/* global $, api, state, h, icon, ICONS, toast, guard, mapName, fmtDate, fmtDur, clamp, pct, fmtNum, spinner, card, barList, big, select, toggle,
   modal, closeModal, renderDetail, showInReplay, viewInCs2Button, openDemo, showView, loadDemos, loadUtility, renderUtility, utFiltered,
   copyText, mapThumb, avatar, aggregate, per, PERIODS, shownProfile, povId, placeLabel, AIM_STATS, aimValues, aimLevel, ratingClass, row, save,
   NADE_COLOR, utLabel, UT_TYPES, renderOverview, openPlayer, ago */
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
        h('span', { class: `side-${x.side}` }, x.side), ' · killed by ', h('b', {}, x.killerName || '?'),
        ` with the ${x.weapon}`, x.headshot ? ' (headshot)' : '', x.wallbang ? ' · wallbang' : '', x.smoke ? ' · through smoke' : '',
        x.place ? ` · ${placeLabel(x.place)}` : ''),
      h('div', { class: 'death-tags' },
        ...DEATH_ORDER.filter(t => x.tags.includes(t)).map(t => deathPill(t, x)),
        x.traded ? h('span', { class: 'dtag good', title: 'A teammate killed your killer within 5 seconds' }, `Traded by ${x.traded.by}`, h('small', {}, `${x.traded.after} s later`)) : null,
        !x.tags.some(t => DEATH_TAGS[t]?.kind === 'bad') && !x.traded ? h('span', { class: 'dtag', title: 'None of the usual mistakes' }, 'Nothing to blame') : null)),
    h('div', { class: 'integ-actions' },
      h('button', { class: 'btn', title: 'The last seconds before this death in the 2D replay', onclick: onReplay || (() => showInReplay(steamid, x.tick - 5 * 64)) }, '2D replay'),
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
      h('span', { class: 'hint' }, `${bad} of ${v.deaths.length} deaths had something to fix. Hover a tag for what it means.`)),
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

function deathCards(list) {
  const p = shownProfile();
  const t = deathTotals(list);
  const missing = list.length - t.matches;
  if (!t.matches) {
    return [card(null, h('div', { class: 'muted-note' }, missing && p?.positionsPending !== 0 ? [spinner(11), ' Reading where everyone stood at each kill, match by match…'] : 'No deaths to review yet.'), { span: 4 })];
  }
  const rows = kind => DEATH_ORDER.filter(k => DEATH_TAGS[k].kind === kind && deathShare(t, k) != null && (kind === 'bad' || t.tags[k])).map(k => {
    const share = deathShare(t, k), of = MEASURED_ONLY.has(k) ? t.measuredN : t.n;
    return { label: DEATH_TAGS[k].label, note: `${t.tags[k] || 0}/${of}`, value: `${Math.round(share * 100)}%`, frac: share, fillCls: kind === 'bad' ? 'bad' : '',
      title: `${DEATH_TAGS[k].tip}\n\nClick to see these deaths`, onclick: () => deathsModal(k, list) };
  }).sort((a, b) => b.frac - a.frac);
  const bad = rows('bad');
  const top = bad[0];
  const foot = [
    missing ? h('div', { class: 'hint' }, spinner(10), ` ${missing} more match${missing > 1 ? 'es' : ''} still being read`) : null,
    t.measuredN < t.n ? h('div', { class: 'hint' }, `“Caught off guard” only counts the ${t.measuredN} deaths of measured matches (see Aim above).`) : null,
  ];
  return [
    card('Death review', [
      top ? big(top.value, null, `of your deaths: ${top.label.toLowerCase()}`) : null,
      barList(bad), ...foot], { span: 2, extra: h('span', { class: 'hint' }, `${fmtNum(t.n)} deaths in ${t.matches} match${t.matches > 1 ? 'es' : ''}`) }),
    card('How the fights went', [barList(rows('info'), { empty: 'Nothing yet' }),
      h('div', { class: 'card-link' }, h('button', { class: 'link-btn', onclick: () => deathsModal('all', list) }, 'All deaths →'))], { span: 2 }),
  ];
}

