// Builds the Windows installer (dist/CS2-DemoLab-Setup-<version>.exe) with electron-builder: the app,
// Electron and ffmpeg + ffprobe in one file, installed per user (no admin rights needed).
// ffmpeg is taken from wherever the app itself finds it (PATH, C:\ffmpeg, C:\ffmpeg\bin).
//   npm run dist
const fs = require('fs');
const path = require('path');
const ffmpeg = require('../src/lib/ffmpeg');

const root = path.join(__dirname, '..');
const found = ffmpeg.resolve('');
if (!found) { console.error('ffmpeg not found: install it (see README) before building the installer.'); process.exit(1); }
const probe = path.join(path.dirname(found), 'ffprobe.exe');
if (!fs.existsSync(probe)) { console.error(`ffprobe.exe is missing next to ${found}.`); process.exit(1); }
const out = path.join(root, 'build', 'ffmpeg');
fs.mkdirSync(out, { recursive: true });
for (const f of [found, probe]) {
  const to = path.join(out, path.basename(f).toLowerCase());
  const st = fs.statSync(f);
  if (!fs.existsSync(to) || fs.statSync(to).size !== st.size) fs.copyFileSync(f, to);
}
console.log('ffmpeg:', found);

let builder;
try { builder = require('electron-builder'); } catch {
  console.error('electron-builder is not installed. Run: npm install --no-save electron-builder@26');
  process.exit(1);
}
builder.build({ projectDir: root, win: ['nsis'], publish: 'never' })
  .then(files => console.log('Built:\n ' + files.join('\n ')))
  .catch(e => { console.error(e); process.exit(1); });
