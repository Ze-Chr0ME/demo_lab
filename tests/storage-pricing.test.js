const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InventoryStore } = require('../src/lib/inventory');
const { compactCatalogue, itemDescription, loadCatalogue } = require('../src/lib/itemNames');

const id = '76561198000000000';
const files = Object.fromEntries(['skins_not_grouped', 'base_weapons', 'stickers', 'patches', 'keychains', 'music_kits', 'graffiti', 'crates', 'collectibles', 'agents', 'keys', 'tools'].map(k => [k, []]));
files.skins_not_grouped = [
  { weapon: { weapon_id: 7, name: 'AK-47' }, paint_index: '1', category: { name: 'Rifles' }, name: 'AK-47 | Test (Factory New)', market_hash_name: 'AK-47 | Test (Factory New)', wear: { name: 'Factory New' }, rarity: { name: 'Covert', color: '#eb4b4b' }, image: 'https://example.com/ak.png' },
  { weapon: { weapon_id: 500, name: 'Bayonet' }, paint_index: '418', category: { name: 'Knives' }, market_hash_name: '★ Bayonet | Doppler (Factory New)', name: '★ Bayonet | Doppler (Factory New)', wear: { name: 'Factory New' }, phase: 'Phase 1' },
];
files.stickers = [{ def_index: '10', name: 'Sticker | Test', market_hash_name: 'Sticker | Test' }];
files.keychains = [{ def_index: '1', name: 'Charm | Test', market_hash_name: 'Charm | Test' }];
const catalogue = () => compactCatalogue(files);

// CSOEconItemAttribute.value_bytes is a Buffer in globaloffensive and base64 after plain().
function gcAttribute(def_index, value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return { def_index, value_bytes: bytes.toString('base64') };
}

const gcFiles = () => ({ ...files,
  music_kits: [
    { def_index: '4', name: 'Music Kit | Test', market_hash_name: 'Music Kit | Test' },
    { def_index: '4', name: 'StatTrak™ Music Kit | Test', market_hash_name: 'StatTrak™ Music Kit | Test' },
  ],
  graffiti: [{ def_index: '1697', color_index: 1, name: 'Sealed Graffiti | Test (Brick Red)', market_hash_name: 'Sealed Graffiti | Test (Brick Red)' }],
  crates: [
    { def_index: '5120', name: 'Austin 2025 Inferno Souvenir Package', market_hash_name: 'Austin 2025 Inferno Souvenir Package' },
    { def_index: '5120', name: 'Austin 2025 Inferno Souvenir Highlight Package', market_hash_name: 'Austin 2025 Inferno Souvenir Highlight Package' },
  ],
});

test('raw GC attributes name music, StatTrak music, charms and tinted graffiti', () => {
  const c = compactCatalogue(gcFiles());
  for (const [raw, expected] of [
    [{ def_index: 1314, attribute: [gcAttribute(166, 4)] }, 'Music Kit | Test'],
    [{ def_index: 1314, attribute: [gcAttribute(166, 4), gcAttribute(80, 0), gcAttribute(81, 1)] }, 'StatTrak™ Music Kit | Test'],
    [{ def_index: 1314, quality: 9, attribute: [gcAttribute(166, 4)] }, 'StatTrak™ Music Kit | Test'],
    [{ def_index: 1355, attribute: [gcAttribute(299, 1)] }, 'Charm | Test'],
    [{ def_index: 1348, attribute: [gcAttribute(113, 1697), gcAttribute(233, 1)] }, 'Sealed Graffiti | Test (Brick Red)'],
  ]) assert.equal(itemDescription(raw, c).market_hash_name, expected);
  const gun = { def_index: 7, paint_index: 1, paint_wear: 0.1, attribute: [gcAttribute(299, 1), gcAttribute(306, 123)] };
  assert.deepEqual(itemDescription(gun, c).applied.map(x => x.name), ['Charm | Test']);
  assert.equal(itemDescription({ ...gun, keychains: [{ slot: 0, sticker_id: 1 }] }, c).applied.length, 1);
  for (const value_bytes of ['', '!!!', 'AQ==', Buffer.alloc(8).toString('base64')]) {
    assert.equal(itemDescription({ def_index: 1314, attribute: [{ def_index: 166, value_bytes }] }, c).market_hash_name, null);
  }
});

