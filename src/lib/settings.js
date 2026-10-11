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
  // 'hlae' = background recording through HLAE (CS2 doesn't need focus); 'obs' = OBS + CS2 in front.
  recording: { method: 'hlae' },
  hlae: { path: '', width: 1920, height: 1080, fps: 60, port: 2121 }, // path empty = <app data>/hlae
  obs: { host: '127.0.0.1', port: 4455, password: '' },
  control: { method: 'keypress', key: 'scrolllock', netconPort: 2121 },
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
    startupWait: 35,    // seconds to wait after CS2's window appears before sending commands
    demoLoadWait: 25,   // seconds to wait after playdemo
    seekWait: 4,        // seconds to wait after jumping to a tick
    specWait: 1.5,      // seconds to wait after switching to the player
  },
  commands: {
    setup: 'cl_drawhud 1; cl_draw_only_deathnotices 0',
    seek: 'demo_gototick {tick}; demo_pause',
    spectate: 'spec_player_by_accountid {accountid}; spec_player "{name}"',
  },
  montage: { fade: 0.25 },
  downloads: { auto: true, intervalMin: 30 },
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
