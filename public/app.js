'use strict';

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * Safe getElementById — never throws on missing elements.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
const $ = id => document.getElementById(id);

/**
 * Centralised fetch wrapper — always checks response.ok before parsing.
 * Returns parsed JSON or throws a descriptive Error.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── State ─────────────────────────────────────────────────────────────────
let ws          = null;
let logs        = [];
let buildState  = null;
let activeFile  = null;
let buildStart  = null;
let durationTimer = null;
let bannerEl    = null;
let tickerTimeout = null;
let launchPort  = 3001;

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen  = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      console.error('[WS] Malformed message — not valid JSON:', e);
      return;
    }
    handleMsg(msg);
  };
}

function setConn(ok) {
  const dot   = $('conn-dot');
  const label = $('conn-label');
  if (dot)   dot.className  = 'conn-dot' + (ok ? ' connected' : '');
  if (label) label.textContent = ok ? 'Connected' : 'Reconnecting...';
}

// ── Message handler ───────────────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {

    case 'init':
      buildState = msg.state;
      if (buildState?.phase && buildState.phase !== 'idle') restoreState(buildState);
      break;

    case 'build_start':
      buildStart = Date.now();
      startDurationTimer();
      appendLog({ agent: 'orchestrator', level: 'info', message: `▶ Build started: "${msg.goal}"`, ts: msg.ts });
      updatePhase('planning', 'Decomposing goal...');
      updateStatsBar({ files: 0, components: 0, testsPassed: 0, testsFailed: 0 });
      $('stats-bar')?.style  && ($('stats-bar').style.display = 'flex');
      if ($('btn-approve')) $('btn-approve').disabled = true;
      break;

    case 'phase_change':
      updatePhase(msg.phase, msg.detail);
      setAgentPhase(msg.phase);
      break;

    case 'agent_log':
      appendLog(msg);
      break;

    case 'agent_status':
      updateAgentNode(msg.agent, msg.status);
      break;

    case 'plan_ready':
      renderPlan(msg.components ?? []);
      appendLog({ agent: 'orchestrator', level: 'info', message: `Plan: ${(msg.components ?? []).map(c => c.name).join(', ')}`, ts: msg.ts });
      appendLog({ agent: 'orchestrator', level: 'info', message: `Stack: ${(msg.stack ?? []).join(', ')}`, ts: msg.ts });
      break;

    case 'task_start':
      appendLog({ agent: 'orchestrator', level: 'info', message: `[${msg.index + 1}/${msg.total}] Starting: ${msg.component}`, ts: msg.ts });
      break;

    case 'task_done':
      updatePlanItem(msg.component, msg.passed ? 'done' : 'warn');
      break;

    case 'review_fail':
      appendLog({ agent: 'reviewer', level: 'warn', message: `Review failed (attempt ${msg.attempt}) — self-correction triggered`, ts: msg.ts });
      (msg.errors ?? []).forEach(e => appendLog({ agent: 'reviewer', level: 'error', message: `  ↳ ${e}`, ts: msg.ts }));
      break;

    case 'file_created':
      handleFileCreated(msg);
      break;

    case 'test_run':
      updateStatsBar({
        files:       $('stat-files')?.textContent,
        components:  $('stat-components')?.textContent,
        testsPassed: msg.passed,
        testsFailed: msg.failed,
      });
      break;

    case 'approval_required':
      showApprovalBanner(msg);
      if ($('btn-approve')) $('btn-approve').disabled = false;
      updateAgentNode('orchestrator', 'idle');
      $('node-gate')?.classList.add('awaiting');
      break;

    case 'approved':
      hideApprovalBanner();
      $('node-gate')?.classList.remove('awaiting');
      appendLog({ agent: 'orchestrator', level: 'success', message: '✓ Deployment approved', ts: msg.ts });
      break;

    case 'build_complete':
      stopDurationTimer();
      updatePhase('complete', `${msg.stats?.files ?? 0} files in ${((msg.duration ?? 0) / 1000).toFixed(1)}s`);
      $('phase-badge')?.setAttribute('class', 'phase-badge success');
      updateStatsBar({
        files:       msg.files?.length ?? 0,
        components:  msg.stats?.components ?? 0,
        testsPassed: msg.stats?.testsPassed ?? 0,
        testsFailed: 0,
        duration:    `${((msg.duration ?? 0) / 1000).toFixed(1)}s`,
      });
      appendLog({ agent: 'orchestrator', level: 'success', message: `✅ Build complete — ${msg.files?.length ?? 0} files in ${((msg.duration ?? 0) / 1000).toFixed(1)}s`, ts: msg.ts });
      if ($('btn-build')) $('btn-build').disabled = false;
      void refreshFiles();
      showLaunchButton(msg.goal ?? '');
      break;

    case 'build_error':
      stopDurationTimer();
      updatePhase('error', msg.error ?? 'Unknown error');
      $('phase-badge')?.setAttribute('class', 'phase-badge error');
      appendLog({ agent: 'orchestrator', level: 'error', message: `✗ Build failed: ${msg.error}`, ts: msg.ts });
      if ($('btn-build')) $('btn-build').disabled = false;
      break;

    case 'llm_stream':
      handleLLMStream(msg);
      break;

    case 'reset':
      resetUI();
      break;

    default:
      console.warn('[WS] Unknown message type:', msg.type);
  }
}

// ── Phase / Agent UI ──────────────────────────────────────────────────────
function updatePhase(phase, detail = '') {
  const badge  = $('phase-badge');
  const detEl  = $('phase-detail');
  if (!badge) return;

  badge.textContent = phase.toUpperCase().replace(/_/g, ' ');
  if (detEl) detEl.textContent = detail;

  const running = ['planning','recon','codegen','review','testing','infra','deploying'].includes(phase);
  const cls = running            ? ' running'
    : phase === 'complete'       ? ' success'
    : phase === 'error'          ? ' error'
    : phase === 'awaiting_approval' ? ' warn'
    : '';
  badge.className = 'phase-badge' + cls;
}

const PHASE_AGENTS = {
  recon: 'recon', codegen: 'codegen', review: 'reviewer',
  testing: 'testing', infra: 'infra', deploying: 'orchestrator',
  planning: 'orchestrator', awaiting_approval: 'orchestrator',
};

function setAgentPhase(phase) {
  document.querySelectorAll('.agent-node').forEach(n => {
    n.classList.remove('running');
    const edgeId = `edge-${n.id.replace('node-', '')}`;
    document.getElementById(edgeId)?.classList.remove('active');
  });

  const agentName = PHASE_AGENTS[phase];
  if (!agentName) return;
  document.getElementById(`node-${agentName}`)?.classList.add('running');
  document.getElementById(`edge-${agentName}`)?.classList.add('active');
}

function updateAgentNode(agent, status) {
  const node = document.getElementById(`node-${agent}`);
  if (!node) return;
  node.classList.remove('running', 'success', 'error', 'active');
  if (status !== 'idle') node.classList.add(status);
}

// ── Terminal ──────────────────────────────────────────────────────────────
const MAX_LOGS = 500;

function appendLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  const level   = entry.level || 'info';
  const filters = getFilters();
  if (!filters.has(level)) return;

  const terminal = $('terminal');
  if (!terminal) return;

  terminal.appendChild(buildLogEl(entry));
  terminal.scrollTop = terminal.scrollHeight;
}

/** Builds a log line using DOM methods — no innerHTML, no XSS risk. */
function buildLogEl(entry) {
  const level = entry.level || 'info';
  const ts    = entry.ts ? new Date(entry.ts).toLocaleTimeString('en', { hour12: false }) : '';

  const line    = document.createElement('div');
  line.className = `log-line log-${level} new-entry`;

  const tsEl = document.createElement('span');
  tsEl.className   = 'log-ts';
  tsEl.textContent = ts;

  const agentEl = document.createElement('span');
  agentEl.className   = 'log-agent';
  agentEl.textContent = `[${entry.agent ?? '?'}]`;

  const msgEl = document.createElement('span');
  msgEl.className   = 'log-msg';
  msgEl.textContent = entry.message ?? '';

  line.append(tsEl, agentEl, msgEl);
  return line;
}

