import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { getReport, localPath, modelLabel, modelName, Msg, NATIVE_CONTEXT_WINDOWS } from '../sidecars/panel/parser.mjs';
import { buildHandoff, cleanUser, exportHandoff } from '../sidecars/panel/handoff.mjs';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const bytes = (...items) => Buffer.concat(items);
function v(value) {
  let n = BigInt.asUintN(64, BigInt(value));
  const out = [];
  while (n > 127n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  return Buffer.from([...out, Number(n)]);
}
function f(field, value) {
  if (typeof value === 'number' || typeof value === 'bigint') return bytes(v(field * 8), v(value));
  const body = Buffer.from(value);
  return bytes(v(field * 8 + 2), v(body.length), body);
}
const call = (name, args) => f(4, bytes(f(2, name), f(3, typeof args === 'string' ? args : JSON.stringify(args))));
const group = (type, tokens, items = []) => f(1, bytes(f(2, type), f(4, tokens), ...items.map(([name, n]) => f(5, bytes(f(1, name), f(3, n))))));
const ck = (i, intent, summary) => bytes(f(1, i), f(4, intent), f(5, summary), f(11, 1), f(12, 9));
const action = (uri, flag) => bytes(f(2, f(1, f(8, uri))), ...(flag ? [f(flag, 1)] : []));

function fixture(t) {
  const app = mkdtempSync(join(os.tmpdir(), 'context-lens-test-'));
  mkdirSync(join(app, 'conversations'));
  const dbPath = join(app, 'conversations', ID + '.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)');
  const index = new DatabaseSync(join(app, 'conversation_summaries.db'));
  index.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, step_count INTEGER)');
  const brain = join(app, 'brain', ID);
  const logDir = join(brain, '.system_generated', 'logs');
  const log = join(logDir, 'transcript.jsonl');
  t.after(() => { index.close(); db.close(); rmSync(app, { recursive: true, force: true }); });
  let seq = 0;
  return {
    app, brain, db, index, log, dbPath,
    step(type, field, payload = Buffer.alloc(0), md = Buffer.alloc(0), status = 3) {
      const pb = bytes(f(1, type), f(4, status), f(5, md), ...(field ? [f(field, payload)] : []));
      db.prepare('INSERT INTO steps VALUES (?,?,?,?,?)').run(seq++, type, status, md, pb);
    },
    gen(groups, { model = 'gemini-4-test', display = '', response = '', budget = 256000, checkpoint = -1, usage = Buffer.alloc(0) } = {}) {
      const start = bytes(f(2, checkpoint), f(10, bytes(f(3, bytes(...groups)), f(4, budget))));
      const chat = bytes(f(4, usage), f(9, start), f(21, display), f(19, response));
      db.prepare('INSERT INTO gen_metadata(data) VALUES (?)').run(bytes(f(1, chat), f(3, f(28, model))));
    },
    summary(title, workspaces = []) {
      index.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?,?,?,?,?)').run(ID, title, JSON.stringify(workspaces), '2026-01-02', seq);
    },
    transcript(rows) { mkdirSync(logDir, { recursive: true }); writeFileSync(log, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); },
    report(workspace = '') { return getReport(app, ID, { workspace }); },
    handoff(mode = 'compact') { return buildHandoff(app, ID, { mode }); },
  };
}
const values = r => Object.fromEntries(r.categories.map(c => [c.key, c.tokens]));
function basic(fx) {
  fx.step(14, 19, f(2, 'hello world!!'));
  fx.step(15, 20, f(1, 'r'.repeat(400)), f(9, f(3, 50)));
  fx.step(132, 0, undefined, call('tool', 'a'.repeat(40)));
}

test('protobuf preserves uint64, signed -1, fixed fields, repeated strings and UTF-8', () => {
  const max = 2n ** 64n - 1n;
  const m = new Msg(bytes(f(1, max), v(17), Buffer.alloc(8, 3), v(29), Buffer.alloc(4, 4), f(4, '旧'), f(4, '新')));
  assert.equal(m.last(1), max);
  assert.equal(m.int(1, true), -1);
  assert.throws(() => m.int(1), RangeError);
  assert.deepEqual([m.bytes(2).length, m.bytes(3).length, m.str(4), m.int(9)], [8, 4, '新', 0]);
  assert.throws(() => new Msg(Buffer.from([8, 128])), /varint/);
  assert.throws(() => new Msg(Buffer.from([10, 9])), /字段不完整/);
});

