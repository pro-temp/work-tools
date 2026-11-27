import {
  closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InputError, localPath, readSnapshot } from './parser.mjs';

const CHECKBOX = new Map([['done', 'x'], ['in_progress', '-'], ['pending', ' '], ['failed', '!'], ['skipped', '~']]);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export function cleanUser(text) {
  // Metadata can follow a request, occur inside it, or be the entire event.
  const clean = text.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '');
  const requests = [...clean.matchAll(/<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/gi)];
  return (requests.length ? requests.map(m => m[1]).join('\n\n') : clean.replace(/<\/USER_REQUEST>/gi, '')).trim();
}

function excerpt(text, max) {
  const chars = [...text.trim()];
  if (chars.length <= max) return text.trim();
  const head = chars.slice(0, Math.floor(max * 0.72)).join('');
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。') + 1);
  return (cut > head.length * 0.75 ? head.slice(0, cut) : head).trimEnd()
    + '\n[…节选…]\n' + chars.slice(-Math.floor(max * 0.28)).join('').trimStart();
}

function transcript(path) {
  if (!statSync(path, { throwIfNoEntry: false })) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  const rows = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) {
      if (error instanceof SyntaxError && i === lines.length - 1) break; // The host is appending this row.
      throw new Error(`会话记录第 ${i + 1} 行无法解析。`, { cause: error });
    }
  }
  return rows;
}

function pathKey(raw, workspace) {
  const local = localPath(raw);
  const path = local && !isAbsolute(local) && workspace ? resolve(workspace, local) : local;
  const key = path ? normalize(path) : raw;
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function mdHeading(path) {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(8192);
    const count = readSync(fd, chunk, 0, chunk.length, 0);
    return /^#\s+(.+)$/m.exec(chunk.toString('utf8', 0, count))?.[1].trim() || '';
  } finally { closeSync(fd); }
}

