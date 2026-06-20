/**
 * Tube Downloader — Full SPA Frontend
 * Handles: WebSocket, SPA routing, download modal (4 tabs), settings (7 tabs),
 * speed graphs, toast notifications, theme switching, and all yt-dlp options.
 */

'use strict';

// ─── Constants & State ────────────────────────────────────────

const WS_URL = `ws://${location.host}/ws`;
const API = {
  analyze: '/api/analyze',
  download: '/api/download',
  action: '/api/action',
  open: '/api/open',
  settings: '/api/settings',
  sysinfo: '/api/sysinfo',
  history: '/api/history',
  update: '/api/update-ytdlp',
};

let ws = null;
let wsReconnectTimer = null;
let appState = {
  active: [],
  completed: [],
  settings: {}
};
let currentAnalyzeResult = null;
const speedTrackers = {}; // id → SpeedTracker
let currentSettingsTab = 'download';
let currentModalTab = 'basic';

// ─── Utility ──────────────────────────────────────────────────

function qs(sel, ctx = document) { return ctx.querySelector(sel); }
function qsa(sel, ctx = document) { return Array.from(ctx.querySelectorAll(sel)); }
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Toast ────────────────────────────────────────────────────

function toast(message, type = 'info', duration = 3500) {
  const container = qs('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-dot"></div><span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('exit');
    setTimeout(() => el.remove(), 250);
  }, duration);
  el.addEventListener('click', () => el.remove());
}

// ─── Speed Tracker (Canvas) ───────────────────────────────────

class SpeedTracker {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.points = [];
    this.maxPoints = 60;
  }
  addPoint(speedStr) {
    let mbps = 0;
    const m = (speedStr || '').match(/([\d.]+)\s*(MiB|MB|KiB|KB|GiB|GB)\/s/i);
    if (m) {
      const val = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      if (unit.includes('g')) mbps = val * 1024;
      else if (unit.includes('m')) mbps = val;
      else mbps = val / 1024;
    }
    this.points.push(mbps);
    if (this.points.length > this.maxPoints) this.points.shift();
    this.draw();
  }
  draw() {
    const { canvas, ctx, points } = this;
    const w = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    const h = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    if (points.length < 2) return;

    const max = Math.max(...points, 0.1);
    const step = w / (this.maxPoints - 1);

    // Dynamic theme colors
    const bodyStyle = getComputedStyle(document.body);
    const accentLine = bodyStyle.getPropertyValue('--accent-1').trim() || '#8b5cf6';
    const accentFill = bodyStyle.getPropertyValue('--accent-glow').trim() || 'rgba(139,92,246,0.25)';

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, accentFill);
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.beginPath();
    ctx.moveTo(0, h);
    points.forEach((p, i) => {
      const x = i * step;
      const y = h - (p / max) * h * 0.9;
      ctx.lineTo(x, y);
    });
    ctx.lineTo((points.length - 1) * step, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = i * step;
      const y = h - (p / max) * h * 0.9;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accentLine;
    ctx.lineWidth = 1.5 * window.devicePixelRatio;
    ctx.stroke();
  }
}

// ─── WebSocket Connection ─────────────────────────────────────

