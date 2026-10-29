/* global weaponIcon, guard, modal, closeModal, copyText, $, api, state, h, icon, ICONS, toast, card, select, toggle, spinner, ago, trOpts, mapName, mapColor, mapShotUrl, artImg, mapEmblem, renderTraining, liveBar, running, trGuard, sessionList, GUNS, LEVELS, radarInfo, radarMaps, radarFrame, radarImage, toPx, viewPt, viewScale, applyView, zoomable, newView, resetZoom, RADAR_SIZE */
'use strict';
// "My scenarios" (a Training card): the player records a scenario in CS2 (or places it on the 2D map):
// where they start and which way they face, bots on spots holding the angles they're given. The list
// is grouped by map; a scenario is played in CS2 (lib/training.js). Heights come from the map mesh / the user's demos (scenario:floor in main.js).

state.sc = { items: null, meshes: [], loading: false, edit: null, tool: 'bot', sel: null, view: newView(), floor: 'upper', newMap: 'de_mirage', map: null };

const SC_TOOLS = [['move', 'Move'], ['me', 'Your start'], ['bot', 'Bot']];
const SC_HINT = {
  move: 'Drag a spot to move it, drag the end of a bot\'s line to turn it. Drag the map to pan when zoomed in.',
  me: 'Click where you start, drag to set which way you face.',
  bot: 'Click where the bot stands and drag towards the spot it holds (where you will come from).',
};
// A bot's own gun ('' = the session's "Bots" gun) and how far it jiggles (lib/scenarios.js JIGGLE).
const BOT_GUNS = [['', 'Session gun'], ['ak47', 'AK-47'], ['m4a1', 'M4A4'], ['m4a1_silencer', 'M4A1-S'], ['galilar', 'Galil AR'], ['famas', 'FAMAS'], ['sg556', 'SG 553'], ['aug', 'AUG'],
  ['awp', 'AWP'], ['ssg08', 'SSG 08'], ['mp9', 'MP9'], ['mac10', 'MAC-10'], ['mp7', 'MP7'], ['ump45', 'UMP-45'], ['p90', 'P90'], ['nova', 'Nova'], ['xm1014', 'XM1014'],
  ['deagle', 'Desert Eagle'], ['usp_silencer', 'USP-S'], ['glock', 'Glock-18'], ['p250', 'P250'], ['tec9', 'Tec-9'], ['fiveseven', 'Five-SeveN'], ['cz75a', 'CZ75-Auto']];
const JIGGLES = [[false, 'Still'], [true, 'Jiggle']];
// how far it jiggles in world units (older scenarios saved 1 / 2)
const jiggleW = j => (j === 1 ? 48 : j === 2 ? 96 : +j || 0);
const SC_MAX_BOTS = 10;
const scFloors = new WeakMap(); // item -> floor heights found under it (to switch floors)

function loadScenarios(force = false) {
  const sc = state.sc;
  if ((sc.items && !force) || sc.loading) return;
  sc.loading = true;
  api.scenarios().then(r => { sc.items = r.items; sc.meshes = r.meshes; })
    .catch(e => toast(e.message, 'error'))
    .finally(() => { sc.loading = false; if (state.view === 'training' && state.tr.drill === 'scenario') renderTraining(); });
}

function scenarioPage() {
  const sc = state.sc;
  if (!sc.items) { loadScenarios(); return h('div', { class: 'empty' }, spinner(28)); }
  return sc.edit ? scenarioEditor() : scenarioList();
}

const radarMapList = () => Object.keys(radarMaps || {}).filter(m => /^de_/.test(m) && !/_(night|v\d+)$/.test(m)).sort();

function playMix(m) {
  return trGuard(async () => {
    await api.trainingStart({ drill: 'scenario', mixMap: m.map, reps: m.reps, firstTo: m.firstTo, ...trOpts() });
    state.tr.status = { drill: 'scenario', map: m.map, phase: 'starting' };
    state.sc.edit = null;
    renderTraining();
  });
}

function playScenario(s) {
  return trGuard(async () => {
    await api.trainingStart({ drill: 'scenario', scenarioId: s.id, ...trOpts() });
    state.tr.status = { drill: 'scenario', map: s.map, phase: 'starting' };
    state.sc.edit = null;
    renderTraining();
  });
}

// A labelled range input with its value shown next to it.
function slider(label, value, min, max, step, show, on, title) {
  const out = h('span', { class: 'sc-slider-v' }, show(+value));
  return h('div', { class: 'tr-row', title: title || '' }, h('span', { class: 'tr-label' }, label),
    h('input', { type: 'range', class: 'sc-slider', min, max, step, value, oninput: e => { out.textContent = show(+e.target.value); on(+e.target.value); } }), out);
}

