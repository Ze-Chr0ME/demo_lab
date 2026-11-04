/* global pickWeapon, pickSvg, PICK_ICONS, sideIcon, $, api, state, h, icon, ICONS, toast, guard, mapName, fmtDate, fmtDur, clamp, pct, fmtNum, spinner, card, barList, big, select, toggle,
   modal, closeModal, renderDetail, showInReplay, viewInCs2Button, openDemo, showView, loadDemos, loadUtility, renderUtility, utFiltered,
   copyText, mapThumb, avatar, aggregate, per, PERIODS, shownProfile, povId, placeLabel, AIM_STATS, aimValues, aimLevel, ratingClass, row, save,
   NADE_COLOR, utLabel, UT_TYPES, renderOverview, openPlayer, ago, artImg, mapIconUrl */
'use strict';
// Added on top of app.js and insights.js: the death review (match tab and overview card), the Compare
// page, the new-match processing shown in the app, and share codes for Utility lineups. Loaded last.

// ---------- Death review ----------
// What each tag means (lib/deaths.js decides them). 'bad' tags are mistakes worth working on, 'info' ones
// describe the fight.
const DEATH_TAGS = {
  alone: { label: 'Died alone', kind: 'bad', tip: 'Not traded, and no teammate was close enough to trade you (all over 1,100 units away).' },
  untraded: { label: 'Not traded', kind: 'bad', tip: 'A teammate was close enough, but nobody killed your killer within 5 seconds.' },
  nades: { label: 'Grenades unused', kind: 'bad', tip: 'You died with grenades still in hand.' },
  dry: { label: 'Entry without utility', kind: 'bad', tip: 'First death of a T round, with no team flash, smoke, molotov or HE landing near the fight just before.' },
  caught: { label: 'Caught off guard', kind: 'bad', tip: 'The killer came into view with your crosshair 15° or more from their head, hit you first and killed you. Only in measured matches.' },
  lowhp: { label: 'Fought on low HP', kind: 'bad', tip: 'You took the fight with less than 40 HP left.' },
  flashed: { label: 'Died blind', kind: 'bad', tip: 'An enemy flash still blinded you when you died.' },
  teamflash: { label: 'Team-flashed', kind: 'bad', tip: 'A teammate’s flash still blinded you when you died.' },
  late: { label: 'After the round', kind: 'bad', tip: 'You died after the round was already over: a gun you could have saved.' },
  outaimed: { label: 'Out-aimed', kind: 'info', tip: 'Your crosshair was close to their head, but they hit first. Only in measured matches.' },
  crossfire: { label: 'Crossfire', kind: 'info', tip: 'Two or more enemies hurt you in your last 4 seconds.' },
  unseen: { label: 'Never saw them', kind: 'info', tip: 'The killer never came into your view: from behind, through a smoke or a wall. Only in measured matches.' },
  hitfirst: { label: 'Hit first, lost', kind: 'info', tip: 'You hit your killer first and still lost the duel.' },
  opening: { label: 'Opening death', kind: 'info', tip: 'The first death of the round.' },
};
const DEATH_ORDER = Object.keys(DEATH_TAGS);
const MEASURED_ONLY = new Set(['caught', 'outaimed', 'unseen']);

// The tag as a pill, with this death's specifics in it.
function deathPill(t, x) {
  const def = DEATH_TAGS[t];
  if (!def) return null;
  const detail = {
    alone: x.nearest != null ? `closest teammate ${fmtNum(x.nearest)} u away` : null,
    untraded: x.nearest != null ? `closest teammate ${fmtNum(x.nearest)} u away` : null,
    nades: x.nades?.length ? x.nades.join(', ') : null,
    flashed: x.flashedBy ? `by ${x.flashedBy}` : null,
    teamflash: x.flashedBy ? `by ${x.flashedBy}` : null,
    lowhp: `${x.hp} HP`,
    caught: x.xhair != null ? `crosshair ${x.xhair}° off` : null,
    outaimed: x.xhair != null ? `crosshair ${x.xhair}° off` : null,
    hitfirst: x.dmgFirst ? `${x.dmgFirst} damage first` : null,
  }[t];
  return h('span', { class: `dtag ${def.kind}`, title: def.tip }, def.label, detail ? h('small', {}, detail) : null);
}

function deathRow(x, { name, steamid, onReplay, cs2 = true, extra = null }) {
  return h('div', { class: 'integ-moment death-row' },
    h('div', { class: 'round-box' }, h('div', { class: 'l' }, 'Round'), h('div', { class: 'n' }, x.round), h('div', { class: 'l' }, fmtDur(x.clock))),
    h('div', { class: 'integ-text' },
      extra,
      h('div', { class: 'death-line' },
        sideTag(x.side), ...(x.killerName === 'yourself' || x.killerName === 'the world' ? [' ', h('b', {}, x.weapon === 'World' ? 'Fall or world damage' : `Own ${x.weapon}`)] : [' Killed by ', h('b', {}, x.killerName || '?'), ` with the ${x.weapon}`]), x.headshot ? ' (headshot)' : '', x.wallbang ? ' · wallbang' : '', x.smoke ? ' · through smoke' : '',
        x.place ? ` · ${placeLabel(x.place)}` : ''),
      h('div', { class: 'death-tags' },
        ...DEATH_ORDER.filter(t => x.tags.includes(t)).map(t => deathPill(t, x)),
        x.traded ? h('span', { class: 'dtag good', title: 'A teammate killed your killer within 5 seconds' }, `Traded by ${x.traded.by}`, h('small', {}, `${x.traded.after} s later`)) : null,
        !x.tags.some(t => DEATH_TAGS[t]?.kind === 'bad') && !x.traded ? h('span', { class: 'dtag', title: 'None of the usual mistakes' }, 'Nothing to blame') : null)),
    h('div', { class: 'integ-actions' },
      h('button', { class: 'btn', title: 'The last seconds before this death in the 2D replay', onclick: onReplay || (() => showInReplay(steamid, x.tick - 5 * 64)) }, icon(ICONS.play), '2D replay'),
      cs2 ? viewInCs2Button('View in CS2', 'btn', 'Opens the demo in CS2 in this player’s eyes 6 s before this death and pauses on it',
        () => ({ tick: x.tick, lead: 6, pause: true, name }), 'Paused on the death in CS2. Use the demo controls (Shift+F2) to step back and forth.') : null));
}