function getFilters() {
  const filters = new Set();
  ['info','success','warn','error'].forEach(l => {
    if (document.getElementById(`filter-${l}`)?.checked) filters.add(l);
  });
  filters.add('detail');
  return filters;
}

function renderLogs() {
  const terminal = $('terminal');
  if (!terminal) return;
  terminal.innerHTML = '';
  const filters = getFilters();
  logs
    .filter(l => filters.has(l.level || 'info'))
    .forEach(l => terminal.appendChild(buildLogEl(l)));
  terminal.scrollTop = terminal.scrollHeight;
}

function clearLogs() {
  logs = [];
  const terminal = $('terminal');
  if (terminal) terminal.textContent = '';
}

// ── Plan ──────────────────────────────────────────────────────────────────
const PLAN_ICONS = { pending: '○', in_progress: '◉', done: '✓', warn: '⚠', error: '✗' };

function renderPlan(components) {
  const list = $('plan-list');
  if (!list) return;

  list.textContent = '';
  components.forEach(c => {
    const item = document.createElement('div');
    item.className = 'plan-item pending';
    item.id = `plan-${c.name}`;

    const iconEl = document.createElement('span');
    iconEl.className   = 'plan-icon';
    iconEl.textContent = PLAN_ICONS.pending;

    const nameEl = document.createElement('span');
    nameEl.className   = 'plan-name';
    nameEl.textContent = c.name;

    const descEl = document.createElement('span');
    descEl.className   = 'plan-desc';
    descEl.textContent = c.description ?? '';

    item.append(iconEl, nameEl, descEl);
    list.appendChild(item);
  });

  const statComponents = $('stat-components');
  if (statComponents) statComponents.textContent = String(components.length);
}