test('collisions preserve all variants and stay unpriced without a confirmed discriminator', () => {
  for (const reverse of [false, true]) {
    const f = gcFiles();
    if (reverse) { f.crates.reverse(); f.music_kits.reverse(); }
    const c = compactCatalogue(f);
    assert.equal(c.defs[5120].length, 2);
    for (const attribute of [[], [gcAttribute(314, 7)], [gcAttribute(137, 24)]]) {
      const d = itemDescription({ def_index: 5120, attribute }, c);
      assert.equal(d.name, 'Austin 2025 Inferno Souvenir Package');
      assert.equal(d.market_hash_name, null);
      assert.equal(d.marketable, false);
    }
    assert.equal(itemDescription({ def_index: 1314, attribute: [gcAttribute(166, 4)] }, c).market_hash_name, 'Music Kit | Test');
  }
  // Apply the same conservative rule outside crates, including future cross-file collisions.
  const c = compactCatalogue({ ...files,
    tools: [{ def_index: '42', name: 'Tool A', market_hash_name: 'Tool A' }],
    keys: [{ def_index: '42', name: 'Key B', market_hash_name: 'Key B' }],
    keychains: [{ def_index: '1', name: 'Charm | A', market_hash_name: 'Charm | A' }, { def_index: '1', name: 'Charm | B', market_hash_name: 'Charm | B' }],
  });
  assert.equal(c.defs[42].length, 2);
  assert.equal(itemDescription({ def_index: 42, attribute: [] }, c).market_hash_name, null);
  assert.equal(itemDescription({ def_index: 7, paint_index: 1, attribute: [gcAttribute(299, 1)] }, c).applied.length, 0);
  // The live music catalogue's kit 76 has different display names but matching market names.
  const music = compactCatalogue({ ...files, music_kits: [
    { def_index: '76', name: 'Music Kit | Artist, Song', market_hash_name: 'Music Kit | Artist and Friend, Song' },
    { def_index: '76', name: 'StatTrak™ Music Kit | Artist and Friend, Song', market_hash_name: 'StatTrak™ Music Kit | Artist and Friend, Song' },
  ] });
  assert.equal(itemDescription({ def_index: 1314, attribute: [gcAttribute(166, 76)] }, music).market_hash_name, 'Music Kit | Artist and Friend, Song');
});

function fixture(t, fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-pricing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new InventoryStore(dir, { fetch });
  const write = (name, v) => { fs.mkdirSync(store.dir, { recursive: true }); fs.writeFileSync(store.file(name), JSON.stringify(v)); };
  write(`inv-${id}.json`, { t: Date.now(), assets: [{ assetid: 'web', classid: '1', instanceid: '0' }], descriptions: [{ classid: '1', instanceid: '0', name: 'Web item', market_hash_name: 'Web item', tags: [] }] });
  write('rates.json', { t: Date.now(), r: { USD: 1, EUR: 0.9 } });
  let candidates, icons;
  store.checkSales = (_id, rows) => { candidates = rows; return null; };
  store.queueImages = rows => { icons = rows; };
  return { store, write, candidates: () => candidates, icons: () => icons };
}