// ---------- the list: one map at a time, like Utility: play and rating on the left, the scenarios beside ----------
// Icons only this page uses (24x24 like ICONS in app.js).
const SC_ICONS = {
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  share: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function scenarioList() {
  const sc = state.sc, tr = state.tr;
  radarInfo(sc.newMap); // loads the radar list
  const hist = (tr.info?.history || []).filter(e => e.drill === 'scenario');
  const byMap = {};
  for (const s of sc.items) (byMap[s.map] ||= []).push(s);
  if (!byMap[sc.map]) sc.map = [...sc.items].sort((a, b) => b.updated - a.updated)[0]?.map || null;
  const map = sc.map, list = byMap[map] || [];
  const maps = Object.keys(byMap).sort((a, b) => mapName(a).localeCompare(mapName(b)));
  const head = h('div', { class: 'page-head ut-head' },
    h('button', { class: 'link-btn', onclick: () => { tr.drill = null; renderTraining(); } }, '← Training'),
    map ? h('h2', { class: 'ut-title' }, mapEmblem(map, 'ut-title-emblem'), mapName(map), h('span', { class: 'ut-title-k' }, 'scenarios')) : h('h2', {}, 'My scenarios'),
    maps.length > 1 ? h('div', { class: 'chips ut-maps' }, ...maps.map(m => h('button', { class: `chip-toggle ${m === map ? 'on' : ''}`, style: { '--c': mapColor(m) }, onclick: () => { sc.map = m; renderTraining(); } },
      mapEmblem(m, 'ut-chip-emblem'), `${mapName(m)} (${byMap[m].length})`))) : null,
    h('span', { class: 'spacer' }),
    h('div', { class: 'ut-toolbar', role: 'group', 'aria-label': 'Scenario actions' },
      h('button', { class: 'btn', title: 'Add scenarios from a code a friend shared (DLS2-…)', onclick: () => scenarioImportDialog() }, icon(SC_ICONS.folder), 'Import'),
      list.length ? h('button', { class: 'btn', title: `Copy the ${plural(list.length, 'scenario')} of ${mapName(map)} as one code`, onclick: () => shareScenarios(list) }, icon(SC_ICONS.share), 'Share') : null),
    h('button', { class: 'btn primary', onclick: () => newScenarioDialog(map || sc.newMap) }, icon(SC_ICONS.plus), 'New scenario'));
  const rec = tr.status?.drill === 'record';
  const live = rec && running() ? recorderCard() : running() || ['done', 'error'].includes(tr.status?.phase) ? liveBar() : null;
  if (!sc.items.length) return [head, live, scEmpty()];
  const mapHist = hist.filter(e => e.map === map);
  return [head, live, h('div', { class: 'sc-layout' },
    h('aside', { class: 'sc-left' }, scPlayPanel(map, list), scRating(map, mapHist)),
    h('div', { class: 'sc-cards' }, ...[...list].sort((a, b) => b.updated - a.updated).map(s => scCard(s, hist))))];
}

const newScenario = map => {
  const sc = state.sc;
  sc.edit = { map, name: '', me: null, bots: [], options: { reps: 10, seconds: 25, firstTo: 0 } };
  sc.sel = null; sc.tool = 'me'; sc.floor = 'upper'; resetZoom(sc.view);
  renderTraining();
};
const recordOn = map => trGuard(() => api.scenarioRecord(map));

// Which map, then how: recorded in CS2 (the main way) or placed on the radar.
function newScenarioDialog(map) {
  const sc = state.sc, maps = radarMapList();
  if (map) sc.newMap = map;
  const way = (cls, title, about, go, disabled) => h('button', { class: `sc-way ${cls}`, disabled, onclick: () => { closeModal(); go(sc.newMap); } },
    h('b', {}, title), h('span', {}, about));
  modal([
    h('h2', {}, 'New scenario'),
    maps.length ? h('div', { class: 'sc-new-maps' }, ...maps.map(m => h('button', { class: `sc-new-map ${m === sc.newMap ? 'on' : ''}`, style: { '--c': mapColor(m) },
      onclick: e => { sc.newMap = m; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget); } },
      mapEmblem(m, 'sc-new-emblem'), mapName(m)))) : spinner(12),
    h('div', { class: 'sc-ways' },
      way('main', 'Record in CS2', 'Opens the map. Stand where a bot holds and aim where it looks: F5. Your start: F6. Done: F3.', recordOn, running()),
      way('', 'Place on the 2D map', 'Click the bots and your start on the radar instead.', newScenario)),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'))]);
}

// No scenario yet: how one is made.
function scEmpty() {
  const steps = [['Record in CS2', 'Stand where a bot should hold and aim where it should look: F5. Your start spot: F6. Finish with F3.'],
    ['Fine-tune', 'On the 2D map: jiggle, guns, who shoots back, the timer and how a game is won.'],
    ['Play it', 'Rep after rep: the round is yours when every bot is dead. Your score comes from the demo.']];
  return h('div', { class: 'sc-empty' },
    h('h3', {}, 'Build your first scenario'),
    h('p', {}, 'Bots holding the angles you choose, cleared rep after rep in CS2.'),
    h('div', { class: 'sc-steps' }, ...steps.map(([t, s], i) => h('div', { class: 'sc-step' }, h('span', { class: 'sc-step-n' }, i + 1), h('div', {}, h('b', {}, t), h('p', {}, s))))),
    h('div', {}, h('button', { class: 'btn primary', onclick: () => newScenarioDialog(state.sc.newMap) }, icon(SC_ICONS.plus), 'New scenario')));
}

// What you play on this map: the mix of all its scenarios (or its only one), and the loadout it starts with.
function scPlayPanel(map, list) {
  const sc = state.sc, mix = sc.mix || (sc.mix = { firstTo: 5, reps: 10 });
  const one = list.length === 1 ? list[0] : null;
  return h('section', { class: 'sc-panel sc-play', style: { '--c': mapColor(map) } },
    h('span', { class: 'sc-k' }, one ? 'Play' : 'Map mix'),
    h('h3', {}, one ? one.name || 'Untitled' : `All ${list.length} ${mapName(map)} scenarios`),
    h('p', {}, one ? `${plural(one.bots.length, 'bot')} · ${one.options.firstTo ? `first to ${one.options.firstTo}` : plural(one.options.reps, 'rep')} · ${one.options.seconds} s rounds`
      : 'A random one every rep, each with its own timer.'),
    one ? null : h('div', { class: 'sc-play-opts' },
      select(String(mix.firstTo), [['0', 'Play every rep'], ...[3, 5, 7, 10, 13, 16].map(n => [String(n), `First team to ${n}`])], v => { mix.firstTo = +v; renderTraining(); }),
      mix.firstTo ? null : select(String(mix.reps), [5, 10, 15, 20, 30].map(n => [String(n), `${n} reps`]), v => { mix.reps = +v; })),
    h('button', { class: 'btn primary sc-play-btn', disabled: running(),
      onclick: () => (one ? buyMenu(one.name || 'Untitled', () => playScenario(one)) : buyMenu(`${mapName(map)} mix`, () => playMix({ ...mix, map }))) },
      icon(ICONS.play), one ? 'Play' : 'Play mix'),
    h('div', { class: 'sc-loadout' }, h('span', {}, 'Loadout'), h('b', {}, loadoutText())));
}

// How the sessions on this map went: the recent average out of 100, its trend, and the sessions themselves.
function scRating(map, hist) {
  const scores = hist.map(e => e.score).filter(v => v != null);
  const avg = l => Math.round(l.reduce((a, b) => a + b, 0) / l.length);
  const recent = scores.slice(-10), before = scores.slice(-20, -10);
  const trend = recent.length && before.length ? avg(recent) - avg(before) : null;
  const tone = v => (v >= 70 ? 'good' : v >= 40 ? 'mid' : 'low');
  return h('section', { class: 'sc-panel sc-rating' },
    h('span', { class: 'sc-k' }, 'Session rating'),
    scores.length ? h('div', { class: 'sc-rating-top' },
      h('div', { class: `sc-rating-big ${tone(avg(recent))}` }, avg(recent), h('small', {}, '/100')),
      h('div', { class: 'sc-rating-facts' },
        trend != null ? h('span', { class: trend >= 0 ? 'up' : 'down' }, `${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)} on the 10 before`) : null,
        h('span', {}, `Best ${Math.max(...scores)} · last ${scores.at(-1)}`),
        h('span', {}, `${plural(hist.length, 'session')} on ${mapName(map)}`)),
      h('div', { class: 'sc-bars', title: 'Your last sessions, oldest first' }, ...scores.slice(-16).map(v =>
        h('span', { class: tone(v), style: { height: `${Math.max(6, Math.min(100, v))}%` }, title: String(v) }))))
      : h('p', { class: 'sc-rating-none' }, `No session on ${mapName(map)} yet. Play one to get a rating.`),
    hist.length ? h('div', { class: 'sc-rating-list' }, sessionList([...hist].reverse())) : null);
}

// A scenario: where its bots and you stand, what it is, how it went.
function scCard(s, hist) {
  const mine = hist.filter(e => e.scenario?.id === s.id), last = mine.at(-1);
  const jig = s.bots.filter(b => b.jiggle).length, still = s.bots.filter(b => !b.shoot).length;
  const stat = (n, w, cls = '') => h('span', { class: `sc-stat ${cls}` }, h('b', {}, n), w);
  return h('article', { class: 'sc-card' },
    h('button', { class: 'sc-prev-wrap', title: 'Edit on the 2D map', onclick: () => editScenario(s) }, scPreview(s),
      last ? h('span', { class: 'sc-card-score', title: 'Last score' }, last.score ?? '—') : null),
    h('div', { class: 'sc-card-body' },
      h('b', { class: 'sc-card-name', title: s.name || 'Untitled' }, s.name || 'Untitled'),
      h('div', { class: 'sc-stats' },
        stat(s.bots.length, s.bots.length === 1 ? 'bot' : 'bots', 'bots'),
        jig ? stat(jig, 'jiggling') : null, still ? stat(still, 'not shooting') : null,
        s.options.firstTo ? stat(s.options.firstTo, 'to win') : stat(s.options.reps, 'reps'), stat(s.options.seconds, 's')),
      h('small', { class: 'sc-card-meta' }, last ? `${plural(mine.length, 'session')} · ${ago(last.date)}` : 'Not played yet'),
      h('div', { class: 'sc-card-foot' },
        h('button', { class: 'btn primary', disabled: running(), onclick: () => buyMenu(s.name || 'Untitled', () => playScenario(s)) }, icon(ICONS.play), 'Play'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost sc-icon-btn', title: 'Edit', onclick: () => editScenario(s) }, icon(SC_ICONS.edit)),
        h('button', { class: 'btn ghost sc-icon-btn', title: 'Share', onclick: () => shareScenarios([s]) }, icon(SC_ICONS.share)),
        h('button', { class: 'btn ghost sc-icon-btn danger', title: 'Delete', onclick: async () => {
          if (!confirm(`Delete "${s.name}"?`)) return;
          await trGuard(() => api.scenarioDelete(s.id));
          loadScenarios(true);
        } }, icon(ICONS.trash)))));
}

// ---------- the buy menu: the loadout a session starts with (lib/training.js WEAPONS / GRENADES) ----------
// Every weapon has its own tile; each category scrolls independently. No smokes in scenarios.
const BUY_COLS = [
  ["Equipment", "armor", [
    ["kevlar","Kevlar Vest",650],
    ["assaultsuit","Kevlar & Helmet",1000],
    ["taser","Zeus x27",200],
    ["defuser","Defuse Kit",400,"No bomb in scenarios"],
    ["knife","Knife",0]
  ]],
  ["Pistols", "pistol", [
    ["usp_silencer","USP-S",200],
    ["hkp2000","P2000",200],
    ["glock","Glock-18",200],
    ["elite","Dual Berettas",300],
    ["p250","P250",300],
    ["fiveseven","Five-SeveN",500],
    ["tec9","Tec-9",500],
    ["cz75a","CZ75-Auto",500],
    ["deagle","Desert Eagle",700],
    ["revolver","R8 Revolver",600]
  ]],
  ["Mid-Tier", "weapon", [
    ["nova","Nova",1050],
    ["mag7","MAG-7",1300],
    ["sawedoff","Sawed-Off",1100],
    ["xm1014","XM1014",2000],
    ["mp9","MP9",1250],
    ["mac10","MAC-10",1050],
    ["bizon","PP-Bizon",1400],
    ["mp5sd","MP5-SD",1500],
    ["mp7","MP7",1500],
    ["ump45","UMP-45",1200],
    ["p90","P90",2350],
    ["negev","Negev",1700],
    ["m249","M249",5200]
  ]],
  ["Rifles", "weapon", [
    ["famas","FAMAS",1950],
    ["galilar","Galil AR",1800],
    ["m4a1_silencer","M4A1-S",2900],
    ["m4a1","M4A4",3100],
    ["ak47","AK-47",2700],
    ["ssg08","SSG 08",1700],
    ["aug","AUG",3300],
    ["sg556","SG 553",3000],
    ["awp","AWP",4750],
    ["scar20","SCAR-20",5000],
    ["g3sg1","G3SG1",5000]
  ]],
  ["Grenades", "nades", [
    ["flashbang","Flashbang",200],
    ["hegrenade","High Explosive Grenade",300],
    ["incgrenade","Incendiary Grenade",500],
    ["molotov","Molotov",400],
    ["decoy","Decoy Grenade",50]
  ]]
];
const BUY_ITEM = Object.fromEntries(BUY_COLS.flatMap(([, , items]) => items.map(([k, name, price]) => [k, { name, price }])));
const NADE_MAX = { flashbang: 2 }; // the others: 1; 4 grenades in all
function loadoutText() {
  const o = trOpts(), nades = {};
  for (const g of o.nades || []) nades[g] = (nades[g] || 0) + 1;
  return [o.weapon, o.pistol].map(k => BUY_ITEM[k]?.name || k)
    .concat(Object.entries(nades).map(([g, n]) => `${BUY_ITEM[g]?.name || g}${n > 1 ? ` ×${n}` : ''}`)).join(' · ');
}

function buyMenu(title, go) {
  const opt = trOpts();
  opt.nades = (opt.nades || []).filter(g => NADE_MAX[g] !== undefined || ['hegrenade', 'incgrenade', 'molotov', 'decoy'].includes(g));
  const money = v => '$' + v.toLocaleString('en-US');
  const count = (slot, k) => (slot === 'nades' ? opt.nades.filter(g => g === k).length : opt[slot] === k ? 1 : 0);
  let col = null; // the column picked with its number key, waiting for the slot's
  const root = h('div', { class: 'buy', tabindex: '-1' });
  const pick = (slot, k) => {
    if (slot === 'armor') opt.armor = opt.armor === k ? '' : k;
    else if (slot !== 'nades') opt[slot] = k;
    else {
      const n = count(slot, k), rest = opt.nades.filter(g => g !== k);
      if (n >= (NADE_MAX[k] || 1)) opt.nades = rest;
      else if (opt.nades.length < 4) opt.nades = [...opt.nades, k];
      else return;
    }
    paint();
  };
  const cancel = () => { closeModal(); renderTraining(); };
  const start = () => { if (running()) return; closeModal(); go(); };
  const tile = (ci, ri) => {
    const [, category, items] = BUY_COLS[ci];
    const [k, label, price, off] = items[ri];
    const slot = k === 'knife' || k === 'taser' ? 'weapon' : category;
    const n = off ? 0 : count(slot, k), maxed = n && n >= (slot === 'nades' ? NADE_MAX[k] || 1 : 1);
    const full = slot === 'nades' && !n && opt.nades.length >= 4;
    return h('button', { class: 'buy-item' + (n ? ' owned' : '') + (maxed ? ' maxed' : '') + (off || full ? ' off' : ''), 'data-buy': k,
      'aria-pressed': String(!!n), 'aria-disabled': String(!!off || full),
      title: off || (full ? 'Four grenades already: drop one first' : k === 'knife' ? 'Start with your knife drawn and no primary gun. Your pistol stays equipped.' : label),
      onclick: () => { if (!off && !full) pick(slot, k); } },
      h('span', { class: 'buy-slot' }, ri + 1), h('span', { class: 'buy-name' }, label), weaponIcon(k), h('span', { class: 'buy-price' }, money(price)),
      slot === 'nades' && (NADE_MAX[k] || 1) > 1 && n ? h('span', { class: 'buy-n' }, n + '/' + NADE_MAX[k]) : null);
  };
  const paint = () => {
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.buy : null;
    const scrolls = [...root.querySelectorAll('.buy-scroll')].map(el => el.scrollTop);
    const cost = [opt.weapon, opt.pistol, opt.armor, ...opt.nades].reduce((a, k) => a + (BUY_ITEM[k]?.price || 0), 0);
    root.replaceChildren(
      h('header', { class: 'buy-top' },
        h('span', { class: 'buy-money', title: 'What this loadout costs in a match' }, money(cost)),
        h('span', { class: 'buy-title' }, 'Scenario ', h('b', {}, title)),
        h('span', { class: 'buy-min' }, `Grenades: ${opt.nades.length} / 4`)),
      h('div', { class: 'buy-cols' }, ...BUY_COLS.map(([name, , items], ci) => h('section', { class: `buy-col ${col === ci ? 'sel' : ''}` },
        h('h3', {}, h('span', { class: 'buy-col-n' }, ci + 1), name),
        h('div', { class: 'buy-scroll', tabindex: '0', role: 'group', 'aria-label': name + ' weapons' }, ...items.map((_, ri) => tile(ci, ri)))))),
      h('footer', { class: 'buy-foot' },
        h('span', { class: 'buy-k' }, 'Bots'),
        select(opt.botWeapon, BOT_GUNS.slice(1), v => { opt.botWeapon = v; }),
        select(String(opt.difficulty), LEVELS.map(([v, l]) => [String(v), l]), v => { opt.difficulty = +v; }),
        toggle('Headshots only', opt.hsOnly, v => { opt.hsOnly = v; }, 'mp_damage_headshot_only: body shots do no damage'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'buy-hint' }, col === null ? 'Scroll for all weapons' : `${BUY_COLS[col][0]}: 1-5 on screen`),
        h('button', { class: 'buy-btn', onclick: cancel }, h('kbd', {}, 'Esc'), 'Back'),
        h('button', { class: 'buy-btn go', disabled: running(), onclick: start }, h('kbd', {}, 'Enter'), 'Start')));
    root.querySelectorAll('.buy-scroll').forEach((el, i) => { el.scrollTop = scrolls[i] || 0; });
    if (focused) root.querySelector(`[data-buy="${focused}"]`)?.focus({ preventScroll: true }); else root.focus({ preventScroll: true });
  };
  // CS2's keys: a column's number, then the slot's
  root.addEventListener('keydown', e => {
    if (e.target.closest('select, input')) return;
    if (e.key === 'Escape') { e.preventDefault(); if (col !== null) { col = null; paint(); } else cancel(); return; }
    if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); start(); return; }
    if (!/^[1-5]$/.test(e.key)) return;
    e.preventDefault();
    const d = +e.key - 1;
    if (col === null) { col = d; paint(); return; }
    const ci = col, list = root.querySelectorAll('.buy-scroll')[ci];
    const top = list.getBoundingClientRect().top;
    const visible = [...list.querySelectorAll('.buy-item')].filter(el => el.getBoundingClientRect().top >= top - 1 && el.getBoundingClientRect().top < top + list.clientHeight - 1);
    const item = visible[d];
    col = null;
    if (item && item.getAttribute('aria-disabled') !== 'true') item.click(); else paint();
  });
  paint();
  modal(root, { wide: true }).classList.add('buy-modal');
  root.focus();
}

