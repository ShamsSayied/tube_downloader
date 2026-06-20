const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, exec, spawnSync } = require('child_process');
const os = require('os');

// ─── Python Environment Detection ────────────────────────────────────────────
let PYTHON_CMD = 'python';
let IS_VIRTUALENV = false;

function detectPython() {
  const commands = ['python', 'py', 'python3'];
  for (const cmd of commands) {
    try {
      const res = spawnSync(cmd, ['-c', 'import sys; print(sys.prefix != sys.base_prefix)'], { timeout: 1000 });
      if (res.status === 0) {
        PYTHON_CMD = cmd;
        IS_VIRTUALENV = res.stdout.toString().trim() === 'True';
        console.log(`Python command detected: "${cmd}" (VirtualEnv: ${IS_VIRTUALENV})`);
        return;
      }
    } catch (e) {
      // try next
    }
  }
  console.warn('Warning: Python was not detected on this system. Downloads may fail.');
}
detectPython();

// ─── Process Tree Termination (Windows-safe) ──────────────────────────────────
function killProcessTree(proc) {
  if (!proc) return;
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
      if (err) {
        console.error(`Failed to taskkill process ${proc.pid}:`, err);
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
    });
  } else {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ─── Persistent Storage ──────────────────────────────────────────────────────

const HISTORY_FILE = path.join(__dirname, 'downloads.json');
let completedDownloads = [];

if (fs.existsSync(HISTORY_FILE)) {
  try {
    completedDownloads = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading downloads.json:', err);
    completedDownloads = [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(completedDownloads, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing downloads.json:', err);
  }
}

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  // Download
  downloadPath: path.join(os.homedir(), 'Downloads'),
  maxConcurrentDownloads: 3,
  defaultFormat: 'bestvideo+bestaudio/best',
  speedLimit: 'unlimited',
  concurrentFragments: 1,
  retries: 10,
  outputTemplate: '%(title)s.%(ext)s',
  noOverwrites: false,
  continueDownload: true,
  // Network
  proxy: '',
  forceIPv4: false,
  forceIPv6: false,
  xffBypass: 'default',
  socketTimeout: 30,
  // Subtitles
  writeSubs: false,
  embedSubs: false,
  writeAutoSubs: false,
  subLangs: 'en',
  subFormat: 'srt',
  // Metadata
  embedThumbnail: true,
  embedMetadata: true,
  addChapters: false,
  writeInfoJson: false,
  writeThumbnail: false,
  // Post-processing
  audioFormat: '',
  audioQuality: '5',
  // SponsorBlock
  sponsorBlockRemove: [],
  sponsorBlockMark: [],
  // Auth
  cookiesFromBrowser: '',
  username: '',
  password: '',
  // Advanced
  externalDownloader: 'native',
  // UI
  theme: 'violet',
  themeMode: 'light'
};

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = { ...DEFAULT_SETTINGS };

if (fs.existsSync(SETTINGS_FILE)) {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (e) {
    console.error('Error reading settings.json:', e);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving settings.json:', e);
  }
}

// ─── In-Memory State ──────────────────────────────────────────────────────────

const activeDownloads = {};

// ─── Express Middleware ───────────────────────────────────────────────────────

// CSRF / Cross-Origin Request Validation (Local Server Security)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname !== 'localhost' && originUrl.hostname !== '127.0.0.1') {
        return res.status(403).json({ error: 'Access forbidden: unauthorized origin' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'Access forbidden: invalid origin header' });
    }
  }
  
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.hostname !== 'localhost' && refererUrl.hostname !== '127.0.0.1') {
        return res.status(403).json({ error: 'Access forbidden: unauthorized referer' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'Access forbidden: invalid referer header' });
    }
  }
  
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket ────────────────────────────────────────────────────────────────

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname !== 'localhost' && originUrl.hostname !== '127.0.0.1') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch (e) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function serializeDownload(id) {
  const dl = activeDownloads[id];
  if (!dl) return null;
  return {
    id: dl.id,
    url: dl.url,
    title: dl.title,
    thumbnail: dl.thumbnail,
    status: dl.status,
    progress: dl.progress,
    speed: dl.speed,
    eta: dl.eta,
    totalSize: dl.totalSize,
    format: dl.format,
    downloadPath: dl.downloadPath,
    filePath: dl.filePath,
    error: dl.error,
    advancedOptions: dl.advancedOptions
  };
}

wss.on('connection', (ws) => {
  const activeList = Object.keys(activeDownloads).map(id => serializeDownload(id));
  ws.send(JSON.stringify({
    type: 'init',
    active: activeList,
    completed: completedDownloads,
    settings: settings
  }));
});

