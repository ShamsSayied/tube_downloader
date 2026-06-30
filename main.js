/**
 * main.js — Tube Downloader — Electron Main Process
 * Manages the BrowserWindow, IPC handlers, yt-dlp/ffmpeg process management,
 * persistent storage, and all download logic.
 * Replaces the old Express + WebSocket server architecture.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');

// ─── Suppress Harmless Chromium GPU Cache Warnings ───────────────────────────
// These flags prevent "Unable to move the cache: Access is denied" errors
// that appear on Windows when Electron's Chromium tries to move GPU shader cache.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('log-level', '3'); // Only show fatal errors in console

// ─── Resolve Bundled Binary Paths ─────────────────────────────────────────────

function getBinPath(name) {
  // In production (packaged), binaries are in resources/bin/
  // In development, they are in ./bin/
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', name);
  }
  return path.join(__dirname, 'bin', name);
}

const YTDLP_PATH = getBinPath('yt-dlp.exe');
const FFMPEG_PATH = getBinPath('ffmpeg.exe');
const FFPROBE_PATH = getBinPath('ffprobe.exe');

// ─── App Paths ────────────────────────────────────────────────────────────────

function getAppDataPath() {
  // Use app's user data directory for settings & history
  return app.getPath('userData');
}

// ─── Process Tree Termination (Windows-safe) ──────────────────────────────────

function killProcessTree(proc) {
  if (!proc) return;
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
      if (err) {
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
    });
  } else {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
}

// ─── Persistent Storage ──────────────────────────────────────────────────────

let HISTORY_FILE;
let SETTINGS_FILE;
let completedDownloads = [];

const DEFAULT_SETTINGS = {
  downloadPath: path.join(os.homedir(), 'Downloads', 'Videos'),
  maxConcurrentDownloads: 3,
  defaultFormat: 'bestvideo+bestaudio/best',
  speedLimit: 'unlimited',
  concurrentFragments: 8,
  retries: 10,
  outputTemplate: '%(title)s.%(ext)s',
  noOverwrites: false,
  continueDownload: true,
  proxy: '',
  forceIPv4: false,
  forceIPv6: false,
  xffBypass: 'default',
  socketTimeout: 30,
  writeSubs: false,
  embedSubs: false,
  writeAutoSubs: false,
  subLangs: 'en',
  subFormat: 'srt',
  embedThumbnail: true,
  embedMetadata: true,
  addChapters: false,
  writeInfoJson: false,
  writeThumbnail: false,
  audioFormat: '',
  audioQuality: '5',
  sponsorBlockRemove: [],
  sponsorBlockMark: [],
  cookiesFromBrowser: '',
  username: '',
  password: '',
  externalDownloader: 'native',
  theme: 'violet',
  themeMode: 'light'
};

let settings = { ...DEFAULT_SETTINGS };

function initStorage() {
  const dataDir = getAppDataPath();
  HISTORY_FILE = path.join(dataDir, 'downloads.json');
  SETTINGS_FILE = path.join(dataDir, 'settings.json');

  // Load history
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      completedDownloads = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (err) {
      console.error('Error reading downloads.json:', err);
      completedDownloads = [];
    }
  }

  // Load settings
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      // If user had old default 'Downloads', migrate to 'Downloads/Videos'
      if (loaded.downloadPath === path.join(os.homedir(), 'Downloads')) {
        loaded.downloadPath = DEFAULT_SETTINGS.downloadPath;
      }
      settings = { ...DEFAULT_SETTINGS, ...loaded };
    } catch (e) {
      console.error('Error reading settings.json:', e);
    }
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(completedDownloads, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing downloads.json:', err);
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
let mainWindow = null;
let splashWindow = null;

// ─── Broadcast to Renderer ────────────────────────────────────────────────────

function broadcast(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
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
    advancedOptions: dl.advancedOptions,
    playlistCurrent: dl.playlistCurrent,
    playlistTotal: dl.playlistTotal
  };
}

let lastBroadcastTimes = {};
function throttleBroadcast(id, force = false) {
  const now = Date.now();
  if (force || !lastBroadcastTimes[id] || now - lastBroadcastTimes[id] > 350) {
    lastBroadcastTimes[id] = now;
    broadcast('download-update', serializeDownload(id));
  }
}

// ─── Build yt-dlp argument list ───────────────────────────────────────────────

function buildYtDlpArgs(dl) {
  const opts = dl.advancedOptions || {};
  const isAudioExtract = dl.format === 'bestaudio/best';
  let outputTemplate = opts.outputTemplate || settings.outputTemplate || '%(title)s.%(ext)s';
  // Ensure title in template is capped to 100 bytes to prevent Windows MAX_PATH overflows on long titles (e.g. Facebook post texts)
  if (outputTemplate.includes('%(title)s')) {
    outputTemplate = outputTemplate.replace('%(title)s', '%(title).100B');
  }
  const downloadPath = dl.downloadPath;

  // Pass directory path via -P so --trim-filenames only applies to the filename template passed via -o
  const args = [
    '--newline',
    '--progress-template',
    'download-progress:%(progress._percent_str)s speed:%(progress._speed_str)s eta:%(progress._eta_str)s size:%(progress._total_bytes_str)s',
    '--ffmpeg-location', path.dirname(FFMPEG_PATH),
    '-P', downloadPath,
    '--windows-filenames',
    '--trim-filenames', '120',
  ];

  // Format
  args.push('-f', dl.format === 'bestaudio/best-m4a' ? 'bestaudio[ext=m4a]/bestaudio' : dl.format);

  // Speed Limit
  const speedLimit = opts.speedLimit || settings.speedLimit;
  if (speedLimit && speedLimit !== 'unlimited') {
    args.push('--limit-rate', speedLimit);
  }

  // Concurrent Fragments
  const fragments = parseInt(opts.concurrentFragments || settings.concurrentFragments) || 1;
  if (fragments > 1) {
    args.push('-N', String(fragments));
  }

  // Retries
  const retries = opts.retries || settings.retries || 10;
  args.push('--retries', String(retries));
  args.push('--fragment-retries', String(retries));

  // No Overwrites
  if (opts.noOverwrites || settings.noOverwrites) {
    args.push('--no-overwrites');
  }

  // Continue / Resume
  const continueDownload = opts.continueDownload !== undefined ? opts.continueDownload : settings.continueDownload;
  if (continueDownload === false) {
    args.push('--no-continue');
  } else {
    args.push('--continue');
  }

  // Proxy
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

  // Subtitles
  const writeSubs = opts.writeSubs !== undefined ? opts.writeSubs : settings.writeSubs;
  const writeAutoSubs = opts.writeAutoSubs !== undefined ? opts.writeAutoSubs : settings.writeAutoSubs;
  const embedSubs = opts.embedSubs !== undefined ? opts.embedSubs : settings.embedSubs;
  const subLangs = opts.subLangs || settings.subLangs || 'en';
  const subFormat = opts.subFormat || settings.subFormat || 'srt';

  if (writeSubs || writeAutoSubs || embedSubs) {
    args.push('--sub-langs', subLangs);
  }
  if (writeSubs || embedSubs) {
    args.push('--write-subs');
    args.push('--convert-subs', subFormat);
  }
  if (writeAutoSubs) {
    args.push('--write-auto-subs');
  }
  if (embedSubs && !isAudioExtract) {
    args.push('--embed-subs');
  }

  // Download Sections
  if (opts.downloadSections) {
    const sections = opts.downloadSections.split(',').map(s => s.trim()).filter(Boolean);
    for (const section of sections) {
      args.push('--download-sections', section);
    }
  }

  // Playlist
  if (opts.noPlaylist) {
    args.push('--no-playlist');
  } else if (opts.playlistItems) {
    args.push('--playlist-items', opts.playlistItems);
  }
  if (opts.playlistRandom) {
    args.push('--playlist-random');
  }

  // Date filtering
  if (opts.dateAfter) args.push('--dateafter', opts.dateAfter.replace(/-/g, ''));
  if (opts.dateBefore) args.push('--datebefore', opts.dateBefore.replace(/-/g, ''));

  // Download Archive
  if (opts.downloadArchive) {
    args.push('--download-archive', opts.downloadArchive);
  }

  // Metadata
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

  // SponsorBlock
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

  // Authentication
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

  // Output template & container
  if (isAudioExtract) {
    const audioFmt = opts.audioFormat || settings.audioFormat || 'mp3';
    const audioQuality = opts.audioQuality || settings.audioQuality || '5';
    args.push('--extract-audio', '--audio-format', audioFmt, '--audio-quality', audioQuality);
    args.push('-o', outputTemplate);
  } else {
    args.push('--merge-output-format', 'mp4');
    if (opts.downloadSections && opts.downloadSections.trim()) {
      args.push('--remux-video', 'mp4');
    }
    args.push('-o', outputTemplate);
  }

  // External downloader
  const extDownloader = opts.externalDownloader || settings.externalDownloader || 'native';
  if (extDownloader && extDownloader !== 'native') {
    args.push('--downloader', extDownloader);
  }

  // Live stream options
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
  const next = Object.values(activeDownloads).find(d => d.status === 'queued' && !d.process);
  if (next) startYtDlpProcess(next.id);
}

// ─── Start yt-dlp Download Process ───────────────────────────────────────────

function startYtDlpProcess(id) {
  const dl = activeDownloads[id];
  if (!dl) return;

  const running = Object.values(activeDownloads).filter(d =>
    ['downloading', 'merging', 'processing', 'extracting'].includes(d.status)
  ).length;
  const limit = settings.maxConcurrentDownloads || 3;
  if (running >= limit) {
    dl.status = 'queued';
    throttleBroadcast(id, true);
    return;
  }

  // Always check whether the target folder exists before saving; create it automatically if not
  if (dl.downloadPath && !fs.existsSync(dl.downloadPath)) {
    try {
      fs.mkdirSync(dl.downloadPath, { recursive: true });
    } catch (e) {
      console.error(`Cannot create download folder: ${dl.downloadPath}`, e);
    }
  }

  const args = buildYtDlpArgs(dl);
  const isAudioExtract = dl.format === 'bestaudio/best';
  const audioFmt = (dl.advancedOptions && dl.advancedOptions.audioFormat) || settings.audioFormat || 'mp3';

  console.log(`Spawning yt-dlp: ${YTDLP_PATH} ${args.join(' ')}`);

  const child = spawn(YTDLP_PATH, args, {
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
    broadcast('download-failed', serializeDownload(id));
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
        const match = trimmed.match(/download-progress:\s*([0-9.]+)%\s*speed:\s*([^\s]+)\s*eta:\s*([^\s]+)(?:\s*size:\s*([^\s]+))?/);
        if (match) {
          dl.progress = parseFloat(match[1]);
          dl.speed = (!match[2] || match[2] === 'Unknown' || match[2] === 'NA') ? 'Calculating...' : match[2];
          dl.eta = (!match[3] || match[3] === 'Unknown' || match[3] === 'NA') ? '--:--' : match[3];
          if (match[4] && match[4] !== 'NA' && match[4] !== 'Unknown') dl.totalSize = match[4];
          if (['merging', 'processing', 'extracting'].includes(dl.status)) {
            dl.status = 'downloading';
          }
          throttleBroadcast(id);
        }
      } else if (trimmed.includes('[download] Downloading item')) {
        const match = trimmed.match(/\[download\] Downloading item\s*(\d+)\s*of\s*(\d+)/);
        if (match) {
          dl.playlistCurrent = parseInt(match[1]);
          dl.playlistTotal = parseInt(match[2]);
          dl.status = 'downloading';
          throttleBroadcast(id, true);
        }
      } else if (trimmed.includes('[download] Destination:')) {
        const m = trimmed.match(/\[download\] Destination:\s*(.*)/);
        if (m) dl.filePath = m[1].trim();
        if (['merging', 'processing', 'extracting'].includes(dl.status)) {
          dl.status = 'downloading';
        }
      } else if (trimmed.includes('has already been downloaded')) {
        const m = trimmed.match(/\[download\]\s*(.*)\s*has already been downloaded/);
        if (m) { dl.filePath = m[1].trim(); dl.progress = 100; }
        if (['merging', 'processing', 'extracting'].includes(dl.status)) {
          dl.status = 'downloading';
        }
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
    const str = data.toString();
    const errLine = str.trim();
    if (errLine.startsWith('ERROR:')) {
      dl.error = errLine;
      console.error(`yt-dlp error [${id}]:`, errLine);
    }
    // Parse FFmpeg clip cutting progress from stderr (e.g., size= 768KiB time=00:00:06.39 speed=1.55x)
    if (str.includes('frame=') || str.includes('size=')) {
      const speedMatch = str.match(/speed=\s*([^\s]+)/);
      const sizeMatch = str.match(/size=\s*([^\s]+)/);
      if (speedMatch && speedMatch[1]) dl.speed = `${speedMatch[1]} (Cutting)`;
      if (sizeMatch && sizeMatch[1]) dl.totalSize = sizeMatch[1];
      if (dl.status === 'queued') dl.status = 'downloading';
      throttleBroadcast(id);
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

      broadcast('download-completed', { download: completedItem, activeId: id });
      checkQueue();
    } else {
      dl.status = 'failed';
      if (!dl.error) dl.error = `Process exited with code ${code}`;
      broadcast('download-failed', serializeDownload(id));
      checkQueue();
    }
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function setupIPC() {

  // ── Analyze URL ──────────────────────────────────────────────
  ipcMain.handle('analyze', async (event, url) => {
    if (!url) throw new Error('URL is required');

    return new Promise((resolve, reject) => {
      const args = ['-J', '--flat-playlist', '--ffmpeg-location', path.dirname(FFMPEG_PATH), url];
      let stdoutData = '';
      let stderrData = '';
      const child = spawn(YTDLP_PATH, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }
      });

      child.on('error', (err) => {
        reject(new Error('Failed to start metadata analysis. yt-dlp may be unavailable.'));
      });

      child.stdout.on('data', d => stdoutData += d.toString());
      child.stderr.on('data', d => stderrData += d.toString());

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('Failed to analyze URL. Ensure it is a valid media link. ' + stderrData));
          return;
        }

        try {
          const info = JSON.parse(stdoutData);

          if (info._type === 'playlist') {
            let playlistThumb = '';
            if (info.thumbnail) {
              playlistThumb = info.thumbnail;
            } else if (info.thumbnails && info.thumbnails.length) {
              playlistThumb = info.thumbnails[info.thumbnails.length - 1].url || '';
            } else if (info.entries && info.entries.length) {
              const firstEntry = info.entries[0];
              playlistThumb = firstEntry.thumbnail || (firstEntry.thumbnails && firstEntry.thumbnails.length ? firstEntry.thumbnails[firstEntry.thumbnails.length - 1].url : '') || '';
            }
            const entries = (info.entries || []).map((e, idx) => ({
              index: idx + 1,
              title: e.title || `Video ${idx + 1}`,
              id: e.id || ''
            }));

            return resolve({
              type: 'playlist',
              title: info.title || 'Playlist',
              thumbnail: playlistThumb,
              channel: info.uploader || info.channel || info.author || 'Playlist',
              videoCount: entries.length,
              entries,
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

          resolve({
            type: 'video',
            title: info.title || 'Unknown',
            thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
            channel: info.uploader || info.channel || info.uploader_id || 'Unknown',
            duration: durationStr,
            durationSeconds: Math.floor(info.duration || 0),
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
          reject(new Error('Failed to parse video metadata.'));
        }
      });
    });
  });

  // ── Start Download ──────────────────────────────────────────
  ipcMain.handle('start-download', async (event, opts) => {
    const { url, formatId, title, thumbnail, downloadPath, advancedOptions } = opts;
    if (!url || !formatId || !title) {
      throw new Error('Missing required parameters');
    }

    const targetPath = downloadPath || settings.downloadPath;

    if (!fs.existsSync(targetPath)) {
      try {
        fs.mkdirSync(targetPath, { recursive: true });
      } catch (e) {
        throw new Error(`Cannot create download folder: ${targetPath}`);
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
      advancedOptions: advancedOptions || {},
      playlistCurrent: null,
      playlistTotal: null
    };

    startYtDlpProcess(downloadId);

    const serialized = serializeDownload(downloadId);
    broadcast('download-added', serialized);
    return { success: true, downloadId, download: serialized };
  });

  // ── Download Action (pause/resume/cancel/retry/delete) ──────
  ipcMain.handle('download-action', async (event, { id, action }) => {
    if (!id || !action) throw new Error('Missing parameters');

    // Bulk actions
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
        broadcastFullState();
        return { success: true };
      }

      if (action === 'resume') {
        ids.forEach(aid => {
          if (activeDownloads[aid].status === 'paused') {
            activeDownloads[aid].status = 'queued';
            startYtDlpProcess(aid);
          }
        });
        broadcastFullState();
        return { success: true };
      }

      if (action === 'cancel') {
        ids.forEach(aid => {
          if (activeDownloads[aid].process) killProcessTree(activeDownloads[aid].process);
          delete activeDownloads[aid];
        });
        broadcastFullState();
        return { success: true };
      }
    }

    // Single actions
    const dl = activeDownloads[id];

    if (dl) {
      if (action === 'pause' && dl.process) {
        dl.status = 'paused';
        dl.speed = 'Paused';
        dl.eta = '--:--';
        killProcessTree(dl.process);
        dl.process = null;
        broadcast('download-update', serializeDownload(id));
        return { success: true };
      }

      if (action === 'resume' && dl.status === 'paused') {
        dl.status = 'queued';
        startYtDlpProcess(id);
        broadcast('download-update', serializeDownload(id));
        return { success: true };
      }

      if (action === 'cancel') {
        if (dl.process) killProcessTree(dl.process);
        delete activeDownloads[id];
        broadcast('download-removed', { id });
        checkQueue();
        return { success: true };
      }

      if (action === 'retry' && dl.status === 'failed') {
        dl.status = 'queued';
        dl.progress = 0;
        dl.speed = '0 B/s';
        dl.eta = '--:--';
        dl.error = null;
        startYtDlpProcess(id);
        broadcast('download-update', serializeDownload(id));
        return { success: true };
      }
    }

    if (action === 'delete') {
      const idx = completedDownloads.findIndex(item => item.id === id);
      if (idx !== -1) {
        completedDownloads.splice(idx, 1);
        saveHistory();
        broadcast('completed-removed', { id });
        return { success: true };
      }

      if (activeDownloads[id] && ['failed', 'paused'].includes(activeDownloads[id].status)) {
        delete activeDownloads[id];
        broadcast('download-removed', { id });
        return { success: true };
      }

      throw new Error('Not found');
    }

    throw new Error('Invalid action');
  });

  // ── Open File ───────────────────────────────────────────────
  ipcMain.handle('open-file', async (event, filePath) => {
    if (!filePath) throw new Error('filePath is required');
    let winPath = path.normalize(filePath);

    // Try to find the file if path doesn't exist
    if (!fs.existsSync(winPath)) {
      const dirPath = path.dirname(winPath);
      if (fs.existsSync(dirPath)) {
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
          if (match) winPath = path.join(dirPath, match);
        } catch (err) {}
      }
    }

    if (fs.existsSync(winPath)) {
      shell.openPath(winPath);
      return { success: true };
    }
    throw new Error('File not found');
  });

  // ── Open Folder ─────────────────────────────────────────────
  ipcMain.handle('open-folder', async (event, filePath) => {
    if (!filePath) throw new Error('filePath is required');
    const winPath = path.normalize(filePath);

    if (fs.existsSync(winPath)) {
      shell.showItemInFolder(winPath);
    } else {
      const dirPath = path.dirname(winPath);
      if (fs.existsSync(dirPath)) {
        shell.openPath(dirPath);
      } else {
        throw new Error('Directory not found');
      }
    }
    return { success: true };
  });

  // ── Select Directory (native dialog) ─────────────────────────
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Download Directory'
    });
    if (result.canceled) return null;
    return result.filePaths[0] || null;
  });

  // ── Settings ────────────────────────────────────────────────
  ipcMain.handle('get-settings', async () => settings);

  ipcMain.handle('save-settings', async (event, newSettings) => {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const key of allowed) {
      if (newSettings[key] !== undefined) {
        settings[key] = newSettings[key];
      }
    }
    saveSettings();
    broadcast('settings-changed', settings);
    return { success: true, settings };
  });

  // ── System Info ─────────────────────────────────────────────
  ipcMain.handle('get-sysinfo', async () => {
    const result = { ytdlp: 'Unknown', ffmpeg: false, node: process.version };

    // yt-dlp version
    try {
      const out = execSync(`"${YTDLP_PATH}" --version`, { timeout: 5000 }).toString().trim();
      result.ytdlp = out || 'Unknown';
    } catch (e) {
      result.ytdlp = 'Not found';
    }

    // ffmpeg check
    try {
      const out = execSync(`"${FFMPEG_PATH}" -version`, { timeout: 5000 }).toString();
      result.ffmpeg = true;
      const firstLine = (out.split('\n')[0] || '').replace('ffmpeg version ', '').trim();
      // BtbN builds: "N-125307-gd66e84695b-20260626 Copyright..."
      // Gyan builds: "7.1-essentials_build-www.gyan.dev Copyright..."
      const versionPart = firstLine.split(' ')[0] || '';
      // Try to extract a meaningful version: look for date pattern (YYYYMMDD)
      const dateMatch = versionPart.match(/(\d{4})(\d{2})(\d{2})/);
      if (dateMatch) {
        result.ffmpegVersion = `${dateMatch[1]}.${dateMatch[2]}.${dateMatch[3]}`;
      } else {
        // Fallback: use the full version string before any space
        result.ffmpegVersion = versionPart.split('-')[0] || 'OK';
      }
    } catch (e) {
      result.ffmpeg = false;
      result.ffmpegVersion = null;
    }

    return result;
  });

  // ── Clear History ───────────────────────────────────────────
  ipcMain.handle('clear-history', async () => {
    completedDownloads = [];
    saveHistory();
    broadcastFullState();
    return { success: true };
  });

  // ── Request Init Data ───────────────────────────────────────
  ipcMain.handle('request-init-data', async () => {
    return {
      active: Object.keys(activeDownloads).map(id => serializeDownload(id)),
      completed: completedDownloads,
      settings: settings
    };
  });

  // ── Update yt-dlp ───────────────────────────────────────────
  ipcMain.handle('update-ytdlp', async () => {
    return new Promise((resolve) => {
      broadcast('update-log', { text: 'Downloading latest yt-dlp.exe...\n' });

      const https = require('https');
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
      const tempPath = YTDLP_PATH + '.tmp';

      // Check if curl.exe is available for fast download
      let hasCurl = false;
      try {
        execSync('where curl.exe', { stdio: 'ignore' });
        hasCurl = true;
      } catch (e) {}

      if (hasCurl) {
        broadcast('update-log', { text: 'Using native curl.exe for high-speed download...\n' });
        const curlChild = spawn('curl.exe', ['-L', '-#', '-f', '-o', tempPath, url]);
        
        curlChild.stderr.on('data', (data) => {
          broadcast('update-log', { text: data.toString() });
        });
        
        curlChild.on('close', (code) => {
          if (code === 0) {
            try {
              if (fs.existsSync(YTDLP_PATH)) fs.unlinkSync(YTDLP_PATH);
              fs.renameSync(tempPath, YTDLP_PATH);
              broadcast('update-log', { text: '\n✓ yt-dlp updated successfully!\n' });
              resolve({ success: true });
            } catch (err) {
              broadcast('update-log', { text: `\n✗ Failed to replace binary: ${err.message}\n` });
              resolve({ success: false });
            }
          } else {
            broadcast('update-log', { text: `\n✗ curl download failed (exit code ${code})\n` });
            resolve({ success: false });
          }
        });
      } else {
        broadcast('update-log', { text: 'curl.exe not found. Downloading via Node.js...\n' });
        function doDownload(downloadUrl) {
          const protocol = downloadUrl.startsWith('https') ? https : require('http');
          protocol.get(downloadUrl, {
            headers: { 'User-Agent': 'TubeDownloader/2.0' }
          }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              doDownload(response.headers.location);
              return;
            }
            if (response.statusCode !== 200) {
              broadcast('update-log', { text: `\n✗ Download failed: HTTP ${response.statusCode}\n` });
              resolve({ success: false });
              return;
            }

            const file = fs.createWriteStream(tempPath);
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              try {
                if (fs.existsSync(YTDLP_PATH)) fs.unlinkSync(YTDLP_PATH);
                fs.renameSync(tempPath, YTDLP_PATH);
                broadcast('update-log', { text: '\n✓ yt-dlp updated successfully!\n' });
                resolve({ success: true });
              } catch (err) {
                broadcast('update-log', { text: `\n✗ Failed to replace binary: ${err.message}\n` });
                resolve({ success: false });
              }
            });
          }).on('error', (err) => {
            broadcast('update-log', { text: `\n✗ Download error: ${err.message}\n` });
            resolve({ success: false });
          });
        }
        doDownload(url);
      }
    });
  });

  // ── Update FFmpeg ───────────────────────────────────────────
  ipcMain.handle('update-ffmpeg', async () => {
    return new Promise((resolve) => {
      broadcast('update-log', { text: 'Starting FFmpeg update...\n' });

      const binDir = path.dirname(FFMPEG_PATH);
      const zipPath = path.join(binDir, 'ffmpeg-master-latest-win64-gpl.zip');
      const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

      broadcast('update-log', { text: 'Downloading FFmpeg from GitHub Releases...\n' });

      let hasCurl = false;
      try {
        execSync('where curl.exe', { stdio: 'ignore' });
        hasCurl = true;
      } catch (e) {}

      if (hasCurl) {
        broadcast('update-log', { text: 'Using native curl.exe for high-speed download...\n' });
        const curlChild = spawn('curl.exe', ['-L', '-#', '-f', '-o', zipPath, url]);

        curlChild.stderr.on('data', (data) => {
          broadcast('update-log', { text: data.toString() });
        });

        curlChild.on('close', (code) => {
          if (code === 0) {
            extractAndInstall();
          } else {
            broadcast('update-log', { text: `\n✗ curl download failed (exit code ${code})\n` });
            resolve({ success: false });
          }
        });
      } else {
        broadcast('update-log', { text: 'curl.exe not found. Downloading via Node.js...\n' });
        const https = require('https');
        function downloadFfmpegNode(downloadUrl) {
          const protocol = downloadUrl.startsWith('https') ? https : require('http');
          protocol.get(downloadUrl, { headers: { 'User-Agent': 'TubeDownloader/2.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              downloadFfmpegNode(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              broadcast('update-log', { text: `\n✗ Download failed: HTTP ${res.statusCode}\n` });
              resolve({ success: false });
              return;
            }
            const file = fs.createWriteStream(zipPath);
            res.pipe(file);
            file.on('finish', () => {
              file.close();
              extractAndInstall();
            });
          }).on('error', (err) => {
            broadcast('update-log', { text: `\n✗ Download error: ${err.message}\n` });
            resolve({ success: false });
          });
        }
        downloadFfmpegNode(url);
      }

      function extractAndInstall() {
        broadcast('update-log', { text: 'Extracting FFmpeg package...\n' });
        const tempDir = path.join(binDir, '_ffmpeg_temp_update');
        try {
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

          exec(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`, (err) => {
            if (err) {
              broadcast('update-log', { text: `\n✗ Extraction failed: ${err.message}\n` });
              resolve({ success: false });
              return;
            }

            function findFile(dir, filename) {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  const result = findFile(fullPath, filename);
                  if (result) return result;
                } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
                  return fullPath;
                }
              }
              return null;
            }

            const foundFfmpeg = findFile(tempDir, 'ffmpeg.exe');
            const foundFfprobe = findFile(tempDir, 'ffprobe.exe');

            if (foundFfmpeg && foundFfprobe) {
              try {
                if (fs.existsSync(FFMPEG_PATH)) fs.unlinkSync(FFMPEG_PATH);
                if (fs.existsSync(FFPROBE_PATH)) fs.unlinkSync(FFPROBE_PATH);

                fs.copyFileSync(foundFfmpeg, FFMPEG_PATH);
                fs.copyFileSync(foundFfprobe, FFPROBE_PATH);

                broadcast('update-log', { text: '✓ FFmpeg updated successfully!\n' });
                resolve({ success: true });
              } catch (e) {
                broadcast('update-log', { text: `\n✗ Failed to replace binaries: ${e.message}\n` });
                resolve({ success: false });
              }
            } else {
              broadcast('update-log', { text: '\n✗ Could not find binaries in archive.\n' });
              resolve({ success: false });
            }

            // Cleanup
            fs.rmSync(tempDir, { recursive: true, force: true });
            try { fs.unlinkSync(zipPath); } catch (e) {}
          });
        } catch (e) {
          broadcast('update-log', { text: `\n✗ Extraction failed: ${e.message}\n` });
          resolve({ success: false });
        }
      }
    });
  });

  // ── Clipboard ───────────────────────────────────────────────
  ipcMain.handle('read-clipboard', async () => {
    return clipboard.readText();
  });

  // ── Open External Link ──────────────────────────────────────
  ipcMain.handle('open-external', async (event, url) => {
    if (!url || typeof url !== 'string') return { success: false };
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false };
  });

  // ── Window Controls ─────────────────────────────────────────
  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });
}

function broadcastFullState() {
  broadcast('init-data', {
    active: Object.keys(activeDownloads).map(id => serializeDownload(id)),
    completed: completedDownloads,
    settings: settings
  });
}

// ─── Create Splash Window ─────────────────────────────────────────────────────

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    icon: path.join(__dirname, 'public', 'icon.png'),
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  splashWindow.loadFile(path.join(__dirname, 'public', 'splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function updateSplashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', text);
  }
}

// ─── Create Main Window ───────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'public', 'icon.png'),
    backgroundColor: '#0f0f14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    updateSplashStatus('Ready!');
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    }, 400);
  });

  // Track maximize/unmaximize state for custom titlebar
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Kill all active downloads on window close
  mainWindow.on('close', () => {
    Object.values(activeDownloads).forEach(dl => {
      if (dl.process) killProcessTree(dl.process);
    });
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createSplashWindow();
  setTimeout(() => {
    updateSplashStatus('Loading user preferences & history...');
    initStorage();
    setupIPC();
    updateSplashStatus('Checking media engine binaries...');
    setTimeout(() => {
      updateSplashStatus('Starting user interface...');
      createWindow();
    }, 300);
  }, 300);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
