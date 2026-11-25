(() => {
  const FAST_POLL_MS = 1500;
  const IDLE_POLL_MS = 3500;
  const RAW_PAGE_BYTES = 512 * 1024;
  const params = new URLSearchParams(location.search);
  const conversationId = (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';
  const doFetch = (window.sidecar && window.sidecar.fetch) ? window.sidecar.fetch.bind(window.sidecar) : fetch.bind(window);

  const elApp = document.getElementById('app');
  const elSelect = document.getElementById('run-select');
  const elLiveDot = document.getElementById('live-dot');
  const elBtnOpenCodex = document.getElementById('btn-open-codex');
  const elBtnCopyLink = document.getElementById('btn-copy-link');
  const elMenu = document.getElementById('viewer-menu');
  const elOptMessagesOnly = document.getElementById('opt-messages-only');
  const elOptAutoFollow = document.getElementById('opt-autofollow');
  const elOptShowEcho = document.getElementById('opt-show-echo');
  const elRawDialog = document.getElementById('raw-dialog');
  const elRawTitle = document.getElementById('raw-dialog-title');
  const elRawSub = document.getElementById('raw-dialog-sub');
  const elRawContent = document.getElementById('raw-content');
  const elRawLoadMore = document.getElementById('raw-load-more');
  const elToast = document.getElementById('toast');

  let workspaces = [];
  let runsList = [];
  let lastSelectSig = '';
  let selectedRunId = '';
  let userPickedRun = false;
  let currentDetail = null;
  let currentEtag = '';
  let renderedRunId = '';
  let renderedHeaderSig = '';
  const renderedTurnSigs = new Map(); // turnId -> signature string

  let pollTimer = null;
  let toastTimer = null;
  let inFlight = false;
  let pendingPoll = false;
  let pollGen = 0;

  // Raw dialog state with generation counter to discard late responses
  let rawGen = 0;
  let rawState = { runId: '', turnId: '', kind: '', content: '', nextOffset: 0, totalBytes: 0, hasMore: false, truncated: false, path: '', filename: '', decompressed: false };

  // Scoped by `${runId}:${turnId}:...` so different runs never inherit each other's collapse state
  const openState = new Map();
  let suppressToggle = false;

  // Store verbatim copy strings per turn in memory instead of duplicating huge text into HTML attributes
  const copyPayloadsByTurn = new Map(); // turnId -> Map(key -> string)
  let copySeq = 0;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

  function registerCopy(turnId, text) {
    let bucket = copyPayloadsByTurn.get(turnId);
    if (!bucket) {
      bucket = new Map();
      copyPayloadsByTurn.set(turnId, bucket);
    }
    const key = `cp${++copySeq}`;
    bucket.set(key, String(text ?? ''));
    return key;
  }

  function lookupCopy(key) {
    for (const bucket of copyPayloadsByTurn.values()) {
      if (bucket.has(key)) return bucket.get(key);
    }
    return undefined;
  }

  async function apiPost(path, payload) {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function showToast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove('show'), 2000);
  }

  async function copyText(text, label = '已复制') {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(label);
  }

  function openWorkspaceFile(fileUri, fallbackPath) {
    if (fileUri && window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fileUri });
    } else {
      copyText(fallbackPath || fileUri, '已复制文件路径');
    }
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(iso)}`;
  }

  function fmtDuration(startIso, endIso) {
    const s = Date.parse(startIso || '');
    if (!s) return '';
    const e = Date.parse(endIso || '') || Date.now();
    const sec = Math.max(0, Math.round((e - s) / 1000));
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }

  function fmtTokens(usage) {
    if (!usage) return '';
    const parts = [];
    if (usage.input_tokens != null) parts.push(`入 ${usage.input_tokens.toLocaleString()}`);
    if (usage.cached_input_tokens) parts.push(`缓存 ${usage.cached_input_tokens.toLocaleString()}`);
    if (usage.output_tokens != null) parts.push(`出 ${usage.output_tokens.toLocaleString()}`);
    return parts.join(' · ');
  }

  function stateLabel(st) {
    const map = {
      running: ['运行中', 'running'],
      finished: ['已完成', 'ok'],
      failed: ['失败', 'err'],
      stopped: ['已中止', 'warn'],
      interrupted: ['已中断', 'warn'],
    };
    return map[st] || [st || '未知', ''];
  }

  function handoffStatusLabel(st) {
    const map = {
      done: ['done · 已交付', 'ok'],
      needs_input: ['needs_input · 需确认', 'warn'],
      needs_permission: ['needs_permission · 需授权', 'warn'],
    };
    return map[st] || [st || '未知', ''];
  }

  function modeLabel(turn) {
    if (turn.source === 'codex_desktop') return 'Codex 桌面端续聊';
    if (turn.source === 'rollout_archive') return '归档会话（Rollout）';
    return turn.mode === 'resume' ? '原会话续跑 / 打回' : '首轮派单';
  }

  function openAttr(key, defaultOpen) {
    const open = openState.has(key) ? openState.get(key) : defaultOpen;
    return open ? ' open' : '';
  }

  function renderSelect() {
    const sig = `${selectedRunId}|${runsList.map((r) => `${r.id}:${r.scope}:${r.effectiveState}:${r.title}:${r.taskKind}:${r.updatedAt}`).join(';')}`;
    if (sig === lastSelectSig) return;
    lastSelectSig = sig;

    if (!runsList.length) {
      elSelect.innerHTML = '<option value="">暂无 codex-loop 派单记录</option>';
      elSelect.disabled = true;
      return;
    }
    elSelect.disabled = false;
    const groups = [
      { key: 'conversation', label: '当前对话' },
      { key: 'workspace', label: '当前工作区' },
      { key: 'other', label: '其他历史派单' },
    ];
    let html = '';
    for (const g of groups) {
      const items = runsList.filter((r) => r.scope === g.key);
      if (!items.length) continue;
      html += `<optgroup label="${esc(g.label)}">`;
      for (const r of items) {
        const prefix = r.effectiveState === 'running' ? '● ' : '';
        const t = fmtDateTime(r.updatedAt);
        const label = `${prefix}${r.title} (${r.taskKind}${t ? ` · ${t}` : ''})`;
        const sel = r.id === selectedRunId ? ' selected' : '';
        html += `<option value="${esc(r.id)}"${sel}>${esc(label)}</option>`;
      }
      html += '</optgroup>';
    }
    elSelect.innerHTML = html;
    if (selectedRunId) elSelect.value = selectedRunId;
  }

  function updateTopBar(run) {
    if (!run) {
      elLiveDot.className = 'live-dot';
      elLiveDot.title = '暂无派单';
      elBtnOpenCodex.disabled = true;
      elBtnCopyLink.disabled = true;
      return;
    }
    const dotCls =
      run.effectiveState === 'running' ? 'running' :
      run.effectiveState === 'finished' ? 'finished' :
      run.effectiveState === 'failed' ? 'failed' : 'warn';
    elLiveDot.className = `live-dot ${dotCls}`;
    elLiveDot.title = stateLabel(run.effectiveState)[0];

    const hasSession = Boolean(run.sessionId && run.desktopUrl);
    elBtnOpenCodex.disabled = !hasSession;
    elBtnCopyLink.disabled = !hasSession;
  }

  function renderStreamItem(runId, turn, item, idx) {
    const key = `${runId}:${turn.turnId}:item:${item.id || idx}`;

    if (item.kind === 'reasoning') {
      return `
        <details class="stream-item reasoning" data-key="${esc(key)}"${openAttr(key, false)}>
          <summary>
            <span class="summary-label">思考摘要</span>
            <span class="summary-meta">${esc(item.text.length)} 字</span>
          </summary>
          <div class="item-body">
            <pre class="verbatim prose compact" data-scroll-key="${esc(key)}:txt">${esc(item.text)}</pre>
          </div>
        </details>`;
    }

    if (item.kind === 'agent_message') {
      if (item.isHandoffEcho && !elOptShowEcho.checked) {
        return `
          <details class="stream-item agent-msg" data-key="${esc(key)}"${openAttr(key, false)}>
            <summary>
              <span class="summary-label">Codex 最终回执原文（JSON，与下方结构化回执一致）</span>
              <span class="summary-meta">${esc(item.text.length)} 字</span>
            </summary>
            <div class="item-body">
              <pre class="code-box" data-scroll-key="${esc(key)}:echo">${esc(item.text)}</pre>
            </div>
          </details>`;
      }
      const copyKey = registerCopy(turn.turnId, item.text);
      return `
        <div class="block codex">
          <div class="block-head">
            <span class="block-title">Codex 消息</span>
            <button type="button" class="btn xs" data-copy-key="${esc(copyKey)}">复制</button>
          </div>
          <pre class="verbatim prose">${esc(item.text)}</pre>
        </div>`;
    }

    if (item.kind === 'command') {
      const exitCls = item.status === 'in_progress' ? 'running' : (item.exitCode === 0 ? 'ok' : (item.exitCode != null ? 'err' : ''));
      const exitText = item.status === 'in_progress' ? '运行中' : (item.exitCode != null ? `exit ${item.exitCode}` : item.status);
      return `
        <details class="stream-item" data-key="${esc(key)}"${openAttr(key, false)}>
          <summary>
            <span class="summary-label summary-code">${esc(item.command || '(空命令)')}</span>
            <span class="summary-meta"><span class="pill ${exitCls}">${esc(exitText)}</span></span>
          </summary>
          <div class="item-body">
            <div class="sub-label">命令</div>
            <pre class="code-box">${esc(item.command)}</pre>
            <div class="sub-label">输出${item.outputTruncated ? `（展示前 200K 字符，完整 ${item.outputFullChars.toLocaleString()} 字符可点顶栏 Events 原文）` : ''}</div>
            <pre class="code-box" data-scroll-key="${esc(key)}:out">${esc(item.output || '(无输出)')}</pre>
          </div>
        </details>`;
    }

    if (item.kind === 'mcp_tool') {
      const label = [item.server, item.tool].filter(Boolean).join('.') || 'MCP 工具';
      const stCls = item.status === 'in_progress' ? 'running' : (item.errorText ? 'err' : 'ok');
      return `
        <details class="stream-item" data-key="${esc(key)}"${openAttr(key, false)}>
          <summary>
            <span class="summary-label summary-code">${esc(label)}</span>
            <span class="summary-meta"><span class="pill ${stCls}">${esc(item.status)}</span></span>
          </summary>
          <div class="item-body">
            <div class="sub-label">参数</div>
            <pre class="code-box">${esc(item.argumentsText || '{}')}</pre>
            ${item.errorText ? `<div class="sub-label">错误</div><pre class="code-box">${esc(item.errorText)}</pre>` : ''}
            ${item.resultText ? `<div class="sub-label">结果${item.resultTruncated ? '（已截断，完整见 Events 原文）' : ''}</div><pre class="code-box" data-scroll-key="${esc(key)}:res">${esc(item.resultText)}</pre>` : ''}
          </div>
        </details>`;
    }

    if (item.kind === 'tool_call') {
      return `
        <details class="stream-item" data-key="${esc(key)}"${openAttr(key, false)}>
          <summary>
            <span class="summary-label summary-code">${esc(item.name)}</span>
            <span class="summary-meta"><span class="pill">${esc(item.status)}</span></span>
          </summary>
          <div class="item-body">
            ${item.argumentsText ? `<div class="sub-label">入参</div><pre class="code-box">${esc(item.argumentsText)}</pre>` : ''}
            ${item.outputText ? `<div class="sub-label">输出${item.outputTruncated ? '（已截断，完整见 Rollout 原文）' : ''}</div><pre class="code-box" data-scroll-key="${esc(key)}:out">${esc(item.outputText)}</pre>` : ''}
          </div>
        </details>`;
    }

    if (item.kind === 'file_change') {
      const changes = item.changes || [];
      return `
        <details class="stream-item" data-key="${esc(key)}"${openAttr(key, false)}>
          <summary>
            <span class="summary-label">文件变更（${changes.length}）</span>
            <span class="summary-meta"><span class="pill ok">${esc(item.status)}</span></span>
          </summary>
          <div class="item-body">
            ${changes.map((c) => `
              <div>
                <span class="pill">${esc(c.kind || 'edit')}</span>
                <button type="button" class="file-link" data-file-uri="${esc(c.fileUri || '')}" data-file-path="${esc(c.path)}">${esc(c.path)}</button>
              </div>`).join('')}
          </div>
        </details>`;
    }

    if (item.kind === 'web_search') {
      return `
        <div class="stream-item">
          <div class="block-head">
            <span class="block-title">Web 搜索</span>
            <span class="mono">${esc(item.query)}</span>
          </div>
        </div>`;
    }

    if (item.kind === 'user_message') {
      const copyKey = registerCopy(turn.turnId, item.text);
      return `
        <div class="block agy">
          <div class="block-head">
            <span class="block-title">轮内追加指令</span>
            <button type="button" class="btn xs" data-copy-key="${esc(copyKey)}">复制</button>
          </div>
          <pre class="verbatim prose">${esc(item.text)}</pre>
        </div>`;
    }

    if (item.kind === 'error') {
      return `
        <div class="block danger">
          <div class="block-head"><span class="block-title">错误事件</span></div>
          <pre class="verbatim compact">${esc(item.message)}</pre>
        </div>`;
    }

    return `
      <details class="stream-item" data-key="${esc(key)}"${openAttr(key, false)}>
        <summary>
          <span class="summary-label summary-code">事件：${esc(item.itemType || item.kind)}</span>
          <span class="summary-meta"><span class="pill">${esc(item.status || '')}</span></span>
        </summary>
        <div class="item-body"><pre class="code-box">${esc(item.rawText || JSON.stringify(item, null, 2))}</pre></div>
      </details>`;
  }

  function renderHandoff(runId, turn) {
    const h = turn.handoff;
    if (!h) return '';
    const [stText, stCls] = handoffStatusLabel(h.status);

    const changedFilesHtml = Array.isArray(h.changed_files) && h.changed_files.length ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">改动文件（${h.changed_files.length}）</div>
        ${h.changed_files.map((f) => `
          <div class="handoff-card">
            <button type="button" class="file-link" data-file-uri="${esc(f.fileUri || '')}" data-file-path="${esc(f.path)}">${esc(f.path)}</button>
            <div class="dim">${esc(f.change)}</div>
          </div>`).join('')}
      </div>` : '';

    const guardsHtml = Array.isArray(h.guards_and_fallbacks) && h.guards_and_fallbacks.length ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">防御与兜底自报（${h.guards_and_fallbacks.length}）</div>
        ${h.guards_and_fallbacks.map((g) => `
          <div class="handoff-card">
            <div class="mono">${esc(g.location)}</div>
            <div>${esc(g.guard)}</div>
            <div class="dim">证据：${esc(g.evidence)}</div>
          </div>`).join('')}
      </div>` : '';

    const verifHtml = Array.isArray(h.verification) && h.verification.length ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">实测命令（${h.verification.length}）</div>
        ${h.verification.map((v) => `
          <div class="handoff-card">
            <div class="meta-row">
              <span class="pill ${v.exit_code === 0 ? 'ok' : 'err'}">exit ${esc(v.exit_code)}</span>
              <span class="mono">${esc(v.command)}</span>
            </div>
            <div class="dim">${esc(v.result)}</div>
          </div>`).join('')}
      </div>` : '';

    const concernsHtml = Array.isArray(h.design_concerns) && h.design_concerns.length ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">审查发现 / 设计隐患（${h.design_concerns.length}）</div>
        ${h.design_concerns.map((c) => {
          const isBlock = String(c.issue || '').includes('[BLOCKING]');
          return `
            <div class="handoff-card">
              <div><span class="pill ${isBlock ? 'err' : 'warn'}">${isBlock ? 'BLOCKING' : 'NOTE'}</span> ${esc(c.issue)}</div>
              <div class="dim">证据：${esc(c.evidence)}</div>
              <div>建议：${esc(c.suggestion)}</div>
            </div>`;
        }).join('')}
      </div>` : '';

    const questionsHtml = Array.isArray(h.questions) && h.questions.length ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">待确认问题（${h.questions.length}）</div>
        ${h.questions.map((q) => `
          <div class="handoff-card">
            <div><strong>${esc(q.question)}</strong></div>
            <div class="dim">代码事实：${esc(q.facts_found)}</div>
            <div>推荐：${esc(q.recommended_option)}</div>
            ${Array.isArray(q.alternatives) && q.alternatives.length ? `<div class="dim">备选：${esc(q.alternatives.join(' / '))}</div>` : ''}
          </div>`).join('')}
      </div>` : '';

    const permHtml = h.permission_request ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">权限申请</div>
        <div class="handoff-card">
          <div><strong>${esc(h.permission_request.action)}</strong></div>
          <div class="mono">${esc((h.permission_request.commands_or_paths || []).join('\n'))}</div>
          <div class="dim">原因：${esc(h.permission_request.reason)} · 可逆：${h.permission_request.reversible ? '是' : '否'}</div>
        </div>
      </div>` : '';

    const listSec = (title, arr) => (Array.isArray(arr) && arr.length ? `
      <div class="handoff-section">
        <div class="handoff-sec-title">${esc(title)}</div>
        <ul class="handoff-list">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>` : '');

    return `
      <div class="block handoff">
        <div class="block-head">
          <span class="block-title">Codex → AGY 结构化回执 <span class="pill ${stCls}">${esc(stText)}</span></span>
          <div class="block-head-actions">
            <button type="button" class="btn xs" data-run-id="${esc(runId)}" data-raw-turn="${esc(turn.turnId)}" data-raw-kind="handoff">回执 JSON</button>
          </div>
        </div>
        <div class="handoff-body">
          <div class="handoff-section">
            <div class="handoff-sec-title">Summary</div>
            <pre class="verbatim prose" style="padding:0">${esc(h.summary || '')}</pre>
          </div>
          ${h.root_cause ? `<div class="handoff-section"><div class="handoff-sec-title">Root Cause</div><pre class="verbatim prose" style="padding:0">${esc(h.root_cause)}</pre></div>` : ''}
          ${changedFilesHtml}
          ${concernsHtml}
          ${guardsHtml}
          ${verifHtml}
          ${questionsHtml}
          ${permHtml}
          ${listSec('自主假设（assumptions）', h.assumptions)}
          ${listSec('未验证项（unverified_gaps）', h.unverified_gaps)}
        </div>
      </div>`;
  }

  function isDirectMessageItem(item) {
    if (item.kind === 'agent_message') return !item.isHandoffEcho || elOptShowEcho.checked;
    return item.kind === 'user_message' || item.kind === 'error';
  }

  function formatToolGroupSummary(items) {
    let cmds = 0;
    let tools = 0;
    let changes = 0;
    let searches = 0;
    let reasonings = 0;
    let others = 0;
    let running = false;
    for (const it of items) {
      if (it.status === 'in_progress') running = true;
      if (it.kind === 'command') cmds++;
      else if (it.kind === 'mcp_tool' || it.kind === 'tool_call') tools++;
      else if (it.kind === 'file_change') changes++;
      else if (it.kind === 'web_search') searches++;
      else if (it.kind === 'reasoning') reasonings++;
      else others++;
    }
    const parts = [];
    if (cmds) parts.push(`${cmds} 条命令`);
    if (tools) parts.push(`${tools} 次工具`);
    if (changes) parts.push(`${changes} 处文件变更`);
    if (searches) parts.push(`${searches} 次搜索`);
    if (reasonings) parts.push(`${reasonings} 条思考`);
    if (others) parts.push(`${others} 项其他过程`);
    return { text: parts.join(' · ') || `${items.length} 步`, running };
  }

  function renderTurnFlow(runId, turn) {
    const allItems = [
      ...(turn.reasonings || []).map((text, rIdx) => ({ kind: 'reasoning', id: `rollout-reason-${rIdx}`, status: 'completed', text })),
      ...(turn.items || []),
    ];

    if (allItems.length === 0) {
      return turn.effectiveState === 'running'
        ? '<div class="block codex"><div class="dim" style="padding:8px 10px">Codex 已启动，等待输出…</div></div>'
        : '';
    }

    const hideTools = elOptMessagesOnly.checked;
    const segments = [];
    let toolBuf = [];
    let groupIdx = 0;

    const flushTools = () => {
      if (!toolBuf.length) return;
      if (hideTools) {
        toolBuf = [];
        return;
      }
      const gKey = `${runId}:${turn.turnId}:tools:${groupIdx++}`;
      const info = formatToolGroupSummary(toolBuf.map((x) => x.item));
      const inner = toolBuf.map(({ item, origIdx }) => renderStreamItem(runId, turn, item, origIdx)).join('');
      segments.push(`
        <details class="tool-group" data-key="${esc(gKey)}"${openAttr(gKey, false)}>
          <summary>
            <span class="summary-label">工具调用与过程 · ${esc(info.text)}</span>
            <span class="summary-meta">${info.running ? '<span class="pill running">运行中</span>' : ''}</span>
          </summary>
          <div class="stream-list">${inner}</div>
        </details>`);
      toolBuf = [];
    };

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      if (isDirectMessageItem(item)) {
        flushTools();
        segments.push(renderStreamItem(runId, turn, item, i));
      } else {
        toolBuf.push({ item, origIdx: i });
      }
    }
    flushTools();

    if (!segments.length && hideTools && turn.effectiveState === 'running') {
      return '<div class="dim" style="padding:2px 4px">Codex 执行中（工具调用已隐藏）…</div>';
    }

    return segments.join('');
  }

  function renderTurnInner(run, turn) {
    const runId = run.id;
    const [stText, stCls] = stateLabel(turn.effectiveState);
    const dur = fmtDuration(turn.startedAt, turn.finishedAt);
    const tok = fmtTokens(turn.usage);
    const modelInfo = [turn.effective?.model, turn.effective?.effort, turn.requestedMode].filter(Boolean).join(' · ');

    const promptKey = `${runId}:${turn.turnId}:prompt`;

    const rawKindLabels = {
      prompt: 'Prompt',
      events: 'Events',
      handoff: 'Handoff',
      status: 'Status',
      stderr: 'Stderr',
      rollout: 'Rollout',
    };

    const rawButtons = (turn.rawFiles || []).map((k) =>
      `<button type="button" class="btn xs" data-run-id="${esc(runId)}" data-raw-turn="${esc(turn.turnId)}" data-raw-kind="${esc(k)}">${esc(rawKindLabels[k] || k)}</button>`
    ).join('');

    const sessionBtn = turn.sessionId && turn.sessionId !== run.sessionId
      ? `<button type="button" class="btn xs primary" data-open-codex="${esc(turn.sessionId)}">跳此会话</button>`
      : '';

    copyPayloadsByTurn.delete(turn.turnId);
    const promptCopyKey = turn.promptText ? registerCopy(turn.turnId, turn.promptText) : '';
    const promptHtml = turn.promptText ? `
      <div class="block agy">
        <details data-key="${esc(promptKey)}"${openAttr(promptKey, true)}>
          <summary>
            <span class="summary-label"><strong>AGY → Codex</strong> · 原样发送内容</span>
            <span class="summary-meta">${esc(turn.promptText.length)} 字</span>
          </summary>
          <div class="block-head" style="border-top:1px solid var(--line)">
            <span>来源：${esc(turn.promptSource)}</span>
            <button type="button" class="btn xs" data-copy-key="${esc(promptCopyKey)}">复制原文</button>
          </div>
          <pre class="verbatim" data-scroll-key="${esc(promptKey)}:pre">${esc(turn.promptText)}</pre>
        </details>
      </div>` : '';

    const streamHtml = renderTurnFlow(runId, turn);

    const errorsHtml = (turn.errors?.length || turn.stderr) ? `
      <div class="block danger">
        <div class="block-head">
          <span class="block-title">异常 / Stderr${turn.errorKind ? ` (${esc(turn.errorKind)})` : ''}</span>
          ${turn.rawFiles?.includes('stderr') ? `<button type="button" class="btn xs" data-run-id="${esc(runId)}" data-raw-turn="${esc(turn.turnId)}" data-raw-kind="stderr">完整 Stderr</button>` : ''}
        </div>
        ${turn.errors?.length ? `<pre class="verbatim compact">${esc(turn.errors.join('\n'))}</pre>` : ''}
        ${turn.stderr ? `<pre class="verbatim compact" style="border-top:1px solid var(--line)">${esc(turn.stderr)}</pre>` : ''}
      </div>` : '';

    return `
      <div class="turn-head">
        <div class="turn-head-left">
          <span>第 ${turn.turnNumber} 轮 · ${esc(modeLabel(turn))}</span>
          <span class="pill ${esc(turn.taskKind)}">${esc(turn.taskKind)}</span>
          <span class="pill ${stCls}">${esc(stText)}</span>
          ${dur ? `<span class="dim">${esc(dur)}</span>` : ''}
        </div>
        <div class="turn-head-right">
          ${sessionBtn}
          ${rawButtons}
        </div>
      </div>
      ${(modelInfo || tok || turn.startedAt) ? `
        <div class="meta-row" style="padding:5px 10px;border-bottom:1px solid var(--line)">
          ${turn.startedAt ? `<span>${esc(fmtTime(turn.startedAt))}</span>` : ''}
          ${modelInfo ? `<span>· ${esc(modelInfo)}</span>` : ''}
          ${tok ? `<span>· ${esc(tok)}</span>` : ''}
        </div>` : ''}
      <div class="turn-body">
        ${promptHtml}
        ${streamHtml}
        ${renderHandoff(runId, turn)}
        ${errorsHtml}
      </div>`;
  }

  function renderHeaderHtml(run, turnsCount) {
    const [stText, stCls] = stateLabel(run.effectiveState);
    const metaBadges = [
      `<span class="pill ${esc(run.taskKind)}">${esc(run.taskKind)}</span>`,
      `<span class="pill ${stCls}">${esc(stText)}</span>`,
      run.mode ? `<span class="pill">mode: ${esc(run.mode)}</span>` : '',
      run.model ? `<span class="pill">${esc(run.model)}${run.effort ? ` (${esc(run.effort)})` : ''}</span>` : '',
      run.rolloutOnly ? '<span class="pill warn">归档（读原生 rollout）</span>' : '',
    ].filter(Boolean).join('');

    return `
      <div class="run-header">
        <div class="run-title">${esc(run.title)}</div>
        <div class="meta-row">
          ${metaBadges}
          <span>· ${turnsCount} 轮</span>
          ${run.sessionId ? `<span class="mono">· ${esc(run.sessionId.slice(0, 8))}</span>` : ''}
        </div>
        ${run.workDir ? `<div class="meta-path">${esc(run.workDir)}</div>` : ''}
      </div>`;
  }

  function turnSignature(run, turn) {
    // Cover all rendered fields of this turn without depending on total turn count so adding a new turn never rebuilds earlier cards.
    return JSON.stringify({
      n: turn.turnNumber,
      src: turn.source,
      mode: turn.mode,
      tk: turn.taskKind,
      rm: turn.requestedMode,
      st: turn.effectiveState,
      start: turn.startedAt,
      fin: turn.finishedAt,
      eff: turn.effective,
      tok: turn.usage,
      ek: turn.errorKind,
      errs: turn.errors,
      ps: turn.promptSource,
      p: turn.promptText,
      items: turn.items,
      r: turn.reasonings,
      hr: turn.handoffRaw,
      h: turn.handoff,
      se: turn.stderr,
      rf: turn.rawFiles,
      sid: turn.sessionId,
      diffSid: Boolean(turn.sessionId && turn.sessionId !== run.sessionId),
      msgOnly: elOptMessagesOnly.checked,
      echo: elOptShowEcho.checked,
    });
  }

  function captureInnerScrolls(rootEl) {
    const map = new Map();
    for (const el of rootEl.querySelectorAll('[data-scroll-key]')) {
      if (el.scrollTop > 0) map.set(el.dataset.scrollKey, el.scrollTop);
    }
    return map;
  }

  function restoreInnerScrolls(rootEl, map) {
    for (const el of rootEl.querySelectorAll('[data-scroll-key]')) {
      const saved = map.get(el.dataset.scrollKey);
      if (saved != null) el.scrollTop = saved;
    }
  }

  function renderDetail(detail, forceFull = false) {
    const wasNearBottom = (document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)) < 72;
    const prevScrollY = window.scrollY;
    const run = detail.run;
    updateTopBar(run);

    const sameRun = !forceFull && renderedRunId === run.id && elApp.querySelector('#turns-slot');

    suppressToggle = true;
    try {
      if (!sameRun) {
        copyPayloadsByTurn.clear();
        renderedTurnSigs.clear();
        renderedRunId = run.id;
        renderedHeaderSig = '';
        elApp.innerHTML = '<div id="run-header-slot"></div><div id="turns-slot"></div>';
      }

      const headerSlot = elApp.querySelector('#run-header-slot');
      const turnsSlot = elApp.querySelector('#turns-slot');

      const headerSig = `${run.title}|${run.taskKind}|${run.workDir}|${run.effectiveState}|${run.mode}|${run.model}|${run.effort}|${run.sessionId}|${run.rolloutOnly}|${detail.turns.length}`;
      if (headerSig !== renderedHeaderSig) {
        renderedHeaderSig = headerSig;
        headerSlot.innerHTML = renderHeaderHtml(run, detail.turns.length);
      }

      // Incrementally patch ONLY turns whose content actually changed, keeping earlier turns' DOM, scroll, focus & selection intact.
      const existingByTurnId = new Map();
      for (const el of turnsSlot.querySelectorAll(':scope > section.turn-card[data-turn-id]')) {
        existingByTurnId.set(el.dataset.turnId, el);
      }

      const activeIds = new Set();
      let prevNode = null;

      for (let i = 0; i < detail.turns.length; i++) {
        const turn = detail.turns[i];
        activeIds.add(turn.turnId);
        const sig = turnSignature(run, turn);
        let card = existingByTurnId.get(turn.turnId);

        if (!card) {
          card = document.createElement('section');
          card.className = 'turn-card';
          card.dataset.turnId = turn.turnId;
          card.innerHTML = renderTurnInner(run, turn);
          renderedTurnSigs.set(turn.turnId, sig);
          if (prevNode) prevNode.after(card);
          else turnsSlot.prepend(card);
        } else {
          if (renderedTurnSigs.get(turn.turnId) !== sig) {
            const scrolls = captureInnerScrolls(card);
            card.innerHTML = renderTurnInner(run, turn);
            restoreInnerScrolls(card, scrolls);
            renderedTurnSigs.set(turn.turnId, sig);
          }
          if (prevNode && card.previousElementSibling !== prevNode) {
            prevNode.after(card);
          } else if (!prevNode && card !== turnsSlot.firstElementChild) {
            turnsSlot.prepend(card);
          }
        }
        prevNode = card;
      }

      for (const [tid, el] of existingByTurnId.entries()) {
        if (!activeIds.has(tid)) {
          el.remove();
          renderedTurnSigs.delete(tid);
          copyPayloadsByTurn.delete(tid);
        }
      }
    } finally {
      suppressToggle = false;
    }

    if (elOptAutoFollow.checked && run.effectiveState === 'running' && wasNearBottom) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    } else if (!sameRun) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    } else {
      window.scrollTo({ top: prevScrollY, behavior: 'auto' });
    }
  }

  function renderEmptyOrError(html) {
    renderedRunId = '';
    renderedHeaderSig = '';
    renderedTurnSigs.clear();
    copyPayloadsByTurn.clear();
    currentEtag = '';
    currentDetail = null;
    elApp.innerHTML = html;
  }

  async function openCodexSession(sessionId) {
    if (!sessionId) return;
    try {
      const data = await apiPost('/api/open-codex', { sessionId, conversationId, workspaces });
      if (data.ok) {
        showToast('正在打开 Codex 桌面端…');
      } else {
        await copyText(`codex://threads/${sessionId}`, '唤起失败，已复制链接');
      }
    } catch {
      await copyText(`codex://threads/${sessionId}`, '唤起失败，已复制链接');
    }
  }

  function updateRawHeader() {
    const loadedKb = (rawState.nextOffset / 1024).toFixed(1);
    const totalKb = (rawState.totalBytes / 1024).toFixed(1);
    const decompNote = rawState.decompressed ? ' · 已解压 zstd' : '';
    const rangeNote = rawState.hasMore ? `已加载 ${loadedKb} / ${totalKb} KB` : `${totalKb} KB`;
    elRawTitle.textContent = rawState.filename || `${rawState.kind} 原文`;
    elRawSub.textContent = `${rawState.path} · ${rangeNote}${decompNote}`;
    elRawLoadMore.hidden = !rawState.hasMore;
    elRawLoadMore.disabled = false;
  }

  async function fetchRawPage(append) {
    const gen = append ? rawGen : ++rawGen;
    const offset = append ? rawState.nextOffset : 0;
    if (append) elRawLoadMore.disabled = true;

    try {
      const data = await apiPost('/api/raw', {
        runId: rawState.runId,
        turnId: rawState.turnId,
        kind: rawState.kind,
        offset,
        limit: RAW_PAGE_BYTES,
        conversationId,
        workspaces,
      });
      if (gen !== rawGen || !elRawDialog.open) return;
      if (data.error) {
        if (!append) {
          elRawSub.textContent = data.error;
          elRawContent.textContent = `无法读取原始文件：${data.message || data.error}`;
          elRawLoadMore.hidden = true;
        } else {
          showToast(`加载后续片段失败：${data.error}`);
          elRawLoadMore.disabled = false;
        }
        return;
      }
      rawState.filename = data.filename || rawState.filename;
      rawState.path = data.path || rawState.path;
      rawState.content = append ? (rawState.content + (data.content || '')) : (data.content || '');
      rawState.nextOffset = data.nextOffset ?? rawState.content.length;
      rawState.totalBytes = data.totalBytes ?? rawState.nextOffset;
      rawState.hasMore = Boolean(data.hasMore);
      rawState.truncated = Boolean(data.hasMore);
      rawState.decompressed = Boolean(data.decompressed);

      updateRawHeader();
      elRawContent.textContent = rawState.content || '(空文件)';
    } catch (err) {
      if (gen !== rawGen || !elRawDialog.open) return;
      if (!append) {
        elRawSub.textContent = '读取失败';
        elRawContent.textContent = String(err?.message || err);
        elRawLoadMore.hidden = true;
      } else {
        showToast('加载失败');
        elRawLoadMore.disabled = false;
      }
    }
  }

  function openRawModal(runId, turnId, kind) {
    const targetRunId = runId || renderedRunId || selectedRunId;
    if (!targetRunId) return;
    rawState = {
      runId: targetRunId,
      turnId,
      kind,
      content: '',
      nextOffset: 0,
      totalBytes: 0,
      hasMore: false,
      truncated: false,
      path: '',
      filename: '',
      decompressed: false,
    };
    elRawTitle.textContent = `${kind.toUpperCase()} 原文`;
    elRawSub.textContent = '读取中…';
    elRawContent.textContent = '';
    elRawLoadMore.hidden = true;
    if (!elRawDialog.open) elRawDialog.showModal();
    fetchRawPage(false);
  }

  function requestPoll(invalidate = false) {
    if (invalidate) {
      pollGen++;
      currentEtag = '';
    }
    if (inFlight) {
      pendingPoll = true;
      return;
    }
    poll();
  }

  async function poll() {
    if (document.hidden) return;
    if (inFlight) {
      pendingPoll = true;
      return;
    }
    inFlight = true;
    pendingPoll = false;
    const myGen = pollGen;
    const wsSnapshot = [...workspaces];

    try {
      const runsPayload = await apiPost('/api/runs', { conversationId, workspaces: wsSnapshot });
      if (myGen !== pollGen) return;

      if (runsPayload.error) {
        elLiveDot.className = 'live-dot warn';
        elLiveDot.title = `刷新列表失败：${runsPayload.message || runsPayload.error}`;
        return;
      }

      runsList = Array.isArray(runsPayload.runs) ? runsPayload.runs : [];

      if (!runsList.length) {
        selectedRunId = '';
        userPickedRun = false;
        renderSelect();
        updateTopBar(null);
        renderEmptyOrError('<p class="empty">当前还没有检测到 <code>codex-loop</code> 派单记录。<br>在对话中通过 <code>/codex-loop</code> 派单后，这里会自动实时展示双向交互原文。</p>');
        return;
      }

      const stillExists = runsList.some((r) => r.id === selectedRunId);
      if (!selectedRunId || !stillExists) {
        selectedRunId = runsPayload.defaultRunId || runsList[0].id;
        currentEtag = '';
        userPickedRun = false;
      } else if (!userPickedRun && runsPayload.defaultRunId && runsPayload.defaultRunId !== selectedRunId) {
        const newestInConv = runsList.find((r) => r.id === runsPayload.defaultRunId && r.scope === 'conversation');
        if (newestInConv) {
          selectedRunId = newestInConv.id;
          currentEtag = '';
        }
      }

      renderSelect();

      const targetRunId = selectedRunId;
      const sentEtag = currentEtag;
      const detail = await apiPost('/api/run', {
        id: targetRunId,
        etag: sentEtag,
        conversationId,
        workspaces: wsSnapshot,
      });
      if (myGen !== pollGen || targetRunId !== selectedRunId) return;

      if (detail.error) {
        updateTopBar(null);
        renderEmptyOrError(`<p class="empty">读取派单详情失败：${esc(detail.message || detail.error)}</p>`);
        return;
      }
      if (!detail.unchanged) {
        currentEtag = detail.etag || '';
        currentDetail = detail;
        renderDetail(detail);
      } else if (currentDetail?.run) {
        // Restore live dot after a transient network/list error clears on an unchanged poll.
        updateTopBar(currentDetail.run);
      }
    } catch {
      if (myGen !== pollGen) return;
      elLiveDot.className = 'live-dot warn';
      elLiveDot.title = '与 sidecar 连接中断，正在重试';
    } finally {
      inFlight = false;
      clearTimeout(pollTimer);
      if (pendingPoll) {
        pendingPoll = false;
        pollTimer = setTimeout(poll, 0);
      } else {
        const isRunning = currentDetail?.run?.effectiveState === 'running' || runsList.some((r) => r.effectiveState === 'running');
        pollTimer = setTimeout(poll, isRunning ? FAST_POLL_MS : IDLE_POLL_MS);
      }
    }
  }

  // Event bindings
  document.addEventListener('toggle', (event) => {
    if (suppressToggle) return;
    const target = event.target;
    if (target instanceof HTMLDetailsElement && target.dataset.key) {
      openState.set(target.dataset.key, target.open);
    }
  }, { capture: true });

  elSelect.addEventListener('change', () => {
    selectedRunId = elSelect.value;
    userPickedRun = true;
    // Prevent top-bar buttons from acting on the previously rendered run while the newly selected run loads.
    elBtnOpenCodex.disabled = true;
    elBtnCopyLink.disabled = true;
    elLiveDot.className = 'live-dot';
    elLiveDot.title = '切换中…';
    requestPoll(true);
  });

  elBtnOpenCodex.addEventListener('click', () => {
    openCodexSession(currentDetail?.run?.sessionId);
  });

  elBtnCopyLink.addEventListener('click', () => {
    const url = currentDetail?.run?.desktopUrl;
    if (url) copyText(url, '已复制 Codex 会话链接');
  });

  document.getElementById('menu-expand-all').addEventListener('click', () => {
    suppressToggle = true;
    try {
      for (const d of elApp.querySelectorAll('details[data-key]')) {
        d.open = true;
        openState.set(d.dataset.key, true);
      }
    } finally {
      suppressToggle = false;
    }
    elMenu.hidePopover?.();
  });

  document.getElementById('menu-collapse-all').addEventListener('click', () => {
    suppressToggle = true;
    try {
      for (const d of elApp.querySelectorAll('details[data-key]')) {
        d.open = false;
        openState.set(d.dataset.key, false);
      }
    } finally {
      suppressToggle = false;
    }
    elMenu.hidePopover?.();
  });

  document.getElementById('menu-copy-rundir').addEventListener('click', () => {
    const dir = currentDetail?.run?.runDir;
    if (dir) copyText(dir, '已复制运行目录');
    elMenu.hidePopover?.();
  });

  document.getElementById('menu-refresh').addEventListener('click', () => {
    requestPoll(true);
    elMenu.hidePopover?.();
  });

  elOptMessagesOnly.addEventListener('change', () => {
    if (currentDetail) renderDetail(currentDetail, true);
  });

  elOptShowEcho.addEventListener('change', () => {
    if (currentDetail) renderDetail(currentDetail, true);
  });

  elApp.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.dataset.copyKey) {
      const text = lookupCopy(btn.dataset.copyKey);
      if (text !== undefined) copyText(text, '已复制原文');
    } else if (btn.dataset.rawTurn && btn.dataset.rawKind) {
      openRawModal(btn.dataset.runId || '', btn.dataset.rawTurn, btn.dataset.rawKind);
    } else if (btn.dataset.fileUri !== undefined || btn.dataset.filePath) {
      openWorkspaceFile(btn.dataset.fileUri || '', btn.dataset.filePath || '');
    } else if (btn.dataset.openCodex) {
      openCodexSession(btn.dataset.openCodex);
    }
  });

  elRawLoadMore.addEventListener('click', () => fetchRawPage(true));
  document.getElementById('raw-copy').addEventListener('click', () => {
    const label = rawState.truncated ? '已复制当前已加载片段（非完整文件）' : '已复制完整原文';
    copyText(rawState.content, label);
  });
  document.getElementById('raw-close').addEventListener('click', () => elRawDialog.close());
  elRawDialog.addEventListener('close', () => { rawGen++; });
  elRawDialog.addEventListener('click', (event) => {
    if (event.target === elRawDialog) elRawDialog.close();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestPoll(false);
  });

  async function start() {
    if (window.sidecar?.getWorkspaceUris) {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        workspaces = Array.isArray(uris) ? uris.filter(Boolean) : [];
        window.sidecar.onWorkspaceChange?.((next) => {
          const arr = Array.isArray(next) ? next.filter(Boolean) : [];
          if (JSON.stringify(arr) !== JSON.stringify(workspaces)) {
            workspaces = arr;
            requestPoll(true);
          }
        });
      } catch {}
    }
    requestPoll(false);
  }

  start();
})();
