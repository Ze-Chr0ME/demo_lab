// Background ("headless") recording through HLAE (advancedfx.org):
//  - CS2 is started by HLAE in a window with -insecure (no VAC servers) and -afxFixNetCon, which makes
//    CS2's console port (-netconport) work on Windows. Commands go over that socket, so CS2 never
//    needs focus and no keys are pressed.
//  - HLAE's mirv_streams records frames straight from the engine at a fixed frame rate (keeps rendering
//    while CS2 is behind other windows or minimized) and encodes them with ffmpeg; mirv_cmd schedules
//    start/stop on exact demo ticks.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function hlaeFiles(dir) {
  return { exe: path.join(dir, 'HLAE.exe'), hook: path.join(dir, 'x64', 'AfxHookSource2.dll'), ini: path.join(dir, 'ffmpeg', 'ffmpeg.ini') };
}

function hlaeVersion(dir) {
  try {
    const xml = fs.readFileSync(path.join(dir, 'changelog.xml'), 'utf8');
    return /<version>([\d.]+)<\/version>/.exec(xml)?.[1] || 'unknown';
  } catch { return null; }
}

// Lists what is missing or unreadable (e.g. removed or locked by an antivirus) — empty when HLAE is usable.
function missingFiles(dir) {
  if (!dir) return ['HLAE folder'];
  const f = hlaeFiles(dir);
  return [f.exe, f.hook].filter(p => {
    try { fs.accessSync(p, fs.constants.R_OK); return false; } catch (e) { return true; }
  }).map(p => `${path.relative(dir, p)}`);
}

function isInstalled(dir) { return missingFiles(dir).length === 0; }

function cs2Pids() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq cs2.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return [...out.matchAll(/"cs2\.exe","(\d+)"/gi)].map(m => Number(m[1]));
  } catch { return []; }
}

// ffmpeg output options per encoder, for HLAE's "mirv_streams settings add ffmpeg".
const FFMPEG_OPTS = {
  h264_nvenc: '-c:v h264_nvenc -preset p5 -rc vbr -cq 23 -b:v 0 -pix_fmt yuv420p',
  h264_amf: '-c:v h264_amf -quality quality -rc cqp -qp_i 21 -qp_p 23 -pix_fmt yuv420p',
  h264_qsv: '-c:v h264_qsv -global_quality 23 -pix_fmt nv12',
  libx264: '-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p',
};

class HlaeSession {
  constructor({ dir, cs2Dir, port, width, height, ffmpegPath, log = () => {} }) {
    Object.assign(this, { dir, cs2Dir, port, width, height, ffmpegPath, log });
    this.sock = null;
    this.buf = '';
    this.launched = false;
  }

  // HLAE reads the ffmpeg location from ffmpeg/ffmpeg.ini.
  writeFfmpegIni() {
    const ini = hlaeFiles(this.dir).ini;
    fs.mkdirSync(path.dirname(ini), { recursive: true });
    fs.writeFileSync(ini, `[Ffmpeg]\r\nPath=${this.ffmpegPath}\r\n`);
  }

  connectOnce() {
    return new Promise(resolve => {
      const s = net.connect(this.port, '127.0.0.1');
      s.setEncoding('utf8');
      s.once('error', () => resolve(false));
      s.once('connect', () => {
        this.sock = s;
        s.on('data', d => { this.buf = (this.buf + d).slice(-2_000_000); });
        s.on('close', () => { if (this.sock === s) this.sock = null; });
        s.on('error', () => {});
        resolve(true);
      });
    });
  }

  // Reuses a CS2 that HLAE already started (console port answering); otherwise launches one.
  async start(isCancelled) {
    if (!isInstalled(this.dir)) throw new Error(`HLAE not found in ${this.dir}. Set its folder in Settings → Recording.`);
    if (await this.connectOnce()) { this.log('Reusing the running HLAE CS2 session'); return { launched: false }; }
    if (cs2Pids().length) throw new Error('CS2 is already running normally. Close it so ClipMaker can start it through HLAE for background recording.');

    this.writeFfmpegIni();
    const f = hlaeFiles(this.dir);
    const cs2exe = path.join(this.cs2Dir, 'game', 'bin', 'win64', 'cs2.exe');
    const cmdLine = `-steam -insecure -allow_third_party_software -afxFixNetCon -netconport ${this.port} -novid -console -window -w ${this.width} -h ${this.height} +sv_lan 1`;
    spawn(f.exe, ['-customLoader', '-noGui', '-autoStart', '-hookDllPath', f.hook, '-programPath', cs2exe, '-cmdLine', cmdLine],
      { cwd: this.dir, detached: true, stdio: 'ignore' }).unref();
    this.launched = true;

    const until = Date.now() + 240000;
    while (Date.now() < until) {
      if (isCancelled()) return { launched: true };
      if (await this.connectOnce()) return { launched: true };
      await sleep(2000);
    }
    throw new Error('CS2 did not open its console port within 4 minutes. Is HLAE up to date with the latest CS2 update?');
  }

