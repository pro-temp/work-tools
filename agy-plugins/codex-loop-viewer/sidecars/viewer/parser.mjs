import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TURN_ID_RE = /^[a-z0-9-]+$/i;
const DESKTOP_TURN_RE = /^desktop-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i;
const MAX_INLINE_OUTPUT_CHARS = 200_000;
const DEFAULT_RAW_LIMIT_BYTES = 512 * 1024;
const MAX_RAW_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_BRAIN_CONVERSATIONS_SCAN = 25;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<INSTRUCTIONS>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<skills_instructions>',
  '<user_instructions>',
];

const statusJsonCache = new Map(); // path -> { stamp, data }
const eventsStreamCache = new Map(); // path -> { offset, size, mtimeMs, partialLine, decoder, state }
const rolloutCache = new Map(); // path -> { stamp, parsed }
const rolloutPathIndexCache = new Map(); // sid -> { path, checkedAt }
const runRegistry = new Map(); // runId -> discovered entry

function setBounded(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

export function findAppDataDir() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') return dirname(d);
    }
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    return process.env.ANTIGRAVITY_APP_DATA_DIR;
  }
  return join(homedir(), '.gemini', 'antigravity');
}

function getCodexSessionRoots() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];
}

export function uriToLocalPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  const trimmed = uri.trim();
  if (!trimmed) return '';
  if (/^file:/i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  return resolve(trimmed);
}

export function toSafeFileUri(filePath, workDir) {
  if (!filePath || typeof filePath !== 'string') return '';
  const trimmed = filePath.trim();
  if (!trimmed) return '';
  try {
    const abs = isAbsolute(trimmed) ? trimmed : (workDir ? resolve(workDir, trimmed) : '');
    if (!abs) return '';
    return pathToFileURL(abs).href;
  } catch {
    return '';
  }
}

