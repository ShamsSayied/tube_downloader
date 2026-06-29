/**
 * Tube Downloader — Electron Desktop App Frontend
 * Handles: IPC communication, SPA routing, download modal (4 tabs), settings (7 tabs),
 * speed graphs, toast notifications, theme switching, and all yt-dlp options.
 *
 * Replaces the old WebSocket + fetch() architecture with Electron IPC via window.electronAPI.
 */

'use strict';

// ─── Constants & State ────────────────────────────────────────

const api = window.electronAPI;

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

function formatSecondsToHHMMSS(totalSeconds) {
  if (isNaN(totalSeconds) || totalSeconds < 0) return '00:00:00';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseHHMMSSToSeconds(str) {
  if (!str || typeof str !== 'string') return 0;
  const clean = str.replace('*', '').trim();
  if (!clean) return 0;
  const parts = clean.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
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

// ─── IPC Event Listeners (Main → Renderer) ────────────────────

function setupIPCListeners() {
  api.onInitData((data) => {
    appState.active = data.active || [];
    appState.completed = data.completed || [];
    if (data.settings) { appState.settings = data.settings; applySettings(data.settings); }
    renderActiveDownloads();
    renderCompletedDownloads();
    updateStats();
  });

  api.onDownloadAdded((download) => {
    if (download) {
      appState.active = appState.active.filter(d => d.id !== download.id);
      appState.active.unshift(download);
      addOrUpdateActiveCard(download);
      updateStats();
      navigateTo('downloads');
    }
  });

  api.onDownloadUpdate((download) => {
    if (download) {
      const idx = appState.active.findIndex(d => d.id === download.id);
      if (idx !== -1) appState.active[idx] = download;
      else appState.active.unshift(download);
      updateActiveCard(download);
      updateStats();
    }
  });

  api.onDownloadCompleted((data) => {
    appState.active = appState.active.filter(d => d.id !== data.activeId);
    if (data.download) appState.completed.unshift(data.download);
    removeActiveCard(data.activeId);
    addCompletedCard(data.download);
    updateStats();
    toast(`✅ "${escapeHtml(data.download.title.substring(0, 50))}" downloaded!`, 'success');
  });

  api.onDownloadFailed((download) => {
    if (download) {
      const idx = appState.active.findIndex(d => d.id === download.id);
      if (idx !== -1) appState.active[idx] = download;
      updateActiveCard(download);
      toast(`❌ Download failed: ${escapeHtml((download.error || 'Unknown error').substring(0, 80))}`, 'error', 5000);
    }
  });

  api.onDownloadRemoved((data) => {
    appState.active = appState.active.filter(d => d.id !== data.id);
    removeActiveCard(data.id);
    updateStats();
  });

  api.onCompletedRemoved((data) => {
    appState.completed = appState.completed.filter(d => d.id !== data.id);
    removeCompletedCard(data.id);
    updateStats();
  });

  api.onSettingsChanged((newSettings) => {
    if (newSettings) { appState.settings = newSettings; applySettings(newSettings); }
  });

  api.onWindowMaximized((maximized) => {
    const maxBtn = qs('#titlebarMaxBtn');
    if (maxBtn) {
      maxBtn.innerHTML = maximized
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1"/><path d="M9 1h12a2 2 0 0 1 2 2v12"/></svg>'
        : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
    }
  });

  // Connection status: always connected in Electron
  setConnStatus(true);
}

function setConnStatus(online) {
  const status = qs('#connStatus');
  const dot = qs('#mobileConnDot');
  if (online) {
    status.className = 'conn-status connected';
    qs('#connText').textContent = 'Ready';
    if (dot) { dot.className = 'mobile-conn-dot connected'; }
  } else {
    status.className = 'conn-status disconnected';
    qs('#connText').textContent = 'Error';
    if (dot) { dot.className = 'mobile-conn-dot'; }
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

  // Dashboard
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
  const isCutting = dl.speed && dl.speed.includes('(Cutting)');
  const isProcessing = ['merging', 'processing', 'extracting'].includes(dl.status) || isCutting;
  
  let statusLabel = 'Downloading';
  if (dl.status === 'queued') statusLabel = 'Queued';
  if (dl.status === 'paused') statusLabel = 'Paused';
  if (dl.status === 'failed') statusLabel = 'Failed';
  if (dl.status === 'merging') statusLabel = 'Merging Streams';
  if (dl.status === 'extracting') statusLabel = 'Extracting Audio';
  if (dl.status === 'processing') statusLabel = 'Finalizing';
  if (isCutting) statusLabel = 'Clipping Section';

  const canPause = dl.status === 'downloading' || dl.status === 'queued';
  const canResume = dl.status === 'paused';
  const canRetry = dl.status === 'failed';
  const pct = Math.min(100, dl.progress || 0).toFixed(1);
  const isAnimated = dl.status === 'downloading' || isProcessing;

  let processingMsg = 'Processing media... Please wait.';
  if (isCutting) processingMsg = 'Clipping video section with FFmpeg... Please wait.';
  else if (dl.status === 'merging') processingMsg = 'Merging audio & video streams into high quality container...';
  else if (dl.status === 'extracting') processingMsg = 'Extracting and converting audio track...';
  else if (dl.status === 'processing') processingMsg = 'Finalizing media metadata & chapter structures...';

  return `
    <div class="download-card-header">
      <img class="download-thumb" src="${escapeHtml(dl.thumbnail || '')}" alt="" onerror="this.style.display='none'">
      <div class="download-meta">
        <div class="download-title" title="${escapeHtml(dl.title)}">${escapeHtml(dl.title)}</div>
        <div class="download-status-row">
          <span class="status-chip ${dl.status} ${isCutting ? 'processing' : ''}">${statusLabel}</span>
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

    <div class="progress-container-row">
      <div class="progress-wrap">
        <div class="progress-fill ${isAnimated ? 'animated' : ''}" id="prog-${dl.id}" style="width:${pct}%"></div>
      </div>
      <div class="progress-percent-badge" id="progpct-${dl.id}">${pct}%</div>
    </div>

    <div class="processing-banner" id="pban-${dl.id}" style="display:${isProcessing ? 'flex' : 'none'}">
      <div class="processing-spinner"></div>
      <span id="pmsg-${dl.id}">${processingMsg}</span>
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

  const isCutting = dl.speed && dl.speed.includes('(Cutting)');
  const isProcessing = ['merging', 'processing', 'extracting'].includes(dl.status) || isCutting;

  const prog = qs(`#prog-${dl.id}`);
  const progPct = qs(`#progpct-${dl.id}`);
  const pct = Math.min(100, dl.progress || 0).toFixed(1);
  if (prog) {
    prog.style.width = pct + '%';
    prog.className = `progress-fill ${(dl.status === 'downloading' || isProcessing) ? 'animated' : ''}`;
  }
  if (progPct) progPct.textContent = pct + '%';

  const speedEl = qs(`#speed-${dl.id}`);
  const etaEl = qs(`#eta-${dl.id}`);
  const sizeEl = qs(`#size-${dl.id}`);
  if (speedEl) speedEl.textContent = dl.status === 'paused' ? '—' : (dl.speed || '—');
  if (etaEl) etaEl.textContent = dl.eta && dl.eta !== '--:--' ? 'ETA ' + dl.eta : '';
  if (sizeEl) sizeEl.textContent = dl.totalSize || '';

  const chip = card.querySelector('.status-chip');
  let statusLabel = 'Downloading';
  if (dl.status === 'queued') statusLabel = 'Queued';
  if (dl.status === 'paused') statusLabel = 'Paused';
  if (dl.status === 'failed') statusLabel = 'Failed';
  if (dl.status === 'merging') statusLabel = 'Merging Streams';
  if (dl.status === 'extracting') statusLabel = 'Extracting Audio';
  if (dl.status === 'processing') statusLabel = 'Finalizing';
  if (isCutting) statusLabel = 'Clipping Section';

  if (chip) {
    chip.className = `status-chip ${dl.status} ${isCutting ? 'processing' : ''}`;
    chip.textContent = statusLabel;
  }

  const pban = qs(`#pban-${dl.id}`);
  const pmsg = qs(`#pmsg-${dl.id}`);
  if (pban) {
    pban.style.display = isProcessing ? 'flex' : 'none';
  }
  if (pmsg && isProcessing) {
    let msg = 'Processing media... Please wait.';
    if (isCutting) msg = 'Clipping video section with FFmpeg... Please wait.';
    else if (dl.status === 'merging') msg = 'Merging audio & video streams into high quality container...';
    else if (dl.status === 'extracting') msg = 'Extracting and converting audio track...';
    else if (dl.status === 'processing') msg = 'Finalizing media metadata & chapter structures...';
    pmsg.textContent = msg;
  }

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

// ─── Time Clipper Controller ──────────────────────────────────

let timeClipperState = {
  duration: 0,
  start: 0,
  end: 0
};

function initTimeClipper(durationSec) {
  const maxSec = durationSec > 0 ? durationSec : 3600;
  timeClipperState = {
    duration: maxSec,
    start: 0,
    end: maxSec
  };

  const rangeStart = qs('#tcRangeStart');
  const rangeEnd = qs('#tcRangeEnd');

  if (rangeStart && rangeEnd) {
    rangeStart.min = 0;
    rangeStart.max = maxSec;
    rangeStart.value = 0;

    rangeEnd.min = 0;
    rangeEnd.max = maxSec;
    rangeEnd.value = maxSec;
  }

  qsa('.tc-preset-btn').forEach(b => b.classList.remove('active'));
  const fullBtn = qs('.tc-preset-btn[data-tcpreset="full"]');
  if (fullBtn) fullBtn.classList.add('active');

  updateTimeClipperUI();
}

function updateTimeClipperUI(fromInput = false) {
  const rangeStart = qs('#tcRangeStart');
  const rangeEnd = qs('#tcRangeEnd');
  const trackFill = qs('#tcTrackFill');
  const badgeStart = qs('#tcBadgeStart');
  const badgeEnd = qs('#tcBadgeEnd');
  const badgeDur = qs('#tcBadgeDuration');
  const timeStart = qs('#tcTimeStart');
  const timeEnd = qs('#tcTimeEnd');
  const dlSections = qs('#dlSections');

  if (!rangeStart || !rangeEnd) return;

  let start = parseInt(rangeStart.value) || 0;
  let end = parseInt(rangeEnd.value) || 0;
  const max = timeClipperState.duration;

  if (start > end) {
    if (document.activeElement === rangeStart) {
      start = end;
      rangeStart.value = start;
    } else {
      end = start;
      rangeEnd.value = end;
    }
  }

  timeClipperState.start = start;
  timeClipperState.end = end;

  const leftPct = max > 0 ? (start / max) * 100 : 0;
  const widthPct = max > 0 ? ((end - start) / max) * 100 : 100;

  if (trackFill) {
    trackFill.style.left = leftPct + '%';
    trackFill.style.width = widthPct + '%';
  }

  const startStr = formatSecondsToHHMMSS(start);
  const endStr = formatSecondsToHHMMSS(end);
  const diffSec = end - start;

  if (badgeStart) badgeStart.textContent = `Start: ${startStr}`;
  if (badgeEnd) badgeEnd.textContent = `End: ${endStr}`;

  if (badgeDur) {
    if (diffSec === max && start === 0) {
      badgeDur.textContent = 'Clip: Full Video';
    } else {
      const m = Math.floor(diffSec / 60);
      const s = diffSec % 60;
      badgeDur.textContent = `Clip: ${m > 0 ? m + 'm ' : ''}${s}s`;
    }
  }

  if (!fromInput) {
    if (timeStart) timeStart.value = startStr;
    if (timeEnd) timeEnd.value = endStr;
  }

  if (dlSections) {
    if (start === 0 && end === max) {
      dlSections.value = '';
    } else {
      dlSections.value = `*${startStr}-${endStr}`;
    }
  }
}

// Setup Time Clipper event listeners
function setupTimeClipperEvents() {
  const rangeStart = qs('#tcRangeStart');
  const rangeEnd = qs('#tcRangeEnd');
  const timeStart = qs('#tcTimeStart');
  const timeEnd = qs('#tcTimeEnd');

  if (rangeStart) rangeStart.addEventListener('input', () => {
    qsa('.tc-preset-btn').forEach(b => b.classList.remove('active'));
    updateTimeClipperUI();
  });
  if (rangeEnd) rangeEnd.addEventListener('input', () => {
    qsa('.tc-preset-btn').forEach(b => b.classList.remove('active'));
    updateTimeClipperUI();
  });

  if (timeStart) timeStart.addEventListener('change', () => {
    const sec = parseHHMMSSToSeconds(timeStart.value);
    if (rangeStart) rangeStart.value = Math.min(sec, timeClipperState.end);
    qsa('.tc-preset-btn').forEach(b => b.classList.remove('active'));
    updateTimeClipperUI();
  });

  if (timeEnd) timeEnd.addEventListener('change', () => {
    const sec = parseHHMMSSToSeconds(timeEnd.value);
    if (rangeEnd) rangeEnd.value = Math.max(sec, timeClipperState.start);
    qsa('.tc-preset-btn').forEach(b => b.classList.remove('active'));
    updateTimeClipperUI();
  });

  // Preset buttons
  qsa('.tc-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.tc-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const preset = btn.dataset.tcpreset;
      const max = timeClipperState.duration;
      const rStart = qs('#tcRangeStart');
      const rEnd = qs('#tcRangeEnd');

      if (!rStart || !rEnd) return;

      if (preset === 'full') {
        rStart.value = 0;
        rEnd.value = max;
      } else if (preset === 'first30') {
        rStart.value = 0;
        rEnd.value = Math.min(30, max);
      } else if (preset === 'first60') {
        rStart.value = 0;
        rEnd.value = Math.min(60, max);
      } else if (preset === 'first300') {
        rStart.value = 0;
        rEnd.value = Math.min(300, max);
      }
      updateTimeClipperUI();
    });
  });
}

// ─── Download Config Modal ────────────────────────────────────

function initPlaylistPicker(data) {
  const playlistChoiceGroup = qs('#playlistChoiceGroup');
  const playlistPickerContainer = qs('#playlistPickerContainer');
  const playlistPickerList = qs('#playlistPickerList');
  const selectedVideoCount = qs('#selectedVideoCount');

  if (!playlistChoiceGroup) return;

  if (data.type !== 'playlist') {
    playlistChoiceGroup.style.display = 'none';
    if (playlistPickerContainer) playlistPickerContainer.style.display = 'none';
    return;
  }

  playlistChoiceGroup.style.display = '';
  const countText = qs('#choicePlaylistCountText');
  if (countText) {
    countText.textContent = data.videoCount ? `All ${data.videoCount} videos` : 'All videos';
  }

  const btnChoicePlaylist = qs('#btnChoicePlaylist');
  const btnChoiceSelect = qs('#btnChoiceSelect');
  const btnChoiceSingle = qs('#btnChoiceSingle');

  // Reset cards active state to default (Entire Playlist)
  if (btnChoicePlaylist) btnChoicePlaylist.classList.add('active');
  if (btnChoiceSelect) btnChoiceSelect.classList.remove('active');
  if (btnChoiceSingle) btnChoiceSingle.classList.remove('active');
  if (playlistPickerContainer) playlistPickerContainer.style.display = 'none';

  // Populate checklist
  if (playlistPickerList) {
    playlistPickerList.innerHTML = '';
    const entries = (data.entries && data.entries.length)
      ? data.entries
      : Array.from({ length: data.videoCount || 0 }, (_, i) => ({ index: i + 1, title: `Video ${i + 1}` }));

    entries.forEach(entry => {
      const label = document.createElement('label');
      label.className = 'playlist-picker-item';
      label.innerHTML = `
        <input type="checkbox" class="pl-item-check" data-idx="${entry.index}" checked>
        <span class="playlist-picker-num">#${entry.index}</span>
        <span class="playlist-picker-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</span>
      `;
      playlistPickerList.appendChild(label);
    });

    const syncPlaylistItemsVal = () => {
      const checkedBoxes = qsa('.pl-item-check:checked');
      if (selectedVideoCount) selectedVideoCount.textContent = checkedBoxes.length;
      
      if (checkedBoxes.length === 0) {
        if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = 'none';
      } else if (checkedBoxes.length === entries.length) {
        if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = `1-${entries.length}`;
      } else {
        const indexes = checkedBoxes.map(cb => parseInt(cb.dataset.idx)).sort((a,b) => a - b);
        let ranges = [];
        let start = null, prev = null;
        for (let i = 0; i < indexes.length; i++) {
          let curr = indexes[i];
          if (start === null) { start = curr; prev = curr; }
          else if (curr === prev + 1) { prev = curr; }
          else {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
            start = curr; prev = curr;
          }
        }
        if (start !== null) ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
        if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = ranges.join(',');
      }
    };

    playlistPickerList.onchange = syncPlaylistItemsVal;
    syncPlaylistItemsVal();

    if (qs('#btnSelectAllVideos')) {
      qs('#btnSelectAllVideos').onclick = () => {
        qsa('.pl-item-check').forEach(cb => cb.checked = true);
        syncPlaylistItemsVal();
      };
    }
    if (qs('#btnDeselectAllVideos')) {
      qs('#btnDeselectAllVideos').onclick = () => {
        qsa('.pl-item-check').forEach(cb => cb.checked = false);
        syncPlaylistItemsVal();
      };
    }
  }

  // Cards click handlers
  if (btnChoicePlaylist) {
    btnChoicePlaylist.onclick = () => {
      btnChoicePlaylist.classList.add('active');
      if (btnChoiceSelect) btnChoiceSelect.classList.remove('active');
      if (btnChoiceSingle) btnChoiceSingle.classList.remove('active');
      if (playlistPickerContainer) playlistPickerContainer.style.display = 'none';
      if (qs('#dlNoPlaylist')) qs('#dlNoPlaylist').checked = false;
      if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = '';
    };
  }
  if (btnChoiceSelect) {
    btnChoiceSelect.onclick = () => {
      btnChoiceSelect.classList.add('active');
      if (btnChoicePlaylist) btnChoicePlaylist.classList.remove('active');
      if (btnChoiceSingle) btnChoiceSingle.classList.remove('active');
      if (playlistPickerContainer) playlistPickerContainer.style.display = '';
      if (qs('#dlNoPlaylist')) qs('#dlNoPlaylist').checked = false;
      syncPlaylistItemsVal();
    };
  }
  if (btnChoiceSingle) {
    btnChoiceSingle.onclick = () => {
      btnChoiceSingle.classList.add('active');
      if (btnChoicePlaylist) btnChoicePlaylist.classList.remove('active');
      if (btnChoiceSelect) btnChoiceSelect.classList.remove('active');
      if (playlistPickerContainer) playlistPickerContainer.style.display = 'none';
      if (qs('#dlNoPlaylist')) qs('#dlNoPlaylist').checked = true;
      if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = '';
    };
  }
}

function openAnalyzeModal(data) {
  currentAnalyzeResult = data;

  qs('#prevThumb').src = data.thumbnail || '';
  qs('#prevTitle').textContent = data.title || 'Unknown';
  qs('#prevChannel').textContent = data.channel || '';
  qs('#prevDuration').textContent = data.duration || '';
  qs('#prevViews').textContent = data.views ? data.views + ' views' : '';
  qs('#prevLikes').textContent = data.likes && data.likes !== 'N/A' ? data.likes + ' likes' : '';
  qs('#prevChapters').textContent = data.hasChapters ? `📚 ${data.chaptersCount} chapters` : '';
  qs('#prevSubs').textContent = data.availableSubs && data.availableSubs.length ? `🌐 ${data.availableSubs.length} subtitle tracks` : '';

  qs('#modalTitle').textContent = data.type === 'playlist' ? 'Configure Playlist Download' : 'Configure Download';

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

  formatSel.removeEventListener('change', updateFormatUI);
  formatSel.addEventListener('change', updateFormatUI);
  updateFormatUI();

  qs('#playlistOptionsGroup').style.display = data.type === 'playlist' ? '' : 'none';
  initPlaylistPicker(data);

  qs('#dlPath').value = appState.settings.downloadPath || '';

  const s = appState.settings || {};
  if (qs('#dlAudioFmt')) qs('#dlAudioFmt').value = s.audioFormat || 'mp3';
  if (qs('#dlPlaylistItems')) qs('#dlPlaylistItems').value = '';
  if (qs('#dlNoPlaylist')) qs('#dlNoPlaylist').checked = false;
  if (qs('#dlPlaylistRandom')) qs('#dlPlaylistRandom').checked = false;
  
  const durSec = data.durationSeconds || parseHHMMSSToSeconds(data.duration) || 0;
  initTimeClipper(durSec);

  if (qs('#dlOutputTemplate')) qs('#dlOutputTemplate').value = s.outputTemplate || '';
  if (qs('#dlArchive')) qs('#dlArchive').value = '';
  if (qs('#dlDateAfter')) qs('#dlDateAfter').value = '';
  if (qs('#dlDateBefore')) qs('#dlDateBefore').value = '';
  if (qs('#dlLiveFromStart')) qs('#dlLiveFromStart').checked = false;
  if (qs('#dlWaitForVideo')) qs('#dlWaitForVideo').value = '';
  if (qs('#dlExternalDownloader')) qs('#dlExternalDownloader').value = '';
  qsa('.dlsb-remove').forEach(c => { c.checked = false; });
  qsa('.dlsb-mark').forEach(c => { c.checked = false; });
  if (qs('#dlProxy')) qs('#dlProxy').value = s.proxy || '';
  if (qs('#dlCookiesBrowser')) qs('#dlCookiesBrowser').value = s.cookiesFromBrowser || '';
  if (qs('#dlForceIPv4')) qs('#dlForceIPv4').checked = !!s.forceIPv4;
  if (qs('#dlForceIPv6')) qs('#dlForceIPv6').checked = !!s.forceIPv6;
  if (qs('#dlWriteSubs')) qs('#dlWriteSubs').checked = !!s.writeSubs;
  if (qs('#dlWriteAutoSubs')) qs('#dlWriteAutoSubs').checked = !!s.writeAutoSubs;
  if (qs('#dlEmbedSubs')) qs('#dlEmbedSubs').checked = !!s.embedSubs;
  if (qs('#dlSubLangs')) qs('#dlSubLangs').value = s.subLangs || 'en';
  if (qs('#dlSubFormat')) qs('#dlSubFormat').value = s.subFormat || 'srt';
  if (qs('#dlEmbedThumbnail')) qs('#dlEmbedThumbnail').checked = !!s.embedThumbnail;
  if (qs('#dlEmbedMetadata')) qs('#dlEmbedMetadata').checked = !!s.embedMetadata;
  if (qs('#dlAddChapters')) qs('#dlAddChapters').checked = !!s.addChapters;
  if (qs('#dlWriteThumbnail')) qs('#dlWriteThumbnail').checked = !!s.writeThumbnail;

  switchModalTab('basic');
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
    audioFormat: qs('#dlAudioFmt').value,
    playlistItems: qs('#dlPlaylistItems').value.trim(),
    noPlaylist: qs('#dlNoPlaylist').checked,
    playlistRandom: qs('#dlPlaylistRandom').checked,
    downloadSections: qs('#dlSections').value.trim(),
    outputTemplate: qs('#dlOutputTemplate').value.trim(),
    downloadArchive: qs('#dlArchive').value.trim(),
    dateAfter: qs('#dlDateAfter').value,
    dateBefore: qs('#dlDateBefore').value,
    liveFromStart: qs('#dlLiveFromStart').checked,
    waitForVideo: (!isNaN(waitForVideoRaw) && waitForVideoRaw > 0) ? waitForVideoRaw : undefined,
    externalDownloader: qs('#dlExternalDownloader') ? qs('#dlExternalDownloader').value : '',
    proxy: qs('#dlProxy').value.trim(),
    cookiesFromBrowser: qs('#dlCookiesBrowser').value,
    forceIPv4: qs('#dlForceIPv4').checked,
    forceIPv6: qs('#dlForceIPv6').checked,
    writeSubs: qs('#dlWriteSubs').checked,
    writeAutoSubs: qs('#dlWriteAutoSubs').checked,
    embedSubs: qs('#dlEmbedSubs').checked,
    subLangs: qs('#dlSubLangs').value.trim() || 'en',
    subFormat: qs('#dlSubFormat').value,
    embedThumbnail: qs('#dlEmbedThumbnail').checked,
    embedMetadata: qs('#dlEmbedMetadata').checked,
    addChapters: qs('#dlAddChapters').checked,
    writeThumbnail: qs('#dlWriteThumbnail').checked,
    sponsorBlockRemove: qsa('.dlsb-remove:checked').map(c => c.value),
    sponsorBlockMark: qsa('.dlsb-mark:checked').map(c => c.value),
  };
}

