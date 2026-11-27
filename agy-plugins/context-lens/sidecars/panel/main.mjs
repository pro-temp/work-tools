import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { getReport, InputError } from './parser.mjs';
import { buildHandoff, exportHandoff } from './handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function appDataDir() {
  for (let dir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR; dir && dir !== dirname(dir); dir = dirname(dir)) {
    if (basename(dir) === 'sidecar_data') return dirname(dir);
  }
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'), 'antigravity');
}
const root = appDataDir();
const app = new SidecarApp();
const tokenConfigured = Boolean((process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim());
const headers = { 'Cache-Control': 'no-store' };

function asset(name, type) {
  return () => new Response(readFileSync(join(here, name), 'utf8'), { contentType: type + '; charset=utf-8', headers });
}
app.page('/', asset('index.html', 'text/html'));
app.api('/styles.css', asset('styles.css', 'text/css'), 'GET');
app.api('/app.js', asset('app.js', 'application/javascript'), 'GET');

function requireTokenConfigured(handler) {
  return data => {
    if (!tokenConfigured) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Sidecar UI token is not configured.' }), {
        status: 401, contentType: 'application/json', headers,
      });
    }
    try { return handler(root, data.conversationId, data); }
    catch (error) {
      if (!(error instanceof InputError)) throw error;
      return new Response(JSON.stringify({ error: error.message }), { status: error.status, contentType: 'application/json', headers });
    }
  };
}
app.api('/api/report', requireTokenConfigured(getReport), 'POST');
app.api('/api/handoff', requireTokenConfigured(buildHandoff), 'POST');
app.api('/api/handoff/export', requireTokenConfigured(exportHandoff), 'POST');
app.run();