function updatePlanItem(name, status) {
  const item = document.getElementById(`plan-${name}`);
  if (!item) return;
  item.className = `plan-item ${status}`;
  const icon = item.querySelector('.plan-icon');
  if (icon) icon.textContent = PLAN_ICONS[status] ?? '○';
}

// ── File Explorer ─────────────────────────────────────────────────────────
let fileTree = [];

function handleFileCreated(msg) {
  if (document.querySelector(`[data-path="${CSS.escape(msg.path)}"]`)) return;

  const filesEl = $('stat-files');
  if (filesEl) filesEl.textContent = String(parseInt(filesEl.textContent || '0', 10) + 1);

  void refreshFiles();
}

async function refreshFiles() {
  let data;
  try {
    data = await apiFetch('/api/files');
  } catch (err) {
    console.error('[refreshFiles] Failed to load file list:', err);
    return;
  }
  fileTree = data.files ?? [];
  renderTree(fileTree);
}

function renderTree(files) {
  const container = $('file-tree');
  if (!container) return;

  if (!files.length) {
    container.textContent = '';
    const hint = document.createElement('span');
    hint.className   = 'empty-hint';
    hint.textContent = 'No files yet';
    container.appendChild(hint);
    return;
  }

  // Group by top-level directory
  const roots = /** @type {Record<string, typeof files>} */ ({});
  files.forEach(f => {
    const top = f.path.split('/')[0];
    if (!roots[top]) roots[top] = [];
    roots[top].push(f);
  });

  container.textContent = '';
  for (const [dir, items] of Object.entries(roots)) {
    const dirEl = document.createElement('div');
    dirEl.className   = 'tree-dir';
    dirEl.textContent = `📁 ${dir}/`;
    dirEl.onclick = () => {
      const sibling = dirEl.nextElementSibling;
      if (sibling instanceof HTMLElement) {
        sibling.style.display = sibling.style.display === 'none' ? '' : 'none';
      }
    };
    container.appendChild(dirEl);

    const group = document.createElement('div');
    group.className = 'tree-indent';
    items
      .filter(f => f.type === 'file')
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach(f => {
        const el = document.createElement('div');
        el.className = `tree-file${f.path === activeFile ? ' active' : ''}`;
        el.setAttribute('data-path', f.path);

        const iconEl = document.createElement('span');
        iconEl.className   = 'tree-icon';
        iconEl.textContent = fileIcon(f.name);

        const nameEl = document.createTextNode(f.name);

        const sizeEl = document.createElement('span');
        sizeEl.className   = 'file-size';
        sizeEl.textContent = formatBytes(f.size);

        el.append(iconEl, nameEl, sizeEl);
        el.onclick = () => void openFile(f.path);
        group.appendChild(el);
      });
    container.appendChild(group);
  }

  const statFiles = $('stat-files');
  if (statFiles) statFiles.textContent = String(files.filter(f => f.type === 'file').length);
}

function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map = { js:'🟨', ts:'🔷', html:'🌐', css:'🎨', json:'{}', md:'📝', sh:'⚙', yml:'🔧', yaml:'🔧', dockerfile:'🐳' };
  return map[ext] ?? '📄';
}

function formatBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b}b`;
  return `${(b / 1024).toFixed(1)}k`;
}

async function openFile(filePath) {
  activeFile = filePath;
  document.querySelectorAll('.tree-file').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-path') === filePath);
  });

  let data;
  try {
    data = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`);
  } catch (err) {
    console.error('[openFile] Failed to fetch file content:', err);
    appendLog({ agent: 'system', level: 'error', message: `Could not open ${filePath}: ${err.message}`, ts: Date.now() });
    return;
  }

  const filenameEl = $('preview-filename');
  const previewEl  = $('file-preview');
  const section    = $('preview-section');

  if (filenameEl) filenameEl.textContent = filePath;
  if (previewEl)  previewEl.textContent  = data.content ?? '';
  if (section) {
    section.style.display       = 'flex';
    section.style.flexDirection = 'column';
  }
}

function closePreview() {
  activeFile = null;
  const section = $('preview-section');
  if (section) section.style.display = 'none';
  document.querySelectorAll('.tree-file').forEach(el => el.classList.remove('active'));
}

// ── Build controls ────────────────────────────────────────────────────────
function startBuild() {
  const goalInput = $('goal-input');
  const goal = goalInput instanceof HTMLTextAreaElement ? goalInput.value.trim() : '';
  if (!goal || goal.length < 5) {
    alert('Please enter a goal (at least 5 characters)');
    return;
  }

  clearLogs();

  const planList = $('plan-list');
  if (planList) {
    planList.textContent = '';
    const hint = document.createElement('span');
    hint.className   = 'empty-hint';
    hint.textContent = 'Planning...';
    planList.appendChild(hint);
  }

  if ($('btn-build'))   $('btn-build').disabled   = true;
  if ($('btn-approve')) $('btn-approve').disabled = true;

  document.querySelectorAll('.agent-node').forEach(n => n.classList.remove('running', 'success', 'error', 'active'));

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'build', goal }));
  } else {
    // Fire-and-forget fallback — errors surfaced via WebSocket events
    void apiFetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    }).catch(err => console.error('[startBuild] Fallback fetch failed:', err));
  }
}

function approveBuild() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'approve' }));
  } else {
    void apiFetch('/api/approve', { method: 'POST' })
      .catch(err => console.error('[approveBuild] Failed:', err));
  }
  if ($('btn-approve')) $('btn-approve').disabled = true;
}

function resetBuild() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'reset' }));
  } else {
    void apiFetch('/api/reset', { method: 'POST' })
      .catch(err => console.error('[resetBuild] Failed:', err));
  }
}

function focusAgent(name) {
  appendLog({ agent: 'user', level: 'info', message: `Focused agent: ${name}`, ts: Date.now() });
}

// ── Approval Banner ───────────────────────────────────────────────────────
function showApprovalBanner(msg) {
  if (bannerEl) return;

  bannerEl = document.createElement('div');
  bannerEl.className = 'approval-banner';

  const textEl = document.createElement('span');
  textEl.textContent = `⏸ Awaiting deployment approval — ${msg.stats?.files ?? 0} files, ${msg.stats?.testsPassed ?? 0} tests passed`;

  const approveBtn = document.createElement('button');
  approveBtn.className   = 'btn-primary btn-sm';
  approveBtn.textContent = '✓ Approve & Deploy';
  approveBtn.onclick     = approveBuild;

  bannerEl.append(textEl, approveBtn);

  const statsBar = $('stats-bar');
  statsBar?.parentNode?.insertBefore(bannerEl, statsBar);
}

function hideApprovalBanner() {
  bannerEl?.remove();
  bannerEl = null;
}

// ── Stats ─────────────────────────────────────────────────────────────────
function updateStatsBar({ files, components, testsPassed, testsFailed, duration } = {}) {
  const set = (id, val) => { const el = $(id); if (el && val !== undefined) el.textContent = String(val); };
  set('stat-files',       files);
  set('stat-components',  components);
  set('stat-tests-pass',  testsPassed);
  set('stat-tests-fail',  testsFailed);
  set('stat-duration',    duration);
}

function startDurationTimer() {
  stopDurationTimer();
  durationTimer = setInterval(() => {
    if (buildStart) {
      const s = ((Date.now() - buildStart) / 1000).toFixed(1);
      const el = $('stat-duration');
      if (el) el.textContent = `${s}s`;
    }
  }, 500);
}

function stopDurationTimer() {
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
}

// ── Config Modal ──────────────────────────────────────────────────────────
function openConfig() {
  const modal = $('config-modal');
  if (modal) modal.style.display = 'flex';
}

function closeConfig(e) {
  if (!e || e.target === $('config-modal')) {
    const modal = $('config-modal');
    if (modal) modal.style.display = 'none';
  }
}

