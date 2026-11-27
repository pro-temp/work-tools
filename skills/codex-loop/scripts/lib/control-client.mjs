import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { findSlot, isMainModule } from './slots.mjs';

function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findLatestStatusInRunDir(runDir) {
  if (!runDir || !existsSync(runDir)) return null;
  const files = readdirSync(runDir)
    .filter((f) => f.endsWith('.status.json'))
    .map((f) => {
      const full = join(runDir, f);
      return { full, mtimeMs: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const data = readJsonSafe(f.full);
    if (data) return { path: f.full, data };
  }
  return null;
}

function sendPipeCommand(pipePath, payload, timeoutMs = 15_000) {
  return new Promise((resolveCmd, rejectCmd) => {
    const socket = net.createConnection(pipePath);
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        socket.destroy();
        rejectCmd(err);
      } else {
        socket.end();
        resolveCmd(val);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`Control pipe timed out after ${timeoutMs}ms (${pipePath}).`));
    }, timeoutMs);

    socket.once('error', (err) => finish(err));

    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`, 'utf8');
    });

    socket.on('data', (chunk) => {
      buf += decoder.write(chunk);
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      try {
        finish(null, JSON.parse(line));
      } catch (err) {
        finish(new Error(`Malformed control response: ${err.message}`));
      }
    });

    socket.once('end', () => {
      buf += decoder.end();
      const line = buf.trim();
      if (!settled) {
        if (!line) {
          finish(new Error('Control pipe closed before sending a response.'));
          return;
        }
        try {
          finish(null, JSON.parse(line));
        } catch (err) {
          finish(new Error(`Malformed control response: ${err.message}`));
        }
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendControl({
  attemptId = '',
  runDir = '',
  sessionId = '',
  action = 'steer',
  message = '',
  reason = '',
  followUp = '',
  clientMessageId = '',
  waitAppliedMs = 3000,
  timeoutMs = 15_000,
}) {
  const normAction = String(action || 'steer').toLowerCase();
  const slot = await findSlot({ attemptId, runDir, sessionId });

  if (!slot) {
    const latest = runDir ? findLatestStatusInRunDir(runDir) : null;
    const statusData = latest?.data || null;
    if (statusData && statusData.state && statusData.state !== 'running') {
      return {
        ok: false,
        action: normAction,
        state: 'already_finished',
        error_kind: 'already_finished',
        session_id: statusData.session_id || sessionId || null,
        run_state: statusData.state,
        message: `Target dispatch already ended with state="${statusData.state}". Use resume to send follow-up instructions.`,
      };
    }
    return {
      ok: false,
      action: normAction,
      error_kind: 'not_found',
      message: 'No active codex-loop worker matched the provided RunDir / SessionId / AttemptId.',
    };
  }

  if (slot.engine && slot.engine !== 'app-server') {
    return {
      ok: false,
      action: normAction,
      error_kind: 'not_controllable',
      engine: slot.engine,
      runner_pid: slot.runner_pid,
      cli_pid: slot.cli_pid,
      session_id: slot.session_id,
      message: `Active worker uses legacy engine "${slot.engine}", which does not support mid-turn steer/interrupt.`,
    };
  }

  const ctrl = readJsonSafe(slot.control_file);
  const pipePath = ctrl?.pipe || slot.control_pipe;
  const token = ctrl?.token;
  if (!pipePath || !token) {
    return {
      ok: false,
      action: normAction,
      error_kind: 'control_unavailable',
      message: 'Control pipe or auth token is missing; worker may be initializing or shutting down.',
    };
  }

  const cid = normAction === 'steer' ? (clientMessageId || `steer-${randomUUID()}`) : undefined;
  let resp;
  try {
    resp = await sendPipeCommand(pipePath, {
      token,
      action: normAction,
      message,
      reason,
      follow_up: followUp,
      client_message_id: cid,
    }, timeoutMs);
  } catch (err) {
    const latestStatus = slot.status_file ? readJsonSafe(slot.status_file) : null;
    if (latestStatus && latestStatus.state !== 'running') {
      return {
        ok: false,
        action: normAction,
        state: 'already_finished',
        error_kind: 'already_finished',
        session_id: latestStatus.session_id || slot.session_id,
        run_state: latestStatus.state,
        message: `Worker finished before control message was delivered (state="${latestStatus.state}").`,
      };
    }
    return {
      ok: false,
      action: normAction,
      state: 'unknown_ack',
      error_kind: 'control_io_error',
      client_message_id: cid || null,
      message: err?.message || String(err),
    };
  }

  if (resp.ok && waitAppliedMs > 0) {
    const deadline = Date.now() + waitAppliedMs;
    if (normAction === 'steer' && (resp.state === 'accepted' || resp.state === 'queued_until_turn_start') && cid) {
      while (Date.now() < deadline) {
        await sleep(150);
        try {
          const st = await sendPipeCommand(pipePath, { token, action: 'status' }, 3000);
          const ev = (st.control_events || []).find((x) => x.client_message_id === cid);
          if (ev?.state === 'applied_in_turn') {
            resp.state = 'applied_in_turn';
            resp.item_id = ev.item_id || null;
            if (ev.turn_id) resp.turn_id = ev.turn_id;
            break;
          }
          if (ev?.state === 'accepted' && resp.state === 'queued_until_turn_start') {
            resp.state = 'accepted';
            if (ev.turn_id) resp.turn_id = ev.turn_id;
          }
        } catch {
          break;
        }
      }
    } else if (normAction === 'interrupt' && (resp.state === 'interrupting' || resp.state === 'restarting' || resp.state === 'stopping_on_start')) {
      const targetTid = resp.turn_id;
      while (Date.now() < deadline) {
        await sleep(150);
        const latestStatus = slot.status_file ? readJsonSafe(slot.status_file) : null;
        if (!followUp && latestStatus && latestStatus.state === 'stopped') {
          resp.state = 'interrupted';
          break;
        }
        if (followUp && latestStatus && latestStatus.active_turn_id && latestStatus.active_turn_id !== targetTid) {
          resp.state = 'restarted';
          resp.new_turn_id = latestStatus.active_turn_id;
          break;
        }
      }
    }
  }

  return {
    ...resp,
    attempt_id: slot.attempt_id,
    session_id: resp.session_id || slot.session_id,
    run_dir: slot.run_dir,
  };
}

async function runCli() {
  const chunks = [];
  if (!process.stdin.isTTY) {
    for await (const c of process.stdin) chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const payload = raw ? JSON.parse(raw) : {};
  const result = await sendControl(payload);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  runCli().catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error_kind: err?.error_kind || 'control_error', message: err.message })}\n`);
    process.exit(1);
  });
}