// ─── Analyze Flow ─────────────────────────────────────────────

qs('#urlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let url = qs('#videoUrl').value.trim();
  if (!url) return;

  // Automatically prepend https:// if protocol is missing (e.g. user pasted 'youtube.com/...')
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  const btn = qs('#analyzeBtn');
  const spinner = qs('#analyzeSpinner');
  const btnText = btn.querySelector('.btn-text');

  btn.disabled = true;
  spinner.style.display = '';
  btnText.style.display = 'none';

  try {
    const data = await api.analyze(url);
    openAnalyzeModal({ ...data, inputUrl: url });
  } catch (err) {
    toast(err.message || 'Failed to analyze URL', 'error', 5000);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.style.display = '';
  }
});

// Paste button
qs('#pasteBtn').addEventListener('click', async () => {
  try {
    const text = await api.readClipboard();
    qs('#videoUrl').value = text;
    qs('#videoUrl').focus();
  } catch {
    toast('Cannot access clipboard', 'warning');
  }
});

// Start download
qs('#startDlBtn').addEventListener('click', async () => {
  if (!currentAnalyzeResult) return;

  // Validation for Playlist Select Mode
  const btnChoiceSelect = qs('#btnChoiceSelect');
  if (currentAnalyzeResult.type === 'playlist' && btnChoiceSelect && btnChoiceSelect.classList.contains('active')) {
    const checkedBoxes = qsa('.pl-item-check:checked');
    if (checkedBoxes.length === 0) {
      toast('Please select at least 1 video from the checklist to download', 'warning');
      return;
    }
  }

  const formatId = qs('#dlFormat').value;
  const dlPath = qs('#dlPath').value.trim();
  const advancedOptions = collectAdvancedOptions();

  const btn = qs('#startDlBtn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    await api.startDownload({
      url: currentAnalyzeResult.inputUrl || currentAnalyzeResult.url,
      formatId,
      title: currentAnalyzeResult.title || 'Unknown',
      thumbnail: currentAnalyzeResult.thumbnail || '',
      downloadPath: dlPath || undefined,
      advancedOptions
    });
    closeModal();
    qs('#videoUrl').value = '';
    toast('Download started!', 'success');
  } catch (err) {
    toast(err.message || 'Failed to start download', 'error');
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

  if (action === 'open-file') {
    if (!filePath) { toast('File path not available', 'warning'); return; }
    try {
      await api.openFile(filePath);
    } catch (err) {
      toast(err.message || 'Failed to open file', 'error', 5000);
    }
    return;
  }

  if (action === 'open-folder') {
    if (!filePath) { toast('File path not available', 'warning'); return; }
    try {
      await api.openFolder(filePath);
    } catch (err) {
      toast(err.message || 'Failed to open folder', 'error', 5000);
    }
    return;
  }

  if (['pause', 'resume', 'cancel', 'delete', 'retry'].includes(action) && id) {
    try {
      await api.downloadAction(id, action);
    } catch (err) {
      toast(err.message || 'Action failed', 'error');
    }
  }
});

