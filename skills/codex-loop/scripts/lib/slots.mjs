import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARD_MAX_CONCURRENCY = 2;
export const DEFAULT_MAX_CONCURRENCY = HARD_MAX_CONCURRENCY;
const LOCK_WAIT_MS = 15_000;
const PID_START_DRIFT_MS = 15_000;
const PID_REUSE_CHECK_AGE_MS = 60_000;

export function getSlotsFilePath() {
  if (process.env.CODEX_LOOP_SLOTS_FILE) {
    return resolve(process.env.CODEX_LOOP_SLOTS_FILE);
  }
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, 'codex-loop', 'slots.json');
}

function getWorktreeLeasesFilePath(slotsFile) {
  return `${slotsFile}.wt-leases.json`;
}

export function normFsPath(p) {
  if (!p || typeof p !== 'string') return '';
  const abs = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export function normRealFsPath(p) {
  if (!p || typeof p !== 'string') return '';
  let cur = resolve(p);
  const tail = [];
  while (true) {
    try {
      const real = realpathSync(cur);
      return normFsPath(tail.length > 0 ? join(real, ...tail.reverse()) : real);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return normFsPath(p);
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return normRealFsPath(process.argv[1]) === normRealFsPath(fileURLToPath(metaUrl));
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

export function getWindowsProcessStartTimes(pids) {
  const unique = [...new Set(pids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const map = new Map();
  if (unique.length === 0 || process.platform !== 'win32') return map;
  try {
    const idList = unique.join(',');
    const ps = `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | ForEach-Object { try { "$($_.Id)|$(([datetimeoffset]$_.StartTime).ToUnixTimeMilliseconds())" } catch {} }`;
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+)\|(\d+)$/.exec(line.trim());
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
  } catch {
    // Best-effort start-time enhancement over kill(pid, 0); empty map keeps kill(pid, 0) result.
  }
  return map;
}

export function getProcessStartMs(pid) {
  return getWindowsProcessStartTimes([pid]).get(Number(pid)) ?? null;
}

function sleepAsync(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    for (let i = 0; i < 6; i++) {
      try {
        renameSync(tmp, filePath);
        return;
      } catch (err) {
        if (i === 5) throw err;
        sleepSync(25);
      }
    }
  } finally {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch {}
    }
  }
}

function tryListenPipe(pipePath) {
  return new Promise((resolveListen, rejectListen) => {
    const srv = net.createServer((sock) => sock.destroy());
    const onErr = (err) => {
      try { srv.close(); } catch {}
      rejectListen(err);
    };
    srv.once('error', onErr);
    srv.listen(pipePath, () => {
      srv.off('error', onErr);
      srv.on('error', () => {});
      resolveListen(srv);
    });
  });
}

// Kernel-enforced cross-process mutex via Windows Named Pipe (automatically released by OS on crash/kill).
export async function withNamedPipeLock(pipeName, fn, timeoutMs = LOCK_WAIT_MS) {
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : join(tmpdir(), `${pipeName}.sock`);
  const deadline = Date.now() + timeoutMs;
  let srv = null;

  while (true) {
    try {
      srv = await tryListenPipe(pipePath);
      break;
    } catch (err) {
      const busy = err && (err.code === 'EADDRINUSE' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!busy) throw err;
      if (Date.now() >= deadline) {
        const timeoutErr = new Error(`Timed out waiting for lock (${pipeName}) after ${timeoutMs}ms.`);
        timeoutErr.code = 'ELOCKTIMEOUT';
        throw timeoutErr;
      }
      await sleepAsync(20 + Math.floor(Math.random() * 25));
    }
  }

  try {
    return await fn();
  } finally {
    await new Promise((res) => {
      try { srv.close(() => res()); } catch { res(); }
    });
  }
}

function getSlotsLockPipeName(slotsFile) {
  const h = createHash('sha1').update(normRealFsPath(slotsFile)).digest('hex').slice(0, 16);
  return `codex-loop-slots-${h}`;
}

async function withSlotsLock(slotsFile, fn) {
  mkdirSync(dirname(slotsFile), { recursive: true });
  return withNamedPipeLock(getSlotsLockPipeName(slotsFile), fn, LOCK_WAIT_MS);
}

// Fail closed on read/parse corruption so active slots or leases are never silently wiped.
function readJsonArrayStrict(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    const e = new Error(`Failed to read ${label} (${filePath}): ${err.message}`);
    e.error_kind = 'slots_error';
    throw e;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    const e = new Error(`${label} is blank/corrupted (${filePath}); refusing to overwrite.`);
    e.error_kind = 'slots_error';
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const e = new Error(`${label} contains invalid JSON (${filePath}): ${err.message}`);
    e.error_kind = 'slots_error';
    throw e;
  }
  if (!Array.isArray(parsed)) {
    const e = new Error(`${label} must be a JSON array (${filePath}); refusing to overwrite.`);
    e.error_kind = 'slots_error';
    throw e;
  }
  return parsed;
}

function checkPidStillOwned(pid, recordedStartMs, startTimesMap) {
  if (!isPidAlive(pid)) return false;
  if (!Number.isFinite(recordedStartMs) || !startTimesMap.has(Number(pid))) return true;
  const actualStart = startTimesMap.get(Number(pid));
  return Math.abs(actualStart - recordedStartMs) <= PID_START_DRIFT_MS;
}

function isStatusFileTerminalForAttempt(statusFile, attemptId) {
  if (!statusFile || !attemptId) return false;
  try {
    const data = JSON.parse(readFileSync(statusFile, 'utf8'));
    if (!data || typeof data !== 'object') return false;
    if (data.attempt_id && data.attempt_id !== attemptId) return false;
    return data.state === 'finished' || data.state === 'failed' || data.state === 'stopped';
  } catch {
    return false;
  }
}

function pruneDeadSlots(slots, { verifyOldPids = true } = {}) {
  if (slots.length === 0) return { active: [], pruned: [] };

  const now = Date.now();
  const candidatePids = [];
  if (verifyOldPids) {
    for (const s of slots) {
      if (s.runner_pid && isPidAlive(s.runner_pid) && Number.isFinite(s.runner_started_ms) && (now - s.runner_started_ms) > PID_REUSE_CHECK_AGE_MS) {
        candidatePids.push(s.runner_pid);
      }
      if (s.cli_pid && isPidAlive(s.cli_pid) && Number.isFinite(s.cli_started_ms) && (now - s.cli_started_ms) > PID_REUSE_CHECK_AGE_MS) {
        candidatePids.push(s.cli_pid);
      }
    }
  }
  const startTimes = candidatePids.length > 0 ? getWindowsProcessStartTimes(candidatePids) : new Map();

  const active = [];
  const pruned = [];
  for (const s of slots) {
    const runnerAlive = s.runner_pid ? checkPidStillOwned(s.runner_pid, s.runner_started_ms, startTimes) : false;
    const cliAlive = s.cli_pid ? checkPidStillOwned(s.cli_pid, s.cli_started_ms, startTimes) : false;
    // Recover slots left by a long-lived host shell if the attempt already wrote a terminal status and its CLI exited.
    if (!cliAlive && isStatusFileTerminalForAttempt(s.status_file, s.attempt_id)) {
      pruned.push(s);
    } else if (runnerAlive || cliAlive) {
      active.push({
        ...s,
        orphaned_cli: !runnerAlive && cliAlive,
      });
    } else {
      pruned.push(s);
    }
  }
  return { active, pruned };
}

function pruneDeadLeases(leases, { verifyOldPids = true } = {}) {
  if (leases.length === 0) return { active: [], pruned: [] };

  const now = Date.now();
  const candidatePids = [];
  if (verifyOldPids) {
    for (const l of leases) {
      if (l.pid && isPidAlive(l.pid) && Number.isFinite(l.pid_started_ms) && (now - l.pid_started_ms) > PID_REUSE_CHECK_AGE_MS) {
        candidatePids.push(l.pid);
      }
    }
  }
  const startTimes = candidatePids.length > 0 ? getWindowsProcessStartTimes(candidatePids) : new Map();

  const active = [];
  const pruned = [];
  for (const l of leases) {
    const alive = l.pid ? checkPidStillOwned(l.pid, l.pid_started_ms, startTimes) : false;
    if (alive) active.push(l);
    else pruned.push(l);
  }
  return { active, pruned };
}

function summarizeSlot(s) {
  return {
    attempt_id: s.attempt_id,
    batch_id: s.batch_id ?? null,
    subtask_id: s.subtask_id ?? null,
    engine: s.engine ?? 'app-server',
    task_kind: s.task_kind ?? 'implement',
    mode: s.mode ?? null,
    title: s.title ?? '',
    run_dir: s.run_dir ?? null,
    work_dir: s.work_dir ?? null,
    worktree_path: s.worktree_path ?? null,
    session_id: s.session_id ?? null,
    active_turn_id: s.active_turn_id ?? null,
    runner_pid: s.runner_pid ?? null,
    cli_pid: s.cli_pid ?? null,
    control_pipe: s.control_pipe ?? null,
    control_file: s.control_file ?? null,
    status_file: s.status_file ?? null,
    orphaned_cli: Boolean(s.orphaned_cli),
    acquired_at: s.acquired_at ?? null,
  };
}

export async function listSlots(slotsFile = getSlotsFilePath()) {
  return withSlotsLock(slotsFile, () => {
    const raw = readJsonArrayStrict(slotsFile, 'slots table');
    const { active, pruned } = pruneDeadSlots(raw);
    if (pruned.length > 0) {
      writeFileAtomic(slotsFile, JSON.stringify(active, null, 2));
    }
    return {
      ok: true,
      slots_file: slotsFile,
      active_count: active.length,
      pruned_count: pruned.length,
      slots: active.map(summarizeSlot),
    };
  });
}

export async function acquireSlot(input, slotsFile = getSlotsFilePath()) {
  let maxConcurrency = HARD_MAX_CONCURRENCY;
  if (input.max_concurrency !== undefined && input.max_concurrency !== null) {
    const parsed = Number(input.max_concurrency);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > HARD_MAX_CONCURRENCY) {
      return {
        ok: false,
        error_kind: 'invalid_max_concurrency',
        max_concurrency: HARD_MAX_CONCURRENCY,
        message: `max_concurrency must be an integer between 1 and ${HARD_MAX_CONCURRENCY} (received ${JSON.stringify(input.max_concurrency)}).`,
      };
    }
    maxConcurrency = parsed;
  }

  return withSlotsLock(slotsFile, () => {
    const raw = readJsonArrayStrict(slotsFile, 'slots table');
    const { active, pruned } = pruneDeadSlots(raw);
    if (pruned.length > 0) {
      writeFileAtomic(slotsFile, JSON.stringify(active, null, 2));
    }

    const leasesFile = getWorktreeLeasesFilePath(slotsFile);
    const rawLeases = readJsonArrayStrict(leasesFile, 'worktree leases table');
    const { active: activeLeases, pruned: prunedLeases } = pruneDeadLeases(rawLeases);
    if (prunedLeases.length > 0) {
      writeFileAtomic(leasesFile, JSON.stringify(activeLeases, null, 2));
    }

    const normRunDir = normRealFsPath(input.run_dir);
    const normSid = input.session_id ? String(input.session_id).trim().toLowerCase() : '';
    const normWt = input.worktree_path ? normRealFsPath(input.worktree_path) : '';

    if (normRunDir) {
      const dupDir = active.find((s) => normRealFsPath(s.run_dir) === normRunDir && s.attempt_id !== input.attempt_id);
      if (dupDir) {
        return {
          ok: false,
          error_kind: 'duplicate_run_dir',
          message: `RunDir already has an active dispatch (${dupDir.attempt_id}, runner_pid=${dupDir.runner_pid}).`,
          active_slots: active.map(summarizeSlot),
        };
      }
    }

    if (normSid) {
      const dupSid = active.find((s) => s.session_id && String(s.session_id).toLowerCase() === normSid && s.attempt_id !== input.attempt_id);
      if (dupSid) {
        return {
          ok: false,
          error_kind: 'active_writer',
          message: `Session ${normSid} already has an active codex-loop worker (${dupSid.attempt_id}).`,
          active_slots: active.map(summarizeSlot),
        };
      }
    }

    if (normWt) {
      const wtLease = activeLeases.find((l) => normRealFsPath(l.worktree_path) === normWt);
      if (wtLease) {
        return {
          ok: false,
          error_kind: 'worktree_busy',
          message: `Worktree is currently locked by "${wtLease.op}" operation (pid=${wtLease.pid}).`,
          active_slots: active.map(summarizeSlot),
        };
      }
      const dupWt = active.find((s) => s.worktree_path && normRealFsPath(s.worktree_path) === normWt && s.attempt_id !== input.attempt_id);
      if (dupWt) {
        return {
          ok: false,
          error_kind: 'worktree_in_use',
          message: `Worktree already has an active codex-loop worker (${dupWt.attempt_id}, runner_pid=${dupWt.runner_pid}).`,
          active_slots: active.map(summarizeSlot),
        };
      }
    }

    const existingIdx = active.findIndex((s) => s.attempt_id === input.attempt_id);
    if (existingIdx !== -1) {
      return {
        ok: false,
        error_kind: 'duplicate_attempt_id',
        message: `Attempt ID "${input.attempt_id}" is already held by an active worker (runner_pid=${active[existingIdx].runner_pid}).`,
        active_slots: active.map(summarizeSlot),
      };
    }

    if (active.length >= maxConcurrency) {
      return {
        ok: false,
        error_kind: 'slots_full',
        max_concurrency: maxConcurrency,
        active_count: active.length,
        message: `Concurrency limit reached (${active.length}/${maxConcurrency} active codex-loop workers). Wait for one to finish before dispatching another.`,
        active_slots: active.map(summarizeSlot),
      };
    }

    const runnerPid = Number(input.runner_pid) || process.pid;
    const cliPid = input.cli_pid ? Number(input.cli_pid) : null;
    const nowMs = Date.now();
    // Use caller's true OS start time, or exact self start time when runnerPid === process.pid; keep unknown for external PIDs.
    const runnerStartedMs = Number.isFinite(Number(input.runner_started_ms)) && input.runner_started_ms !== null
      ? Number(input.runner_started_ms)
      : (runnerPid === process.pid ? Math.round(nowMs - process.uptime() * 1000) : null);
    const cliStartedMs = Number.isFinite(Number(input.cli_started_ms)) && input.cli_started_ms !== null
      ? Number(input.cli_started_ms)
      : null;

    const record = {
      attempt_id: input.attempt_id,
      batch_id: input.batch_id ?? null,
      subtask_id: input.subtask_id ?? null,
      engine: input.engine ?? 'app-server',
      task_kind: input.task_kind ?? 'implement',
      mode: input.mode ?? null,
      title: input.title ?? '',
      run_dir: input.run_dir ?? null,
      work_dir: input.work_dir ?? null,
      worktree_path: input.worktree_path ?? null,
      session_id: normSid || null,
      active_turn_id: input.active_turn_id ?? null,
      runner_pid: runnerPid,
      runner_started_ms: runnerStartedMs,
      cli_pid: cliPid,
      cli_started_ms: cliStartedMs,
      control_pipe: input.control_pipe ?? null,
      control_file: input.control_file ?? null,
      status_file: input.status_file ?? null,
      acquired_at: new Date(nowMs).toISOString(),
    };

    active.push(record);
    writeFileAtomic(slotsFile, JSON.stringify(active, null, 2));
    return {
      ok: true,
      max_concurrency: maxConcurrency,
      active_count: active.length,
      slot: summarizeSlot(record),
      active_slots: active.map(summarizeSlot),
    };
  });
}

export async function updateSlot(attemptId, patch, slotsFile = getSlotsFilePath()) {
  return withSlotsLock(slotsFile, () => {
    const raw = readJsonArrayStrict(slotsFile, 'slots table');
    const { active } = pruneDeadSlots(raw, { verifyOldPids: false });
    const idx = active.findIndex((s) => s.attempt_id === attemptId);
    if (idx === -1) {
      return { ok: false, error_kind: 'slot_not_found', message: `Slot ${attemptId} not found.` };
    }
    const next = { ...active[idx], ...patch };
    if (patch.session_id) {
      next.session_id = String(patch.session_id).trim().toLowerCase();
    }
    if (patch.cli_pid) {
      next.cli_pid = Number(patch.cli_pid);
      if (patch.cli_started_ms !== undefined) {
        next.cli_started_ms = Number.isFinite(Number(patch.cli_started_ms)) && patch.cli_started_ms !== null
          ? Number(patch.cli_started_ms)
          : null;
      }
    }
    active[idx] = next;
    writeFileAtomic(slotsFile, JSON.stringify(active, null, 2));
    return { ok: true, slot: summarizeSlot(next) };
  });
}

export async function releaseSlot(attemptId, slotsFile = getSlotsFilePath()) {
  return withSlotsLock(slotsFile, () => {
    const raw = readJsonArrayStrict(slotsFile, 'slots table');
    const { active } = pruneDeadSlots(raw, { verifyOldPids: false });
    const next = active.filter((s) => s.attempt_id !== attemptId);
    const released = next.length !== active.length;
    if (released || next.length !== raw.length) {
      writeFileAtomic(slotsFile, JSON.stringify(next, null, 2));
    }
    return { ok: true, released, active_count: next.length };
  });
}

export async function findSlot({ attemptId, runDir, sessionId, worktreePath } = {}, slotsFile = getSlotsFilePath()) {
  const { slots } = await listSlots(slotsFile);
  if (attemptId) {
    return slots.find((s) => s.attempt_id === attemptId) || null;
  }
  if (runDir) {
    const target = normRealFsPath(runDir);
    return slots.find((s) => normRealFsPath(s.run_dir) === target) || null;
  }
  if (sessionId) {
    const target = String(sessionId).trim().toLowerCase();
    return slots.find((s) => s.session_id && s.session_id.toLowerCase() === target) || null;
  }
  if (worktreePath) {
    const target = normRealFsPath(worktreePath);
    return slots.find((s) => s.worktree_path && normRealFsPath(s.worktree_path) === target) || null;
  }
  return null;
}

export async function acquireWorktreeLease({ worktreePath, op = 'cleanup', pid = process.pid, pidStartedMs = null }, slotsFile = getSlotsFilePath()) {
  const normWt = normRealFsPath(worktreePath);
  if (!normWt) {
    return { ok: false, error_kind: 'invalid_arguments', message: 'worktreePath is required.' };
  }
  return withSlotsLock(slotsFile, () => {
    const rawSlots = readJsonArrayStrict(slotsFile, 'slots table');
    const { active: activeSlots, pruned: prunedSlots } = pruneDeadSlots(rawSlots);
    if (prunedSlots.length > 0) {
      writeFileAtomic(slotsFile, JSON.stringify(activeSlots, null, 2));
    }

    const ownerSlot = activeSlots.find((s) => s.worktree_path && normRealFsPath(s.worktree_path) === normWt);
    if (ownerSlot) {
      return {
        ok: false,
        error_kind: 'worktree_in_use',
        slot: summarizeSlot(ownerSlot),
        message: `Worktree is still in use by active codex-loop worker ${ownerSlot.attempt_id} (runner_pid=${ownerSlot.runner_pid}).`,
      };
    }

    const leasesFile = getWorktreeLeasesFilePath(slotsFile);
    const rawLeases = readJsonArrayStrict(leasesFile, 'worktree leases table');
    const { active: activeLeases, pruned: prunedLeases } = pruneDeadLeases(rawLeases);
    if (prunedLeases.length > 0) {
      writeFileAtomic(leasesFile, JSON.stringify(activeLeases, null, 2));
    }

    const existingLease = activeLeases.find((l) => normRealFsPath(l.worktree_path) === normWt);
    if (existingLease) {
      return {
        ok: false,
        error_kind: 'worktree_busy',
        lease: existingLease,
        message: `Worktree is currently locked by "${existingLease.op}" (pid=${existingLease.pid}).`,
      };
    }

    const ownerPid = Number(pid) || process.pid;
    const resolvedStartMs = Number.isFinite(Number(pidStartedMs)) && pidStartedMs !== null
      ? Number(pidStartedMs)
      : (ownerPid === process.pid ? Math.round(Date.now() - process.uptime() * 1000) : null);
    const lease = {
      lease_id: `wtl-${randomUUID()}`,
      worktree_path: resolve(worktreePath),
      op,
      pid: ownerPid,
      pid_started_ms: resolvedStartMs,
      acquired_at: new Date().toISOString(),
    };
    activeLeases.push(lease);
    writeFileAtomic(leasesFile, JSON.stringify(activeLeases, null, 2));
    return { ok: true, lease };
  });
}

export async function releaseWorktreeLease(leaseId, slotsFile = getSlotsFilePath()) {
  if (!leaseId) return { ok: true, released: false };
  return withSlotsLock(slotsFile, () => {
    const leasesFile = getWorktreeLeasesFilePath(slotsFile);
    const rawLeases = readJsonArrayStrict(leasesFile, 'worktree leases table');
    const { active } = pruneDeadLeases(rawLeases, { verifyOldPids: false });
    const next = active.filter((l) => l.lease_id !== leaseId);
    const released = next.length !== active.length;
    if (released || next.length !== rawLeases.length) {
      writeFileAtomic(leasesFile, JSON.stringify(next, null, 2));
    }
    return { ok: true, released };
  });
}

async function runCli() {
  const cmd = String(process.argv[2] || '').toLowerCase();
  const stdinChunks = [];
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) stdinChunks.push(chunk);
  }
  const rawInput = Buffer.concat(stdinChunks).toString('utf8').trim();
  const payload = rawInput ? JSON.parse(rawInput) : {};

  let result;
  if (cmd === 'list') {
    result = await listSlots();
  } else if (cmd === 'acquire') {
    result = await acquireSlot(payload);
  } else if (cmd === 'update') {
    result = await updateSlot(payload.attempt_id, payload.patch || {});
  } else if (cmd === 'release') {
    result = await releaseSlot(payload.attempt_id);
  } else if (cmd === 'find') {
    const slot = await findSlot({
      attemptId: payload.attempt_id,
      runDir: payload.run_dir,
      sessionId: payload.session_id,
      worktreePath: payload.worktree_path,
    });
    result = { ok: Boolean(slot), slot };
  } else {
    throw new Error(`Unknown slots command: ${cmd}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  runCli().catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error_kind: err?.error_kind || 'slots_error', message: err.message })}\n`);
    process.exit(1);
  });
}
