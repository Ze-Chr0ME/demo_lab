// "My highlights" page: a link anyone can open to watch your best clips, without a server of ours.
//  - Videos, thumbnails and pictures (profile picture, theme picture) go to qu.ax: a free file host that
//    needs no account or API key, uploads about 3x faster than catbox and keeps files for good (they can't
//    be deleted). It serves the raw file to a <video> or <img> tag only when the request has a Referer, so
//    the page sends its origin; https://qu.ax/dc/<id> serves it to anyone, Discord included. Clips published
//    before went to catbox.moe and stay there.
//  - Discord plays a video link right in the chat only when the file is small enough (a 29 MB clip played,
//    a 164 MB montage did not): bigger web copies get a smaller Discord copy too, item.dc.
//  - The page's data goes to catbox: qu.ax refuses .json and sends no CORS header (the page could not read
//    it), catbox does.
//  - The page is static (docs/share on GitHub Pages). What it shows is a small JSON file on catbox too, so
//    the link is just that file's name (…/demo_lab/#a1b2c3); until it is uploaded, the data travels in the
//    link itself, deflated and base64url'd after the #. Either way the link changes whenever the gallery
//    does, and the part after the # never reaches GitHub.
//  - The short one is shared as is. The long one (catbox could not be reached) goes through a free link
//    shortener that needs no account (is.gd, else TinyURL), like https://is.gd/AbC12; without one, as is.
// Kept in <userData>/gallery.json: { name, showSteam, userhash, pictures, short, tiny, items: [...] }, items newest first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const ffmpeg = require('./ffmpeg');

const CATBOX_API = 'https://catbox.moe/user/api.php';
const CATBOX_FILE = /^https:\/\/files\.catbox\.moe\/([a-z0-9]{6}\.(?:mp4|jpg|png|gif|webp|svg|json))$/;
const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
const QUAX_API = 'https://qu.ax/upload.php';
const QUAX_FILE = /^[A-Za-z0-9]{3,16}$/;
const MAX_UPLOAD = 250e6;   // qu.ax takes up to 256 MB: bigger web copies are encoded again to fit
const DISCORD_MAX = 50e6;   // bigger web copies get a Discord copy of about 45 MB (fitToSize may land 4% over)
const MAX_ITEMS = 20;       // keeps the link under Discord's 2000 characters, with the stats and theme
const PAGE_URL = 'https://ze-chr0me.github.io/demo_lab/share/';
const SHORT_URL = 'https://ze-chr0me.github.io/demo_lab/'; // docs/index.html sends #<id> on to the page
const CODE_VERSION = 1;
// Link shorteners without an account or key, tried in order: the page link (# part included) goes in,
// a short link that redirects to it comes out. Only ones that send browsers straight on (da.gd shows
// them a page with a link to click first).
const SHORTENERS = [
  { api: u => `https://is.gd/create.php?format=simple&url=${encodeURIComponent(u)}`, out: /^https:\/\/is\.gd\/[A-Za-z0-9_-]{1,32}$/ },
  { api: u => `https://tinyurl.com/api-create.php?url=${encodeURIComponent(u)}`, out: /^https:\/\/tinyurl\.com\/[A-Za-z0-9_-]{1,32}$/ },
];
// The saved short link to full, unless it came from a shortener no longer used.
const tinyFor = (g, full) => (full && g.tiny?.link === full && SHORTENERS.some(x => x.out.test(g.tiny.url)) ? g.tiny.url : null);
const isPageLink = url => typeof url === 'string' && (url.startsWith(SHORT_URL) || url.startsWith(PAGE_URL) || SHORTENERS.some(x => x.out.test(url)));

// Web copy of a clip: at most 1080p, ~6 Mbit/s (a 20 s clip is about 15 MB), starts playing before it
// has fully loaded (faststart).
const WEB_VIDEO = {
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '6M', '-maxrate', '9M', '-bufsize', '18M'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', '6M', '-maxrate', '9M'],
  h264_qsv: ['-c:v', 'h264_qsv', '-b:v', '6M', '-maxrate', '9M'],
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '9M', '-bufsize', '18M'],
};

