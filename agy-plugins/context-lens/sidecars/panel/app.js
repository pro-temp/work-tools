'use strict';

const $ = id => document.getElementById(id);
const dialog = $('handoff-dialog');
const colors = { system: '#94a3b8', user: '#60a5fa', agent: '#34d399', tool: '#fbbf24', custom: '#c084fc', system_messages: '#f87171' };
const childLabels = {
  system_prompt: '系统提示词', system_tools: '系统工具', system_overhead: '系统开销',
  rules: '规则', skills: '技能', subagents: '子代理', legacy_workflows: '旧版工作流',
  workflows: '工作流', plugins: '插件', mcp_tools: 'MCP 工具',
};
const groups = [
  ['artifact_files', '产物文件'], ['knowledge_files', '知识文件'], ['skill_files', '已加载技能'], ['system_files', '自动加载配置'],
];
const nodes = new Map(), folders = new Map();
let report, workspace = '', signature = '', inFlight = false, pendingRefresh = false;
let hover = '', focus = '', locked = '';
let currentDoc, previewRequest, toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function short(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
const number = new Intl.NumberFormat('zh-CN');
const pct = n => n.toFixed(1) + '%';
const capped = n => Math.max(0, Math.min(100, n)) + '%';

function notify(message) {
  if (dialog.open) { $('feedback').textContent = message; return; }
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 3500);
}

async function post(endpoint, data, signal) {
  const response = await window.sidecar.fetch('/api/' + endpoint, {
    method: 'POST', body: JSON.stringify({ conversationId: window.sidecar.conversationId, workspace, ...data }), signal,
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message || body.error);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    // Embedded panes may deny the async Clipboard API. The selection must be inside an open modal.
    const previous = document.activeElement;
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0';
    (dialog.open ? dialog : document.body).append(area);
    try {
      area.select();
      if (!document.execCommand('copy')) throw new Error('复制未获授权，可在预览中选择文字复制。');
    } finally {
      area.remove();
      previous?.focus({ preventScroll: true });
    }
  }
  notify(message);
}

async function openFile(uri, path) {
  if (uri && window.parent !== window && window.sidecar?.ui?.toggleAuxPane) {
    try {
      await window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      return true;
    } catch { /* A rejected host request falls through to the same path-copy action. */ }
  }
  await copy(path, '已复制路径');
  return false;
}

function action(button, fn) {
  button.addEventListener('click', () => Promise.resolve().then(fn).catch(error => notify(error.message)));
}

function highlight() {
  const key = locked || hover || focus;
  const part = report.ring_segments.find(s => s.key === key);
  for (const [id, { arc, row }] of nodes) {
    for (const node of [arc, row]) {
      node.classList.toggle('active', id === key);
      node.setAttribute('aria-pressed', String(locked === id));
    }
    arc.classList.toggle('dimmed', Boolean(part && id !== key));
  }
  const limit = report.limit_tokens;
  $('dial-label').textContent = part ? part.label : '原生窗口';
  $('dial-value').textContent = part ? short(part.tokens) : limit ? pct(report.used_pct) : '—';
  $('dial-detail').textContent = part ? (limit ? '占窗口 ' + pct(part.pct) : '窗口未知') : short(report.used_tokens) + ' / ' + (limit ? short(limit) : '未知');
  $('state').textContent = report.compacted ? '压缩后估算' : report.has_breakdown ? '实时精确' : '待生成估算';
}

function bindSegment(node, key) {
  node.addEventListener('pointerenter', () => { hover = key; highlight(); });
  node.addEventListener('pointerleave', () => { hover = ''; highlight(); });
  node.addEventListener('focus', () => { focus = node.matches(':focus-visible') ? key : ''; highlight(); });
  node.addEventListener('blur', () => { focus = ''; highlight(); });
  node.addEventListener('click', () => { locked = locked === key ? '' : key; highlight(); });
}

function makeSegment(key, label) {
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [attr, value] of Object.entries({ cx: 110, cy: 110, r: 88, pathLength: 100, role: 'button', class: 'arc' })) arc.setAttribute(attr, value);
  arc.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); arc.dispatchEvent(new MouseEvent('click')); }
  });
  $('arcs').append(arc);
  const row = element('button', 'segment', '');
  const bar = element('span', 'row-meter', '');
  const fill = element('i', '', '');
  const count = element('span', 'tokens', '');
  const share = element('span', 'pct', '');
  bar.append(fill);
  row.append(element('i', 'dot', ''), element('span', '', label), bar, count, share);
  $(['user', 'agent', 'tool'].includes(key) ? 'chat-rows' : 'system-rows').append(row);
  const childList = key === 'system' || key === 'custom' ? element('ul', 'segment-children', '') : null;
  if (childList) {
    childList.setAttribute('aria-label', label + '子分类');
    row.after(childList);
  }
  for (const node of [row, arc]) {
    node.style.setProperty('--swatch', colors[key]);
    bindSegment(node, key);
  }
  const item = { arc, row, fill, count, share, childList };
  nodes.set(key, item);
  return item;
}