function connectWS() {
  clearTimeout(wsReconnectTimer);

  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    setConnStatus(true);
  });

  ws.addEventListener('message', (e) => {
    try {
      handleWSMessage(JSON.parse(e.data));
    } catch (err) {
      console.error('WS parse error:', err);
    }
  });

  ws.addEventListener('close', () => {
    setConnStatus(false);
    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function setConnStatus(online) {
  const status = qs('#connStatus');
  const dot = qs('#mobileConnDot');
  if (online) {
    status.className = 'conn-status connected';
    qs('#connText').textContent = 'Connected';
    if (dot) { dot.className = 'mobile-conn-dot connected'; }
  } else {
    status.className = 'conn-status disconnected';
    qs('#connText').textContent = 'Reconnecting...';
    if (dot) { dot.className = 'mobile-conn-dot'; }
  }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'init':
      appState.active = msg.active || [];
      appState.completed = msg.completed || [];
      if (msg.settings) { appState.settings = msg.settings; applySettings(msg.settings); }
      renderActiveDownloads();
      renderCompletedDownloads();
      updateStats();
      break;

    case 'added':
      if (msg.download) {
        // Remove if already present then re-add
        appState.active = appState.active.filter(d => d.id !== msg.download.id);
        appState.active.unshift(msg.download);
        addOrUpdateActiveCard(msg.download);
        updateStats();
        // Navigate to downloads page
        navigateTo('downloads');
      }
      break;

    case 'update':
      if (msg.download) {
        const idx = appState.active.findIndex(d => d.id === msg.download.id);
        if (idx !== -1) appState.active[idx] = msg.download;
        else appState.active.unshift(msg.download);
        updateActiveCard(msg.download);
        updateStats();
      }
      break;

    case 'completed':
      appState.active = appState.active.filter(d => d.id !== msg.activeId);
      if (msg.download) appState.completed.unshift(msg.download);
      removeActiveCard(msg.activeId);
      addCompletedCard(msg.download);
      updateStats();
      toast(`✅ "${escapeHtml(msg.download.title.substring(0, 50))}" downloaded!`, 'success');
      break;

    case 'failed':
      if (msg.download) {
        const idx = appState.active.findIndex(d => d.id === msg.download.id);
        if (idx !== -1) appState.active[idx] = msg.download;
        updateActiveCard(msg.download);
        toast(`❌ Download failed: ${escapeHtml((msg.download.error || 'Unknown error').substring(0, 80))}`, 'error', 5000);
      }
      break;

    case 'removed':
      appState.active = appState.active.filter(d => d.id !== msg.id);
      removeActiveCard(msg.id);
      updateStats();
      break;

    case 'completed_removed':
      appState.completed = appState.completed.filter(d => d.id !== msg.id);
      removeCompletedCard(msg.id);
      updateStats();
      break;

    case 'settings':
      if (msg.settings) { appState.settings = msg.settings; applySettings(msg.settings); }
      break;
  }
}

// ─── Stats ────────────────────────────────────────────────────

function updateStats() {
  const activeCount = appState.active.filter(d => d.status !== 'failed').length;
  const completedCount = appState.completed.length;

  qs('#statActive').textContent = activeCount;
  qs('#statCompleted').textContent = completedCount;
  qs('#historyNavBadge').textContent = completedCount;

  const activeBadge = qs('#activeNavBadge');
  if (activeCount > 0) {
    activeBadge.textContent = activeCount;
    activeBadge.style.display = 'inline-flex';
  } else {
    activeBadge.style.display = 'none';
  }

  // Aggregate speed
  let totalMbps = 0;
  appState.active.forEach(d => {
    if (d.status === 'downloading' && d.speed) {
      const m = d.speed.match(/([\d.]+)\s*(MiB|MB|KiB|KB|GiB|GB)\/s/i);
      if (m) {
        const val = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        if (unit.includes('g')) totalMbps += val * 1024;
        else if (unit.includes('m')) totalMbps += val;
        else totalMbps += val / 1024;
      }
    }
  });
  if (totalMbps >= 1024) qs('#statSpeed').textContent = (totalMbps / 1024).toFixed(2) + ' GiB/s';
  else if (totalMbps >= 1) qs('#statSpeed').textContent = totalMbps.toFixed(1) + ' MiB/s';
  else qs('#statSpeed').textContent = (totalMbps * 1024).toFixed(0) + ' KiB/s';

  // Empty states
  qs('#activeEmpty').style.display = activeCount === 0 ? '' : 'none';
  qs('#completedEmpty').style.display = completedCount === 0 ? '' : 'none';

  // Dashboard recent
  renderDashboardRecent();
  renderDashboardActive();
}

// ─── SPA Navigation ───────────────────────────────────────────

function navigateTo(page) {
  qsa('.page').forEach(p => p.classList.remove('active'));
  qsa('.nav-item').forEach(n => n.classList.remove('active'));

  const targetPage = qs(`#page${page.charAt(0).toUpperCase() + page.slice(1)}`);
  const targetNav = qs(`[data-page="${page}"]`);

  if (targetPage) targetPage.classList.add('active');
  if (targetNav) targetNav.classList.add('active');

  // Close mobile sidebar
  closeMobileSidebar();
}

// ─── Mobile Sidebar ───────────────────────────────────────────

function openMobileSidebar() {
  qs('#sidebar').classList.add('open');
  let overlay = qs('.sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', closeMobileSidebar);
  }
  overlay.classList.add('active');
}