state.dv = { data: null, loading: null, filter: 'all' };
function deathsData() {
  const d = state.demo, sid = povId(), key = `${d.id}|${sid}`;
  if (state.dv.data?.key === key) return state.dv.data;
  if (state.dv.loading !== key) {
    state.dv.loading = key;
    api.deaths(d.path, sid || undefined)
      .then(v => { state.dv.data = { key, value: v }; })
      .catch(e => { state.dv.data = { key, error: e.message }; })
      .finally(() => { if (state.dv.loading === key) state.dv.loading = null; if (state.demo?.id === d.id && state.tab === 'deaths') renderDetail(); });
  }
  return null;
}

// Counts per tag over a list of deaths, as filter chips.
function deathChips(deaths, current, onpick) {
  const counts = {};
  for (const x of deaths) for (const t of x.tags) counts[t] = (counts[t] || 0) + 1;
  const chip = (k, label, n, cls = '') => h('button', { class: `chip-toggle dchip ${cls} ${current === k ? 'on' : ''}`, title: DEATH_TAGS[k]?.tip || '', onclick: () => onpick(k) }, label, h('span', { class: 'tab-count' }, n));
  return h('div', { class: 'chips death-chips' },
    chip('all', 'All deaths', deaths.length),
    ...DEATH_ORDER.filter(t => counts[t]).map(t => chip(t, DEATH_TAGS[t].label, counts[t], DEATH_TAGS[t].kind)));
}

function deathsView() {
  const st = deathsData();
  if (!st) return h('div', { class: 'empty' }, spinner(24), h('h2', {}, 'Going over every death…'), h('div', {}, 'The first time for a match it reads where everyone stood at each kill (about a second).'));
  if (st.error) return h('div', { class: 'empty' }, h('h2', {}, 'Could not review the deaths'), h('div', { class: 'err-box' }, st.error));
  const v = st.value;
  const name = state.analysis?.player?.name || 'You';
  if (!v) return h('div', { class: 'empty' }, h('h2', {}, 'This player is not in this demo'));
  if (!v.deaths.length) return h('div', { class: 'empty' }, h('h2', {}, `${name} never died in this match`), h('div', {}, 'Nothing to review.'));
  const f = state.dv.filter in DEATH_TAGS || state.dv.filter === 'all' ? state.dv.filter : 'all';
  const list = v.deaths.filter(x => f === 'all' || x.tags.includes(f));
  const bad = v.deaths.filter(x => x.tags.some(t => DEATH_TAGS[t]?.kind === 'bad')).length;

  let measure = null;
  if (!v.measured) {
    const btn = h('button', { class: 'btn', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Measuring… (about 10 s)';
      try { await api.aim(state.demo.path); state.dv.data = null; state.aimRes = null; renderDetail(); }
      catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Measure this match'; }
    } }, 'Measure this match');
    measure = h('div', { class: 'integ-note death-note' }, h('span', {}, 'Measure the match to also see when you were caught off guard, out-aimed, or never saw your killer (one pass over every tick, the same as the Aim tab).'), btn);
  }
  return [
    h('div', { class: 'section-head' }, h('h3', { class: 'with-avatar' }, avatar(name, povId(), 'sm'), `Deaths · ${name}`), h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, `${bad} of ${v.deaths.length} deaths had something to fix. Red: something to fix · grey: context. Hover a tag for what it means.`)),
    measure,
    deathChips(v.deaths, f, k => { state.dv.filter = k; renderDetail(); }),
    list.length ? h('div', { class: 'integ-moments' }, ...list.map(x => deathRow(x, { name, steamid: povId() }))) : h('div', { class: 'integ-none' }, 'No death with this tag.'),
  ];
}

// ---------- Death review on the overview ----------
function deathTotals(list) {
  const t = { n: 0, measuredN: 0, matches: 0, tags: {} };
  for (const m of list) {
    if (!m.review) continue;
    t.matches++;
    t.n += m.review.n;
    if (m.review.measured) t.measuredN += m.review.n;
    for (const [k, c] of Object.entries(m.review.tags)) t.tags[k] = (t.tags[k] || 0) + c;
  }
  return t;
}
const deathShare = (t, k) => { const of = MEASURED_ONLY.has(k) ? t.measuredN : t.n; return of ? (t.tags[k] || 0) / of : null; };

// ---------- Compare ----------
// Two players side by side over the same filters (or one against "your lobbies": every player of every
// demo you have). Bars show where each value ranks among your lobbies' player-matches.
state.cmp = { a: null, b: 'lobby', mode: 'all', map: 'all', period: 'all', together: false, profiles: new Map(), lobby: null, lobbyAsked: false, players: null };