function renderRing(r) {
  const known = r.limit_tokens > 0;
  // Preserve small hit targets. Scale the drawing at saturation, retaining true percentages in the labels.
  const widths = r.ring_segments.map(s => known && s.tokens > 0 ? Math.max(1.15, s.pct) : 0);
  const scale = Math.min(1, 100 / (widths.reduce((sum, n) => sum + n, 0) || 1));
  let offset = 0;
  r.ring_segments.forEach((s, i) => {
    const { arc, row, count, share, fill, childList } = nodes.get(s.key) ?? makeSegment(s.key, s.label);
    const width = widths[i] * scale;
    const gap = Math.min(width * .25, .45);
    arc.style.display = width ? '' : 'none';
    arc.setAttribute('tabindex', width ? '0' : '-1');
    arc.setAttribute('stroke-dasharray', `${width - gap} ${100 - width + gap}`);
    arc.setAttribute('stroke-dashoffset', String(-offset - gap / 2));
    offset += width;
    const exact = number.format(s.tokens) + ' Token';
    const percent = known ? pct(s.pct) : '—';
    row.title = [exact, ...s.children.filter(c => c.key !== s.key).map(c => c.name + ' · ' + number.format(c.tokens))].join('\n');
    for (const node of [row, arc]) node.setAttribute('aria-label', `${s.label}，${exact}，${percent}`);
    count.textContent = short(s.tokens);
    share.textContent = percent;
    fill.style.width = capped(s.pct);
    if (childList) {
      childList.replaceChildren(...s.children.filter(c => c.tokens !== 0).map(c => {
        const li = document.createElement('li');
        li.append(element('span', '', childLabels[c.key]), element('span', 'tokens', number.format(c.tokens)),
          element('span', 'pct', known ? pct(c.pct) : '—'));
        return li;
      }));
    }
  });
  const showBudget = r.request_budget_tokens > 0 && r.request_budget_tokens < r.limit_tokens;
  $('budget').hidden = !showBudget;
  $('marker').setAttribute('visibility', showBudget ? 'visible' : 'hidden');
  if (showBudget) {
    $('marker').setAttribute('transform', `rotate(${360 * r.request_budget_tokens / r.limit_tokens} 110 110)`);
    $('budget').className = 'budget' + (r.budget_pct >= 90 ? ' danger' : r.budget_pct >= 75 ? ' warn' : '');
    $('budget-pct').textContent = pct(r.budget_pct);
    $('budget-fill').style.width = capped(r.budget_pct);
    $('budget-count').textContent = number.format(r.used_tokens) + ' / ' + number.format(r.request_budget_tokens) + ' Token';
  }
  highlight();
}

function renderFiles(r) {
  for (const [key, label] of groups) {
    let folder = folders.get(key);
    if (!folder) {
      const details = document.createElement('details');
      const summary = element('summary', '', label);
      const count = element('span', 'count', '');
      summary.append(count);
      const list = element('div', '', '');
      details.append(summary, list);
      $('file-groups').append(details);
      folder = { count, list, signature: '' };
      folders.set(key, folder);
    }
    const files = r[key], sig = JSON.stringify(files);
    if (sig === folder.signature) continue;
    folder.signature = sig;
    folder.count.textContent = number.format(files.length);
    const entries = files.map(file => {
      const line = element('div', 'file-line', '');
      const button = element('button', 'file', file.path);
      const path = file.fullPath || file.path;
      button.title = (file.fileUri ? '在侧栏打开 · ' : '复制路径 · ') + path;
      if (file.tokens) button.append(element('small', '', number.format(file.tokens) + ' Token'));
      action(button, () => openFile(file.fileUri, path));
      line.append(button);
      if (file.fileUri) {
        const copyPath = element('button', 'copy-path', '复制');
        copyPath.setAttribute('aria-label', '复制路径 ' + file.path);
        action(copyPath, () => copy(path, '已复制路径'));
        line.append(copyPath);
      }
      return line;
    });
    folder.list.replaceChildren(...(entries.length ? entries : [element('p', 'file-empty', '暂无记录')]));
  }
}