async function webCopy(input, output, onProgress) {
  const info = await ffmpeg.probe(input);
  const fps = Math.min(info.fps || 60, 60);
  await ffmpeg.run(ffmpeg.path, ['-y', '-hide_banner', '-i', input,
    '-vf', `scale=-2:'min(ih,1080)',fps=${fps}`, ...(WEB_VIDEO[ffmpeg.encoder] || WEB_VIDEO.libx264), '-pix_fmt', 'yuv420p',
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : ['-an']),
    '-movflags', '+faststart', output], { onProgress, totalSeconds: info.duration });
  return info;
}

function poster(input, output, at) {
  return ffmpeg.run(ffmpeg.path, ['-y', '-hide_banner', '-ss', String(Math.max(0, at)), '-i', input, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', output]);
}

// POST one file to catbox (multipart, streamed so big videos don't sit in memory). Returns the file name
// on files.catbox.moe, e.g. "a1b2c3.mp4". When busy, catbox answers HTTP 200 with an empty body (or a 5xx,
// or stops answering): those are tried again a few times before giving up.
async function catboxUpload(file, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await catboxUploadOnce(file, opts); }
    catch (e) {
      if (!e.retry || attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
}

// POST fields and one file as multipart/form-data, the file streamed. Resolves { status, body }.
// host names the site in errors; busy(msg) makes the errors worth trying again.
function postFile(url, fields, fileField, file, { onProgress, host, busy }) {
  return new Promise((resolve, reject) => {
    const boundary = `----DemoLab${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const head = Buffer.from(Object.entries(fields).map(([k, v]) => field(k, v)).join('') +
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${path.basename(file)}"\r\nContent-Type: ${type}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = fs.statSync(file).size;
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': head.length + size + tail.length, 'User-Agent': 'CS2-DemoLab' },
      timeout: 120000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: body.trim() }));
    });
    req.on('timeout', () => req.destroy(busy(`${host} stopped answering. Try again later.`)));
    req.on('error', e => reject(/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(e.code || '')
      ? new Error(`Could not reach ${host} (${e.code}). Some internet providers block it: changing your DNS to 1.1.1.1 usually fixes that.`) : e));
    req.write(head);
    let sent = 0;
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => { sent += chunk.length; onProgress?.(sent / size); });
    stream.on('error', e => req.destroy(e));
    stream.on('end', () => req.end(tail));
    stream.pipe(req, { end: false });
  });
}

const busyError = msg => Object.assign(new Error(msg), { retry: true });

async function catboxUploadOnce(file, { userhash = '', onProgress } = {}) {
  const { status, body } = await postFile(CATBOX_API, { reqtype: 'fileupload', ...(userhash ? { userhash } : {}) }, 'fileToUpload', file, { onProgress, host: 'catbox.moe', busy: busyError });
  const m = CATBOX_FILE.exec(body);
  if (status === 200 && m) return m[1];
  if ((status === 200 && !body) || status >= 500) throw busyError(`catbox.moe is busy and did not take the file (HTTP ${status}). Try again in a few minutes.`);
  throw new Error(`catbox.moe did not take the file (HTTP ${status}${body ? `: ${body.slice(0, 160)}` : ''}).`);
}

// POST one video or picture to qu.ax, kept for good (expiry -1). Returns "q/<id>.<ext>": the page plays it
// from https://qu.ax/x/<id>.<ext>, Discord from https://qu.ax/dc/<id>.<ext>. Tried twice.
async function quaxUpload(file, { onProgress } = {}) {
  const ext = path.extname(file).toLowerCase();
  for (let attempt = 1; ; attempt++) {
    try {
      const { status, body } = await postFile(QUAX_API, { expiry: '-1' }, 'files[]', file, { onProgress, host: 'qu.ax', busy: busyError });
      let res = null;
      try { res = JSON.parse(body); } catch {}
      const id = res?.files?.[0]?.file_name;
      if (status === 200 && res?.success && QUAX_FILE.test(id || '')) return `q/${id}${ext}`;
      const msg = `qu.ax did not take the file (HTTP ${status}${res?.message ? `: ${String(res.message).slice(0, 160)}` : ''}).`;
      throw status >= 500 || !body ? busyError(msg) : new Error(msg);
    } catch (e) {
      if (!e.retry || attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

// The size of a file on the web, or null. Asks for its first byte (catbox answers HEAD with no size).
function remoteSize(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'CS2-DemoLab', Range: 'bytes=0-0' }, timeout: 15000 }, res => {
      res.destroy();
      const n = res.statusCode === 206 ? Number(/\/(\d+)$/.exec(res.headers['content-range'] || '')?.[1]) : NaN;
      resolve(n > 0 ? n : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CS2-DemoLab' }, timeout: 15000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 4096) req.destroy(new Error('answer too long')); });
      res.on('end', () => (res.statusCode === 200 ? resolve(body.trim()) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', reject);
  });
}

// A short link to url, from the first shortener that gives one.
async function shortenLink(url) {
  const errors = [];
  for (const s of SHORTENERS) {
    const host = new URL(s.api('')).host;
    try {
      const out = await getText(s.api(url));
      if (s.out.test(out)) return out;
      errors.push(`${host}: ${out.slice(0, 80)}`);
    } catch (e) { errors.push(`${host}: ${e.message}`); }
  }
  throw new Error(errors.join('; '));
}

function catboxDelete(names, userhash) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ reqtype: 'deletefiles', userhash, files: names.join(' ') }).toString();
    const req = https.request(CATBOX_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'CS2-DemoLab' }, timeout: 30000 }, res => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`catbox.moe HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('catbox.moe stopped answering.')));
    req.on('error', reject);
    req.end(body);
  });
}

// What the page looks like, from the app (renderer/gallery.js galleryLook): the theme and a snapshot of
// the Overview's numbers. Only known shapes get through; the page checks everything again.
const HEX = /^#[0-9a-f]{6}$/i;
const PATTERNS = ['hex', 'tri', 'grid', 'diag', 'dots'];
function cleanLook(look) {
  const t = look?.theme;
  const theme = t && HEX.test(t.base || '') && HEX.test(t.accent || '') ? {
    b: t.base, a: t.accent, d: HEX.test(t.data || '') ? t.data : undefined, p: PATTERNS.includes(t.pattern) ? t.pattern : undefined,
    s: ['map', 'team'].includes(t.scene) ? t.scene : undefined, k: t.scene === 'team' && t.logoLook === 'lit' ? 'lit' : undefined,
  } : undefined;
  const stats = look?.stats && typeof look.stats === 'object' && JSON.stringify(look.stats).length < 2400 ? look.stats : undefined;
  return { theme, stats };
}

// The gallery as the page reads it (docs/share/index.html), with short keys. It goes to catbox as a small
// JSON file (the link is then just its name, see Gallery.syncShort), or deflated into the link itself.
//   th: theme { b base, a accent, d data colour, p pattern, s scene, k logo look, i its picture file }
//   A: profile picture file (a: Steam avatar hash), st: the Overview's numbers (renderer galleryStats)
//   f: the featured clip (index), shown big at the top
//   per clip: dc its Discord copy (when the video is too big for Discord),
//             kl kills [{ t time in the clip, w weapon, v victim, f flags, p place }],
//             cx round { s side, sc score before it [us, them], b our buy, eb their buy, w won }
function payload(g) {
  const { theme, stats } = cleanLook(g.look);
  const featured = g.items.findIndex(x => x.id === g.featured);
  return {
    v: CODE_VERSION,
    n: g.name || g.items.find(x => x.player)?.player || '',
    s: g.steamid || undefined,
    a: g.avatar || undefined,
    A: g.avatarFile || undefined,
    c: theme ? undefined : g.accent || undefined,
    th: theme ? { ...theme, i: g.artFile || undefined } : undefined,
    st: stats,
    f: featured >= 0 ? featured : undefined,
    i: g.items.map(x => ({
      v: x.video, p: x.thumb, t: x.title, m: x.map || undefined, d: Math.round((x.duration || 0) * 10) / 10,
      k: x.kills || undefined, w: x.weapon || undefined, g: x.tags?.length ? x.tags : undefined,
      r: x.round || undefined, at: x.date ? Math.round(x.date / 86400e3) : undefined, o: x.vertical ? 1 : undefined,
      s: x.score || undefined, x: x.kind === 'montage' ? 1 : undefined, dc: x.dc || undefined,
      kl: x.kl?.length ? x.kl : undefined, cx: x.cx || undefined,
    })),
  };
}
function encode(g) {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(payload(g)), 'utf8'), { level: 9 }).toString('base64url');
}
function decode(code) {
  return JSON.parse(zlib.inflateRawSync(Buffer.from(code, 'base64url'), { maxOutputLength: 1 << 20 }).toString('utf8'));
}