// Bulk actions
qs('#bulkPauseBtn').addEventListener('click', () => api.downloadAction('all', 'pause'));
qs('#bulkResumeBtn').addEventListener('click', () => api.downloadAction('all', 'resume'));
qs('#bulkCancelBtn').addEventListener('click', () => api.downloadAction('all', 'cancel'));

// ─── Clear History ────────────────────────────────────────────

qs('#clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear all download history?')) return;
  await api.clearHistory();
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
  if (s.proxy !== undefined) safeSet('sProxy', s.proxy);
  if (s.socketTimeout !== undefined) safeSet('sSocketTimeout', s.socketTimeout);
  if (s.xffBypass !== undefined) safeSetSelect('sXffBypass', s.xffBypass);
  if (s.forceIPv4 !== undefined) safeCheck('sForceIPv4', s.forceIPv4);
  if (s.forceIPv6 !== undefined) safeCheck('sForceIPv6', s.forceIPv6);
  if (s.writeSubs !== undefined) safeCheck('sWriteSubs', s.writeSubs);
  if (s.writeAutoSubs !== undefined) safeCheck('sWriteAutoSubs', s.writeAutoSubs);
  if (s.embedSubs !== undefined) safeCheck('sEmbedSubs', s.embedSubs);
  if (s.subLangs !== undefined) safeSet('sSubLangs', s.subLangs);
  if (s.subFormat !== undefined) safeSetSelect('sSubFormat', s.subFormat);
  if (s.embedThumbnail !== undefined) safeCheck('sEmbedThumbnail', s.embedThumbnail);
  if (s.embedMetadata !== undefined) safeCheck('sEmbedMetadata', s.embedMetadata);
  if (s.addChapters !== undefined) safeCheck('sAddChapters', s.addChapters);
  if (s.writeThumbnail !== undefined) safeCheck('sWriteThumbnail', s.writeThumbnail);
  if (s.writeInfoJson !== undefined) safeCheck('sWriteInfoJson', s.writeInfoJson);
  if (s.sponsorBlockRemove) {
    qsa('.sb-remove-check').forEach(c => { c.checked = s.sponsorBlockRemove.includes(c.value); });
  }
  if (s.sponsorBlockMark) {
    qsa('.sb-mark-check').forEach(c => { c.checked = s.sponsorBlockMark.includes(c.value); });
  }
  if (s.cookiesFromBrowser !== undefined) safeSetSelect('sCookiesBrowser', s.cookiesFromBrowser);
  if (s.username !== undefined) safeSet('sUsername', s.username);
  if (s.externalDownloader !== undefined) safeSetSelect('sExternalDownloader', s.externalDownloader);
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
    concurrentFragments: parseInt(qs('#sConcurrentFragments').value) || 8,
    retries: parseInt(qs('#sRetries').value) || 10,
    maxConcurrentDownloads: parseInt(qs('#sMaxConcurrent').value) || 3,
    outputTemplate: qs('#sOutputTemplate').value.trim() || '%(title)s.%(ext)s',
    audioFormat: qs('#sAudioFormat').value,
    audioQuality: qs('#sAudioQuality').value,
    noOverwrites: qs('#sNoOverwrites').checked,
    continueDownload: qs('#sContinueDownload').checked,
    proxy: qs('#sProxy').value.trim(),
    socketTimeout: parseInt(qs('#sSocketTimeout').value) || 30,
    xffBypass: qs('#sXffBypass').value,
    forceIPv4: qs('#sForceIPv4').checked,
    forceIPv6: qs('#sForceIPv6').checked,
    writeSubs: qs('#sWriteSubs').checked,
    writeAutoSubs: qs('#sWriteAutoSubs').checked,
    embedSubs: qs('#sEmbedSubs').checked,
    subLangs: qs('#sSubLangs').value.trim() || 'en',
    subFormat: qs('#sSubFormat').value,
    embedThumbnail: qs('#sEmbedThumbnail').checked,
    embedMetadata: qs('#sEmbedMetadata').checked,
    addChapters: qs('#sAddChapters').checked,
    writeThumbnail: qs('#sWriteThumbnail').checked,
    writeInfoJson: qs('#sWriteInfoJson').checked,
    sponsorBlockRemove: qsa('.sb-remove-check:checked').map(c => c.value),
    sponsorBlockMark: qsa('.sb-mark-check:checked').map(c => c.value),
    cookiesFromBrowser: qs('#sCookiesBrowser').value,
    username: qs('#sUsername').value.trim(),
    password: qs('#sPassword').value,
    externalDownloader: qs('#sExternalDownloader') ? qs('#sExternalDownloader').value : 'native',
    theme: qs('input[name="themeRadio"]:checked')?.value || 'violet',
    themeMode: qs('input[name="modeRadio"]:checked')?.value || 'light',
  };
}