function editScenario(s) {
  const sc = state.sc;
  sc.edit = structuredClone(s); sc.sel = null; sc.tool = 'move'; sc.floor = 'upper'; resetZoom(sc.view);
  renderTraining();
}

// The radar around a scenario's spots: bots (red when they shoot back) with the angle they hold, and
// your start (blue) with the way you face. On the floor most of its spots are on.
function scPreview(s) {
  const W = 480, H = 270;
  const info = radarInfo(s.map);
  const spots = [s.me?.pos, ...s.bots.flatMap(b => [b.pos, b.look])].filter(Boolean);
  if (!info || !spots.length) return h('div', { class: 'sc-prev none' }, mapEmblem(s.map, 'sc-prev-emblem'));
  const zs = [s.me?.pos, ...s.bots.map(b => b.pos)].filter(p => p && p[2] != null).map(p => p[2]);
  const lower = info.lowerBelow !== undefined && zs.filter(z => z < info.lowerBelow).length > zs.length / 2;
  const frame = radarFrame(info, s.map, { lower });
  const px = p => toPx(frame, p[0], p[1]);
  const xs = spots.map(p => px(p)[0]), ys = spots.map(p => px(p)[1]);
  // the spots' box with a margin, at least 280 radar px wide, in the canvas' shape
  let x0 = Math.min(...xs) - 60, y0 = Math.min(...ys) - 60, bw = Math.max(...xs) + 60 - x0, bh = Math.max(...ys) + 60 - y0;
  const grow = (w, hh) => { x0 -= (w - bw) / 2; y0 -= (hh - bh) / 2; bw = w; bh = hh; };
  if (bw / bh < W / H) grow(bh * W / H, bh); else grow(bw, bw * H / W);
  if (bw < 280) grow(280, 280 * H / W);
  const k = W / bw;
  const canvas = h('canvas', { class: 'sc-prev', width: W, height: H });
  radarImage(frame.src).then(img => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0d10'; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    if (img) { ctx.globalAlpha = 0.85; ctx.drawImage(img, 0, 0, RADAR_SIZE, RADAR_SIZE); ctx.globalAlpha = 1; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const at = p => { const [x, y] = px(p); return [(x - x0) * k, (y - y0) * k]; };
    for (const b of s.bots) {
      const [x, y] = at(b.pos), [lx, ly] = at(b.look), a = Math.atan2(ly - y, lx - x);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 44, a - 0.3, a + 0.3); ctx.closePath();
      ctx.fillStyle = b.shoot ? 'rgba(255,70,90,.3)' : 'rgba(255,190,60,.3)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fillStyle = b.shoot ? '#ff3d5e' : '#f0a020'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke();
    }
    if (s.me) {
      const [x, y] = at(s.me.pos), a = -s.me.yaw * Math.PI / 180;
      ctx.strokeStyle = '#4cc9ff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 26, y + Math.sin(a) * 26); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.fillStyle = '#2a9df4'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  });
  return canvas;
}

// ---------- recording in CS2 ----------
const REC_KEYS = [['F5', 'Bot here, aiming where you aim'], ['F6', 'Your start spot'], ['F7', 'Remove the last bot'], ['F8', 'Teleport test (to your start)'], ['F3', 'Finish and edit']];
const gunName = w => (BOT_GUNS.find(([k]) => k === w) || [w, w.toUpperCase()])[1];

function recorderCard() {
  const st = state.tr.status || {};
  const live = st.phase === 'recording';
  const list = st.list || [];
  const body = [
    h('div', { class: 'sc-rec-head' }, live ? h('span', { class: 'sc-rec-dot' }) : spinner(14),
      h('b', {}, live ? `Recording on ${mapName(st.map)}` : st.message || 'Starting CS2…'),
      live ? h('span', { class: 'muted' }, `${list.length} bot${list.length === 1 ? '' : 's'} · start spot ${st.me ? 'set' : 'not set'}`) : null),
    h('div', { class: 'tr-note' }, 'In CS2: buy what you want (buy anywhere is on). Stand where a bot should hold, aim where it should look and press F5. Crouch for a crouched bot; the gun in your hands is its gun. Then F6 where you start. Chat confirms each key.'),
    h('div', { class: 'sc-rec-keys' }, ...REC_KEYS.map(([k, what]) => h('span', {}, h('kbd', {}, k), what))),
    list.length ? h('div', { class: 'sc-rec-list' }, ...list.map((b, i) => h('div', { class: 'sc-rec-bot' },
      h('b', {}, `Bot ${i + 1}`), h('span', {}, [b.weapon ? gunName(b.weapon) : 'Session gun', b.crouch ? 'crouched' : null].filter(Boolean).join(' · ')),
      h('button', { class: 'btn', title: 'Remove', onclick: () => trGuard(() => api.scenarioRecordRemove(i)) }, icon(ICONS.trash))))) : null,
    h('div', { class: 'tr-row' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => trGuard(() => api.scenarioRecordStop(false)) }, 'Discard'),
      h('button', { class: 'btn primary', disabled: !live || !list.length, onclick: () => trGuard(() => api.scenarioRecordStop(true)) }, 'Finish and edit'))];
  return h('div', { class: 'dash', id: 'trLive' }, card('Recording a scenario', body, { span: 4 }));
}