test('latest generation splits every top-level group and includes checkpoint chat items in agent', t => {
  const fx = fixture(t);
  basic(fx);
  fx.gen([group(1, 90000)]);
  fx.gen([
    group(1, 1000, [['skills', 200], ['subagents', 30], ['flows', 20], ['user_rules', 50]]), group(2, 0),
    group(3, 30), group(4, 40), group(5, 17), group(6, 18),
    group(7, 370, [['0: USER_INPUT', 20], ['1: PLANNER_RESPONSE', 200], ['+2: GENERIC', 80], ['3: FINISH', 30], ['4: CHECKPOINT', 40]]),
    group(8, 11), group(9, 12), group(10, 13),
  ], { usage: f(2, 9000) });
  const r = fx.report();
  assert.deepEqual(values(r), { user: 20, agent: 240, tool: 80, system_prompt: 750, rules: 30, mcp_tools: 40,
    skills: 217, subagents: 48, workflows: 33, legacy_workflows: 11, plugins: 12, system_messages: 30 });
  assert.equal(r.ring_segments.reduce((a, s) => a + s.tokens, 0), r.used_tokens);
  assert.deepEqual(r.ring_segments.map(s => s.key), ['system', 'user', 'agent', 'tool', 'custom', 'system_messages']);
  assert.equal(r.budget_pct, r.used_tokens / 256000 * 100);
  assert.match(r.text, /^└ Context Usage\n\n/);
  assert.match(r.text, /Related: \/artifact · \/skill · \/rewind$/);
});

test('unknown chat item scales estimates, excludes checkpoint buffer and computes overhead only without prompt or tools', t => {
  const fx = fixture(t);
  basic(fx);
  const chat = group(7, 315, [['0: USER_INPUT', 20], ['1: UNKNOWN_FUTURE_STEP', 1]]);
  const opts = { usage: bytes(f(2, 1000), f(5, 500)) };
  fx.gen([chat], opts);
  assert.deepEqual(values(fx.report()), { user: 15, agent: 250, tool: 50, system_overhead: 1185 });
  for (const g of [group(1, 0), group(2, 0)]) {
    fx.gen([g, chat], opts);
    assert.equal(values(fx.report()).system_overhead, undefined);
  }
  fx.db.exec('DELETE FROM steps');
  fx.gen([group(7, 10)]);
  assert.equal(values(fx.report()).agent, 10);
});

test('awaiting generation uses output, tool outputs or UTF-8 bytes divided by four even without a metadata table', t => {
  const fx = fixture(t);
  basic(fx);
  fx.db.exec('DROP TABLE gen_metadata');
  fx.step(14, 19, f(2, '中'));
  fx.step(132, 0, undefined, bytes(call('tool', 'q'.repeat(40)), f(23, 7)));
  fx.step(2, 0, undefined, call('tool', 'b'.repeat(8)));
  const r = fx.report();
  assert.deepEqual(values(r), { user: 4, agent: 50, tool: 17, system_messages: 2 });
  assert.deepEqual([r.title, r.has_breakdown, r.limit_tokens, r.model], ['', false, 0, 'Unknown Model']);
});

test('newer completed checkpoint replaces the covered steps and uses retry usage before text size', t => {
  const fx = fixture(t);
  basic(fx);
  fx.step(23, 30, ck(0, 'Fix the login bug', 's'.repeat(383)), call('tool', 'c'.repeat(80)));
  fx.step(14, 19, f(2, 'next question please'));
  fx.gen([group(1, 800), group(7, 370, [['0: USER_INPUT', 370]])]);
  let r = fx.report();
  assert.deepEqual([r.compacted, ...['user', 'agent', 'tool'].map(k => values(r)[k]), r.checkpoint_buffer], [true, 5, 100, 0, 20]);
  assert.equal(r.checkpoint_view.active_number, 1);
  fx.step(23, 30, ck(1, '', ''), f(28, f(2, bytes(f(3, 24), f(9, 5)))));
  assert.equal(values(fx.report()).agent, 19);
  fx.step(23, 30, ck(2, '', ''), f(28, f(2, bytes(f(3, 85), f(10, 12)))));
  r = fx.report();
  assert.deepEqual([values(r).agent, r.checkpoint_view.historical, r.checkpoint_view.active_text], [12, 2, 'steps 1–9']);
  fx.gen([group(7, 7, [['0: CHECKPOINT', 7]])], { checkpoint: 2 });
  assert.equal(fx.report().compacted, false);
  fx.gen([], { checkpoint: -1 });
  fx.step(15, 20, f(1, 'done'));
  assert.equal(fx.report().compacted, false);
});

