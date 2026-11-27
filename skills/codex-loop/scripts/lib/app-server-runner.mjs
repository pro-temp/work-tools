import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { validateHandoff } from './schema-validate.mjs';
import {
  acquireSlot,
  isMainModule,
  releaseSlot,
  updateSlot,
  withNamedPipeLock,
  writeFileAtomic,
} from './slots.mjs';

const SECTION_NAME = 'Codex 派单';
const SECTION_LOCK_PIPE = 'codex-loop-dispatch-section';
const DELTA_FLUSH_MS = 250;

function appendJsonLine(filePath, obj) {
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function getPromptTitle(text) {
  if (!text) return null;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const clean = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:任务书|任务)\s*[:：]\s*/, '')
      .replace(/`/g, '')
      .trim();
    if (!clean) continue;
    const chars = [...clean];
    return chars.length <= 80 ? clean : `${chars.slice(0, 79).join('').trimEnd()}…`;
  }
  return null;
}

function normalizeSandboxName(sb) {
  if (!sb) return null;
  const raw = typeof sb === 'string' ? sb : (sb.type || null);
  if (!raw) return null;
  const map = {
    dangerFullAccess: 'danger-full-access',
    workspaceWrite: 'workspace-write',
    readOnly: 'read-only',
  };
  return map[raw] || raw;
}

function normalizeApprovalName(ap) {
  if (!ap) return null;
  if (typeof ap === 'string') return ap;
  if (typeof ap === 'object' && ap.granular) return 'granular';
  return String(ap);
}

export function buildModePolicies(mode, addDirs = []) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'readonly') {
    return {
      threadSandbox: 'read-only',
      turnSandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never',
      approvalsReviewer: null,
    };
  }
  if (m === 'workspace') {
    return {
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: addDirs,
        networkAccess: false,
      },
      approvalPolicy: 'never',
      approvalsReviewer: null,
    };
  }
  if (m === 'auto') {
    return {
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: addDirs,
        networkAccess: false,
      },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    };
  }
  if (m === 'yolo') {
    return {
      threadSandbox: 'danger-full-access',
      turnSandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
      approvalsReviewer: null,
    };
  }
  const err = new Error(`Unsupported execution mode "${mode}"; expected readonly, workspace, auto, or yolo.`);
  err.error_kind = 'invalid_arguments';
  throw err;
}

function findRolloutPathById(codexHome, sessionId) {
  if (!sessionId) return null;
  const sidLower = String(sessionId).toLowerCase();
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(codexHome, sub);
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          const lower = e.name.toLowerCase();
          if (lower.startsWith('rollout-') && (lower.endsWith(`-${sidLower}.jsonl`) || lower.endsWith(`-${sidLower}.jsonl.zst`))) {
            try {
              if (statSync(full).size > 0) return full;
            } catch {}
          }
        }
      }
    }
  }
  return null;
}

function extractUserMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

function projectThreadItem(item, steerClientIds, turnId = null) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id || null;
  const status = item.status || 'completed';
  const base = turnId ? { turn_id: turnId } : {};

  if (item.type === 'commandExecution') {
    return {
      ...base,
      id,
      type: 'command_execution',
      status: status === 'inProgress' ? 'in_progress' : status,
      command: item.command || '',
      aggregated_output: item.aggregatedOutput || '',
      exit_code: item.exitCode ?? null,
    };
  }
  if (item.type === 'mcpToolCall') {
    return {
      ...base,
      id,
      type: 'mcp_tool_call',
      status: status === 'inProgress' ? 'in_progress' : status,
      server: item.server || '',
      tool: item.tool || '',
      arguments: item.arguments ?? {},
      result: item.result ?? null,
      error: item.error ?? null,
    };
  }
  if (item.type === 'agentMessage') {
    return {
      ...base,
      id,
      type: 'agent_message',
      status: status === 'inProgress' ? 'in_progress' : 'completed',
      text: item.text || '',
      phase: item.phase || null,
    };
  }
  if (item.type === 'reasoning') {
    const summaryText = Array.isArray(item.summary) ? item.summary.filter(Boolean).join('\n\n') : '';
    const contentText = Array.isArray(item.content) ? item.content.filter(Boolean).join('\n\n') : '';
    return {
      ...base,
      id,
      type: 'reasoning',
      status: 'completed',
      text: summaryText || contentText,
    };
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((c) => ({
          path: c?.path || '',
          kind: typeof c?.kind === 'object' ? (c.kind?.type || 'update') : (c?.kind || 'update'),
        }))
      : [];
    return {
      ...base,
      id,
      type: 'file_change',
      status: status === 'inProgress' ? 'in_progress' : status,
      changes,
    };
  }
  if (item.type === 'webSearch') {
    return {
      ...base,
      id,
      type: 'web_search',
      status: 'completed',
      query: item.query || '',
    };
  }
  if (item.type === 'userMessage') {
    const clientId = item.clientId || null;
    if (!clientId || !steerClientIds.has(clientId)) return null;
    return {
      ...base,
      id,
      type: 'user_message',
      client_id: clientId,
      is_steer: true,
      is_followup: false,
      status: 'completed',
      text: extractUserMessageText(item.content),
    };
  }
  if (item.type === 'plan') {
    return {
      ...base,
      id,
      type: 'plan',
      status: 'completed',
      text: item.text || '',
    };
  }
  return null;
}

function mapTokenUsage(tokenUsage) {
  const src = tokenUsage?.last || tokenUsage?.total || tokenUsage;
  if (!src || typeof src !== 'object') return null;
  return {
    input_tokens: src.inputTokens ?? src.input_tokens ?? null,
    cached_input_tokens: src.cachedInputTokens ?? src.cached_input_tokens ?? null,
    cache_write_input_tokens: src.cacheWriteInputTokens ?? src.cache_write_input_tokens ?? 0,
    output_tokens: src.outputTokens ?? src.output_tokens ?? null,
    reasoning_output_tokens: src.reasoningOutputTokens ?? src.reasoning_output_tokens ?? null,
  };
}

export function pickFinalAssistantCandidate(turnItems) {
  const agentMsgs = (turnItems || []).filter((it) => it?.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim());
  if (agentMsgs.length === 0) return null;
  for (let i = agentMsgs.length - 1; i >= 0; i--) {
    if (agentMsgs[i].phase === 'final_answer') {
      return { text: agentMsgs[i].text, phase: 'final_answer', confident: true };
    }
  }
  for (let i = agentMsgs.length - 1; i >= 0; i--) {
    if (agentMsgs[i].phase !== 'commentary') {
      return { text: agentMsgs[i].text, phase: agentMsgs[i].phase || null, confident: true };
    }
  }
  const last = agentMsgs[agentMsgs.length - 1];
  return { text: last.text, phase: last.phase || 'commentary', confident: false };
}

function buildServerRequestReply(method) {
  if (method === 'item/commandExecution/requestApproval') return { result: { decision: 'decline' } };
  if (method === 'item/fileChange/requestApproval') return { result: { decision: 'decline' } };
  if (method === 'item/permissions/requestApproval') return { result: { permissions: {}, scope: 'turn' } };
  if (method === 'item/tool/requestUserInput') return { result: { answers: {} } };
  if (method === 'mcpServer/elicitation/request') return { result: { action: 'cancel', content: null } };
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { result: { decision: 'denied' } };
  return { error: { code: -32601, message: `Unsupported server request in codex-loop non-interactive runner: ${method}` } };
}

function waitForStdinGo(timeoutMs = 10_000) {
  return new Promise((resolveGo, rejectGo) => {
    let settled = false;
    let buf = '';
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      if (err) rejectGo(err);
      else resolveGo();
    };
    const timer = setTimeout(() => done(new Error('Timed out waiting for Job Object GO signal from wrapper.')), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('GO')) done(null);
    };
    const onEnd = () => {
      if (buf.includes('GO')) done(null);
      else done(new Error('Wrapper closed stdin before sending Job Object GO signal.'));
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath || !existsSync(configPath)) {
    throw new Error('Missing runner config JSON path.');
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  cfg.task_kind = String(cfg.task_kind || 'implement').toLowerCase();
  cfg.requested_mode = String(cfg.requested_mode || '').toLowerCase();
  if (cfg.requested_effort) cfg.requested_effort = String(cfg.requested_effort).toLowerCase();

  if (cfg.wait_stdin_go) {
    await waitForStdinGo(10_000);
  }

  const schemaObj = JSON.parse(readFileSync(cfg.schema_file, 'utf8'));
  const promptText = readFileSync(cfg.prompt_file, 'utf8');
  const codexHome = cfg.codex_home || process.env.CODEX_HOME || join(homedir(), '.codex');
  const effectiveWorkDir = cfg.worktree_path || cfg.work_dir;
  const attemptId = cfg.attempt_id;
  const controlPipe = `\\\\.\\pipe\\codex-loop-${attemptId}`;
  const controlToken = randomBytes(24).toString('hex');
  const controlFile = join(cfg.run_dir, `${cfg.turn_tag}.control.json`);
  const controlLogFile = join(cfg.run_dir, `${cfg.turn_tag}.control.jsonl`);

  const status = {
    state: 'running',
    exit_code: null,
    engine: 'app-server',
    attempt_id: attemptId,
    batch_id: cfg.batch_id || null,
    subtask_id: cfg.subtask_id || null,
    worktree_path: cfg.worktree_path || null,
    mode: cfg.is_resume ? 'resume' : 'exec',
    task_kind: cfg.task_kind,
    requested_mode: cfg.requested_mode,
    requested_add_dir: cfg.requested_add_dir || [],
    requested_effort: cfg.requested_effort || null,
    requested_model: cfg.requested_model || null,
    requested_tier: cfg.requested_tier || null,
    // Keep session_id / native_session / desktop_url unset until thread/start or thread/resume actually succeeds.
    session_confirmed: false,
    attempted_session_id: cfg.is_resume ? cfg.session_id : null,
    session_id: null,
    active_turn_id: null,
    turn_ids: [],
    desktop_url: null,
    sidebar_registered: Boolean(cfg.prev_sidebar_registered),
    sidebar_title: cfg.prev_sidebar_title || null,
    sidebar_error: null,
    native_session: null,
    runner_pid: Number(cfg.wrapper_pid) || process.pid,
    node_pid: process.pid,
    cli_pid: null,
    cli_path: cfg.cli_path,
    cli_version: cfg.cli_version || null,
    control_pipe: controlPipe,
    control_file: controlFile,
    control_events: [],
    started_at: cfg.started_at || new Date().toISOString(),
    finished_at: null,
    work_dir: cfg.work_dir,
    effective_work_dir: effectiveWorkDir,
    is_git_repo: Boolean(cfg.is_git_repo),
    conversation_id: cfg.conversation_id || null,
    run_dir: cfg.run_dir,
    prompt_file: cfg.prompt_file,
    source_prompt_file: cfg.source_prompt_file || null,
    status_file: cfg.status_file,
    handoff_file: cfg.handoff_file,
    events_file: cfg.events_file,
    stderr_file: cfg.stderr_file,
    baseline_head_file: cfg.baseline_head_file || null,
    baseline_status_file: cfg.baseline_status_file || null,
    baseline_diff_file: cfg.baseline_diff_file || null,
    baseline_cached_file: cfg.baseline_cached_file || null,
    effective: null,
    usage: null,
    error_kind: null,
    errors: [],
    stderr_preview: '',
    handoff: null,
    handoff_raw_preview: null,
  };

  let desktopUrlAnnounced = false;
  let slotOwnedLocally = false;
  let child = null;
  let pipeServer = null;

  function saveStatus() {
    if (status.session_confirmed && status.session_id && !status.desktop_url) {
      status.desktop_url = `codex://threads/${status.session_id}`;
    }
    // Atomically write status.json FIRST so readers reacting to CODEX_DESKTOP_URL always see confirmed state + effective.
    writeFileAtomic(cfg.status_file, JSON.stringify(status, null, 2));
    if (cfg.report_startup && status.session_confirmed && status.desktop_url && !desktopUrlAnnounced && (status.state === 'running' || status.state === 'finished')) {
      desktopUrlAnnounced = true;
      process.stderr.write(`CODEX_DESKTOP_URL=${status.desktop_url}\n`);
    }
  }

  function recordControlEvent(ev) {
    const rec = { ts: new Date().toISOString(), ...ev };
    appendJsonLine(controlLogFile, rec);
    const existingIdx = rec.client_message_id
      ? status.control_events.findIndex((x) => x.client_message_id === rec.client_message_id)
      : -1;
    if (existingIdx !== -1) {
      const prev = status.control_events[existingIdx];
      // Once userMessage confirmation is observed, applied_in_turn is an irreversible terminal state.
      if (prev.state === 'applied_in_turn') {
        rec.state = 'applied_in_turn';
        if (prev.item_id && !rec.item_id) rec.item_id = prev.item_id;
        delete rec.error;
      }
      status.control_events[existingIdx] = { ...prev, ...rec };
    } else {
      status.control_events.push(rec);
    }
    saveStatus();
  }

  // Either update the slot already acquired by run-codex.ps1, or acquire directly for standalone runner invocations.
  if (cfg.slot_acquired_by_wrapper) {
    await updateSlot(attemptId, {
      control_pipe: controlPipe,
      control_file: controlFile,
    });
  } else {
    const slotRes = await acquireSlot({
      attempt_id: attemptId,
      max_concurrency: cfg.max_concurrency,
      batch_id: cfg.batch_id,
      subtask_id: cfg.subtask_id,
      engine: 'app-server',
      task_kind: cfg.task_kind,
      mode: cfg.requested_mode,
      title: cfg.prev_sidebar_title || getPromptTitle(promptText) || attemptId,
      run_dir: cfg.run_dir,
      work_dir: cfg.work_dir,
      worktree_path: cfg.worktree_path || null,
      session_id: cfg.is_resume ? cfg.session_id : null,
      runner_pid: Number(cfg.wrapper_pid) || process.pid,
      runner_started_ms: cfg.wrapper_started_ms ?? null,
      control_pipe: controlPipe,
      control_file: controlFile,
      status_file: cfg.status_file,
    });

    if (!slotRes.ok) {
      status.state = 'failed';
      status.exit_code = 1;
      status.error_kind = slotRes.error_kind || 'slots_full';
      status.errors = [slotRes.message || 'Failed to acquire concurrency slot.'];
      if (slotRes.active_slots) status.active_slots = slotRes.active_slots;
      status.finished_at = new Date().toISOString();
      saveStatus();
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      process.exit(1);
    }
    slotOwnedLocally = true;
  }

  writeFileAtomic(controlFile, JSON.stringify({
    attempt_id: attemptId,
    pipe: controlPipe,
    token: controlToken,
    node_pid: process.pid,
    runner_pid: status.runner_pid,
    status_file: cfg.status_file,
    created_at: new Date().toISOString(),
  }, null, 2));

  writeFileSync(cfg.events_file, '', 'utf8');
  writeFileSync(cfg.stderr_file, '', 'utf8');
  saveStatus();

  // RPC & control state
  let rpcSeq = 0;
  const pendingRpc = new Map();
  let currentTurnId = null;
  let currentTurnStatus = 'idle'; // idle | starting | inProgress | completed | interrupted | failed
  let targetTurnResolve = null;
  let targetTurnPromise = null;

  // Single turn-scoped interrupt decision (prevents stop + stale follow-up race and late RPC clobbering).
  let interruptSeq = 0;
  let interruptDecision = null; // { seq, turnId, mode: 'stop' | 'restart', followUp: string | null }
  const interruptRpcByTurn = new Map(); // turnId -> { promise, succeeded }
  let pendingStartupStop = false;

  const turnItemsByTurnId = new Map();
  const steerMessageByCid = new Map(); // client_message_id -> original message (immutable binding across retries/timeouts)
  const steerReceipts = new Map(); // client_message_id -> { message, receipt }
  const steerInFlight = new Map(); // client_message_id -> { message, promise }
  const steerClientIds = new Set();
  const pendingStartupSteers = [];
  const liveItems = new Map(); // itemId -> { projected, timer, dirty }
  const stderrChunks = [];
  let stderrTotalLen = 0;

  function resetTurnWaiter() {
    targetTurnPromise = new Promise((res) => {
      targetTurnResolve = res;
    });
  }

  function resolveTurnWaiter(result) {
    if (targetTurnResolve) {
      const fn = targetTurnResolve;
      targetTurnResolve = null;
      fn(result);
    }
  }

  function flushLiveItem(itemId) {
    const entry = liveItems.get(itemId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.dirty) {
      entry.dirty = false;
      appendJsonLine(cfg.events_file, { type: 'item.updated', item: entry.projected });
    }
  }

  function scheduleDeltaFlush(itemId, fallbackType, deltaField, deltaText) {
    let entry = liveItems.get(itemId);
    if (!entry) {
      const base = fallbackType === 'command_execution'
        ? { id: itemId, type: 'command_execution', status: 'in_progress', command: '', aggregated_output: '', exit_code: null }
        : fallbackType === 'reasoning'
          ? { id: itemId, type: 'reasoning', status: 'in_progress', text: '' }
          : { id: itemId, type: 'agent_message', status: 'in_progress', text: '' };
      if (currentTurnId) base.turn_id = currentTurnId;
      entry = { projected: base, timer: null, dirty: false };
      liveItems.set(itemId, entry);
    }
    entry.projected[deltaField] = (entry.projected[deltaField] || '') + deltaText;
    entry.dirty = true;
    if (!entry.timer) {
      entry.timer = setTimeout(() => flushLiveItem(itemId), DELTA_FLUSH_MS);
    }
  }

  function sendRawRpc(obj) {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is closed.');
    }
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function rpcRequest(method, params, timeoutMs = 60_000) {
    const id = `r${++rpcSeq}`;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        rejectReq(new Error(`RPC timeout (${timeoutMs}ms) on ${method}`));
      }, timeoutMs);
      pendingRpc.set(id, {
        method,
        resolve: (val) => { clearTimeout(timer); resolveReq(val); },
        reject: (err) => { clearTimeout(timer); rejectReq(err); },
      });
      try {
        sendRawRpc({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pendingRpc.delete(id);
        rejectReq(err);
      }
    });
  }

  function dispatchSteerToActiveTurn(message, cid) {
    const expectedTurnId = currentTurnId;
    const promise = (async () => {
      try {
        const res = await rpcRequest('turn/steer', {
          threadId: status.session_id,
          expectedTurnId,
          input: [{ type: 'text', text: message }],
          clientUserMessageId: cid,
        }, 15_000);
        const existingEv = status.control_events.find((x) => x.client_message_id === cid);
        const state = existingEv?.state === 'applied_in_turn' ? 'applied_in_turn' : 'accepted';
        const receipt = {
          ok: true,
          action: 'steer',
          state,
          client_message_id: cid,
          turn_id: res?.turnId || expectedTurnId,
          ...(existingEv?.item_id ? { item_id: existingEv.item_id } : {}),
        };
        steerReceipts.set(cid, { message, receipt });
        recordControlEvent({ action: 'steer', state, client_message_id: cid, turn_id: receipt.turn_id, text: message });
        return receipt;
      } catch (err) {
        // If userMessage notification already confirmed applied_in_turn before RPC timed out/errored, preserve success.
        const existingEv = status.control_events.find((x) => x.client_message_id === cid);
        if (existingEv?.state === 'applied_in_turn') {
          const appliedReceipt = {
            ok: true,
            action: 'steer',
            state: 'applied_in_turn',
            client_message_id: cid,
            turn_id: existingEv.turn_id || expectedTurnId,
            ...(existingEv.item_id ? { item_id: existingEv.item_id } : {}),
          };
          steerReceipts.set(cid, { message, receipt: appliedReceipt });
          return appliedReceipt;
        }
        const msg = err?.message || String(err);
        const notActive = /no active turn|expected active turn id/i.test(msg);
        const failRec = {
          ok: false,
          action: 'steer',
          state: notActive ? 'turn_not_active' : 'steer_failed',
          error_kind: notActive ? 'turn_not_active' : 'steer_failed',
          client_message_id: cid,
          turn_id: currentTurnId,
          message: msg,
        };
        recordControlEvent({ action: 'steer', state: failRec.state, client_message_id: cid, turn_id: currentTurnId, error: msg });
        return failRec;
      } finally {
        steerInFlight.delete(cid);
      }
    })();
    steerInFlight.set(cid, { message, promise });
    return promise;
  }

  async function executeSteer(message, clientMessageId) {
    const cid = clientMessageId || `steer-${randomUUID()}`;

    // Immutable client_message_id -> message binding persists even if an earlier RPC timed out.
    if (steerMessageByCid.has(cid) && steerMessageByCid.get(cid) !== message) {
      return {
        ok: false,
        action: 'steer',
        error_kind: 'idempotency_conflict',
        client_message_id: cid,
        message: `client_message_id "${cid}" was already bound to a different message body.`,
      };
    }

    const inflight = steerInFlight.get(cid);
    if (inflight) {
      return inflight.promise;
    }

    const prevEntry = steerReceipts.get(cid);
    if (prevEntry) {
      const latestEv = status.control_events.find((x) => x.client_message_id === cid);
      if (latestEv?.state === 'applied_in_turn' && prevEntry.receipt.state !== 'applied_in_turn') {
        prevEntry.receipt.state = 'applied_in_turn';
        if (latestEv.item_id) prevEntry.receipt.item_id = latestEv.item_id;
      }
      return prevEntry.receipt;
    }

    const alreadyAppliedEv = status.control_events.find((x) => x.client_message_id === cid && x.state === 'applied_in_turn');
    if (alreadyAppliedEv) {
      const appliedReceipt = {
        ok: true,
        action: 'steer',
        state: 'applied_in_turn',
        client_message_id: cid,
        turn_id: alreadyAppliedEv.turn_id || currentTurnId,
        ...(alreadyAppliedEv.item_id ? { item_id: alreadyAppliedEv.item_id } : {}),
      };
      steerReceipts.set(cid, { message, receipt: appliedReceipt });
      return appliedReceipt;
    }

    steerMessageByCid.set(cid, message);
    steerClientIds.add(cid);

    if (!currentTurnId && (currentTurnStatus === 'idle' || currentTurnStatus === 'starting')) {
      const queuedReceipt = {
        ok: true,
        action: 'steer',
        state: 'queued_until_turn_start',
        client_message_id: cid,
        turn_id: null,
        message,
      };
      steerReceipts.set(cid, { message, receipt: queuedReceipt });
      pendingStartupSteers.push({ message, client_message_id: cid });
      recordControlEvent({ action: 'steer', state: 'queued_until_turn_start', client_message_id: cid, text: message });
      return queuedReceipt;
    }

    if (!currentTurnId || currentTurnStatus !== 'inProgress') {
      return {
        ok: false,
        action: 'steer',
        state: currentTurnStatus === 'completed' ? 'already_finished' : 'turn_not_active',
        error_kind: currentTurnStatus === 'completed' ? 'already_finished' : 'turn_not_active',
        client_message_id: cid,
        turn_id: currentTurnId,
        turn_status: currentTurnStatus,
        message: 'No active turn available to steer; use resume instead.',
      };
    }

    return dispatchSteerToActiveTurn(message, cid);
  }

  function drainPendingStartupControls() {
    if (pendingStartupStop && currentTurnId && currentTurnStatus === 'inProgress') {
      executeInterrupt('Stopped during startup', '').catch(() => {});
      pendingStartupSteers.length = 0;
      return;
    }
    while (pendingStartupSteers.length > 0 && currentTurnId && currentTurnStatus === 'inProgress') {
      const item = pendingStartupSteers.shift();
      steerReceipts.delete(item.client_message_id);
      if (!steerInFlight.has(item.client_message_id)) {
        dispatchSteerToActiveTurn(item.message, item.client_message_id).catch(() => {});
      }
    }
  }

  async function executeInterrupt(reason = '', followUp = '') {
    const trimmedFollowUp = typeof followUp === 'string' ? followUp.trim() : '';
    const wantsRestart = Boolean(trimmedFollowUp);

    // Handle explicit stop arriving during startup handshake before turn/started.
    if (!currentTurnId && (currentTurnStatus === 'idle' || currentTurnStatus === 'starting')) {
      if (!wantsRestart) {
        pendingStartupStop = true;
        recordControlEvent({
          action: 'interrupt',
          state: 'stopping_on_start',
          turn_id: null,
          reason: reason || null,
          has_follow_up: false,
        });
        return {
          ok: true,
          action: 'interrupt',
          state: 'stopping_on_start',
          turn_id: null,
        };
      }
      return {
        ok: false,
        action: 'interrupt',
        state: 'turn_not_active',
        error_kind: 'turn_not_active',
        turn_id: null,
        message: 'Turn has not started yet; use steer (queued_until_turn_start) or wait for turn start before restart.',
      };
    }

    if (!currentTurnId || currentTurnStatus !== 'inProgress') {
      return {
        ok: false,
        action: 'interrupt',
        state: currentTurnStatus === 'completed' ? 'already_finished' : 'turn_not_active',
        error_kind: currentTurnStatus === 'completed' ? 'already_finished' : 'turn_not_active',
        turn_id: currentTurnId,
        message: 'No active turn to interrupt.',
      };
    }

    const targetTid = currentTurnId;
    const prevSameTurn = interruptDecision && interruptDecision.turnId === targetTid ? interruptDecision : null;

    // Pure stop strictly overrides any earlier follow-up, and once stopped for this turn a follow-up cannot resurrect it.
    let nextMode;
    let nextFollowUp;
    if (!wantsRestart || prevSameTurn?.mode === 'stop') {
      nextMode = 'stop';
      nextFollowUp = null;
    } else {
      nextMode = 'restart';
      nextFollowUp = trimmedFollowUp;
    }

    const mySeq = ++interruptSeq;
    interruptDecision = { seq: mySeq, turnId: targetTid, mode: nextMode, followUp: nextFollowUp };

    recordControlEvent({
      action: 'interrupt',
      state: nextMode === 'restart' ? 'restarting' : 'interrupting',
      turn_id: targetTid,
      reason: reason || null,
      has_follow_up: nextMode === 'restart',
    });

    // Share one turn/interrupt RPC per turn so a subsequent pure stop never sends a failing second RPC that resurrects FollowUp.
    let rpcEntry = interruptRpcByTurn.get(targetTid);
    if (rpcEntry?.succeeded) {
      const effectiveMode = interruptDecision && interruptDecision.turnId === targetTid ? interruptDecision.mode : nextMode;
      return {
        ok: true,
        action: 'interrupt',
        state: effectiveMode === 'restart' ? 'restarting' : 'interrupting',
        turn_id: targetTid,
      };
    }

    if (!rpcEntry) {
      const entry = { succeeded: false, promise: null };
      entry.promise = rpcRequest('turn/interrupt', { threadId: status.session_id, turnId: targetTid }, 15_000)
        .then(() => {
          entry.succeeded = true;
        })
        .catch((err) => {
          if (interruptRpcByTurn.get(targetTid) === entry) {
            interruptRpcByTurn.delete(targetTid);
          }
          throw err;
        });
      interruptRpcByTurn.set(targetTid, entry);
      rpcEntry = entry;
    }

    try {
      await rpcEntry.promise;
      const effectiveMode = interruptDecision && interruptDecision.turnId === targetTid ? interruptDecision.mode : nextMode;
      return {
        ok: true,
        action: 'interrupt',
        state: effectiveMode === 'restart' ? 'restarting' : 'interrupting',
        turn_id: targetTid,
      };
    } catch (err) {
      // Never roll back an explicit pure stop into an earlier restart/FollowUp on transport error.
      if (
        interruptDecision &&
        interruptDecision.seq === mySeq &&
        interruptDecision.mode !== 'stop' &&
        currentTurnId === targetTid &&
        currentTurnStatus === 'inProgress'
      ) {
        interruptDecision = prevSameTurn;
      }
      return {
        ok: false,
        action: 'interrupt',
        state: 'interrupt_failed',
        error_kind: 'interrupt_failed',
        turn_id: targetTid,
        message: err?.message || String(err),
      };
    }
  }

  function startControlPipe() {
    return new Promise((resolveSrv, rejectSrv) => {
      pipeServer = net.createServer((socket) => {
        socket.on('error', () => {});
        const decoder = new StringDecoder('utf8');
        let buf = '';
        let socketQueue = Promise.resolve();

        const enqueueLine = (line) => {
          socketQueue = socketQueue.then(async () => {
            let resp;
            try {
              const req = JSON.parse(line);
              const reqAction = String(req.action || '').toLowerCase();
              if (req.token !== controlToken) {
                resp = { ok: false, error_kind: 'unauthorized', message: 'Invalid control token.' };
              } else if (reqAction === 'status') {
                resp = {
                  ok: true,
                  state: status.state,
                  session_id: status.session_id,
                  active_turn_id: currentTurnId,
                  turn_status: currentTurnStatus,
                  control_events: status.control_events,
                  usage: status.usage,
                };
              } else if (reqAction === 'steer') {
                if (!req.message || !String(req.message).trim()) {
                  resp = { ok: false, error_kind: 'invalid_arguments', message: 'Steer message is empty.' };
                } else {
                  resp = await executeSteer(String(req.message), req.client_message_id || null);
                }
              } else if (reqAction === 'interrupt') {
                resp = await executeInterrupt(req.reason || '', req.follow_up || '');
              } else {
                resp = { ok: false, error_kind: 'invalid_action', message: `Unknown control action: ${req.action}` };
              }
            } catch (err) {
              resp = { ok: false, error_kind: 'control_error', message: err?.message || String(err) };
            }
            if (!socket.destroyed && socket.writable) {
              try {
                socket.write(`${JSON.stringify(resp)}\n`, 'utf8');
              } catch {}
            }
          });
        };

        socket.on('data', (chunk) => {
          buf += decoder.write(chunk);
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) enqueueLine(line);
          }
        });

        socket.on('end', () => {
          buf += decoder.end();
          const tail = buf.trim();
          buf = '';
          if (tail) enqueueLine(tail);
        });
      });
      pipeServer.once('error', rejectSrv);
      pipeServer.listen(controlPipe, () => {
        pipeServer.off('error', rejectSrv);
        pipeServer.on('error', () => {});
        resolveSrv();
      });
    });
  }

  function handleNotification(method, params) {
    if (!params || typeof params !== 'object') return;

    if (method === 'turn/started') {
      const tid = params.turn?.id || null;
      if (tid) {
        currentTurnId = tid;
        currentTurnStatus = 'inProgress';
        status.active_turn_id = tid;
        if (!status.turn_ids.includes(tid)) status.turn_ids.push(tid);
        if (!turnItemsByTurnId.has(tid)) turnItemsByTurnId.set(tid, []);
        appendJsonLine(cfg.events_file, { type: 'turn.started', turn_id: tid });
        saveStatus();
        updateSlot(attemptId, { active_turn_id: tid }).catch(() => {});
        drainPendingStartupControls();
      }
      return;
    }

    if (method === 'item/started') {
      const item = params.item;
      const tid = params.turnId || currentTurnId;
      const proj = projectThreadItem(item, steerClientIds, tid);
      if (proj) {
        if (proj.id) liveItems.set(proj.id, { projected: proj, timer: null, dirty: false });
        appendJsonLine(cfg.events_file, { type: 'item.started', turn_id: tid, item: proj });
      }
      return;
    }

    if (method === 'item/commandExecution/outputDelta') {
      if (params.itemId && typeof params.delta === 'string') {
        scheduleDeltaFlush(params.itemId, 'command_execution', 'aggregated_output', params.delta);
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      if (params.itemId && typeof params.delta === 'string') {
        scheduleDeltaFlush(params.itemId, 'agent_message', 'text', params.delta);
      }
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      if (params.itemId && typeof params.delta === 'string') {
        scheduleDeltaFlush(params.itemId, 'reasoning', 'text', params.delta);
      }
      return;
    }

    if (method === 'item/completed') {
      const item = params.item;
      const tid = params.turnId || currentTurnId;
      if (tid) {
        if (!turnItemsByTurnId.has(tid)) turnItemsByTurnId.set(tid, []);
        turnItemsByTurnId.get(tid).push(item);
      }
      if (item?.type === 'userMessage' && item.clientId && steerClientIds.has(item.clientId)) {
        const entry = steerReceipts.get(item.clientId);
        if (entry?.receipt) {
          entry.receipt.state = 'applied_in_turn';
          if (item.id) entry.receipt.item_id = item.id;
        }
        recordControlEvent({
          action: 'steer',
          state: 'applied_in_turn',
          client_message_id: item.clientId,
          turn_id: tid,
          item_id: item.id || null,
        });
      }
      if (item?.id && liveItems.has(item.id)) {
        const entry = liveItems.get(item.id);
        if (entry.timer) clearTimeout(entry.timer);
        liveItems.delete(item.id);
      }
      const proj = projectThreadItem(item, steerClientIds, tid);
      if (proj) {
        appendJsonLine(cfg.events_file, { type: 'item.completed', turn_id: tid, item: proj });
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      const mapped = mapTokenUsage(params.tokenUsage);
      if (mapped) status.usage = mapped;
      return;
    }

    if (method === 'error') {
      const msg = params.error?.message || JSON.stringify(params);
      if (!params.willRetry) {
        status.errors.push(msg);
      }
      appendJsonLine(cfg.events_file, { type: 'error', message: msg, will_retry: Boolean(params.willRetry) });
      return;
    }

    if (method === 'turn/completed') {
      for (const id of [...liveItems.keys()]) flushLiveItem(id);
      const turn = params.turn || {};
      const tid = turn.id || currentTurnId;
      if (Array.isArray(turn.items) && turn.items.length > 0 && tid) {
        turnItemsByTurnId.set(tid, turn.items);
      }
      const st = turn.status || 'completed';
      currentTurnStatus = st;
      if (st === 'completed') {
        appendJsonLine(cfg.events_file, { type: 'turn.completed', turn_id: tid, usage: status.usage });
      } else if (st === 'interrupted') {
        recordControlEvent({ action: 'interrupt', state: 'interrupted', turn_id: tid });
        appendJsonLine(cfg.events_file, { type: 'turn.interrupted', turn_id: tid });
      } else if (st === 'failed') {
        const errMsg = turn.error?.message || 'Turn failed.';
        status.errors.push(errMsg);
        appendJsonLine(cfg.events_file, { type: 'turn.failed', turn_id: tid, error: { message: errMsg } });
      }
      resolveTurnWaiter({ turnId: tid, status: st, error: turn.error || null, items: turn.items || [] });
    }
  }

  async function registerSidebarInBand(threadId, existingName, existingSection) {
    try {
      let title = existingName || status.sidebar_title || null;
      if (!title && !cfg.is_resume) {
        const derived = getPromptTitle(promptText);
        if (derived) {
          try {
            await rpcRequest('thread/name/set', { threadId, name: derived }, 10_000);
            title = derived;
          } catch (err) {
            status.sidebar_error = err?.message || String(err);
          }
        }
      }
      status.sidebar_title = title;
      if (status.sidebar_registered || existingSection) {
        status.sidebar_registered = true;
        saveStatus();
        return;
      }

      // Shared OS-enforced Named Pipe lock with add-sidebar-thread.ps1; throws on timeout instead of running unlocked.
      await withNamedPipeLock(SECTION_LOCK_PIPE, async () => {
        let cursor = null;
        let section = null;
        do {
          const page = await rpcRequest('threadSection/list', { cursor, limit: 100 }, 10_000);
          section = (page?.data || []).find((s) => s.name === SECTION_NAME) || null;
          cursor = page?.nextCursor || null;
        } while (!section && cursor);

        let firstId = null;
        if (section) {
          const members = await rpcRequest('thread/list', {
            sectionId: section.id,
            sortKey: 'section_position',
            limit: 1,
            modelProviders: [],
            useStateDbOnly: true,
            sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
          }, 10_000);
          firstId = members?.data?.[0]?.id || null;
          if (firstId === threadId) {
            status.sidebar_registered = true;
            return;
          }
        } else {
          const created = await rpcRequest('threadSection/create', { name: SECTION_NAME }, 10_000);
          section = created?.section || null;
        }

        if (section) {
          try {
            await rpcRequest('thread/section/move', { threadId, sectionId: section.id, beforeThreadId: firstId }, 10_000);
          } catch (err) {
            if (firstId && String(err?.message || '').includes(`before thread ${firstId} is not in section`)) {
              await rpcRequest('thread/section/move', { threadId, sectionId: section.id, beforeThreadId: null }, 10_000);
            } else {
              throw err;
            }
          }
          status.sidebar_registered = true;
        }
      }, 15_000);
    } catch (err) {
      status.sidebar_error = err?.message || String(err);
    }
    saveStatus();
  }

  let runSucceeded = false;

  try {
    await startControlPipe();

    const policies = buildModePolicies(cfg.requested_mode, cfg.requested_add_dir || []);
    const args = [
      ...(cfg.cli_prefix_args || []),
      '-c', 'notify=[]',
      '--disable', 'default_mode_request_user_input',
    ];
    if (cfg.requested_effort) {
      args.push('-c', `model_reasoning_effort="${cfg.requested_effort}"`);
    }
    if (cfg.requested_tier) {
      args.push('-c', `service_tier="${cfg.requested_tier}"`);
    }
    if ((cfg.requested_mode === 'workspace' || cfg.requested_mode === 'auto') && Array.isArray(cfg.requested_add_dir) && cfg.requested_add_dir.length > 0) {
      const escaped = cfg.requested_add_dir.map((d) => `"${String(d).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      args.push('-c', `sandbox_workspace_write.writable_roots=[${escaped.join(',')}]`);
    }
    args.push('app-server', '--listen', 'stdio://');

    child = spawn(cfg.cli_path, args, {
      cwd: effectiveWorkDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const cliSpawnMs = Date.now();

    // Attach ALL child error/exit/stream listeners synchronously BEFORE any async slot I/O.
    let childSpawnError = null;
    let childExitState = null;
    const childExitPromise = new Promise((res) => {
      child.once('exit', (code, signal) => {
        childExitState = { code: code ?? 1, signal };
        for (const [, w] of pendingRpc.entries()) {
          w.reject(new Error(`Codex app-server exited prematurely (code=${code ?? 1}).`));
        }
        pendingRpc.clear();
        resolveTurnWaiter({ turnId: currentTurnId, status: 'exited', code: code ?? 1 });
        res(childExitState);
      });
      child.once('error', (err) => {
        childSpawnError = err;
        childExitState = { code: 1, error: err };
        for (const [, w] of pendingRpc.entries()) {
          w.reject(new Error(`Codex app-server spawn error: ${err.message}`));
        }
        pendingRpc.clear();
        resolveTurnWaiter({ turnId: currentTurnId, status: 'exited', code: 1, error: err });
        res(childExitState);
      });
    });

    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const stderrDecoder = new StringDecoder('utf8');
    child.stderr.on('data', (chunk) => {
      const str = stderrDecoder.write(chunk);
      appendFileSync(cfg.stderr_file, str, 'utf8');
      if (stderrTotalLen < 65_536) {
        stderrChunks.push(str);
        stderrTotalLen += str.length;
      }
    });
    child.stderr.once('end', () => {
      const tail = stderrDecoder.end();
      if (tail) {
        appendFileSync(cfg.stderr_file, tail, 'utf8');
        if (stderrTotalLen < 65_536) {
          stderrChunks.push(tail);
          stderrTotalLen += tail.length;
        }
      }
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const waiter = pendingRpc.get(msg.id);
        if (waiter) {
          pendingRpc.delete(msg.id);
          if (msg.error) {
            const err = new Error(msg.error.message || JSON.stringify(msg.error));
            err.rpcCode = msg.error.code;
            waiter.reject(err);
          } else {
            waiter.resolve(msg.result);
          }
        }
        return;
      }

      if (msg.id !== undefined && msg.method) {
        const reply = buildServerRequestReply(msg.method);
        if (reply.error) {
          sendRawRpc({ jsonrpc: '2.0', id: msg.id, error: reply.error });
        } else {
          sendRawRpc({ jsonrpc: '2.0', id: msg.id, result: reply.result });
        }
        appendJsonLine(cfg.events_file, {
          type: 'item.completed',
          turn_id: currentTurnId,
          item: {
            id: `srvreq_${msg.id}`,
            type: 'error',
            message: `Auto-handled server request ${msg.method} (${reply.result ? JSON.stringify(reply.result) : reply.error.message}).`,
          },
        });
        return;
      }

      if (msg.method) {
        handleNotification(msg.method, msg.params);
      }
    });

    status.cli_pid = child.pid ?? null;
    saveStatus();
    if (child.pid) {
      await updateSlot(attemptId, { cli_pid: child.pid, cli_started_ms: cliSpawnMs });
    }
    if (childSpawnError) {
      throw new Error(`Failed to spawn Codex app-server: ${childSpawnError.message}`);
    }
    if (childExitState) {
      throw new Error(`Codex app-server exited before handshake (code=${childExitState.code}).`);
    }

    // 1. Handshake
    await rpcRequest('initialize', {
      clientInfo: { name: 'codex_loop', version: '2.0' },
      capabilities: { experimentalApi: true },
    }, 30_000);
    sendRawRpc({ jsonrpc: '2.0', method: 'initialized' });

    // 2. Start or resume thread (session is confirmed ONLY after this RPC succeeds)
    let threadResp;
    if (cfg.is_resume) {
      const resumeParams = {
        threadId: cfg.session_id,
        cwd: effectiveWorkDir,
        sandbox: policies.threadSandbox,
        approvalPolicy: policies.approvalPolicy,
        persistExtendedHistory: true,
      };
      if (cfg.requested_model) resumeParams.model = cfg.requested_model;
      if (cfg.requested_tier) resumeParams.serviceTier = cfg.requested_tier;
      if (policies.approvalsReviewer) resumeParams.approvalsReviewer = policies.approvalsReviewer;
      threadResp = await rpcRequest('thread/resume', resumeParams, 30_000);
    } else {
      const startParams = {
        cwd: effectiveWorkDir,
        sandbox: policies.threadSandbox,
        approvalPolicy: policies.approvalPolicy,
        ephemeral: false,
      };
      if (cfg.requested_model) startParams.model = cfg.requested_model;
      if (cfg.requested_tier) startParams.serviceTier = cfg.requested_tier;
      if (policies.approvalsReviewer) startParams.approvalsReviewer = policies.approvalsReviewer;
      threadResp = await rpcRequest('thread/start', startParams, 30_000);
    }

    const thread = threadResp?.thread || {};
    status.session_confirmed = true;
    status.session_id = thread.id || cfg.session_id;
    status.native_session = thread.path || cfg.initial_native_session || findRolloutPathById(codexHome, status.session_id);
    status.effective = {
      workdir: threadResp.cwd || effectiveWorkDir,
      model: threadResp.model || null,
      effort: threadResp.reasoningEffort || null,
      service_tier: threadResp.serviceTier || null,
      approval: normalizeApprovalName(threadResp.approvalPolicy),
      sandbox: normalizeSandboxName(threadResp.sandbox),
    };
    appendJsonLine(cfg.events_file, { type: 'thread.started', thread_id: status.session_id });
    saveStatus();
    await updateSlot(attemptId, { session_id: status.session_id });

    // Register sidebar asynchronously without delaying turn start.
    const sidebarPromise = registerSidebarInBand(status.session_id, thread.name, thread.section);

    // 3. Turn execution loop (supports in-place replacement turn on interrupt + follow_up)
    let nextPrompt = promptText;
    let pendingFollowUpPrompt = null;
    let finalTurnOutcome = null;

    while (nextPrompt !== null) {
      if (pendingStartupStop) {
        finalTurnOutcome = { turnId: null, status: 'interrupted', items: [] };
        break;
      }

      resetTurnWaiter();
      currentTurnStatus = 'starting';
      const turnParams = {
        threadId: status.session_id,
        input: [{ type: 'text', text: nextPrompt }],
        cwd: effectiveWorkDir,
        sandboxPolicy: policies.turnSandboxPolicy,
        approvalPolicy: policies.approvalPolicy,
        outputSchema: schemaObj,
      };
      if (cfg.requested_model) turnParams.model = cfg.requested_model;
      if (cfg.requested_effort) turnParams.effort = cfg.requested_effort;
      if (cfg.requested_tier) turnParams.serviceTier = cfg.requested_tier;
      if (policies.approvalsReviewer) turnParams.approvalsReviewer = policies.approvalsReviewer;

      const startTurnResp = await rpcRequest('turn/start', turnParams, 30_000);
      const startedTid = startTurnResp?.turn?.id || currentTurnId;
      if (pendingFollowUpPrompt !== null) {
        // Emit the replacement turn event ONLY after turn/start actually succeeded with a turn ID.
        appendJsonLine(cfg.events_file, {
          type: 'item.completed',
          turn_id: startedTid || null,
          item: {
            id: `followup_${Date.now()}`,
            turn_id: startedTid || null,
            type: 'user_message',
            is_steer: false,
            is_followup: true,
            status: 'completed',
            text: pendingFollowUpPrompt,
          },
        });
        pendingFollowUpPrompt = null;
      }
      if (startTurnResp?.turn?.id && !currentTurnId) {
        currentTurnId = startTurnResp.turn.id;
        currentTurnStatus = 'inProgress';
        status.active_turn_id = currentTurnId;
        if (!status.turn_ids.includes(currentTurnId)) status.turn_ids.push(currentTurnId);
        if (!turnItemsByTurnId.has(currentTurnId)) turnItemsByTurnId.set(currentTurnId, []);
        saveStatus();
        await updateSlot(attemptId, { active_turn_id: currentTurnId });
        drainPendingStartupControls();
      }

      nextPrompt = null;
      finalTurnOutcome = await targetTurnPromise;

      const dec = interruptDecision;
      if (
        finalTurnOutcome.status === 'interrupted' &&
        !pendingStartupStop &&
        dec &&
        dec.turnId === finalTurnOutcome.turnId &&
        dec.mode === 'restart' &&
        dec.followUp
      ) {
        nextPrompt = dec.followUp;
        pendingFollowUpPrompt = dec.followUp;
        interruptDecision = null;
        currentTurnId = null;
        continue;
      }
      break;
    }

    await sidebarPromise.catch(() => {});

    if (!status.native_session && status.session_id) {
      status.native_session = findRolloutPathById(codexHome, status.session_id);
    }

    // 4. Extract & validate final handoff for completed turn
    if (finalTurnOutcome?.status === 'completed') {
      const targetTid = finalTurnOutcome.turnId;
      const localItems = turnItemsByTurnId.get(targetTid) || finalTurnOutcome.items || [];
      let candidate = pickFinalAssistantCandidate(localItems);

      const validateRawCandidate = (text) => {
        try {
          const parsed = JSON.parse(text);
          const v = validateHandoff(parsed, schemaObj, cfg.task_kind);
          return { parsed, validation: v, parseError: null };
        } catch (err) {
          return { parsed: null, validation: null, parseError: err.message };
        }
      };

      let localEval = candidate ? validateRawCandidate(candidate.text) : null;
      const needThreadReadFallback = !candidate || !candidate.confident || !localEval?.validation?.valid;

      if (needThreadReadFallback && status.session_id) {
        try {
          const readRes = await rpcRequest('thread/read', { threadId: status.session_id, includeTurns: true }, 15_000);
          const matchedTurn = (readRes?.thread?.turns || []).find((t) => t.id === targetTid);
          if (matchedTurn && Array.isArray(matchedTurn.items)) {
            const remoteCandidate = pickFinalAssistantCandidate(matchedTurn.items);
            if (remoteCandidate) {
              const remoteEval = validateRawCandidate(remoteCandidate.text);
              if (remoteCandidate.confident && (remoteEval.validation?.valid || !candidate || !candidate.confident)) {
                candidate = remoteCandidate;
                localEval = remoteEval;
              }
            }
          }
        } catch {}
      }

      // Reject turns whose only assistant messages are explicitly marked commentary (never accept commentary as final handoff).
      if (candidate && candidate.confident) {
        writeFileAtomic(cfg.handoff_file, candidate.text);
        if (localEval.parseError) {
          status.handoff_raw_preview = candidate.text.length > 800 ? candidate.text.slice(0, 800) : candidate.text;
          status.state = 'failed';
          status.exit_code = 1;
          status.error_kind = 'invalid_handoff';
          status.errors.push(`Final assistant message is not valid JSON: ${localEval.parseError}`);
        } else {
          status.handoff = localEval.parsed;
          if (localEval.validation.valid) {
            status.state = 'finished';
            status.exit_code = 0;
            runSucceeded = true;
          } else {
            status.state = 'failed';
            status.exit_code = 1;
            status.error_kind = 'invalid_handoff';
            for (const e of localEval.validation.errors) status.errors.push(e);
          }
        }
      } else if (candidate && !candidate.confident) {
        status.handoff_raw_preview = candidate.text.length > 800 ? candidate.text.slice(0, 800) : candidate.text;
        status.state = 'failed';
        status.exit_code = 1;
        status.error_kind = 'invalid_handoff';
        status.errors.push('Turn completed with only commentary messages and no final_answer handoff.');
      } else {
        status.state = 'failed';
        status.exit_code = 1;
        status.error_kind = 'invalid_handoff';
        status.errors.push('Turn completed without a final assistant message.');
      }
    } else if (finalTurnOutcome?.status === 'interrupted' || pendingStartupStop || interruptDecision?.mode === 'stop') {
      status.state = 'stopped';
      status.exit_code = 130;
    } else {
      status.state = 'failed';
      status.exit_code = 1;
    }

    if (child && !child.killed) {
      try { child.stdin.end(); } catch {}
      await Promise.race([
        childExitPromise,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  } catch (err) {
    status.state = 'failed';
    status.exit_code = 1;
    if (err?.error_kind && !status.error_kind) status.error_kind = err.error_kind;
    status.errors.push(err?.message || String(err));
  } finally {
    for (const id of [...liveItems.keys()]) {
      const entry = liveItems.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
    }
    if (pipeServer) {
      try { pipeServer.close(); } catch {}
    }
    if (child && child.exitCode === null) {
      try { child.kill(); } catch {}
    }
    try { rmSync(controlFile, { force: true }); } catch {}

    const stderrText = stderrChunks.join('').trim();
    status.stderr_preview = stderrText.length > 800 ? stderrText.slice(-800) : stderrText;
    status.errors = [...new Set(status.errors.filter(Boolean))];

    const combinedErr = `${status.errors.join('\n')}\n${stderrText}`;
    if (!status.error_kind) {
      if (/already has an active writer/i.test(combinedErr)) status.error_kind = 'active_writer';
      else if (/at capacity/i.test(combinedErr)) status.error_kind = 'capacity';
    }

    if (!status.session_confirmed) {
      status.effective = null;
      status.desktop_url = null;
    }

    status.finished_at = new Date().toISOString();
    saveStatus();

    if (slotOwnedLocally) {
      try { await releaseSlot(attemptId); } catch {}
    }
  }

  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(runSucceeded ? 0 : (status.exit_code || 1));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`FATAL app-server-runner: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
}
