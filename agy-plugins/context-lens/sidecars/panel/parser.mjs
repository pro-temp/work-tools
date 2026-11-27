import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_BYTES = Buffer.alloc(0);

// CortexStepType names accepted in TopLevelTokenGroup chat item labels.
const STEP_NAMES = new Set(`
  UNSPECIFIED DUMMY FINISH PLAN_INPUT MQUERY CODE_ACTION
  GIT_COMMIT GREP_SEARCH VIEW_FILE LIST_DIRECTORY COMPILE VIEW_CODE_ITEM
  USER_INPUT PLANNER_RESPONSE ERROR_MESSAGE RUN_COMMAND CHECKPOINT PROPOSE_CODE
  FIND SUGGESTED_RESPONSES COMMAND_STATUS MEMORY READ_URL_CONTENT VIEW_CONTENT_CHUNK
  SEARCH_WEB RETRIEVE_MEMORY MCP_TOOL MANAGER_FEEDBACK TOOL_CALL_PROPOSAL TOOL_CALL_CHOICE
  TRAJECTORY_CHOICE CLIPBOARD VIEW_FILE_OUTLINE POST_PR_REVIEW LIST_RESOURCES READ_RESOURCE
  LINT_DIFF FIND_ALL_REFERENCES BRAIN_UPDATE OPEN_BROWSER_URL RUN_EXTENSION_CODE PROPOSAL_FEEDBACK
  TRAJECTORY_SEARCH EXECUTE_BROWSER_JAVASCRIPT LIST_BROWSER_PAGES CAPTURE_BROWSER_SCREENSHOT CLICK_BROWSER_PIXEL READ_TERMINAL
  CAPTURE_BROWSER_CONSOLE_LOGS READ_BROWSER_PAGE BROWSER_GET_DOM CODE_SEARCH BROWSER_INPUT BROWSER_MOVE_MOUSE
  BROWSER_SELECT_OPTION BROWSER_SCROLL_UP BROWSER_SCROLL_DOWN BROWSER_CLICK_ELEMENT BROWSER_PRESS_KEY TASK_BOUNDARY
  NOTIFY_USER CODE_ACKNOWLEDGEMENT INTERNAL_SEARCH BROWSER_SUBAGENT FILE_CHANGE MOVE
  BROWSER_SCROLL KNOWLEDGE_GENERATION EPHEMERAL_MESSAGE GENERATE_IMAGE DELETE_DIRECTORY COMPILE_APPLET
  INSTALL_APPLET_DEPENDENCIES INSTALL_APPLET_PACKAGE BROWSER_RESIZE_WINDOW BROWSER_DRAG_PIXEL_TO_PIXEL CONVERSATION_HISTORY KNOWLEDGE_ARTIFACTS
  SEND_COMMAND_INPUT SYSTEM_MESSAGE WAIT AGENCY_TOOL_CALL CIDER_AGENT_DUMMY BUILD_CLEANER
  BLAZE_BUILD_TARGETS BLAZE_TEST_TARGETS SET_UP_FIREBASE MOMA RESTART_DEV_SERVER DEPLOY_FIREBASE
  SHELL_EXEC BROWSER_MOUSE_WHEEL LINT_APPLET KI_INSERTION RETRIEVE_CONTENT CRITIQUE
  FINDINGS BROWSER_MOUSE_UP BROWSER_MOUSE_DOWN WORKSPACE_API BROWSER_LIST_NETWORK_REQUESTS BROWSER_GET_NETWORK_REQUEST
  BROWSER_REFRESH_PAGE EDIT_NOTEBOOK INVOKE_SUBAGENT WRITE_BLOB READ_NOTEBOOK PROPOSE_AI_COMMENTS
  START_CODE_REVIEW GENERIC SET_UP_CLOUD_SQL EXECUTE_NOTEBOOK CLOUD_SQL_UPDATE_SCHEMA RPC_ACTION
  CLOUD_SQL_EXECUTE_SQL ASK_QUESTION DIRECTORY_RULES TOOL_SEARCH
`.trim().split(/\s+/));