test('storage rows share inventory stacking, prices, sales, pictures and history', async t => {
  const priceList = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`filler${i}`, { last_24h: 1 }]));
  Object.assign(priceList, {
    'Web item': { last_24h: 5 }, 'StatTrak™ AK-47 | Test (Minimal Wear)': { last_24h: 10, last_30d: 8 },
    '★ Bayonet | Doppler (Factory New)': { last_24h: 100 }, 'Sticker | Test': { last_24h: 20 }, 'Charm | Test': { last_24h: 3 },
  });
  const f = fixture(t, async url => { assert.match(url, /steam.json$/); return { ok: true, json: async () => priceList }; });
  f.write('catalogue.json', catalogue());
  const gun = { def_index: 7, paint_index: 1, quality: 9, paint_wear: 0.1, stickers: [{ slot: 0, sticker_id: 10, wear: 0.5 }], keychains: [{ slot: 0, sticker_id: 1 }] };
  f.write(`storage-${id}.json`, { t: Date.now() - 31 * 864e5, units: [
    { id: 'u1', name: 'Skins', count: 4, items: [{ ...gun, id: 'a', paint_seed: 20 }, { ...gun, id: 'b', paint_wear: 0.08, paint_seed: 21 }, { id: 'c', def_index: 500, paint_index: 418, paint_wear: 0.01 }, { id: 'd', def_index: 99999 }] },
    { id: 'u2', name: 'More', count: 1, items: [{ ...gun, id: 'e' }] },
  ] });
  const name = '★ Bayonet | Doppler (Factory New)';
  f.store.marketMem.set(name, { t: Date.now(), currency: 'USD', prices: [[Date.now(), 90, 10]] });
  const result = await f.store.get(id, { storageAccount: { signedIn: true, steamid: id, account: 'me', busy: false } });
  assert.equal(result.total, 137); // web 5 + three guns (10 + sticker 1 + charm 3) + knife sales 90
  assert.equal(result.storage.value, 132);
  assert.equal(result.count, 6);
  assert.equal(result.priced, 5);
  assert.equal(result.storage.count, 5);
  assert.equal(result.storage.mine, true);
  assert.deepEqual(result.storage.units.map(x => [x.value, x.priced]), [[118, 3], [14, 1]]);
  const row = result.items.find(x => x.storage?.id === 'u1' && x.type === 'Rifle');
  assert.equal(row.count, 2);
  assert.equal(row.hash, 'StatTrak™ AK-47 | Test (Minimal Wear)');
  assert.equal(row.exterior, 'Minimal Wear');
  assert.equal(row.tradable, 0);
  assert.match(row.key, /^su:u1\|/);
  assert.deepEqual(row.copies.map(x => x.float), [0.08, 0.1]);
  assert.equal(result.items.find(x => x.name === 'Unknown item 99999').value, null);
  assert.equal(result.sales.value, 90);
  assert.equal(result.applied, 12);
  assert.equal(result.trend30.then, 114);
  assert.equal(result.history.at(-1).usd, 137);
  assert(f.candidates().some(x => x.hash === name && x.marketable));
  assert(f.icons().includes('https://example.com/ak.png'));
  assert(result.notes.some(x => /Storage units were last read/.test(x)));
});

test('GC-shaped storage snapshots price decoded accessories and leave package collisions unpriced', async t => {
  const f = fixture(t, async () => { throw new Error('unexpected request'); });
  f.write('catalogue.json', compactCatalogue(gcFiles()));
  f.write('prices-steam.json', { t: Date.now(), p: {
    'Web item': [5], 'Music Kit | Test': [2], 'StatTrak™ Music Kit | Test': [4],
    'Sealed Graffiti | Test (Brick Red)': [3], 'AK-47 | Test (Minimal Wear)': [10], 'Charm | Test': [6],
    'Austin 2025 Inferno Souvenir Package': [100], 'Austin 2025 Inferno Souvenir Highlight Package': [200],
  } });
  f.write(`storage-${id}.json`, { t: Date.now(), units: [{ id: 'u', name: 'Raw GC', count: 5, items: [
    { id: 'music', def_index: 1314, attribute: [gcAttribute(166, 4)] },
    { id: 'st', def_index: 1314, attribute: [gcAttribute(166, 4), gcAttribute(80, 0), gcAttribute(81, 1)] },
    { id: 'spray', def_index: 1348, attribute: [gcAttribute(113, 1697), gcAttribute(233, 1)] },
    { id: 'gun', def_index: 7, paint_index: 1, paint_wear: 0.1, attribute: [gcAttribute(299, 1)] },
    { id: 'package', def_index: 5120, attribute: [gcAttribute(137, 24)] },
  ] }] });
  const result = await f.store.get(id);
  assert.equal(result.total, 30);
  assert.equal(result.storage.value, 25);
  assert.equal(result.applied, 6); // detachable charm counts in full
  assert.equal(result.storage.units[0].priced, 4);
  assert.equal(result.items.find(x => x.name === 'Austin 2025 Inferno Souvenir Package').value, null);
});

test('names handle exterior boundaries, souvenir and kill-eater attributes', () => {
  const c = catalogue();
  for (const [paint_wear, exterior] of [[0, 'Factory New'], [0.07, 'Minimal Wear'], [0.15, 'Field-Tested'], [0.38, 'Well-Worn'], [0.45, 'Battle-Scarred']]) {
    assert.equal(itemDescription({ def_index: 7, paint_index: 1, paint_wear, quality: 12 }, c).market_hash_name, `Souvenir AK-47 | Test (${exterior})`);
  }
  assert.equal(itemDescription({ def_index: 500, paint_index: 418, paint_wear: 0.01, attributes: [{ def_index: 80, value: 0 }] }, c).market_hash_name, '★ StatTrak™ Bayonet | Doppler (Factory New)');
});

