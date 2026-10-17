/* global $, api, state, h, icon, ICONS, toast, card, barList, select, toggle, modal, closeModal, spinner, avatar, steamAvatar, ago, fmtNum, clamp, showView */
'use strict';
// The Inventory page: what a player's CS2 items are worth, item by item. lib/inventory.js reads the Steam
// inventory and a price list for every item; this page converts the dollars to your currency, adds them up,
// and shows the value over time (one point each time the inventory is read, at most one per hour).

state.inv = { who: null, data: null, error: null, loading: false, q: '', type: 'all', sort: 'total', hideFree: false, currency: '' };
const invImages = new Map(); // icon_url -> file
// The main process prices the most valuable items from their Steam sales in the background: show the
// progress, and read the inventory again (cached, no Steam request) every few items and at the end.
api.onInventorySales(v => {
  const st = state.inv;
  st.salesJob = v.running ? v : null;
  const mine = st.data && st.data.steamid === v.steamid;
  if (!mine || state.view !== 'inventory') return;
  if (!v.running || v.done % 5 === 0) loadInventory();
  else { const el = $('#invSales'); if (el) el.textContent = ` checking Steam sales ${v.done}/${v.total}`; }
});
api.onInventoryImages(v => {
  for (const [k, f] of Object.entries(v)) {
    invImages.set(k, f);
    for (const img of document.querySelectorAll('img.inv-pic[data-icon]')) if (img.dataset.icon === k) img.src = api.fileUrl(f);
  }
});
api.inventoryDefaults().then(d => { state.inv.defaultCurrency = d.currency; }).catch(() => {});

// The types in the order people think of them; anything else goes after, alphabetically.
const INV_TYPES = ['Knife', 'Gloves', 'Rifle', 'Sniper Rifle', 'Pistol', 'SMG', 'Shotgun', 'Machinegun', 'Agent', 'Sticker', 'Patch', 'Charm',
  'Container', 'Key', 'Music Kit', 'Graffiti', 'Pass', 'Tool', 'Collectible', 'Equipment'];
const invTypeRank = t => { const i = INV_TYPES.indexOf(t); return i < 0 ? 99 : i; };
const INV_SORTS = [['total', 'Total value'], ['price', 'Price per item'], ['change', 'Price change (30 days)'], ['count', 'Quantity'], ['rarity', 'Rarity'], ['name', 'Name'], ['float', 'Float (lowest first)']];
const RARITY_ORDER = ['Contraband', 'Extraordinary', 'Covert', 'Master', 'Classified', 'Superior', 'Restricted', 'Exceptional', 'Remarkable', 'Mil-Spec Grade', 'Distinguished', 'High Grade', 'Industrial Grade', 'Consumer Grade', 'Base Grade'];
const rarityRank = r => { const i = RARITY_ORDER.indexOf(r?.name); return i < 0 ? 99 : i; };

function invCurrency() {
  const d = state.inv.data;
  const want = state.settings?.inventory?.currency || state.inv.defaultCurrency || 'USD';
  return d?.rates?.[want] ? want : 'USD';
}
// Dollars → the chosen currency, formatted like the system formats money.
function invMoney(usd, { cents = true } = {}) {
  if (usd == null) return '—';
  const cur = invCurrency();
  const v = usd * (state.inv.data?.rates?.[cur] || 1);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(v);
  } catch { return `${v.toFixed(cents ? 2 : 0)} ${cur}`; }
}
const invChange = (now, then) => (now != null && then ? now / then - 1 : null);
function invChangeEl(c, title) {
  if (c == null || !Number.isFinite(c)) return null;
  const p = Math.round(c * 1000) / 10;
  return h('span', { class: `trend ${p > 0 ? 'up' : p < 0 ? 'down' : ''}`, title }, `${p > 0 ? '▲' : p < 0 ? '▼' : ''} ${Math.abs(p).toFixed(1)}%`);
}