const CATEGORIES = [
  ['user', 'User messages'], ['agent', 'Agent responses'], ['tool', 'Tool calls'],
  ['system_prompt', 'System prompt'], ['system_tools', 'System tools'], ['system_overhead', 'System overhead'],
  ['rules', 'Rules'], ['skills', 'Skills'], ['subagents', 'Subagents'], ['legacy_workflows', 'Legacy workflows'],
  ['workflows', 'Workflows'], ['plugins', 'Plugins'], ['mcp_tools', 'MCP tools'], ['system_messages', 'System messages'],
];
const CHAT_KEYS = ['user', 'agent', 'tool', 'system_messages'];
const SEGMENTS = [
  ['system', '系统', ['system_prompt', 'system_tools', 'system_overhead']],
  ['user', '用户', ['user']], ['agent', '助手', ['agent']], ['tool', '工具', ['tool']],
  ['custom', '扩展定制', ['rules', 'skills', 'subagents', 'legacy_workflows', 'workflows', 'plugins', 'mcp_tools']],
  ['system_messages', '系统消息', ['system_messages']],
];
const TOKEN_GROUPS = new Map([[3, 'rules'], [4, 'mcp_tools'], [5, 'skills'], [6, 'subagents'],
  [8, 'legacy_workflows'], [9, 'plugins'], [10, 'workflows']]);
const PROMPT_CHILDREN = new Map([['flows', 'workflows'], ['skills', 'skills'], ['subagents', 'subagents']]);
export const NATIVE_CONTEXT_WINDOWS = [
  ['claude-opus-4-6', 250_000], ['claude-sonnet-4-6', 250_000], ['claude-', 1_000_000],
  ['gemini-3.1-flash-image', 65_536], ['gemini-', 1_048_576], ['gpt-oss-', 131_072], ['tab_', 16_384],
];

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function conversationPath(appDataDir, id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new InputError('请选择有效的会话。');
  return join(appDataDir, 'conversations', id + '.db');
}

// Keep uint64 values as BigInt until the caller specifies the protobuf field type.
export class Msg {
  fields = new Map();

  constructor(buffer = NO_BYTES) {
    let pos = 0;
    function varint() {
      let value = 0n;
      for (let shift = 0n; shift <= 63n && pos < buffer.length; shift += 7n) {
        const byte = buffer[pos++];
        if (shift === 63n && byte > 1) break;
        value |= BigInt(byte & 127) << shift;
        if (byte < 128) return value;
      }
      throw new Error('会话 protobuf 的 varint 不完整或超出 64 位。');
    }
    while (pos < buffer.length) {
      const tag = Number(varint());
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      let value;
      if (wire === 0) {
        value = varint();
      } else {
        let size;
        if (wire === 2) size = Number(varint());
        else if (wire === 1) size = 8;
        else if (wire === 5) size = 4;
        else throw new Error(`不支持的 protobuf wire type ${wire}。`);
        if (size > buffer.length - pos) throw new Error('会话 protobuf 的字段不完整。');
        value = buffer.subarray(pos, pos + size);
        pos += size;
      }
      if (!this.fields.has(field)) this.fields.set(field, []);
      this.fields.get(field).push(value);
    }
  }

  has(field) { return this.fields.has(field); }
  last(field) { return this.fields.get(field)?.at(-1); }
  int(field, signed32 = false) {
    const raw = this.last(field);
    if (typeof raw !== 'bigint') return 0;
    const n = Number(signed32 ? BigInt.asIntN(32, raw) : raw);
    if (!Number.isSafeInteger(n)) throw new RangeError('该 protobuf 整数必须以 BigInt 读取。');
    return n;
  }
  bytes(field) {
    const raw = this.last(field);
    return raw instanceof Uint8Array ? raw : NO_BYTES;
  }
  str(field) { return Buffer.from(this.bytes(field)).toString('utf8'); }
  msg(field) { return this.has(field) ? new Msg(this.bytes(field)) : EMPTY; }
  msgs(field) {
    return (this.fields.get(field) ?? []).filter(v => v instanceof Uint8Array).map(v => new Msg(v));
  }
}
const EMPTY = new Msg();

