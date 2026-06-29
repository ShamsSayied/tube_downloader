const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) process.exit(0);

const files = fs.readdirSync(distDir);
files.forEach(file => {
  if (file.endsWith('.zip')) {
    const oldPath = path.join(distDir, file);
    const newPath = path.join(distDir, 'TubeDownloader-Portable-2.1.0.zip');
    if (oldPath !== newPath) {
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
      fs.renameSync(oldPath, newPath);
      console.log(`[✓] Renamed ZIP artifact to: ${path.basename(newPath)}`);
    }
  }
});