function artifacts(brain, report, workspace) {
  const files = new Map();
  for (const f of report.artifact_files) {
    files.set(pathKey(f.originalPath, workspace), { path: f.fullPath || f.path, heading: '' });
  }
  if (statSync(brain, { throwIfNoEntry: false })?.isDirectory()) {
    for (const entry of readdirSync(brain, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue;
      const path = join(brain, entry.name);
      files.set(pathKey(path, workspace), { path, heading: mdHeading(path) });
    }
  }
  return [...files.values()];
}

function substantive(text) {
  if (/^(好的|收到|明白|OK|understood)[。.!！\s]*$/i.test(text)) return false;
  return text && !(text.length < 85 && /^(?:(?:好的|明白|收到)[，。！! ]*)?(?:我先(?:看一下|检查一下|确认一下)|稍等(?:一下)?|现在开始|我来处理|接下来继续|继续执行|让我看看|let me check|one moment)[。.!！…\s]*$/i.test(text));
}

// Overwrite grants permission. A successful write can still report creation.
function editKind(name, args) {
  if (name !== 'write_file') return 'modified';
  return [true, 'true'].includes(args?.Overwrite) ? 'written' : 'added';
}

function parseJsonString(raw) {
  try { return JSON.parse(raw); }
  catch (error) { if (error instanceof SyntaxError) return raw; throw error; }
}

function decodeTranscriptArgs({ name, args: fields }, recordedCall) {
  const original = recordedCall?.str(2) === name ? parseJsonString(recordedCall.str(3)) : null;
  const args = { ...fields };
  for (const [key, raw] of Object.entries(fields)) {
    if (typeof raw !== 'string') continue;
    if (original && /\n<truncated \d+ bytes>$/.test(raw) && Object.hasOwn(original, key)) {
      args[key] = original[key];
      continue;
    }
    const value = parseJsonString(raw);
    // A direct text argument can itself be a JSON literal, e.g. the shell command true.
    if (typeof value === 'string' || !['Path', 'CommandLine', 'toolSummary'].includes(key)) args[key] = value;
  }
  return args;
}

function gather(rows, steps, workspace) {
  const users = [], replies = [], commands = new Map(), edits = [], waits = new Map(), checkpoints = new Map();
  const created = new Set();
  const plannerSteps = new Map(steps.filter(s => s.type === 15).map(s => [s.index, s.pb]));
  let tasks = [], latestPlanIndex = -1;
  function call(name, args, index) {
    if (name === 'update_steps' && index >= latestPlanIndex) {
      const list = typeof args.steps === 'string' ? JSON.parse(args.steps) : args.steps;
      if (!Array.isArray(list)) throw new Error('update_steps 缺少任务列表。');
      tasks = list.map(item => {
        if (!CHECKBOX.has(item.status) || typeof item.title !== 'string') throw new Error('update_steps 的标题或状态无效。');
        return { title: item.title, status: item.status };
      });
      latestPlanIndex = index;
    }
    if (name === 'run_command') {
      const command = args.CommandLine?.trim();
      if (!command) return;
      commands.delete(command);
      commands.set(command, { command, summary: args.toolSummary || '' });
    }
  }

  for (const row of rows) {
    const content = (row.content || '').trim();
    if (row.type === 'USER_INPUT') {
      const user = cleanUser(content);
      if (user) users.push(user);
    } else if (row.type === 'GENERIC' && /(?:^|\n)Created file\.$/.test(content)) created.add(row.step_index);
    else if (row.type === 'CHECKPOINT') checkpoints.set(row.step_index, content);
    else if (row.type === 'PLANNER_RESPONSE') {
      if (!plannerSteps.has(row.step_index)) plannerSteps.set(row.step_index, null);
      // PlannerResponse field 7 retains the ordered calls when the transcript clips their arguments.
      const recordedCalls = row.truncated_fields?.includes('tool_calls')
        ? plannerSteps.get(row.step_index)?.msg(20).msgs(7) : undefined;
      if (substantive(content)) replies.push(content);
      for (const [i, tool] of (row.tool_calls ?? []).entries()) {
        const { name } = tool;
        const writesFile = WRITE_TOOLS.has(name);
        if (!writesFile && name !== 'run_command' && name !== 'update_steps') continue;
        const args = decodeTranscriptArgs(tool, recordedCalls?.[i]);
        call(name, args, row.step_index);
        if (writesFile && args.Path) {
          const key = JSON.stringify([row.step_index, pathKey(args.Path, workspace)]);
          const edit = { path: args.Path, kind: editKind(name, args), counted: true };
          if (!waits.has(key)) waits.set(key, []);
          waits.get(key).push(edit);
          edits.push(edit);
        }
      }
    }
  }

  const planners = [...plannerSteps.keys()].sort((a, b) => a - b);
  let batch = -1;
  for (const s of steps) {
    while (batch + 1 < planners.length && planners[batch + 1] <= s.index) ++batch;
    const pb = s.pb;
    if (!rows.length) {
      if (pb.has(19)) {
        const user = cleanUser(pb.msg(19).str(2));
        if (user) users.push(user);
      }
      if (pb.has(20)) {
        const text = pb.msg(20).str(1).trim();
        if (substantive(text)) replies.push(text);
      }
    }
    if (pb.has(30)) {
      const ck = pb.msg(30);
      const details = [ck.str(4), ck.str(5), ck.str(6)].filter(Boolean);
      const text = details.length ? [...new Set(details)].join('\n\n') : checkpoints.get(s.index);
      checkpoints.set(s.index, text || `步骤 ${ck.int(11)}–${ck.int(12)}`);
    }
    const name = s.toolCall.str(2);
    const action = pb.msg(10).msg(2).msg(1);
    if (!rows.length && s.status === 3 && ['update_steps', 'run_command'].includes(name)) {
      const args = s.toolArgs();
      if (args) call(name, args, s.index);
    }
    if (!action.has(8) && !WRITE_TOOLS.has(name)) continue;
    const args = s.toolArgs();
    const path = action.str(8) || args?.Path;
    if (!path) continue;
    const queue = waits.get(JSON.stringify([planners[batch], pathKey(path, workspace)]));
    const proposed = queue?.shift();
    const edit = proposed ?? { path: localPath(path) || path, kind: editKind(name, args) };
    edit.counted = s.status === 3;
    if (edit.kind === 'written' && (created.has(s.index) || /(?:^|\n)Created file\.\s*$/.test(s.toolResult?.str(1)))) edit.kind = 'added';
    if (!proposed) edits.push(edit);
  }
  const files = new Map();
  for (const edit of edits) {
    if (!edit.counted) continue;
    const key = pathKey(edit.path, workspace);
    if (!files.has(key)) files.set(key, { path: edit.path, added: 0, modified: 0, written: 0 });
    ++files.get(key)[edit.kind];
  }
  return { users, replies, tasks, commands: [...commands.values()], files: [...files.values()],
    checkpoints: [...checkpoints].sort(([a], [b]) => a - b).map(([, text]) => text) };
}

function codeSpan(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(text) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

function firstLineExcerpt(text, max) {
  const line = text.trim().split(/[\r\n\u2028\u2029]/, 1)[0].trimEnd();
  const chars = [...line];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : line;
}

function codeBlock(text) {
  const longest = Math.max(2, ...[...text.matchAll(/^`+/gm)].map(m => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return fence + 'text\n' + text + '\n' + fence;
}

export function buildHandoff(appDataDir, conversationId, { workspace = '', mode = 'compact' } = {}) {
  if (mode !== 'compact' && mode !== 'full') throw new InputError('请选择 compact 或 full 交接模式。');
  const { report: r, steps, summary, workspace: root } = readSnapshot(appDataDir, conversationId, workspace);
  const brain = join(appDataDir, 'brain', conversationId);
  const rows = transcript(join(brain, '.system_generated', 'logs', 'transcript.jsonl'));
  const data = gather(rows, steps, root);
  const outputs = artifacts(brain, r, root);
  const full = mode === 'full';
  const title = r.title || conversationId.slice(0, 8);
  const parts = [`# 会话交接 · ${title}\n\n${full ? '完整版' : '精简版'} · ${codeSpan(conversationId)}`];
  function section(heading, lines, empty = '未记录。') {
    parts.push('## ' + heading + '\n\n' + (lines.length ? lines.join('\n') : empty));
  }
  const overview = [
    `- 模型：${r.model}`,
    `- 上下文：${r.used_tokens} / ${r.limit_tokens || '未知窗口'} Token（${r.compacted ? '压缩后估算' : r.has_breakdown ? '实时精确' : '待生成估算'}）`,
    `- 请求压缩预算：${r.request_budget_tokens ? r.request_budget_tokens + ' Token（' + r.budget_pct.toFixed(1) + '%）' : '未记录'}`,
  ];
  for (const uri of new Set([root, ...summary.workspaces.map(localPath)].filter(Boolean))) overview.push('- 工作区：' + codeSpan(uri));
  if (summary.last_modified_time) overview.push('- 最后活动：' + summary.last_modified_time);
  if (summary.step_count !== null) overview.push('- 会话步骤：' + summary.step_count);
  overview.push('- 消息来源：' + (rows.length ? 'transcript.jsonl' : '会话数据库'));
  if (summary.warning) overview.push('- 摘要索引：' + summary.warning);
  section('会话概览', overview);

  const shown = data.users.map((text, i) => ({ text, i })).filter(({ i }) => full || i === 0 || i >= data.users.length - 3);
  section('用户指令', shown.map(({ text, i }) => `### 第 ${i + 1} 轮\n\n${full ? text : excerpt(text, 640)}\n`));
  section('最新任务清单', data.tasks.map(t => `- [${CHECKBOX.get(t.status)}] ${t.title}`));
  section('文件改动', data.files.map(f => {
    const counts = [f.added && `新增 ${f.added} 次`, f.modified && `修改 ${f.modified} 次`,
      f.written && `写入 ${f.written} 次（原文件状态未记录）`].filter(Boolean);
    return `- ${codeSpan(f.path)} · ${counts.join('，')}`;
  }));
  const commands = full ? data.commands : data.commands.slice(-6);
  section('关键命令', commands.map(({ command, summary }) => {
    if (full) return (summary ? summary + '\n\n' : '') + codeBlock(command) + '\n';
    const label = firstLineExcerpt(summary, 80);
    return '- ' + (label ? label + ' · ' : '') + codeSpan(firstLineExcerpt(command, 150));
  }));
  section('检查点', data.checkpoints.map((text, i) => `### 检查点 ${i + 1}\n\n${full ? text : excerpt(text, 420)}\n`));
  const recent = full ? data.replies : data.replies.slice(-3);
  section('最近进展', recent.map((text, i) => `### 助手回复 ${data.replies.length - recent.length + i + 1}\n\n${full ? text : excerpt(text, 560)}\n`));
  section('产物与上下文文件', [
    ...outputs.map(f => '- 产物：' + codeSpan(f.path) + (f.heading ? ' · ' + f.heading : '')),
    ...r.knowledge_files.map(f => '- 知识：' + codeSpan(f.fullPath || f.path)),
    ...r.skill_files.map(f => '- 技能：' + codeSpan(f.fullPath || f.path)),
  ]);
  const next = data.tasks.find(t => t.status === 'in_progress') ?? data.tasks.find(t => t.status === 'pending' || t.status === 'failed');
  section('下一会话接棒指引', [
    next ? '优先接续「' + next.title + '」。' : '先核对最近一轮用户指令和助手回复，确认尚需完成的事项。',
    '对照上面的改动与产物核实现状，再继续工作。',
  ]);
  const markdown = parts.join('\n\n').trimEnd() + '\n';
  return { title, mode, markdown, stats: { characters: [...markdown].length, estimatedTokens: Math.ceil(Buffer.byteLength(markdown) / 4),
    turns: shown.length, totalTurns: data.users.length, files: data.files.length, artifacts: outputs.length } };
}

function timestamp(date) {
  const two = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

export function exportHandoff(appDataDir, conversationId, { workspace, mode, target, expectedMarkdown } = {}) {
  if (target !== 'brain' && target !== 'downloads') throw new InputError('导出目标必须是 downloads 或 brain。');
  const doc = buildHandoff(appDataDir, conversationId, { workspace, mode });
  if (expectedMarkdown !== undefined && doc.markdown !== expectedMarkdown) {
    throw new InputError('会话已更新，请核对新预览后再次导出。', 409);
  }
  const parts = target === 'brain' ? ['brain', conversationId] : ['Downloads'];
  let dir = target === 'brain' ? appDataDir : homedir();
  for (const part of parts) {
    dir = join(dir, part);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new InputError('导出目录指向符号链接或联接点。');
    mkdirSync(dir, { recursive: true });
  }
  const slug = [...doc.title.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')].slice(0, 48).join('');
  const stem = `handoff-${slug || conversationId.slice(0, 8)}-${timestamp(new Date())}`;
  for (let n = 1; ; n++) {
    const filename = stem + (n === 1 ? '' : '-' + n) + '.md';
    const path = join(dir, filename);
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      try { writeFileSync(fd, doc.markdown); }
      finally { closeSync(fd); }
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return { ok: true, filename, path, fileUri: pathToFileURL(path).href, bytes: Buffer.byteLength(doc.markdown) };
  }
}