qs('#saveAllSettingsBtn').addEventListener('click', async () => {
  const s = collectSettings();
  try {
    await api.saveSettings(s);
    toast('Settings saved!', 'success');
    applyTheme(s.theme, s.themeMode);
  } catch {
    toast('Failed to save settings', 'error');
  }
});

// Theme picker live preview
qsa('input[name="themeRadio"]').forEach(r => {
  r.addEventListener('change', () => {
    const activeMode = qs('input[name="modeRadio"]:checked')?.value || 'light';
    applyTheme(r.value, activeMode);
  });
});

qsa('input[name="modeRadio"]').forEach(r => {
  r.addEventListener('change', () => {
    const activeTheme = qs('input[name="themeRadio"]:checked')?.value || 'violet';
    applyTheme(activeTheme, r.value);
  });
});

// ─── Browse button for download path ──────────────────────────

const browseBtn = qs('#browseDlPath');
if (browseBtn) {
  browseBtn.addEventListener('click', async () => {
    const dir = await api.selectDirectory();
    if (dir) qs('#dlPath').value = dir;
  });
}

const browseSettingsBtn = qs('#browseSettingsPath');
if (browseSettingsBtn) {
  browseSettingsBtn.addEventListener('click', async () => {
    const dir = await api.selectDirectory();
    if (dir) qs('#sDownloadPath').value = dir;
  });
}

