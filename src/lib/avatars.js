// Steam profile pictures for the players in the user's demos. The picture URL comes from the public
// profile page (steamcommunity.com/profiles/<id>/, no API key needed), which also has animated avatars
// (a GIF from the points shop), with the profile XML as fallback. Images are kept in
// <userData>/avatars/<name>.<ext>, so each one is downloaded once and works offline afterwards.
// Lookups are re-checked after a week (people change pictures), failures after a day.
const fs = require('fs');
const path = require('path');

const FRESH = 7 * 86400e3;
const RETRY = 86400e3;
const PARALLEL = 2;
const isSteamId = id => typeof id === 'string' && /^7656119\d{10}$/.test(id);
const httpError = (what, res) => Object.assign(new Error(`${what} HTTP ${res.status}`), { status: res.status });

class AvatarStore {
  // fetch: a fetch() (Electron's net.fetch); steamPath: () => Steam folder, for the client's own avatar cache;
  // onUpdate: called with { steamid: file } as pictures arrive.
  constructor(dir, { fetch, steamPath, onUpdate, log = () => {} }) {
    this.dir = path.join(dir, 'avatars');
    this.file = path.join(this.dir, 'index.json');
    this.fetch = fetch;
    this.steamPath = steamPath;
    this.onUpdate = onUpdate;
    this.log = log;
    try { this.index = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.index = {}; }
    this.queue = [];
    this.queued = new Set();
    this.running = 0;
    this.pausedUntil = 0;
  }

  image(name) { return path.join(this.dir, name); }

  // The pictures we already have for these players; the missing or stale ones are fetched in the
  // background and reported through onUpdate.
  get(ids) {
    const out = {};
    const now = Date.now();
    for (const id of new Set(ids)) {
      if (!isSteamId(id)) continue;
      const e = this.index[id];
      // (entries with only a hash are from before animated avatars: shown, but looked up again;
      // a .png from before v2 is an avatar frame picked up by mistake: not shown, looked up again)
      const frame = e?.pic?.endsWith('.png') && !e.v;
      const file = e?.pic && !frame ? this.image(e.pic) : e?.hash ? this.image(`${e.hash}.jpg`) : this.steamCache(id);
      if (file && fs.existsSync(file)) out[id] = file;
      const stale = !e || now - e.t > (e.pic ? FRESH : RETRY) || (e.hash && !e.pic) || frame || (e.pic && !out[id]);
      if (stale && !this.queued.has(id)) { this.queued.add(id); this.queue.push(id); }
    }
    this.pump();
    return out;
  }

  // The Steam client keeps pictures of friends and recently seen players in config/avatarcache.
  steamCache(id) {
    const dir = this.steamPath?.();
    return dir ? path.join(dir, 'config', 'avatarcache', `${id}.png`) : null;
  }

  pump() {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) {
      if (!this.resume) this.resume = setTimeout(() => { this.resume = null; this.pump(); }, wait);
      return;
    }
    while (this.running < PARALLEL && this.queue.length) {
      const id = this.queue.shift();
      this.running++;
      this.lookup(id)
        .catch(err => {
          if (err.status === 429) { // Steam is throttling us: put it back and slow down
            this.pausedUntil = Date.now() + 60e3;
            this.queue.unshift(id);
            return;
          }
          this.log('avatar', id, err.message);
          this.index[id] = { ...this.index[id], t: Date.now() };
          this.save();
          this.queued.delete(id);
        })
        .finally(() => { this.running--; this.pump(); });
    }
  }

  async lookup(id) {
    const url = await this.pageAvatar(id) || await this.xmlAvatar(id);
    const m = url && /\/([0-9a-f]{40})(?:_full)?\.(jpe?g|png|gif|webp)$/i.exec(url);
    if (!m) throw new Error('no picture in the profile');
    const pic = `${m[1]}.${m[2].toLowerCase()}`;
    const file = this.image(pic);
    if (!fs.existsSync(file)) {
      const img = await this.fetch(url);
      if (!img.ok) throw httpError('picture', img);
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, Buffer.from(await img.arrayBuffer()));
      fs.renameSync(`${file}.tmp`, file);
    }
    this.index[id] = { pic, t: Date.now(), v: 2 };
    this.save();
    this.queued.delete(id);
    this.onUpdate({ [id]: file });
  }

  // The big picture in the profile header: <img srcset="…"> inside playerAvatarAutoSizeInner, a GIF for
  // animated avatars (the <source> before it is the still version, for reduced motion).
  async pageAvatar(id) {
    const res = await this.fetch(`https://steamcommunity.com/profiles/${id}/`);
    if (!res.ok) throw httpError('profile', res);
    const html = await res.text();
    const at = html.indexOf('playerAvatarAutoSizeInner');
    if (at < 0) return null;
    // An avatar frame (points shop item) comes first, in its own div: skip it.
    const rest = html.slice(at).replace(/^[^>]*>\s*<div class="profile_avatar_frame">[\s\S]*?<\/div>/, '');
    const block = rest.slice(0, rest.indexOf('</div>'));
    return /<img[^>]*?\bsrc(?:set)?="(https:\/\/[^"\s]+)/.exec(block)?.[1] || null;
  }

  async xmlAvatar(id) {
    const res = await this.fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`);
    if (!res.ok) throw httpError('profile', res);
    return /<avatarFull>\s*(?:<!\[CDATA\[)?\s*(https:\/\/[^\s<\]]+)/.exec(await res.text())?.[1] || null;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.index));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (err) { this.log('avatar index:', err.message); }
    }, 1000);
  }
}

module.exports = { AvatarStore };
