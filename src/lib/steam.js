// Locates Steam, the CS2 install, demo folders and the logged-in Steam account.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CS2_REL = path.join('steamapps', 'common', 'Counter-Strike Global Offensive');

// Minimal Valve KeyValues (VDF) text parser.
function parseVdf(text) {
  let i = 0;
  const skip = () => {
    while (i < text.length) {
      if (/\s/.test(text[i])) i++;
      else if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
      else break;
    }
  };
  const str = () => {
    if (text[i] !== '"') { const m = /^[^\s{}"]+/.exec(text.slice(i)); i += m[0].length; return m[0]; }
    i++;
    let s = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < text.length) { s += text[i + 1]; i += 2; } else s += text[i++];
    }
    i++;
    return s;
  };
  const obj = () => {
    const o = {};
    for (;;) {
      skip();
      if (i >= text.length || text[i] === '}') { i++; return o; }
      const k = str();
      skip();
      if (text[i] === '{') { i++; o[k] = obj(); } else o[k] = str();
    }
  };
  return obj();
}

function findSteamPath() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out);
    if (m && fs.existsSync(m[1].trim())) return path.normalize(m[1].trim());
  } catch {}
  const fallback = 'C:\\Program Files (x86)\\Steam';
  return fs.existsSync(fallback) ? fallback : null;
}

function libraryFolders(steamPath) {
  const libs = new Set([steamPath]);
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const root = vdf.libraryfolders || vdf.LibraryFolders || {};
    for (const v of Object.values(root)) {
      if (v && typeof v === 'object' && v.path) libs.add(path.normalize(v.path));
    }
  } catch {}
  return [...libs];
}

function findCs2Dir(steamPath) {
  if (!steamPath) return null;
  for (const lib of libraryFolders(steamPath)) {
    const dir = path.join(lib, CS2_REL);
    if (fs.existsSync(path.join(dir, 'game', 'csgo'))) return dir;
  }
  return null;
}

function findSteamUser(steamPath) {
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(steamPath, 'config', 'loginusers.vdf'), 'utf8'));
    const users = Object.entries(vdf.users || {}).map(([id, u]) => ({ steamid: id, name: u.PersonaName, recent: u.MostRecent === '1', ts: +u.Timestamp || 0 }));
    users.sort((a, b) => (b.recent - a.recent) || (b.ts - a.ts));
    return users[0] || null;
  } catch { return null; }
}

function detect() {
  const steamPath = findSteamPath();
  const cs2Dir = findCs2Dir(steamPath);
  return { steamPath, cs2Dir, csgoDir: cs2Dir ? path.join(cs2Dir, 'game', 'csgo') : null, steamUser: steamPath ? findSteamUser(steamPath) : null };
}

module.exports = { detect, parseVdf };