function originalStep(result) {
  const any = result.msg(6);
  if (any.str(1).endsWith('/gemini_coder.Step')) return any.msg(2);
  for (const entry of result.msgs(5)) {
    const value = entry.msg(2);
    if (entry.str(1) === '__original_cortex_step' && value.str(1).endsWith('/gemini_coder.Step')) return value.msg(2);
  }
}

export class Step {
  constructor(row) {
    this.index = row.idx;
    this.pb = new Msg(row.step_payload ?? NO_BYTES);
    this.type = this.pb.has(1) ? this.pb.int(1) : row.step_type;
    this.status = this.pb.has(4) ? this.pb.int(4) : row.status;
    this.md = this.pb.has(5) ? this.pb.msg(5) : new Msg(row.metadata ?? NO_BYTES);
    this.toolCall = this.md.msg(4);
    if (this.type === 132 && this.pb.has(140)) {
      this.toolResult = this.pb.msg(140).msg(2);
      const original = originalStep(this.toolResult);
      if (original) {
        this.pb = original;
        this.type = original.int(1);
        this.md = original.msg(5);
      } else if (['read_file', 'view_file'].includes(this.toolCall.str(2))) {
        // A failed tool call can contain incomplete JSON and has no typed file payload.
        const args = this.toolArgs();
        const file = [args?.AbsolutePath, args?.Path, args?.FilePath].find(p => typeof p === 'string' && p);
        if (file) {
          this.type = 8;
          this.skillPath = /[/\\]SKILL\.md$/.test(file) ? file : '';
        }
      }
    }
  }
  toolArgs() {
    const json = this.toolCall.str(3);
    if (!json) return null;
    try { return JSON.parse(json); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  }
}

function stepCategory(type) {
  if (type === 14) return 'user';
  if (type === 15) return 'agent';
  if (type === 23) return 'checkpoint';
  return [0, 2, 101].includes(type) ? 'system_messages' : 'tool';
}

function stepTokens({ md, pb }) {
  if (md.has(9)) return md.msg(9).int(3);
  let length;
  if (pb.has(19)) length = pb.msg(19).bytes(2).length;
  else if (pb.has(20)) length = pb.msg(20).bytes(1).length;
  else {
    const output = md.int(23, true);
    if (output > 0) return output;
    length = md.msg(4).bytes(3).length;
  }
  return length ? Math.max(1, Math.trunc(length / 4)) : 0;
}

function checkpointSummaryTokens(step) {
  for (const retry of step.md.msgs(28).reverse()) {
    if (!retry.has(2)) continue;
    const usage = retry.msg(2);
    const measured = usage.int(10) || Math.max(0, usage.int(3) - usage.int(9));
    if (measured) return measured;
    break;
  }
  const ck = step.pb.msg(30);
  return Math.trunc((ck.bytes(4).length + ck.bytes(5).length + ck.bytes(6).length) / 4);
}

function newerCheckpoint(steps, generationCheckpoint) {
  for (let i = steps.length - 1; i >= 0; --i) {
    const { pb, status } = steps[i];
    if (status !== 3) continue;
    if (pb.has(30)) return generationCheckpoint < pb.msg(30).int(1) ? i : -1;
    if (pb.has(20)) break;
  }
  return -1;
}

function applyChatBreakdown(stats, items, chatTokens) {
  const exact = { user: 0, agent: 0, tool: 0, system_messages: 0 };
  const known = items.length && items.every(item => {
    const match = /^[+-]?\d+: ([A-Z_0-9]+)$/.exec(item.str(1));
    if (!match || !STEP_NAMES.has(match[1])) return false;
    const name = match[1];
    let category = 'tool';
    if (name === 'USER_INPUT') category = 'user';
    else if (name === 'PLANNER_RESPONSE' || name === 'CHECKPOINT') category = 'agent';
    else if (['UNSPECIFIED', 'FINISH', 'SYSTEM_MESSAGE'].includes(name)) category = 'system_messages';
    exact[category] += item.int(3, true);
    return true;
  });
  if (known) Object.assign(stats, exact);
  else {
    const estimated = stats.user + stats.agent + stats.tool;
    if (!estimated) stats.agent = chatTokens;
    else {
      const factor = chatTokens / estimated;
      for (const key of ['user', 'agent', 'tool']) stats[key] = Math.trunc(stats[key] * factor);
    }
  }
}

export function modelLabel(slug) {
  const words = slug.split('-');
  const last = words.at(-1);
  const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  let effort = '';
  if (words.length > 1 && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(last)) {
    words.pop();
    effort = ` (${last === 'xhigh' ? 'XHigh' : capitalize(last)})`;
  }
  const label = [];
  for (const word of words) {
    if (/^\d+$/.test(word) && /\d$/.test(label.at(-1))) label[label.length - 1] += '.' + word;
    else if (/^\d|^(gpt|oss)$/.test(word)) label.push(word.toUpperCase());
    else label.push(capitalize(word));
  }
  return label.join(' ').replace('GPT OSS', 'GPT-OSS') + effort;
}

export function modelName(gen) {
  const chat = gen.msg(1);
  return chat.str(21) || modelLabel(gen.msg(3).str(28)) || chat.str(19) || 'Unknown Model';
}

// Remote file authorities and UNC paths can open network shares even in a filesystem-only plugin.
export function localPath(raw) {
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname && url.hostname !== 'localhost') return '';
    raw = fileURLToPath(url);
  }
  if (/^[/\\]{2}|^[a-z][\w+.-]*:\/\//i.test(raw)) return '';
  return raw;
}

