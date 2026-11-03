// The GC sends numeric definitions; the public catalogue supplies Steam's English market names.
const fs = require('fs');
const path = require('path');
const URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
const TTL = 7 * 864e5;
const FILES = ['skins_not_grouped', 'base_weapons', 'stickers', 'patches', 'keychains', 'music_kits', 'graffiti', 'crates', 'collectibles', 'agents', 'keys', 'tools'];
const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(v));
  fs.renameSync(`${file}.tmp`, file);
}
const bare = n => n.replace(/^★\s*/, '').replace(/^(StatTrak™|Souvenir)\s*/, '').replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '');
function weaponType(def, category) {
  if ([9, 11, 38, 40].includes(+def)) return 'Sniper Rifle';
  if ([25, 27, 29, 35].includes(+def)) return 'Shotgun';
  if ([14, 28].includes(+def)) return 'Machinegun';
  return { Rifles: 'Rifle', Pistols: 'Pistol', SMGs: 'SMG', Knives: 'Knife' }[category] || category || 'Other';
}

function compactCatalogue(files) {
  const c = { version: 2, t: Date.now(), skins: {}, defs: {}, stickers: {}, patches: {}, keychains: {}, music: {}, graffiti: {} };
  // Retain every definition variant; resolution must never depend on catalogue order.
  const add = (map, key, value) => {
    const variants = map[key] ||= [];
    if (!variants.some(x => JSON.stringify(x) === JSON.stringify(value))) variants.push(value);
  };
  const entry = (x, type) => ({ name: x.name, hash: x.market_hash_name ?? null, type, rarity: x.rarity || null, icon: x.image || null });
  for (const x of files.base_weapons) {
    const type = weaponType(x.def_index, x.category?.name);
    add(c.defs, x.def_index, { ...entry(x, type), name: bare(x.name), weapon: x.name, hash: type === 'Knife' && +x.def_index >= 500 ? bare(x.name) : null, star: ['Knife', 'Gloves'].includes(type) });
  }
  for (const x of files.skins_not_grouped) {
    const key = `${x.weapon.weapon_id}:${x.paint_index}`;
    const type = weaponType(x.weapon.weapon_id, x.category?.name);
    add(c.skins, key, { ...entry(x, type), name: bare(x.market_hash_name || x.name), hash: x.market_hash_name ? bare(x.market_hash_name) : null, weapon: x.weapon.name, star: ['Knife', 'Gloves'].includes(type), painted: !!x.wear });
  }
  for (const [file, map, type] of [['stickers', 'stickers', 'Sticker'], ['patches', 'patches', 'Patch'], ['keychains', 'keychains', 'Charm'], ['music_kits', 'music', 'Music Kit'], ['graffiti', 'graffiti', 'Graffiti']]) {
    for (const x of files[file]) {
      const key = file === 'graffiti' ? `${x.def_index}:${x.color_index || 0}` : x.def_index;
      // Music kits have a second entry for StatTrak; the GC's quality selects the prefix.
      add(c[map], key, { ...entry(x, type), name: (x.market_hash_name || x.name).replace(/^StatTrak™ /, ''), hash: x.market_hash_name?.replace(/^StatTrak™ /, '') || null });
    }
  }
  for (const [file, type] of [['crates', 'Container'], ['collectibles', 'Collectible'], ['agents', 'Agent'], ['keys', 'Key'], ['tools', 'Tool']]) {
    for (const x of files[file]) add(c.defs, x.def_index, { ...entry(x, /Pass/.test(x.type || x.name) ? 'Pass' : type), hash: x.market_hash_name ?? (file === 'tools' && x.def_index !== '1201' ? x.name : null) });
  }
  return c;
}

async function loadCatalogue(file, fetch) {
  const disk = readJson(file);
  if (disk?.version === 2 && Date.now() - disk.t < TTL) return disk;
  try {
    const data = await Promise.all(FILES.map(async name => {
      const res = await fetch(`${URL}${name}.json`, { signal: AbortSignal.timeout(45e3) });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) throw new Error(`${name}: empty catalogue`);
      return [name, rows];
    }));
    const c = compactCatalogue(Object.fromEntries(data));
    writeJson(file, c);
    return c;
  } catch (err) {
    if (disk?.version === 2) return disk;
    throw err;
  }
}

// Confirmed in SteamDatabase/GameTracking-CS2's game/csgo/pak01_dir/scripts/items/items_game.txt:
// 166 music id, 233 spray tint id, 299 keychain slot 0 id (all stored_as_integer).
// globaloffensive@3.3.0 handlers.js reads integer attributes as uint32 LE but omits these.
function attributeUint(item, index) {
  const attr = (item.attribute || item.attributes || []).find(x => +(x.def_index ?? x.defIndex) === index);
  const raw = attr?.value_bytes;
  const bytes = Buffer.isBuffer(raw) ? raw : typeof raw === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  return bytes?.length === 4 ? bytes.readUInt32LE(0) : null;
}