function normPath(p) {
  if (!p || typeof p !== 'string') return '';
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(rootDir, targetPath) {
  if (!rootDir || !targetPath) return false;
  const r = normPath(rootDir);
  const t = normPath(targetPath);
  const rel = relative(r, t);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function makeRunId(key) {
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function statInfo(path) {
  if (!path) return null;
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory(), isFile: s.isFile() };
  } catch {
    return null;
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function resolveContainedFile(rootDir, candidatePath) {
  if (!rootDir || !candidatePath) return null;
  try {
    const rootReal = realpathSync(rootDir);
    const targetReal = realpathSync(candidatePath);
    const st = statSync(targetReal);
    if (!st.isFile()) return null;
    return isPathInside(rootReal, targetReal) ? targetReal : null;
  } catch {
    return null;
  }
}

function readFullUtf8(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readCachedJson(path) {
  const st = statInfo(path);
  if (!st?.isFile || st.size === 0) return null;
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = statusJsonCache.get(path);
  if (cached && cached.stamp === stamp) return cached.data;
  const raw = readFullUtf8(path);
  if (!raw || !raw.trim()) return null;
  try {
    const data = JSON.parse(raw);
    setBounded(statusJsonCache, path, { stamp, data }, 256);
    return data;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function isZstdFile(path) {
  if (!path) return false;
  if (path.toLowerCase().endsWith('.zst')) return true;
  let fd;
  try {
    fd = openSync(path, 'r');
    const hdr = Buffer.alloc(4);
    const n = readSync(fd, hdr, 0, 4, 0);
    return n === 4 && hdr.equals(ZSTD_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function matchesRolloutFilename(filePath, sidLower) {
  const name = basename(filePath).toLowerCase();
  return name.startsWith('rollout-') && (name.endsWith(`-${sidLower}.jsonl`) || name.endsWith(`-${sidLower}.jsonl.zst`));
}

function validateRolloutRealpath(roots, candidatePath, sidLower) {
  if (!candidatePath) return null;
  for (const root of roots) {
    const contained = resolveContainedFile(root, candidatePath);
    if (contained && matchesRolloutFilename(contained, sidLower)) {
      return contained;
    }
  }
  return null;
}

function findRolloutInTree(rootDir, sidLower) {
  if (!statInfo(rootDir)?.isDir) return null;
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const e of safeReaddir(cur)) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && matchesRolloutFilename(full, sidLower)) {
        const contained = resolveContainedFile(rootDir, full);
        if (contained && matchesRolloutFilename(contained, sidLower)) return contained;
      }
    }
  }
  return null;
}

export function resolveRolloutBySessionId(sessionId, hintPath = null) {
  if (!UUID_RE.test(sessionId || '')) return null;
  const sidLower = sessionId.toLowerCase();
  const roots = getCodexSessionRoots();

  if (hintPath) {
    const validHint = validateRolloutRealpath(roots, hintPath, sidLower);
    if (validHint) {
      setBounded(rolloutPathIndexCache, sidLower, { path: validHint, checkedAt: Date.now() }, 256);
      return validHint;
    }
  }

  const cached = rolloutPathIndexCache.get(sidLower);
  if (cached) {
    if (cached.path) {
      const validCached = validateRolloutRealpath(roots, cached.path, sidLower);
      if (validCached) return validCached;
    } else if (Date.now() - cached.checkedAt < 3000) {
      return null;
    }
  }

  for (const root of roots) {
    const found = findRolloutInTree(root, sidLower);
    if (found) {
      setBounded(rolloutPathIndexCache, sidLower, { path: found, checkedAt: Date.now() }, 256);
      return found;
    }
  }

  setBounded(rolloutPathIndexCache, sidLower, { path: null, checkedAt: Date.now() }, 256);
  return null;
}

function isConfirmedSessionStatus(d) {
  if (!d || !UUID_RE.test(d.session_id || '')) return false;
  if (d.error_kind === 'invalid_session') return false;
  return Boolean(d.desktop_url || d.native_session || d.sidebar_registered || d.state === 'finished');
}

function extractTitleFromPrompt(text) {
  if (!text) return '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const clean = trimmed.replace(/^#+\s*/, '').trim();
    if (clean) return clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
  }
  return '';
}

function listStatusFilesInDir(dir) {
  const entries = safeReaddir(dir);
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.status.json')) {
      const turnId = e.name.slice(0, -'.status.json'.length);
      if (!SAFE_TURN_ID_RE.test(turnId)) continue;
      const fullPath = resolveContainedFile(dir, join(dir, e.name));
      if (!fullPath) continue;
      const st = statInfo(fullPath);
      if (st) out.push({ name: e.name, turnId, path: fullPath, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function scanScratchForRunDirs(scratchDir, maxDepth = 2) {
  const found = [];
  function walk(dir, depth) {
    const entries = safeReaddir(dir);
    let hasStatus = false;
    const subdirs = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.status.json')) {
        hasStatus = true;
      } else if (e.isDirectory() && depth < maxDepth) {
        subdirs.push(join(dir, e.name));
      }
    }
    if (hasStatus) found.push(dir);
    for (const sub of subdirs) walk(sub, depth + 1);
  }
  if (statInfo(scratchDir)?.isDir) walk(scratchDir, 0);
  return found;
}

function inferConversationFromRunDir(runDir, appDataDir) {
  const brainDir = join(appDataDir, 'brain');
  if (!isPathInside(brainDir, runDir)) return null;
  const rel = relative(normPath(brainDir), normPath(runDir));
  const firstSegment = rel.split(sep)[0];
  return UUID_RE.test(firstSegment) ? firstSegment : null;
}

function pathMatchesAnyWorkspace(workDir, workspacePaths) {
  if (!workDir || !workspacePaths.length) return false;
  for (const wsRaw of workspacePaths) {
    if (!wsRaw) continue;
    if (isPathInside(wsRaw, workDir) || isPathInside(workDir, wsRaw)) {
      return true;
    }
  }
  return false;
}

function resolveTurnFiles(runDir, turnId, statusData, isFirstTurn) {
  const files = {
    status: resolveContainedFile(runDir, join(runDir, `${turnId}.status.json`)),
    events: resolveContainedFile(runDir, join(runDir, `${turnId}.events.jsonl`)),
    handoff: resolveContainedFile(runDir, join(runDir, `${turnId}.handoff.json`)),
    stderr: resolveContainedFile(runDir, join(runDir, `${turnId}.stderr.txt`)),
    prompt: null,
    promptSource: 'none',
    rollout: null,
  };

  // Only accept prompt files strictly contained within runDir (blocks arbitrary file reads / symlinks).
  const promptCandidates = [
    { path: join(runDir, `${turnId}.prompt.txt`), src: 'prompt_file' },
    { path: statusData?.prompt_file, src: 'prompt_file' },
    { path: statusData?.source_prompt_file, src: 'source_prompt_file' },
  ];
  if (isFirstTurn) {
    promptCandidates.push({ path: join(runDir, 'prompt.txt'), src: 'legacy_prompt_txt' });
  }
  for (const c of promptCandidates) {
    if (!c.path) continue;
    const safePath = resolveContainedFile(runDir, c.path);
    if (safePath) {
      files.prompt = safePath;
      files.promptSource = c.src;
      break;
    }
  }

  if (isConfirmedSessionStatus(statusData)) {
    files.rollout = resolveRolloutBySessionId(statusData.session_id, statusData.native_session);
  }
  return files;
}

function computeTurnEffectiveState(data) {
  const raw = data?.state || 'unknown';
  if (raw !== 'running') return { effectiveState: raw, isAlive: false };
  const alive = isPidAlive(data.runner_pid) || isPidAlive(data.cli_pid);
  return { effectiveState: alive ? 'running' : 'interrupted', isAlive: alive };
}

function summarizeRunDir(runDir, seedMeta, appDataDir) {
  const statusFiles = listStatusFilesInDir(runDir);
  if (statusFiles.length === 0) return null;

  const statuses = [];
  for (const sf of statusFiles) {
    const parsed = readCachedJson(sf.path);
    if (!parsed) continue;
    statuses.push({ file: sf, data: parsed });
  }
  if (statuses.length === 0) return null;

  statuses.sort((a, b) => {
    const ta = Date.parse(a.data.started_at || '') || a.file.mtimeMs;
    const tb = Date.parse(b.data.started_at || '') || b.file.mtimeMs;
    if (ta !== tb) return ta - tb;
    return a.file.name.localeCompare(b.file.name);
  });

  const first = statuses[0].data;
  const latest = statuses[statuses.length - 1].data;
  const latestFile = statuses[statuses.length - 1].file;

  const conversationId =
    latest.conversation_id ||
    first.conversation_id ||
    seedMeta?.conversation_id ||
    inferConversationFromRunDir(runDir, appDataDir) ||
    null;

  // Keep strictly paired confirmed sessions (never mix session B's ID with session A's desktopUrl/nativeSession).
  const confirmedMap = new Map();
  let sidebarTitle = null;
  let effective = null;
  for (const { data: d } of statuses) {
    if (d.sidebar_title) sidebarTitle = d.sidebar_title;
    if (d.effective && (d.effective.model || d.effective.effort)) effective = d.effective;
    if (!isConfirmedSessionStatus(d)) continue;
    const sid = d.session_id.toLowerCase();
    const prev = confirmedMap.get(sid);
    const resolvedRollout = resolveRolloutBySessionId(sid, d.native_session) || prev?.nativeSession || null;
    confirmedMap.delete(sid);
    confirmedMap.set(sid, {
      sessionId: sid,
      desktopUrl: d.desktop_url || prev?.desktopUrl || `codex://threads/${sid}`,
      nativeSession: resolvedRollout,
    });
  }

  const confirmedSessions = [...confirmedMap.values()];
  const latestConfirmed = confirmedSessions.length > 0 ? confirmedSessions[confirmedSessions.length - 1] : null;
  const workDir = latest.work_dir || first.work_dir || seedMeta?.work_dir || '';

  let title = sidebarTitle || seedMeta?.title || '';
  if (!title) {
    const firstFiles = resolveTurnFiles(runDir, statuses[0].file.turnId, first, true);
    if (firstFiles.prompt) {
      const txt = readFullUtf8(firstFiles.prompt);
      if (txt) title = extractTitleFromPrompt(txt);
    }
  }
  if (!title) title = basename(runDir);

  let isAlive = false;
  let effectiveState = computeTurnEffectiveState(latest).effectiveState;
  for (const { data: d } of statuses) {
    const st = computeTurnEffectiveState(d);
    if (st.isAlive) {
      isAlive = true;
      effectiveState = 'running';
      break;
    }
  }

  const startedAt = first.started_at || new Date(statuses[0].file.mtimeMs).toISOString();
  const updatedMs = Math.max(
    Date.parse(latest.finished_at || '') || 0,
    Date.parse(latest.started_at || '') || 0,
    latestFile.mtimeMs,
  );
  const updatedAt = new Date(updatedMs).toISOString();

  return {
    id: makeRunId(`dir:${normPath(runDir)}`),
    runDir,
    workDir,
    conversationId,
    sessionId: latestConfirmed?.sessionId || null,
    desktopUrl: latestConfirmed?.desktopUrl || null,
    nativeSession: latestConfirmed?.nativeSession || null,
    confirmedSessions,
    title,
    taskKind: latest.task_kind || first.task_kind || 'implement',
    mode: latest.requested_mode || first.requested_mode || null,
    model: effective?.model || latest.requested_model || first.requested_model || null,
    effort: effective?.effort || latest.requested_effort || first.requested_effort || null,
    state: latest.state || 'unknown',
    effectiveState,
    isAlive,
    turnsCount: statuses.length,
    startedAt,
    updatedAt,
    rolloutOnly: false,
  };
}

export function discoverRuns(appDataDir, conversationId = '', workspacesInput = []) {
  const rawList = Array.isArray(workspacesInput) ? workspacesInput : (workspacesInput ? [workspacesInput] : []);
  const workspacePaths = rawList.map(uriToLocalPath).filter(Boolean);

  const candidates = new Map();
  const rolloutOnlySeeds = [];

  const indexPath = join(appDataDir, 'codex-loop', 'runs.json');
  const indexData = readCachedJson(indexPath);
  if (Array.isArray(indexData)) {
    for (const item of indexData) {
      if (!item || !item.run_dir) continue;
      if (statInfo(item.run_dir)?.isDir && listStatusFilesInDir(item.run_dir).length > 0) {
        candidates.set(normPath(item.run_dir), { runDir: item.run_dir, seedMeta: item });
      } else {
        rolloutOnlySeeds.push(item);
      }
    }
  }

  const brainDir = join(appDataDir, 'brain');
  if (UUID_RE.test(conversationId)) {
    const convScratch = join(brainDir, conversationId, 'scratch');
    for (const dir of scanScratchForRunDirs(convScratch, 2)) {
      const k = normPath(dir);
      if (!candidates.has(k)) candidates.set(k, { runDir: dir, seedMeta: { conversation_id: conversationId } });
    }
  }

  if (statInfo(brainDir)?.isDir) {
    const convDirs = [];
    for (const e of safeReaddir(brainDir)) {
      if (!e.isDirectory() || !UUID_RE.test(e.name)) continue;
      if (e.name.toLowerCase() === conversationId.toLowerCase()) continue;
      const scratchPath = join(brainDir, e.name, 'scratch');
      const st = statInfo(scratchPath);
      if (st?.isDir) convDirs.push({ convId: e.name, scratchPath, mtimeMs: st.mtimeMs });
    }
    convDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of convDirs.slice(0, MAX_BRAIN_CONVERSATIONS_SCAN)) {
      for (const dir of scanScratchForRunDirs(c.scratchPath, 2)) {
        const k = normPath(dir);
        if (!candidates.has(k)) candidates.set(k, { runDir: dir, seedMeta: { conversation_id: c.convId } });
      }
    }
  }

  const tempRoot = join(tmpdir(), 'codex-loop');
  if (statInfo(tempRoot)?.isDir) {
    for (const e of safeReaddir(tempRoot)) {
      if (!e.isDirectory()) continue;
      const dir = join(tempRoot, e.name);
      const k = normPath(dir);
      if (!candidates.has(k) && listStatusFilesInDir(dir).length > 0) {
        candidates.set(k, { runDir: dir, seedMeta: null });
      }
    }
  }

  const runs = [];
  const seenSessions = new Set();

  for (const { runDir, seedMeta } of candidates.values()) {
    const summary = summarizeRunDir(runDir, seedMeta, appDataDir);
    if (!summary) continue;
    for (const s of summary.confirmedSessions) seenSessions.add(s.sessionId);
    runs.push(summary);
  }

  // Keep archived runs whose RunDir was pruned, preserving ALL confirmed sessions in that directory.
  for (const seed of rolloutOnlySeeds) {
    const rawSessions = Array.isArray(seed.sessions) && seed.sessions.length > 0
      ? seed.sessions
      : (seed.session_id ? [{ session_id: seed.session_id, desktop_url: seed.desktop_url, native_session: seed.native_session }] : []);

    const confirmedSessions = [];
    for (const s of rawSessions) {
      if (!s || !UUID_RE.test(s.session_id || '')) continue;
      const sid = s.session_id.toLowerCase();
      if (seenSessions.has(sid)) continue;
      const rolloutPath = resolveRolloutBySessionId(sid, s.native_session);
      if (!rolloutPath) continue;
      seenSessions.add(sid);
      confirmedSessions.push({
        sessionId: sid,
        desktopUrl: s.desktop_url || `codex://threads/${sid}`,
        nativeSession: rolloutPath,
      });
    }
    if (confirmedSessions.length === 0) continue;

    const latest = confirmedSessions[confirmedSessions.length - 1];
    const st = statInfo(latest.nativeSession);
    runs.push({
      id: makeRunId(`rollout:${normPath(seed.run_dir || latest.nativeSession)}`),
      runDir: seed.run_dir,
      workDir: seed.work_dir || '',
      conversationId: seed.conversation_id || null,
      sessionId: latest.sessionId,
      desktopUrl: latest.desktopUrl,
      nativeSession: latest.nativeSession,
      confirmedSessions,
      title: seed.title || basename(seed.run_dir || latest.nativeSession),
      taskKind: seed.task_kind || 'implement',
      mode: null,
      model: null,
      effort: null,
      state: seed.state || 'finished',
      effectiveState: seed.state === 'running' ? 'interrupted' : (seed.state || 'finished'),
      isAlive: false,
      turnsCount: null,
      startedAt: seed.started_at || (st ? new Date(st.mtimeMs).toISOString() : null),
      updatedAt: seed.updated_at || (st ? new Date(st.mtimeMs).toISOString() : null),
      rolloutOnly: true,
    });
  }

  for (const r of runs) {
    if (conversationId && r.conversationId && r.conversationId.toLowerCase() === conversationId.toLowerCase()) {
      r.scope = 'conversation';
    } else if (pathMatchesAnyWorkspace(r.workDir, workspacePaths)) {
      r.scope = 'workspace';
    } else {
      r.scope = 'other';
    }
  }

  const scopeRank = { conversation: 0, workspace: 1, other: 2 };
  runs.sort((a, b) => {
    if (scopeRank[a.scope] !== scopeRank[b.scope]) return scopeRank[a.scope] - scopeRank[b.scope];
    if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });

  runRegistry.clear();
  for (const r of runs) runRegistry.set(r.id, r);

  const defaultRunId = runs[0]?.id || null;
  return { runs, defaultRunId, conversationId: conversationId || null, workspacePaths };
}

export function getRegisteredRun(runId) {
  return runRegistry.get(runId) || null;
}

export function findConfirmedSessionInRegistry(sessionId) {
  if (!UUID_RE.test(sessionId || '')) return null;
  const target = sessionId.toLowerCase();
  for (const r of runRegistry.values()) {
    const found = (r.confirmedSessions || []).find((s) => s.sessionId === target);
    if (found) return { run: r, session: found };
  }
  return null;
}

function clampText(text, maxChars = MAX_INLINE_OUTPUT_CHARS) {
  if (typeof text !== 'string') return { text: '', truncated: false, fullChars: 0 };
  if (text.length <= maxChars) return { text, truncated: false, fullChars: text.length };
  return { text: text.slice(0, maxChars), truncated: true, fullChars: text.length };
}

function normalizeEventItem(item, workDir) {
  const id = item.id || null;
  const status = item.status || 'completed';

  if (item.type === 'command_execution') {
    const out = clampText(item.aggregated_output || '');
    return {
      kind: 'command',
      id,
      status,
      command: item.command || '',
      output: out.text,
      outputTruncated: out.truncated,
      outputFullChars: out.fullChars,
      exitCode: item.exit_code ?? null,
    };
  }
  if (item.type === 'mcp_tool_call') {
    const argsStr = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}, null, 2);
    const resStr = item.result == null ? '' : (typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2));
    const errStr = item.error == null ? '' : (typeof item.error === 'string' ? item.error : JSON.stringify(item.error, null, 2));
    const clampedRes = clampText(resStr);
    return {
      kind: 'mcp_tool',
      id,
      status,
      server: item.server || '',
      tool: item.tool || '',
      argumentsText: clampText(argsStr, 64_000).text,
      resultText: clampedRes.text,
      resultTruncated: clampedRes.truncated,
      errorText: errStr,
    };
  }
  if (item.type === 'agent_message') {
    return {
      kind: 'agent_message',
      id,
      status,
      text: item.text || '',
      isHandoffEcho: false,
    };
  }
  if (item.type === 'reasoning') {
    return { kind: 'reasoning', id, status, text: item.text || '' };
  }
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((c) => ({ ...c, fileUri: toSafeFileUri(c?.path, workDir) }))
      : [];
    return { kind: 'file_change', id, status, changes };
  }
  if (item.type === 'web_search') {
    return { kind: 'web_search', id, status, query: item.query || '' };
  }
  if (item.type === 'todo_list') {
    return { kind: 'todo_list', id, status, items: Array.isArray(item.items) ? item.items : [] };
  }
  if (item.type === 'error') {
    return { kind: 'error', id, status: 'failed', message: item.message || JSON.stringify(item) };
  }
  return {
    kind: 'raw_item',
    id,
    status,
    itemType: item.type || 'unknown',
    rawText: clampText(JSON.stringify(item, null, 2), 64_000).text,
  };
}

