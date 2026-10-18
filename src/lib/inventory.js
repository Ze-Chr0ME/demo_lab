// A player's CS2 inventory and what it is worth. The items come from the Steam Community inventory
// (steamcommunity.com/inventory/<id>/730/2: public inventories, or your own private one when you are
// signed in to Steam Community in the Downloads tab). Prices come from one big list for every item, so a
// whole inventory is valued in one request instead of one Steam Market request per item (which Steam
// throttles to ~20 a minute):
//   steam    — Steam Community Market sale prices, collected by CSGO Trader (prices.csgotrader.app)
//   skinport — the cheapest Skinport listing (api.skinport.com)
// Prices are kept in US dollars and converted with the exchange rates from prices.csgotrader.app.
// Everything lives in <userData>/inventory: the last inventory per player, price lists (6 h), item
// pictures (once) and a value history per player (one point per hour at most).
// Items in storage units are not part of the Steam inventory and are not counted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRICE_TTL = 6 * 3600e3;
const INV_TTL = 10 * 60e3;       // a fresh inventory is reused for 10 min unless a refresh is asked for
const HISTORY_GAP = 3600e3;
const PARALLEL = 4;
const IMG = 'https://community.akamai.steamstatic.com/economy/image/';
const SOURCES = {
  steam: { label: 'Steam Market', url: 'https://prices.csgotrader.app/latest/steam.json' },
  skinport: { label: 'Skinport', url: 'https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0' },
};
const FX_URL = 'https://prices.csgotrader.app/latest/exchange_rates.json';
const MARKET_TTL = 3 * 3600e3;
// The most valuable items are priced from their own Steam Market sales (the price list is only an
// estimate, often well above what things actually sell for). A sales history is used for 2 days and
// read again in the background after 6 h, at most STEAM_ITEMS of them per inventory, one every 4 s.
const SALES_USE = 48 * 3600e3;
const SALES_REFRESH = 6 * 3600e3;
const STEAM_ITEMS = 40;
const STEAM_MIN_USD = 0.5;
const STEAM_GAP = 4000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Price from a sales history: the average sale over the last day with sales (the last week when that day
// had fewer than 3 sales), and the 7- and 30-day averages, all in the history's currency.
function salesPrice(m) {
  const last = m.prices[m.prices.length - 1]?.[0];
  if (!last) return null;
  const avg = days => {
    let w = 0, n = 0;
    for (const [t, p, c] of m.prices) if (t > last - days * 864e5) { const k = Math.max(1, c); w += p * k; n += k; }
    return n ? { v: w / n, n } : null;
  };
  let now = avg(1);
  if (!now || now.n < 3) now = avg(7) || now;
  return { price: now.v, avg7: avg(7)?.v ?? null, avg30: avg(30)?.v ?? null, lastSale: last };
}
// Steam's ECurrencyCode → ISO code (the price history comes in the currency of the viewer's country).
const ECURRENCY = { 1: 'USD', 2: 'GBP', 3: 'EUR', 4: 'CHF', 5: 'RUB', 6: 'PLN', 7: 'BRL', 8: 'JPY', 9: 'NOK', 10: 'IDR', 11: 'MYR', 12: 'PHP', 13: 'SGD',
  14: 'THB', 15: 'VND', 16: 'KRW', 17: 'TRY', 18: 'UAH', 19: 'MXN', 20: 'CAD', 21: 'AUD', 22: 'NZD', 23: 'CNY', 24: 'INR', 25: 'CLP', 26: 'PEN', 27: 'COP',
  28: 'ZAR', 29: 'HKD', 30: 'TWD', 31: 'SAR', 32: 'AED', 34: 'ARS', 35: 'ILS', 37: 'KZT', 38: 'KWD', 39: 'QAR', 40: 'CRC', 41: 'UYU' };

// The Steam Market listing page carries the page's data as JSON (<script id="valve-ssr-data">), with a
// "pricehistory" query for the item: a median sale price and a sale count per day, per hour for the last month.
function marketHistory(html, name) {
  const m = /<script[^>]*id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('Steam changed its market page (no page data)');
  const ssr = JSON.parse(m[1]);
  const q = JSON.parse(ssr.renderContext?.queryData || '{}');
  const hit = (q.queries || []).find(e => e.queryKey?.[1] === 'pricehistory' && e.queryKey?.[3] === name);
  const data = hit?.state?.data;
  if (!data?.prices) return null;
  const currency = ECURRENCY[data.ecurrency];
  if (!currency) throw new Error(`unknown Steam currency ${data.ecurrency}`);
  return { currency, prices: data.prices.filter(p => p.price_median > 0).map(p => [p.time * 1000, Math.round(p.price_median * 1e4) / 1e4, p.purchases || 0]) };
}

const clampShare = v => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : 0.1);
const isSteamId = id => typeof id === 'string' && /^7656119\d{10}$/.test(id);
const httpError = (what, res) => Object.assign(new Error(`${what}: HTTP ${res.status}`), { status: res.status });
const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(v));
  fs.renameSync(`${file}.tmp`, file);
}