function closeMobileSidebar() {
  qs('#sidebar').classList.remove('open');
  const overlay = qs('.sidebar-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ─── Render Active Downloads ──────────────────────────────────

function renderActiveDownloads() {
  const list = qs('#activeList');
  list.innerHTML = '';
  Object.keys(speedTrackers).forEach(id => delete speedTrackers[id]);

  appState.active.forEach(dl => {
    const card = buildActiveCard(dl);
    list.appendChild(card);
    initSpeedTracker(dl.id);
  });
  updateStats();
}

function buildActiveCard(dl) {
  const div = document.createElement('div');
  div.className = 'download-card';
  div.id = `card-${dl.id}`;
  div.innerHTML = activeCardHTML(dl);
  return div;
}

function activeCardHTML(dl) {
  const statusMap = {
    downloading: 'Downloading',
    queued: 'Queued',
    paused: 'Paused',
    merging: 'Merging',
    processing: 'Processing',
    extracting: 'Extracting',
    failed: 'Failed'
  };
  const statusLabel = statusMap[dl.status] || dl.status;
  const isPaused = dl.status === 'paused';
  const canPause = dl.status === 'downloading' || dl.status === 'queued';
  const canResume = dl.status === 'paused';
  const canRetry = dl.status === 'failed';
  const pct = Math.min(100, dl.progress || 0).toFixed(1);
  const isAnimated = dl.status === 'downloading' || dl.status === 'merging' || dl.status === 'processing';

  return `
    <div class="download-card-header">
      <img class="download-thumb" src="${escapeHtml(dl.thumbnail || '')}" alt="" onerror="this.style.display='none'">
      <div class="download-meta">
        <div class="download-title" title="${escapeHtml(dl.title)}">${escapeHtml(dl.title)}</div>
        <div class="download-status-row">
          <span class="status-chip ${dl.status}">${statusLabel}</span>
          <span class="download-speed-text" id="speed-${dl.id}">${dl.status === 'paused' ? 'Paused' : (dl.speed || '—')}</span>
          <span class="download-eta-text" id="eta-${dl.id}">${dl.eta && dl.eta !== '--:--' ? 'ETA ' + dl.eta : ''}</span>
          <span class="download-size-text" id="size-${dl.id}">${dl.totalSize || ''}</span>
        </div>
        ${dl.error ? `<div style="color:#ef4444;font-size:11px;margin-top:4px;">${escapeHtml(dl.error.substring(0,120))}</div>` : ''}
      </div>
      <div class="download-card-actions">
        ${canPause ? `<button class="icon-btn" title="Pause" data-action="pause" data-id="${dl.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>` : ''}
        ${canResume ? `<button class="icon-btn success" title="Resume" data-action="resume" data-id="${dl.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>` : ''}
        ${canRetry ? `<button class="icon-btn success" title="Retry" data-action="retry" data-id="${dl.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        </button>` : ''}
        <button class="icon-btn danger" title="Cancel" data-action="cancel" data-id="${dl.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress-fill ${isAnimated ? 'animated' : ''}" id="prog-${dl.id}" style="width:${pct}%"></div>
      <div class="progress-percent" id="progpct-${dl.id}">${pct}%</div>
    </div>
    <canvas class="speed-graph" id="graph-${dl.id}"></canvas>
  `;
}

function addOrUpdateActiveCard(dl) {
  const existing = qs(`#card-${dl.id}`);
  if (existing) {
    updateActiveCard(dl);
    return;
  }
  const list = qs('#activeList');
  const card = buildActiveCard(dl);
  list.insertBefore(card, list.firstChild);
  initSpeedTracker(dl.id);
  updateStats();
}

function updateActiveCard(dl) {
  const card = qs(`#card-${dl.id}`);
  if (!card) { addOrUpdateActiveCard(dl); return; }

  // Update progress
  const prog = qs(`#prog-${dl.id}`);
  const progPct = qs(`#progpct-${dl.id}`);
  const pct = Math.min(100, dl.progress || 0).toFixed(1);
  if (prog) { prog.style.width = pct + '%'; prog.className = `progress-fill ${(dl.status === 'downloading' || dl.status === 'merging') ? 'animated' : ''}`; }
  if (progPct) progPct.textContent = pct + '%';

  // Update speed/eta/size
  const speedEl = qs(`#speed-${dl.id}`);
  const etaEl = qs(`#eta-${dl.id}`);
  const sizeEl = qs(`#size-${dl.id}`);
  if (speedEl) speedEl.textContent = dl.status === 'paused' ? '—' : (dl.speed || '—');
  if (etaEl) etaEl.textContent = dl.eta && dl.eta !== '--:--' ? 'ETA ' + dl.eta : '';
  if (sizeEl) sizeEl.textContent = dl.totalSize || '';

  // Update status chip
  const chip = card.querySelector('.status-chip');
  const statusMap = { downloading: 'Downloading', queued: 'Queued', paused: 'Paused', merging: 'Merging', processing: 'Processing', extracting: 'Extracting', failed: 'Failed' };
  if (chip) { chip.className = `status-chip ${dl.status}`; chip.textContent = statusMap[dl.status] || dl.status; }

  // Update speed graph
  if (speedTrackers[dl.id] && dl.status === 'downloading') {
    speedTrackers[dl.id].addPoint(dl.speed);
  }
}

function initSpeedTracker(id) {
  const canvas = qs(`#graph-${id}`);
  if (canvas) {
    speedTrackers[id] = new SpeedTracker(canvas);
  }
}

function removeActiveCard(id) {
  const card = qs(`#card-${id}`);
  if (card) card.remove();
  delete speedTrackers[id];
}

// ─── Render Completed Downloads ───────────────────────────────

function renderCompletedDownloads() {
  const list = qs('#completedList');
  list.innerHTML = '';
  appState.completed.forEach(dl => list.appendChild(buildCompletedCard(dl)));
  updateStats();
}

function buildCompletedCard(dl) {
  const div = document.createElement('div');
  div.id = `completed-${dl.id}`;
  div.className = 'download-card';
  div.innerHTML = completedCardHTML(dl);
  return div;
}

function completedCardHTML(dl) {
  return `
    <div class="download-card-header">
      <img class="download-thumb" src="${escapeHtml(dl.thumbnail || '')}" alt="" onerror="this.style.display='none'">
      <div class="download-meta">
        <div class="download-title" title="${escapeHtml(dl.title)}">${escapeHtml(dl.title)}</div>
        <div class="download-status-row">
          <span class="status-chip completed">Completed</span>
          <span class="download-size-text">${escapeHtml(dl.totalSize || '')}</span>
          <span class="download-eta-text">${formatDate(dl.completedAt)}</span>
        </div>
      </div>
      <div class="download-card-actions">
        <button class="icon-btn success" title="Open File" data-action="open-file" data-filepath="${escapeHtml(dl.filePath || '')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="icon-btn" title="Open Folder" data-action="open-folder" data-filepath="${escapeHtml(dl.filePath || '')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="icon-btn danger" title="Remove" data-action="delete" data-id="${dl.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
  `;
}

function addCompletedCard(dl) {
  if (!dl) return;
  const list = qs('#completedList');
  const card = buildCompletedCard(dl);
  list.insertBefore(card, list.firstChild);
  updateStats();
}

function removeCompletedCard(id) {
  const card = qs(`#completed-${id}`);
  if (card) card.remove();
}

// ─── Dashboard Recent ─────────────────────────────────────────

function renderDashboardRecent() {
  const container = qs('#dashboardRecent');
  const recent = appState.completed.slice(0, 5);
  if (!recent.length) {
    container.innerHTML = '<div class="empty-mini">No downloads yet. Paste a URL above to get started!</div>';
    return;
  }
  container.innerHTML = recent.map(dl => `
    <div class="recent-item">
      <img class="recent-thumb" src="${escapeHtml(dl.thumbnail || '')}" alt="" onerror="this.style.display='none'">
      <div class="recent-info">
        <div class="recent-title">${escapeHtml(dl.title)}</div>
        <div class="recent-date">${formatDate(dl.completedAt)}</div>
      </div>
      <div class="recent-actions">
        <button class="icon-btn success" title="Play" data-action="open-file" data-filepath="${escapeHtml(dl.filePath || '')}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="icon-btn" title="Folder" data-action="open-folder" data-filepath="${escapeHtml(dl.filePath || '')}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

// ─── Dashboard Active Downloads ───────────────────────────────

function renderDashboardActive() {
  const container = qs('#dashActiveList');
  if (!container) return;
  const downloads = Object.values(appState.active);
  if (!downloads.length) {
    container.innerHTML = '<div class="dash-active-empty">No active downloads. Paste a URL above to get started.</div>';
    return;
  }
  container.innerHTML = downloads.map(dl => {
    const pct = Math.min(100, dl.progress || 0);
    const statusLabel = dl.status === 'downloading' ? 'Downloading'
      : dl.status === 'queued' ? 'Queued'
      : dl.status === 'paused' ? 'Paused'
      : dl.status === 'merging' ? 'Merging'
      : dl.status === 'processing' ? 'Processing'
      : dl.status === 'failed' ? 'Failed'
      : dl.status;
    return `
      <div class="dash-active-item" onclick="navigateTo('downloads')" title="Go to Downloads">
        <img class="dash-active-thumb" src="${escapeHtml(dl.thumbnail || '')}" alt="" onerror="this.style.display='none'">
        <div class="dash-active-info">
          <div class="dash-active-title">${escapeHtml(dl.title || dl.url || 'Downloading...')}</div>
          <div class="dash-active-progress-wrap">
            <div class="dash-active-progress-fill" style="width:${pct}%"></div>
          </div>
          <div class="dash-active-meta">
            <span class="dash-active-pct">${pct.toFixed(1)}%</span>
            <span class="dash-active-speed">${dl.speed && dl.speed !== 'Calculating...' ? dl.speed : ''}</span>
            <span class="dash-active-status ${dl.status}">${statusLabel}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Download Config Modal ────────────────────────────────────

function openAnalyzeModal(data) {
  currentAnalyzeResult = data;

  // Fill preview
  qs('#prevThumb').src = data.thumbnail || '';
  qs('#prevTitle').textContent = data.title || 'Unknown';
  qs('#prevChannel').textContent = data.channel || '';
  qs('#prevDuration').textContent = data.duration || '';
  qs('#prevViews').textContent = data.views ? data.views + ' views' : '';
  qs('#prevLikes').textContent = data.likes && data.likes !== 'N/A' ? data.likes + ' likes' : '';
  qs('#prevChapters').textContent = data.hasChapters ? `📚 ${data.chaptersCount} chapters` : '';
  qs('#prevSubs').textContent = data.availableSubs && data.availableSubs.length ? `🌐 ${data.availableSubs.length} subtitle tracks` : '';

  // Set modal title
  qs('#modalTitle').textContent = data.type === 'playlist' ? 'Configure Playlist Download' : 'Configure Download';

  // Populate formats
  const formatSel = qs('#dlFormat');
  formatSel.innerHTML = '';
  const formats = data.type === 'playlist'
    ? [
        { id: 'bestvideo+bestaudio/best', label: 'Best Quality (MP4)', ext: 'mp4' },
        { id: 'bestvideo[height<=1080]+bestaudio/best', label: 'Full HD (1080p)', ext: 'mp4' },
        { id: 'bestvideo[height<=720]+bestaudio/best', label: 'HD (720p)', ext: 'mp4' },
        { id: 'bestaudio/best', label: 'Audio Only', ext: 'audio' },
      ]
    : (data.formats || []);

  formats.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label + (f.note ? ` — ${f.note}` : '');
    formatSel.appendChild(opt);
  });

  // Audio format group visibility
  formatSel.addEventListener('change', updateFormatUI);
  updateFormatUI();

  // Show/hide playlist options
  qs('#playlistOptionsGroup').style.display = data.type === 'playlist' ? '' : 'none';

  // Pre-fill path with settings default
  qs('#dlPath').value = appState.settings.downloadPath || '';

  // Pre-fill advanced options with global settings
  const s = appState.settings || {};
  
  // Basic
  if (qs('#dlAudioFmt')) qs('#dlAudioFmt').value = s.audioFormat || 'mp3';
  if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = '';
  if (qs('#dlNoPlaylist')) qs('#dlNoPlaylist').checked = false;
  if (qs('#dlPlaylistRandom')) qs('#dlPlaylistRandom').checked = false;

  // Advanced
  if (qs('#dlSections')) qs('#dlSections').value = '';
  if (qs('#dlOutputTemplate')) qs('#dlOutputTemplate').value = s.outputTemplate || '';
  if (qs('#dlArchive')) qs('#dlArchive').value = '';
  if (qs('#dlDateAfter')) qs('#dlDateAfter').value = '';
  if (qs('#dlDateBefore')) qs('#dlDateBefore').value = '';
  if (qs('#dlLiveFromStart')) qs('#dlLiveFromStart').checked = false;
  if (qs('#dlWaitForVideo')) qs('#dlWaitForVideo').value = '';
  if (qs('#dlExternalDownloader')) qs('#dlExternalDownloader').value = '';
  qsa('.dlsb-remove').forEach(c => { c.checked = false; });
  qsa('.dlsb-mark').forEach(c => { c.checked = false; });

  // Network
  if (qs('#dlProxy')) qs('#dlProxy').value = s.proxy || '';
  if (qs('#dlCookiesBrowser')) qs('#dlCookiesBrowser').value = s.cookiesFromBrowser || '';
  if (qs('#dlForceIPv4')) qs('#dlForceIPv4').checked = !!s.forceIPv4;
  if (qs('#dlForceIPv6')) qs('#dlForceIPv6').checked = !!s.forceIPv6;

  // Post-processing
  if (qs('#dlWriteSubs')) qs('#dlWriteSubs').checked = !!s.writeSubs;
  if (qs('#dlWriteAutoSubs')) qs('#dlWriteAutoSubs').checked = !!s.writeAutoSubs;
  if (qs('#dlEmbedSubs')) qs('#dlEmbedSubs').checked = !!s.embedSubs;
  if (qs('#dlSubLangs')) qs('#dlSubLangs').value = s.subLangs || 'en';
  if (qs('#dlSubFormat')) qs('#dlSubFormat').value = s.subFormat || 'srt';
  if (qs('#dlEmbedThumbnail')) qs('#dlEmbedThumbnail').checked = !!s.embedThumbnail;
  if (qs('#dlEmbedMetadata')) qs('#dlEmbedMetadata').checked = !!s.embedMetadata;
  if (qs('#dlAddChapters')) qs('#dlAddChapters').checked = !!s.addChapters;
  if (qs('#dlWriteThumbnail')) qs('#dlWriteThumbnail').checked = !!s.writeThumbnail;

  // Switch to first modal tab
  switchModalTab('basic');

  // Show modal
  qs('#modalOverlay').style.display = 'flex';
}

function updateFormatUI() {
  const val = qs('#dlFormat').value;
  const isAudio = val === 'bestaudio/best';
  qs('#audioFormatGroup').style.display = isAudio ? '' : 'none';
}

function closeModal() {
  qs('#modalOverlay').style.display = 'none';
  currentAnalyzeResult = null;
}

function switchModalTab(tab) {
  currentModalTab = tab;
  qsa('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.mtab === tab));
  qsa('.modal-tab-panel').forEach(p => p.classList.toggle('active', p.id === `mtab${tab.charAt(0).toUpperCase() + tab.slice(1)}`));
}

function collectAdvancedOptions() {
  const waitForVideoRaw = qs('#dlWaitForVideo') ? parseInt(qs('#dlWaitForVideo').value) : NaN;
  return {
    // Basic
    audioFormat: qs('#dlAudioFmt').value,
    playlistItems: qs('#dlPlaylistItems').value.trim(),
    noPlaylist: qs('#dlNoPlaylist').checked,
    playlistRandom: qs('#dlPlaylistRandom').checked,

    // Advanced
    downloadSections: qs('#dlSections').value.trim(),
    outputTemplate: qs('#dlOutputTemplate').value.trim(),
    downloadArchive: qs('#dlArchive').value.trim(),
    dateAfter: qs('#dlDateAfter').value,
    dateBefore: qs('#dlDateBefore').value,
    liveFromStart: qs('#dlLiveFromStart').checked,
    waitForVideo: (!isNaN(waitForVideoRaw) && waitForVideoRaw > 0) ? waitForVideoRaw : undefined,
    externalDownloader: qs('#dlExternalDownloader') ? qs('#dlExternalDownloader').value : '',

    // Network (per-download override)
    proxy: qs('#dlProxy').value.trim(),
    cookiesFromBrowser: qs('#dlCookiesBrowser').value,
    forceIPv4: qs('#dlForceIPv4').checked,
    forceIPv6: qs('#dlForceIPv6').checked,

    // Post-processing
    writeSubs: qs('#dlWriteSubs').checked,
    writeAutoSubs: qs('#dlWriteAutoSubs').checked,
    embedSubs: qs('#dlEmbedSubs').checked,
    subLangs: qs('#dlSubLangs').value.trim() || 'en',
    subFormat: qs('#dlSubFormat').value,
    embedThumbnail: qs('#dlEmbedThumbnail').checked,
    embedMetadata: qs('#dlEmbedMetadata').checked,
    addChapters: qs('#dlAddChapters').checked,
    writeThumbnail: qs('#dlWriteThumbnail').checked,

    // SponsorBlock
    sponsorBlockRemove: qsa('.dlsb-remove:checked').map(c => c.value),
    sponsorBlockMark: qsa('.dlsb-mark:checked').map(c => c.value),
  };
}

// ─── Analyze Flow ─────────────────────────────────────────────

qs('#urlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = qs('#videoUrl').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    toast('Please enter a valid URL starting with http:// or https://', 'error');
    return;
  }

  const btn = qs('#analyzeBtn');
  const spinner = qs('#analyzeSpinner');
  const btnText = btn.querySelector('.btn-text');

  btn.disabled = true;
  spinner.style.display = '';
  btnText.style.display = 'none';

  try {
    const res = await fetch(API.analyze, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (!res.ok) {
      toast(data.error || 'Failed to analyze URL', 'error', 5000);
      return;
    }

    openAnalyzeModal({ ...data, inputUrl: url });
  } catch (err) {
    toast('Network error — is the server running?', 'error');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.style.display = '';
  }
});

// Paste button
qs('#pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    qs('#videoUrl').value = text;
    qs('#videoUrl').focus();
  } catch {
    toast('Cannot access clipboard — paste manually', 'warning');
  }
});