function loadInventory(refresh = false) {
  const st = state.inv;
  const who = st.who;
  st.loading = true;
  st.error = null;
  api.inventory(who, refresh)
    .then(d => { if (st.who !== who) return; st.data = d; for (const [k, f] of Object.entries(d.images || {})) invImages.set(k, f); })
    .catch(e => { if (st.who === who) st.error = e.message; })
    .finally(() => { if (st.who !== who) return; st.loading = false; if (state.view === 'inventory') renderInventory(); });
}

function openInventory(steamid, name) {
  if (steamid === state.env?.mySteamId) steamid = null;
  if ((steamid || null) !== state.inv.who) { state.inv.who = steamid || null; state.inv.data = null; state.inv.error = null; }
  state.inv.whoName = name || null;
  showView('inventory');
}

function renderInventory() {
  const view = $('#view-inventory');
  const st = state.inv, me = state.env?.mySteamId;
  const page = (...body) => view.replaceChildren(h('div', { class: 'page dash-page inv-page' }, ...body));
  const back = st.who ? h('button', { class: 'btn', onclick: () => openInventory(null) }, '← My inventory') : null;
  if (!st.who && !me) return page(h('div', { class: 'empty' }, h('h2', {}, 'Which player are you?'), h('div', {}, 'No Steam account was found on this PC. Enter your SteamID64 in Settings → Counter-Strike 2.')));
  const d = st.data && (st.data.steamid === (st.who || me)) ? st.data : null;
  if (!d && !st.loading && !st.error) loadInventory();
  if (!d) {
    return page(st.error
      ? h('div', { class: 'empty' }, icon(ICONS.demo, 'class="big"'), h('h2', {}, 'Could not read the inventory'), h('div', { class: 'err-box' }, st.error),
        h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } }, back, h('button', { class: 'btn primary', onclick: () => loadInventory(true) }, 'Try again')))
      : h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Reading the inventory from Steam…'), h('div', {}, 'And looking up a price for every item.')));
  }

  const isMe = d.steamid === me;
  const name = isMe ? state.profile?.name || state.env?.steamUser?.name || 'You' : st.whoName || 'Player';
  const cur = invCurrency();
  const currencies = Object.keys(d.rates).sort();
  const setInv = patch => api.setSettings({ inventory: patch }).then(s => { state.settings = s; }).catch(e => toast(e.message, 'error'));

  const head = h('div', { class: 'dash-head' },
    steamAvatar(name, d.steamid, 'large'),
    h('div', { class: 'dash-title' },
      h('h2', {}, isMe ? 'Inventory' : `${name}’s inventory`, !isMe ? h('span', { class: 'dash-tag', title: `SteamID ${d.steamid}` }, 'Player') : null),
      h('div', { class: 'sub' }, `${fmtNum(d.count)} item${d.count === 1 ? '' : 's'}`,
        ` · read ${ago(d.t)}`,
        d.pricesAt ? ` · ${d.sources[d.source]} prices from ${ago(d.pricesAt)}` : null,
        st.loading ? h('span', {}, ' · ', spinner(11), ' updating') : null,
        (st.salesJob || d.sales?.job)?.steamid === d.steamid
          ? h('span', { title: 'The most valuable items are priced from what they sold for on Steam (one item every few seconds, so Steam doesn’t block DemoLab)' },
            ' · ', spinner(11), h('span', { id: 'invSales' }, ` checking Steam sales ${(st.salesJob || d.sales.job).done}/${(st.salesJob || d.sales.job).total}`))
          : null)),
    h('span', { class: 'spacer' }),
    back,
    h('div', { class: 'filters' },
      select(d.source, Object.entries(d.sources).map(([k, l]) => [k, `${l} prices`]), v => { setInv({ source: v }).then(() => loadInventory()); }),
      select(cur, currencies.map(c => [c, c]), v => { setInv({ currency: v }).then(() => renderInventory()); }),
      invShareSelect(d, setInv)),
    h('button', { class: 'btn', disabled: st.loading, title: 'Read the inventory from Steam again', onclick: () => loadInventory(true) },
      icon('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2"/>'), 'Refresh'));

  const notes = d.notes.length ? h('div', { class: 'info-box' }, ...d.notes.map(n => h('div', {}, n))) : null;

  // ---- summary cards
  const unpriced = d.count - d.priced;
  const tradable = d.items.reduce((n, r) => n + r.tradable, 0);
  const tradableValue = d.items.reduce((n, r) => n + (r.value || 0) * r.tradable, 0);
  const valueCard = card('Inventory value', [
    h('div', { class: 'big-line' }, h('span', { class: 'big inv-total' }, invMoney(d.total)),
      d.trend30 ? invChangeEl(invChange(d.trend30.now, d.trend30.then), `Against the same items at their 30-day average price (${invMoney(d.trend30.then)})`) : null),
    h('div', { class: 'kv' },
      h('div', { class: 'kv-row' }, h('span', {}, 'Priced items'), h('b', {}, `${fmtNum(d.priced)} of ${fmtNum(d.count)}`)),
      h('div', { class: 'kv-row', title: 'Items you can trade or sell right now (new items have a 7-day trade hold)' }, h('span', {}, 'Tradable now'), h('b', {}, `${fmtNum(tradable)} · ${invMoney(tradableValue)}`)),
      d.sales?.items ? h('div', { class: 'kv-row', title: 'These items are priced from their own Steam Market sales over the last day (the last week for rarely sold items). The rest use the price list.' },
        h('span', {}, 'Priced from Steam sales'), h('b', {}, `${fmtNum(d.sales.items)} · ${invMoney(d.sales.value)}`)) : null,
      d.applied > 0.005 ? h('div', { class: 'kv-row', title: `Included in the value: charms at their full price (they come off), applied stickers at ${Math.round(d.stickerShare * 100)}% of theirs, less when scraped` }, h('span', {}, 'Stickers & charms on items'), h('b', {}, `+${invMoney(d.applied)}`)) : null,
      h('div', { class: 'kv-row' }, h('span', {}, 'Average per priced item'), h('b', {}, invMoney(d.priced ? d.total / d.priced : 0))),
      unpriced ? h('div', { class: 'kv-row', title: 'Medals, coins, badges and other items that cannot be sold' }, h('span', {}, 'Without a price'), h('b', {}, fmtNum(unpriced))) : null),
    h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Storage unit contents are not part of the Steam inventory and are not counted.'),
  ]);

  const byType = new Map();
  for (const r of d.items) {
    const x = byType.get(r.type) || byType.set(r.type, { v: 0, n: 0 }).get(r.type);
    x.v += (r.value || 0) * r.count; x.n += r.count;
  }
  const types = [...byType].sort((a, b) => b[1].v - a[1].v || invTypeRank(a[0]) - invTypeRank(b[0]));
  const maxType = Math.max(1e-9, ...types.map(([, x]) => x.v));
  const typeCard = card('By type', barList(types.filter(([, x]) => x.v > 0).slice(0, 8).map(([t, x]) => ({
    label: t, note: `${fmtNum(x.n)} item${x.n === 1 ? '' : 's'}`, value: invMoney(x.v, { cents: false }), frac: x.v / maxType,
    title: `Show only ${t}`, onclick: () => { st.type = st.type === t ? 'all' : t; renderInventory(); },
  })), { empty: 'No priced items' }));

  page(head, notes,
    h('div', { class: 'dash inv-dash' }, valueCard, invHistoryCard(d), typeCard),
    invItemsSection(d));
}