// ─── yt-dlp Updater ───────────────────────────────────────────

qs('#updateCoreBtn').addEventListener('click', async () => {
  const wrapper = qs('#updateProgressWrapper');
  const console_ = qs('#updateConsole');
  wrapper.style.display = '';
  console_.textContent = 'Starting yt-dlp update...\n';

  // Listen for update log messages
  const cleanup = api.onUpdateLog((data) => {
    console_.textContent += data.text;
    console_.scrollTop = console_.scrollHeight;
  });

  try {
    await api.updateYtdlp();
    loadSysInfo();
  } catch (err) {
    console_.textContent += `\nError: ${err.message}`;
  } finally {
    cleanup();
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
    const data = await api.getSysInfo();
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

async function runSidebarUpdate(btnEl, type, title) {
  btnEl.disabled = true;
  btnEl.classList.add('spinning');
  showSidebarUpdateLog(title);

  const logEl = qs('#sysUpdateLogContent');

  const cleanup = api.onUpdateLog((data) => {
    logEl.textContent += data.text;
    logEl.scrollTop = logEl.scrollHeight;
  });

  try {
    if (type === 'ytdlp') {
      await api.updateYtdlp();
    } else if (type === 'ffmpeg') {
      await api.updateFfmpeg();
    }
    setTimeout(loadSysInfo, 1500);
    toast(`${title} complete!`, 'success');
  } catch (err) {
    logEl.textContent += `\nError: ${err.message}`;
    toast(`${title} failed`, 'error');
  } finally {
    cleanup(); // Clean up event listener to prevent duplicates and memory leaks
    btnEl.disabled = false;
    btnEl.classList.remove('spinning');
  }
}

qs('#updateYtdlpBtn').addEventListener('click', () => {
  runSidebarUpdate(qs('#updateYtdlpBtn'), 'ytdlp', 'Updating yt-dlp...');
});

qs('#updateFfmpegBtn').addEventListener('click', () => {
  runSidebarUpdate(qs('#updateFfmpegBtn'), 'ffmpeg', 'Updating FFmpeg...');
});

qs('#closeUpdateLog').addEventListener('click', hideSidebarUpdateLog);

// ─── Window Controls (Custom Titlebar) ────────────────────────

qs('#titlebarMinBtn')?.addEventListener('click', () => api.windowMinimize());
qs('#titlebarMaxBtn')?.addEventListener('click', () => api.windowMaximize());
qs('#titlebarCloseBtn')?.addEventListener('click', () => api.windowClose());

// ─── External Links ───────────────────────────────────────────

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="http"]');
  if (link) {
    e.preventDefault();
    api.openExternal(link.href);
  }
});

// ─── Init ─────────────────────────────────────────────────────

async function init() {
  setupIPCListeners();
  setupTimeClipperEvents();
  loadSysInfo();
  navigateTo('dashboard');

  // Request initial data
  try {
    const data = await api.requestInitData();
    appState.active = data.active || [];
    appState.completed = data.completed || [];
    if (data.settings) { appState.settings = data.settings; applySettings(data.settings); }
    renderActiveDownloads();
    renderCompletedDownloads();
    updateStats();
  } catch (err) {
    console.error('Failed to get init data:', err);
  }
}

init();