// What a finished recording becomes: the editor on it (saved when it had a start spot).
function recordedScenario(st) {
  const sc = state.sc, tr = state.tr;
  tr.status = null;
  if (!st.scenario) return toast('No bot was placed: nothing saved.', 'error');
  sc.edit = structuredClone(st.scenario);
  sc.sel = null; sc.tool = st.scenario.me ? 'move' : 'me'; sc.floor = 'upper';
  resetZoom(sc.view);
  tr.drill = 'scenario';
  loadScenarios(true);
  toast(st.saved ? 'Scenario saved: fine-tune it here (jiggle, shooting, spots).' : 'No start spot was set: click where you start, then Save.', st.saved ? 'ok' : 'error');
}

// A short tone when a key in CS2 was taken (the app is behind the game).
let recAudio = null;
function recBeep() {
  try {
    recAudio = recAudio || new AudioContext();
    const o = recAudio.createOscillator(), g = recAudio.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(recAudio.destination);
    o.start(); o.stop(recAudio.currentTime + 0.09);
  } catch {}
}

// ---------- the editor ----------
function scenarioEditor() {
  const sc = state.sc, d = sc.edit;
  const info = radarInfo(d.map);
  if (info === undefined) return h('div', { class: 'empty' }, spinner(28));
  if (!info) { sc.edit = null; toast(`No radar image for ${mapName(d.map)}.`, 'error'); return scenarioList(); }
  const floors = info.lowerBelow !== undefined;
  const lower = floors && sc.floor === 'lower';
  const frame = radarFrame(info, d.map, { lower });
  const onThisFloor = z => !floors || z == null || (z < info.lowerBelow) === lower;
  const pending = new Set();

  // the floor under a point: fills p[2] (asynchronously; saving waits for it)
  const floorOf = (item, p, near = null, lift = 0) => {
    const job = api.scenarioFloor({ map: d.map, x: p[0], y: p[1], near, lower, lowerBelow: info.lowerBelow }).then(r => {
      if (r.z == null) { toast('No height known at this spot (no map mesh and no match of yours there). Pick another spot.', 'error'); p[2] = null; return; }
      p[2] = Math.round(r.z + lift);
      if (!lift) scFloors.set(item, r.floors);
      paintPanel(); redraw();
    }).catch(e => toast(e.message, 'error')).finally(() => pending.delete(job));
    pending.add(job);
    return job;
  };
  const lookFloor = b => floorOf({}, b.look, b.pos[2], 62);

  // ---- canvas
  const canvas = h('canvas', { width: 1200, height: 1200 });
  let img = null;
  radarImage(frame.src).then(i => { img = i; redraw(); });
  const S = () => canvas.width / canvas.getBoundingClientRect().width; // canvas px per screen px
  const pt = p => viewPt(canvas, sc.view, ...toPx(frame, p[0], p[1]));
  const world = e => {
    const r = canvas.getBoundingClientRect(), v = sc.view;
    const rx = v.x + (e.clientX - r.left) / r.width * RADAR_SIZE / v.k, ry = v.y + (e.clientY - r.top) / r.height * RADAR_SIZE / v.k;
    return [Math.round(frame.x + rx * frame.scale), Math.round(frame.y - ry * frame.scale)];
  };
  const canvasPt = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * S(), (e.clientY - r.top) * S()]; };
  const unitPx = () => viewScale(canvas, sc.view) / frame.scale; // canvas px per world unit

  function redraw() {
    const ctx = canvas.getContext('2d'), W = canvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    applyView(ctx, canvas, sc.view);
    if (img) { ctx.globalAlpha = 0.9; ctx.drawImage(img, 0, 0, RADAR_SIZE, RADAR_SIZE); ctx.globalAlpha = 1; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // sizes in screen pixels, whatever the canvas is shown at
    const base = S() || W / RADAR_SIZE, grow = Math.min(1.6, 0.9 + sc.view.k * 0.1), r = 9 * base * grow;
    const sel = sc.sel;
    for (const [i, b] of d.bots.entries()) {
      const [x, y] = pt(b.pos), [lx, ly] = pt(b.look);
      const on = sel?.kind === 'bot' && sel.i === i;
      ctx.globalAlpha = onThisFloor(b.pos[2]) ? 1 : 0.35;
      // the angle it holds: a cone towards the look point
      const a = Math.atan2(ly - y, lx - x), len = Math.max(r * 4, Math.hypot(lx - x, ly - y));
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, len, a - 0.12, a + 0.12); ctx.closePath();
      ctx.fillStyle = b.shoot ? 'rgba(255,70,90,.18)' : 'rgba(255,190,60,.18)'; ctx.fill();
      ctx.setLineDash([6 * base, 5 * base]); ctx.lineWidth = 1.6 * base; ctx.strokeStyle = b.shoot ? '#ff5468' : '#ffbe3c';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly); ctx.stroke(); ctx.setLineDash([]);
      if (on) { ctx.beginPath(); ctx.arc(lx, ly, r * 0.7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
      if (b.jiggle) {
        // the line it steps along, across its angle
        const half = Math.max(r * 1.5, jiggleW(b.jiggle) / 2 * unitPx()), px = -Math.sin(a), py = Math.cos(a);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * base; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - px * half, y - py * half); ctx.lineTo(x + px * half, y + py * half); ctx.stroke();
        for (const k of [-1, 1]) { ctx.beginPath(); ctx.arc(x + k * px * half, y + k * py * half, 2.2 * base, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
      }
      ctx.beginPath(); ctx.arc(x, y, b.crouch ? r * 0.8 : r, 0, Math.PI * 2);
      ctx.fillStyle = b.shoot ? '#ff3d5e' : '#f0a020'; ctx.fill();
      ctx.lineWidth = (on ? 3 : 1.5) * base; ctx.strokeStyle = on ? '#fff' : 'rgba(0,0,0,.6)'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
    }
    if (d.me) {
      const [x, y] = pt(d.me.pos), a = -d.me.yaw * Math.PI / 180;
      const on = sel?.kind === 'me';
      ctx.globalAlpha = onThisFloor(d.me.pos[2]) ? 1 : 0.35;
      ctx.strokeStyle = '#4cc9ff'; ctx.lineWidth = 2.5 * base;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * 4, y + Math.sin(a) * r * 4); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r * 1.1, 0, Math.PI * 2); ctx.fillStyle = '#2a9df4'; ctx.fill();
      ctx.lineWidth = (on ? 3 : 1.5) * base; ctx.strokeStyle = on ? '#fff' : 'rgba(0,0,0,.6)'; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // what's under the pointer: the selected bot's look point first, then spots (me, bots)
  const hitTest = e => {
    const [cx, cy] = canvasPt(e), near = (p, rad = 16) => Math.hypot(pt(p)[0] - cx, pt(p)[1] - cy) < rad * S();
    if (sc.sel?.kind === 'bot' && near(d.bots[sc.sel.i].look, 12)) return { kind: 'look', i: sc.sel.i };
    if (d.me && near(d.me.pos)) return { kind: 'me' };
    for (let i = d.bots.length - 1; i >= 0; i--) if (near(d.bots[i].pos)) return { kind: 'bot', i };
    return null;
  };
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const hit = hitTest(e), w = world(e);
    if (hit) {
      sc.sel = hit.kind === 'look' ? { kind: 'bot', i: hit.i } : hit;
      drag = { what: hit.kind === 'look' ? 'look' : 'move', ...sc.sel, moved: false };
    } else if (sc.tool === 'me') {
      d.me = { pos: [w[0], w[1], null], yaw: d.me?.yaw ?? 0 };
      sc.sel = { kind: 'me' };
      drag = { what: 'yaw', kind: 'me', moved: false, from: w };
      floorOf(d.me, d.me.pos);
    } else if (sc.tool === 'bot') {
      if (d.bots.length >= SC_MAX_BOTS) return toast(`${SC_MAX_BOTS} bots at most.`, 'error');
      const prev = d.bots.at(-1); // a new bot starts with the last one's settings
      const b = { pos: [w[0], w[1], null], look: [w[0], w[1], null], shoot: prev?.shoot ?? true, crouch: prev?.crouch ?? false, weapon: prev?.weapon ?? null, jiggle: prev?.jiggle ?? 0 };
      d.bots.push(b);
      sc.sel = { kind: 'bot', i: d.bots.length - 1 };
      drag = { what: 'look', kind: 'bot', i: sc.sel.i, moved: false, fresh: true };
      floorOf(b, b.pos);
    } else { if (sc.sel) { sc.sel = null; paintPanel(); redraw(); } return; } // move tool on the map: pan
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
    paintPanel(); redraw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const w = world(e);
    drag.moved = true;
    if (drag.what === 'yaw') d.me.yaw = Math.round(Math.atan2(w[1] - d.me.pos[1], w[0] - d.me.pos[0]) * 180 / Math.PI);
    else if (drag.what === 'look') { const b = d.bots[drag.i]; b.look[0] = w[0]; b.look[1] = w[1]; }
    else {
      const p = drag.kind === 'me' ? d.me.pos : drag.kind === 'bot' ? d.bots[drag.i].pos : null;
      const dx = w[0] - p[0], dy = w[1] - p[1];
      p[0] = w[0]; p[1] = w[1];
      if (drag.kind === 'bot') { const b = d.bots[drag.i]; b.look[0] += dx; b.look[1] += dy; } // the angle moves with it
    }
    redraw();
  });
  const endDrag = async e => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const g = drag;
    drag = null;
    if (g.what === 'look') {
      const b = d.bots[g.i];
      if (g.fresh && Math.hypot(b.look[0] - b.pos[0], b.look[1] - b.pos[1]) < 48) {
        // no drag: look at the player's start, else straight ahead
        const to = d.me ? d.me.pos : [b.pos[0] + 400, b.pos[1]];
        b.look[0] = to[0]; b.look[1] = to[1];
      }
      if (pending.size) await Promise.all([...pending]);
      if (b.pos[2] != null) lookFloor(b);
    } else if (g.what === 'move' && g.moved) {
      const p = g.kind === 'me' ? d.me.pos : g.kind === 'bot' ? d.bots[g.i].pos : null;
      const item = g.kind === 'me' ? d.me : g.kind === 'bot' ? d.bots[g.i] : p;
      await floorOf(item, p);
      if (g.kind === 'bot') lookFloor(d.bots[g.i]);
    }
    paintPanel(); redraw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  const stage = zoomable(canvas, sc.view, redraw);

  // ---- side panel
  const toolTabs = h('div', { class: 'tabs' }, ...SC_TOOLS.map(([k, l]) => h('button', { class: sc.tool === k ? 'on' : '', onclick: () => { sc.tool = k; renderTraining(); } }, l)));
  const panel = h('div', { class: 'sc-sel' });
  const counts = h('div', { class: 'sc-counts' });
  function floorChips(item, p, after) {
    const list = scFloors.get(item) || [];
    if (list.length < 2) return null;
    return h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Floor'),
      h('div', { class: 'chips' }, ...list.map(z => h('button', { class: `chip-toggle ${p[2] === z ? 'on' : ''}`, onclick: () => { p[2] = z; if (after) after(); paintPanel(); redraw(); } }, `${z}`))));
  }
  function paintPanel() {
    counts.textContent = `${d.me ? '✓ start' : 'no start yet'} · ${d.bots.length}/${SC_MAX_BOTS} bots`;
    const s = sc.sel;
    const del = fn => h('button', { class: 'btn', onclick: () => { fn(); sc.sel = null; paintPanel(); redraw(); } }, icon(ICONS.trash), 'Remove');
    let body;
    if (!s) body = h('div', { class: 'muted-note' }, 'Click a spot on the map to change it.');
    else if (s.kind === 'me' && d.me) body = [h('b', {}, 'Your start'), h('div', { class: 'hint' }, `Facing ${d.me.yaw}° · height ${d.me.pos[2] ?? '…'}`), floorChips(d.me, d.me.pos)];
    else if (s.kind === 'bot' && d.bots[s.i]) {
      const b = d.bots[s.i];
      body = [h('b', {}, `Bot ${s.i + 1}`),
        h('div', { class: 'tr-row' }, toggle('Shoots back', b.shoot, v => { b.shoot = v; redraw(); }, 'Off: it holds the angle but never fires (pre-aim practice)'),
          toggle('Crouched', b.crouch, v => { b.crouch = v; redraw(); })),
        h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Gun'), select(b.weapon || '', BOT_GUNS, v => { b.weapon = v || null; })),
        h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Level'),
          select(b.level == null ? '' : String(b.level), [['', 'Session level'], ...LEVELS.map(([v, l]) => [String(v), l])], v => { b.level = v === '' ? null : +v; })),
        h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Moves'),
          h('div', { class: 'tabs' }, ...JIGGLES.map(([v, l]) => h('button', { class: !!b.jiggle === v ? 'on' : '', title: v ? 'Steps left and right across its angle' : 'Stands on its spot',
            onclick: () => { b.jiggle = v ? jiggleW(b.jiggle) || 48 : 0; paintPanel(); redraw(); } }, l)))),
        slider('Hears', b.hear || 1200, 300, 3000, 100, v => `${v} u`, v => { b.hear = v; }, 'How far it hears your footsteps, shots and reloads (running footsteps carry about 1100 units): it turns towards them for a few seconds'),
        b.jiggle ? [
          slider('Width', jiggleW(b.jiggle), 16, 200, 4, v => `${v} u`, v => { b.jiggle = v; redraw(); }),
          slider('Stop', b.jigglePause ?? 0.25, 0, 2, 0.05, v => `${v.toFixed(2)} s`, v => { b.jigglePause = v; }, 'How long it stops at each end (a bit random)'),
          h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Speed'),
            h('div', { class: 'tabs' }, ...[[false, 'Run'], [true, 'Walk']].map(([v, l]) => h('button', { class: !!b.jiggleWalk === v ? 'on' : '', onclick: () => { b.jiggleWalk = v; paintPanel(); } }, l)))),
        ] : null,
        floorChips(b, b.pos, () => lookFloor(b)),
        del(() => d.bots.splice(s.i, 1))];
    }
    panel.replaceChildren(...[body].flat(2).filter(Boolean));
  }
  paintPanel();

  const name = h('input', { type: 'text', class: 'sc-name', placeholder: 'Name (e.g. A site from ramp)', value: d.name || '', oninput: e => { d.name = e.target.value; } });
  const save = async play => {
    if (pending.size) await Promise.all([...pending]);
    const bad = [d.me?.pos, ...d.bots.flatMap(b => [b.pos, b.look])].some(p => p && p[2] == null);
    if (bad) return toast('A spot has no height yet: move it a little or pick another spot.', 'error');
    let saved;
    try { saved = await api.scenarioSave(d); } catch (e) { return toast(e.message, 'error'); }
    toast('Scenario saved.', 'ok');
    sc.edit = null;
    loadScenarios(true);
    if (play) playScenario(saved); else renderTraining();
  };
  const noMesh = !sc.meshes.includes(d.map);
  const side = [
    h('div', { class: 'tr-row' }, name),
    h('div', { class: 'tr-row' }, toolTabs),
    h('div', { class: 'tr-note' }, SC_HINT[sc.tool]),
    counts,
    panel,
    h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Win'),
      select(String(d.options.firstTo || 0), [['0', 'Play every rep'], ...[3, 5, 7, 10, 13, 16].map(n => [String(n), `First team to ${n}`])], v => { d.options.firstTo = +v; renderTraining(); })),
    d.options.firstTo ? null : h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Reps'),
      select(String(d.options.reps), [3, 5, 10, 15, 20, 30].map(n => [String(n), String(n)]), v => { d.options.reps = +v; })),
    h('div', { class: 'tr-row' }, h('span', { class: 'tr-label' }, 'Timer'),
      select(String(d.options.seconds), [10, 15, 20, 25, 30, 45, 60, 90, 120].map(n => [String(n), `${n} s per round`]), v => { d.options.seconds = +v; })),
    h('div', { class: 'tr-note' }, `A round is yours when every bot is dead, the bots' when you die or the timer runs out. ${d.options.firstTo ? `The first side to ${d.options.firstTo} wins` : 'After the last rep you see the result'}, then CS2 closes.`),
    noMesh ? h('div', { class: 'tr-note' }, `No map mesh for ${mapName(d.map)} on this PC: heights come from your matches only (open a match's Integrity tab once to download the meshes).`) : null,
    h('div', { class: 'tr-start' },
      h('button', { class: 'btn', onclick: () => { sc.edit = null; renderTraining(); } }, 'Cancel'),
      h('button', { class: 'btn', onclick: () => save(false) }, 'Save'),
      h('button', { class: 'btn primary', disabled: running(), onclick: () => save(true) }, icon(ICONS.play), 'Save & play')),
  ];
  const head = h('div', { class: 'page-head' },
    h('button', { class: 'link-btn', onclick: () => { if (!confirm('Leave without saving?')) return; sc.edit = null; renderTraining(); } }, '← My scenarios'),
    h('h2', {}, d.id ? 'Edit scenario' : 'New scenario'), h('span', { class: 'dl-head-info' }, mapName(d.map)));
  return [head, h('div', { class: 'sc-editor' },
    h('div', { class: 'sc-stage' },
      floors ? h('div', { class: 'tabs' }, ...[['upper', 'Upper floor'], ['lower', 'Lower floor']].map(([k, l]) =>
        h('button', { class: sc.floor === k ? 'on' : '', onclick: () => { sc.floor = k; renderTraining(); } }, l))) : null,
      stage),
    h('div', { class: 'sc-side' }, ...side))];
}