// A line of dollar values over time (pts: [{ t, usd, n? }]) with a crosshair and a tooltip on the nearest
// point. volume: a strip of bars under the line for the sale counts (n), on its own baseline.
function invChart(pts, { W = 800, H = 240, volume = false, tip }) {
  const padL = 64, padR = 12, padT = 12, padB = 24, volH = volume ? 46 : 0;
  const plotB = H - padB - volH;
  const vals = pts.map(p => p.usd);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.02, 0.01);
  lo = Math.max(0, lo - pad); hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = t => padL + (W - padL - padR) * ((t - t0) / Math.max(1, t1 - t0));
  const y = v => padT + (plotB - padT) * (1 - (v - lo) / (hi - lo));
  const cents = hi < 20;
  const grid = [];
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${padL - 6}" y="${y(v) + 4}" class="g-t">${invMoney(v, { cents }).replace(/[<&]/g, '')}</text>`);
  }
  const long = t1 - t0 > 300 * 864e5;
  const fmtDay = t => new Date(t).toLocaleDateString(undefined, long ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  const axis = `<text x="${padL}" y="${H - 6}" class="g-t" style="text-anchor:start">${fmtDay(t0)}</text><text x="${W - padR}" y="${H - 6}" class="g-t">${fmtDay(t1)}</text>`;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.usd).toFixed(1)}`).join('');
  const area = `${line}L${x(t1)},${plotB}L${x(t0)},${plotB}Z`;
  let bars = '';
  if (volume) {
    const maxN = Math.max(1, ...pts.map(p => p.n || 0));
    const bw = Math.max(1, Math.min(6, (W - padL - padR) / pts.length - 1));
    const base = H - padB;
    bars = `<line x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}" class="g"/><text x="${padL - 6}" y="${base - volH / 2 + 4}" class="g-t">sold</text>`
      + pts.map(p => { const bh = Math.max(1, (volH - 8) * (p.n || 0) / maxN); return `<rect x="${(x(p.t) - bw / 2).toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1" class="inv-vol"/>`; }).join('');
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg"><defs><linearGradient id="tFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="t-stop-a"/><stop offset="1" class="t-stop-b"/></linearGradient></defs>${grid.join('')}${axis}${bars}
    <path d="${area}" class="t-area"/><path d="${line}" class="t-line"/>
    <line class="inv-cross hidden" y1="${padT}" y2="${H - padB}"/><circle class="inv-dot hidden" r="5"/></svg>`;
  const tipEl = h('div', { class: 'inv-tip hidden' });
  const el = h('div', { class: 'trend-wrap inv-hist', html: svg });
  el.append(tipEl);
  const sv = el.querySelector('svg'), cross = sv.querySelector('.inv-cross'), dot = sv.querySelector('.inv-dot');
  el.addEventListener('mousemove', e => {
    const b = sv.getBoundingClientRect();
    const vx = (e.clientX - b.left) / b.width * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(x(p.t) - vx) < Math.abs(x(pts[best].t) - vx)) best = i; });
    const p = pts[best], px = x(p.t), py = y(p.usd);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    cross.classList.remove('hidden'); dot.classList.remove('hidden');
    tipEl.replaceChildren(...tip(p, pts[best - 1]));
    tipEl.classList.remove('hidden');
    tipEl.style.left = `${clamp(px / W * b.width, 80, b.width - 80)}px`;
    tipEl.style.top = `${py / H * b.height}px`;
  });
  el.addEventListener('mouseleave', () => { tipEl.classList.add('hidden'); cross.classList.add('hidden'); dot.classList.add('hidden'); });
  return el;
}
const fmtWhen = (t, hours = true) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', ...(hours ? { hour: '2-digit', minute: '2-digit' } : {}) });

// Applied stickers sell for a part of their own price (and nothing once scraped off); how big a part is a
// guess, so it's a setting. Charms always count in full: they can be taken off and sold.
const INV_SHARES = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 1];
function invShareSelect(d, setInv) {
  const cur = d.stickerShare ?? 0.1;
  const opts = [...new Set([...INV_SHARES, cur])].sort((a, b) => a - b);
  const el = select(String(cur), opts.map(v => [String(v), v ? `Stickers at ${Math.round(v * 100)}%` : 'Stickers not counted']), v => { setInv({ stickerShare: +v }).then(() => loadInventory()); });
  el.title = 'How much of an applied sticker’s price is added to the item’s value (an estimate: applied stickers resell for a fraction of their price, scraped ones for less). Charms always count in full.';
  return el;
}

// The inventory's value each time it was read (in today's currency rate, with that day's prices).
function invHistoryCard(d) {
  const pts = d.history.filter(p => p.usd > 0);
  if (pts.length < 2) {
    return card('Value over time', h('div', { class: 'muted-note' }, 'A point is added each time DemoLab reads this inventory (at most one an hour). Come back in a while to see the curve.'), { span: 2 });
  }
  const el = invChart(pts, { tip: (p, prev) => [h('b', {}, invMoney(p.usd)), h('div', {}, fmtWhen(p.t)),
    h('div', { class: 'hint' }, `${fmtNum(p.n)} items`, prev ? [' · ', invChangeEl(invChange(p.usd, prev.usd), 'Since the point before')] : null)] });
  const first = pts[0];
  return card('Value over time', el, { span: 2, extra: h('span', { class: 'hint' }, `${pts.length} points since ${new Date(first.t).toLocaleDateString()} · `, invChangeEl(invChange(pts[pts.length - 1].usd, first.usd), 'Since the first point')) });
}

// ---- Steam Market price graph of one item (item popup)
const INV_RANGES = [['7', '1W'], ['30', '1M'], ['90', '3M'], ['365', '1Y'], ['all', 'All']];
const invMarket = new Map(); // market name -> Promise of { currency, prices: [[ms, price, sold]] }
function invPriceGraph(r) {
  const box = h('div', { class: 'inv-graph' }, h('div', { class: 'hint' }, spinner(12), ' Loading Steam Market sales…'));
  if (!invMarket.has(r.hash)) invMarket.set(r.hash, api.inventoryMarket(r.hash).catch(e => { invMarket.delete(r.hash); throw e; }));
  invMarket.get(r.hash).then(m => {
    const rate = state.inv.data?.rates?.[m.currency];
    if (!rate) throw new Error(`no exchange rate for ${m.currency}`);
    // Sales → dollars, then shown in the chosen currency like every other price.
    const all = m.prices.map(([t, p, n]) => ({ t, usd: p / rate, n }));
    if (!all.length) throw new Error('Steam has no sales of this item');
    // What it sold for on Steam over the last day of sales (can differ from the price list above).
    const day = all.filter(p => p.t > all[all.length - 1].t - 864e5);
    const daySold = day.reduce((n, p) => n + Math.max(1, p.n), 0);
    const recent = day.reduce((n, p) => n + p.usd * Math.max(1, p.n), 0) / daySold;
    let range = state.inv.range || '90';
    const draw = () => {
      const days = range === 'all' ? Infinity : +range;
      const from = all[all.length - 1].t - days * 864e5;
      let pts = all.filter(p => p.t >= from);
      // Steam keeps one point per hour for the last month: over longer ranges, one point per day.
      const daily = days > 31;
      if (daily) {
        const byDay = new Map();
        for (const p of pts) {
          const k = Math.floor(p.t / 864e5);
          const x = byDay.get(k) || byDay.set(k, { t: k * 864e5, w: 0, s: 0, n: 0 }).get(k);
          x.w += p.usd * Math.max(1, p.n); x.s += Math.max(1, p.n); x.n += p.n;
        }
        pts = [...byDay.values()].map(x => ({ t: x.t, usd: x.w / x.s, n: x.n }));
      }
      if (pts.length < 2) pts = all.slice(-2);
      const sold = pts.reduce((n, p) => n + p.n, 0);
      box.replaceChildren(...[
        h('div', { class: 'inv-graph-head' },
          h('div', { class: 'sub-head' }, 'Steam Market sales'),
          h('span', { class: 'hint' }, `${fmtNum(sold)} sold · `, invChangeEl(invChange(pts[pts.length - 1].usd, pts[0].usd), 'Over this range')),
          h('span', { class: 'hint', title: `Average sale price over the last day with sales (${fmtWhen(all[all.length - 1].t)})` }, 'Latest sales ', h('b', { class: 'inv-recent' }, invMoney(recent))),
          h('span', { class: 'spacer' }),
          h('div', { class: 'inv-seg' }, ...INV_RANGES.map(([k, l]) => h('button', { class: k === range ? 'on' : '', onclick: () => { range = state.inv.range = k; draw(); } }, l)))),
        invChart(pts, { W: 800, H: 230, volume: true, tip: p => [h('b', {}, invMoney(p.usd)), h('div', {}, fmtWhen(p.t, !daily)),
          h('div', { class: 'hint' }, `${fmtNum(p.n)} sold that ${daily ? 'day' : 'hour'} · median price`)] }),
        m.stale ? h('div', { class: 'hint' }, `Sales read ${ago(m.t)} (Steam did not answer now: ${m.stale})`) : null].filter(Boolean));
    };
    draw();
  }).catch(e => box.replaceChildren(h('div', { class: 'hint' }, `No price graph: ${e.message}`)));
  return box;
}

function invItemsSection(d) {
  const st = state.inv;
  const q = st.q.trim().toLowerCase();
  const types = [...new Set(d.items.map(r => r.type))].sort((a, b) => invTypeRank(a) - invTypeRank(b) || a.localeCompare(b));
  if (st.type !== 'all' && !types.includes(st.type)) st.type = 'all';
  let list = d.items.filter(r => (st.type === 'all' || r.type === st.type) && (!st.hideFree || r.value != null)
    && (!q || `${r.hash || r.name} ${r.type} ${r.collection || ''} ${r.nameTag || ''} ${r.stickers.join(' ')}`.toLowerCase().includes(q)));
  const by = {
    total: (a, b) => (b.value || 0) * b.count - (a.value || 0) * a.count,
    price: (a, b) => (b.value ?? -1) - (a.value ?? -1),
    change: (a, b) => (invChange(b.price, b.avg30) ?? -9) - (invChange(a.price, a.avg30) ?? -9),
    count: (a, b) => b.count - a.count,
    rarity: (a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || (b.value || 0) - (a.value || 0),
    name: (a, b) => (a.hash || a.name).localeCompare(b.hash || b.name),
    float: (a, b) => (a.copies[0]?.float ?? 9) - (b.copies[0]?.float ?? 9),
  }[st.sort] || (() => 0);
  list = [...list].sort((a, b) => by(a, b) || (a.hash || a.name).localeCompare(b.hash || b.name));
  const shownValue = list.reduce((n, r) => n + (r.value || 0) * r.count, 0);
  const shownCount = list.reduce((n, r) => n + r.count, 0);

  const search = h('input', { type: 'search', class: 'inv-search', placeholder: 'Search items, collections, stickers…', value: st.q, oninput: e => {
    st.q = e.target.value;
    clearTimeout(invItemsSection.timer);
    invItemsSection.timer = setTimeout(() => {
      const at = e.target.selectionStart;
      renderInventory();
      const box = $('.inv-search');
      if (box) { box.focus(); box.setSelectionRange(at, at); }
    }, 180);
  } });
  const filters = h('div', { class: 'filters inv-filters' }, search,
    select(st.type, [['all', 'All types'], ...types.map(t => [t, t])], v => { st.type = v; renderInventory(); }),
    select(st.sort, INV_SORTS, v => { st.sort = v; renderInventory(); }),
    toggle('Only priced items', st.hideFree, v => { st.hideFree = v; renderInventory(); }, 'Hide medals, coins and other items that have no market price'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'hint' }, `${fmtNum(shownCount)} item${shownCount === 1 ? '' : 's'} · ${invMoney(shownValue)}`));

  return h('section', { class: 'ov-sec' }, h('div', { class: 'sec' }, h('h3', {}, 'Items')), filters,
    list.length ? h('div', { class: 'inv-grid' }, ...list.map(invItemCard))
      : h('div', { class: 'empty' }, h('h2', {}, 'No items match'), h('div', {}, 'Try another search or type.')));
}

function invPic(r, cls = '', key = r.icon) {
  const f = key && invImages.get(key);
  return h('img', { class: `inv-pic ${cls}`, 'data-icon': key || null, src: f ? api.fileUrl(f) : 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', alt: '', draggable: 'false' });
}
// "StatTrak™ AK-47 | Redline (Field-Tested)" → weapon line + skin line.
function invNames(r) {
  const [top, ...rest] = r.name.split(' | ');
  return rest.length ? [top, rest.join(' | ')] : [r.type, r.name];
}
const fmtFloat = f => (f == null ? null : f.toFixed(f < 0.01 ? 6 : 4));

function invItemCard(r) {
  const [top, main] = invNames(r);
  const c = r.copies[0];
  const ch = invChange(r.price, r.avg30);
  const badge = /StatTrak/.test(r.quality || r.name) ? h('span', { class: 'inv-badge st' }, 'StatTrak™') : /Souvenir/.test(r.quality || r.name) ? h('span', { class: 'inv-badge sv' }, 'Souvenir') : null;
  return h('button', { class: 'inv-item', style: { '--rar': r.rarity?.color || 'var(--line-2)' }, onclick: () => invItemModal(r),
    title: [r.hash || r.name, r.collection, r.stickers.length ? r.stickers.join('\n') : null].filter(Boolean).join('\n') },
  h('div', { class: 'inv-art' }, invPic(r), r.count > 1 ? h('span', { class: 'inv-count' }, `×${r.count}`) : null, badge,
    r.tradable < r.count ? h('span', { class: 'inv-lock', title: `${r.count - r.tradable} not tradable yet (trade hold) or never tradable` }, icon('<rect x="5" y="11" width="14" height="9" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/>')) : null,
    r.applied.length ? h('span', { class: 'inv-stk', title: r.applied.map(invAppliedLine).join('\n') }, ...r.applied.map(x => invPic(r, 'stk', x.img))) : null),
  h('div', { class: 'inv-name' }, h('small', {}, top), h('b', { style: { color: r.nameColor && !/^#d2d2d2$/i.test(r.nameColor) ? r.nameColor : null } }, main)),
  h('div', { class: 'inv-meta' }, r.exterior || r.rarity?.name || r.type, c?.float != null ? h('span', { class: 'inv-float' }, fmtFloat(c.float)) : null),
  h('div', { class: 'inv-price' }, h('b', {}, invMoney(r.value == null ? null : r.value * r.count)),
    r.count > 1 && r.value != null ? h('small', {}, `${invMoney(r.value)} each`) : null,
    h('span', { class: 'spacer' }), invChangeEl(ch, `Item price now against its 30-day average (${invMoney(r.avg30)})`)),
  r.appliedValue >= 0.005 ? h('div', { class: 'inv-extra', title: r.applied.map(invAppliedLine).join('\n') },
    `incl. +${invMoney(r.appliedValue)} ${invAppliedWhat(r)}`) : null);
}
const invAppliedWhat = r => {
  const k = new Set(r.applied.map(x => x.kind));
  return k.has('Charm') && k.size > 1 ? 'stickers & charm' : k.has('Charm') ? 'charm' : k.has('Patch') ? 'patches' : 'stickers';
};
const invAppliedLine = x => `${x.name}: ${x.price == null ? 'no price' : invMoney(x.price)}${x.wear ? ` · scraped ${Math.round(x.wear * 100)}%` : ''}${x.price != null ? ` → +${invMoney(x.price * x.share)}` : ''}`;
function invAppliedRow(r, x) {
  return h('div', { class: 'inv-app', title: x.name },
    invPic(r, 'app', x.img),
    h('div', { class: 'inv-app-name' }, h('b', {}, x.name.replace(/^(Sticker|Charm|Patch) \| /, '')),
      h('small', {}, x.kind, x.wear ? ` · scraped ${Math.round(x.wear * 100)}%` : '', x.price != null ? ` · ${invMoney(x.price)} on the market` : ' · no price')),
    h('div', { class: 'inv-app-v' }, h('b', {}, x.price == null ? '—' : x.price * x.share > 0 && x.price * x.share < 0.005 ? `+ < ${invMoney(0.01)}` : `+${invMoney(x.price * x.share)}`),
      x.price != null ? h('small', {}, x.share === 1 ? 'full price' : `${Math.round(x.share * 100)}% counted`) : null));
}

function invItemModal(r) {
  const [top, main] = invNames(r);
  const kv = (k, v, title) => (v == null || v === '' ? null : h('div', { class: 'kv-row', title }, h('span', {}, k), h('b', {}, v)));
  modal([
    h('div', { class: 'inv-modal', style: { '--rar': r.rarity?.color || 'var(--line-2)' } },
      h('div', { class: 'inv-modal-art' }, invPic(r, 'large')),
      h('div', { class: 'inv-modal-body' },
        h('div', { class: 'hint' }, top),
        h('h2', {}, main),
        h('div', { class: 'inv-modal-tags' }, r.rarity ? h('span', { class: 'inv-rar' }, r.rarity.name) : null, r.exterior ? h('span', {}, r.exterior) : null, h('span', {}, r.type), r.collection ? h('span', {}, r.collection) : null),
        h('div', { class: 'kv' },
          kv(`${r.applied.length ? 'Item price' : 'Price'}${r.priceFrom === 'sales' ? ' · Steam sales' : r.priceFrom === 'list' ? ' · price list' : ''}`,
            r.price == null ? (r.marketable ? 'No price found' : 'Cannot be sold') : invMoney(r.price),
            r.priceFrom === 'sales' ? `Average Steam Market sale over the last day with sales (last sale ${fmtWhen(r.lastSale)}; sales read ${ago(r.salesAt)})`
              : r.priceFrom === 'list' ? `From the ${state.inv.data?.sources?.[state.inv.data.source] || ''} price list (only the most valuable items are priced from their own Steam sales)` : null),
          r.applied.length ? kv(`${invAppliedWhat(r)[0].toUpperCase()}${invAppliedWhat(r).slice(1)} (estimate)`, `+${invMoney(r.appliedValue)}`) : null,
          r.applied.length ? h('div', { class: 'kv-row inv-est' }, h('span', {}, 'Estimated value'), h('b', {}, invMoney(r.value))) : null,
          kv('7-day average', r.avg7 == null ? null : invMoney(r.avg7)),
          kv('30-day average', r.avg30 == null ? null : invMoney(r.avg30)),
          kv('You have', r.count > 1 ? `${r.count} · ${invMoney(r.value == null ? null : r.value * r.count)}` : null),
          kv('Tradable now', r.tradable < r.count ? `${r.tradable} of ${r.count}` : null, 'New items have a 7-day trade hold'),
          kv('Name tag', r.nameTag ? `“${r.nameTag}”` : null)),
        r.applied.length ? h('div', {},
          h('div', { class: 'sub-head', title: 'Charms come off and keep their full price; applied stickers only add a part of theirs (set at the top of the page), less when scraped.' },
            `On this item · +${invMoney(r.appliedValue)}`),
          h('div', { class: 'inv-apps' }, ...r.applied.map(x => invAppliedRow(r, x)))) : null,
        r.copies.some(c => c.float != null || c.pattern != null) ? h('div', {},
          h('div', { class: 'sub-head' }, r.copies.length > 1 ? `Your ${r.copies.length} copies` : 'This copy'),
          h('div', { class: 'inv-copies' }, ...r.copies.map(c => h('div', { class: 'inv-copy' },
            c.float != null ? h('span', {}, 'Float ', h('b', {}, fmtFloat(c.float))) : null,
            c.float != null ? h('span', { class: 'inv-wear' }, h('i', { style: { left: `${clamp(c.float, 0, 1) * 100}%` } })) : null,
            c.pattern != null ? h('span', {}, 'Pattern ', h('b', {}, c.pattern)) : null)))) : null)),
    r.marketable && r.hash ? invPriceGraph(r) : null,
    h('div', { class: 'actions' },
      r.marketable && r.hash ? h('button', { class: 'btn', onclick: () => api.openMarket(r.hash) }, 'Open on Steam Market') : null,
      h('button', { class: 'btn primary', onclick: () => closeModal() }, 'Close')),
  ]);
}
