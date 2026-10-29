const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  steamId: '',               // empty = logged-in Steam account
  cs2Dir: '',                // empty = auto-detect
  demoFolders: [],           // extra folders scanned besides the CS2 ones
  outputDir: '',             // empty = Videos\CS2 Clips
  ffmpegPath: '',
  encoder: 'auto',
  keepRaw: false,
  hlae: { path: '', width: 1920, height: 1080, fps: 60, port: 2121 }, // path empty = <app data>/hlae
  detection: {
    minMultiKill: 3,
    clutch: true,
    minClutch: 2,
    specials: { noscope: true, wallbang: true, smoke: true, blind: true, jumpshot: false, knife: true, zeus: true, collateral: true },
  },
  timing: {
    padBefore: 3,       // seconds kept before the first kill of a segment
    padAfter: 2,        // seconds kept after the last kill
    mergeGap: 4,        // kills closer than this (after padding) stay in one continuous shot
    startupWait: 35,    // seconds to wait after CS2's console answers before sending commands
  },
  commands: {
    setup: 'cl_drawhud 1; cl_draw_only_deathnotices 0',
  },
  montage: { fade: 0.25 },
  videoSize: { clip: 0, montage: 0 }, // target size in MB picked before recording / building a montage, 0 = best quality
  downloads: { auto: true, intervalMin: 30 },
  faceit: { playerId: '', nickname: '' }, // the FACEIT account signed in through the Downloads page
  uiScale: 0,                // 0 = automatic (bigger on 1440p and up), else a zoom factor like 1.1
  theme: 'demolab',          // a THEMES id from app.js, or 'custom'
  customTheme: { base: '#0b0f13', accent: '#2fd8a4', data: '', map: '', shot: '', logo: '', pattern: 'dots' }, // data empty = accent; map (a screenshot) or logo for the backdrop
  themeShots: {},            // map theme id → the CS2 screenshot it shows (default: the map's first)
  lowEnd: false,             // Low-end PC: read demos with fewer threads and less memory (slower)
  autoProcess: { enabled: true, measure: true, notify: true, lastScan: 0 }, // new matches: read, measure, notify (lastScan: when DemoLab last looked)
  updates: { auto: true },   // look for a new DemoLab release now and then and download it in the background
  training: { weapon: 'ak47', botWeapon: 'ak47', difficulty: 2, pistol: 'usp_silencer', nades: [], armor: 'assaultsuit', source: 'both', gsiPort: 3790, gsiToken: '' }, // last drill options; gsi: Game State Integration server (lib/training.js)
  inventory: { source: 'steam', currency: '', stickerShare: 0.1 }, // price list (steam | skinport); currency empty = the one used in your country;
                             // stickerShare: part of an applied sticker's price added to the item's value
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.data = merge(DEFAULTS, saved);
  }
  get() { return this.data; }
  update(patch) {
    this.data = merge(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.data;
  }
}

module.exports = { Settings, DEFAULTS };