// The weapon a clip is "about": the one with the most kills.
function mainWeapon(c) {
  const list = c.killWeapons?.length ? c.killWeapons : c.weapons || [];
  const count = {};
  for (const w of list) count[w] = (count[w] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

class Gallery {
  // upload / remove: overridable for tests (default: catbox.moe, for the page's data). uploadMedia, for
  // videos and pictures: qu.ax (default) or, when upload is overridden, that.
  constructor(dir, { upload = catboxUpload, uploadMedia = upload === catboxUpload ? quaxUpload : upload, remove = catboxDelete, shorten = shortenLink, log = () => {} } = {}) {
    this.file = path.join(dir, 'gallery.json');
    this.upload = upload;
    this.uploadMedia = uploadMedia;
    this.shorten = shorten;
    this.removeFiles = remove;
    this.log = log;
    this.busy = null;
  }

  load() {
    let g = {};
    try { g = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    return { name: '', userhash: '', items: [], ...g };
  }
  save(g) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(g, null, 2));
  }

  set({ name, userhash, showSteam } = {}) {
    const g = this.load();
    if (typeof name === 'string') g.name = name.trim().slice(0, 32);
    if (typeof showSteam === 'boolean') g.showSteam = showSteam;
    if (typeof userhash === 'string') {
      const h = userhash.trim();
      if (h && !/^[A-Za-z0-9]{8,64}$/.test(h)) throw new Error('That does not look like a catbox user hash (letters and digits, from catbox.moe → Manage account).');
      g.userhash = h;
    }
    this.save(g);
    return g;
  }

  // Encodes the clip for the web, uploads its thumbnail and video and adds it at the top of the gallery.
  // onProgress({ step, progress }) with progress 0..1 over the whole job.
  // extra: more about the clip for the page (kl kills, cx round), from main's clipContext.
  async publish(clip, { onProgress = () => {}, extra = null } = {}) {
    if (this.busy) throw new Error('Another clip is being published. Wait until it is done.');
    const g0 = this.load();
    if (g0.items.some(x => x.id === clip.id)) throw new Error('This clip is already on your highlights page.');
    if (g0.items.length >= MAX_ITEMS) throw new Error(`Your highlights page is full (${MAX_ITEMS} clips). Remove one first.`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-gallery-'));
    this.busy = clip.id;
    try {
      onProgress({ step: 'Preparing the web version…', progress: 0 });
      const web = path.join(tmp, 'clip.mp4');
      const info = await webCopy(clip.file, web, p => onProgress({ step: 'Preparing the web version…', progress: p * 0.45 }));
      let size = fs.statSync(web).size;
      // Too big to upload: encoded again to fit, a little under the limit (fitToSize may land up to 4% over).
      if (size > MAX_UPLOAD) {
        this.log('gallery: web copy is', Math.round(size / 1e6), 'MB, making it smaller');
        const fit = path.join(tmp, 'fit.mp4');
        await ffmpeg.fitToSize(web, fit, MAX_UPLOAD * 0.94 / 1048576, { onProgress: p => onProgress({ step: 'Making the web version smaller…', progress: p * 0.45 }) });
        fs.renameSync(fit, web);
        size = fs.statSync(web).size;
      }
      if (size > MAX_UPLOAD) throw new Error(`The web version is ${Math.round(size / 1e6)} MB, more than can be uploaded (250 MB). Shorter clips or montages only.`);
      let dcFile = null, dcSize = 0;
      if (size > DISCORD_MAX) {
        dcFile = path.join(tmp, 'discord.mp4');
        await this.discordCopy(web, dcFile, p => onProgress({ step: 'Preparing the Discord version…', progress: 0.45 + p * 0.1 }));
        dcSize = fs.statSync(dcFile).size;
      }
      const jpg = path.join(tmp, 'thumb.jpg');
      // The picture: just before the last kill, else the middle.
      const last = clip.kills?.at(-1)?.t;
      await poster(web, jpg, last ? last - 0.15 : (info.duration || 2) / 2).catch(() => poster(web, jpg, 0));
      const g = this.load();
      const start = dcFile ? 0.55 : 0.45, total = size + dcSize;
      const uploaded = (before, part) => p => {
        const n = before + p * part;
        onProgress({ step: `Uploading… ${Math.round(n / 1e6)} / ${Math.round(total / 1e6)} MB`, progress: start + 0.02 + n / total * (0.98 - start) });
      };
      onProgress({ step: 'Uploading…', progress: start });
      const thumb = await this.uploadMedia(jpg, { userhash: g.userhash });
      const video = await this.uploadMedia(web, { userhash: g.userhash, onProgress: uploaded(0, size) });
      const dc = dcFile ? await this.uploadMedia(dcFile, { userhash: g.userhash, onProgress: uploaded(size, dcSize) }) : null;
      const item = {
        id: clip.id, video, thumb, dc, owned: !!g.userhash && !video.startsWith('q/'), player: clip.player || '',
        title: (clip.title || 'Highlight').slice(0, 80), kind: clip.kind, map: clip.kind === 'montage' ? '' : clip.map || '',
        duration: info.duration || clip.duration || 0, kills: clip.killWeapons?.length || clip.kills?.length || 0,
        weapon: clip.kind === 'montage' ? null : mainWeapon(clip), tags: (clip.tags || []).slice(0, 3).map(t => String(t).slice(0, 24)),
        round: clip.round || 0, date: clip.matchDate || clip.createdAt || Date.now(), score: Math.round(clip.score || 0),
        vertical: (info.height || 0) > (info.width || 0), publishedAt: Date.now(),
        ...extra, ctx: true,
      };
      const now = this.load();
      now.items = [item, ...now.items.filter(x => x.id !== item.id)];
      this.save(now);
      this.log('gallery: published', clip.id, video, thumb);
      onProgress({ step: 'Done', progress: 1 });
      return item;
    } finally {
      this.busy = null;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A smaller copy of a web copy for Discord, about 45 MB.
  discordCopy(input, output, onProgress) {
    return ffmpeg.fitToSize(input, output, DISCORD_MAX * 0.9 / 1048576, { onProgress });
  }

  // For a clip published before Discord copies (item.dc undefined): none needed when its video is small
  // enough (dc null), else one made from file, the clip in the library. Checked again next time when the
  // video's size can't be had.
  async addDiscordCopy(id, file) {
    const item = this.load().items.find(x => x.id === id);
    if (!item || item.dc !== undefined || this.busy) return;
    const size = await remoteSize(item.video.startsWith('q/') ? `https://qu.ax/dc/${item.video.slice(2)}` : `https://files.catbox.moe/${item.video}`);
    if (size == null) return;
    if (size <= DISCORD_MAX || !file || !fs.existsSync(file)) { this.patch(id, { dc: null }); return; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-gallery-'));
    this.busy = id;
    try {
      const out = path.join(tmp, 'discord.mp4');
      await this.discordCopy(file, out);
      const dc = await this.uploadMedia(out, { userhash: this.load().userhash });
      this.patch(id, { dc });
      this.log('gallery: Discord copy', id, dc);
    } finally {
      this.busy = null;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Pictures the page shows besides the clips (profile picture, theme picture), uploaded once each and
  // remembered by file name and size: pictures { 'name:size': 'q/AbC12.png' } (assets: the same, on
  // catbox, from before; used until the qu.ax one is there).
  assetKey(file) {
    try { return file && fs.existsSync(file) ? `${path.basename(file)}:${fs.statSync(file).size}` : null; } catch { return null; }
  }
  assetIds({ avatarFile, artFile } = {}) {
    const g = this.load();
    const a = { ...g.assets, ...g.pictures };
    return { avatar: a[this.assetKey(avatarFile)] || null, art: a[this.assetKey(artFile)] || null };
  }
  picturesMissing(files = {}) {
    const p = this.load().pictures || {};
    return [files.avatarFile, files.artFile].some(f => { const k = this.assetKey(f); return k && !p[k]; });
  }
  // Uploads the ones not on qu.ax yet. Failures are only logged: the page works without them.
  async syncAssets(files = {}) {
    for (const file of [files.avatarFile, files.artFile]) {
      const key = this.assetKey(file);
      if (!key || this.load().pictures?.[key] || !TYPES[path.extname(file).toLowerCase()] || fs.statSync(file).size > 20e6) continue;
      try {
        const id = await this.uploadMedia(file, { userhash: this.load().userhash });
        const g = this.load();
        g.pictures = { ...g.pictures, [key]: id };
        this.save(g);
        this.log('gallery: uploaded', key, id);
      } catch (e) { this.log('gallery: picture upload failed', key, e.message); }
    }
    return this.assetIds(files);
  }

  // Takes a clip off the page; with a catbox account its files are deleted from catbox as well.
  async unpublish(id) {
    const g = this.load();
    const item = g.items.find(x => x.id === id);
    if (!item) return { removed: false };
    g.items = g.items.filter(x => x.id !== id);
    this.save(g);
    let deleted = false;
    if (item.owned && g.userhash) {
      try { await this.removeFiles([item.video, item.thumb].filter(x => x && !x.startsWith('q/')), g.userhash); deleted = true; } catch (e) { this.log('gallery: catbox delete failed', e.message); }
    }
    return { removed: true, deleted };
  }

  move(id, delta) {
    const g = this.load();
    const i = g.items.findIndex(x => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= g.items.length) return g;
    [g.items[i], g.items[j]] = [g.items[j], g.items[i]];
    this.save(g);
    return g;
  }

  // Adds fields to a published clip (kills and round context found later).
  patch(id, fields) {
    const g = this.load();
    const item = g.items.find(x => x.id === id);
    if (item) { Object.assign(item, fields); this.save(g); }
    return g;
  }

  // The clip shown big at the top of the page (null: the page picks the best one).
  feature(id) {
    const g = this.load();
    g.featured = g.featured === id ? null : id;
    this.save(g);
    return g;
  }

  // The page's data as it is now. opts: { steamid, avatar, accent, look, files: { avatarFile, artFile } },
  // the catbox copies of the files are used once uploaded.
  data(opts = {}) {
    const g = this.load();
    if (!g.items.length) return null;
    const ids = this.assetIds(opts.files);
    const json = JSON.stringify(payload({ ...g, ...opts, avatarFile: ids.avatar, artFile: ids.art }));
    return { json, hash: crypto.createHash('sha1').update(json).digest('hex') };
  }

  // The github.io link: short (the data file on catbox) when it matches the page's data, else the data
  // deflated into the link itself until syncShort has uploaded it.
  fullLink(opts = {}) {
    const d = this.data(opts);
    if (!d) return null;
    const short = this.load().short;
    if (short?.hash === d.hash) return `${SHORT_URL}#${short.id.replace(/\.json$/, '')}`;
    return `${opts.page || PAGE_URL}#${zlib.deflateRawSync(Buffer.from(d.json, 'utf8'), { level: 9 }).toString('base64url')}`;
  }
  // The link to share: fullLink, through the shortener only when it still carries the data itself.
  link(opts = {}) {
    const full = this.fullLink(opts);
    return (!this.isUploaded(opts) && tinyFor(this.load(), full)) || full;
  }
  isUploaded(opts = {}) {
    const d = this.data(opts);
    return !!d && this.load().short?.hash === d.hash;
  }
  // Short enough to share: the shortener's link, or the github.io one with the catbox file name.
  isShort(opts = {}) {
    return this.isUploaded(opts) || this.isTiny(opts);
  }
  isTiny(opts = {}) {
    return !this.isUploaded(opts) && !!tinyFor(this.load(), this.fullLink(opts));
  }
  // Uploads the page's data as a JSON file, so the link is just its name (catbox serves it to any page),
  // or, when catbox could not be reached, the shortener's link to the long one. Each change makes a new file and a new link; older links keep
  // showing the older data.
  async syncShort(opts = {}) {
    const d = this.data(opts);
    if (!d) return null;
    if (this.load().short?.hash !== d.hash) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-gallery-'));
      try {
        const file = path.join(tmp, 'highlights.json');
        fs.writeFileSync(file, d.json);
        const id = await this.upload(file, { userhash: this.load().userhash });
        if (!/^[a-z0-9]{6}\.json$/.test(id)) throw new Error(`catbox.moe gave an unexpected file name (${id}).`);
        const g = this.load();
        g.short = { hash: d.hash, id };
        this.save(g);
        this.log('gallery: short link', id);
      } catch (e) {
        this.log('gallery: short link failed', e.message);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    // The long link when catbox could not be reached: shortened, it is as easy to share.
    const full = this.fullLink(opts);
    if (full && !this.isUploaded(opts) && !tinyFor(this.load(), full)) {
      try {
        const url = await this.shorten(full);
        const g = this.load();
        g.tiny = { link: full, url };
        this.save(g);
        this.log('gallery: tiny link', url);
      } catch (e) {
        this.log('gallery: tiny link failed', e.message);
      }
    }
    return this.link(opts);
  }
}

module.exports = { Gallery, encode, decode, payload, cleanLook, catboxUpload, quaxUpload, shortenLink, isPageLink, PAGE_URL, SHORT_URL, MAX_ITEMS };