  async send(cmds) {
    if (!this.sock) throw new Error('Lost the connection to CS2 (did it close or crash?).');
    for (const c of [].concat(cmds)) {
      this.sock.write(c + '\r\n');
      await sleep(120);
    }
  }

  mark() { this.buf = ''; }

  async waitFor(re, ms, isCancelled) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const m = re.exec(this.buf);
      if (m) return m;
      if (isCancelled()) return null;
      if (!this.sock) throw new Error('CS2 closed or crashed during recording.');
      await sleep(200);
    }
    return null;
  }

  // Always closes CS2 afterwards: an -insecure HLAE session must never be used to queue for matches.
  async quit() {
    const pids = cs2Pids();
    try { await this.send(['disconnect', 'quit']); } catch {}
    const until = Date.now() + 12000;
    while (Date.now() < until && cs2Pids().some(p => pids.includes(p))) await sleep(1000);
    // CS2 sometimes hangs while quitting; force-close the session we drove.
    for (const pid of cs2Pids().filter(p => pids.includes(p))) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }); this.log('CS2 hung while quitting, force-closed it'); } catch {}
    }
    this.sock?.destroy();
    this.sock = null;
  }
}

// ---------- Updates ----------
// HLAE has to match the installed CS2 build (every CS2 update can break it), so the app checks
// advancedfx's GitHub releases and can install the newest one into its own folder.
const https = require('https');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cs2-clipmaker', Accept: 'application/vnd.github+json' }, timeout: 20000 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub answered HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('GitHub did not answer')); });
  });
}

// GitHub's download servers sometimes answer 5xx (e.g. 504) for a moment: retry a few times.
async function downloadWithRetry(url, file, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await download(url, file); } catch (e) {
      const retryable = !/HTTP 4\d\d/.test(e.message);
      if (i >= attempts || !retryable) throw new Error(`${e.message}${i > 1 ? ` (after ${i} attempts)` : ''}`);
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
}

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cs2-clipmaker' }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), file, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

async function latestRelease() {
  const r = await getJson('https://api.github.com/repos/advancedfx/advancedfx/releases/latest');
  const zip = r.assets.find(a => /^hlae_[\d_]+\.zip$/i.test(a.name));
  if (!zip) throw new Error('The latest HLAE release has no zip download.');
  return { version: r.tag_name.replace(/^v/, ''), published: r.published_at, url: zip.browser_download_url, size: zip.size };
}

// Downloads the release zip, extracts it next to the current install and swaps folders.
async function installRelease(release, dir, ffmpegPath) {
  const parent = path.dirname(dir);
  const zip = path.join(parent, `hlae_${release.version}.zip`);
  const fresh = `${dir}.new`, old = `${dir}.old`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  await downloadWithRetry(release.url, zip);
  if (fs.statSync(zip).size !== release.size) throw new Error('The HLAE download is incomplete, try again.');
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${fresh.replace(/'/g, "''")}' -Force`], { windowsHide: true });
  fs.rmSync(zip, { force: true });
  if (!isInstalled(fresh)) throw new Error('The HLAE download does not contain HLAE.exe.');
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  fs.renameSync(fresh, dir);
  fs.rmSync(old, { recursive: true, force: true });
  fs.writeFileSync(hlaeFiles(dir).ini, `[Ffmpeg]\r\nPath=${ffmpegPath}\r\n`);
  return hlaeVersion(dir);
}

module.exports = { HlaeSession, isInstalled, missingFiles, hlaeVersion, FFMPEG_OPTS, latestRelease, installRelease, cmpVersion, cs2Pids };
