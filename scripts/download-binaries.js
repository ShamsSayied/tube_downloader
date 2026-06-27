/**
 * download-binaries.js
 * Downloads yt-dlp.exe and ffmpeg/ffprobe static builds for bundling with Electron.
 * Run via: npm run postinstall  OR  node scripts/download-binaries.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');

// Ensure bin directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

/**
 * Follow redirects and download a file
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    function doRequest(url) {
      protocol.get(url, {
        headers: { 'User-Agent': 'TubeDownloader-Builder/2.0' }
      }, (response) => {
        // Follow redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (e) {}
          const redirectUrl = response.headers.location;
          const redirectFile = fs.createWriteStream(destPath);
          const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
          redirectProtocol.get(redirectUrl, {
            headers: { 'User-Agent': 'TubeDownloader-Builder/2.0' }
          }, (res2) => {
            if (res2.statusCode !== 200) {
              redirectFile.close();
              reject(new Error(`Failed to download (redirect): HTTP ${res2.statusCode}`));
              return;
            }
            const totalBytes = parseInt(res2.headers['content-length'] || '0', 10);
            let downloadedBytes = 0;
            res2.on('data', (chunk) => {
              downloadedBytes += chunk.length;
              if (totalBytes > 0) {
                const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                process.stdout.write(`\r  Progress: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`);
              }
            });
            res2.pipe(redirectFile);
            redirectFile.on('finish', () => {
              redirectFile.close();
              console.log('');
              resolve();
            });
          }).on('error', (err) => {
            redirectFile.close();
            reject(err);
          });
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
            process.stdout.write(`\r  Progress: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`);
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('');
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        reject(err);
      });
    }

    doRequest(url);
  });
}

/**
 * Downloads a file attempting to use native curl.exe first for maximum speed.
 */
async function downloadFileWrapper(url, destPath) {
  let hasCurl = false;
  try {
    // Check if curl.exe is available
    execSync('where curl.exe', { stdio: 'ignore' });
    hasCurl = true;
  } catch (e) {
    hasCurl = false;
  }

  if (hasCurl) {
    try {
      console.log(`  [Fast Download] Spawning curl.exe for download...`);
      // Use curl with redirect following (-L), silent but show progress bar (-#), and fail on server error (-f)
      execSync(`curl.exe -L -# -f -o "${destPath}" "${url}"`, { stdio: 'inherit' });
      console.log('  [✓] Download finished.');
      return;
    } catch (err) {
      console.warn(`  [!] curl download failed: ${err.message}. Falling back to node http...`);
      // Delete partially downloaded file if it exists
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
    }
  }

  // Fallback to pure node.js download
  await downloadFile(url, destPath);
}

/**
 * Extract zip file using PowerShell (Windows)
 */
function extractZip(zipPath, destDir) {
  console.log(`  Extracting ${path.basename(zipPath)}...`);
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, {
    stdio: 'inherit'
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Tube Downloader — Binary Dependency Downloader');
  console.log('═══════════════════════════════════════════════════\n');

  // ── 1. Download yt-dlp.exe ──────────────────────────────────
  const ytdlpPath = path.join(BIN_DIR, 'yt-dlp.exe');
  if (fs.existsSync(ytdlpPath)) {
    console.log('[✓] yt-dlp.exe already exists, skipping download.');
  } else {
    console.log('[*] Downloading yt-dlp.exe from GitHub...');
    const ytdlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    try {
      await downloadFileWrapper(ytdlpUrl, ytdlpPath);
      console.log('[✓] yt-dlp.exe downloaded successfully.');
    } catch (err) {
      console.error(`[✗] Failed to download yt-dlp.exe: ${err.message}`);
      console.error('    You can manually download it from: https://github.com/yt-dlp/yt-dlp/releases');
      console.error(`    Place it at: ${ytdlpPath}`);
    }
  }

  // ── 2. Download FFmpeg ──────────────────────────────────────
  const ffmpegPath = path.join(BIN_DIR, 'ffmpeg.exe');
  const ffprobePath = path.join(BIN_DIR, 'ffprobe.exe');

  if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
    console.log('[✓] ffmpeg.exe & ffprobe.exe already exist, skipping download.');
  } else {
    console.log('[*] Downloading FFmpeg essentials from GitHub Releases (BtbN builds)...');
    const ffmpegZipUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
    const ffmpegZipPath = path.join(BIN_DIR, 'ffmpeg-master-latest-win64-gpl.zip');
    try {
      await downloadFileWrapper(ffmpegZipUrl, ffmpegZipPath);
      console.log('[✓] FFmpeg zip downloaded. Extracting...');

      const extractDir = path.join(BIN_DIR, '_ffmpeg_temp');
      extractZip(ffmpegZipPath, extractDir);

      // Find ffmpeg.exe and ffprobe.exe in the extracted directory
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

      const foundFfmpeg = findFile(extractDir, 'ffmpeg.exe');
      const foundFfprobe = findFile(extractDir, 'ffprobe.exe');

      if (foundFfmpeg) {
        fs.copyFileSync(foundFfmpeg, ffmpegPath);
        console.log('[✓] ffmpeg.exe extracted.');
      } else {
        console.error('[✗] Could not find ffmpeg.exe in extracted archive.');
      }

      if (foundFfprobe) {
        fs.copyFileSync(foundFfprobe, ffprobePath);
        console.log('[✓] ffprobe.exe extracted.');
      } else {
        console.error('[✗] Could not find ffprobe.exe in extracted archive.');
      }

      // Cleanup
      fs.rmSync(extractDir, { recursive: true, force: true });
      try { fs.unlinkSync(ffmpegZipPath); } catch (e) {}
      console.log('[✓] Cleanup complete.');
    } catch (err) {
      console.error(`[✗] Failed to download/extract FFmpeg: ${err.message}`);
      console.error('    You can manually download from: https://github.com/BtbN/FFmpeg-Builds/releases');
      console.error(`    Place ffmpeg.exe and ffprobe.exe in: ${BIN_DIR}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Done! All binaries are ready in: bin/');
  console.log('═══════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