async function shareScenarios(list) {
  const code = await guard(() => api.scenarioCode(list.map(s => s.id)));
  if (!code) return;
  await guard(async () => {
    await copyText(code);
    toast(code.startsWith('DLS2-') ? `Copied ${code}. Paste it in Scenarios > Import code.` : 'Copied a long scenario code. Paste it in Scenarios > Import code.', 'ok');
  });
}
async function scenarioImportDialog(prefill = '') {
  if (!prefill) { try { const text = await navigator.clipboard.readText(); if (/DLS[12]-/.test(text)) prefill = text; } catch {} }
  const area = h('textarea', { class: 'code-area mono', placeholder: 'Paste DLS2- or DLS1- codes here', spellcheck: 'false' }, prefill);
  const err = h('div', {});
  const read = async () => {
    err.replaceChildren();
    let list;
    try { list = await api.scenarioReadCode(area.value); }
    catch (e) { err.replaceChildren(h('div', { class: 'err-box' }, e.message)); return; }
    const pick = list.map(s => !s.dupe);
    const go = h('button', { class: 'btn primary', onclick: async () => {
      go.disabled = true;
      const n = await guard(() => api.scenarioImport(list.filter((_, i) => pick[i])));
      if (n === undefined) { label(); return; }
      closeModal(); toast(`${n} scenario${n === 1 ? '' : 's'} imported.`, 'ok'); loadScenarios(true);
    } });
    const label = () => { const n = pick.filter(Boolean).length; go.textContent = `Import ${n} scenarios`; go.disabled = !n; };
    label();
    modal([
      h('h2', {}, 'Import scenarios'),
      h('div', { class: 'import-list' }, ...list.map((s, i) => h('label', { class: `import-item ${s.dupe ? 'dupe' : ''}` },
        h('input', { type: 'checkbox', checked: pick[i], disabled: s.dupe, onchange: e => { pick[i] = e.target.checked; label(); } }),
        h('span', { class: 'import-t' }, h('b', {}, s.name), h('span', { class: 'ut-sub' }, `${mapName(s.map)} / ${s.bots.length} bots`)),
        s.dupe ? h('span', { class: 'pill' }, 'Already saved') : null))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => scenarioImportDialog(area.value) }, 'Back'), go),
    ]);
  };
  modal([h('h2', {}, 'Import scenarios'), area, err,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'), h('button', { class: 'btn primary', onclick: read }, 'Read code'))]);
  area.focus();
  if (prefill) read();
}
