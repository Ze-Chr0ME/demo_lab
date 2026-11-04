/* global $, api, state, h, icon, ICONS, toast, card, barList, select, toggle, modal, closeModal, spinner, avatar, steamAvatar, ago, fmtNum, clamp, showView, pickSvg, PICK_ICONS */
'use strict';
// The Inventory page: what a player's CS2 items are worth, item by item. lib/inventory.js reads the Steam
// inventory and a price list for every item; this page converts the dollars to your currency, adds them up,
// and shows the value over time (one point each time the inventory is read, at most one per hour).

state.inv = { who: null, data: null, error: null, loading: false, q: '', type: 'all', where: 'inv', sort: 'total', hideFree: false, currency: '',
  su: { busy: false, progress: null, error: null } };
const invImages = new Map(); // icon_url -> file
// The main process prices the most valuable items from their Steam sales in the background: show the
// progress, and read the inventory again (cached, no Steam request) every few items and at the end.
api.onInventorySales(v => {
  const st = state.inv;
  st.salesJob = v.running ? v : null;
  const mine = st.data && st.data.steamid === v.steamid;
  // Keep the loaded copy's progress current too, or coming back to the page shows the progress it was loaded with.
  if (mine && st.data.sales) st.data.sales.job = st.salesJob;
  if (mine && !v.running && state.view !== 'inventory') st.stale = true; // new prices: read them when the page is shown again
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
// Storage unit contents only come from CS2's Game Coordinator, so reading them needs a Steam client sign-in
// (lib/steamClient.js in the main process). Read when asked, never while CS2 runs: it would kick the game.
api.onStorageProgress(v => {
  state.inv.su.progress = v;
  const el = $('#invSuProgress');
  if (el) el.textContent = `Reading storage unit ${v.done} of ${v.total}…`;
});
api.onStorageGuard(v => invSignIn?.code(v));

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
    return new Intl.NumberFormat(UI_LOCALE, { style: 'currency', currency: cur, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(v);
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
  const who = st.who, request = st.request = (st.request || 0) + 1;
  st.loading = true;
  st.error = null;
  api.inventory(who, refresh)
    .then(d => { if (st.who !== who || st.request !== request) return; st.data = d; for (const [k, f] of Object.entries(d.images || {})) invImages.set(k, f); })
    .catch(e => { if (st.who === who && st.request === request) st.error = e.message; })
    .finally(() => { if (st.who !== who || st.request !== request) return; st.loading = false; if (state.view === 'inventory') renderInventory(); });
}

function openInventory(steamid, name) {
  selectPlayer(steamid);
  showView('inventory');
}

function renderInventory() {
  const view = $('#view-inventory');
  const st = state.inv, me = state.env?.mySteamId;
  if (st.who !== state.who) { st.who = state.who; st.data = null; st.error = null; st.loading = false; }
  st.whoName = state.other?.name || null;
  const page = (...body) => view.replaceChildren(h('div', { class: 'page dash-page inv-page' }, ...body));
  const back = playerMenu();
  if (!st.who && !me) return page(h('div', { class: 'empty' }, h('h2', {}, 'Which player are you?'), h('div', {}, 'No Steam account was found on this PC. Enter your SteamID64 in Settings → Counter-Strike 2.')));
  const d = st.data && (st.data.steamid === (st.who || me)) ? st.data : null;
  if ((!d || st.stale) && !st.loading && !st.error) { st.stale = false; loadInventory(); }
  if (!d) {
    return page(h('div', { class: 'page-head' }, h('h2', {}, 'Inventory'), back), st.error
      ? h('div', { class: 'empty' }, icon(ICONS.demo, 'class="big"'), h('h2', {}, 'Could not read the inventory'), h('div', { class: 'err-box' }, st.error),
        h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: () => loadInventory(true) }, 'Try again')))
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
      select(d.source, Object.entries(d.sources).map(([k, l]) => [k, l]), v => { setInv({ source: v }).then(() => loadInventory()); }, { seg: true, icon: () => pickSvg(PICK_ICONS.coin) }),
      select(cur, currencies.map(c => [c, c, () => { let symbol = c; try { symbol = new Intl.NumberFormat(UI_LOCALE, { style: 'currency', currency: c }).formatToParts(0).find(p => p.type === 'currency')?.value || c; } catch {} return h('span', { class: 'muted' }, symbol); }]), v => { setInv({ currency: v }).then(() => renderInventory()); }, { seg: false, search: true, noun: 'currencies', right: true }),
      invShareSelect(d, setInv)),
    h('button', { class: 'btn', disabled: st.loading, title: 'Read the inventory from Steam again', onclick: () => loadInventory(true) },
      icon('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2"/>'), 'Refresh'));

  const notes = d.notes.length ? h('div', { class: 'info-box' }, ...d.notes.map(n => h('div', {}, n))) : null;

  // ---- summary cards
  const unpriced = d.count - d.priced;
  const tradable = d.items.reduce((n, r) => n + r.tradable, 0);
  const tradableValue = d.items.reduce((n, r) => n + (r.value || 0) * r.tradable, 0);
  const stat = (label, value, detail, title) => h('div', { class: 'tile inv-stat', title },
    h('div', { class: 'tile-k' }, label), h('div', { class: 'tile-v' }, value), detail ? h('div', { class: 'tile-sub' }, detail) : null);
  const stats = [
    stat('Tradable now', invMoney(tradableValue), `${fmtNum(tradable)} of ${fmtNum(d.count)} items`, 'Items you can trade or sell right now (new items have a 7-day trade hold)'),
    stat('Items', [fmtNum(d.priced), h('small', {}, `of ${fmtNum(d.count)}`)], unpriced > 0 ? h('span', { title: 'Medals, coins, badges and other items that cannot be sold' }, `${fmtNum(unpriced)} without a price`) : null),
    stat('Average per priced item', invMoney(d.priced ? d.total / d.priced : 0)),
    d.applied > 0.005 ? stat('Stickers & charms on items', `+${invMoney(d.applied)}`, 'Included in inventory value', `Included in the value: charms at their full price (they come off), applied stickers at ${Math.round(d.stickerShare * 100)}% of theirs, less when scraped`) : null,
    d.storage?.count ? stat('In storage units', invMoney(d.storage.value), `${fmtNum(d.storage.count)} items in ${d.storage.units.length} unit${d.storage.units.length === 1 ? '' : 's'}`, 'Included in the inventory value') : null,
    d.sales?.items ? stat('Priced from Steam sales', invMoney(d.sales.value), `${fmtNum(d.sales.items)} items`, 'These items are priced from their own Steam Market sales over the last day (the last week for rarely sold items). The rest use the price list.') : null,
  ].filter(Boolean);
  const summary = h('div', { class: 'inv-summary', style: { '--inv-stats': stats.length } },
    h('div', { class: 'tile inv-stat inv-hero' }, h('div', { class: 'tile-k' }, 'Inventory value'),
      h('div', { class: 'tile-row' }, h('div', { class: 'tile-v inv-total' }, invMoney(d.total)),
        d.trend30 ? invChangeEl(invChange(d.trend30.now, d.trend30.then), `Against the same items at their 30-day average price (${invMoney(d.trend30.then)})`) : null),
      h('div', { class: 'tile-sub' }, 'Total estimated value')), ...stats);

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
  })), { empty: 'No priced items' }), { span: 2, cls: 'inv-types' });

  const units = isMe && d.storage ? invStorageCard(d) : null;
  page(head, notes, summary,
    units ? null : h('div', { class: 'hint inv-storage' }, isMe ? 'Storage unit contents are not part of the Steam inventory and are not counted.' : 'Storage unit contents are only visible to their owner and are not counted.'),
    h('div', { class: 'dash inv-dash' }, invHistoryCard(d), typeCard, units),
    invItemsSection(d));
}