const info = file => statSync(file, { throwIfNoEntry: false });
function fileItem(raw, tokens, workspace) {
  const local = localPath(raw);
  const home = homedir().replaceAll('\\', '/');
  let short = (local || raw).replaceAll('\\', '/');
  if (short === home || short.startsWith(home + '/')) short = '~' + short.slice(home.length);
  let fullPath = '';
  if (local.startsWith('~/')) fullPath = join(homedir(), local.slice(2));
  else if (isAbsolute(local)) fullPath = normalize(local);
  else if (workspace && local) fullPath = resolve(workspace, local);
  const fileUri = fullPath && info(fullPath)?.isFile() ? pathToFileURL(fullPath).href : '';
  return { path: short, fullPath, fileUri, tokens, originalPath: raw };
}

function systemFiles(appDir, workspace) {
  const gemini = join(homedir(), '.gemini');
  const found = [];
  function check(root, sub, directory, display) {
    const fullPath = join(root, sub);
    const stat = info(fullPath);
    if (!(directory ? stat?.isDirectory() : stat?.isFile())) return;
    found.push({ path: display, fullPath, fileUri: directory ? '' : pathToFileURL(fullPath).href, tokens: 0, originalPath: fullPath });
  }
  check(gemini, 'GEMINI.md', false, '~/.gemini/GEMINI.md');
  for (const sub of ['skills', 'rules', 'agents', 'global_workflows']) check(gemini, sub, true, `~/.gemini/${sub}/`);
  for (const sub of ['rules', 'skills', 'agents', 'global_workflows']) check(appDir, sub, true, `~/.gemini/${basename(appDir)}/${sub}/`);
  if (workspace) for (const root of ['.agents', '_agents']) {
    for (const sub of ['rules', 'skills', 'agents', 'workflows']) check(join(workspace, root), sub, true, `${root}/${sub}/`);
    check(join(workspace, root), 'hooks.json', false, root + '/hooks.json');
  }
  return found;
}