function saveConfig() {
  const val = id => {
    const el = $(id);
    return el instanceof HTMLInputElement ? (el.value.trim() || undefined) : undefined;
  };

  const config = {
    anthropicKey: val('cfg-anthropic'),
    openaiKey:    val('cfg-openai'),
    geminiKey:    val('cfg-gemini'),
    ollamaUrl:    val('cfg-ollama'),
  };

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'config', config }));
  } else {
    void apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }).catch(err => console.error('[saveConfig] Failed:', err));
  }

  closeConfig();
  appendLog({ agent: 'system', level: 'success', message: 'LLM config updated', ts: Date.now() });
}

// ── Restore state on reconnect ────────────────────────────────────────────
function restoreState(state) {
  if (state.phase && state.phase !== 'idle') {
    updatePhase(state.phase, '');
    setAgentPhase(state.phase);
  }
  if (Array.isArray(state.plan) && state.plan.length) {
    renderPlan(state.plan);
    state.plan.forEach(p => p.status && updatePlanItem(p.name, p.status));
  }
  if (Array.isArray(state.files) && state.files.length) {
    renderTree(state.files);
    const statsBar = $('stats-bar');
    if (statsBar) statsBar.style.display = 'flex';
  }
  if (state.phase === 'awaiting_approval') {
    if ($('btn-approve')) $('btn-approve').disabled = false;
    $('node-gate')?.classList.add('awaiting');
  }
}

function resetUI() {
  clearLogs();

  const setHint = (id, text) => {
    const el = $(id);
    if (!el) return;
    el.textContent = '';
    const hint = document.createElement('span');
    hint.className   = 'empty-hint';
    hint.textContent = text;
    el.appendChild(hint);
  };

  setHint('plan-list',  'No plan yet — start a build');
  setHint('file-tree',  'No files yet');

  updatePhase('idle', '');
  $('phase-badge')?.setAttribute('class', 'phase-badge');
  if ($('btn-build'))   $('btn-build').disabled   = false;
  if ($('btn-approve')) $('btn-approve').disabled = true;
  const statsBar = $('stats-bar');
  if (statsBar) statsBar.style.display = 'none';

  document.querySelectorAll('.agent-node').forEach(n => n.classList.remove('running', 'success', 'error', 'active'));
  $('node-gate')?.classList.remove('awaiting');

  closePreview();
  hideApprovalBanner();
  stopDurationTimer();
  buildStart = null;
}

// ── LLM Stream Ticker ─────────────────────────────────────────────────────
function handleLLMStream(msg) {
  const ticker     = $('llm-ticker');
  const tickerText = $('llm-ticker-text');
  if (!ticker || !tickerText) return;

  ticker.style.display   = 'flex';
  tickerText.textContent = msg.chunk ?? '';

  // Append to terminal as a dimmed stream line using safe DOM construction
  const terminal = $('terminal');
  if (terminal) {
    const line = document.createElement('div');
    line.className    = 'log-line log-detail';
    line.style.opacity = '0.55';

    const agentEl = document.createElement('span');
    agentEl.className   = 'log-agent';
    agentEl.style.color = 'var(--accent)';
    agentEl.textContent = `[${msg.agent ?? '?'}]`;

    const msgEl = document.createElement('span');
    msgEl.className   = 'log-msg';
    msgEl.textContent = msg.chunk ?? '';

    line.append(agentEl, msgEl);
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  clearTimeout(tickerTimeout);
  tickerTimeout = setTimeout(() => {
    if (ticker) ticker.style.display = 'none';
  }, 3000);
}

// ── Launch Button ─────────────────────────────────────────────────────────
function showLaunchButton(goal) {
  const btn = $('btn-launch');
  if (!btn) return;
  btn.style.display = 'flex';
  btn.title = `Launch generated app: ${goal}`;
}

async function launchApp() {
  let data;
  try {
    data = await apiFetch('/api/launch', { method: 'POST' });
  } catch (err) {
    console.error('[launchApp] Launch request failed:', err);
    alert(`Launch request failed: ${err.message}`);
    return;
  }

  if (data.error) {
    console.error('[launchApp] Launch failed:', data.error);
    alert(`Launch failed: ${data.error}`);
    return;
  }

  const url = data.url;
  appendLog({ agent: 'system', level: 'success', message: `🚀 Opening ${url}`, ts: Date.now() });
  window.open(url, '_blank');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    startBuild();
  }
  if (e.key === 'Escape') closeConfig();
});

// ── Init ──────────────────────────────────────────────────────────────────
connect();