let lastBroadcastTimes = {};
function throttleBroadcast(id, force = false) {
  const now = Date.now();
  if (force || !lastBroadcastTimes[id] || now - lastBroadcastTimes[id] > 350) {
    lastBroadcastTimes[id] = now;
    broadcast({ type: 'update', download: serializeDownload(id) });
  }
}

// ─── Build yt-dlp argument list from advanced options ─────────────────────────

function buildYtDlpArgs(dl) {
  const opts = dl.advancedOptions || {};
  const isAudioOnlyMp3 = dl.format === 'bestaudio/best' && (!opts.audioFormat || opts.audioFormat === 'mp3');
  const isAudioExtract = dl.format === 'bestaudio/best';
  const outputTemplate = opts.outputTemplate || settings.outputTemplate || '%(title)s.%(ext)s';
  const downloadPath = dl.downloadPath;

  const args = [
    '-m', 'yt_dlp',
    '--newline',
    '--progress-template',
    'download-progress:%(progress._percent_str)s speed:%(progress._speed_str)s eta:%(progress._eta_str)s size:%(progress._total_bytes_str)s',
  ];

  // ── Format ───────────────────────────────────────────────────────────────────
  args.push('-f', dl.format === 'bestaudio/best-m4a' ? 'bestaudio[ext=m4a]/bestaudio' : dl.format);

  // ── Speed Limit ───────────────────────────────────────────────────────────────
  const speedLimit = opts.speedLimit || settings.speedLimit;
  if (speedLimit && speedLimit !== 'unlimited') {
    args.push('--limit-rate', speedLimit);
  }

  // ── Concurrent Fragments ──────────────────────────────────────────────────────
  const fragments = parseInt(opts.concurrentFragments || settings.concurrentFragments) || 1;
  if (fragments > 1) {
    args.push('-N', String(fragments));
  }

  // ── Retries ────────────────────────────────────────────────────────────────────
  const retries = opts.retries || settings.retries || 10;
  args.push('--retries', String(retries));
  args.push('--fragment-retries', String(retries));

  // ── No Overwrites ─────────────────────────────────────────────────────────────
  if (opts.noOverwrites || settings.noOverwrites) {
    args.push('--no-overwrites');
  }

  // ── Continue / Resume ─────────────────────────────────────────────────────────
  const continueDownload = opts.continueDownload !== undefined ? opts.continueDownload : settings.continueDownload;
  if (continueDownload === false) {
    args.push('--no-continue');
  } else {
    args.push('--continue');
  }

  // ── Network / Proxy ───────────────────────────────────────────────────────────
  const proxy = opts.proxy || settings.proxy;
  if (proxy) {
    args.push('--proxy', proxy);
  }

  const socketTimeout = opts.socketTimeout || settings.socketTimeout;
  if (socketTimeout && socketTimeout !== 30) {
    args.push('--socket-timeout', String(socketTimeout));
  }

  if (opts.forceIPv4 || settings.forceIPv4) {
    args.push('--force-ipv4');
  } else if (opts.forceIPv6 || settings.forceIPv6) {
    args.push('--force-ipv6');
  }

  const xffBypass = opts.xffBypass || settings.xffBypass;
  if (xffBypass && xffBypass !== 'default') {
    args.push('--xff', xffBypass);
  }

  // ── Subtitles ─────────────────────────────────────────────────────────────────
  const writeSubs = opts.writeSubs !== undefined ? opts.writeSubs : settings.writeSubs;
  const writeAutoSubs = opts.writeAutoSubs !== undefined ? opts.writeAutoSubs : settings.writeAutoSubs;
  const embedSubs = opts.embedSubs !== undefined ? opts.embedSubs : settings.embedSubs;
  const subLangs = opts.subLangs || settings.subLangs || 'en';
  const subFormat = opts.subFormat || settings.subFormat || 'srt';

  if (writeSubs || embedSubs) {
    args.push('--write-subs');
    args.push('--sub-langs', subLangs);
    args.push('--convert-subs', subFormat);
  }
  if (writeAutoSubs) {
    args.push('--write-auto-subs');
    args.push('--sub-langs', subLangs);
  }
  if (embedSubs && !isAudioExtract) {
    args.push('--embed-subs');
  }

  // ── Download Sections (time range clips) ──────────────────────────────────────
  if (opts.downloadSections) {
    const sections = opts.downloadSections.split(',').map(s => s.trim()).filter(Boolean);
    for (const section of sections) {
      args.push('--download-sections', section);
    }
  }

  // ── Playlist ──────────────────────────────────────────────────────────────────
  if (opts.noPlaylist) {
    args.push('--no-playlist');
  } else if (opts.playlistItems) {
    args.push('--playlist-items', opts.playlistItems);
  }
  if (opts.playlistRandom) {
    args.push('--playlist-random');
  }

  // ── Date filtering ────────────────────────────────────────────────────────────
  // yt-dlp expects YYYYMMDD — HTML date inputs return YYYY-MM-DD
  if (opts.dateAfter) args.push('--dateafter', opts.dateAfter.replace(/-/g, ''));
  if (opts.dateBefore) args.push('--datebefore', opts.dateBefore.replace(/-/g, ''));

  // ── Download Archive ──────────────────────────────────────────────────────────
  if (opts.downloadArchive) {
    args.push('--download-archive', opts.downloadArchive);
  }

  // ── Metadata ──────────────────────────────────────────────────────────────────
  const embedThumbnail = opts.embedThumbnail !== undefined ? opts.embedThumbnail : settings.embedThumbnail;
  const embedMetadata = opts.embedMetadata !== undefined ? opts.embedMetadata : settings.embedMetadata;
  const addChapters = opts.addChapters !== undefined ? opts.addChapters : settings.addChapters;
  const writeInfoJson = opts.writeInfoJson !== undefined ? opts.writeInfoJson : settings.writeInfoJson;
  const writeThumbnail = opts.writeThumbnail !== undefined ? opts.writeThumbnail : settings.writeThumbnail;

  if (embedThumbnail) args.push('--embed-thumbnail');
  if (embedMetadata) args.push('--embed-metadata');
  if (addChapters) args.push('--add-chapters');
  if (writeInfoJson) args.push('--write-info-json');
  if (writeThumbnail) args.push('--write-thumbnail');

  // ── SponsorBlock ──────────────────────────────────────────────────────────────
  const sbRemove = (opts.sponsorBlockRemove && opts.sponsorBlockRemove.length)
    ? opts.sponsorBlockRemove
    : (settings.sponsorBlockRemove && settings.sponsorBlockRemove.length ? settings.sponsorBlockRemove : []);
  const sbMark = (opts.sponsorBlockMark && opts.sponsorBlockMark.length)
    ? opts.sponsorBlockMark
    : (settings.sponsorBlockMark && settings.sponsorBlockMark.length ? settings.sponsorBlockMark : []);

  if (sbRemove.length > 0) {
    args.push('--sponsorblock-remove', sbRemove.join(','));
  }
  if (sbMark.length > 0) {
    args.push('--sponsorblock-mark', sbMark.join(','));
  }

  // ── Authentication ────────────────────────────────────────────────────────────
  const cookiesBrowser = opts.cookiesFromBrowser || settings.cookiesFromBrowser;
  if (cookiesBrowser) {
    args.push('--cookies-from-browser', cookiesBrowser);
  }
  const username = opts.username || settings.username;
  const password = opts.password || settings.password;
  if (username) {
    args.push('--username', username);
    if (password) args.push('--password', password);
  }

  // ── Output template & container ───────────────────────────────────────────────
  if (isAudioExtract) {
    const audioFmt = opts.audioFormat || settings.audioFormat || 'mp3';
    const audioQuality = opts.audioQuality || settings.audioQuality || '5';
    args.push('--extract-audio', '--audio-format', audioFmt, '--audio-quality', audioQuality);
    args.push('-o', path.join(downloadPath, outputTemplate));
  } else {
    args.push('--merge-output-format', 'mp4');
    args.push('--remux-video', 'mp4');
    args.push('-o', path.join(downloadPath, outputTemplate));
  }

  // ── External downloader ───────────────────────────────────────────────────────
  const extDownloader = opts.externalDownloader || settings.externalDownloader || 'native';
  if (extDownloader && extDownloader !== 'native') {
    args.push('--downloader', extDownloader);
  }

  // ── Live stream options ───────────────────────────────────────────────────────
  if (opts.liveFromStart) {
    args.push('--live-from-start');
  }
  if (opts.waitForVideo) {
    args.push('--wait-for-video', String(opts.waitForVideo));
  }

  args.push(dl.url);

  return args;
}

