import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  UUID_RE,
  discoverRuns,
  findAppDataDir,
  findConfirmedSessionInRegistry,
  getRegisteredRun,
  readRawFile,
  readRunDetail,
} from './parser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = findAppDataDir();
const HAS_UI_TOKEN = Boolean((process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim());

const app = new SidecarApp();

const NO_STORE = { 'Cache-Control': 'no-store' };

app.page('/', () => new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), { contentType: 'text/html; charset=utf-8', headers: NO_STORE }));

app.api('/styles.css', () => new Response(readFileSync(join(HERE, 'styles.css'), 'utf8'), { contentType: 'text/css; charset=utf-8', headers: NO_STORE }), 'GET');
app.api('/app.js', () => new Response(readFileSync(join(HERE, 'app.js'), 'utf8'), { contentType: 'application/javascript; charset=utf-8', headers: NO_STORE }), 'GET');

function extractWorkspaces(data) {
  if (Array.isArray(data.workspaces)) return data.workspaces;
  if (data.workspace) return [data.workspace];
  return [];
}

function requireTokenConfigured(handler) {
  return async (data) => {
    // sidecar_sdk skips token checks when ANTIGRAVITY_SIDECAR_UI_TOKEN is unset; refuse sensitive routes in that case.
    if (!HAS_UI_TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Sidecar UI token is not configured.' }), {
        status: 401,
        contentType: 'application/json',
      });
    }
    return handler(data);
  };
}

// All data/action APIs use POST so sidecar_sdk enforces x-sidecar-token authentication.
app.api('/api/runs', requireTokenConfigured((data) => {
  try {
    return discoverRuns(APP_DATA_DIR, data.conversationId || '', extractWorkspaces(data));
  } catch (err) {
    return { error: 'discover-failed', message: err.message, runs: [] };
  }
}), 'POST');

app.api('/api/run', requireTokenConfigured(async (data) => {
  try {
    let entry = getRegisteredRun(data.id || '');
    if (!entry) {
      discoverRuns(APP_DATA_DIR, data.conversationId || '', extractWorkspaces(data));
      entry = getRegisteredRun(data.id || '');
    }
    return await readRunDetail(entry, data.etag || '');
  } catch (err) {
    return { error: 'read-failed', message: err.message };
  }
}), 'POST');

app.api('/api/raw', requireTokenConfigured(async (data) => {
  try {
    let entry = getRegisteredRun(data.runId || '');
    if (!entry) {
      discoverRuns(APP_DATA_DIR, data.conversationId || '', extractWorkspaces(data));
      entry = getRegisteredRun(data.runId || '');
    }
    return await readRawFile(entry, data.turnId || '', data.kind || '', Number(data.offset) || 0, Number(data.limit) || undefined);
  } catch (err) {
    return { error: 'raw-failed', message: err.message };
  }
}), 'POST');

function openCodexUri(sessionId) {
  return new Promise((resolvePromise) => {
    const uri = `codex://threads/${sessionId}`;
    const cmd = process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', uri]]
      : process.platform === 'darwin'
        ? ['open', [uri]]
        : ['xdg-open', [uri]];
    execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 5000 }, (err) => {
      resolvePromise(err ? { ok: false, error: err.message, uri } : { ok: true, uri });
    });
  });
}

app.api('/api/open-codex', requireTokenConfigured(async (data) => {
  const sid = String(data.sessionId || '').trim().toLowerCase();
  if (!UUID_RE.test(sid)) {
    return { ok: false, error: 'invalid-session-id' };
  }
  let match = findConfirmedSessionInRegistry(sid);
  if (!match) {
    discoverRuns(APP_DATA_DIR, data.conversationId || '', extractWorkspaces(data));
    match = findConfirmedSessionInRegistry(sid);
  }
  if (!match) {
    return { ok: false, error: 'unknown-session' };
  }
  return openCodexUri(sid);
}), 'POST');

app.run();
