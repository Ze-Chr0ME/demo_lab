// DemoLab updates itself from the GitHub releases of Ze-Chr0ME/demo_lab. The newest release's installer
// (CS2-DemoLab-Setup-<version>.exe, built by `npm run dist` and published by `npm run release`) is
// downloaded in the background, checked against the sha256 GitHub lists for it, and run silently: it
// replaces the installed app in place (same folder, shortcuts kept) and, after "Restart to update",
// starts DemoLab again. Running from the source (not installed) only reports that a release exists.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'Ze-Chr0ME/demo_lab';
const SETUP = /^CS2-DemoLab-Setup-.+\.exe$/i;

// "v1.10.2" > "1.9.7"; a pre-release suffix ("1.2.0-beta") is ignored, /releases/latest never lists those.
function cmpVersion(a, b) {
  const parts = v => String(v).replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

const sha256File = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
});

class Updater {
  // dir: where installers are kept (<userData>/updates); fetch: Electron's net.fetch (system proxy, redirects);
  // installed: false when running from the source, which can't replace itself.
  constructor({ dir, version, fetch, installed, log = () => {}, onChange = () => {} }) {
    Object.assign(this, { dir, fetch, log, onChange });
    this.release = null; // { version, notes, published, url, size, sha256, name, page }
    this.file = null;    // the verified installer, once downloaded
    this.job = null;
    // status: idle | checking | current | available | downloading | ready | error
    this.st = { current: version, installed, status: 'idle', latest: null, notes: '', published: null, page: null, size: 0, progress: 0, error: '', checked: 0 };
  }

  state() { return { ...this.st }; }
  set(patch) { Object.assign(this.st, patch); this.onChange(this.state()); }

  async check() {
    if (['downloading', 'checking'].includes(this.st.status)) return this.state();
    const was = this.st.status;
    this.set({ status: 'checking', error: '' });
    try {
      const res = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'cs2-demolab', Accept: 'application/vnd.github+json' } });
      // 404 = no release published yet (drafts and pre-releases don't count).
      if (res.status === 404) { this.set({ status: 'current', latest: null, checked: Date.now() }); return this.state(); }
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      const r = await res.json();
      const asset = (r.assets || []).find(a => SETUP.test(a.name));
      const version = String(r.tag_name || '').replace(/^v/i, '');
      const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '');
      this.release = asset && version ? {
        version, notes: (r.body || '').trim(), published: r.published_at, page: r.html_url,
        url: asset.browser_download_url, size: asset.size, name: asset.name, sha256: digest ? digest[1].toLowerCase() : null,
      } : null;
      if (!this.release) this.log('update check: latest release', r.tag_name, 'has no installer');
      const newer = this.release && cmpVersion(this.release.version, this.st.current) > 0;
      const rel = this.release || {};
      // A newer release than the one already downloaded makes that one stale; up to date, the installer
      // that just ran (or an outdated one) can go.
      if (this.file && !this.file.endsWith(rel.name || '\0')) this.file = null;
      if (!newer) fs.rmSync(this.dir, { recursive: true, force: true });
      this.set({
        status: !newer ? 'current' : this.file ? 'ready' : 'available',
        latest: rel.version || version || null, notes: rel.notes || '', published: rel.published || null, page: rel.page || null, size: rel.size || 0, checked: Date.now(),
      });
    } catch (e) {
      this.set({ status: was === 'ready' ? 'ready' : 'error', error: e.message, checked: Date.now() });
    }
    return this.state();
  }

  // Downloads the installer of the release found by check(); resolves when it's verified and ready to run.
  download() {
    if (!this.st.installed) return Promise.reject(new Error('DemoLab runs from the source code here: update it with git pull instead.'));
    if (this.st.status === 'ready') return Promise.resolve(this.state());
    if (!this.release || this.st.status !== 'available') return Promise.reject(new Error('No update to download.'));
    if (!this.job) this.job = this._download(this.release).finally(() => { this.job = null; });
    return this.job;
  }

  async _download(rel) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, rel.name);
    // Older installers and broken downloads go; an already complete copy of this one is reused.
    for (const f of fs.readdirSync(this.dir)) if (f !== rel.name) fs.rmSync(path.join(this.dir, f), { force: true, recursive: true });
    this.set({ status: 'downloading', progress: 0, error: '' });
    try {
      if (!(await this.verified(file, rel))) {
        const part = file + '.part';
        const res = await this.fetch(rel.url, { headers: { 'User-Agent': 'cs2-demolab' } });
        if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
        let got = 0, last = 0;
        const body = Readable.fromWeb(res.body);
        body.on('data', d => {
          got += d.length;
          if (Date.now() - last > 300) { last = Date.now(); this.set({ progress: rel.size ? got / rel.size : 0 }); }
        });
        await pipeline(body, fs.createWriteStream(part));
        fs.renameSync(part, file);
        if (!(await this.verified(file, rel))) { fs.rmSync(file, { force: true }); throw new Error('The downloaded update is damaged (checksum mismatch). Try again later.'); }
      }
      this.file = file;
      this.log('update', rel.version, 'downloaded', rel.sha256 ? '(sha256 ok)' : '(GitHub listed no sha256, size checked)');
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.log('update download failed:', e.message);
      this.set({ status: 'available', progress: 0, error: e.message });
      throw e;
    }
    return this.state();
  }

  async verified(file, rel) {
    try {
      if (fs.statSync(file).size !== rel.size) return false;
      return !rel.sha256 || (await sha256File(file)) === rel.sha256;
    } catch { return false; }
  }

  // Runs the downloaded installer silently; the caller quits DemoLab right after (the installer waits for
  // it to close, or closes it). relaunch: start DemoLab again once installed.
  install({ relaunch }) {
    if (!this.file || !fs.existsSync(this.file)) throw new Error('The update is not downloaded yet.');
    const args = ['/S', '--updated', ...(relaunch ? ['--force-run'] : [])];
    this.log('installing update', this.st.latest, relaunch ? '(restart)' : '(on quit)');
    spawn(this.file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.file = null;
  }
}

module.exports = { Updater, cmpVersion, REPO };