// ─── Queue Management ────────────────────────────────────────────────────────

function checkQueue() {
  const limit = settings.maxConcurrentDownloads || 3;
  const running = Object.values(activeDownloads).filter(d =>
    ['downloading', 'merging', 'processing', 'extracting'].includes(d.status)
  ).length;
  if (running >= limit) return;
  // Start the oldest queued download that hasn't spawned a process yet
  const next = Object.values(activeDownloads).find(d => d.status === 'queued' && !d.process);
  if (next) startYtDlpProcess(next.id);
}

// ─── Start yt-dlp Download Process ───────────────────────────────────────────

function startYtDlpProcess(id) {
  const dl = activeDownloads[id];
  if (!dl) return;

  // ── Concurrent Download Limit ─────────────────────────────────
  const running = Object.values(activeDownloads).filter(d =>
    ['downloading', 'merging', 'processing', 'extracting'].includes(d.status)
  ).length;
  const limit = settings.maxConcurrentDownloads || 3;
  if (running >= limit) {
    dl.status = 'queued';
    throttleBroadcast(id, true);
    return;
  }

  const args = buildYtDlpArgs(dl);
  const isAudioExtract = dl.format === 'bestaudio/best';
  const audioFmt = (dl.advancedOptions && dl.advancedOptions.audioFormat) || settings.audioFormat || 'mp3';

  console.log(`Spawning yt-dlp: ${PYTHON_CMD} ${args.join(' ')}`);

  const child = spawn(PYTHON_CMD, args, {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    }
  });
  
  child.on('error', (err) => {
    console.error(`Download process spawn error [${id}]:`, err);
    dl.status = 'failed';
    dl.error = `Failed to start download process: ${err.message}`;
    broadcast({ type: 'failed', download: serializeDownload(id) });
  });

  dl.process = child;
  dl.status = 'downloading';
  dl.error = null;

  let buffer = '';

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split(/[\r\n]+/);
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('download-progress:')) {
        // Size field is optional — yt-dlp outputs "NA" until file size is known
        const match = trimmed.match(/download-progress:\s*([0-9.]+)%\s*speed:\s*([^\s]+)\s*eta:\s*([^\s]+)(?:\s*size:\s*([^\s]+))?/);
        if (match) {
          dl.progress = parseFloat(match[1]);
          dl.speed = (!match[2] || match[2] === 'Unknown' || match[2] === 'NA') ? 'Calculating...' : match[2];
          dl.eta = (!match[3] || match[3] === 'Unknown' || match[3] === 'NA') ? '--:--' : match[3];
          if (match[4] && match[4] !== 'NA' && match[4] !== 'Unknown') dl.totalSize = match[4];
          throttleBroadcast(id);
        }
      } else if (trimmed.includes('[download] Destination:')) {
        const m = trimmed.match(/\[download\] Destination:\s*(.*)/);
        if (m) dl.filePath = m[1].trim();
      } else if (trimmed.includes('has already been downloaded')) {
        const m = trimmed.match(/\[download\]\s*(.*)\s*has already been downloaded/);
        if (m) { dl.filePath = m[1].trim(); dl.progress = 100; }
      } else if (trimmed.includes('[Merger] Merging formats into')) {
        const m = trimmed.match(/\[Merger\] Merging formats into\s*"(.*)"/);
        if (m) dl.filePath = m[1].trim();
        dl.status = 'merging';
        dl.progress = 100;
        throttleBroadcast(id, true);
      } else if (trimmed.includes('[ExtractAudio] Destination:')) {
        const m = trimmed.match(/\[ExtractAudio\] Destination:\s*(.*)/);
        if (m) dl.filePath = m[1].trim();
        dl.status = 'extracting';
        throttleBroadcast(id, true);
      } else if (trimmed.includes('[EmbedThumbnail]') || trimmed.includes('[FFmpegMetadata]') || trimmed.includes('[SponsorBlock]')) {
        dl.status = 'processing';
        throttleBroadcast(id, true);
      }
    }
  });

  child.stderr.on('data', (data) => {
    const errLine = data.toString().trim();
    if (errLine.startsWith('ERROR:')) {
      dl.error = errLine;
      console.error(`yt-dlp error [${id}]:`, errLine);
    }
  });

  child.on('close', (code) => {
    console.log(`Download ${id} exited code ${code}`);
    if (dl.status === 'paused') return;

    if (code === 0) {
      dl.status = 'completed';
      dl.progress = 100;
      dl.speed = '0 B/s';
      dl.eta = '00:00';

      if (!dl.filePath) {
        const cleanTitle = dl.title.replace(/[\\/:*?"<>|]/g, '_');
        const ext = isAudioExtract ? audioFmt : 'mp4';
        dl.filePath = path.join(dl.downloadPath, `${cleanTitle}.${ext}`);
      }

      if (!isAudioExtract && dl.filePath.endsWith('.webm')) {
        const mp4Path = dl.filePath.slice(0, -5) + '.mp4';
        if (fs.existsSync(mp4Path)) dl.filePath = mp4Path;
      }

      const completedItem = {
        id: dl.id,
        url: dl.url,
        title: dl.title,
        thumbnail: dl.thumbnail,
        filePath: dl.filePath,
        totalSize: dl.totalSize || 'Unknown',
        format: dl.format,
        completedAt: new Date().toISOString()
      };

      completedDownloads.unshift(completedItem);
      saveHistory();
      delete activeDownloads[id];

      broadcast({ type: 'completed', download: completedItem, activeId: id });
      checkQueue();
    } else {
      dl.status = 'failed';
      if (!dl.error) dl.error = `Process exited with code ${code}`;
      broadcast({ type: 'failed', download: serializeDownload(id) });
      checkQueue();
    }
  });
}

// ─── REST API Routes ──────────────────────────────────────────────────────────

// GET /api/sysinfo — yt-dlp version + ffmpeg availability
app.get('/api/sysinfo', (req, res) => {
  const result = { ytdlp: 'Unknown', ffmpeg: false, node: process.version };
  let sent = false;
  const sendResponse = () => {
    if (sent) return;
    sent = true;
    res.json(result);
  };

  const versionCheck = spawn(PYTHON_CMD, ['-m', 'yt_dlp', '--version']);
  
  versionCheck.on('error', (err) => {
    console.error('Sysinfo spawn error:', err);
    sendResponse();
  });

  let vtxt = '';
  versionCheck.stdout.on('data', d => vtxt += d.toString());
  versionCheck.on('close', () => {
    result.ytdlp = vtxt.trim() || 'Unknown';

    exec('ffmpeg -version', (err, stdout) => {
      result.ffmpeg = !err;
      if (!err) {
        // Extract only the version number (e.g. "8.1.1" from "8.1.1-full_build-www.gyan.dev ...")
        const rawVer = (stdout.split('\n')[0] || '').replace('ffmpeg version ', '').split(' ')[0].trim();
        result.ffmpegVersion = rawVer.split('-')[0]; // strip build suffix like "-full_build-www..."
      } else {
        result.ffmpegVersion = null;
      }
      sendResponse();
    });
  });
});

// GET /api/formats — lists available yt-dlp audio/video format options
app.get('/api/formats', (req, res) => {
  res.json({
    videoFormats: [
      { id: 'bestvideo+bestaudio/best', label: 'Best Quality (auto)', ext: 'mp4' },
      { id: 'bestvideo[height<=2160]+bestaudio/best', label: '4K UHD (2160p)', ext: 'mp4' },
      { id: 'bestvideo[height<=1440]+bestaudio/best', label: '2K QHD (1440p)', ext: 'mp4' },
      { id: 'bestvideo[height<=1080]+bestaudio/best', label: 'Full HD (1080p)', ext: 'mp4' },
      { id: 'bestvideo[height<=720]+bestaudio/best', label: 'HD (720p)', ext: 'mp4' },
      { id: 'bestvideo[height<=480]+bestaudio/best', label: 'SD (480p)', ext: 'mp4' },
      { id: 'bestvideo[height<=360]+bestaudio/best', label: 'Low (360p)', ext: 'mp4' },
    ],
    audioFormats: [
      { id: 'bestaudio/best', label: 'Best Audio (converted)', ext: 'varies' },
    ],
    audioConversionFormats: ['mp3', 'aac', 'opus', 'flac', 'm4a', 'wav', 'vorbis'],
    subFormats: ['srt', 'vtt', 'ass', 'lrc'],
    browsers: ['chrome', 'firefox', 'edge', 'safari', 'opera', 'chromium', 'brave'],
    externalDownloaders: ['native', 'aria2c', 'curl', 'wget', 'ffmpeg'],
    sponsorBlockCategories: ['sponsor', 'intro', 'outro', 'selfpromo', 'preview', 'filler', 'interaction', 'music_offtopic', 'poi_highlight']
  });
});

// POST /api/analyze — video info
app.post('/api/analyze', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const args = ['-m', 'yt_dlp', '-J', '--flat-playlist', url];
  let stdoutData = '';
  let stderrData = '';
  const child = spawn(PYTHON_CMD, args, {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    }
  });

  child.on('error', (err) => {
    console.error('yt-dlp analyze spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start metadata analysis. Python or yt-dlp may be unavailable.', details: err.message });
    }
  });

  child.stdout.on('data', d => stdoutData += d.toString());
  child.stderr.on('data', d => stderrData += d.toString());

  child.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp analyze failed:', stderrData);
      return res.status(500).json({ error: 'Failed to analyze URL. Ensure it is a valid media link.', details: stderrData });
    }

    try {
      const info = JSON.parse(stdoutData);

      if (info._type === 'playlist') {
        // Try multiple thumbnail sources for playlists
        let playlistThumb = '';
        if (info.thumbnail) {
          playlistThumb = info.thumbnail;
        } else if (info.thumbnails && info.thumbnails.length) {
          playlistThumb = info.thumbnails[info.thumbnails.length - 1].url || '';
        } else if (info.entries && info.entries.length) {
          // Try first entry's thumbnail
          const firstEntry = info.entries[0];
          playlistThumb = firstEntry.thumbnail || (firstEntry.thumbnails && firstEntry.thumbnails.length ? firstEntry.thumbnails[firstEntry.thumbnails.length - 1].url : '') || '';
        }
        return res.json({
          type: 'playlist',
          title: info.title || 'Playlist',
          thumbnail: playlistThumb,
          channel: info.uploader || info.channel || info.author || 'Playlist',
          videoCount: info.entries ? info.entries.length : 0,
          url
        });
      }

      let durationStr = '--:--';
      if (info.duration) {
        const h = Math.floor(info.duration / 3600);
        const m = Math.floor((info.duration % 3600) / 60);
        const s = Math.floor(info.duration % 60);
        durationStr = h > 0
          ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
          : `${m}:${s.toString().padStart(2, '0')}`;
      }

      const availableFormats = [
        { id: 'bestvideo+bestaudio/best', label: 'Best Quality (auto)', ext: 'mp4', note: 'Highest quality available' },
      ];

      const heights = new Set();
      if (info.formats) info.formats.forEach(f => { if (f.height) heights.add(f.height); });

      [
        { height: 2160, label: '4K UHD (2160p)' },
        { height: 1440, label: '2K QHD (1440p)' },
        { height: 1080, label: 'Full HD (1080p)' },
        { height: 720, label: 'HD (720p)' },
        { height: 480, label: 'SD (480p)' },
        { height: 360, label: 'Low Quality (360p)' },
      ].forEach(({ height, label }) => {
        if (Array.from(heights).some(h => h >= height - 80 && h <= height + 80) || height <= 1080) {
          availableFormats.push({
            id: `bestvideo[height<=${height}]+bestaudio/best`,
            label,
            ext: 'mp4',
            note: 'MP4 video'
          });
        }
      });

      availableFormats.push(
        { id: 'bestaudio/best', label: 'Audio Only (MP3/AAC/etc)', ext: 'varies', note: 'Extracted audio' }
      );

      // Subtitle availability — use correct variable name throughout
      const availableSubs = [];
      if (info.subtitles) {
        for (const lang of Object.keys(info.subtitles)) {
          availableSubs.push(lang);
        }
      }
      if (info.automatic_captions) {
        for (const lang of Object.keys(info.automatic_captions)) {
          if (!availableSubs.includes(lang)) availableSubs.push(lang + ' (auto)');
        }
      }

      res.json({
        type: 'video',
        title: info.title || 'Unknown',
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
        channel: info.uploader || info.channel || info.uploader_id || 'Unknown',
        duration: durationStr,
        views: info.view_count ? info.view_count.toLocaleString() : 'N/A',
        likes: info.like_count ? info.like_count.toLocaleString() : 'N/A',
        uploadDate: info.upload_date || '',
        description: info.description ? info.description.substring(0, 200) + '...' : '',
        formats: availableFormats,
        availableSubs,
        hasChapters: !!(info.chapters && info.chapters.length),
        chaptersCount: info.chapters ? info.chapters.length : 0,
        url
      });
    } catch (err) {
      console.error('Error parsing yt-dlp JSON:', err);
      res.status(500).json({ error: 'Failed to parse video metadata.', details: err.message });
    }
  });
});