const sumMulti = m => Object.values(m || {}).reduce((a, b) => a + b, 0);
const CMP_ICONS = {
  chart: '<path d="M5 20V12M12 20V4M19 20v-9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  crosshair: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  burst: '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  skull: '<path d="M8 20v-4a8 8 0 1 1 8 0v4zM10 17v3M14 17v3M8 10h1M15 10h1M11 14h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  target: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 12h6M12 9v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  trophy: '<path d="M8 3h8v6a4 4 0 0 1-8 0zM8 5H4v2a4 4 0 0 0 4 4M16 5h4v2a4 4 0 0 1-4 4M12 13v7M8 21h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  matches: '<path d="M5 4h14v17H5zM8 2v4M16 2v4M5 9h14M8 13h3M8 17h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  swap: '<path d="M4 7h16M16 3l4 4-4 4M20 17H4M8 13l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  up: '<path d="M12 20V4M6 10l6-6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M12 4v16M6 14l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  teamed: '<circle cx="9" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  team: '<circle cx="12" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 21v-4a6 6 0 0 1 12 0v4M5 4a3 3 0 0 0 0 6M3 14a5 5 0 0 0-1 3v3M19 4a3 3 0 0 1 0 6M21 14a5 5 0 0 1 1 3v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  flame: '<path d="M13 3c1 5-4 5-3 9-2 0-3-2-3-3-4 5-1 12 5 12 7 0 10-8 1-18z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  shield: '<path d="M12 3l8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};
const CMP_GROUP_ICONS = { Overall: CMP_ICONS.chart, Duels: CMP_ICONS.crosshair, Utility: CMP_ICONS.burst, Deaths: CMP_ICONS.skull, Aim: CMP_ICONS.target };

const CMP_STATS = [
  { g: 'Overall', icon: CMP_ICONS.chart, label: 'Rating ≈ HLTV 2.0', d: 2, t: t => t.rating, r: r => r[2] },
  { g: 'Overall', icon: CMP_ICONS.trophy, label: 'Win rate', u: '%', d: 0, t: t => per(100 * t.won, t.played), r: null },
  { g: 'Overall', icon: CMP_ICONS.crosshair, label: 'K/D', d: 2, t: t => t.kd, r: r => (r[4] ? r[3] / r[4] : r[3]) },
  { g: 'Overall', icon: CMP_ICONS.burst, label: 'ADR', d: 1, t: t => t.adr, r: r => r[6] / r[1] },
  { g: 'Overall', icon: CMP_ICONS.shield, label: 'KAST', u: '%', d: 1, t: t => per(100 * t.kastRounds, t.rounds), r: r => 100 * r[7] / r[1] },
  { g: 'Overall', icon: CMP_ICONS.target, label: 'Headshot %', u: '%', d: 1, t: t => per(100 * t.hs, t.kills), r: r => (r[3] ? 100 * r[8] / r[3] : null) },
  { g: 'Duels', icon: CMP_ICONS.crosshair, label: 'Kills / round', d: 2, t: t => per(t.kills, t.rounds), r: r => r[3] / r[1] },
  { g: 'Duels', icon: CMP_ICONS.skull, label: 'Deaths / round', d: 2, low: true, t: t => per(t.deaths, t.rounds), r: r => r[4] / r[1] },
  { g: 'Duels', icon: CMP_ICONS.trophy, label: 'Opening duels won', u: '%', d: 0, t: t => per(100 * t.fk, t.fk + t.fd), r: r => (r[9] + r[10] ? 100 * r[9] / (r[9] + r[10]) : null) },
  { g: 'Duels', icon: CMP_ICONS.crosshair, label: 'Opening duels taken', u: '%', d: 0, neutral: true, tip: 'Rounds where they were in the first duel: a role, not better or worse.', t: t => per(100 * (t.fk + t.fd), t.rounds), r: r => 100 * (r[9] + r[10]) / r[1] },
  { g: 'Duels', icon: CMP_ICONS.swap, label: 'Trade kills / round', d: 2, t: t => per(t.trades, t.rounds), r: r => r[11] / r[1] },
  { g: 'Duels', icon: CMP_ICONS.burst, label: 'Multi-kill rounds', u: '%', d: 1, t: t => per(100 * sumMulti(t.multi), t.rounds), r: r => 100 * r[14] / r[1] },
  { g: 'Duels', icon: CMP_ICONS.shield, label: 'Clutches won', u: '%', d: 0, t: t => per(100 * t.clutchWon, t.clutchPlayed), r: r => (r[16] ? 100 * r[15] / r[16] : null) },
  { g: 'Utility', icon: CMP_ICONS.burst, label: 'Utility damage / round', d: 1, t: t => per(t.utility, t.rounds), r: r => r[12] / r[1] },
  { g: 'Utility', icon: CMP_ICONS.burst, label: 'Enemies flashed / round', d: 2, t: t => per(t.flashed, t.rounds), r: r => r[13] / r[1] },
  ...['alone', 'untraded', 'nades', 'dry', 'lowhp', 'caught'].map(k => ({
    g: 'Deaths', icon: CMP_ICONS.skull, label: DEATH_TAGS[k].label, u: '%', d: 0, low: true, tip: `${DEATH_TAGS[k].tip}\nShare of their deaths.`,
    t: (t, dt) => { const s = deathShare(dt, k); return s == null ? null : 100 * s; },
    r: MEASURED_ONLY.has(k) ? null : r => (r[18] && r[4] ? 100 * (r[18][k] || 0) / r[4] : null),
  })),
];

function cmpProfileOf(sid) {
  const c = state.cmp, me = state.env?.mySteamId;
  if (!sid || sid === me) return state.profile;
  if (c.profiles.has(sid)) return c.profiles.get(sid);
  c.profiles.set(sid, null);
  api.profile(sid).then(p => { c.profiles.set(sid, p); }).catch(e => { c.profiles.set(sid, { error: e.message, steamid: sid, matches: [] }); })
    .finally(() => { if (state.view === 'compare') renderCompare(); });
  return null;
}
function cmpLobby() {
  const c = state.cmp;
  if (!c.lobbyAsked) {
    c.lobbyAsked = true;
    api.lobby().then(v => { c.lobby = v; }).catch(e => { c.lobby = { error: e.message, matches: [] }; }).finally(() => { if (state.view === 'compare') renderCompare(); });
  }
  return c.lobby;
}
function cmpFilter(list, ids) {
  const c = state.cmp;
  let out = list.filter(m => (c.mode === 'all' || m.mode === c.mode) && (c.map === 'all' || m.map === c.map) && (!ids || ids.has(m.id))).sort((a, b) => b.date - a.date);
  if (/d$/.test(c.period)) { const since = Date.now() - parseInt(c.period, 10) * 864e5; out = out.filter(m => m.date >= since); }
  else if (c.period !== 'all') out = out.slice(0, +c.period);
  return out;
}

// Share of the lobby's player-matches that a value beats (lower-is-better stats reversed).
function rankIn(sorted, v, low) {
  if (v == null || !sorted.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  let eq = lo;
  while (eq < sorted.length && sorted[eq] === v) eq++;
  const below = (lo + eq) / 2 / sorted.length;
  return low ? 1 - below : below;
}
// Aim stats only have quartiles of the lobbies (AIM_STATS good / bad): a rough percentile from them.
function aimRank(s, v) {
  if (v == null) return null;
  const [bad, good] = [s.bad, s.good];
  let x = s.low ? (bad - v) / (bad - good) : (v - bad) / (good - bad); // 0 at the 25th percentile, 1 at the 75th
  x = 0.25 + 0.5 * x;
  return clamp(x, 0.02, 0.98);
}

let cmpCloseMenu = null;
let cmpMenuId = 0;
function cmpFilterIcon(key, value) {
  let svg;
  if (key === 'map') svg = CMP_ICONS.map;
  else if (key === 'mode') svg = value === 'all' ? CMP_ICONS.grid : value === 'Wingman' ? CMP_ICONS.teamed : value === 'Rush' ? CMP_ICONS.flame : CMP_ICONS.team;
  else svg = value === 'all' ? CMP_ICONS.clock : /d$/.test(value) ? CMP_ICONS.matches : CMP_ICONS.chart;
  return h('span', { class: 'cmp-filter-icon', 'aria-hidden': 'true' }, icon(svg),
    key === 'map' && value !== 'all' ? artImg('cmp-filter-emblem', mapIconUrl(value).catch(() => null)) : null);
}

// Also the menu behind every long select() in the app: cls styles the button, noun names what the search looks for.
function cmpMenu({ value, items, onpick, trigger, search = false, right = false, cls, noun = 'players' }) {
  const selected = items.find(p => p.value === value);
  const players = search && !cls;
  const btn = h('button', { type: 'button', class: cls || (search ? 'cmp-pick' : 'cmp-filter-pick'),
    'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => open() },
    selected?.icon ? selected.icon() : null,
    h('span', { class: players ? 'cmp-name' : 'pick-label' }, trigger || selected?.label || value),
    icon(CMP_ICONS.chevron, 'aria-hidden="true"'));
  let close = null;
  const open = (edge = 0) => {
    if (close) { close(true); return; }
    cmpCloseMenu?.();
    const id = `cmp-menu-${++cmpMenuId}`;
    const list = h('div', { class: 'cmp-menu-list', id, role: 'listbox', tabindex: '-1', 'aria-label': players ? 'Players' : btn.textContent });
    const input = search ? h('input', { class: 'cmp-menu-search', type: 'search', placeholder: `Search ${noun}...`, 'aria-label': `Search ${noun}`,
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': id, 'aria-expanded': 'true', oninput: () => draw() }) : null;
    const menu = h('div', { class: `cmp-menu ${players ? 'cmp-player-menu' : ''}` }, input, list);
    const focus = input || list;
    let visible = [], rows = [], active = -1;
    const highlight = i => {
      active = i;
      rows.forEach((row, n) => row.classList.toggle('active', n === active));
      if (rows[active]) {
        focus.setAttribute('aria-activedescendant', rows[active].id);
        rows[active].scrollIntoView({ block: 'nearest' });
      } else focus.removeAttribute('aria-activedescendant');
    };
    const pick = item => { close(true); onpick(item.value); };
    const draw = () => {
      const query = (input?.value || '').trim().toLocaleLowerCase();
      visible = items.filter(p => p.label.toLocaleLowerCase().includes(query));
      rows = visible.map((p, i) => h('button', { type: 'button', class: `cmp-menu-row ${p.value === value ? 'selected' : ''}`,
        id: `${id}-${i}`, role: 'option', 'aria-selected': String(p.value === value), tabindex: '-1',
        onpointermove: () => { if (active !== i) highlight(i); }, onpointerdown: e => e.preventDefault(), onclick: () => pick(p) },
        ...(p.content ? p.content() : [p.icon ? p.icon() : null, h('span', { class: 'cmp-menu-name' }, p.label), h('span', { class: 'cmp-menu-check' }, p.value === value ? icon(ICONS.check, 'aria-hidden="true"') : null)])));
      list.replaceChildren(...rows, !rows.length ? h('div', { class: 'cmp-menu-empty' }, `No ${noun} found`) : '');
      highlight(Math.max(0, visible.findIndex(p => p.value === value)));
      position();
    };
    // Body portal avoids clipping in scrolling views.
    const position = e => {
      if (e && menu.contains(e.target)) return;
      const r = btn.getBoundingClientRect(), w = document.documentElement.clientWidth, ht = document.documentElement.clientHeight;
      if (!btn.isConnected || r.bottom < 0 || r.top > ht) { close(); return; }
      const below = Math.max(0, ht - r.bottom - 14), above = Math.max(0, r.top - 14);
      const up = below < Math.min(420, list.scrollHeight + (input ? input.offsetHeight + 5 : 0) + 12) && above > below;
      menu.style.maxHeight = `${Math.min(420, up ? above : below)}px`;
      menu.style.left = `${Math.max(8, Math.min(right ? r.right - menu.offsetWidth : r.left, w - menu.offsetWidth - 8))}px`;
      menu.style.top = `${up ? Math.max(8, r.top - menu.offsetHeight - 6) : r.bottom + 6}px`;
    };
    const outside = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(true);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (rows.length) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
      } else if (e.key === 'Enter' && visible[active]) { e.preventDefault(); e.stopPropagation(); pick(visible[active]); }
    };
    const view = btn.closest('.view') || $('#overlay'); // pickers in dialogs live in the overlay
    const gone = () => !btn.isConnected || (view.id === 'overlay' ? view.classList.contains('hidden') : !view.classList.contains('active'));
    const observer = new MutationObserver(() => { if (gone()) close(); });
    close = (restore = false) => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      observer.disconnect();
      menu.remove();
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-controls');
      if (cmpCloseMenu === close) cmpCloseMenu = null;
      close = null;
      if (restore && btn.isConnected) btn.focus({ preventScroll: true });
    };
    cmpCloseMenu = close;
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', id);
    document.body.append(menu);
    draw();
    if (!close) return;
    focus.focus({ preventScroll: true });
    highlight(edge < 0 ? rows.length - 1 : active);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    observer.observe(view, { attributes: true, childList: true, subtree: true });
  };
  btn.addEventListener('keydown', e => {
    if (!close && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); open(e.key === 'ArrowUp' ? -1 : 0); }
  });
  return btn;
}

// Shared searchable player picker; one index request serves every page.
function playerMenu({ value = state.who, onpick = selectPlayer, right = false, trigger, lobby = false, you = true } = {}) {
  const c = state.cmp, me = state.env?.mySteamId;
  if ((!c.players || c.playersStale) && !c.playersLoading) {
    c.playersStale = false;
    c.playersLoading = true;
    api.players().then(p => { c.players = p; }).catch(() => { c.players ||= { self: me, players: [] }; })
      .finally(() => { c.playersLoading = false; rerender(); });
  }
  const known = (c.players?.players || []).filter(p => p.steamid !== c.players?.self).sort((x, y) => (y.with + y.against) - (x.with + x.against) || y.matches - x.matches);
  const myName = state.env?.steamUser?.name || 'You';
  const self = { value: me, label: `${myName} (you)`, content: () => [avatar(myName, me, 'sm'), h('span', { class: 'cmp-menu-name' }, `${myName} (you)`)] };
  const opts = (cur, extra) => {
    const list = known.slice();
    const count = (n, teamed) => h('span', { class: `cmp-menu-count ${teamed ? 'teamed' : 'against'} ${n ? '' : 'zero'}`,
      title: teamed ? `${n} matches on your team` : `${n} matches against you` },
      icon(teamed ? CMP_ICONS.teamed : CMP_ICONS.crosshair, 'aria-hidden="true"'), h('span', {}, n));
    return [...extra, ...list.map(p => ({ value: p.steamid, label: p.name || p.steamid,
      content: () => [avatar(p.name, p.steamid, 'sm'), h('span', { class: 'cmp-menu-name' }, p.name || p.steamid), count(p.with || 0, true), count(p.against || 0, false)] }))];
  };
  const extra = [...(lobby ? [{ value: 'lobby', label: 'Your lobbies (the median player)',
    content: () => [h('span', { class: 'cmp-menu-lobby' }, icon(CMP_ICONS.chart, 'aria-hidden="true"')), h('span', { class: 'cmp-menu-name' }, 'Your lobbies (the median player)')] }] : []), ...(you ? [self] : [])];
  value = value || me;
  return cmpMenu({ value, items: opts(value, extra), search: true, right, onpick,
    trigger: trigger || (value === 'lobby' ? 'Your lobbies' : value === me ? myName : known.find(p => p.steamid === value)?.name || (value === state.who ? state.other?.name : null) || value) });
}

function renderCompare() {
  cmpCloseMenu?.();
  const view = $('#view-compare');
  const c = state.cmp, env = state.env;
  const me = env?.mySteamId;
  const aId = c.a || me;
  const page = (...body) => view.replaceChildren(h('div', { class: 'page cmp-page' }, ...body));
  if (!me && !c.a) return page(h('div', { class: 'empty' }, h('h2', {}, 'Which player are you?'), h('div', {}, 'Set your SteamID in Settings first.')));
  const A = cmpProfileOf(aId);
  const B = c.b === 'lobby' ? null : cmpProfileOf(c.b);
  const lobby = cmpLobby();

  // ---- pickers
  const pickA = playerMenu({ value: aId, trigger: A?.name,
    onpick: v => { c.a = v === me ? null : v; renderCompare(); } });
  const pickB = playerMenu({ value: c.b, lobby: true, you: aId !== me, right: true, trigger: B?.name,
    onpick: v => { c.b = v; renderCompare(); } });
  const swap = c.b !== 'lobby' ? h('button', { class: 'icon-btn cmp-swap', title: 'Swap sides', 'aria-label': 'Swap sides', onclick: () => { const a = aId; c.a = c.b === me ? null : c.b; c.b = a; renderCompare(); } }, icon(CMP_ICONS.swap, 'aria-hidden="true"')) : null;

  if (!A || (c.b !== 'lobby' && !B)) return page(h('div', { class: 'cmp-filters loading' }, pickA, pickB), h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Loading stats…')));

  // ---- filters (modes and maps of both players)
  const pool = [...A.matches, ...(B?.matches || [])];
  const modes = [...new Set(pool.map(m => m.mode))];
  const maps = [...new Set(pool.map(m => m.map))].sort((x, y) => mapName(x).localeCompare(mapName(y)));
  if (c.map !== 'all' && !maps.includes(c.map)) c.map = 'all';
  const both = B ? new Set(A.matches.filter(m => B.matches.some(n => n.id === m.id)).map(m => m.id)) : null;
  const ids = c.together && both ? both : null;
  const la = cmpFilter(A.matches, ids), lb = B ? cmpFilter(B.matches, ids) : [];
  const filterMenu = (key, options) => cmpMenu({ value: c[key], search: key === 'map' && options.length > 10, noun: key === 'map' ? 'maps' : 'options', items: options.map(([value, label]) => ({ value, label, icon: () => cmpFilterIcon(key, value) })), onpick: v => { c[key] = v; renderCompare(); } });
  const filters = h('div', { class: 'cmp-filters', title: 'Only matches from your own demos count' },
    modes.length > 1 ? filterMenu('mode', [['all', 'All modes'], ...modes.map(m => [m, m])]) : null,
    maps.length > 1 ? filterMenu('map', [['all', 'All maps'], ...maps.map(m => [m, mapName(m)])]) : null,
    filterMenu('period', PERIODS),
    both ? toggle(`Only your ${both.size} shared match${both.size === 1 ? '' : 'es'}`, c.together, v => { c.together = v; renderCompare(); }, 'Only matches both players were in: same lobbies, a fairer comparison') : null);

  // ---- the lobby: per stat, every player-match value (10+ rounds) under the same filters
  const lobbyRows = [];
  for (const m of lobby?.matches || []) {
    if ((c.mode !== 'all' && m.mode !== c.mode) || (c.map !== 'all' && m.map !== c.map)) continue;
    if (/d$/.test(c.period) && m.date < Date.now() - parseInt(c.period, 10) * 864e5) continue;
    for (const r of m.rows) if (r[1] >= 10) lobbyRows.push(r);
  }
  const dist = new Map(CMP_STATS.map(s => [s, s.r ? lobbyRows.map(s.r).filter(v => v != null && Number.isFinite(v)).sort((x, y) => x - y) : []]));

  const ta = aggregate(la), tb = B ? aggregate(lb) : null;
  const da = deathTotals(la), db = B ? deathTotals(lb) : null;
  const aa = aimValues(la.filter(m => m.aim).map(m => m.aim)), ab = B ? aimValues(lb.filter(m => m.aim).map(m => m.aim)) : null;
  const median = arr => (arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null);

  const nameA = A.name || 'You', nameB = B ? B.name || 'Player' : 'Your lobbies';
  let winsA = 0, winsB = 0, counted = 0;
  const tallies = new Map();
  const glyph = paths => icon(paths, 'aria-hidden="true"');
  const line = (s, va, vb, ra, rb, tip) => {
    const fmt = v => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(s.d)}${s.u || ''}`);
    let win = null;
    if (!s.neutral && va != null && vb != null && Math.abs(va - vb) >= 10 ** -s.d / 2) { win = (va > vb) !== !!s.low ? 'a' : 'b'; counted++; win === 'a' ? winsA++ : winsB++;
      const tally = tallies.get(s.g) || [0, 0]; tally[win === 'a' ? 0 : 1]++; tallies.set(s.g, tally);
    }
    // Bars: rank among the lobby when known, else the two values against each other (the better one full).
    const best = s.low ? Math.min(va ?? Infinity, vb ?? Infinity) : Math.max(va ?? 0, vb ?? 0);
    const rel = v => (v == null || !best ? 0 : s.low ? best / Math.max(v, 1e-9) : v / best);
    const wa = ra != null ? ra : rel(va), wb = rb != null ? rb : rel(vb);
    const tier = r => {
      if (r == null || !Number.isFinite(r)) return null;
      const n = Math.round(r * 100), hot = r >= 0.9, good = r >= 0.6, bad = r <= 0.25;
      return h('span', { class: `cmp-tier ${hot || good ? 'high' : bad ? 'low' : ''}`, title: `Better than ${r * 100}% of your lobbies${s.g === 'Aim' ? ' (estimated from quartiles)' : ''}` },
        hot || good || bad ? glyph(hot ? CMP_ICONS.flame : good ? CMP_ICONS.up : CMP_ICONS.down) : null,
        `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'} percentile`);
    };
    const value = (side, v, r) => h('div', { class: `cmp-v ${side} ${win === side ? 'win' : ''}` },
      h('b', {}, win === side ? glyph(ICONS.check) : null, fmt(v)),
      h('div', { class: 'cmp-sub' },
        win === side ? h('span', { class: 'cmp-delta', title: `${fmt(Math.abs(va - vb))} better than the other side${s.low ? ' (lower is better)' : ''}` }, `${Math.abs(va - vb).toFixed(s.d)}${s.u === '%' ? ' pp' : s.u || ''} ${s.low ? 'lower' : 'higher'}`) : null,
        tier(r)));
    const track = (side, w, r) => h('div', { class: `cmp-bar ${side}`, style: va == null || vb == null ? { visibility: 'hidden' } : undefined }, // no counterpart, no comparison bar
      h('i', { class: win === side ? 'win' : '', style: { width: `${clamp(w || 0, 0, 1) * 100}%` } }),
      r != null ? h('span', { class: 'cmp-median', title: 'Lobby median (50%)' }) : null);
    return h('div', { class: `cmp-row ${s.neutral ? 'neutral' : ''}`, title: tip || s.tip || '' },
      value('a', va, ra), track('a', wa, ra),
      h('div', { class: 'cmp-label' }, h('span', { class: 'cmp-stat-icon' }, glyph(s.icon || CMP_GROUP_ICONS[s.g])), h('span', {}, s.label),
        s.low ? h('span', { class: 'cmp-lower', title: 'Lower is better', 'aria-label': 'Lower is better' }, glyph(CMP_ICONS.down)) : null),
      track('b', wb, rb), value('b', vb, B ? rb : null)); // the lobby median is the 50th percentile by definition
  };

  const groups = new Map();
  const add = (g, el) => (groups.get(g) || groups.set(g, []).get(g)).push(el);
  for (const s of CMP_STATS) {
    const sorted = dist.get(s);
    const va = s.t(ta, da);
    const vb = B ? s.t(tb, db) : median(sorted);
    const ra = sorted.length >= 20 && !s.neutral ? rankIn(sorted, va, s.low) : null;
    const rb = sorted.length >= 20 && !s.neutral ? (B ? rankIn(sorted, vb, s.low) : 0.5) : null;
    if (va == null && vb == null) continue;
    add(s.g, line(s, va, vb, ra, rb, s.r ? `${s.tip ? s.tip + '\n' : ''}Bars: how many of the ${sorted.length} player-matches in your demos each value beats.` : s.tip));
  }
  for (const s of AIM_STATS) {
    const [va, na] = aa[s.k], [vb, nb] = ab ? ab[s.k] : [s.low ? (s.good + s.bad) / 2 : (s.good + s.bad) / 2, s.min];
    const okA = va != null && na >= s.min, okB = vb != null && nb >= s.min;
    if (!okA && !okB) continue;
    const def = { g: 'Aim', icon: CMP_ICONS.target, label: s.label, d: /timeToDamage/.test(s.k) ? 0 : /crosshair/.test(s.k) ? 1 : 0, u: /timeToDamage/.test(s.k) ? ' ms' : /crosshair/.test(s.k) ? '°' : '%', low: !!s.low };
    const scale = v => (v == null ? null : def.u === '%' ? v * 100 : v);
    add('Aim', line(def, okA ? scale(va) : null, okB ? scale(vb) : null, okA ? aimRank(s, va) : null, okB ? (B ? aimRank(s, vb) : 0.5) : null,
      `${s.tip}\nBars: rough rank among your lobbies, from their quartiles (measured matches only).`));
  }

  const who = (p, list, id, lead, pick) => h('div', { class: `cmp-who ${lead ? 'leading' : ''}` },
    h('span', { class: 'cmp-avatar' }, p ? avatar(p.name, id, 'large') : h('span', { class: 'avatar large lobby-avatar' }, glyph(CMP_ICONS.chart)),
      lead ? h('span', { class: 'cmp-crown', title: 'Ahead in more stats' }, glyph(CMP_ICONS.trophy)) : null),
    h('div', { class: 'cmp-identity' }, pick,
      h('div', { class: 'cmp-meta' }, p ? [
        h('span', {}, glyph(CMP_ICONS.matches), `${list.length} match${list.length === 1 ? '' : 'es'}`),
        h('span', {}, glyph(CMP_ICONS.clock), `${fmtNum(aggregate(list).rounds)} rounds`),
      ] : h('span', {}, glyph(CMP_ICONS.matches), `median of ${fmtNum(lobbyRows.length)} player-matches`)),
      p && id !== me ? h('button', { class: 'link-btn', onclick: () => openPlayer(id) }, 'Their overview \u2192') : null));

  const empty = !la.length || (B && !lb.length);
  page(
    h('div', { class: 'cmp-heads' }, filters, who(A, la, aId, winsA > winsB, pickA), h('div', { class: 'cmp-score', title: 'Stats where each side is better (roles like “Opening duels taken” don’t count)' },
      glyph(CMP_ICONS.trophy),
      h('div', { class: 'cmp-nums' }, counted ? [h('b', { class: winsA > winsB ? 'cmp-ahead' : '' }, winsA), h('span', {}, '–'), h('b', { class: winsB > winsA ? 'cmp-ahead' : '' }, winsB)] : '—'),
      h('small', {}, counted ? 'metrics ahead' : ''),
      h('div', { class: 'cmp-split', 'aria-hidden': 'true' }, h('i', { style: { width: `${counted ? winsA / counted * 100 : 50}%` } }), h('i', { style: { width: `${counted ? winsB / counted * 100 : 50}%` } })),
      swap), who(B, lb, c.b, winsB > winsA, pickB)),
    !lobby ? h('div', { class: 'hint' }, spinner(10), ' Reading everyone’s numbers in your demos (only the first time takes a few seconds)…') : null,
    lobby?.pending ? h('div', { class: 'hint' }, `${lobby.pending} demo${lobby.pending > 1 ? 's are' : ' is'} not read yet and not in the lobby numbers.`) : null,
    !empty ? h('div', { class: 'cmp-key' }, h('span', {}, 'Bars: percentile within your lobbies'), h('span', {}, h('i', { class: 'cmp-key-median' }), 'lobby median'), h('span', {}, glyph(CMP_ICONS.down), 'lower is better')) : null,
    empty ? h('div', { class: 'empty' }, h('h2', {}, 'No matches for these filters'), h('div', {}, 'Pick another period, map or mode.'))
      : h('div', { class: 'cmp-groups' }, ...[...groups].map(([g, rows]) => {
        const [a, b] = tallies.get(g) || [0, 0];
        return h('section', { class: 'dcard cmp-group' }, h('div', { class: 'dcard-head' },
          h('div', { class: 'cmp-group-heading' }, h('span', { class: 'cmp-group-icon' }, glyph(CMP_GROUP_ICONS[g])), h('h4', {}, g)),
          h('span', { class: `cmp-tally ${a > b ? 'a' : b > a ? 'b' : ''}`, title: `${nameA}: ${a} \u00b7 ${nameB}: ${b} stats ahead` }, glyph(CMP_ICONS.trophy), `${a}\u2013${b}`)), ...rows);
      })),
  );
}

