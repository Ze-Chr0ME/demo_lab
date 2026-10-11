// Regenerates the bundled radar images (src/renderer/radar) from a CS2 install. Run it after Valve
// updates a map's layout:
//
//   node scripts/extract-radars.js <Source2Viewer-CLI.exe> [<CS2 game\csgo folder>]
//
// Source2Viewer-CLI comes from https://github.com/ValveResourceFormat/ValveResourceFormat/releases
// (cli-windows-x64.zip). It decompiles the radar textures and the overview files that say where each
// image sits in the world (resource/overviews/<map>.txt: upper-left corner and units per pixel).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [cli, csgo = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo'] = process.argv.slice(2);
if (!cli) { console.error('usage: node scripts/extract-radars.js <Source2Viewer-CLI.exe> [<csgo folder>]'); process.exit(1); }

const out = path.join(__dirname, '..', 'src', 'renderer', 'radar');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radars-'));
execFileSync(cli, ['-i', path.join(csgo, 'pak01_dir.vpk'), '-o', tmp, '-d', '-f', 'panorama/images/overheadmaps/,resource/overviews/', '--threads', '4'], { stdio: 'ignore' });

// Valve KeyValues, just enough for overview files: nested "key" { … } blocks and "key" "value" pairs.
function parseKv(text) {
  const tokens = [...text.replace(/\/\/[^\n]*/g, '').matchAll(/"([^"]*)"|([{}])/g)].map(m => m[2] || { s: m[1] });
  let i = 0;
  const block = () => {
    const o = {};
    while (i < tokens.length && tokens[i] !== '}') {
      const key = tokens[i++].s;
      if (tokens[i] === '{') { i++; o[key] = block(); i++; } else o[key] = tokens[i++]?.s;
    }
    return o;
  };
  return block();
}

const images = path.join(tmp, 'panorama', 'images', 'overheadmaps');
const overviews = path.join(tmp, 'resource', 'overviews');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const maps = {};
for (const file of fs.readdirSync(overviews)) {
  const name = path.basename(file, '.txt');
  const image = ['_radar_psd.png', '_radar_tga.png'].map(s => path.join(images, name + s)).find(f => fs.existsSync(f));
  if (!image || name.startsWith('workshop')) continue;
  const kv = Object.values(parseKv(fs.readFileSync(path.join(overviews, file), 'utf8')))[0];
  const entry = { x: +kv.pos_x, y: +kv.pos_y, scale: +kv.scale };
  fs.copyFileSync(image, path.join(out, `${name}.png`));
  // Maps with two floors (Nuke, Vertigo, Train…) have a second image for everything below an altitude.
  const lower = kv.verticalsections?.lower;
  const lowerImage = path.join(images, `${name}_lower_radar_psd.png`);
  if (lower && fs.existsSync(lowerImage)) {
    fs.copyFileSync(lowerImage, path.join(out, `${name}_lower.png`));
    entry.lowerBelow = +lower.AltitudeMax;
  }
  // Rush: the overview shows the whole hotel; each room also has its own close-up image.
  for (const [room, v] of Object.entries(kv.Volumes || {})) {
    const roomImage = path.join(images, `${name}_${room}_radar_tga.png`);
    if (!fs.existsSync(roomImage)) continue;
    fs.copyFileSync(roomImage, path.join(out, `${name}_${room}.png`));
    (entry.rooms ||= {})[room] = { x: +v.pos_x, y: +v.pos_y, scale: +v.scale };
  }
  maps[name] = entry;
}
fs.writeFileSync(path.join(out, 'maps.json'), JSON.stringify(maps, null, 1) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${Object.keys(maps).length} maps written to ${out}`);