export function collectStats(steps, gen, workspace) {
  const stats = Object.fromEntries(CATEGORIES.map(([key]) => [key, 0]));
  const files = { knowledge_files: new Map(), artifact_files: new Map(), skill_files: new Map() };
  const checkpoints = [];
  const chat = gen.msg(1);
  const start = chat.msg(9);
  const window = start.msg(10);
  const genCheckpoint = chat.has(9) ? start.int(2, true) : -1;
  const newer = newerCheckpoint(steps, genCheckpoint);
  let active = genCheckpoint;
  let buffer = 0;
  function record(map, raw, tokens) {
    if (!map.has(raw)) map.set(raw, fileItem(raw, tokens, workspace));
  }
  for (const [pos, step] of steps.entries()) {
    const tok = stepTokens(step);
    const key = stepCategory(step.type);
    if (key === 'checkpoint') {
      buffer += tok;
      if (step.pb.has(30)) {
        const ck = step.pb.msg(30);
        checkpoints.push({ index: ck.int(1), start: ck.int(11), end: ck.int(12), intent: ck.str(4) });
      }
    } else if (pos >= newer) stats[key] += tok;

    const ca = step.pb.msg(10);
    const result = ca.msg(2);
    if (result.has(1)) {
      const raw = result.msg(1).str(8);
      if (ca.int(21)) record(files.artifact_files, raw, tok);
      if (ca.int(24)) record(files.knowledge_files, raw, tok);
    }
    const view = step.pb.msg(14);
    const skill = step.skillPath || (view.int(17) && view.str(1));
    if (skill) record(files.skill_files, skill, tok);
  }
  let seenPrompt = false, seenTools = false, chatTokens = 0, items = [];
  for (const group of window.msg(3).msgs(1)) {
    const type = group.int(2);
    const tokens = group.int(4, true);
    if (type === 1) {
      seenPrompt = true;
      stats.system_prompt = tokens;
      for (const item of group.msgs(5)) {
        const key = PROMPT_CHILDREN.get(item.str(1));
        if (key) {
          const child = item.int(3, true);
          stats[key] += child;
          stats.system_prompt -= child;
        }
      }
    } else if (type === 2) {
      seenTools = true;
      stats.system_tools = tokens;
    } else if (type === 7) {
      chatTokens = tokens;
      items = group.msgs(5);
    } else if (TOKEN_GROUPS.has(type)) stats[TOKEN_GROUPS.get(type)] += tokens;
  }
  if (!seenPrompt && !seenTools && chatTokens) {
    const usage = chat.msg(4);
    stats.system_overhead = Math.max(0, usage.int(2) + usage.int(5) - chatTokens);
  }
  if (newer >= 0) {
    stats.agent += checkpointSummaryTokens(steps[newer]);
    active = steps[newer].pb.msg(30).int(1);
  } else if (chatTokens) applyChatBreakdown(stats, items, chatTokens);
  return {
    stats, checkpoints, active_checkpoint: active, checkpoint_buffer: buffer,
    has_breakdown: window.has(3), compacted: newer >= 0,
    ...Object.fromEntries(Object.entries(files).map(([key, map]) => [key, [...map.values()]])),
  };
}


// Python's CLI renderer rounds exact half-tenths to an even digit (e.g. 1.25M).
function decimal(n) {
  return (Math.abs(n * 4 % 2) === 1 ? Math.round(n * 5) / 5 : n).toFixed(1);
}
function percent(tokens, limit) { return limit ? tokens / limit * 100 : 0; }
function fmt(n) {
  if (n >= 1_000_000) return (n % 1_000_000 ? decimal(n / 1_000_000) : n / 1_000_000) + 'M';
  return n >= 1000 ? decimal(n / 1000) + 'k' : String(n);
}