function compareWith(steamid) {
  state.cmp.a = null;
  state.cmp.b = steamid || 'lobby';
  showView('compare');
}


// ---------- New matches processed in the background ----------
const autoChip = h('div', { class: 'auto-chip hidden', title: 'A new match is being read and measured in the background' });
document.querySelector('.me-wrap')?.before(autoChip);
function showAuto(st) {
  const r = st?.running;
  autoChip.classList.toggle('hidden', !r && !st?.waiting);
  autoChip.replaceChildren(spinner(11), h('span', {}, r ? (r.step === 'measuring' ? 'Measuring new match…' : 'Reading new match…') : 'New match queued…'),
    st?.waiting > 1 ? h('span', { class: 'tab-count' }, st.waiting) : null);
}
api.onAuto(showAuto);
api.autoStatus().then(showAuto).catch(() => {});

function openAutoMatch(r) {
  const go = () => {
    const d = state.demos.find(x => x.path === r.path) || state.demos.find(x => x.id === r.id);
    if (!d) return false;
    showView('matches');
    openDemo(d, undefined, 'scoreboard');
    return true;
  };
  if (!go()) loadDemos().then(go);
}
api.onAutoDone(r => {
  loadDemos();
  // The Compare page's players and lobby numbers now miss this match: read again next time.
  Object.assign(state.cmp, { players: null, lobby: null, lobbyAsked: false });
  state.cmp.profiles.clear();
  const sm = r.summary;
  const text = sm
    ? `${mapName(r.map)} ${sm.score[0]}:${sm.score[1]} — ${sm.kills}–${sm.deaths}${sm.rating != null ? `, rating ${sm.rating.toFixed(2)}` : ''}${r.highlights ? `, ${r.highlights} highlight${r.highlights > 1 ? 's' : ''}` : ''}`
    : `New demo read: ${mapName(r.map)}`;
  const t = h('div', { class: 'toast ok auto-toast' }, h('span', {}, text), h('button', { class: 'btn', onclick: () => { t.remove(); openAutoMatch(r); } }, 'Open'));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 12000);
});
api.onAutoOpen(openAutoMatch);