test('local window prefix order, model precedence, capitalization and CLI decimal rounding', t => {
  assert.equal(modelLabel('gpt-oss-120b-xhigh'), 'GPT-OSS 120B (XHigh)');
  assert.equal(modelLabel('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelLabel('gemini-3.8-flash-medium'), 'Gemini 3.8 Flash (Medium)');
  assert.equal(modelName(new Msg(f(1, f(19, 'response-only')))), 'response-only');
  const fx = fixture(t);
  for (const [slug, n] of [...NATIVE_CONTEXT_WINDOWS, ['other-', 1234]]) {
    fx.gen([], { model: slug + 'test', budget: 1234, display: 'Displayed' });
    assert.deepEqual([fx.report().limit_tokens, fx.report().model], [n, 'Displayed']);
  }
  fx.gen([group(1, 1250000)], { model: 'other', budget: 2500000 });
  assert.match(fx.report().text, /1\.2M\/2\.5M tokens/);
});

test('both GENERIC Any encodings, skill paths, relative files and auto-loaded directories', t => {
  const fx = fixture(t);
  const file = join(fx.app, '术 语.md');
  writeFileSync(file, '# 术语');
  const uri = pathToFileURL(file).href;
  const typed = bytes(f(1, 5), f(10, bytes(action(uri, 21), f(24, 1))), f(5, f(23, 7)));
  const any = bytes(f(1, 'type.googleapis.com/gemini_coder.Step'), f(2, typed));
  fx.step(132, 140, f(2, f(6, any)));
  const archived = bytes(f(1, 'type.googleapis.com/gemini_coder.Step'), f(2, bytes(f(1, 5), f(10, action('other.md', 21)))));
  fx.step(132, 140, f(2, f(5, bytes(f(1, '__original_cortex_step'), f(2, archived)))));
  for (const [name, key] of [['read_file', 'Path'], ['view_file', 'AbsolutePath'], ['read_file', 'FilePath']]) {
    fx.step(132, 140, f(2, Buffer.alloc(0)), call(name, { [key]: 'skills/demo/SKILL.md' }));
  }
  fx.step(132, 140, f(2, Buffer.alloc(0)), call('read_file', '{'));
  mkdirSync(join(fx.app, '.agents', 'rules'), { recursive: true });
  mkdirSync(join(fx.app, '_agents'));
  writeFileSync(join(fx.app, '_agents', 'hooks.json'), '{}');
  const r = fx.report(pathToFileURL(fx.app).href);
  assert.deepEqual([r.artifact_files.length, r.knowledge_files.length, r.skill_files.length], [2, 1, 1]);
  assert.equal(r.artifact_files[1].originalPath, 'other.md');
  assert.deepEqual([r.artifact_files[0].tokens, r.artifact_files[0].fileUri, r.artifact_files[0].originalPath], [7, uri, uri]);
  assert.equal(r.skill_files[0].fullPath, join(fx.app, 'skills', 'demo', 'SKILL.md'));
  assert.equal(r.skill_files[0].fileUri, '');
  assert.equal(r.system_files.find(f => f.path === '.agents/rules/').fileUri, '');
  assert.ok(r.system_files.find(f => f.path === '_agents/hooks.json').fileUri.startsWith('file:///'));
  assert.equal(localPath('file://remote/share/SKILL.md'), '');
});

test('report cache includes WAL-only writes, summary title changes and workspace', t => {
  const fx = fixture(t);
  fx.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  basic(fx);
  assert.equal(fx.report(), fx.report());
  const before = statSync(fx.dbPath);
  const a = fx.report();
  fx.step(14, 19, f(2, 'more'));
  assert.deepEqual([statSync(fx.dbPath).mtimeMs, statSync(fx.dbPath).size], [before.mtimeMs, before.size]);
  assert.equal(fx.report().used_tokens, a.used_tokens + 1);
  fx.summary('重新命名');
  assert.equal(fx.report().title, '重新命名');
  assert.notEqual(fx.report(), fx.report(fx.app));
  assert.throws(() => getReport(fx.app, 'not-a-uuid'), /有效的会话/);
});

test('strips host annotations, including metadata-only events and incomplete request wrappers', () => {
  assert.equal(cleanUser('<USER_REQUEST>中文</USER_REQUEST><ADDITIONAL_METADATA>私有</ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>变化</USER_SETTINGS_CHANGE>'), '中文');
  assert.equal(cleanUser('<ADDITIONAL_METADATA>私有</ADDITIONAL_METADATA>'), '');
  assert.equal(cleanUser('<USER_REQUEST>用户正文'), '用户正文');
  assert.equal(cleanUser('用户正文</USER_REQUEST>'), '用户正文');
});

test('the 21st conversation evicts the oldest report', t => {
  const fx = fixture(t);
  const first = fx.report();
  for (let i = 0; i < 20; ++i) {
    const id = '00000000-0000-0000-0000-' + String(i).padStart(12, '0');
    copyFileSync(fx.dbPath, join(fx.app, 'conversations', id + '.db'));
    getReport(fx.app, id);
  }
  assert.notEqual(fx.report(), first);
});

test('missing summary rows and an unreadable summary schema still allow trajectory accounting', t => {
  const fx = fixture(t);
  basic(fx);
  const r = fx.report();
  assert.equal(r.title, '');
  fx.index.exec('DROP TABLE conversation_summaries');
  const degraded = fx.report();
  assert.deepEqual([degraded.title, degraded.used_tokens], ['', r.used_tokens]);
  assert.match(degraded.summary_warning, /conversation_summaries/);
});

test('creation result takes precedence over overwrite permission in a write_file call', t => {
  const fx = fixture(t);
  const result = f(2, f(1, 'Completed At: 12:00\nCreated file.'));
  fx.step(132, 140, result, call('write_file', { Path: 'new.md', Overwrite: true }));
  fx.step(132, 140, Buffer.alloc(0), call('write_file', { Path: 'unknown.md', Overwrite: true }));
  const md = fx.handoff().markdown;
  assert.ok(md.includes('`new.md` · 新增 1 次'));
  assert.ok(md.includes('`unknown.md` · 写入 1 次（原文件状态未记录）'));
});

test('decodes JSON-encoded transcript fields before matching DB edits and formatting commands', t => {
  const fx = fixture(t);
  const path = String.raw`d:\Workspace\demo\src\localEditor.ts`;
  const firstLine = 'node --check ' + 'x'.repeat(165);
  const command = '\r\n  \r\n' + firstLine + '\nnode --version';
  const label = 'Check and complete "editor"';
  fx.step(15, 20, f(1, '实施改动'));
  fx.step(132, 140, f(2, f(1, 'Created file.')), call('write_file', { Path: path, Overwrite: true }));
  fx.step(5, 10, action(path), call('edit_file', { Path: path }));
  fx.transcript([{ step_index: 0, type: 'PLANNER_RESPONSE', tool_calls: [
    { name: 'write_file', args: { Path: JSON.stringify(path), Overwrite: 'true' } },
    { name: 'edit_file', args: { Path: JSON.stringify(path) } },
    { name: 'run_command', args: { CommandLine: JSON.stringify(command), toolSummary: JSON.stringify(label) } },
    { name: 'update_steps', args: { steps: JSON.stringify([{ title: '核对文件', status: 'done' }]) } },
  ] }]);
  const compact = fx.handoff(), full = fx.handoff('full');
  const section = (doc, title) => doc.markdown.split('## ' + title + '\n\n')[1].split('\n\n## ')[0].trimEnd();
  for (const doc of [compact, full]) {
    assert.equal(doc.stats.files, 1);
    assert.equal(section(doc, '文件改动'), '- `' + path + '` · 新增 1 次，修改 1 次');
    assert.equal(section(doc, '最新任务清单'), '- [x] 核对文件');
  }
  assert.equal(section(compact, '关键命令'), '- ' + label + ' · `' + firstLine.slice(0, 149) + '…`');
  assert.equal(section(full, '关键命令'), label + '\n\n```text\n' + command.trim() + '\n```');
});

test('plain transcript text stays usable as a single-line command or a Markdown code span', t => {
  const fx = fixture(t);
  fx.transcript([{ step_index: 0, type: 'PLANNER_RESPONSE', tool_calls: [
    { name: 'run_command', args: { CommandLine: 'true', toolSummary: '首行\n后续说明' } },
    { name: 'run_command', args: { CommandLine: '\n  \n' } },
    { name: 'edit_file', args: { Path: '123' } },
    { name: 'edit_file', args: { Path: '`draft`' } },
    { name: 'edit_file', args: { Path: 'a`b.md' } },
    { name: 'edit_file', args: { Path: ' note.md ' } },
  ] }]);
  const { markdown } = fx.handoff();
  assert.ok(markdown.includes('## 关键命令\n\n- 首行 · `true`\n\n## '));
  for (const span of ['`123`', '`` `draft` ``', '``a`b.md``', '`  note.md  `']) {
    assert.ok(markdown.includes('- ' + span + ' · 修改 1 次'));
  }
});

test('a clipped transcript argument is restored from the same planner step and tool ordinal', t => {
  const fx = fixture(t);
  const first = { CommandLine: 'node --version', toolSummary: '版本' };
  const second = { CommandLine: "node --check app.js\nnode --test", toolSummary: 'DB 中的说明' };
  const plannerCall = args => f(7, bytes(f(2, 'run_command'), f(3, JSON.stringify(args))));
  fx.step(15, 20, bytes(plannerCall(first), plannerCall(second)));
  fx.transcript([{ step_index: 0, type: 'PLANNER_RESPONSE', truncated_fields: ['tool_calls'], tool_calls: [
    { name: 'run_command', args: { CommandLine: JSON.stringify(first.CommandLine), toolSummary: '"版本"' } },
    { name: 'run_command', args: { CommandLine: '"node --check app.js\\nnode\n<truncated 8 bytes>', toolSummary: '"检查与测试"' } },
  ] }]);
  const compact = fx.handoff().markdown;
  assert.ok(compact.includes('- 版本 · `node --version`\n- 检查与测试 · `node --check app.js`'));
  const full = fx.handoff('full').markdown;
  assert.ok(full.includes('检查与测试\n\n```text\n' + second.CommandLine + '\n```'));
  assert.doesNotMatch(full, /<truncated|DB 中的说明/);
});

test('handoff merges planner calls with DB results once, clears failed edits, preserves latest tasks and full commands', t => {
  const fx = fixture(t);
  fx.summary('交接/标题', [pathToFileURL(fx.app).href]);
  const first = '首轮原文。' + '上下文'.repeat(450) + '验收要求。';
  const path = join(fx.app, 'work.txt');
  const more = join(fx.app, 'also.txt');
  const statuses = ['done', 'in_progress', 'pending', 'failed', 'skipped'];
  const list = statuses.map(status => ({ title: '最新' + status, status }));
  fx.step(14, 19, f(2, '数据库中的用户'));
  fx.step(15, 20, f(1, '数据库中的回复'));
  fx.step(5, 10, action(pathToFileURL(path).href), call('write_file', { Path: path, Overwrite: false }));
  fx.step(5, 10, action(pathToFileURL(path).href), call('edit_file', { Path: path }));
  fx.step(5, 10, action(pathToFileURL(more).href));
  fx.step(132, 140, Buffer.alloc(0), call('edit_file', { Path: 'failed.txt' }), 7);
  fx.step(23, 30, ck(0, '检查计划', '检查点摘要'));
  fx.transcript([
    { step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>${first}</USER_REQUEST><ADDITIONAL_METADATA>不要出现</ADDITIONAL_METADATA>` },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: '我先看一下。', tool_calls: [
      { name: 'update_steps', args: { steps: [{ title: '旧任务', status: 'done' }] } },
      { name: 'write_file', args: { Path: path, Overwrite: 'false' } }, { name: 'edit_file', args: { Path: path } },
      { name: 'edit_file', args: { Path: 'failed.txt' } }, { name: 'run_command', args: { CommandLine: 'node --version\nnode --test', toolSummary: '运行测试' } },
    ] },
    { step_index: 7, type: 'PLANNER_RESPONSE', content: '已完成接口实现，验证了导出文件。', tool_calls: [
      { name: 'update_steps', args: { steps: JSON.stringify(list) } }, { name: 'run_command', args: { CommandLine: 'node --version\nnode --test', toolSummary: '版本检查' } },
    ] },
    { step_index: 8, type: 'EPHEMERAL_MESSAGE', content: '不要出现' },
  ]);
  writeFileSync(join(fx.brain, 'plan.md'), '# 迁移计划');
  writeFileSync(join(fx.brain, '.hidden.md'), '# 不应出现');
  mkdirSync(join(fx.brain, 'scratch'));
  writeFileSync(join(fx.brain, 'scratch', 'temp.md'), '# 不应出现');
  const c = fx.handoff(), full = fx.handoff('full');
  assert.deepEqual([c.stats.files, c.stats.turns, c.stats.artifacts], [2, 1, 1]);
  for (const checkbox of ['[x]', '[-]', '[ ]', '[!]', '[~]']) assert.ok(c.markdown.includes(checkbox + ' 最新'));
  assert.match(c.markdown, /新增 1 次，修改 1 次/);
  assert.match(c.markdown, /迁移计划/);
  assert.match(c.markdown, /检查点摘要/);
  assert.match(c.markdown, /版本检查/);
  assert.match(c.markdown, /下一会话接棒指引/);
  assert.doesNotMatch(c.markdown, /不要出现|不应出现|ADDITIONAL_METADATA|旧任务|我先看一下|failed\.txt|node --test|数据库中的用户/);
  assert.ok(full.markdown.includes(first));
  assert.ok(full.markdown.includes('node --version\nnode --test'));
  assert.equal(full.stats.characters, [...full.markdown].length);
  assert.ok(full.stats.characters > c.stats.characters);
});

test('missing log falls back to DB messages, tasks, commands and checkpoints; incomplete last row is never published', t => {
  const fx = fixture(t);
  basic(fx);
  fx.step(23, 30, ck(0, '摘要意图', '摘要内容'));
  fx.step(132, 140, Buffer.alloc(0), call('update_steps', { steps: [{ title: 'DB任务', status: 'done' }] }));
  fx.step(132, 140, Buffer.alloc(0), call('run_command', { CommandLine: 'node -v' }));
  const md = fx.handoff().markdown;
  for (const text of ['会话数据库', 'hello world!!', 'r'.repeat(40), '摘要内容', 'DB任务', 'node -v']) assert.ok(md.includes(text));
  fx.transcript([{ step_index: 0, type: 'USER_INPUT', content: '已落盘' }]);
  writeFileSync(fx.log, readFileSync(fx.log, 'utf8') + '{"step_index":1');
  assert.match(fx.handoff().markdown, /已落盘/);
  writeFileSync(fx.log, '{broken}\n');
  assert.throws(() => fx.handoff(), /第 1 行/);
});

test('exports exactly the preview, refuses stale or invalid requests, creates private fixed targets with collision suffixes', t => {
  const fx = fixture(t);
  const mockHome = t.mock.method(os, 'homedir', () => fx.app);
  syncBuiltinESMExports();
  t.after(() => { mockHome.mock.restore(); syncBuiltinESMExports(); });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 2, 3, 4, 5) });
  basic(fx);
  fx.summary(' ..\\恶意<>:/标题?. ');
  const preview = fx.handoff().markdown;
  const opts = { target: 'downloads', expectedMarkdown: preview };
  const saved = exportHandoff(fx.app, ID, opts);
  assert.equal(saved.filename, 'handoff-恶意-标题-20260102-030405.md');
  assert.equal(saved.path, join(fx.app, 'Downloads', saved.filename));
  assert.deepEqual([saved.ok, saved.fileUri, saved.bytes], [true, pathToFileURL(saved.path).href, Buffer.byteLength(preview)]);
  assert.equal(readFileSync(saved.path, 'utf8'), preview);
  assert.equal(exportHandoff(fx.app, ID, opts).filename, saved.filename.replace('.md', '-2.md'));
  const brain = exportHandoff(fx.app, ID, { target: 'brain' });
  assert.equal(brain.path, join(fx.brain, saved.filename));
  fx.step(14, 19, f(2, '新消息'));
  assert.throws(() => exportHandoff(fx.app, ID, opts), e => e.status === 409);
  assert.equal(readdirSync(join(fx.app, 'Downloads')).length, 2);
  assert.throws(() => exportHandoff(fx.app, ID, { target: 'other' }), /导出目标/);
  assert.throws(() => exportHandoff(fx.app, '../invalid', { target: 'brain' }), /有效的会话/);
  assert.throws(() => fx.handoff('other'), /交接模式/);
  rmSync(join(fx.app, 'Downloads'), { recursive: true });
  symlinkSync(fx.brain, join(fx.app, 'Downloads'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportHandoff(fx.app, ID, { target: 'downloads' }), /符号链接或联接点/);
});