function checkpointView(report) {
  const list = report.checkpoints;
  if (!list.length) return null;
  const ck = list.findLast(c => c.index === report.active_checkpoint) ?? list.at(-1);
  const intent = Buffer.from(ck.intent);
  const brief = intent.length > 70 ? intent.subarray(0, 67).toString().replace(/\uFFFD$/, '') + '...' : ck.intent;
  return { count: list.length, active_number: ck.index + 1, active_text: brief || `steps ${ck.start}–${ck.end}`, historical: list.length - 1 };
}

function cliText(r) {
  const limit = r.limit_tokens;
  const lines = [`${r.model} · ${fmt(r.used_tokens)}/${limit ? fmt(limit) : 'Unknown'} tokens`];
  if (limit) lines.push(` (${r.used_pct.toFixed(1)}%)`);
  lines.push(r.heading);
  for (const c of r.categories) lines.push(`${c.icon} ${c.name}: ${fmt(c.tokens)} tokens (${c.pct.toFixed(1)}%)`);
  lines.push(`□ Free space: ${fmt(r.free_tokens)} (${decimal(percent(r.free_tokens, limit))}%)`);
  if (r.checkpoint_buffer) lines.push(`⊠ Checkpoint buffer: ${fmt(r.checkpoint_buffer)} tokens (not counted in usage)`);

  // The reference report's default 100-column terminal uses 20 cells per grid row.
  const cols = 20, cells = lines.length * cols;
  let counts = r.grid_segments.map(t => t && limit ? Math.max(1, Math.trunc(t / limit * cells)) : 0);
  const used = counts.reduce((a, b) => a + b, 0);
  if (used > cells) counts = counts.map(n => Math.trunc(n * (cells / used)));
  const grid = '◉'.repeat(counts.reduce((a, b) => a + b, 0)).padEnd(cells, '□');
  let text = '└ Context Usage\n\n' + lines.map((line, i) => [...grid.slice(i * cols, (i + 1) * cols)].join(' ') + '   ' + line).join('\n') + '\n';
  const ck = r.checkpoint_view;
  if (ck) {
    text += `\nCheckpoints (${ck.count}) · /rewind\n└ Checkpoint ${ck.active_number} (active, in context): ${ck.active_text}\n`;
    if (ck.historical) text += `  ${ck.historical} historical checkpoint(s) (summarized, not in context)\n`;
  }
  for (const [key, title] of [
    ['knowledge_files', 'Knowledge files · /rules'], ['artifact_files', 'Artifact files · /artifact'],
    ['skill_files', 'Skill files · /skill'], ['system_files', 'System files · auto-loaded'],
  ]) {
    if (!r[key].length) continue;
    text += '\n' + title + '\n';
    for (const file of r[key]) text += ' └ ' + file.path + (file.tokens > 0 ? `: ${fmt(file.tokens)} tokens` : '') + '\n';
  }
  return text + '\nRelated: /artifact · /skill · /rewind';
}

function readOnly(dbPath, read) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return read(db); }
  finally { db.close(); }
}

function readSummary(appDir, id) {
  const file = join(appDir, 'conversation_summaries.db');
  const empty = { title: '', workspaces: [], last_modified_time: '', step_count: null };
  try {
    if (!info(file)) return empty;
    const row = readOnly(file, db => db.prepare(
      'SELECT title, workspace_uris, last_modified_time, step_count FROM conversation_summaries WHERE conversation_id = ?'
    ).get(id));
    if (!row) return empty;
    const workspaces = JSON.parse(row.workspace_uris || '[]') ?? [];
    if (!Array.isArray(workspaces) || !workspaces.every(uri => typeof uri === 'string')) throw new Error('摘要中的工作区 URI 列表无效。');
    return { title: row.title, last_modified_time: row.last_modified_time, step_count: row.step_count, workspaces };
  } catch (error) {
    // The summary index is optional. Keep the trajectory available and surface the index error.
    return { ...empty, warning: error.message };
  }
}