// Start download
qs('#startDlBtn').addEventListener('click', async () => {
  if (!currentAnalyzeResult) return;

  const formatId = qs('#dlFormat').value;
  const dlPath = qs('#dlPath').value.trim();
  const advancedOptions = collectAdvancedOptions();

  const btn = qs('#startDlBtn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const res = await fetch(API.download, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentAnalyzeResult.inputUrl || currentAnalyzeResult.url,
        formatId,
        title: currentAnalyzeResult.title || 'Unknown',
        thumbnail: currentAnalyzeResult.thumbnail || '',
        downloadPath: dlPath || undefined,
        advancedOptions
      })
    });

    const data = await res.json();
    if (res.ok) {
      closeModal();
      qs('#videoUrl').value = '';
      toast('Download started!', 'success');
    } else {
      toast(data.error || 'Failed to start download', 'error');
    }
  } catch (err) {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Start Download`;
  }
});

qs('#cancelDlBtn').addEventListener('click', closeModal);
qs('#closeModal').addEventListener('click', closeModal);
qs('#modalOverlay').addEventListener('click', (e) => { if (e.target === qs('#modalOverlay')) closeModal(); });

// Modal tab switching
qsa('.modal-tab').forEach(t => t.addEventListener('click', () => switchModalTab(t.dataset.mtab)));

// ─── Download Actions (event delegation) ─────────────────────

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const filePath = btn.dataset.filepath;

  if (action === 'open-file' || action === 'open-folder') {
    if (!filePath) { toast('File path not available', 'warning'); return; }
    try {
      const res = await fetch(API.open, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, type: action === 'open-folder' ? 'folder' : 'file' })
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || 'Failed to open item', 'error', 5000);
      } else if (data.warning) {
        toast(data.warning, 'info', 4000);
      }
    } catch (err) {
      toast('Failed to communicate with server', 'error');
    }
    return;
  }

  if (['pause', 'resume', 'cancel', 'delete', 'retry'].includes(action) && id) {
    await fetch(API.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action })
    });
  }
});

// Bulk actions
qs('#bulkPauseBtn').addEventListener('click', () => bulkAction('pause'));
qs('#bulkResumeBtn').addEventListener('click', () => bulkAction('resume'));
qs('#bulkCancelBtn').addEventListener('click', () => bulkAction('cancel'));

async function bulkAction(action) {
  await fetch(API.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'all', action })
  });
}

// ─── Clear History ────────────────────────────────────────────

qs('#clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear all download history?')) return;
  await fetch(API.history, { method: 'DELETE' });
});

// ─── Settings Tab Navigation ──────────────────────────────────

qsa('.settings-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.stab;
    qsa('.settings-nav-item').forEach(n => n.classList.remove('active'));
    qsa('.settings-panel').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const panel = qs(`#stab${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
    if (panel) panel.classList.add('active');
  });
});

