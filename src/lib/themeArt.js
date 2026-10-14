// Pictures for the themes, taken from the player's own CS2 install: the map screenshots CS2 shows in
// its map picker (1080p, several angles per map), the team logos it uses for tournament stickers and the
// weapon silhouettes of the kill feed (Weapons tab).
// All sit in pak01_dir.vpk inside Valve's compiled resource files, but as plain PNG / SVG data, so
// a small VPK reader is enough (no Source2Viewer). Results are cached in <userData>/theme-art and
// refreshed when CS2 updates a file (the cache name carries the file's CRC).
const fs = require('fs');
const path = require('path');

const SHOTS = 'panorama/images/map_icons/screenshots/1080p/';
const TEAMS = 'panorama/images/tournaments/teams/';
const EQUIP = 'panorama/images/icons/equipment/';

// VPK v2 directory: a tree of extension → folder → file name, each with where its bytes live
// (0x7fff = in the directory file after the tree, else pak01_NNN.vpk) and optional preload bytes.
function readVpkIndex(dirFile, keep) {
  const buf = fs.readFileSync(dirFile);
  if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error('not a VPK file');
  const treeEnd = 28 + buf.readUInt32LE(8);
  let p = 28;
  const str = () => { const e = buf.indexOf(0, p); const s = buf.toString('utf8', p, e); p = e + 1; return s; };
  const files = new Map();
  for (let ext; (ext = str());) {
    for (let dir; (dir = str());) {
      for (let name; (name = str());) {
        const pre = buf.readUInt16LE(p + 4);
        const file = `${dir === ' ' ? '' : `${dir}/`}${name}.${ext}`;
        if (keep(file)) {
          files.set(file, { crc: buf.readUInt32LE(p), arc: buf.readUInt16LE(p + 6), off: buf.readUInt32LE(p + 8), len: buf.readUInt32LE(p + 12), preload: Buffer.from(buf.subarray(p + 18, p + 18 + pre)) });
        }
        p += 18 + pre;
      }
    }
  }
  return { files, treeEnd };
}

function readVpkFile(dirFile, index, file) {
  const e = index.files.get(file);
  if (!e) return null;
  if (!e.len) return e.preload;
  const inDir = e.arc === 0x7fff;
  const fd = fs.openSync(inDir ? dirFile : dirFile.replace(/_dir\.vpk$/, `_${String(e.arc).padStart(3, '0')}.vpk`), 'r');
  try {
    const b = Buffer.alloc(e.len);
    fs.readSync(fd, b, 0, e.len, inDir ? index.treeEnd + e.off : e.off);
    return Buffer.concat([e.preload, b]);
  } finally { fs.closeSync(fd); }
}

// The PNG inside a compiled panorama texture: from its signature to the end of the IEND chunk.
function embeddedPng(buf) {
  const start = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const end = buf.indexOf('IEND', start);
  return start < 0 || end < 0 ? null : buf.subarray(start, end + 8);
}
// The SVG inside a compiled vector image. Illustrator exports declare namespaces through entities in
// a DOCTYPE that gets lost here, so those references are replaced by a dummy URI.
function embeddedSvg(buf) {
  const text = buf.toString('utf8');
  const start = text.indexOf('<svg'), end = text.lastIndexOf('</svg>');
  return start < 0 || end < 0 ? null : text.slice(start, end + 6).replace(/&ns_\w+;/g, 'http://ns.adobe.com/x');
}

class ThemeArt {
  // csgoDir: () => the game\csgo folder or null
  constructor(userData, csgoDir) {
    this.dir = path.join(userData, 'theme-art');
    this.csgoDir = csgoDir;
    this.index = null;
    this.indexKey = '';
  }

  vpk() {
    const csgo = this.csgoDir();
    if (!csgo) return null;
    const file = path.join(csgo, 'pak01_dir.vpk');
    let key;
    try { const st = fs.statSync(file); key = `${file}|${st.mtimeMs}|${st.size}`; } catch { return null; }
    if (key !== this.indexKey) {
      this.index = readVpkIndex(file, f => f.startsWith(SHOTS) || f.startsWith(TEAMS) || f.startsWith(EQUIP));
      this.indexKey = key;
    }
    return { file, index: this.index };
  }

  // { maps: { de_mirage: ['de_mirage', 'de_mirage_1', …] }, teams: ['vita', …] } — null without CS2.
  list() {
    const v = this.vpk();
    if (!v) return null;
    const maps = {}, teams = [];
    for (const f of v.index.files.keys()) {
      const shot = f.startsWith(SHOTS) && f.slice(SHOTS.length).match(/^(\w+)_png\.vtex_c$/)?.[1];
      const team = f.startsWith(TEAMS) && f.slice(TEAMS.length).match(/^(\w+)\.vsvg_c$/)?.[1];
      if (shot) (maps[shot.replace(/_\d+$/, '')] ||= []).push(shot);
      else if (team) teams.push(team);
    }
    for (const list of Object.values(maps)) list.sort((a, b) => (+a.match(/_(\d+)$/)?.[1] || 0) - (+b.match(/_(\d+)$/)?.[1] || 0) || a.length - b.length);
    return { maps, teams: teams.filter(t => !/^(nologo|nosticker|center_icon)$/.test(t)).sort() };
  }

  // Writes the cached file through make(bytes) unless it already exists; drops older copies.
  cached(sub, name, ext, source, make) {
    const v = this.vpk();
    if (!v) return null;
    const entry = v.index.files.get(source);
    if (!entry) return null;
    const folder = path.join(this.dir, sub);
    const file = path.join(folder, `${name}.${entry.crc.toString(16)}${ext}`);
    if (fs.existsSync(file)) return file;
    const data = make(readVpkFile(v.file, v.index, source));
    if (!data) return null;
    fs.mkdirSync(folder, { recursive: true });
    for (const old of fs.readdirSync(folder)) if (old.startsWith(`${name}.`) && old.endsWith(ext)) fs.rmSync(path.join(folder, old), { force: true });
    fs.writeFileSync(file, data);
    return file;
  }

  // A map screenshot as JPEG: full size (1920 × 1080) for the background, or a 400 px wide thumbnail.
  shot(name, thumb = false) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('bad screenshot name');
    const { nativeImage } = require('electron');
    return this.cached('maps', name, thumb ? '.thumb.jpg' : '.jpg', `${SHOTS}${name}_png.vtex_c`, buf => {
      const png = embeddedPng(buf);
      if (!png) return null;
      const img = nativeImage.createFromBuffer(png);
      if (img.isEmpty()) return null;
      return (thumb ? img.resize({ width: 400, quality: 'best' }) : img).toJPEG(thumb ? 84 : 90);
    });
  }

  team(code) {
    if (!/^\w+$/.test(code)) throw new Error('bad team code');
    return this.cached('teams', code, '.svg', `${TEAMS}${code}.vsvg_c`, buf => embeddedSvg(buf));
  }

  // A weapon's silhouette (the one of the kill feed and buy menu), e.g. 'ak47', 'hegrenade'.
  weapon(code) {
    if (!/^\w+$/.test(code)) throw new Error('bad weapon code');
    return this.cached('weapons', code, '.svg', `${EQUIP}${code}.vsvg_c`, buf => embeddedSvg(buf));
  }
}

module.exports = { ThemeArt, readVpkIndex, readVpkFile, embeddedPng, embeddedSvg };
