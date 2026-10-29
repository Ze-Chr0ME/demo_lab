// Pictures for the themes, taken from the player's own CS2 install: the map screenshots CS2 shows in
// its map picker (1080p, several angles per map) and the maps' emblems, the team logos it uses for
// tournament stickers and the weapon silhouettes of the kill feed (Weapons tab).
// All sit in pak01_dir.vpk inside Valve's compiled resource files, but as plain PNG / SVG data, so
// a small VPK reader is enough (no Source2Viewer). Results are cached in <userData>/theme-art and
// refreshed when CS2 updates a file (the cache name carries the file's CRC).
const fs = require('fs');
const path = require('path');

const MAP_ICONS = 'panorama/images/map_icons/';
const SHOTS = `${MAP_ICONS}screenshots/1080p/`;
const TEAMS = 'panorama/images/tournaments/teams/';
const EQUIP = 'panorama/images/icons/equipment/';
const DEATHNOTICE = 'panorama/images/hud/deathnotice/';

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
// The SVG inside a compiled vector image. Illustrator exports declare namespaces (and sometimes styles)
// through entities in a DOCTYPE; when the compiler kept it, those entities get their declared value,
// otherwise namespace entities become their real or a dummy URI and any other one is dropped, since an
// undefined entity makes the whole picture fail to load. A root without a viewBox gets one from its
// width and height, else the drawing doesn't scale with the <img> and shows cropped or tiny.
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const KNOWN_NS = { ns_svg: 'http://www.w3.org/2000/svg', ns_xlink: 'http://www.w3.org/1999/xlink' };
function embeddedSvg(buf) {
  const text = buf.toString('utf8');
  const start = text.indexOf('<svg'), end = text.lastIndexOf('</svg>');
  if (start < 0 || end < 0) return null;
  const declared = new Map([...text.slice(0, start).matchAll(/<!ENTITY\s+(\w+)\s+"([^"]*)"/g)].map(m => [m[1], m[2]]));
  let svg = text.slice(start, end + 6).replace(/&(\w+);/g, (m, name) => {
    if (XML_ENTITIES.has(name)) return m;
    if (declared.has(name)) return declared.get(name);
    return KNOWN_NS[name] || (name.startsWith('ns_') ? 'http://ns.adobe.com/x' : '');
  });
  const root = svg.slice(0, svg.indexOf('>') + 1);
  if (!/\sviewBox\s*=/.test(root)) {
    const size = k => +(root.match(new RegExp(`\\s${k}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`))?.[1] || 0);
    if (size('width') > 0 && size('height') > 0) svg = `<svg viewBox="0 0 ${size('width')} ${size('height')}"${svg.slice(4)}`;
  }
  return svg;
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
      this.index = readVpkIndex(file, f => f.startsWith(MAP_ICONS) || f.startsWith(TEAMS) || f.startsWith(EQUIP) || f.startsWith(DEATHNOTICE));
      this.indexKey = key;
    }
    return { file, index: this.index };
  }

  // { maps: { de_mirage: ['de_mirage', 'de_mirage_1', …] }, icons: ['de_mirage', …], teams: ['vita', …] }
  // — null without CS2.
  list() {
    const v = this.vpk();
    if (!v) return null;
    const maps = {}, icons = [], teams = [];
    for (const f of v.index.files.keys()) {
      const shot = f.startsWith(SHOTS) && f.slice(SHOTS.length).match(/^(\w+)_png\.vtex_c$/)?.[1];
      const icon = f.startsWith(MAP_ICONS) && f.slice(MAP_ICONS.length).match(/^map_icon_(\w+)\.vsvg_c$/)?.[1];
      const team = f.startsWith(TEAMS) && f.slice(TEAMS.length).match(/^(\w+)\.vsvg_c$/)?.[1];
      if (shot) (maps[shot.replace(/_\d+$/, '')] ||= []).push(shot);
      else if (icon) icons.push(icon);
      else if (team) teams.push(team);
    }
    for (const list of Object.values(maps)) list.sort((a, b) => (+a.match(/_(\d+)$/)?.[1] || 0) - (+b.match(/_(\d+)$/)?.[1] || 0) || a.length - b.length);
    return { maps, icons: icons.sort(), teams: teams.filter(t => !/^(nologo|nosticker|center_icon)$/.test(t)).sort() };
  }

  // Writes the cached file through make(bytes) unless it already exists; drops older copies. rev changes
  // the file name when make() changes, so copies made by an older version are rebuilt.
  cached(sub, name, ext, source, make, rev = '') {
    const v = this.vpk();
    if (!v) return null;
    const entry = v.index.files.get(source);
    if (!entry) return null;
    const folder = path.join(this.dir, sub);
    const file = path.join(folder, `${name}.${entry.crc.toString(16)}${rev}${ext}`);
    if (fs.existsSync(file)) return file;
    const data = make(readVpkFile(v.file, v.index, source));
    if (!data) return null;
    fs.mkdirSync(folder, { recursive: true });
    for (const old of fs.readdirSync(folder)) if (old.startsWith(`${name}.`) && old.endsWith(ext)) fs.rmSync(path.join(folder, old), { force: true });
    fs.writeFileSync(file, data);
    return file;
  }

  // A map screenshot as JPEG: full size (1920 × 1080) for the background and the Maps page, or a 640 px
  // wide thumbnail for the theme previews (sharp up to about 300 px shown at 200 % zoom). Thumbnails get
  // their own folder, else cached() dropping older '<name>.*.jpg' copies deletes the other one.
  shot(name, thumb = false) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('bad screenshot name');
    const { nativeImage } = require('electron');
    return this.cached(thumb ? 'map-thumbs' : 'maps', name, '.jpg', `${SHOTS}${name}_png.vtex_c`, buf => {
      const png = embeddedPng(buf);
      if (!png) return null;
      const img = nativeImage.createFromBuffer(png);
      if (img.isEmpty()) return null;
      if (thumb) this.dropOldThumbs();
      return (thumb ? img.resize({ width: 640, quality: 'best' }) : img).toJPEG(thumb ? 86 : 90);
    });
  }

  dropOldThumbs() {
    if (this.oldThumbsGone) return;
    this.oldThumbsGone = true;
    const folder = path.join(this.dir, 'maps');
    try { for (const f of fs.readdirSync(folder)) if (f.endsWith('.thumb.jpg')) fs.rmSync(path.join(folder, f), { force: true }); } catch {}
  }

  // The map's emblem from CS2's map picker (a 32 × 32 vector drawing, so it is sharp at any size).
  mapIcon(map) {
    if (!/^\w+$/.test(map)) throw new Error('bad map name');
    return this.cached('map-icons', map, '.svg', `${MAP_ICONS}map_icon_${map}.vsvg_c`, buf => embeddedSvg(buf));
  }

  team(code) {
    if (!/^\w+$/.test(code)) throw new Error('bad team code');
    return this.cached('teams', code, '.svg', `${TEAMS}${code}.vsvg_c`, buf => embeddedSvg(buf), '.2');
  }

  // The logo's SVG text, for measuring how it should be drawn (see Scene.teamLook in the renderer).
  teamSvg(code) {
    const file = this.team(code);
    return file ? fs.readFileSync(file, 'utf8') : null;
  }

  // A weapon's silhouette (the one of the kill feed and buy menu), e.g. 'ak47', 'hegrenade'.
  weapon(code) {
    if (!/^\w+$/.test(code)) throw new Error('bad weapon code');
    return this.cached('weapons', code, '.svg', `${EQUIP}${code}.vsvg_c`, buf => embeddedSvg(buf));
  }

  // A kill feed mark: 'icon_headshot', 'penetrate' (wallbang), 'noscope', 'inairkill', 'blind_kill', 'smoke_kill'.
  killIcon(name) {
    if (!/^\w+$/.test(name)) throw new Error('bad icon name');
    return this.cached('deathnotice', name, '.svg', `${DEATHNOTICE}${name}.vsvg_c`, buf => embeddedSvg(buf));
  }
}

module.exports = { ThemeArt, readVpkIndex, readVpkFile, embeddedPng, embeddedSvg };