// ─── Settings Form Apply / Save ───────────────────────────────

function applyTheme(theme, mode) {
  document.body.className = `theme-${theme} ${mode === 'dark' ? 'mode-dark' : 'mode-light'}`;
}

function applySettings(s) {
  // Download
  if (s.downloadPath !== undefined) safeSet('sDownloadPath', s.downloadPath);
  if (s.speedLimit !== undefined) safeSetSelect('sSpeedLimit', s.speedLimit);
  if (s.concurrentFragments !== undefined) safeSet('sConcurrentFragments', s.concurrentFragments);
  if (s.retries !== undefined) safeSet('sRetries', s.retries);
  if (s.maxConcurrentDownloads !== undefined) safeSet('sMaxConcurrent', s.maxConcurrentDownloads);
  if (s.outputTemplate !== undefined) safeSet('sOutputTemplate', s.outputTemplate);
  if (s.audioFormat !== undefined) safeSetSelect('sAudioFormat', s.audioFormat);
  if (s.audioQuality !== undefined) safeSet('sAudioQuality', s.audioQuality);
  if (s.noOverwrites !== undefined) safeCheck('sNoOverwrites', s.noOverwrites);
  if (s.continueDownload !== undefined) safeCheck('sContinueDownload', s.continueDownload);
  // Network
  if (s.proxy !== undefined) safeSet('sProxy', s.proxy);
  if (s.socketTimeout !== undefined) safeSet('sSocketTimeout', s.socketTimeout);
  if (s.xffBypass !== undefined) safeSetSelect('sXffBypass', s.xffBypass);
  if (s.forceIPv4 !== undefined) safeCheck('sForceIPv4', s.forceIPv4);
  if (s.forceIPv6 !== undefined) safeCheck('sForceIPv6', s.forceIPv6);
  // Subtitles
  if (s.writeSubs !== undefined) safeCheck('sWriteSubs', s.writeSubs);
  if (s.writeAutoSubs !== undefined) safeCheck('sWriteAutoSubs', s.writeAutoSubs);
  if (s.embedSubs !== undefined) safeCheck('sEmbedSubs', s.embedSubs);
  if (s.subLangs !== undefined) safeSet('sSubLangs', s.subLangs);
  if (s.subFormat !== undefined) safeSetSelect('sSubFormat', s.subFormat);
  // Metadata
  if (s.embedThumbnail !== undefined) safeCheck('sEmbedThumbnail', s.embedThumbnail);
  if (s.embedMetadata !== undefined) safeCheck('sEmbedMetadata', s.embedMetadata);
  if (s.addChapters !== undefined) safeCheck('sAddChapters', s.addChapters);
  if (s.writeThumbnail !== undefined) safeCheck('sWriteThumbnail', s.writeThumbnail);
  if (s.writeInfoJson !== undefined) safeCheck('sWriteInfoJson', s.writeInfoJson);
  // SponsorBlock
  if (s.sponsorBlockRemove) {
    qsa('.sb-remove-check').forEach(c => { c.checked = s.sponsorBlockRemove.includes(c.value); });
  }
  if (s.sponsorBlockMark) {
    qsa('.sb-mark-check').forEach(c => { c.checked = s.sponsorBlockMark.includes(c.value); });
  }
  // Auth
  if (s.cookiesFromBrowser !== undefined) safeSetSelect('sCookiesBrowser', s.cookiesFromBrowser);
  if (s.username !== undefined) safeSet('sUsername', s.username);
  // Advanced
  if (s.externalDownloader !== undefined) safeSetSelect('sExternalDownloader', s.externalDownloader);
  // Theme & Mode
  if (s.theme !== undefined || s.themeMode !== undefined) {
    const t = s.theme || 'violet';
    const m = s.themeMode || 'light';
    applyTheme(t, m);
    
    const themeRadio = qs(`input[name="themeRadio"][value="${t}"]`);
    if (themeRadio) themeRadio.checked = true;
    
    const modeRadio = qs(`input[name="modeRadio"][value="${m}"]`);
    if (modeRadio) modeRadio.checked = true;
  }
}