// Every death with one tag over the overview's matches, newest first; each opens in its match's 2D replay.
async function deathsModal(tag, list) {
  const who = state.who || undefined;
  const ids = new Set(list.map(m => m.id));
  modal([h('h2', {}, 'Loading…'), spinner(24)], { wide: true });
  const all = await api.deathsAll(who).catch(e => ({ error: e.message, matches: [] }));
  if (all.error) return modal([h('h2', {}, 'Could not load the deaths'), h('div', { class: 'err-box' }, all.error), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'))]);
  const matches = all.matches.filter(m => ids.has(m.id));
  let current = tag;
  const name = shownProfile()?.name || 'You';
  const show = () => {
    const rows = [];
    for (const m of matches) for (const x of m.deaths) if (current === 'all' || x.tags.includes(current)) rows.push([m, x]);
    const shown = rows.slice(0, 80);
    const open = (m, x) => {
      const d = state.demos.find(y => y.id === m.id) || state.demos.find(y => y.path === m.path);
      if (!d) return toast('This demo is no longer in your demo folders.', 'error');
      closeModal();
      state.radar.jump = x.tick - 5 * 64;
      showView('matches');
      openDemo(d, who, 'radar');
    };
    modal([
      h('div', { class: 'section-head' }, h('h2', {}, current === 'all' ? `All deaths · ${name}` : `${DEATH_TAGS[current].label} · ${name}`), h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, `${rows.length} death${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? `, newest ${shown.length} shown` : ''}`)),
      current !== 'all' ? h('p', { class: 'hint' }, DEATH_TAGS[current].tip) : null,
      deathChips(matches.flatMap(m => m.deaths), current, k => { current = k; show(); }),
      h('div', { class: 'integ-moments death-modal-list' }, ...shown.map(([m, x]) => deathRow(x, {
        name, cs2: false, onReplay: () => open(m, x),
        extra: h('div', { class: 'death-match' }, mapThumb(m.map), h('b', {}, mapName(m.map)), h('span', { class: `hp-res r-${m.result}` }, h('i', {}, m.result), `${m.score[0]}:${m.score[1]}`), h('span', { class: 'hint' }, ago(m.date))),
      }))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close')),
    ], { wide: true });
  };
  show();
}

// ---------- Compare ----------
// Two players side by side over the same filters (or one against "your lobbies": every player of every
// demo you have). Bars show where each value ranks among your lobbies' player-matches.
state.cmp = { a: null, b: 'lobby', mode: 'all', map: 'all', period: 'all', together: false, profiles: new Map(), lobby: null, lobbyAsked: false, players: null };

const sumMulti = m => Object.values(m || {}).reduce((a, b) => a + b, 0);
const CMP_STATS = [
  { g: 'Overall', label: 'Rating ≈ HLTV 2.0', d: 2, t: t => t.rating, r: r => r[2] },
  { g: 'Overall', label: 'Win rate', u: '%', d: 0, t: t => per(100 * t.won, t.played), r: null },
  { g: 'Overall', label: 'K/D', d: 2, t: t => t.kd, r: r => (r[4] ? r[3] / r[4] : r[3]) },
  { g: 'Overall', label: 'ADR', d: 1, t: t => t.adr, r: r => r[6] / r[1] },
  { g: 'Overall', label: 'KAST', u: '%', d: 1, t: t => per(100 * t.kastRounds, t.rounds), r: r => 100 * r[7] / r[1] },
  { g: 'Overall', label: 'Headshot %', u: '%', d: 1, t: t => per(100 * t.hs, t.kills), r: r => (r[3] ? 100 * r[8] / r[3] : null) },
  { g: 'Duels', label: 'Kills / round', d: 2, t: t => per(t.kills, t.rounds), r: r => r[3] / r[1] },
  { g: 'Duels', label: 'Deaths / round', d: 2, low: true, t: t => per(t.deaths, t.rounds), r: r => r[4] / r[1] },
  { g: 'Duels', label: 'Opening duels won', u: '%', d: 0, t: t => per(100 * t.fk, t.fk + t.fd), r: r => (r[9] + r[10] ? 100 * r[9] / (r[9] + r[10]) : null) },
  { g: 'Duels', label: 'Opening duels taken', u: '%', d: 0, neutral: true, tip: 'Rounds where they were in the first duel: a role, not better or worse.', t: t => per(100 * (t.fk + t.fd), t.rounds), r: r => 100 * (r[9] + r[10]) / r[1] },
  { g: 'Duels', label: 'Trade kills / round', d: 2, t: t => per(t.trades, t.rounds), r: r => r[11] / r[1] },
  { g: 'Duels', label: 'Multi-kill rounds', u: '%', d: 1, t: t => per(100 * sumMulti(t.multi), t.rounds), r: r => 100 * r[14] / r[1] },
  { g: 'Duels', label: 'Clutches won', u: '%', d: 0, t: t => per(100 * t.clutchWon, t.clutchPlayed), r: r => (r[16] ? 100 * r[15] / r[16] : null) },
  { g: 'Utility', label: 'Utility damage / round', d: 1, t: t => per(t.utility, t.rounds), r: r => r[12] / r[1] },
  { g: 'Utility', label: 'Enemies flashed / round', d: 2, t: t => per(t.flashed, t.rounds), r: r => r[13] / r[1] },
  ...['alone', 'untraded', 'nades', 'dry', 'lowhp', 'caught'].map(k => ({
    g: 'Deaths', label: DEATH_TAGS[k].label, u: '%', d: 0, low: true, tip: `${DEATH_TAGS[k].tip}\nShare of their deaths.`,
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

function renderCompare() {
  const view = $('#view-compare');
  const c = state.cmp, env = state.env;
  const me = env?.mySteamId;
  const aId = c.a || me;
  const page = (...body) => view.replaceChildren(h('div', { class: 'page cmp-page' }, ...body));
  if (!me && !c.a) return page(h('div', { class: 'empty' }, h('h2', {}, 'Which player are you?'), h('div', {}, 'Set your SteamID in Settings first.')));
  if (!c.players) {
    api.players().then(p => { c.players = p; }).catch(() => { c.players = { self: me, players: [] }; }).finally(() => { if (state.view === 'compare') renderCompare(); });
    return page(h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Loading players…')));
  }
  const A = cmpProfileOf(aId);
  const B = c.b === 'lobby' ? null : cmpProfileOf(c.b);
  const lobby = cmpLobby();

  // ---- pickers
  const known = c.players.players.filter(p => p.steamid !== c.players.self).sort((x, y) => (y.with + y.against) - (x.with + x.against) || y.matches - x.matches);
  const opts = (cur, extra) => {
    const list = known.slice(0, 80);
    if (cur && cur !== 'lobby' && cur !== me && !list.some(p => p.steamid === cur)) { const p = known.find(x => x.steamid === cur); if (p) list.unshift(p); }
    return [...extra, ...list.map(p => [p.steamid, `${p.name || p.steamid} · ${p.with ? `${p.with} with you` : ''}${p.with && p.against ? ', ' : ''}${p.against ? `${p.against} against` : ''}`])];
  };
  const pickA = select(aId, opts(aId, [[me, `${env?.steamUser?.name || 'You'} (you)`]]), v => { c.a = v === me ? null : v; renderCompare(); });
  const pickB = select(c.b, opts(c.b, [['lobby', 'Your lobbies (the median player)'], ...(aId !== me ? [[me, `${env?.steamUser?.name || 'You'} (you)`]] : [])]), v => { c.b = v; renderCompare(); });
  const swap = c.b !== 'lobby' ? h('button', { class: 'icon-btn', title: 'Swap sides', onclick: () => { const a = aId; c.a = c.b === me ? null : c.b; c.b = a; renderCompare(); } }, '⇄') : null;

  const head = h('div', { class: 'page-head' }, h('h2', {}, 'Compare'),
    h('span', { class: 'dl-head-info' }, 'Two players side by side, or one against everyone in your demos. Only matches from your own demos count.'));
  if (!A || (c.b !== 'lobby' && !B)) return page(head, h('div', { class: 'cmp-pickers' }, pickA, swap, pickB), h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Loading stats…')));

  // ---- filters (modes and maps of both players)
  const pool = [...A.matches, ...(B?.matches || [])];
  const modes = [...new Set(pool.map(m => m.mode))];
  const maps = [...new Set(pool.map(m => m.map))].sort((x, y) => mapName(x).localeCompare(mapName(y)));
  if (c.map !== 'all' && !maps.includes(c.map)) c.map = 'all';
  const both = B ? new Set(A.matches.filter(m => B.matches.some(n => n.id === m.id)).map(m => m.id)) : null;
  const ids = c.together && both ? both : null;
  const la = cmpFilter(A.matches, ids), lb = B ? cmpFilter(B.matches, ids) : [];
  const filters = h('div', { class: 'filters' },
    modes.length > 1 ? select(c.mode, [['all', 'All modes'], ...modes.map(m => [m, m])], v => { c.mode = v; renderCompare(); }) : null,
    select(c.map, [['all', 'All maps'], ...maps.map(m => [m, mapName(m)])], v => { c.map = v; renderCompare(); }),
    select(c.period, PERIODS, v => { c.period = v; renderCompare(); }),
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
  const line = (s, va, vb, ra, rb, tip) => {
    const fmt = v => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(s.d)}${s.u || ''}`);
    let win = null;
    if (!s.neutral && va != null && vb != null && Math.abs(va - vb) >= 10 ** -s.d / 2) { win = (va > vb) !== !!s.low ? 'a' : 'b'; counted++; win === 'a' ? winsA++ : winsB++; }
    // Bars: rank among the lobby when known, else the two values against each other (the better one full).
    const best = s.low ? Math.min(va ?? Infinity, vb ?? Infinity) : Math.max(va ?? 0, vb ?? 0);
    const rel = v => (v == null || !best ? 0 : s.low ? best / Math.max(v, 1e-9) : v / best);
    const wa = ra != null ? ra : rel(va), wb = rb != null ? rb : rel(vb);
    const rankTxt = r => (r == null ? '' : `better than ${Math.round(r * 100)}%`);
    return h('div', { class: `cmp-row ${s.neutral ? 'neutral' : ''}`, title: tip || s.tip || '' },
      h('div', { class: `cmp-v a ${win === 'a' ? 'win' : ''}` }, h('b', {}, fmt(va)), h('small', {}, rankTxt(ra))),
      h('div', { class: 'cmp-bar a' }, h('i', { class: win === 'a' ? 'win' : '', style: { width: `${clamp(wa || 0, 0, 1) * 100}%` } })),
      h('div', { class: 'cmp-label' }, s.label, s.low ? h('small', {}, 'lower is better') : null),
      h('div', { class: 'cmp-bar b' }, h('i', { class: win === 'b' ? 'win' : '', style: { width: `${clamp(wb || 0, 0, 1) * 100}%` } })),
      h('div', { class: `cmp-v b ${win === 'b' ? 'win' : ''}` }, h('b', {}, fmt(vb)), h('small', {}, rankTxt(rb))));
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
    const def = { label: s.label, d: /timeToDamage/.test(s.k) ? 0 : /crosshair/.test(s.k) ? 1 : 0, u: /timeToDamage/.test(s.k) ? ' ms' : /crosshair/.test(s.k) ? '°' : '%', low: !!s.low };
    const scale = v => (v == null ? null : def.u === '%' ? v * 100 : v);
    add('Aim', line(def, okA ? scale(va) : null, okB ? scale(vb) : null, okA ? aimRank(s, va) : null, okB ? (B ? aimRank(s, vb) : 0.5) : null,
      `${s.tip}\nBars: rough rank among your lobbies, from their quartiles (measured matches only).`));
  }

  const who = (p, list, id) => h('div', { class: 'cmp-who' },
    p ? avatar(p.name, id, 'large') : h('span', { class: 'avatar large lobby-avatar' }, '∑'),
    h('div', {}, h('div', { class: 'cmp-name' }, p ? p.name || id : 'Your lobbies'),
      h('div', { class: 'hint' }, p ? `${list.length} match${list.length === 1 ? '' : 'es'} · ${fmtNum(aggregate(list).rounds)} rounds` : `median of ${fmtNum(lobbyRows.length)} player-matches`),
      p && id !== me ? h('button', { class: 'link-btn', onclick: () => openPlayer(id) }, 'Their overview →') : null));

  const empty = !la.length || (B && !lb.length);
  page(head,
    h('div', { class: 'cmp-pickers' }, pickA, swap, h('span', { class: 'cmp-vs' }, 'vs'), pickB, h('span', { class: 'spacer' }), filters),
    h('div', { class: 'cmp-heads' }, who(A, la, aId), h('div', { class: 'cmp-score', title: 'Stats where each side is better (roles like “Opening duels taken” don’t count)' },
      h('div', { class: 'cmp-nums' }, counted ? [h('b', { class: winsA >= winsB ? 'good' : '' }, winsA), h('span', {}, '–'), h('b', { class: winsB > winsA ? 'good' : '' }, winsB)] : '—'),
      h('small', {}, counted ? 'stats ahead' : '')), who(B, lb, c.b)),
    !lobby ? h('div', { class: 'hint' }, spinner(10), ' Reading everyone’s numbers in your demos (only the first time takes a few seconds)…') : null,
    lobby?.pending ? h('div', { class: 'hint' }, `${lobby.pending} demo${lobby.pending > 1 ? 's are' : ' is'} not read yet and not in the lobby numbers.`) : null,
    empty ? h('div', { class: 'empty' }, h('h2', {}, 'No matches for these filters'), h('div', {}, 'Pick another period, map or mode.'))
      : h('div', { class: 'cmp-groups' }, ...[...groups].map(([g, rows]) => h('section', { class: 'dcard cmp-group' }, h('div', { class: 'dcard-head' }, h('h4', {}, g)), ...rows))),
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
async function shareLineups(list) {
  if (!list.length) return;
  const code = await guard(() => api.utilityCode(list.map(x => x.id)));
  if (!code) return;
  await copyText(code);
  toast(`${list.length === 1 ? `“${list[0].name}”` : `${list.length} lineups`} copied as a code (${fmtNum(code.length)} characters). Your friend pastes it in Utility → Import code.`, 'ok');
}

async function importDialog(prefill = '') {
  if (!prefill) { try { const t = await navigator.clipboard.readText(); if (/DLU1-/.test(t)) prefill = t; } catch {} }
  const area = h('textarea', { class: 'code-area mono', placeholder: 'Paste one or more DLU1-… codes here', spellcheck: 'false' }, prefill);
  const err = h('div', {});
  const read = async () => {
    err.replaceChildren();
    let list;
    try { list = await api.utilityReadCode(area.value); } catch (e) { err.replaceChildren(h('div', { class: 'err-box' }, e.message)); return; }
    preview(list);
  };
  modal([
    h('h2', {}, 'Import lineups'),
    h('p', { class: 'hint' }, 'Lineup codes hold the spot, aim, technique, flight and notes (no pictures). Get one with the Share button on a lineup.'),
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
        h('span', { class: 'ut-dot' }),
        h('span', { class: 'import-t' }, h('b', {}, x.name), h('span', { class: 'ut-sub' }, [mapName(x.map), utLabel(UT_TYPES, x.type), x.side !== 'both' ? x.side : 'both sides', x.from ? null : 'no throw spot'].filter(Boolean).join(' · '))),
        x.dupe ? h('span', { class: 'pill' }, 'Already saved') : null))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => importDialog(area.value) }, 'Back'), go),
    ]);
  }
}