function autoProcessCard() {
  const a = state.settings.autoProcess;
  return h('div', { class: 'card' },
    h('h3', {}, 'New matches'),
    h('div', { class: 'desc' }, 'A demo that arrives while DemoLab is open (from the Downloads tab, CS2 or a copy into a demo folder), or since it was last open, is read straight away. While CS2 is running this runs at low priority on fewer cores.'),
    row('Read new matches', toggle('Automatically', a.enabled, v => save({ autoProcess: { enabled: v } })), 'Stats, highlights and the death review are ready when you open it.'),
    row('Measure them too', toggle('Measure', a.measure, v => save({ autoProcess: { measure: v } })), 'Also the tick pass behind the Aim and Integrity tabs (about 10 s per match).'),
    row('Notification', toggle('Windows notification', a.notify, v => save({ autoProcess: { notify: v } })), 'Score, your K–D and rating, highlights to clip and your most common death mistake. Click it to open the match.'));
}

// ---------- Utility share codes ----------
function lineupShareDialog(list) {
  const picked = new Set(list.map(x => x.id));
  let type = 'all', side = 'all';
  const rows = h('div', { class: 'import-list' }), count = h('span', { class: 'hint' });
  const copy = h('button', { class: 'btn primary', onclick: async () => {
    copy.disabled = true;
    try { if (await shareLineups(list.filter(x => picked.has(x.id)))) closeModal(); }
    finally { paint(); }
  } }, 'Copy code');
  const visible = () => list.filter(x => (type === 'all' || x.type === type) && (side === 'all' || x.side === side));
  const paint = () => {
    count.textContent = `${picked.size} of ${list.length} selected`;
    copy.disabled = !picked.size;
    rows.replaceChildren(...visible().map(x => h('label', { class: 'import-item' },
      h('input', { type: 'checkbox', checked: picked.has(x.id), onchange: e => { if (e.target.checked) picked.add(x.id); else picked.delete(x.id); paint(); } }),
      h('span', { class: 'import-t' }, h('b', {}, x.name), h('span', { class: 'ut-sub' }, `${utLabel(UT_TYPES, x.type)} / ${x.side}`)))));
  };
  modal([
    h('h2', {}, 'Share lineups'),
    h('div', { class: 'actions' },
      select(type, [['all', 'All grenades'], ...UT_TYPES.filter(([v]) => v !== 'all')], v => { type = v; paint(); }, { seg: false, icon: v => v === 'all' ? pickSvg(PICK_ICONS.layers) : pickWeapon({ smoke: 'smokegrenade', flash: 'flashbang', molotov: 'molotov', he: 'hegrenade' }[v]) }),
      select(side, [['all', 'All sides'], ['T', 'T'], ['CT', 'CT'], ['both', 'Both sides']], v => { side = v; paint(); }, { seg: true, icon: sideIcon }),
      h('button', { class: 'btn', onclick: () => { visible().forEach(x => picked.add(x.id)); paint(); } }, 'Select all'),
      h('button', { class: 'btn', onclick: () => { visible().forEach(x => picked.delete(x.id)); paint(); } }, 'Select none')),
    count, rows,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'), copy),
  ]);
  paint();
}