function safeSet(id, val) { const el = qs('#' + id); if (el) el.value = val ?? ''; }
function safeSetSelect(id, val) {
  const el = qs('#' + id);
  if (!el) return;
  const opt = Array.from(el.options).find(o => o.value === String(val));
  if (opt) el.value = val;
}
function safeCheck(id, val) { const el = qs('#' + id); if (el) el.checked = !!val; }

function collectSettings() {
  return {
    downloadPath: qs('#sDownloadPath').value.trim(),
    speedLimit: qs('#sSpeedLimit').value,
    concurrentFragments: parseInt(qs('#sConcurrentFragments').value) || 1,
    retries: parseInt(qs('#sRetries').value) || 10,
    maxConcurrentDownloads: parseInt(qs('#sMaxConcurrent').value) || 3,
    outputTemplate: qs('#sOutputTemplate').value.trim() || '%(title)s.%(ext)s',
    audioFormat: qs('#sAudioFormat').value,
    audioQuality: qs('#sAudioQuality').value,
    noOverwrites: qs('#sNoOverwrites').checked,
    continueDownload: qs('#sContinueDownload').checked,
    // Network
    proxy: qs('#sProxy').value.trim(),
    socketTimeout: parseInt(qs('#sSocketTimeout').value) || 30,
    xffBypass: qs('#sXffBypass').value,
    forceIPv4: qs('#sForceIPv4').checked,
    forceIPv6: qs('#sForceIPv6').checked,
    // Subtitles
    writeSubs: qs('#sWriteSubs').checked,
    writeAutoSubs: qs('#sWriteAutoSubs').checked,
    embedSubs: qs('#sEmbedSubs').checked,
    subLangs: qs('#sSubLangs').value.trim() || 'en',
    subFormat: qs('#sSubFormat').value,
    // Metadata
    embedThumbnail: qs('#sEmbedThumbnail').checked,
    embedMetadata: qs('#sEmbedMetadata').checked,
    addChapters: qs('#sAddChapters').checked,
    writeThumbnail: qs('#sWriteThumbnail').checked,
    writeInfoJson: qs('#sWriteInfoJson').checked,
    // SponsorBlock
    sponsorBlockRemove: qsa('.sb-remove-check:checked').map(c => c.value),
    sponsorBlockMark: qsa('.sb-mark-check:checked').map(c => c.value),
    // Auth
    cookiesFromBrowser: qs('#sCookiesBrowser').value,
    username: qs('#sUsername').value.trim(),
    password: qs('#sPassword').value,
    // Advanced
    externalDownloader: qs('#sExternalDownloader') ? qs('#sExternalDownloader').value : 'native',
    // Theme
    theme: qs('input[name="themeRadio"]:checked')?.value || 'violet',
    themeMode: qs('input[name="modeRadio"]:checked')?.value || 'light',
  };
}