// A price list as { market_hash_name: [price, avg7, avg30] } in USD.
function pricesOf(source, raw) {
  const out = {};
  if (source === 'steam') {
    for (const [name, p] of Object.entries(raw || {})) {
      const price = num(p?.last_24h) ?? num(p?.last_7d) ?? num(p?.last_30d) ?? num(p?.last_90d);
      if (price != null) out[name] = [price, num(p.last_7d), num(p.last_30d)];
    }
  } else {
    for (const p of Array.isArray(raw) ? raw : []) {
      const price = num(p.min_price) ?? num(p.median_price) ?? num(p.suggested_price);
      if (price != null) out[p.market_hash_name] = [price, null, null];
    }
  }
  return out;
}

const tag = (d, cat) => d.tags?.find(t => t.category === cat);
const plain = html => String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const decode = t => String(t).replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Stickers, patches and charms on an item, from the "sticker_info" / "keychain_info" blocks: one
// <img src title="Sticker: name"> each, in the order of the asset's accessories. name is the market name.
function applied(d) {
  const out = [];
  for (const x of d.descriptions || []) {
    if (!/sticker_info|keychain_info/.test(x.name || '')) continue;
    const before = out.length;
    for (const m of String(x.value).matchAll(/<img[^>]*?\bsrc="([^"]+)"[^>]*?\btitle="([^"]+)"/g)) {
      const k = /^(Sticker|Patch|Charm):\s*(.+)$/.exec(decode(m[2]).trim());
      if (k) out.push({ kind: k[1], name: `${k[1]} | ${k[2].trim()}`, img: m[1] });
    }
    if (out.length > before) continue;
    // no pictures: the caption ("Sticker: a, b, c")
    const m = /(Sticker|Patch|Charm)s?:\s*(.+)$/i.exec(plain(x.value));
    if (m) out.push(...m[2].split(/,\s*(?![^()]*\))/).map(n => n.trim()).filter(n => n.length > 1).map(n => ({ kind: m[1], name: `${m[1]} | ${decode(n)}`, img: null })));
  }
  return out;
}

// One row per item (identical items are stacked: same name, stickers, sticker wear and name tag), with every
// copy's float and pattern.
function buildItems(inv) {
  const desc = new Map(inv.descriptions.map(d => [`${d.classid}_${d.instanceid}`, d]));
  const props = new Map((inv.props || []).map(p => [p.assetid, p]));
  const rows = new Map();
  for (const a of inv.assets) {
    const d = desc.get(`${a.classid}_${a.instanceid}`);
    if (!d) continue;
    const ap = props.get(a.assetid);
    const app = applied(d);
    // Each accessory's wear (property 4: 0 = like new, up to 1 = scraped off), same order as the pictures.
    const acc = ap?.asset_accessories || [];
    if (acc.length === app.length) {
      app.forEach((x, i) => {
        const w = num(acc[i].parent_relationship_properties?.find(p => p.propertyid === 4)?.float_value);
        if (w && x.kind !== 'Charm') x.wear = w;
      });
    }
    const tagLine = (d.fraudwarnings || []).map(plain).find(w => /Name Tag/i.test(w));
    const nameTag = tagLine ? tagLine.replace(/^Name Tag:\s*/i, '').replace(/^''|''$/g, '') : null;
    const key = [d.market_hash_name || d.name, ...app.map(x => `${x.name}@${(x.wear || 0).toFixed(2)}`), nameTag || ''].join('|');
    let r = rows.get(key);
    if (!r) {
      const rarity = tag(d, 'Rarity');
      const type = tag(d, 'Type');
      r = {
        key, name: d.name, hash: d.market_hash_name, marketName: d.market_name,
        type: type?.localized_tag_name || d.type || 'Other', typeId: type?.internal_name || '',
        weapon: tag(d, 'Weapon')?.localized_tag_name || null,
        exterior: tag(d, 'Exterior')?.localized_tag_name || null,
        quality: tag(d, 'Quality')?.localized_tag_name || null,
        collection: tag(d, 'ItemSet')?.localized_tag_name || null,
        rarity: rarity ? { name: rarity.localized_tag_name, color: `#${rarity.color || 'b0c3d9'}` } : null,
        nameColor: d.name_color ? `#${d.name_color}` : null,
        icon: d.icon_url_large || d.icon_url || null,
        marketable: !!d.marketable, count: 0, tradable: 0, copies: [],
        applied: app, stickers: app.map(x => x.name), nameTag,
      };
      rows.set(key, r);
    }
    const n = Math.max(1, +a.amount || 1);
    r.count += n;
    if (d.tradable) r.tradable += n;
    const p = ap?.asset_properties || [];
    const float = num(p.find(x => x.propertyid === 2)?.float_value);
    const pattern = num(p.find(x => x.propertyid === 1)?.int_value);
    if (float != null || pattern != null) r.copies.push({ assetid: a.assetid, float, pattern });
  }
  for (const r of rows.values()) r.copies.sort((x, y) => (x.float ?? 9) - (y.float ?? 9));
  return [...rows.values()];
}