function consumeEventLine(line, state, workDir) {
  if (!line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  state.eventCount++;

  if (ev.type === 'turn.started') {
    state.enteredTurn = true;
  } else if (ev.type === 'turn.completed') {
    state.enteredTurn = true;
    if (ev.usage) state.usage = ev.usage;
  } else if (ev.type === 'error' || ev.type === 'turn.failed') {
    const msg = ev.message || ev.error?.message || JSON.stringify(ev);
    state.items.push({ kind: 'error', id: null, status: 'failed', message: msg });
  } else if (ev.item && (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed')) {
    const normalized = normalizeEventItem(ev.item, workDir);
    if (normalized.kind !== 'error') state.enteredTurn = true;
    if (normalized.kind === 'reasoning') state.hasReasoning = true;
    if (ev.type === 'item.started' && !ev.item.status) normalized.status = 'in_progress';
    if (normalized.id && state.byId.has(normalized.id)) {
      state.items[state.byId.get(normalized.id)] = normalized;
    } else {
      if (normalized.id) state.byId.set(normalized.id, state.items.length);
      state.items.push(normalized);
    }
  }
}

// Incremental byte-offset JSONL reader with StringDecoder so arbitrary-size logs never drop tail events or split UTF-8.
function parseEventsIncremental(eventsPath, workDir, handoffRawTrimmed) {
  const st = statInfo(eventsPath);
  if (!st?.isFile || st.size === 0) {
    return { items: [], usage: null, eventCount: 0, hasReasoning: false, enteredTurn: false };
  }

  let cache = eventsStreamCache.get(eventsPath);
  if (!cache || st.size < cache.offset || (st.size === cache.offset && st.mtimeMs !== cache.mtimeMs)) {
    cache = {
      offset: 0,
      mtimeMs: 0,
      partialLine: '',
      decoder: new StringDecoder('utf8'),
      state: { items: [], byId: new Map(), usage: null, eventCount: 0, hasReasoning: false, enteredTurn: false },
    };
  }

  if (st.size > cache.offset) {
    let fd;
    try {
      fd = openSync(eventsPath, 'r');
      const chunkSize = 256 * 1024;
      const buf = Buffer.allocUnsafe(Math.min(chunkSize, st.size - cache.offset));
      let pos = cache.offset;
      while (pos < st.size) {
        const toRead = Math.min(buf.length, st.size - pos);
        const bytesRead = readSync(fd, buf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const decoded = cache.decoder.write(buf.subarray(0, bytesRead));
        const combined = cache.partialLine + decoded;
        const lines = combined.split(/\r?\n/);
        cache.partialLine = lines.pop() ?? '';
        for (const line of lines) {
          consumeEventLine(line, cache.state, workDir);
        }
      }
      cache.offset = pos;
      cache.mtimeMs = st.mtimeMs;
    } catch {
      return { items: [], usage: null, eventCount: 0, hasReasoning: false, enteredTurn: false };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
    setBounded(eventsStreamCache, eventsPath, cache, 64);
  }

  // If the trailing partial line is already complete JSON (e.g. final line without trailing newline), merge it cleanly by item id.
  const outItems = cache.state.items.map((it) => {
    if (it.kind === 'agent_message' && handoffRawTrimmed) {
      return { ...it, isHandoffEcho: it.text.trim() === handoffRawTrimmed };
    }
    return it;
  });

  let extraEventCount = 0;
  let extraEntered = false;
  let extraHasReasoning = false;
  let extraUsage = cache.state.usage;
  if (cache.partialLine.trim()) {
    const tailState = {
      items: [],
      byId: new Map(),
      usage: null,
      eventCount: 0,
      hasReasoning: false,
      enteredTurn: false,
    };
    consumeEventLine(cache.partialLine, tailState, workDir);
    if (tailState.eventCount > 0) {
      extraEventCount = tailState.eventCount;
      extraEntered = tailState.enteredTurn;
      extraHasReasoning = tailState.hasReasoning;
      if (tailState.usage) extraUsage = tailState.usage;
      const mergedById = new Map(cache.state.byId);
      for (const it of tailState.items) {
        if (it.kind === 'agent_message' && handoffRawTrimmed) {
          it.isHandoffEcho = it.text.trim() === handoffRawTrimmed;
        }
        if (it.id && mergedById.has(it.id)) {
          outItems[mergedById.get(it.id)] = it;
        } else {
          if (it.id) mergedById.set(it.id, outItems.length);
          outItems.push(it);
        }
      }
    }
  }

  return {
    items: outItems,
    usage: extraUsage,
    eventCount: cache.state.eventCount + extraEventCount,
    hasReasoning: cache.state.hasReasoning || extraHasReasoning,
    enteredTurn: cache.state.enteredTurn || extraEntered,
  };
}

function isInjectedUserEnvelope(text) {
  const trimmed = (text || '').trimStart();
  if (trimmed.startsWith('# AGENTS.md instructions') && trimmed.includes('<INSTRUCTIONS>')) {
    return true;
  }
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

// Streaming rollout parser supporting arbitrarily large plain .jsonl and compressed .jsonl.zst files.
async function parseRolloutJsonl(rolloutPath) {
  const st = statInfo(rolloutPath);
  if (!st?.isFile) return { ok: false, error: 'file-missing' };
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = rolloutCache.get(rolloutPath);
  if (cached && cached.stamp === stamp) return { ok: true, ...cached.parsed };

  const turns = [];
  let current = null;
  const toolIndex = new Map();

  function startTurn(ts, explicit = false, codexTurnId = null) {
    current = {
      index: turns.length,
      codexTurnId,
      explicit,
      startedAt: ts || null,
      lastActivityAt: ts || null,
      finishedAt: null,
      completed: false,
      aborted: false,
      promptText: '',
      reasonings: [],
      items: [],
      assistantText: '',
    };
    turns.push(current);
    return current;
  }

  function ensureTurn(ts) {
    return current || startTurn(ts, false, null);
  }

  const fileStream = createReadStream(rolloutPath);
  const compressed = isZstdFile(rolloutPath);
  let inputStream = fileStream;
  if (compressed) {
    const decomp = zlib.createZstdDecompress();
    fileStream.on('error', (err) => decomp.destroy(err));
    inputStream = fileStream.pipe(decomp);
  }
  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = obj.timestamp || null;
      if (obj.type === 'event_msg' && obj.payload) {
        if (obj.payload.type === 'task_started') {
          startTurn(ts, true, obj.payload.turn_id || null);
        } else if (obj.payload.type === 'task_complete') {
          if (current) {
            current.completed = true;
            current.lastActivityAt = ts || current.lastActivityAt;
            current.finishedAt = ts || current.lastActivityAt;
          }
        } else if (obj.payload.type === 'turn_aborted' || obj.payload.type === 'error') {
          if (current) {
            current.aborted = true;
            current.lastActivityAt = ts || current.lastActivityAt;
            current.finishedAt = ts || current.lastActivityAt;
          }
        }
        continue;
      }

      if (obj.type !== 'response_item' || !obj.payload) continue;
      const p = obj.payload;

      if (p.type === 'message' && p.role === 'user') {
        const text = extractMessageText(p.content);
        if (!text.trim() || isInjectedUserEnvelope(text)) continue;
        // Prefer task_started turn boundaries so in-turn steering/follow-up messages stay inside the same turn.
        if (current && current.explicit && !current.completed && !current.aborted) {
          current.lastActivityAt = ts || current.lastActivityAt;
          if (!current.promptText) {
            current.promptText = text;
            if (!current.startedAt) current.startedAt = ts;
          } else {
            current.items.push({ kind: 'user_message', id: p.id || null, status: 'completed', text });
          }
        } else {
          const t = startTurn(ts, false, null);
          t.promptText = text;
        }
      } else if (p.type === 'reasoning') {
        const summaryTexts = Array.isArray(p.summary)
          ? p.summary.map((s) => s?.text).filter((t) => typeof t === 'string' && t.trim())
          : [];
        if (summaryTexts.length === 0) continue;
        const text = summaryTexts.join('\n\n');
        const t = ensureTurn(ts);
        t.lastActivityAt = ts || t.lastActivityAt;
        t.reasonings.push(text);
        t.items.push({ kind: 'reasoning', id: p.id || null, status: 'completed', text });
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        const t = ensureTurn(ts);
        t.lastActivityAt = ts || t.lastActivityAt;
        const rawArgs = p.input ?? p.arguments ?? '';
        const argsText = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs, null, 2);
        const item = {
          kind: 'tool_call',
          id: p.call_id || p.id || null,
          status: p.status || 'completed',
          name: p.name || 'tool',
          argumentsText: clampText(argsText, 64_000).text,
          outputText: '',
          outputTruncated: false,
        };
        if (item.id) toolIndex.set(item.id, { turn: t, idx: t.items.length });
        t.items.push(item);
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const rawOut = p.output ?? '';
        const outStr = typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut, null, 2);
        const clamped = clampText(outStr);
        const ref = p.call_id ? toolIndex.get(p.call_id) : null;
        if (ref) {
          ref.turn.lastActivityAt = ts || ref.turn.lastActivityAt;
          ref.turn.items[ref.idx].outputText = clamped.text;
          ref.turn.items[ref.idx].outputTruncated = clamped.truncated;
        } else {
          const t = ensureTurn(ts);
          t.lastActivityAt = ts || t.lastActivityAt;
          t.items.push({
            kind: 'tool_call',
            id: p.call_id || p.id || null,
            status: 'completed',
            name: p.name || 'tool_output',
            argumentsText: '',
            outputText: clamped.text,
            outputTruncated: clamped.truncated,
          });
        }
      } else if (p.type === 'message' && p.role === 'assistant') {
        const text = extractMessageText(p.content);
        if (!text.trim()) continue;
        const t = ensureTurn(ts);
        t.lastActivityAt = ts || t.lastActivityAt;
        t.assistantText = text;
        t.items.push({
          kind: 'agent_message',
          id: p.id || null,
          status: p.status || 'completed',
          text,
          isHandoffEcho: false,
        });
      }
    }
  } catch (err) {
    return { ok: false, error: err?.message || 'stream-read-failed' };
  } finally {
    rl.close();
    fileStream.destroy();
  }

  const nonEmptyTurns = turns.filter((t) => t.promptText || t.items.length > 0 || t.completed || t.aborted);
  const parsed = { turns: nonEmptyTurns, mtimeMs: st.mtimeMs };
  setBounded(rolloutCache, rolloutPath, { stamp, parsed }, 32);
  return { ok: true, ...parsed };
}

function normPromptForMatch(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function matchRolloutTurn(rolloutTurns, consumedSet, loopTurn) {
  if (!rolloutTurns || rolloutTurns.length === 0) return null;

  const targetPrompt = normPromptForMatch(loopTurn.promptText);
  const startMs = Date.parse(loopTurn.startedAt || '') || 0;
  const endMs = Date.parse(loopTurn.finishedAt || '') || 0;

  // 1. When a prompt snapshot exists, require an exact prompt match so unrelated adjacent desktop turns are never swallowed.
  if (targetPrompt) {
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < rolloutTurns.length; i++) {
      if (consumedSet.has(i)) continue;
      if (normPromptForMatch(rolloutTurns[i].promptText) !== targetPrompt) continue;
      const rMs = Date.parse(rolloutTurns[i].startedAt || '') || 0;
      const delta = startMs && rMs ? Math.abs(rMs - startMs) : i;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) {
      consumedSet.add(bestIdx);
      return rolloutTurns[bestIdx];
    }
    return null;
  }

  // 2. Legacy runs without saved prompt snapshot only: match by timestamp window [start - 15s, end + 15s].
  if (startMs) {
    let bestIdx = -1;
    let bestDelta = Infinity;
    const upperBound = endMs ? endMs + 15_000 : startMs + 60_000;
    for (let i = 0; i < rolloutTurns.length; i++) {
      if (consumedSet.has(i)) continue;
      const rMs = Date.parse(rolloutTurns[i].startedAt || '') || 0;
      if (!rMs) continue;
      if (rMs >= startMs - 15_000 && rMs <= upperBound) {
        const delta = Math.abs(rMs - startMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      }
    }
    if (bestIdx !== -1) {
      consumedSet.add(bestIdx);
      return rolloutTurns[bestIdx];
    }
  }

  return null;
}

function classifyRolloutTurnState(rt, isLastTurnInRollout, rolloutMtimeMs) {
  if (rt.completed) return { state: 'finished', effectiveState: 'finished' };
  if (rt.aborted) return { state: 'stopped', effectiveState: 'stopped' };
  if (!isLastTurnInRollout) return { state: 'interrupted', effectiveState: 'interrupted' };
  const actMs = Date.parse(rt.lastActivityAt || rt.startedAt || '') || rolloutMtimeMs;
  const recentlyActive = Date.now() - actMs < 90_000;
  return recentlyActive
    ? { state: 'running', effectiveState: 'running' }
    : { state: 'interrupted', effectiveState: 'interrupted' };
}

function decorateHandoffFileUris(handoff, workDir) {
  if (!handoff || !Array.isArray(handoff.changed_files)) return handoff;
  return {
    ...handoff,
    changed_files: handoff.changed_files.map((f) => ({
      ...f,
      fileUri: toSafeFileUri(f?.path, workDir),
    })),
  };
}

function buildManifestAndEtag(turnManifests, extraParts = []) {
  const parts = [];
  for (const m of turnManifests) {
    parts.push(`t:${m.turnId}:${m.effectiveState}`);
    for (const [k, fp] of Object.entries(m.files)) {
      if (!fp || k === 'promptSource') continue;
      const st = statInfo(fp);
      if (st) parts.push(`${k}:${basename(fp)}:${st.mtimeMs}:${st.size}`);
    }
  }
  for (const p of extraParts) parts.push(p);
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

export async function readRunDetail(entry, clientEtag = '') {
  if (!entry) return { error: 'not-found' };

  if (entry.rolloutOnly) {
    const sessions = entry.confirmedSessions || [];
    const resolved = [];
    for (const s of sessions) {
      const rp = resolveRolloutBySessionId(s.sessionId, s.nativeSession);
      const st = statInfo(rp);
      if (st) resolved.push({ s, rp, st });
    }
    if (resolved.length === 0) return { error: 'missing-files' };

    const turns = [];
    const etagParts = [];
    for (const { s, rp, st } of resolved) {
      const rollout = await parseRolloutJsonl(rp);
      if (!rollout.ok) return { error: 'read-failed', message: rollout.error };
      etagParts.push(`${s.sessionId}:${st.mtimeMs}:${st.size}`);
      for (let i = 0; i < rollout.turns.length; i++) {
        const rt = rollout.turns[i];
        const isLast = i === rollout.turns.length - 1;
        const stInfo = classifyRolloutTurnState(rt, isLast, rollout.mtimeMs);
        etagParts.push(`${s.sessionId}:${i}:${stInfo.effectiveState}`);
        turns.push({
          turnId: `desktop-${s.sessionId}-${i + 1}`,
          turnNumber: 0,
          source: 'rollout_archive',
          mode: i === 0 ? 'exec' : 'resume',
          taskKind: entry.taskKind,
          requestedMode: null,
          state: stInfo.state,
          effectiveState: stInfo.effectiveState,
          exitCode: null,
          sessionId: s.sessionId,
          desktopUrl: s.desktopUrl,
          startedAt: rt.startedAt,
          finishedAt: rt.finishedAt,
          effective: null,
          usage: null,
          errorKind: null,
          errors: [],
          promptText: rt.promptText,
          promptSource: 'rollout',
          items: rt.items,
          reasonings: [],
          eventCount: rt.items.length,
          handoff: null,
          handoffRaw: '',
          stderr: '',
          rawFiles: ['rollout'],
        });
      }
    }

    const etag = `ro:${createHash('sha1').update(etagParts.join('|')).digest('hex').slice(0, 16)}`;
    if (clientEtag && clientEtag === etag) return { unchanged: true, etag };

    turns.sort((a, b) => (Date.parse(a.startedAt || '') || 0) - (Date.parse(b.startedAt || '') || 0));
    turns.forEach((t, idx) => { t.turnNumber = idx + 1; });

    const runningTurn = turns.find((t) => t.effectiveState === 'running');
    const latest = turns[turns.length - 1];
    return {
      unchanged: false,
      etag,
      run: {
        ...entry,
        turnsCount: turns.length,
        state: runningTurn?.state || latest?.state || entry.state,
        effectiveState: runningTurn?.effectiveState || latest?.effectiveState || entry.effectiveState,
      },
      turns,
    };
  }

  const statusFiles = listStatusFilesInDir(entry.runDir);
  if (statusFiles.length === 0) return { error: 'missing-files' };

  const statusRecords = [];
  for (const sf of statusFiles) {
    const data = readCachedJson(sf.path);
    if (!data) continue;
    statusRecords.push({ file: sf, data });
  }
  if (statusRecords.length === 0) return { error: 'missing-files' };

  statusRecords.sort((a, b) => {
    const ta = Date.parse(a.data.started_at || '') || a.file.mtimeMs;
    const tb = Date.parse(b.data.started_at || '') || b.file.mtimeMs;
    if (ta !== tb) return ta - tb;
    return a.file.name.localeCompare(b.file.name);
  });

  // Single manifest drives both ETag and actual reads (fixes ETag drift & PID liveness detection).
  const manifests = statusRecords.map(({ file, data }, idx) => {
    const { effectiveState, isAlive } = computeTurnEffectiveState(data);
    const files = resolveTurnFiles(entry.runDir, file.turnId, data, idx === 0);
    return { turnId: file.turnId, file, data, effectiveState, isAlive, files };
  });

  const rolloutsBySession = new Map();
  let hadRolloutReadFailure = false;
  const rolloutStateParts = [];

  for (const m of manifests) {
    if (!isConfirmedSessionStatus(m.data)) continue;
    const sid = m.data.session_id.toLowerCase();
    if (m.files.rollout && !rolloutsBySession.has(sid)) {
      const parsed = await parseRolloutJsonl(m.files.rollout);
      if (parsed.ok) {
        rolloutsBySession.set(sid, { path: m.files.rollout, parsed, desktopUrl: m.data.desktop_url || `codex://threads/${sid}` });
        for (let i = 0; i < parsed.turns.length; i++) {
          const stInfo = classifyRolloutTurnState(parsed.turns[i], i === parsed.turns.length - 1, parsed.mtimeMs);
          rolloutStateParts.push(`rs:${sid}:${i}:${stInfo.effectiveState}`);
        }
      } else {
        hadRolloutReadFailure = true;
      }
    }
  }

  // Never emit a cacheable ETag when a rollout transiently failed to read so the next poll self-heals.
  const etag = hadRolloutReadFailure ? '' : buildManifestAndEtag(manifests, rolloutStateParts);
  if (etag && clientEtag && clientEtag === etag) {
    return { unchanged: true, etag };
  }

  const consumedRolloutBySession = new Map();
  const loopTurns = [];

  for (let idx = 0; idx < manifests.length; idx++) {
    const { turnId, data, effectiveState, files } = manifests[idx];
    const workDir = data.work_dir || entry.workDir || '';
    const confirmed = isConfirmedSessionStatus(data);
    const sid = confirmed ? data.session_id.toLowerCase() : null;

    let promptText = '';
    let promptSource = 'none';
    if (files.prompt) {
      const txt = readFullUtf8(files.prompt);
      if (txt) {
        promptText = txt;
        promptSource = files.promptSource;
      }
    }

    const handoffRaw = files.handoff ? (readFullUtf8(files.handoff) || '') : '';
    let handoff = data.handoff || null;
    if (!handoff && handoffRaw.trim()) {
      try { handoff = JSON.parse(handoffRaw); } catch {}
    }

    const parsedEvents = files.events
      ? parseEventsIncremental(files.events, workDir, handoffRaw.trim())
      : { items: [], usage: null, eventCount: 0, hasReasoning: false, enteredTurn: false };

    const enteredCodexTurn = parsedEvents.enteredTurn || data.state === 'finished' || data.exit_code === 0;
    let rolloutTurn = null;
    if (sid && enteredCodexTurn && rolloutsBySession.has(sid)) {
      if (!consumedRolloutBySession.has(sid)) consumedRolloutBySession.set(sid, new Set());
      rolloutTurn = matchRolloutTurn(
        rolloutsBySession.get(sid).parsed.turns,
        consumedRolloutBySession.get(sid),
        { promptText, startedAt: data.started_at, finishedAt: data.finished_at },
      );
    }

    if (!promptText && rolloutTurn?.promptText) {
      promptText = rolloutTurn.promptText;
      promptSource = 'rollout';
    }

    const stderr = files.stderr ? (readFullUtf8(files.stderr) || '').trim() : '';

    const rawFiles = [];
    if (files.status) rawFiles.push('status');
    if (files.prompt) rawFiles.push('prompt');
    if (files.events && statInfo(files.events)?.size > 0) rawFiles.push('events');
    if (files.handoff && handoffRaw.trim()) rawFiles.push('handoff');
    if (files.stderr && stderr) rawFiles.push('stderr');
    if (files.rollout) rawFiles.push('rollout');

    loopTurns.push({
      turnId,
      turnNumber: 0,
      source: 'codex_loop',
      mode: data.mode || (turnId.startsWith('resume') ? 'resume' : 'exec'),
      taskKind: data.task_kind || entry.taskKind,
      requestedMode: data.requested_mode || null,
      state: data.state || 'unknown',
      effectiveState,
      exitCode: data.exit_code ?? null,
      sessionId: sid,
      attemptedSessionId: !confirmed && data.session_id ? data.session_id : null,
      desktopUrl: sid ? (data.desktop_url || `codex://threads/${sid}`) : null,
      startedAt: data.started_at || null,
      finishedAt: data.finished_at || null,
      effective: data.effective || null,
      usage: data.usage || parsedEvents.usage || null,
      errorKind: data.error_kind || null,
      errors: Array.isArray(data.errors) ? data.errors : [],
      promptText,
      promptSource,
      items: parsedEvents.items,
      reasonings: !parsedEvents.hasReasoning && rolloutTurn?.reasonings?.length ? rolloutTurn.reasonings : [],
      eventCount: parsedEvents.eventCount,
      handoff: decorateHandoffFileUris(handoff, workDir),
      handoffRaw,
      stderr,
      rawFiles,
    });
  }

  // Merge unconsumed Codex Desktop turns in true chronological order (preserving interleaved desktop replies).
  const desktopTurns = [];
  for (const [sid, wrap] of rolloutsBySession.entries()) {
    const consumed = consumedRolloutBySession.get(sid) || new Set();
    for (let i = 0; i < wrap.parsed.turns.length; i++) {
      if (consumed.has(i)) continue;
      const rt = wrap.parsed.turns[i];
      const stInfo = classifyRolloutTurnState(rt, i === wrap.parsed.turns.length - 1, wrap.parsed.mtimeMs);
      desktopTurns.push({
        turnId: `desktop-${sid}-${i + 1}`,
        turnNumber: 0,
        source: 'codex_desktop',
        mode: 'desktop',
        taskKind: 'desktop',
        requestedMode: null,
        state: stInfo.state,
        effectiveState: stInfo.effectiveState,
        exitCode: null,
        sessionId: sid,
        desktopUrl: wrap.desktopUrl,
        startedAt: rt.startedAt,
        finishedAt: rt.finishedAt,
        effective: null,
        usage: null,
        errorKind: null,
        errors: [],
        promptText: rt.promptText,
        promptSource: 'rollout',
        items: rt.items,
        reasonings: [],
        eventCount: rt.items.length,
        handoff: null,
        handoffRaw: '',
        stderr: '',
        rawFiles: ['rollout'],
      });
    }
  }

  const turns = [...loopTurns, ...desktopTurns].sort((a, b) => {
    const ta = Date.parse(a.startedAt || '') || 0;
    const tb = Date.parse(b.startedAt || '') || 0;
    if (ta !== tb) return ta - tb;
    if (a.source !== b.source) return a.source === 'codex_loop' ? -1 : 1;
    return a.turnId.localeCompare(b.turnId);
  });
  turns.forEach((t, idx) => { t.turnNumber = idx + 1; });

  // Derive top-level run state: active codex_loop turn first, then active desktop turn, else latest codex_loop turn.
  const runningLoopTurn = loopTurns.find((t) => t.effectiveState === 'running');
  const runningDesktopTurn = desktopTurns.find((t) => t.effectiveState === 'running');
  const latestLoopTurn = loopTurns[loopTurns.length - 1];
  const latestConfirmedTurn = [...loopTurns].reverse().find((t) => t.sessionId);

  const runMeta = {
    ...entry,
    turnsCount: turns.length,
    state: runningLoopTurn?.state || runningDesktopTurn?.state || latestLoopTurn?.state || entry.state,
    effectiveState: runningLoopTurn?.effectiveState || runningDesktopTurn?.effectiveState || latestLoopTurn?.effectiveState || entry.effectiveState,
    sessionId: latestConfirmedTurn?.sessionId || entry.sessionId,
    desktopUrl: latestConfirmedTurn?.desktopUrl || entry.desktopUrl,
  };

  return { unchanged: false, etag, run: runMeta, turns };
}

async function readTextRange(path, offset, limit) {
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
  const safeLimit = Math.min(MAX_RAW_LIMIT_BYTES, Math.max(4096, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_RAW_LIMIT_BYTES));

  if (isZstdFile(path)) {
    // Stream-decompress and slice UTF-8 bytes safely across [safeOffset, safeOffset + safeLimit).
    const fileStream = createReadStream(path);
    const decomp = zlib.createZstdDecompress();
    fileStream.on('error', (err) => decomp.destroy(err));
    fileStream.pipe(decomp);
    const chunks = [];
    let totalBytes = 0;
    let collected = 0;
    try {
      for await (const buf of decomp) {
        const chunkStart = totalBytes;
        const chunkEnd = totalBytes + buf.length;
        totalBytes = chunkEnd;
        if (chunkEnd <= safeOffset || collected >= safeLimit) continue;
        const sliceStart = Math.max(0, safeOffset - chunkStart);
        const sliceEnd = Math.min(buf.length, sliceStart + (safeLimit - collected));
        if (sliceEnd > sliceStart) {
          chunks.push(buf.subarray(sliceStart, sliceEnd));
          collected += sliceEnd - sliceStart;
        }
      }
    } finally {
      fileStream.destroy();
    }
    const rawBuf = Buffer.concat(chunks);
    const trimmedBuf = trimIncompleteUtf8Tail(rawBuf, safeOffset + collected < totalBytes);
    const nextOffset = safeOffset + trimmedBuf.length;
    return {
      content: trimmedBuf.toString('utf8'),
      offset: safeOffset,
      nextOffset,
      totalBytes,
      hasMore: nextOffset < totalBytes,
      truncated: safeOffset > 0 || nextOffset < totalBytes,
      decompressed: true,
    };
  }

  const st = statInfo(path);
  if (!st?.isFile) return null;
  if (st.size === 0 || safeOffset >= st.size) {
    return { content: '', offset: safeOffset, nextOffset: safeOffset, totalBytes: st.size, hasMore: false, truncated: safeOffset > 0, decompressed: false };
  }

  const toRead = Math.min(safeLimit, st.size - safeOffset);
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, safeOffset);
    const slice = trimIncompleteUtf8Tail(buf.subarray(0, bytesRead), safeOffset + bytesRead < st.size);
    const nextOffset = safeOffset + slice.length;
    return {
      content: slice.toString('utf8'),
      offset: safeOffset,
      nextOffset,
      totalBytes: st.size,
      hasMore: nextOffset < st.size,
      truncated: safeOffset > 0 || nextOffset < st.size,
      decompressed: false,
    };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function trimIncompleteUtf8Tail(buf, hasMoreBytes) {
  if (!hasMoreBytes || buf.length === 0) return buf;
  // Walk back at most 3 bytes if ending inside a multi-byte UTF-8 sequence.
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i < 0) return buf;
  const lead = buf[i];
  const expected =
    (lead & 0x80) === 0 ? 1 :
    (lead & 0xe0) === 0xc0 ? 2 :
    (lead & 0xf0) === 0xe0 ? 3 :
    (lead & 0xf8) === 0xf0 ? 4 : 1;
  const actual = buf.length - i;
  return actual < expected ? buf.subarray(0, i) : buf;
}

export async function readRawFile(entry, turnId, kind, offset = 0, limit = DEFAULT_RAW_LIMIT_BYTES) {
  if (!entry) return { error: 'run-not-found' };
  const allowedKinds = new Set(['status', 'events', 'handoff', 'stderr', 'prompt', 'rollout']);
  if (!allowedKinds.has(kind)) return { error: 'invalid-kind' };

  if (kind === 'rollout') {
    let target = null;
    const desktopMatch = DESKTOP_TURN_RE.exec(String(turnId || ''));
    if (desktopMatch) {
      const sid = desktopMatch[1].toLowerCase();
      const confirmed = (entry.confirmedSessions || []).find((s) => s.sessionId === sid);
      if (!confirmed) return { error: 'file-not-found' };
      target = resolveRolloutBySessionId(sid, confirmed.nativeSession);
    } else if (!entry.rolloutOnly && SAFE_TURN_ID_RE.test(String(turnId || ''))) {
      const statusFiles = listStatusFilesInDir(entry.runDir);
      const matched = statusFiles.find((sf) => sf.turnId === turnId);
      if (!matched) return { error: 'file-not-found' };
      const statusData = readCachedJson(matched.path);
      if (!isConfirmedSessionStatus(statusData)) return { error: 'file-not-found' };
      target = resolveRolloutBySessionId(statusData.session_id, statusData.native_session);
    }
    if (!target) return { error: 'file-not-found' };
    const range = await readTextRange(target, offset, limit);
    if (!range) return { error: 'file-not-found' };
    return { filename: basename(target), path: target, kind, ...range };
  }

  if (entry.rolloutOnly || !SAFE_TURN_ID_RE.test(String(turnId || ''))) {
    return { error: 'file-not-found' };
  }

  const statusFiles = listStatusFilesInDir(entry.runDir);
  const ordered = statusFiles
    .map((sf) => ({ sf, data: readCachedJson(sf.path) }))
    .filter((x) => x.data)
    .sort((a, b) => {
      const ta = Date.parse(a.data.started_at || '') || a.sf.mtimeMs;
      const tb = Date.parse(b.data.started_at || '') || b.sf.mtimeMs;
      return ta !== tb ? ta - tb : a.sf.name.localeCompare(b.sf.name);
    });

  const turnIdx = ordered.findIndex((x) => x.sf.turnId === turnId);
  if (turnIdx === -1) return { error: 'file-not-found' };

  const files = resolveTurnFiles(entry.runDir, turnId, ordered[turnIdx].data, turnIdx === 0);
  const target = files[kind];
  if (!target) return { error: 'file-not-found' };

  const range = await readTextRange(target, offset, limit);
  if (!range) return { error: 'file-not-found' };
  return { filename: basename(target), path: target, kind, ...range };
}