qs('#saveAllSettingsBtn').addEventListener('click', async () => {
  const s = collectSettings();
  try {
    const res = await fetch(API.settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    });
    if (res.ok) {
      toast('Settings saved!', 'success');
      applyTheme(s.theme, s.themeMode);
    } else {
      toast('Failed to save settings', 'error');
    }
  } catch {
    toast('Network error', 'error');
  }
});

// Theme picker live preview
qsa('input[name="themeRadio"]').forEach(r => {
  r.addEventListener('change', () => {
    const activeMode = qs('input[name="modeRadio"]:checked')?.value || 'light';
    applyTheme(r.value, activeMode);
  });
});

// Mode picker live preview
qsa('input[name="modeRadio"]').forEach(r => {
  r.addEventListener('change', () => {
    const activeTheme = qs('input[name="themeRadio"]:checked')?.value || 'violet';
    applyTheme(activeTheme, r.value);
  });
});

// ─── yt-dlp Updater ───────────────────────────────────────────

qs('#updateCoreBtn').addEventListener('click', async () => {
  const wrapper = qs('#updateProgressWrapper');
  const console_ = qs('#updateConsole');
  wrapper.style.display = '';
  console_.textContent = 'Connecting to pip...\n';

  try {
    const res = await fetch(API.update, { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console_.textContent += decoder.decode(value);
      console_.scrollTop = console_.scrollHeight;
    }
  } catch (err) {
    console_.textContent += `\nError: ${err.message}`;
  }
});

// ─── Sidebar Navigation ───────────────────────────────────────

qsa('.nav-item').forEach(item => {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
});

qs('#hamburgerBtn').addEventListener('click', () => {
  if (qs('#sidebar').classList.contains('open')) closeMobileSidebar();
  else openMobileSidebar();
});

// ─── System Info ──────────────────────────────────────────────

async function loadSysInfo() {
  try {
    const res = await fetch(API.sysinfo);
    const data = await res.json();
    qs('#sysYtdlp').textContent = data.ytdlp || '?';
    qs('#sysFfmpeg').textContent = data.ffmpeg ? (data.ffmpegVersion || 'OK') : 'Missing ⚠';
    qs('#sysFfmpeg').style.color = data.ffmpeg ? '#22c55e' : '#ef4444';
    qs('#sysNode').textContent = data.node || '?';
  } catch {
    qs('#sysYtdlp').textContent = 'unavail.';
  }
}

// ─── Sidebar Update Buttons ───────────────────────────────────

function showSidebarUpdateLog(title) {
  const log = qs('#sysUpdateLog');
  qs('#sysUpdateLogTitle').textContent = title;
  qs('#sysUpdateLogContent').textContent = '';
  log.style.display = '';
  log.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideSidebarUpdateLog() {
  qs('#sysUpdateLog').style.display = 'none';
}

async function runSidebarUpdate(btnEl, title, endpoint) {
  btnEl.disabled = true;
  btnEl.classList.add('spinning');
  showSidebarUpdateLog(title);

  const logEl = qs('#sysUpdateLogContent');

  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      logEl.textContent += decoder.decode(value);
      logEl.scrollTop = logEl.scrollHeight;
    }

    // Reload sys info after update
    setTimeout(loadSysInfo, 1500);
    toast(`${title} complete!`, 'success');
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    toast(`${title} failed`, 'error');
  } finally {
    btnEl.disabled = false;
    btnEl.classList.remove('spinning');
  }
}

qs('#updateYtdlpBtn').addEventListener('click', () => {
  runSidebarUpdate(qs('#updateYtdlpBtn'), 'Updating yt-dlp...', API.update);
});

qs('#updateFfmpegBtn').addEventListener('click', () => {
  runSidebarUpdate(qs('#updateFfmpegBtn'), 'Updating ffmpeg...', '/api/update-ffmpeg');
});

qs('#closeUpdateLog').addEventListener('click', hideSidebarUpdateLog);

// ─── Init ─────────────────────────────────────────────────────

function init() {
  connectWS();
  loadSysInfo();
  navigateTo('dashboard');
}

init();