class InventoryStore {
  // fetch: Electron's net.fetch (prices, pictures); steamFetch: a fetch that carries the Steam Community
  // login (so your own private inventory works); onImages: called with { icon: file } as pictures arrive.
  // onSales: progress of the background Steam sales check, { steamid, done, total, running }.
  constructor(dir, { fetch, steamFetch, onImages, onSales, log = () => {} }) {
    this.dir = path.join(dir, 'inventory');
    this.imgDir = path.join(this.dir, 'img');
    this.fetch = fetch;
    this.steamFetch = steamFetch || fetch;
    this.onImages = onImages;
    this.onSales = onSales;
    this.log = log;
    this.marketMem = new Map(); // market name -> sales history read from disk
    this.marketFailed = new Map(); // market name -> when Steam last had nothing for it
    this.salesJob = null;
    this.prices = {};   // source -> { t, p }
    this.jobs = new Map();
    this.imgQueue = [];
    this.imgQueued = new Set();
    this.imgRunning = 0;
  }

  file(name) { return path.join(this.dir, name); }

  // The inventory with prices. refresh: read it again from Steam even when the last copy is recent.
  // stickerShare: the part of an applied sticker's price added to the item (charms come off and count in full).
  async get(steamid, { source = 'steam', refresh = false, stickerShare = 0.1 } = {}) {
    if (!isSteamId(steamid)) throw new Error('No SteamID: set yours in Settings → Counter-Strike 2.');
    if (!SOURCES[source]) source = 'steam';
    const notes = [];
    let inv = readJson(this.file(`inv-${steamid}.json`));
    if (refresh || !inv || Date.now() - inv.t > INV_TTL) {
      try {
        inv = await this.once(`inv|${steamid}`, () => this.download(steamid));
      } catch (err) {
        if (!inv) throw err;
        notes.push(`Could not read the inventory again (${err.message}): showing the copy from ${new Date(inv.t).toLocaleString()}.`);
      }
    }
    let list = null, fx = null;
    try { list = await this.priceList(source); } catch (err) { notes.push(`No ${SOURCES[source].label} prices (${err.message}).`); }
    try { fx = await this.rates(); } catch (err) { notes.push(`No exchange rates (${err.message}): prices are in US dollars.`); }

    const items = buildItems(inv);
    const rates = fx?.r || { USD: 1 };
    const useSales = source === 'steam';
    // [price, avg7, avg30] in dollars: the item's own Steam sales when we have them, else the price list.
    const sales = new Map();
    const priceOf = name => {
      if (useSales && name) {
        if (!sales.has(name)) {
          const m = this.marketCached(name);
          const sp = m && rates[m.currency] && Date.now() - m.t < SALES_USE ? salesPrice(m) : null;
          sales.set(name, sp && { p: [sp.price / rates[m.currency], sp.avg7 == null ? null : sp.avg7 / rates[m.currency], sp.avg30 == null ? null : sp.avg30 / rates[m.currency]], at: m.t, lastSale: sp.lastSale });
        }
        const sp = sales.get(name);
        if (sp) return { p: sp.p, from: 'sales', at: sp.at, lastSale: sp.lastSale };
      }
      const p = name && list?.p[name];
      return p ? { p, from: 'list' } : null;
    };
    let total = 0, applied = 0, priced = 0, avg30 = 0, avg30Base = 0, fromSales = 0, salesValue = 0;
    for (const r of items) {
      const q = priceOf(r.hash);
      const p = q?.p;
      r.price = p ? p[0] : null;
      r.avg7 = p ? p[1] : null;
      r.avg30 = p ? p[2] : null;
      r.priceFrom = q?.from || null;
      r.salesAt = q?.at || null;
      r.lastSale = q?.lastSale || null;
      // Stickers and charms: an estimate on top of the item's own price. A charm can be taken off and kept, so it
      // counts in full; an applied sticker only adds a part of its price (less the more it is scraped).
      r.appliedValue = 0;
      for (const x of r.applied) {
        const xq = priceOf(x.name);
        x.price = xq?.p[0] ?? null;
        x.priceFrom = xq?.from || null;
        x.share = x.kind === 'Charm' ? 1 : clampShare(stickerShare) * (1 - Math.min(1, x.wear || 0));
        r.appliedValue += (x.price || 0) * x.share;
      }
      r.value = r.price == null && !r.appliedValue ? null : (r.price || 0) + r.appliedValue;
      if (r.value == null) continue;
      total += r.value * r.count;
      applied += r.appliedValue * r.count;
      priced += r.count;
      if (r.avg30 != null) { avg30 += r.avg30 * r.count; avg30Base += r.price * r.count; }
      if (r.priceFrom === 'sales') { fromSales += r.count; salesValue += r.price * r.count; }
    }
    const job = useSales ? this.checkSales(steamid, items) : null;
    const history = this.record(steamid, inv, total, items.reduce((n, r) => n + r.count, 0), useSales ? 'steam-sales' : source);
    const icons = [...items.map(r => r.icon), ...items.flatMap(r => r.applied.map(x => x.img))];
    this.queueImages(icons);
    return {
      steamid, t: inv.t, total, applied, stickerShare: clampShare(stickerShare), priced, count: items.reduce((n, r) => n + r.count, 0), inventoryCount: inv.total ?? null,
      // the value of the priced items at their 30-day average price, against the same items now
      trend30: avg30Base ? { now: avg30Base, then: avg30 } : null,
      items, history, notes,
      source, sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.label])), pricesAt: list?.t || null,
      rates: fx?.r || { USD: 1 },
      images: this.knownImages(icons),
      sales: useSales ? { items: fromSales, value: salesValue, job } : null,
    };
  }

  once(key, fn) {
    if (!this.jobs.has(key)) this.jobs.set(key, fn().finally(() => this.jobs.delete(key)));
    return this.jobs.get(key);
  }

  async download(steamid) {
    const assets = [], descriptions = [], props = [];
    const seen = new Set();
    let start = null, total = null;
    for (let page = 0; page < 30; page++) {
      const url = `https://steamcommunity.com/inventory/${steamid}/730/2?l=english&count=1000${start ? `&start_assetid=${start}` : ''}`;
      const res = await this.steamFetch(url);
      if (res.status === 403 || res.status === 401) throw new Error('This inventory is private. Make it public in Steam (Profile → Edit Profile → Privacy Settings), or sign in to Steam Community in the Downloads tab to see your own.');
      if (res.status === 404) throw new Error('Steam has no CS2 inventory for this player (or it is private).');
      if (res.status === 429) throw new Error('Steam is limiting inventory requests right now. Try again in a minute.');
      if (!res.ok) throw httpError('Steam inventory', res);
      const j = await res.json().catch(() => null);
      if (!j || j.success === false || j.success === 0) throw new Error(j?.error || 'Steam did not return the inventory.');
      total = j.total_inventory_count ?? total;
      assets.push(...(j.assets || []));
      props.push(...(j.asset_properties || []));
      for (const d of j.descriptions || []) {
        const k = `${d.classid}_${d.instanceid}`;
        if (!seen.has(k)) { seen.add(k); descriptions.push(d); }
      }
      if (!j.more_items || !j.last_assetid) break;
      start = j.last_assetid;
    }
    const inv = { t: Date.now(), total, assets, descriptions, props };
    writeJson(this.file(`inv-${steamid}.json`), inv);
    this.log(`inventory ${steamid}: ${assets.length} items, ${descriptions.length} kinds`);
    return inv;
  }

  async priceList(source) {
    const mem = this.prices[source];
    if (mem && Date.now() - mem.t < PRICE_TTL) return mem;
    const file = this.file(`prices-${source}.json`);
    const disk = mem || readJson(file);
    if (disk && Date.now() - disk.t < PRICE_TTL) return (this.prices[source] = disk);
    try {
      const fresh = await this.once(`prices|${source}`, async () => {
        const res = await this.fetch(SOURCES[source].url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw httpError(SOURCES[source].label, res);
        const p = pricesOf(source, await res.json());
        if (Object.keys(p).length < 1000) throw new Error('the price list looks empty');
        const v = { t: Date.now(), p };
        writeJson(file, v);
        return v;
      });
      return (this.prices[source] = fresh);
    } catch (err) {
      if (disk) { this.log(`prices ${source}: ${err.message}, keeping the list from ${new Date(disk.t).toISOString()}`); return (this.prices[source] = disk); }
      throw err;
    }
  }

  async rates() {
    const file = this.file('rates.json');
    const disk = this.fx || readJson(file);
    if (disk && Date.now() - disk.t < PRICE_TTL) return (this.fx = disk);
    try {
      const res = await this.fetch(FX_URL);
      if (!res.ok) throw httpError('exchange rates', res);
      const r = await res.json();
      if (!r || r.USD !== 1 || !r.EUR) throw new Error('unexpected exchange rates');
      this.fx = { t: Date.now(), r };
      writeJson(file, this.fx);
      return this.fx;
    } catch (err) {
      if (disk) return (this.fx = disk);
      throw err;
    }
  }

  // Steam Market sales of one item over its whole life (cached 3 h): { t, currency, prices: [[ms, price, sold]] }.
  marketFile(name) { return path.join(this.dir, 'market', `${crypto.createHash('sha1').update(name).digest('hex').slice(0, 24)}.json`); }
  marketCached(name) {
    if (!this.marketMem.has(name)) this.marketMem.set(name, readJson(this.marketFile(name)));
    return this.marketMem.get(name);
  }

  // Reads the Steam sales of the most valuable items (by their current price) whose history is missing or
  // older than 6 h, one after the other in the background. Returns the job's progress (null when there's nothing to do).
  checkSales(steamid, items) {
    if (this.salesJob) return this.salesStatus();
    const worth = new Map();
    const add = (name, usd) => { if (name && usd > 0) worth.set(name, (worth.get(name) || 0) + usd); };
    for (const r of items) {
      if (r.marketable) add(r.hash, (r.price || 0) * r.count);
      for (const x of r.applied) add(x.name, (x.price || 0) * x.share * r.count);
    }
    const top = [...worth].filter(([, v]) => v >= STEAM_MIN_USD).sort((a, b) => b[1] - a[1]).slice(0, STEAM_ITEMS).map(([n]) => n);
    const todo = top.filter(n => {
      const m = this.marketCached(n);
      const failed = this.marketFailed.get(n);
      return (!m || Date.now() - m.t > SALES_REFRESH) && !(failed && Date.now() - failed < SALES_REFRESH);
    });
    if (!todo.length) return null;
    const job = this.salesJob = { steamid, total: todo.length, done: 0 };
    (async () => {
      for (const name of todo) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await this.market(name, { force: true }); break; } catch (err) {
            // Steam answers too many requests with 429, and sometimes with a 500 that works a bit later.
            const busy = err.status === 429 || err.status >= 500;
            if (busy && !attempt) { await sleep(err.status === 429 ? 60e3 : 20e3); continue; }
            this.marketFailed.set(name, Date.now());
            this.log(`Steam sales of ${name}: ${err.message}`);
            if (err.status === 429) job.stopped = 'Steam is limiting market requests';
            break;
          }
        }
        job.done++;
        this.onSales?.(this.salesStatus());
        if (job.stopped) break;
        await sleep(STEAM_GAP);
      }
    })().catch(err => this.log('Steam sales check:', err.message)).finally(() => {
      this.salesJob = null;
      this.onSales?.({ ...job, running: false });
    });
    return this.salesStatus();
  }
  salesStatus() { return this.salesJob ? { ...this.salesJob, running: true } : null; }

  async market(name, { force = false } = {}) {
    if (typeof name !== 'string' || !name || name.length > 200) throw new Error('No market name');
    const file = this.marketFile(name);
    const disk = this.marketCached(name);
    if (disk && Date.now() - disk.t < (force ? 60e3 : MARKET_TTL)) return disk;
    try {
      return await this.once(`market|${name}`, async () => {
        // The page is 2-4 MB and can take 10 s; a request that hangs must not stall the whole sales check.
        const res = await this.fetch(`https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(45e3) });
        if (res.status === 429) throw Object.assign(new Error('Steam is limiting market requests right now. Try again in a minute.'), { status: 429 });
        if (!res.ok) throw httpError('Steam Market', res);
        const h = marketHistory(await res.text(), name);
        if (!h) throw new Error('Steam has no sales of this item');
        const v = { t: Date.now(), ...h };
        writeJson(file, v);
        this.marketMem.set(name, v);
        return v;
      });
    } catch (err) {
      if (disk && !force) return { ...disk, stale: err.message };
      throw err;
    }
  }

  // One point per hour at most (a newer one replaces the last if it's closer than that).
  // Each point remembers how it was priced (m): only points priced the same way are compared, so switching
  // the price source doesn't draw a fake jump. (Points from before m existed used the plain price list.)
  record(steamid, inv, usd, n, m) {
    const file = this.file(`history-${steamid}.json`);
    const all = (readJson(file) || []).filter(p => p.m);
    const hist = all.filter(p => p.m === m);
    if (usd > 0) {
      const last = hist[hist.length - 1];
      const point = { t: inv.t, usd: Math.round(usd * 100) / 100, n, m };
      if (last && last.t === point.t && Math.abs(last.usd - point.usd) < 0.005) return hist;
      if (last && point.t - last.t < HISTORY_GAP) all[all.indexOf(last)] = hist[hist.length - 1] = point;
      else { all.push(point); hist.push(point); }
      try { writeJson(file, all); } catch (err) { this.log('inventory history:', err.message); }
    }
    return hist;
  }

  // ---- item pictures (Steam's CDN, cached on disk; the page's CSP only allows local files)
  imgFile(icon) { return path.join(this.imgDir, `${crypto.createHash('sha1').update(icon).digest('hex').slice(0, 24)}.png`); }
  knownImages(icons) {
    const out = {};
    for (const i of icons) if (i) { const f = this.imgFile(i); if (fs.existsSync(f)) out[i] = f; }
    return out;
  }
  queueImages(icons) {
    for (const i of icons) {
      if (!i || this.imgQueued.has(i) || fs.existsSync(this.imgFile(i))) continue;
      this.imgQueued.add(i);
      this.imgQueue.push(i);
    }
    this.pumpImages();
  }
  pumpImages() {
    while (this.imgRunning < PARALLEL && this.imgQueue.length) {
      const icon = this.imgQueue.shift();
      this.imgRunning++;
      this.fetchImage(icon)
        .then(file => this.onImages?.({ [icon]: file }))
        .catch(err => this.log('item picture:', err.message))
        .finally(() => { this.imgRunning--; this.pumpImages(); });
    }
  }
  async fetchImage(icon) {
    const res = await this.fetch(/^https:\/\//.test(icon) ? icon : `${IMG}${icon}/256fx256f`);
    if (!res.ok) throw httpError('picture', res);
    const file = this.imgFile(icon);
    fs.mkdirSync(this.imgDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${file}.tmp`, file);
    return file;
  }
}

// The currency people in this country see on Steam, when the exchange rates have it.
const EURO = new Set('AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' '));
const CURRENCY = { GB: 'GBP', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', TR: 'TRY', RU: 'RUB',
  UA: 'UAH', BR: 'BRL', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', KR: 'KRW', IN: 'INR', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
  ZA: 'ZAR', IL: 'ILS', SA: 'SAR', AE: 'AED', KZ: 'KZT', SG: 'SGD', HK: 'HKD', TW: 'TWD', TH: 'THB', MY: 'MYR', ID: 'IDR', PH: 'PHP', VN: 'VND', IS: 'ISK' };
const localCurrency = country => (EURO.has(country) ? 'EUR' : CURRENCY[country] || 'USD');

module.exports = { InventoryStore, buildItems, pricesOf, marketHistory, localCurrency, SOURCES };