test('catalogue downloads are compact, cached for seven days and stale on failure', async t => {
  const f = fixture(t, async () => { throw new Error('offline'); });
  let calls = 0;
  const fetch = async url => { calls++; const key = url.split('/').at(-1).replace('.json', ''); return { ok: true, json: async () => files[key].length ? files[key] : [{ def_index: '90000', name: 'Dummy' }] }; };
  const file = f.store.file('catalogue.json');
  const c = await loadCatalogue(file, fetch);
  assert.equal(calls, 12);
  assert(c.skins['7:1']);
  await loadCatalogue(file, fetch);
  assert.equal(calls, 12);
  c.t = Date.now() - 8 * 864e5;
  f.write('catalogue.json', c);
  assert.equal((await loadCatalogue(file, f.store.fetch)).t, c.t);
});

test('old lossy catalogue caches are rebuilt and cannot supply prices offline', async t => {
  const f = fixture(t, async () => { throw new Error('offline'); });
  const old = { ...catalogue(), version: 1 };
  f.write('catalogue.json', old);
  await assert.rejects(loadCatalogue(f.store.file('catalogue.json'), f.store.fetch), /offline/);
  let calls = 0;
  await loadCatalogue(f.store.file('catalogue.json'), async url => {
    calls++;
    const key = url.split('/').at(-1).replace('.json', '');
    return { ok: true, json: async () => files[key].length ? files[key] : [{ def_index: '90000', name: 'Dummy' }] };
  });
  assert.equal(calls, 12);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file('catalogue.json'))).version, 2);
});

test('accessory, music, graffiti and agent definitions use their separate IDs', () => {
  const c = compactCatalogue({ ...files,
    patches: [{ def_index: '55', name: 'Patch | Test', market_hash_name: 'Patch | Test' }],
    agents: [{ def_index: '4613', name: 'Agent Test', market_hash_name: 'Agent Test' }],
    music_kits: [{ def_index: '4', name: 'Music Kit | Test', market_hash_name: 'Music Kit | Test' }],
    graffiti: [{ def_index: '1697', color_index: 1, name: 'Sealed Graffiti | Test (Brick Red)', market_hash_name: 'Sealed Graffiti | Test (Brick Red)' }],
  });
  for (const [raw, name] of [
    [{ def_index: 1209, stickers: [{ slot: 0, sticker_id: 10 }] }, 'Sticker | Test'],
    [{ def_index: 4609, stickers: [{ slot: 0, sticker_id: 55 }] }, 'Patch | Test'],
    [{ def_index: 1355, keychains: [{ slot: 0, sticker_id: 1 }] }, 'Charm | Test'],
    [{ def_index: 1314, music_index: 4, kill_eater_value: 0 }, 'StatTrak™ Music Kit | Test'],
    [{ def_index: 1348, stickers: [{ slot: 0, sticker_id: 1697 }], graffiti_tint: 1 }, 'Sealed Graffiti | Test (Brick Red)'],
  ]) assert.equal(itemDescription(raw, c).market_hash_name, name);
  const agent = itemDescription({ def_index: 4613, stickers: [{ slot: 0, sticker_id: 55, wear: 0.2 }] }, c);
  assert.equal(agent.applied[0].name, 'Patch | Test');
  assert.equal(agent.applied[0].wear, 0.2);
  const unsealed = itemDescription({ def_index: 1349, stickers: [{ sticker_id: 1697 }], graffiti_tint: 1 }, c);
  assert.equal(unsealed.name, 'Graffiti | Test (Brick Red)');
  assert.equal(unsealed.market_hash_name, null);
});

test('missing catalogue leaves stored rows unpriced with a note', async t => {
  const f = fixture(t, async () => { throw new Error('offline'); });
  f.write(`storage-${id}.json`, { t: Date.now(), units: [{ id: 'u', name: 'Unit', count: 1, items: [{ id: 'a', def_index: 7, paint_index: 1 }] }] });
  const result = await f.store.get(id);
  assert.equal(result.storage.count, 1);
  assert.equal(result.storage.value, 0);
  assert.equal(result.items.find(x => x.storage).price, null);
  assert(result.notes.some(x => /Could not name storage items/.test(x)));
});

test('inventories without storage keep their original values', async t => {
  const f = fixture(t, async () => { throw new Error('unexpected request'); });
  f.write('prices-steam.json', { t: Date.now(), p: { 'Web item': [5, null, null] } });
  const result = await f.store.get(id);
  assert.equal(result.total, 5);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.storage.units, []);
  assert.equal(result.storage.count, 0);
});