// POST /api/download — start download with full advanced options
app.post('/api/download', (req, res) => {
  const { url, formatId, title, thumbnail, downloadPath, advancedOptions } = req.body;
  if (!url || !formatId || !title) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const targetPath = downloadPath || settings.downloadPath;

  if (!fs.existsSync(targetPath)) {
    try {
      fs.mkdirSync(targetPath, { recursive: true });
    } catch (e) {
      return res.status(500).json({ error: `Cannot create download folder: ${targetPath}` });
    }
  }

  const downloadId = 'dl_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  activeDownloads[downloadId] = {
    id: downloadId,
    url,
    title,
    thumbnail: thumbnail || '',
    status: 'queued',
    progress: 0,
    speed: '0 B/s',
    eta: '--:--',
    totalSize: 'Calculating...',
    format: formatId,
    downloadPath: targetPath,
    filePath: '',
    error: null,
    process: null,
    advancedOptions: advancedOptions || {}
  };

  startYtDlpProcess(downloadId);

  res.json({ success: true, downloadId, download: serializeDownload(downloadId) });
  broadcast({ type: 'added', download: serializeDownload(downloadId) });
});

// POST /api/action — pause, resume, cancel, delete
app.post('/api/action', (req, res) => {
  const { id, action } = req.body;
  if (!id || !action) return res.status(400).json({ error: 'Missing parameters' });

  // Bulk
  if (id === 'all') {
    const ids = Object.keys(activeDownloads);

    if (action === 'pause') {
      ids.forEach(aid => {
        const dl = activeDownloads[aid];
        if (dl.process && (dl.status === 'downloading' || dl.status === 'queued')) {
          dl.status = 'paused';
          dl.speed = 'Paused';
          dl.eta = '--:--';
          killProcessTree(dl.process);
          dl.process = null;
        }
      });
      broadcast({ type: 'init', active: ids.map(id => serializeDownload(id)), completed: completedDownloads, settings });
      return res.json({ success: true });
    }

    if (action === 'resume') {
      ids.forEach(aid => {
        if (activeDownloads[aid].status === 'paused') {
          activeDownloads[aid].status = 'queued';
          startYtDlpProcess(aid);
        }
      });
      broadcast({ type: 'init', active: ids.map(id => serializeDownload(id)), completed: completedDownloads, settings });
      return res.json({ success: true });
    }

    if (action === 'cancel') {
      ids.forEach(aid => {
        if (activeDownloads[aid].process) killProcessTree(activeDownloads[aid].process);
        delete activeDownloads[aid];
      });
      broadcast({ type: 'init', active: [], completed: completedDownloads, settings });
      return res.json({ success: true });
    }
  }

  // Single
  const dl = activeDownloads[id];

  if (dl) {
    if (action === 'pause' && dl.process) {
      dl.status = 'paused';
      dl.speed = 'Paused';
      dl.eta = '--:--';
      killProcessTree(dl.process);
      dl.process = null;
      broadcast({ type: 'update', download: serializeDownload(id) });
      return res.json({ success: true });
    }

    if (action === 'resume' && dl.status === 'paused') {
      dl.status = 'queued';
      startYtDlpProcess(id);
      broadcast({ type: 'update', download: serializeDownload(id) });
      return res.json({ success: true });
    }

    if (action === 'cancel') {
      if (dl.process) killProcessTree(dl.process);
      delete activeDownloads[id];
      broadcast({ type: 'removed', id });
      checkQueue();
      return res.json({ success: true });
    }

    if (action === 'retry' && dl.status === 'failed') {
      dl.status = 'queued';
      dl.progress = 0;
      dl.speed = '0 B/s';
      dl.eta = '--:--';
      dl.error = null;
      startYtDlpProcess(id);
      broadcast({ type: 'update', download: serializeDownload(id) });
      return res.json({ success: true });
    }
  }

  if (action === 'delete') {
    const idx = completedDownloads.findIndex(item => item.id === id);
    if (idx !== -1) {
      completedDownloads.splice(idx, 1);
      saveHistory();
      broadcast({ type: 'completed_removed', id });
      return res.json({ success: true });
    }

    if (activeDownloads[id] && ['failed', 'paused'].includes(activeDownloads[id].status)) {
      delete activeDownloads[id];
      broadcast({ type: 'removed', id });
      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Not found' });
  }

  return res.status(400).json({ error: 'Invalid action' });
});

// POST /api/open — open file or folder natively
app.post('/api/open', (req, res) => {
  const { filePath, type } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });

  let winPath = path.normalize(filePath);
  let dirPath = path.dirname(winPath);

  // Security Check: Ensure the path is inside the downloads directory or in the completed downloads history
  const targetPath = path.resolve(winPath);
  const allowedDir = path.resolve(settings.downloadPath);
  const isInsideAllowedDir = targetPath.startsWith(allowedDir);
  const isInHistory = completedDownloads.some(item => {
    if (!item.filePath) return false;
    return path.resolve(item.filePath) === targetPath;
  });

  if (!isInsideAllowedDir && !isInHistory) {
    console.warn(`Access forbidden for path: ${winPath}`);
    return res.status(403).json({ error: 'Access forbidden: path is outside the downloads folder' });
  }

  // If the file path doesn't exist, try to match it with a normalized filename in the directory
  if (!fs.existsSync(winPath) && fs.existsSync(dirPath)) {
    try {
      const files = fs.readdirSync(dirPath);
      const ext = path.extname(winPath);
      const base = path.basename(winPath, ext);

      const normalize = (name) => name.toLowerCase().replace(/\uff5c/g, ' ').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
      const normalizedBase = normalize(base);

      const match = files.find(f => {
        const fExt = path.extname(f);
        const fBase = path.basename(f, fExt);
        return normalize(fBase) === normalizedBase;
      });

      if (match) {
        winPath = path.join(dirPath, match);
      }
    } catch (err) {
      console.error('Error reading directory for match:', err);
    }
  }

  // Double check existence
  const fileExists = fs.existsSync(winPath);
  const dirExists = fs.existsSync(dirPath);

  if (type === 'folder') {
    if (fileExists) {
      const explorer = spawn('explorer.exe', [`/select,"${winPath}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true
      });
      explorer.on('error', (err) => console.error('Explorer spawn error:', err));
      explorer.unref();
      return res.json({ success: true });
    } else if (dirExists) {
      // Fallback to opening folder directly if file doesn't exist
      const explorer = spawn('explorer.exe', [dirPath], { detached: true, stdio: 'ignore' });
      explorer.on('error', (err) => console.error('Explorer spawn error:', err));
      explorer.unref();
      return res.json({ success: true });
    } else {
      return res.status(404).json({ error: `Directory not found: ${dirPath}` });
    }
  } else {
    // Opening file using explorer.exe directly to avoid cmd.exe command injection vulnerabilities
    if (fileExists) {
      const explorer = spawn('explorer.exe', [winPath], { detached: true, stdio: 'ignore' });
      explorer.on('error', (err) => console.error('Explorer spawn error:', err));
      explorer.unref();
      return res.json({ success: true });
    } else if (dirExists) {
      // Fallback to opening folder if file doesn't exist
      const explorer = spawn('explorer.exe', [dirPath], { detached: true, stdio: 'ignore' });
      explorer.on('error', (err) => console.error('Explorer spawn error:', err));
      explorer.unref();
      return res.status(404).json({ error: `File not found, opened folder instead: ${dirPath}` });
    } else {
      return res.status(404).json({ error: `File and directory not found: ${winPath}` });
    }
  }
});

// GET /api/settings
app.get('/api/settings', (req, res) => res.json(settings));

// POST /api/settings
app.post('/api/settings', (req, res) => {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      settings[key] = req.body[key];
    }
  }
  saveSettings();
  broadcast({ type: 'settings', settings });
  res.json({ success: true, settings });
});

// DELETE /api/history
app.delete('/api/history', (req, res) => {
  completedDownloads = [];
  saveHistory();
  broadcast({ type: 'init', active: Object.keys(activeDownloads).map(id => serializeDownload(id)), completed: [], settings });
  res.json({ success: true });
});

// POST /api/update-ffmpeg — update ffmpeg via winget
app.post('/api/update-ffmpeg', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write('Attempting to update ffmpeg via winget...\n\n');

  // Try winget first (Windows Package Manager)
  const child = spawn('winget', [
    'install', '--id', 'Gyan.FFmpeg', '-e',
    '--accept-package-agreements', '--accept-source-agreements',
    '--silent'
  ]);

  let hasOutput = false;

  child.stdout.on('data', d => {
    hasOutput = true;
    res.write(d.toString());
  });
  child.stderr.on('data', d => {
    hasOutput = true;
    res.write(d.toString());
  });

  child.on('close', (code) => {
    if (code === 0) {
      res.write('\n✓ ffmpeg updated successfully via winget!\nRestart the server to reflect the new version.\n');
    } else {
      res.write(`\n✗ winget update failed (exit code ${code}).\n`);
      res.write('You can manually download the latest ffmpeg from:\n');
      res.write('https://www.gyan.dev/ffmpeg/builds/ or https://github.com/BtbN/FFmpeg-Builds/releases\n');
    }
    res.end();
  });

  child.on('error', () => {
    res.write('winget not available on this system.\n\n');
    res.write('To update ffmpeg manually, download from:\n');
    res.write('→ https://www.gyan.dev/ffmpeg/builds/\n');
    res.write('→ https://github.com/BtbN/FFmpeg-Builds/releases\n');
    res.end();
  });
});

// POST /api/update-ytdlp
app.post('/api/update-ytdlp', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write('Starting yt-dlp update via pip...\n');

  const pipArgs = ['-m', 'pip', 'install', '-U', 'yt-dlp'];
  if (!IS_VIRTUALENV) {
    pipArgs.push('--user');
  }

  const child = spawn(PYTHON_CMD, pipArgs);
  
  child.on('error', (err) => {
    console.error('yt-dlp update spawn error:', err);
    res.write(`\n✗ Failed to start update process: ${err.message}\n`);
    res.end();
  });

  child.stdout.on('data', d => res.write(d.toString()));
  child.stderr.on('data', d => res.write(`${d.toString()}`));
  child.on('close', (code) => {
    res.write(code === 0 ? '\n✓ yt-dlp updated successfully!\n' : `\n✗ Update failed (code ${code})\n`);
    res.end();
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tube Downloader Server running → http://localhost:${PORT}`);
});