async function shareLineups(list) {
  if (!list.length) return;
  const result = await guard(() => api.utilityCode(list.map(x => x.id)));
  if (!result) return;
  const { code, missingImages } = result;
  const warning = missingImages ? ` ${missingImages} pictures could not be uploaded.` : '';
  if (!await guard(async () => { await copyText(code); return true; })) return;
  const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} lineups`;
  toast((code.startsWith('DLU2-')
    ? `${what} copied as the code ${code}. Your friend pastes it in Utility → Import code.`
    : `${what} copied as a long code (${fmtNum(code.length)} characters: catbox.moe did not answer, so no short one). Your friend pastes it in Utility → Import code.`) + warning, 'ok');
  return true;
}

async function importDialog(prefill = '') {
  if (!prefill) { try { const t = await navigator.clipboard.readText(); if (/DLU[12]-/.test(t)) prefill = t; } catch {} }
  const area = h('textarea', { class: 'code-area mono', placeholder: 'Paste one or more DLU2-… codes here', spellcheck: 'false' }, prefill);
  const err = h('div', {});
  const read = async () => {
    err.replaceChildren();
    let list;
    try { list = await api.utilityReadCode(area.value); } catch (e) { err.replaceChildren(h('div', { class: 'err-box' }, e.message)); return; }
    preview(list);
  };
  modal([
    h('h2', {}, 'Import lineups'),
    h('p', { class: 'hint' }, 'Lineup codes hold the spot, aim, technique, flight, notes and backed-up pictures. Get one with the Share button on a lineup.'),
    area, err,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'), h('button', { class: 'btn primary', onclick: read }, 'Read code')),
  ]);
  area.focus();
  if (prefill) read();

  function preview(list) {
    const pick = list.map(x => !x.dupe);
    const go = h('button', { class: 'btn primary' });
    const label = () => { const n = pick.filter(Boolean).length; go.textContent = n ? `Import ${n} lineup${n > 1 ? 's' : ''}` : 'Nothing to import'; go.disabled = !n; };
    go.onclick = async () => {
      const n = await guard(() => api.utilityImport(list.filter((_, i) => pick[i])));
      if (n === undefined) return;
      closeModal();
      toast(`${n} lineup${n === 1 ? '' : 's'} added to Utility.`, 'ok');
      const first = list.find((x, i) => pick[i]);
      if (first) { state.ut.map = first.map; state.ut.sel = null; }
      await loadUtility();
      showView('utility');
    };
    label();
    modal([
      h('h2', {}, `${list.length} lineup${list.length > 1 ? 's' : ''} in this code`),
      h('div', { class: 'import-list' }, ...list.map((x, i) => h('label', { class: `import-item ${x.dupe ? 'dupe' : ''}`, style: { '--c': NADE_COLOR[x.type] } },
        h('input', { type: 'checkbox', checked: pick[i], onchange: e => { pick[i] = e.target.checked; label(); } }),
        x.pictures?.[0] ? h('img', { src: `https://qu.ax/x/${x.pictures[0].slice(2)}`, style: { width: '72px', height: '44px', objectFit: 'cover' } }) : h('span', { class: 'ut-dot' }),
        h('span', { class: 'import-t' }, h('b', {}, x.name), h('span', { class: 'ut-sub' }, [mapName(x.map), utLabel(UT_TYPES, x.type), x.side !== 'both' ? x.side : 'both sides', x.from ? null : 'no throw spot'].filter(Boolean).join(' · '))),
        x.dupe ? h('span', { class: 'pill' }, 'Already saved') : null))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => importDialog(area.value) }, 'Back'), go),
    ]);
  }
}