// A line of dollar values over time (pts: [{ t, usd, n? }]) with a crosshair and a tooltip on the nearest
// point. volume: a strip of bars under the line for the sale counts (n), on its own baseline.
function invChart(pts, { W = 800, H = 150, volume = false, tip }) {
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
  const fmtDay = t => new Date(t).toLocaleDateString(UI_LOCALE, long ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
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
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="trend-svg"><defs><linearGradient id="tFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="t-stop-a"/><stop offset="1" class="t-stop-b"/></linearGradient></defs>${grid.join('')}${axis}${bars}
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
const fmtWhen = (t, hours = true) => new Date(t).toLocaleString(UI_LOCALE, { day: 'numeric', month: 'short', year: 'numeric', ...(hours ? { hour: '2-digit', minute: '2-digit' } : {}) });

// Applied stickers sell for a part of their own price (and nothing once scraped off); how big a part is a
// guess, so it's a setting. Charms always count in full: they can be taken off and sold.
const INV_SHARES = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 1];
function invShareSelect(d, setInv) {
  const cur = d.stickerShare ?? 0.1;
  const opts = [...new Set([...INV_SHARES, cur])].sort((a, b) => a - b);
  const el = select(String(cur), opts.map(v => [String(v), v ? `Stickers at ${Math.round(v * 100)}%` : 'Stickers not counted']), v => { setInv({ stickerShare: +v }).then(() => loadInventory()); }, { seg: false, icon: () => pickSvg(PICK_ICONS.sticker) });
  el.title = 'How much of an applied sticker’s price is added to the item’s value (an estimate: applied stickers resell for a fraction of their price, scraped ones for less). Charms always count in full.';
  return el;
}

// The inventory's value each time it was read (in today's currency rate, with that day's prices).
function invHistoryCard(d) {
  const pts = d.history.filter(p => p.usd > 0);
  if (pts.length < 2) {
    return card('Value over time', h('div', { class: 'muted-note inv-history-empty' }, 'A point is added each time DemoLab reads this inventory (at most one an hour). Come back in a while to see the curve.'), { span: 2, cls: 'inv-history' });
  }
  const el = invChart(pts, { W: 600, H: 150, tip: (p, prev) => [h('b', {}, invMoney(p.usd)), h('div', {}, fmtWhen(p.t)),
    h('div', { class: 'hint' }, `${fmtNum(p.n)} items`, prev ? [' · ', invChangeEl(invChange(p.usd, prev.usd), 'Since the point before')] : null)] });
  const first = pts[0];
  return card('Value over time', el, { span: 2, cls: 'inv-history', extra: h('span', { class: 'hint' }, `${pts.length} points since ${new Date(first.t).toLocaleDateString(UI_LOCALE)} · `, invChangeEl(invChange(pts[pts.length - 1].usd, first.usd), 'Since the first point')) });
}

// ---- Storage units (your own inventory only)
const INV_BOX = '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 7.5 12 12l9-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';
function invStorageCard(d) {
  const s = d.storage, su = state.inv.su;
  const signOut = h('button', { class: 'btn ghost', disabled: su.busy, title: 'Forget the Steam sign-in DemoLab keeps for storage units', onclick: invSignOut }, 'Sign out');
  const read = label => h('button', { class: 'btn primary', disabled: su.busy, onclick: invReadStorage }, icon(INV_BOX), label);
  const busy = su.busy ? h('div', { class: 'inv-su-busy' }, spinner(12), h('span', { id: 'invSuProgress' },
    su.progress ? `Reading storage unit ${su.progress.done} of ${su.progress.total}…` : 'Signing in to CS2…'),
    h('button', { class: 'btn ghost', onclick: () => api.storageCancel().catch(() => {}) }, 'Stop')) : null;
  const err = su.error ? h('div', { class: 'err-box' }, su.error) : null;
  const what = [h('b', {}, 'Optional.'), ' Everything else on this page works without it: only storage unit contents need it. Steam shows what is inside storage units to CS2 alone, so signing in here is the only way to read them. DemoLab then reads them like a second PC, only when you ask. Close CS2 first: reading them would kick your game.'];
  let body, extra;
  if (!s.signedIn) {
    extra = null;
    body = h('div', { class: 'inv-su-empty' }, icon(INV_BOX, 'class="big"'),
      h('div', {}, h('b', {}, 'Count your storage units too (optional)'), h('p', { class: 'hint' }, what)),
      h('button', { class: 'btn primary', onclick: () => invSignInDialog() }, 'Sign in to Steam'));
  } else if (!s.mine) {
    extra = signOut;
    body = h('div', { class: 'inv-su-empty' }, icon(INV_BOX, 'class="big"'),
      h('div', {}, h('b', {}, `Signed in as ${s.account || 'another account'}`), h('p', { class: 'hint' }, 'That Steam account is not the one this inventory belongs to. Sign out and sign in with this one to count its storage units.')));
  } else if (!s.t) {
    extra = signOut;
    body = h('div', { class: 'inv-su-empty' }, icon(INV_BOX, 'class="big"'),
      h('div', {}, h('b', {}, `Signed in as ${s.account}`), h('p', { class: 'hint' }, 'Close CS2, then read your storage units. Their contents are added to the inventory value.')),
      su.busy ? null : read('Read storage units'));
  } else {
    extra = [h('span', { class: 'hint' }, `${s.account} · read ${ago(s.t)}`), su.busy ? null : read('Read again'), signOut];
    const max = Math.max(1e-9, ...s.units.map(u => u.value || 0));
    body = s.units.length ? barList(s.units.map(u => ({
      label: u.name, note: `${fmtNum(u.count)} item${u.count === 1 ? '' : 's'}${u.priced < u.count ? ` · ${fmtNum(u.count - u.priced)} without a price` : ''}`,
      value: invMoney(u.value, { cents: false }), frac: (u.value || 0) / max,
      title: `Open “${u.name}”`, onclick: () => invOpenUnit(u.id),
    }))) : h('div', { class: 'muted-note' }, 'You have no storage units.');
  }
  return card('Storage units', [busy, err, body], { span: 4, cls: 'inv-units', extra });
}

async function invReadStorage() {
  const su = state.inv.su;
  if (su.busy) return;
  Object.assign(su, { busy: true, progress: null, error: null });
  renderInventory();
  try {
    const r = await api.storageRead();
    toast(`Read ${r.units.length} storage unit${r.units.length === 1 ? '' : 's'}`);
  } catch (e) { su.error = e.message === 'Cancelled' ? null : e.message; }
  su.busy = false;
  if (state.view === 'inventory') loadInventory(); // the main process signed in or out: show it either way
}

async function invSignOut() {
  try { await api.storageLogout(); } catch (e) { toast(e.message, 'error'); }
  state.inv.su.error = null;
  loadInventory();
}

// The sign-in dialog: account name and password, then a Steam Guard step when Steam asks for one (the main
// process sends storage:guard and waits for the code; a phone approval finishes the sign-in on its own).
let invSignIn = null;
function invSignInDialog() {
  const body = h('div', { class: 'inv-signin' });
  const err = h('div', { class: 'err-box hidden' });
  const showErr = m => { err.textContent = m || ''; err.classList.toggle('hidden', !m); };
  const user = h('input', { type: 'text', autocomplete: 'username', spellcheck: 'false', placeholder: 'Steam account name (not your profile name)' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const waiting = text => body.replaceChildren(h('div', { class: 'inv-signin-wait' }, spinner(18), h('span', {}, text)),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => cancel() }, 'Cancel')));
  const credentials = () => {
    body.replaceChildren(h('form', { class: 'inv-signin-form', onsubmit: e => { e.preventDefault(); submit(); } },
      h('label', {}, 'Account name', user), h('label', {}, 'Password', pass),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => cancel() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'))));
    (user.value ? pass : user).focus();
  };
  const me = {
    code(v) {
      if (invSignIn !== me) return;
      showErr(v.wrong ? 'That code was not right. Try again with a new one.' : '');
      const input = h('input', { type: 'text', class: 'inv-code', maxlength: 5, autocomplete: 'one-time-code', spellcheck: 'false', placeholder: 'XXXXX',
        oninput: e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); } });
      body.replaceChildren(h('form', { class: 'inv-signin-form', onsubmit: e => {
        e.preventDefault();
        if (input.value.length < 5) return;
        api.storageGuard(input.value).catch(x => showErr(x.message));
        waiting('Checking the code…');
      } },
      h('p', {}, v.kind === 'email' ? `Steam sent a code to your email${v.domain ? ` at ${v.domain}` : ''}.` : 'Enter the code from the Steam Mobile app, or approve the sign-in in the app.'),
      h('label', {}, 'Steam Guard code', input),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => cancel() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Continue'))));
      input.focus();
    },
  };
  const close = () => { invSignIn = null; closeModal(); };
  const cancel = () => { if (busy) api.storageCancel().catch(() => {}); close(); };
  let busy = false;
  async function submit() {
    if (!user.value.trim() || !pass.value) return showErr('Enter your account name and password.');
    showErr('');
    waiting('Signing in to Steam…');
    busy = true;
    try {
      const r = await api.storageLogin(user.value.trim(), pass.value).finally(() => { busy = false; });
      pass.value = '';
      if (invSignIn === me) close();
      toast(`Signed in to Steam as ${r.account}`);
      if (state.view === 'inventory') invReadStorage();
    } catch (e) {
      if (invSignIn !== me) return e.message === 'Cancelled' ? null : toast(e.message, 'error');
      credentials();
      showErr(e.message);
    }
  }
  invSignIn = me;
  modal([
    h('h2', {}, 'Sign in to Steam'),
    h('p', {}, 'Steam shows what is inside storage units to CS2 alone, so this sign-in is the only way to count them. DemoLab reads them like a second PC would.'),
    h('div', { class: 'info-box inv-signin-optional' }, h('b', {}, 'This is optional.'), ' Your inventory, its value and everything else on the Inventory page work without signing in. Only the contents of your storage units need it.'),
    h('ul', { class: 'inv-signin-notes' },
      h('li', {}, 'Your password goes to Steam only and is never saved. DemoLab keeps a sign-in token, encrypted by Windows, until you sign out.'),
      h('li', {}, 'Storage units are only read when you ask, and never while CS2 is running (it would kick your game).')),
    err, body,
  ], { onClose: false });
  credentials();
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
        invChart(pts, { W: 800, H: 180, volume: true, tip: p => [h('b', {}, invMoney(p.usd)), h('div', {}, fmtWhen(p.t, !daily)),
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
  // Stored items stay inside their storage unit: the inventory shows one card per unit (its value and name),
  // and opening a unit lists what is inside. A search also finds stored items, tagged with their unit.
  const units = d.storage?.units?.length && d.items.some(r => r.storage) ? d.storage.units : [];
  const unit = units.find(u => `su:${u.id}` === st.where) || null;
  if (!unit) st.where = 'inv';
  // The storage unit items themselves are replaced by the unit cards (their picture is reused there).
  const isUnitItem = r => !r.storage && units.length && /^Storage Unit$/i.test(r.hash || r.name);
  const base = d.items.filter(r => (unit ? r.storage?.id === unit.id : !r.storage && !isUnitItem(r)));
  const types = [...new Set(base.map(r => r.type))].sort((a, b) => invTypeRank(a) - invTypeRank(b) || a.localeCompare(b));
  if (st.type !== 'all' && !types.includes(st.type)) st.type = 'all';
  const pool = !unit && q ? [...base, ...d.items.filter(r => r.storage)] : base;
  let list = pool.filter(r => (st.type === 'all' || r.type === st.type) && (!st.hideFree || r.value != null)
    && (!q || `${r.hash || r.name} ${r.type} ${r.collection || ''} ${r.nameTag || ''} ${r.stickers.join(' ')} ${r.storage?.name || ''}`.toLowerCase().includes(q)));
  const unitCards = !unit && !q && st.type === 'all' ? [...units].sort((a, b) => (b.value || 0) - (a.value || 0)) : [];
  const unitPic = d.items.find(isUnitItem)?.icon || null;
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
  const shownValue = list.reduce((n, r) => n + (r.value || 0) * r.count, 0) + unitCards.reduce((n, u) => n + (u.value || 0), 0);
  const shownCount = list.reduce((n, r) => n + r.count, 0) + unitCards.reduce((n, u) => n + u.count, 0);

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
    types.length > 1 ? select(st.type, [['all', 'All types'], ...types.map(t => [t, t])], v => { st.type = v; renderInventory(); }, { seg: false, icon: () => pickSvg(PICK_ICONS.layers) }) : null,
    select(st.sort, INV_SORTS, v => { st.sort = v; renderInventory(); }, { seg: false, label: 'Sort', icon: () => pickSvg(PICK_ICONS.sort) }),
    toggle('Only priced items', st.hideFree, v => { st.hideFree = v; renderInventory(); }, 'Hide medals, coins and other items that have no market price'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'hint' }, `${fmtNum(shownCount)} item${shownCount === 1 ? '' : 's'} · ${invMoney(shownValue)}`));

  const head = unit
    ? h('div', { class: 'sec inv-crumbs' },
      h('button', { class: 'btn ghost', title: 'Back to the inventory', onclick: () => invOpenUnit(null) },
        icon('<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2"/>'), 'Items'),
      h('span', { class: 'inv-crumb-unit' }, icon(INV_BOX), h('b', {}, unit.name)),
      h('span', { class: 'hint' }, `${fmtNum(unit.count)} item${unit.count === 1 ? '' : 's'} · ${invMoney(unit.value)}`))
    : h('div', { class: 'sec' }, h('h3', {}, 'Items'));
  const empty = unit && !base.length ? ['This storage unit is empty', ''] : ['No items match', 'Try another search or type.'];
  return h('section', { class: 'ov-sec', id: 'invItems' }, head, filters,
    list.length || unitCards.length ? h('div', { class: 'inv-grid' }, ...unitCards.map(u => invUnitCard(u, unitPic)), ...list.map(invItemCard))
      : h('div', { class: 'empty' }, h('h2', {}, empty[0]), empty[1] ? h('div', {}, empty[1]) : null));
}

// Open a storage unit's contents in the item grid (null: back to the inventory), keeping the grid in view.
function invOpenUnit(id) {
  Object.assign(state.inv, { where: id == null ? 'inv' : `su:${id}`, q: '', type: 'all' });
  renderInventory();
  $('#invItems')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function invUnitCard(u, pic) {
  const unpriced = u.count - (u.priced ?? u.count);
  return h('button', { class: 'inv-item inv-unit', style: { '--rar': 'var(--accent)' }, onclick: () => invOpenUnit(u.id), title: `Open “${u.name}” to see what is inside` },
    h('div', { class: 'inv-art' }, pic ? invPic({ icon: pic }) : icon(INV_BOX, 'class="inv-unit-ic"'),
      h('span', { class: 'inv-count' }, fmtNum(u.count))),
    h('div', { class: 'inv-name' }, h('small', {}, 'Storage unit'), h('b', {}, u.name)),
    h('div', { class: 'inv-meta' }, `${fmtNum(u.count)} item${u.count === 1 ? '' : 's'}`, unpriced > 0 ? h('span', { class: 'inv-float' }, `${fmtNum(unpriced)} without a price`) : null),
    h('div', { class: 'inv-price' }, h('div', { class: 'inv-price-value' }, h('b', {}, invMoney(u.value)))),
    h('div', { class: 'inv-extra inv-unit-open' }, 'Open ›'));
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
    r.storage && state.inv.where === 'inv' ? h('span', { class: 'inv-su', title: `In storage unit “${r.storage.name}”` }, icon(INV_BOX), h('span', {}, r.storage.name)) : null,
    !r.storage && r.tradable < r.count ? h('span', { class: 'inv-lock', title: `${r.count - r.tradable} not tradable yet (trade hold) or never tradable` }, icon('<rect x="5" y="11" width="14" height="9" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/>')) : null,
    r.applied.length ? h('span', { class: 'inv-stk', title: r.applied.map(invAppliedLine).join('\n') }, ...r.applied.map(x => invPic(r, 'stk', x.img))) : null),
  h('div', { class: 'inv-name' }, h('small', {}, top), h('b', { style: { color: r.nameColor && !/^#d2d2d2$/i.test(r.nameColor) ? r.nameColor : null } }, main)),
  h('div', { class: 'inv-meta' }, r.exterior || r.rarity?.name || r.type, c?.float != null ? h('span', { class: 'inv-float' }, fmtFloat(c.float)) : null),
  h('div', { class: 'inv-price' }, invChangeEl(ch, `Item price now against its 30-day average (${invMoney(r.avg30)})`),
    h('div', { class: 'inv-price-value' }, h('b', {}, invMoney(r.value == null ? null : r.value * r.count)),
      r.count > 1 && r.value != null ? h('small', {}, `${invMoney(r.value)} each`) : null)),
  h('div', { class: 'inv-extra', title: r.appliedValue >= 0.005 ? r.applied.map(invAppliedLine).join('\n') : null },
    r.appliedValue >= 0.005 ? `incl. +${invMoney(r.appliedValue)} ${invAppliedWhat(r)}` : null));
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
          kv('Stored in', r.storage ? `“${r.storage.name}”` : null, 'Take it out of the storage unit in CS2 to trade or sell it'),
          kv('Tradable now', !r.storage && r.tradable < r.count ? `${r.tradable} of ${r.count}` : null, 'New items have a 7-day trade hold'),
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