function localWorkspace(raw) {
  if (typeof raw !== 'string') throw new InputError('工作区必须是本地路径或文件 URI。');
  const path = localPath(raw);
  return isAbsolute(path) ? path : '';
}

export function readSnapshot(appDir, id, workspace = '') {
  const path = conversationPath(appDir, id);
  if (!info(path)?.isFile()) throw new InputError('该会话尚无已保存的数据库。', 404);
  const { rows, genRow } = readOnly(path, db => {
    // Both SELECTs must observe the same generation while the host appends to the WAL.
    db.exec('BEGIN');
    const rows = db.prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx').all();
    const hasGen = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'gen_metadata'").get();
    const genRow = hasGen && db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    db.exec('COMMIT');
    return { rows, genRow };
  });
  const summary = readSummary(appDir, id);
  const root = localWorkspace(workspace) || localWorkspace(summary.workspaces[0] || '');
  const steps = rows.map(row => new Step(row));
  const gen = genRow ? new Msg(genRow.data ?? NO_BYTES) : EMPTY;
  const { stats, ...details } = collectStats(steps, gen, root);
  const slug = gen.msg(3).str(28);
  const budget = gen.msg(1).msg(9).msg(10).int(4, true);
  const limit = NATIVE_CONTEXT_WINDOWS.find(([prefix]) => slug.startsWith(prefix))?.[1] ?? budget;
  const categories = CATEGORIES.filter(([key], i) => i < 3 || stats[key]).map(([key, name]) => ({
    icon: CHAT_KEYS.includes(key) ? '◉' : '⛁', name, key, tokens: stats[key], pct: Number(decimal(percent(stats[key], limit))),
  }));
  const ring = SEGMENTS.map(([key, label, children]) => {
    const tokens = children.reduce((sum, child) => sum + stats[child], 0);
    return { key, label, tokens, pct: percent(tokens, limit), children: categories.filter(c => children.includes(c.key)) };
  });
  const used = ring.reduce((sum, segment) => sum + segment.tokens, 0);
  const heading = details.compacted ? 'Estimated after compaction · updates next turn'
    : details.has_breakdown ? 'Token usage by category' : 'Estimated usage (awaiting generation)';
  const report = {
    conversation_id: id, title: summary.title, model: modelName(gen), model_id: slug, heading,
    limit_tokens: limit, request_budget_tokens: budget, used_tokens: used, used_pct: Number(decimal(Math.min(100, percent(used, limit)))),
    budget_pct: budget > 0 ? percent(used, budget) : 0, free_tokens: Math.max(0, limit - used), categories,
    ring_segments: ring, grid_segments: ring.slice(0, 5).map(s => s.tokens), ...details, system_files: systemFiles(appDir, root),
  };
  if (summary.warning) report.summary_warning = summary.warning;
  report.checkpoint_view = checkpointView(report);
  report.text = cliText(report);
  return { report, steps, summary, workspace: root };
}

const reports = new Map();
function stamp(path) {
  const stat = info(path);
  return stat ? `${stat.mtimeMs}:${stat.size}` : '-';
}
export function getReport(appDir, id, { workspace = '' } = {}) {
  const db = conversationPath(appDir, id);
  const summaries = join(appDir, 'conversation_summaries.db');
  let summaryStamp;
  try { summaryStamp = [stamp(summaries), stamp(summaries + '-wal')]; }
  catch (error) { summaryStamp = error.code; } // readSummary reports an inaccessible optional index.
  const signature = JSON.stringify([workspace, stamp(db), stamp(db + '-wal'), summaryStamp]);
  const entry = reports.get(db);
  if (entry?.signature === signature) return entry.report;
  const { report } = readSnapshot(appDir, id, workspace);
  reports.delete(db);
  if (reports.size === 20) reports.delete(reports.keys().next().value);
  reports.set(db, { signature, report });
  return report;
}