function render(r) {
  report = r;
  $('report').hidden = false;
  $('model').textContent = $('model').title = r.model;
  for (const id of ['handoff', 'quick-copy', 'copy-cli']) $(id).disabled = false;
  renderRing(r);
  $('free').textContent = r.limit_tokens ? short(r.free_tokens) + ' · ' + pct(r.free_tokens / r.limit_tokens * 100) : '窗口未知';
  $('buffer-row').hidden = !r.checkpoint_buffer;
  $('buffer').textContent = number.format(r.checkpoint_buffer);
  const ck = r.checkpoint_view;
  $('checkpoint').hidden = !ck;
  if (ck) {
    $('checkpoint-name').textContent = '检查点 ' + ck.active_number;
    $('checkpoint-intent').textContent = ck.active_text;
    $('checkpoint-history').textContent = `历史已摘要 ${ck.historical} 个`;
  }
  renderFiles(r);
}

async function refresh() {
  if (document.hidden || !window.sidecar?.conversationId) return;
  if (inFlight) {
    pendingRefresh = true;
    return;
  }
  const requestedWorkspace = workspace;
  inFlight = true;
  try {
    const r = await post('report');
    if (workspace !== requestedWorkspace) return;
    $('live').classList.add('on');
    $('live').title = '已连接本地会话';
    $('notice').hidden = !r.summary_warning;
    if (r.summary_warning) $('notice').textContent = '摘要库读取失败：' + r.summary_warning;
    const next = JSON.stringify(r);
    if (signature !== next) { render(r); signature = next; }
  } catch (error) {
    if (workspace !== requestedWorkspace) return;
    $('live').classList.remove('on');
    $('live').title = '读取失败';
    $('notice').hidden = false;
    $('notice').textContent = error.message;
  } finally {
    inFlight = false;
    if (pendingRefresh || workspace !== requestedWorkspace) {
      pendingRefresh = false;
      refresh();
    }
  }
}

function docButtons(enabled) {
  for (const id of ['copy-md', 'download', 'save']) $(id).disabled = !enabled;
}
async function preview(message = '') {
  previewRequest?.abort();
  const controller = new AbortController();
  previewRequest = controller;
  currentDoc = null;
  docButtons(false);
  $('metrics').replaceChildren();
  $('feedback').textContent = '';
  $('preview').textContent = '正在生成交接文档…';
  try {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const doc = await post('handoff', { mode }, controller.signal);
    if (controller.signal.aborted) return;
    currentDoc = doc;
    $('preview').textContent = doc.markdown;
    $('preview').scrollTop = 0;
    const s = doc.stats;
    $('metrics').replaceChildren(...[
      number.format(s.characters) + ' 字符', '约 ' + number.format(s.estimatedTokens) + ' Token',
      `${s.turns}/${s.totalTurns} 轮`, s.files + ' 个改动文件', s.artifacts + ' 个产物',
    ].map(t => element('span', '', t)));
    docButtons(true);
    $('feedback').textContent = message;
  } catch (error) {
    if (!controller.signal.aborted) $('preview').textContent = error.message;
  }
}

function copyDoc(doc) {
  return copy(doc.markdown, `已复制 ${number.format(doc.stats.characters)} 字符 · 约 ${number.format(doc.stats.estimatedTokens)} Token`);
}

async function save(target) {
  const doc = currentDoc;
  docButtons(false);
  try {
    const result = await post('handoff/export', { mode: doc.mode, target, expectedMarkdown: doc.markdown });
    const copiedPath = target === 'brain' && !await openFile(result.fileUri, result.path);
    notify((copiedPath ? '已保存并复制路径 · ' : '已保存 · ') + result.path);
  } catch (error) {
    if (error.status === 409 && dialog.open && currentDoc === doc) await preview(error.message);
    else notify(error.message);
  } finally { if (currentDoc === doc) docButtons(true); }
}

action($('handoff'), () => {
  dialog.showModal();
  return preview();
});
action($('close'), () => dialog.close());
dialog.addEventListener('close', () => { previewRequest?.abort(); currentDoc = null; });
document.querySelector('.modes').addEventListener('change', () => preview());
action($('quick-copy'), async () => copyDoc(await post('handoff', { mode: 'compact' })));
action($('copy-md'), () => copyDoc(currentDoc));
action($('download'), () => save('downloads'));
action($('save'), () => save('brain'));
action($('copy-cli'), () => { $('menu').hidePopover(); return copy(report.text, '已复制 CLI 文本报告'); });
action($('refresh'), () => { $('menu').hidePopover(); return refresh(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && locked && !dialog.open) { locked = ''; highlight(); }
});

async function start() {
  const uris = await window.sidecar.getWorkspaceUris?.();
  workspace = uris?.[0] ?? '';
  window.sidecar.onWorkspaceChange(([first = '']) => {
    if (first === workspace) return;
    workspace = first;
    refresh();
  });
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 3000);
  refresh();
}

if (window.sidecar?.conversationId) start();
else {
  $('notice').textContent = '请在 Antigravity 的会话侧栏中打开 Context Lens。';
}