function resolve(variants) {
  if (!Array.isArray(variants)) return variants; // also accept callers' single-entry fixtures
  if (!variants.length) return null;
  // Wear and StatTrak prefixes are normalized at ingestion and reconstructed from the GC item.
  if (variants.every(x => x.name === variants[0].name && x.hash === variants[0].hash)) return variants[0];
  // The schema defines 314 as an applied keychain's highlight, but does not establish a
  // package discriminator. Do not guess from it (or from tournament/team attributes).
  const base = [...variants].sort((a, b) => Number(/Highlight/.test(a.name)) - Number(/Highlight/.test(b.name)) || a.name.localeCompare(b.name))[0];
  return { ...base, hash: null, ambiguous: true };
}

function itemDescription(a, c) {
  const def = +a.def_index;
  const charmId = attributeUint(a, 299);
  const keychains = a.keychains?.length ? a.keychains : charmId ? [{ slot: 0, sticker_id: charmId }] : [];
  const music = num(a.music_index) ?? attributeUint(a, 166);
  const tint = num(a.graffiti_tint) ?? attributeUint(a, 233) ?? 0;
  const sticker = a.stickers?.find(x => +x.slot === 0) || a.stickers?.[0] || { sticker_id: attributeUint(a, 113) };
  let e;
  if (def === 1209) e = c?.stickers?.[sticker?.sticker_id];
  else if (def === 4609) e = c?.patches?.[sticker?.sticker_id];
  else if (def === 1355) e = c?.keychains?.[keychains[0]?.sticker_id];
  else if (def === 1314) e = c?.music?.[music]; // 1315 is the Operation Vanguard pass, not a music kit
  else if ([1348, 1349].includes(def)) e = c?.graffiti?.[`${sticker?.sticker_id}:${tint}`];
  else e = num(a.paint_index) ? c?.skins?.[`${def}:${a.paint_index}`] : c?.defs?.[def];
  e = resolve(e);
  if (!e) return { name: `Unknown item ${a.def_index}`, market_hash_name: null, tags: [], applied: [], custom_name: a.custom_name };
  if (def === 1349) e = { ...e, name: e.name.replace(/^Sealed /, ''), hash: null };
  const st = +a.quality === 9 || a.kill_eater != null || a.kill_eater_value != null || a.kill_eater_score_type != null || (a.attributes || a.attribute || []).some(x => [80, 81].includes(+(x.def_index ?? x.defIndex)));
  const quality = +a.quality === 12 ? 'Souvenir' : st ? 'StatTrak™' : null;
  const wear = num(a.paint_wear);
  const exterior = e.painted && wear != null ? (wear < 0.07 ? 'Factory New' : wear < 0.15 ? 'Minimal Wear' : wear < 0.38 ? 'Field-Tested' : wear < 0.45 ? 'Well-Worn' : 'Battle-Scarred') : null;
  const prefix = `${e.star ? '★ ' : ''}${quality ? `${quality} ` : ''}`;
  const name = `${prefix}${e.name}${exterior ? ` (${exterior})` : ''}`;
  const hash = e.ambiguous ? null : e.painted ? (exterior ? name : null) : e.hash ? `${prefix}${e.hash}` : null;
  const tags = [];
  const tag = (category, value, color) => { if (value) tags.push({ category, localized_tag_name: value, color: color?.replace(/^#/, '') }); };
  tag('Type', e.type); tag('Weapon', e.weapon); tag('Exterior', exterior); tag('Quality', quality); tag('Rarity', e.rarity?.name, e.rarity?.color);
  const applied = [];
  if (!['Sticker', 'Patch', 'Charm', 'Graffiti'].includes(e.type)) {
    for (const x of a.stickers || []) {
      const acc = resolve((e.type === 'Agent' ? c?.patches : c?.stickers)?.[x.sticker_id]);
      if (acc && !acc.ambiguous) applied.push({ kind: acc.type, name: acc.hash || acc.name, img: acc.icon, ...(num(x.wear) != null ? { wear: +x.wear } : {}) });
    }
    for (const x of keychains) {
      const acc = resolve(c?.keychains?.[x.sticker_id]);
      if (acc && !acc.ambiguous) applied.push({ kind: 'Charm', name: acc.hash || acc.name, img: acc.icon });
    }
  }
  return { name, market_hash_name: hash, market_name: hash, marketable: !!hash, tradable: 0, icon_url: e.icon, tags, applied, custom_name: a.custom_name };
}

module.exports = { loadCatalogue, compactCatalogue, itemDescription };
