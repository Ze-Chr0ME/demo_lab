/* global api, state, h, icon, ICONS, toast, guard, mapName, fmtDate, fmtDur, clamp, pct, fmtNum, spinner, card, kv, barList, big,
   select, modal, closeModal, renderDetail, showInReplay, viewInCs2Button, statsPending, radarInfo, radarFrame, radarImage, toPx, viewPt, applyView,
   viewScale, zoomable, newView, resetZoom, RADAR_SIZE, NADE_COLOR, SMOKE_RADIUS, MOLOTOV_RADIUS, utLabel, UT_TYPES, UT_MOVES, UT_CLICKS, utImg,
   utMoved, renderUtility, onLower, loadProfile, reloadProfileSoon, renderOverview, shownProfile, renderClips, loadClips, playClip, utMapKey */
'use strict';
// Coaching views added on top of app.js: the round strip and Economy tab, the Aim tab and its overview
// section, where you play on each map, the Utility quiz with "Practice in CS2", and "Export for sharing".
// Loaded after app.js and uses its helpers.

// ---------- Rounds: strip under the match header, Economy tab ----------
state.rd = { data: null, loading: null };
const BUY_SHORT = { pistol: 'P', eco: 'E', force: 'F', full: 'B' };
const BUY_TIP = {
  pistol: 'Pistol round',
  eco: 'Eco: saving (average loadout under $2,000)',
  force: 'Force or half buy (average loadout $2,000 – $3,500)',
  full: 'Full buy (average loadout $3,500 or more)',
};
const REASON_ICON = {
  elim: '<path fill-rule="evenodd" fill="currentColor" d="M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4 2.5 5v3.5h9V15c1.3-1 2.5-2.6 2.5-5a7 7 0 0 0-7-7zM9.3 8.8a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0-3.4zM14.7 8.8a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0-3.4z"/>',
  bomb_exploded: '<circle cx="11" cy="14" r="6.5" fill="currentColor"/><path d="M15.5 9.5l2.5-2.5M18 3.5v2M21.5 7h-2M20.5 4.5l-1.3 1.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  bomb_defused: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  time_ran_out: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const reasonIcon = r => icon(REASON_ICON[r] || REASON_ICON.elim);
const money = v => `$${fmtNum(v || 0)}`;
const povId = () => state.analysis?.player?.steamid || '';
const placeLabel = p => (p || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ') || 'Unknown';

function roundsData() {
  const d = state.demo, key = `${d.id}|${povId()}`;
  if (state.rd.data?.key === key) return state.rd.data;
  if (state.rd.loading !== key) {
    state.rd.loading = key;
    api.rounds(d.path, povId() || undefined)
      .then(v => { state.rd.data = { key, value: v }; })
      .catch(e => { state.rd.data = { key, error: e.message }; })
      .finally(() => { if (state.rd.loading === key) state.rd.loading = null; if (state.demo?.id === d.id && state.view === 'matches') renderDetail(); });
  }
  return null;
}

const jumpToRound = r => showInReplay(povId(), r.freezeEndTick + 2 * 64);

function roundTip(v, r) {
  const me = v.myTeam, them = v.otherTeam;
  const tm = r.teams[me], to = r.teams[them];
  const lines = [
    `Round ${r.num} · ${r.score[me]} : ${r.score[them]}`,
    r.winner ? `${r.winner === me ? 'Won' : 'Lost'}: ${r.reasonText}${r.plant && r.reason !== 'bomb_exploded' && r.reason !== 'bomb_defused' ? ' (bomb planted)' : ''} · ${fmtDur(r.time)}` : 'No winner',
  ];
  if (tm.type) lines.push(`${v.teamNames[me]} (${tm.side}): ${v.labels[tm.type]} · ${money(tm.equip)}`, `${v.teamNames[them]} (${to.side}): ${v.labels[to.type]} · ${money(to.equip)}`);
  if (r.opening) lines.push(`Opening kill: ${r.opening.attackerName} → ${r.opening.victimName} (${r.opening.weapon})`);
  if (r.me) lines.push(`${state.analysis?.player?.name || 'You'}: ${r.me.kills} kill${r.me.kills === 1 ? '' : 's'}${r.me.died ? ', died' : ', survived'}`);
  lines.push('', 'Click to open this round in the 2D replay');
  return lines.join('\n');
}

// One cell per round: won or lost, how it ended, the point-of-view player's kills; halftime gap.
function roundStrip() {
  const st = roundsData();
  if (!st) return h('div', { class: 'round-strip loading' });
  if (st.error || !st.value.rounds.length) return null;
  const v = st.value;
  const cells = [];
  for (const r of v.rounds) {
    if (r.half) cells.push(h('div', { class: 'rs-half', title: 'Sides switch' }));
    const won = r.winner === v.myTeam;
    const tm = r.teams[v.myTeam];
    cells.push(h('button', { class: `rs-cell ${r.winner ? (won ? 'win' : 'loss') : ''} side-${r.winnerSide || ''}`, title: roundTip(v, r), onclick: () => jumpToRound(r) },
      h('span', { class: 'rs-n' }, r.num),
      h('span', { class: 'rs-ic' }, reasonIcon(r.reason)),
      h('span', { class: 'rs-pips' }, ...Array.from({ length: Math.min(5, r.me?.kills || 0) }, () => h('i', {}))),
      tm.type ? h('span', { class: `rs-buy buy-${tm.type}` }, BUY_SHORT[tm.type]) : null));
  }
  return h('div', { class: 'round-strip' },
    h('div', { class: 'rs-cells' }, ...cells),
    h('div', { class: 'rs-legend' },
      h('span', {}, h('i', { class: 'rs-key win' }), 'won'), h('span', {}, h('i', { class: 'rs-key loss' }), 'lost'),
      h('span', { class: 'rs-pips demo' }, h('i', {})), 'kills of the point-of-view player',
      h('span', { class: 'rs-letters' }, 'P pistol · E eco · F force · B full buy (your team)')));
}

function economyView() {
  const st = roundsData();
  if (!st) return h('div', { class: 'empty' }, spinner(24), h('h2', {}, 'Reading the money of every round…'));
  if (st.error) return h('div', { class: 'empty' }, h('h2', {}, 'No economy for this demo'), h('div', { class: 'err-box' }, st.error));
  const v = st.value;
  if (!v.hasEconomy) return h('div', { class: 'empty' }, h('h2', {}, 'No money data in this demo'), h('div', {}, 'The demo parser could not read the players’ money and loadouts.'));
  const me = v.myTeam, them = v.otherTeam, pov = povId();
  const name = state.analysis?.player?.name || 'You';

  // Loadout value per round: your team above the line, the opponents below.
  const W = 1000, H = 230, mid = H / 2, top = 14;
  const n = v.rounds.length, bw = (W - 40) / n;
  const max = Math.max(5000, ...v.rounds.flatMap(r => [r.teams[me].equip, r.teams[them].equip]));
  const y = val => (mid - top) * val / max;
  const bars = v.rounds.map((r, i) => {
    const x = 30 + i * bw + bw * 0.14, w = bw * 0.72;
    const a = r.teams[me], b = r.teams[them];
    const tip = (t, label) => `${label} · round ${r.num}: ${v.labels[t.type]} · ${money(t.equip)} loadout · ${money(t.money)} at the start`;
    return `<g class="eco-r" data-i="${i}">
      <rect x="${x}" y="${mid - y(a.equip)}" width="${w}" height="${y(a.equip)}" class="eb side-${a.side} buy-${a.type}"><title>${tip(a, v.teamNames[me])}</title></rect>
      <rect x="${x}" y="${mid}" width="${w}" height="${y(b.equip)}" class="eb side-${b.side} buy-${b.type}"><title>${tip(b, v.teamNames[them])}</title></rect>
      <circle cx="${x + w / 2}" cy="${r.winner === me ? 6 : H - 6}" r="3.6" class="${r.winner === me ? 'ew' : 'el'}"/>
      ${r.half ? `<line x1="${x - bw * 0.14}" x2="${x - bw * 0.14}" y1="0" y2="${H}" class="eh"/>` : ''}
      <text x="${x + w / 2}" y="${mid + 4}" class="en">${n <= 30 || r.num % 2 ? r.num : ''}</text></g>`;
  }).join('');
  const chart = h('div', { class: 'eco-chart', html: `<svg viewBox="0 0 ${W} ${H}">
    <text x="4" y="${top + 8}" class="et">${v.teamNames[me]}</text><text x="4" y="${H - 8}" class="et">${v.teamNames[them]}</text>
    <line x1="30" x2="${W - 10}" y1="${mid}" y2="${mid}" class="em"/>${bars}</svg>` });
  chart.addEventListener('click', e => { const g = e.target.closest('.eco-r'); if (g) jumpToRound(v.rounds[+g.dataset.i]); });

  const types = Object.keys(v.labels);
  const winRow = t => types.map(k => { const [w, p] = v.summary[t][k]; return { label: v.labels[k], note: `${w}/${p}`, value: p ? `${pct(w, p)}%` : '—', frac: p ? w / p : 0, fillCls: w / p >= 0.5 ? 'good' : 'bad' }; });
  const matrix = h('table', { class: 'sb eco-matrix' },
    h('thead', {}, h('tr', {}, h('th', { class: 'team' }, 'Your buy ↓  vs  theirs →'), ...types.map(k => h('th', {}, v.labels[k])))),
    h('tbody', {}, ...types.filter(a => types.some(b => v.matrix[a][b][1])).map(a => h('tr', {}, h('td', { class: 'name' }, v.labels[a]),
      ...types.map(b => { const [w, p] = v.matrix[a][b]; return h('td', { class: p ? (w / p >= 0.5 ? 'good' : 'bad') : '', title: p ? `${w} won of ${p}` : '' }, p ? `${w}/${p}` : '·'); })))));

  const flags = v.flags.filter(f => f.steamid === pov);
  const broke = v.rounds.filter(r => r.teams[me].brokeAfterForce);
  const flagList = flags.length ? h('div', { class: 'integ-moments' }, ...flags.map(f => h('div', { class: 'integ-moment' },
    h('div', { class: 'round-box' }, h('div', { class: 'l' }, 'Round'), h('div', { class: 'n' }, f.round), h('div', { class: 'l' }, f.side)),
    h('div', { class: 'integ-text' }, f.text),
    h('div', { class: 'integ-actions' }, h('button', { class: 'btn', onclick: () => showInReplay(pov, f.tick + 2 * 64) }, '2D replay')))))
    : h('div', { class: 'integ-none' }, `No buy mistakes found for ${name}.`);

  const rows = v.rounds.map(r => {
    const a = r.teams[me], b = r.teams[them];
    const mine = r.me?.eco;
    return h('tr', { class: r.winner === me ? 'won' : 'lost', onclick: () => jumpToRound(r), title: 'Open this round in the 2D replay' },
      h('td', {}, r.num),
      h('td', { class: r.winner === me ? 'good' : 'bad' }, `${r.score[me]}:${r.score[them]}`),
      h('td', {}, h('span', { class: `buy-tag buy-${a.type} side-${a.side}` }, v.labels[a.type]), ' ', money(a.equip)),
      h('td', {}, h('span', { class: `buy-tag buy-${b.type} side-${b.side}` }, v.labels[b.type]), ' ', money(b.equip)),
      h('td', { class: 'eco-how' }, h('span', { class: 'rs-ic' }, reasonIcon(r.reason)), r.reasonText),
      h('td', { class: 'eco-items', title: mine ? mine.items.join(', ') : '' }, mine ? `${money(mine.equip)} · ${mine.items.filter(x => !/Grenade|Flashbang|Molotov|Decoy/.test(x)).slice(-1)[0] || 'nothing'}` : '—'),
      h('td', {}, r.me ? `${r.me.kills}${r.me.died ? '' : ' · alive'}` : ''));
  });

  return [
    h('div', { class: 'section-head' }, h('h3', {}, 'Economy'), h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, 'Loadout value when each round went live. Dots: who won the round. Click a round to open it in the 2D replay.')),
    chart,
    h('div', { class: 'legend eco-legend' }, ...types.map(k => h('span', { class: `lg buy-${k}`, title: BUY_TIP[k] }, h('i', {}), v.labels[k])), h('span', { class: 'lg side-T' }, h('i', {}), 'T'), h('span', { class: 'lg side-CT' }, h('i', {}), 'CT')),
    h('div', { class: 'dash eco-cards' },
      card(`Win rate per buy · ${v.teamNames[me]}`, barList(winRow(me))),
      card(`Win rate per buy · ${v.teamNames[them]}`, barList(winRow(them))),
      card('Your buy against theirs', matrix, { span: 2 })),
    h('div', { class: 'section-head' }, h('h3', {}, `Buy decisions · ${name}`), h('span', { class: 'spacer' }),
      broke.length ? h('span', { class: 'hint' }, `Your team lost ${broke.length} force buy${broke.length > 1 ? 's' : ''} and had to eco the round after (round${broke.length > 1 ? 's' : ''} ${broke.map(r => r.num).join(', ')}).`) : null),
    flagList,
    h('div', { class: 'section-head' }, h('h3', {}, 'Round by round')),
    h('div', { class: 'sb-wrap' }, h('table', { class: 'sb eco-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Score'), h('th', {}, v.teamNames[me]), h('th', {}, v.teamNames[them]), h('th', {}, 'How it ended'), h('th', {}, `${name}’s loadout`), h('th', {}, 'Kills'))),
      h('tbody', {}, ...rows))),
  ];
}

// ---------- Aim ----------
// Benchmarks: quartiles over 96 player-matches of the user's own Premier and matchmaking lobbies
// (October 2026). Above "good" is better than three players in four, below "bad" worse than three in four.
const AIM_STATS = [
  { k: 'counterStrafe', n: 'counterStrafeN', min: 10, label: 'Counter-strafing', fmt: v => `${Math.round(v * 100)}%`, good: 0.75, bad: 0.56,
    tip: 'First bullets (rifles, snipers and pistols, after half a second without shooting) fired while standing still enough to be accurate: under 34% of the weapon’s running speed. Tap the opposite movement key before you shoot.' },
  { k: 'firstBullet', n: 'firstBulletN', min: 8, label: 'First-bullet accuracy', fmt: v => `${Math.round(v * 100)}%`, good: 0.35, bad: 0.19,
    tip: 'First bullets fired at a visible enemy (within 8° of the crosshair) that hit.' },
  { k: 'spray', n: 'sprayN', min: 10, label: 'Spray accuracy', fmt: v => `${Math.round(v * 100)}%`, good: 0.33, bad: 0.19,
    tip: 'Bullets from the 4th of a spray onward (rifles, SMGs, machine guns) at a visible enemy that hit: how well the recoil is pulled down.' },
  { k: 'headHits', n: 'hits', min: 10, label: 'Head hits', fmt: v => `${Math.round(v * 100)}%`, good: 0.2, bad: 0.09,
    tip: 'Share of your bullet hits that were in the head.' },
  { k: 'timeToDamage', n: 'timeToDamageN', min: 5, label: 'Time to damage', fmt: v => `${Math.round(v)} ms`, good: 480, bad: 600, low: true,
    tip: 'From an enemy coming into view to your first damage on them, when you hit them first (within 1.5 s). Reaction plus aim.' },
  { k: 'crosshair', n: 'crosshairN', min: 15, label: 'Crosshair placement', fmt: v => `${v.toFixed(1)}°`, good: 4.7, bad: 7.6, low: true,
    tip: 'How far the crosshair was from an enemy’s head the moment they came into view (median). Keep it at head height where enemies appear.' },
];
const aimLevel = (s, v) => (v == null ? '' : s.low ? (v <= s.good ? 'good' : v > s.bad ? 'bad' : 'mid') : (v >= s.good ? 'good' : v < s.bad ? 'bad' : 'mid'));
const aimMedian = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
// Raw aim counts (one match, several, or some rounds) added up → { stat key: [value, samples] }.
function aimValues(list) {
  const c = { stop: [0, 0], first: [0, 0], spray: [0, 0], hits: 0, head: 0, ttd: [], xhair: [] };
  for (const a of list) {
    for (const k of ['stop', 'first', 'spray']) { c[k][0] += a[k][0]; c[k][1] += a[k][1]; }
    c.hits += a.hits; c.head += a.head; c.ttd.push(...a.ttd); c.xhair.push(...a.xhair);
  }
  return {
    counterStrafe: [c.stop[1] ? c.stop[0] / c.stop[1] : null, c.stop[1]], firstBullet: [c.first[1] ? c.first[0] / c.first[1] : null, c.first[1]],
    spray: [c.spray[1] ? c.spray[0] / c.spray[1] : null, c.spray[1]], headHits: [c.hits ? c.head / c.hits : null, c.hits],
    timeToDamage: [aimMedian(c.ttd), c.ttd.length], crosshair: [aimMedian(c.xhair), c.xhair.length],
  };
}
const CLASS_LABEL = { rifle: 'Rifles', sniper: 'Snipers', pistol: 'Pistols', smg: 'SMGs', shotgun: 'Shotguns', heavy: 'Machine guns' };

function aimData() {
  const d = state.demo;
  if (state.aimRes?.id === d.id) return state.aimRes;
  if (state.aimLoading !== d.id) {
    state.aimLoading = d.id;
    state.aimProgress = 0;
    api.aim(d.path)
      .then(v => { state.aimRes = { id: d.id, value: v }; })
      .catch(e => { state.aimRes = { id: d.id, error: e.message }; })
      .finally(() => { if (state.aimLoading === d.id) state.aimLoading = null; if (state.demo?.id === d.id && state.tab === 'aim') renderDetail(); });
  }
  return null;
}
api.onIntegrityProgress(({ id, progress, phase }) => {
  if (state.aimLoading !== id) return;
  state.aimProgress = progress;
  const el = document.getElementById('aim-progress');
  if (el) el.textContent = phase === 'geometry' ? 'Downloading the map geometry first (57 MB, only once)…' : `${Math.round(progress * 100)}%`;
});

function aimView() {
  const st = aimData();
  if (!st) return h('div', { class: 'empty' }, spinner(24), h('h2', {}, 'Measuring everyone’s aim…'),
    h('div', {}, 'Going through every tick of the match (the same pass as the Integrity tab, so that one is ready afterwards too). Only the first time for each match: about 10 seconds. ',
      h('b', { id: 'aim-progress' }, `${Math.round((state.aimProgress || 0) * 100)}%`)));
  if (st.error) return h('div', { class: 'empty' }, h('h2', {}, 'Could not measure this demo'), h('div', { class: 'err-box' }, st.error));
  const { players } = st.value;
  if (!players.length) return h('div', { class: 'empty' }, h('h2', {}, 'No shots in this demo'));
  const sel = players.find(p => p.steamid === state.aimPlayer) || players.find(p => p.steamid === povId()) || players[0];
  const cell = (s, p) => {
    const v = p[s.k], ok = v != null && p[s.n] >= s.min;
    return h('td', { class: ok ? aimLevel(s, v) : 'muted', title: `${p[s.n]} sample${p[s.n] === 1 ? '' : 's'}` }, ok ? s.fmt(v) : '—');
  };
  const teamName = p => (p.team == null ? '' : p.team === st.value.myTeam ? 'Your team' : 'Opponents');
  const table = h('table', { class: 'sb integ aim-table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'team' }, 'Player'), ...AIM_STATS.map(s => h('th', { title: `${s.tip}\n\nGood: ${s.fmt(s.good)} or ${s.low ? 'less' : 'more'} · needs work: ${s.low ? 'over' : 'under'} ${s.fmt(s.bad)}` }, s.label)), h('th', { title: 'Bullets fired · bullets that hit an enemy' }, 'Shots · hits'))),
    h('tbody', {}, ...players.map(p => h('tr', { class: `${p.steamid === sel.steamid ? 'on' : ''} ${p.mine ? 'me' : ''}`, onclick: () => { state.aimPlayer = p.steamid; renderDetail(); } },
      h('td', { class: 'name' }, avatar(p.name, p.steamid, 'sm'), p.name, h('span', { class: 'integ-team' }, teamName(p))),
      ...AIM_STATS.map(s => cell(s, p)),
      h('td', {}, `${p.shots} · ${p.hits}`)))));

  const tiles = h('div', { class: 'aim-tiles' }, ...AIM_STATS.map(s => {
    const v = sel[s.k], ok = v != null && sel[s.n] >= s.min;
    return h('div', { class: `aim-tile ${ok ? aimLevel(s, v) : ''}`, title: s.tip },
      h('div', { class: 'k' }, s.label), h('div', { class: 'v' }, ok ? s.fmt(v) : '—'),
      h('div', { class: 'aim-bench' }, ok ? `good ${s.low ? '≤' : '≥'} ${s.fmt(s.good)}` : `too few samples (${sel[s.n]})`));
  }));
  const classes = Object.entries(sel.byClass).filter(([, x]) => x.shots >= 5).sort((a, b) => b[1].shots - a[1].shots);
  const classTable = classes.length ? h('table', { class: 'sb aim-class' },
    h('thead', {}, h('tr', {}, h('th', { class: 'team' }, 'Weapons'), h('th', {}, 'Shots'), h('th', {}, 'Accuracy'), h('th', {}, 'Counter-strafing'), h('th', {}, 'First bullet'))),
    h('tbody', {}, ...classes.map(([k, x]) => h('tr', {}, h('td', { class: 'name' }, CLASS_LABEL[k] || k), h('td', {}, x.shots),
      h('td', {}, x.accuracy == null ? '—' : `${Math.round(x.accuracy * 100)}%`),
      h('td', { class: x.counterStrafeN >= 5 ? aimLevel(AIM_STATS[0], x.counterStrafe) : '' }, x.counterStrafeN ? `${Math.round(x.counterStrafe * 100)}% of ${x.counterStrafeN}` : '—'),
      h('td', { class: x.firstBulletN >= 5 ? aimLevel(AIM_STATS[1], x.firstBullet) : '' }, x.firstBulletN ? `${Math.round(x.firstBullet * 100)}% of ${x.firstBulletN}` : '—'))))) : null;

  const moment = (m, text, tag, tickOffset = 0) => h('div', { class: 'integ-moment' },
    h('div', { class: 'round-box' }, h('div', { class: 'l' }, 'Round'), h('div', { class: 'n' }, m.round), h('div', { class: 'l' }, fmtDur(m.clock))),
    h('div', { class: 'integ-text' }, h('span', { class: 'tag' }, tag), h('div', {}, text)),
    h('div', { class: 'integ-actions' },
      h('button', { class: 'btn', onclick: () => showInReplay(sel.steamid, m.tick + tickOffset) }, '2D replay'),
      viewInCs2Button('View in CS2', 'btn', 'Opens the demo in CS2 in this player’s eyes 3 s before this moment and pauses on it',
        () => ({ tick: m.tick, lead: 3, pause: true, name: sel.name }), 'Paused on the moment in CS2. Use the demo controls (Shift+F2) to step back and forth.')));
  const weaponLabel = w => ({ ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', usp_silencer: 'USP-S', hkp2000: 'P2000', deagle: 'Deagle', awp: 'AWP', ssg08: 'Scout', glock: 'Glock' })[w] || w.toUpperCase();
  const tab = state.aimMoments || 'moving';
  const list = tab === 'moving' ? sel.moving : sel.caught;
  return [
    h('div', { class: 'section-head' }, h('h3', {}, 'Aim'), h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, 'Green: better than three players in four of your lobbies; red: worse. Hover a column for what it measures, click a player for details.')),
    st.value.lineOfSight ? null : h('div', { class: 'integ-note' }, 'No map geometry for this map, so who could see whom comes from the in-game radar. Crosshair placement and time to damage are rougher than usual.'),
    h('div', { class: 'sb-wrap' }, table),
    h('div', { class: 'section-head' }, h('h3', { class: 'with-avatar' }, avatar(sel.name, sel.steamid, 'sm'), sel.name)),
    tiles,
    classTable ? h('div', { class: 'sb-wrap' }, classTable) : null,
    aimProgression(sel, st.value),
    h('div', { class: 'section-head' },
      h('div', { class: 'tabs' },
        h('button', { class: tab === 'moving' ? 'on' : '', onclick: () => { state.aimMoments = 'moving'; renderDetail(); } }, `Missed while moving (${sel.moving.length})`),
        h('button', { class: tab === 'caught' ? 'on' : '', onclick: () => { state.aimMoments = 'caught'; renderDetail(); } }, `Caught first (${sel.caught.length})`)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, tab === 'moving' ? 'First bullets at a visible enemy fired too fast to be accurate, that missed.' : 'Enemies that came into view, hit you first and killed you: where was your crosshair?')),
    list.length ? h('div', { class: 'integ-moments' }, ...list.map(m => tab === 'moving'
      ? moment(m, `First bullet with the ${weaponLabel(m.weapon)} at ${m.speed} u/s: too fast to be accurate. It missed.`, 'Moving shot')
      : moment(m, `${m.enemy} came into view ${fmtNum(m.dist)} units away with your crosshair ${m.err.toFixed(1)}° from their head, hit you first and killed you.`, 'Caught'))) : h('div', { class: 'integ-none' }, 'Nothing here.'),
  ];
}

// How a player's aim moved during the match: one stat over the rounds (pooled over a sliding window,
// since a single round has only a few samples), and every stat early / mid / late in the match.
const PROG_WINDOW = 5;
const roundCounts = r => ({ stop: r[1], first: r[2], spray: r[3], hits: r[4], head: r[5], ttd: r[7], xhair: r[8] });
function aimProgression(sel, v) {
  const nums = v.roundNums || [];
  if (!sel.rounds || nums.length < 6) return null;
  const by = new Map(sel.rounds.map(r => [r[0], roundCounts(r)]));
  const at = list => aimValues(list.map(n => by.get(n)).filter(Boolean));
  const s = AIM_STATS.find(x => x.k === state.aimProg) || AIM_STATS[0];
  const enough = n => n >= Math.max(3, Math.ceil(s.min / 2));
  const pts = nums.map((n, i) => ({ n, win: at(nums.slice(Math.max(0, i - PROG_WINDOW + 1), i + 1))[s.k], one: at([n])[s.k] }));
  const whole = at(nums)[s.k];

  // ---- chart
  const W = 1000, H = 230, L = 46, R = 14, T = 14, B = 26;
  const isPct = !/timeToDamage|crosshair/.test(s.k);
  const seen = pts.flatMap(p => [p.win, p.one]).filter(([x, n]) => x != null && n).map(([x]) => x);
  const step = s.k === 'timeToDamage' ? 100 : 2;
  const top = isPct ? 1 : Math.ceil(Math.max(s.bad * 1.4, ...seen.map(x => Math.min(x, s.bad * 3))) / step) * step;
  const X = i => L + (nums.length === 1 ? 0 : i * (W - L - R) / (nums.length - 1));
  const Y = val => T + (H - T - B) * (1 - Math.min(val, top) / top);
  const fmt = val => (isPct ? `${Math.round(val * 100)}%` : s.fmt(val));
  const ticks = isPct ? [0, 0.25, 0.5, 0.75, 1] : [0, top / 2, top];
  const goodZone = s.low ? [0, s.good] : [s.good, top], badZone = s.low ? [s.bad, top] : [0, s.bad];
  const zone = ([a, b], cls) => (b > a ? `<rect x="${L}" width="${W - L - R}" y="${Y(b)}" height="${Y(a) - Y(b)}" class="${cls}"/>` : '');
  let line = '', seg = false;
  pts.forEach((p, i) => { const [val, n] = p.win; if (val != null && enough(n)) { line += `${seg ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(val).toFixed(1)}`; seg = true; } else seg = false; });
  const halves = (v.halves || []).map(n => nums.indexOf(n)).filter(i => i > 0)
    .map(i => `<line x1="${(X(i - 1) + X(i)) / 2}" x2="${(X(i - 1) + X(i)) / 2}" y1="${T}" y2="${H - B}" class="ap-half"/><text x="${(X(i - 1) + X(i)) / 2 + 4}" y="${T + 9}" class="ap-tx">sides switch</text>`).join('');
  const cols = pts.map((p, i) => {
    const [w, wn] = p.win, [o, on] = p.one;
    const tip = `Round ${p.n}\nLast ${Math.min(PROG_WINDOW, i + 1)} rounds: ${w != null && wn ? `${s.fmt(w)} (${wn} sample${wn === 1 ? '' : 's'})` : 'no samples'}\nThis round: ${o != null && on ? `${s.fmt(o)} (${on})` : '—'}`;
    const half = i ? (X(i) - X(i - 1)) / 2 : (X(1) - X(0)) / 2;
    return `<g class="ap-r" data-n="${p.n}"><rect x="${X(i) - half}" width="${half * 2}" y="${T}" height="${H - T - B}" class="ap-hit"/>
      ${o != null && on ? `<circle cx="${X(i)}" cy="${Y(o)}" r="${Math.min(6, 2 + on * 0.6)}" class="ap-one"/>` : ''}
      ${w != null && enough(wn) ? `<circle cx="${X(i)}" cy="${Y(w)}" r="3.4" class="ap-dot ${aimLevel(s, w)}"/>` : ''}
      <text x="${X(i)}" y="${H - 8}" class="ap-n">${nums.length <= 30 || p.n % 2 ? p.n : ''}</text><title>${tip}</title></g>`;
  }).join('');
  const chart = h('div', { class: 'eco-chart ap-chart', html: `<svg viewBox="0 0 ${W} ${H}">
    ${zone(goodZone, 'ap-good')}${zone(badZone, 'ap-bad')}
    ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="ap-grid"/><text x="${L - 8}" y="${Y(t) + 3.5}" class="ap-tx ap-y">${fmt(t)}</text>`).join('')}
    ${whole[0] != null ? `<line x1="${L}" x2="${W - R}" y1="${Y(whole[0])}" y2="${Y(whole[0])}" class="ap-avg"/><text x="${W - R - 4}" y="${Y(whole[0]) - 5}" class="ap-tx ap-avgt">match ${s.fmt(whole[0])}</text>` : ''}
    ${halves}<path d="${line}" class="ap-line"/>${cols}</svg>` });
  const rounds = state.rd.data?.value?.rounds;
  chart.addEventListener('click', e => {
    const g = e.target.closest('.ap-r'), r = g && rounds?.find(x => x.num === +g.dataset.n);
    if (r) showInReplay(sel.steamid, r.freezeEndTick + 2 * 64);
  });

  // ---- early / mid / late
  const third = Math.ceil(nums.length / 3);
  const parts = [nums.slice(0, third), nums.slice(third, 2 * third), nums.slice(2 * third)].filter(p => p.length);
  const label = p => `Rounds ${p[0]}–${p[p.length - 1]}`;
  const vals = parts.map(p => at(p));
  const cell = (x, [val, n]) => { const ok = val != null && n >= Math.ceil(x.min / 2); return h('td', { class: ok ? aimLevel(x, val) : 'muted', title: `${n} sample${n === 1 ? '' : 's'}` }, ok ? x.fmt(val) : '—'); };
  const trend = x => {
    const [a, an] = vals[0][x.k], [b, bn] = vals[vals.length - 1][x.k], need = Math.ceil(x.min / 2);
    if (a == null || b == null || an < need || bn < need) return h('td', { class: 'muted' }, '—');
    const better = x.low ? a - b : b - a, rel = better / Math.max(Math.abs(a), x.low ? 1 : 0.05);
    if (Math.abs(rel) < 0.08) return h('td', { class: 'muted', title: 'Less than 8% apart' }, '≈ steady');
    return h('td', { class: better > 0 ? 'good' : 'bad' }, better > 0 ? '▲ better' : '▼ worse');
  };
  const table = h('table', { class: 'sb ap-table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'team' }, 'Stat'), ...parts.map((p, i) => h('th', {}, ['Early', 'Middle', 'Late'][i], h('div', { class: 'ap-sub' }, label(p)))), h('th', { title: 'Late in the match against early' }, 'Trend'))),
    h('tbody', {}, ...AIM_STATS.map(x => h('tr', { class: x.k === s.k ? 'on' : '', title: 'Show this stat on the chart', onclick: () => { state.aimProg = x.k; renderProg(); } },
      h('td', { class: 'name' }, x.label), ...vals.map(vv => cell(x, vv[x.k])), trend(x)))));

  const box = h('div', { class: 'ap' },
    h('div', { class: 'section-head' }, h('h3', {}, 'Progression over the match'),
      h('div', { class: 'tabs' }, ...AIM_STATS.map(x => h('button', { class: x.k === s.k ? 'on' : '', title: x.tip, onclick: () => { state.aimProg = x.k; renderProg(); } }, x.label))),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, `Line: the last ${PROG_WINDOW} rounds together · rings: each round alone (bigger = more samples)${s.low ? ' · lower is better' : ''}. Click a round for the 2D replay.`)),
    chart, h('div', { class: 'sb-wrap' }, table));
  // Switching the stat repaints only this block, so the page keeps its scroll position.
  function renderProg() { box.replaceWith(aimProgression(sel, v)); }
  return box;
}

// Overview: aim over the selected matches (only those that went through the tick pass).
state.aimBatch = { running: false };
api.onAimBatch(s => {
  state.aimBatch = s;
  if (s.finished || (s.running && s.done)) reloadProfileSoon();
  if (state.view === 'overview') renderOverview();
});
api.onProfileChanged(() => reloadProfileSoon());

function aimCard(list) {
  const p = shownProfile();
  const withAim = list.filter(m => m.aim);
  const batch = state.aimBatch?.running ? state.aimBatch : p?.aimBatch?.running ? p.aimBatch : null;
  const missing = p?.aimMissing || 0;
  const batchCall = async action => { state.aimBatch = await guard(() => api.aimBatch(action, state.who || undefined)) || state.aimBatch; renderOverview(); };
  const n = batch && Math.min(batch.done + 1, batch.total);
  const last = state.aimBatch?.stopped ? state.aimBatch : null;
  const action = batch
    ? h('div', { class: `aim-batch ${batch.stopping ? 'stopping' : ''}` }, spinner(12), batch.stopping
      ? [` Stopping once match ${n} of ${batch.total} is measured…`, h('button', { class: 'link-btn', onclick: () => batchCall('resume') }, 'Keep going')]
      : [` Measuring match ${n} of ${batch.total}…`, h('button', { class: 'link-btn', onclick: () => batchCall('cancel') }, 'Stop after this one')])
    : missing ? h('div', { class: 'aim-batch' },
      h('button', { class: 'btn', title: 'Goes through every tick of each match once (about 10 seconds per match, in the background). The Integrity tab of those matches is ready afterwards too.',
        onclick: () => batchCall('start') },
      `Measure ${missing} more match${missing === 1 ? '' : 'es'} (~${Math.max(1, Math.round(missing / 6))} min)`),
      last ? h('span', {}, `Stopped: ${last.done} of ${last.total} measured.`) : null) : null;
  if (!withAim.length) {
    return card(null, [h('div', { class: 'muted-note' }, 'Counter-strafing, first-bullet and spray accuracy, crosshair placement and time to damage need one pass over every tick of a match. Open a match’s Aim tab, or measure all your matches at once.'), action], { span: 4 });
  }
  const vals = aimValues(withAim.map(m => m.aim));
  const tiles = h('div', { class: 'aim-tiles' }, ...AIM_STATS.map(s => {
    const [v, n] = vals[s.k];
    const ok = v != null && n >= s.min;
    return h('div', { class: `aim-tile ${ok ? aimLevel(s, v) : ''}`, title: `${s.tip}\n\n${n} samples over ${withAim.length} match${withAim.length === 1 ? '' : 'es'}` },
      h('div', { class: 'k' }, s.label), h('div', { class: 'v' }, ok ? s.fmt(v) : '—'),
      h('div', { class: 'aim-bench' }, `good ${s.low ? '≤' : '≥'} ${s.fmt(s.good)} · needs work ${s.low ? '>' : '<'} ${s.fmt(s.bad)}`));
  }));
  return card(null, [tiles, h('div', { class: 'aim-foot' },
    h('span', { class: 'hint' }, `From ${withAim.length} of ${list.length} matches · green: better than three players in four of your lobbies, red: worse`), h('span', { class: 'spacer' }), action)], { span: 4 });
}

// ---------- Positions (Maps page) ----------
state.posSide = 'T';
function positionsCard(map) {
  const matches = (state.profile?.matches || []).filter(m => m.map === map);
  if (!matches.length) return null;
  const rows = matches.flatMap(m => m.positions || []);
  const pending = state.profile?.positionsPending;
  if (!rows.length) return card('Where you play', h('div', { class: 'muted-note' }, pending ? [spinner(11), ' Reading the positions of your matches…'] : 'No positions for your matches on this map.'), { cls: 'map-stats' });
  const side = state.posSide;
  const by = new Map();
  let total = 0;
  for (const [, s, place, won, kills, died] of rows) {
    if (s !== side) continue;
    total++;
    const e = by.get(place) || by.set(place, { place, rounds: 0, won: 0, kills: 0, deaths: 0 }).get(place);
    e.rounds++; e.won += won; e.kills += kills; e.deaths += died;
  }
  const list = [...by.values()].sort((a, b) => b.rounds - a.rounds).slice(0, 9);
  const kd = e => (e.deaths ? e.kills / e.deaths : e.kills);
  const sideTabs = h('div', { class: 'tabs' }, ...['T', 'CT'].map(s => h('button', { class: `${side === s ? 'on' : ''} side-${s}`, onclick: () => { state.posSide = s; const el = document.getElementById('pos-card'); el?.replaceWith(positionsCard(map)); } }, s)));
  const el = card('Where you play', [
    list.length ? h('table', { class: 'sb pos-table' },
      h('thead', {}, h('tr', {}, h('th', { class: 'team' }, 'Position'), h('th', { title: 'Rounds you mostly played there (share of your rounds on this side)' }, 'Rounds'), h('th', { title: 'Rounds your team won' }, 'Won'), h('th', { title: 'Your kills – deaths in those rounds' }, 'K–D'))),
      h('tbody', {}, ...list.map(e => h('tr', {},
        h('td', { class: 'name' }, placeLabel(e.place), h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${side === 'T' ? 't' : 'ct'}`, style: { width: `${100 * e.rounds / total}%` } }))),
        h('td', {}, `${e.rounds} · ${pct(e.rounds, total)}%`),
        h('td', { class: e.won / e.rounds >= 0.5 ? 'good' : 'bad' }, `${pct(e.won, e.rounds)}%`),
        h('td', { class: kd(e) >= 1 ? 'good' : 'bad', title: `K/D ${kd(e).toFixed(2)}` }, `${e.kills}–${e.deaths}`)))))
      : h('div', { class: 'muted-note' }, `No ${side} rounds on this map yet.`),
    h('div', { class: 'hint' }, 'Position: the callout where you spent the most time from 10 s into the round until you died, the bomb was planted or the round ended.'),
  ], { cls: 'map-stats', extra: sideTabs });
  el.id = 'pos-card';
  return el;
}

// ---------- Utility: practice quiz and "Practice in CS2" ----------
const QUIZ_KINDS = [['mix', 'Mixed'], ['land', 'Where does it land?'], ['from', 'Where is it thrown from?'], ['name', 'Which lineup is this?']];
const LAND_OK = 220, FROM_OK = 160; // units: close enough to count as right

async function practiceInCs2(x, btn) {
  if (btn) btn.disabled = true;
  toast('Opening the map in CS2 (through HLAE). The first time takes a minute or two.');
  try {
    await api.practice({ map: x.map, from: x.from, angle: x.angle, type: x.type, side: x.side === 'CT' ? 'CT' : 'T' });
    toast(`You are on the spot with a ${utLabel(UT_TYPES, x.type).toLowerCase()} in hand. ${utMoved(x) ? `Throw: ${utMoved(x)}.` : ''}`, 'ok');
  } catch (e) { toast(e.message.replace(/^.*HLAE_MISSING:\s*/, ''), 'error'); }
  if (btn) btn.disabled = false;
}
function practiceButton(x, cls = 'btn nc-btn') {
  if (!x.from || x.from[2] == null) return null;
  const b = h('button', { class: cls, title: 'Opens this map on a private practice server in CS2 (through HLAE), puts you on the throw spot aiming the same way, with the grenade in hand. Close CS2 first if it is open normally.' }, icon(ICONS.screen), 'Practice in CS2');
  b.onclick = () => practiceInCs2(x, b);
  return b;
}

const quizzable = (x, kind) => (kind === 'name' ? x.images.length > 0 : !!(x.from && x.to));
function quizSetup() {
  const items = state.ut.items;
  const maps = [...new Set(items.filter(x => x.from && x.to || x.images.length).map(x => x.map))];
  const q = state.quiz ||= { map: state.ut.map !== 'all' ? state.ut.map : 'all', kind: 'mix', count: 10 };
  if (q.map !== 'all' && !maps.includes(q.map)) q.map = 'all';
  const pool = () => items.filter(x => (q.map === 'all' || x.map === q.map) && (q.kind === 'mix' ? quizzable(x, 'land') || quizzable(x, 'name') : quizzable(x, q.kind)));
  const info = h('div', { class: 'hint' });
  const update = () => { const n = pool().length; info.textContent = n ? `${n} lineup${n === 1 ? '' : 's'} to ask about. The ones you missed most and practiced least come first.` : 'No lineup fits: "where" questions need a throw spot and a landing spot, "which" questions a picture.'; start.disabled = !n; };
  const start = h('button', { class: 'btn primary', onclick: () => quizStart(pool()) }, 'Start');
  modal([
    h('h2', {}, 'Practice quiz'),
    h('p', {}, 'Test yourself on your lineups: find where a grenade lands, where you throw it from, or recognise it from its picture.'),
    h('div', { class: 'quiz-setup' },
      h('label', {}, 'Map'), select(q.map, [['all', 'All maps'], ...maps.map(m => [m, mapName(m)])], v => { q.map = v; update(); }),
      h('label', {}, 'Questions'), select(q.kind, QUIZ_KINDS, v => { q.kind = v; update(); }),
      h('label', {}, 'How many'), select(String(q.count), [['5', '5'], ['10', '10'], ['20', '20'], ['999', 'All']], v => { q.count = +v; })),
    info,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'), start),
  ]);
  update();
}

function quizStart(pool) {
  const q = state.quiz;
  const weak = x => (x.quiz ? x.quiz.wrong - x.quiz.right : 0.5);
  const order = [...pool].map(x => [x, weak(x) * 10 - (x.quiz?.last || x.lastPracticed || 0) / 864e5 / 30 + Math.random() * 3])
    .sort((a, b) => b[1] - a[1]).map(([x]) => x).slice(0, q.count);
  q.questions = order.map(x => {
    const kinds = q.kind !== 'mix' ? [q.kind] : ['land', 'from', 'name'].filter(k => quizzable(x, k) && (k !== 'name' || state.ut.items.filter(y => y.map === x.map).length >= 2));
    const kind = kinds[Math.floor(Math.random() * kinds.length)] || 'land';
    return { id: x.id, kind, answer: null, right: null };
  });
  q.i = 0;
  quizQuestion();
}

function quizQuestion() {
  const q = state.quiz;
  if (q.i >= q.questions.length) return quizEnd();
  const qq = q.questions[q.i];
  const x = state.ut.items.find(y => y.id === qq.id);
  if (!x) { q.i++; return quizQuestion(); }
  const head = h('div', { class: 'quiz-head' }, h('span', { class: 'pill' }, `${q.i + 1} / ${q.questions.length}`), h('span', { class: 'ut-dot', style: { '--c': NADE_COLOR[x.type] } }),
    h('b', {}, `${utLabel(UT_TYPES, x.type)} · ${mapName(x.map)}`), x.side !== 'both' ? h('span', { class: `side-${x.side}` }, x.side) : null);
  const answered = qq.answer != null;
  const next = h('button', { class: 'btn primary', onclick: () => { q.i++; quizQuestion(); } }, q.i + 1 < q.questions.length ? 'Next' : 'Finish');
  const result = answered ? h('div', { class: `quiz-result ${qq.right ? 'good' : 'bad'}` }, qq.right ? '✓ Right' : '✗ Not quite', qq.dist != null ? ` · ${fmtNum(qq.dist)} units off` : '', ` · ${x.name}`) : null;
  const foot = h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => closeModal() }, 'Stop'),
    answered ? practiceButton(x, 'btn') : null,
    answered ? next : h('button', { class: 'btn', onclick: () => quizAnswer(qq, x, null) }, 'Show me'));
  const technique = h('div', { class: 'quiz-tech' }, [utMoved(x), x.aim ? `aim: ${x.aim}` : ''].filter(Boolean).join(' · '));

  if (qq.kind === 'name') {
    const same = state.ut.items.filter(y => y.map === x.map && y.id !== x.id);
    qq.options ||= [x, ...same.sort(() => Math.random() - 0.5).slice(0, 3)].sort(() => Math.random() - 0.5).map(y => y.id);
    return modal([head, h('h2', {}, 'Which lineup is this?'),
      h('img', { class: 'quiz-img', src: utImg(x.images[0]) }),
      h('div', { class: 'quiz-options' }, ...qq.options.map(id => {
        const y = state.ut.items.find(z => z.id === id);
        const cls = !answered ? '' : id === x.id ? 'good' : id === qq.answer ? 'bad' : '';
        return h('button', { class: `btn quiz-opt ${cls}`, disabled: answered, onclick: () => quizAnswer(qq, x, id) }, y?.name || '?');
      })),
      result, foot], { wide: true, onClose: false }).classList.add('quiz-modal');
  }

  const info = radarInfo(x.map);
  if (!info) { qq.kind = 'name'; return x.images.length ? quizQuestion() : (q.i++, quizQuestion()); }
  const ref = qq.kind === 'land' ? x.from : x.to;
  const frame = radarFrame(info, x.map, { lower: info.lowerBelow !== undefined && (qq.kind === 'land' ? !!x.lower : onLower(info, x.to[2] ?? 0)) });
  const view = qq.view ||= newView();
  const canvas = h('canvas', { width: 1400, height: 1400, class: 'quiz-canvas' });
  let img = null;
  const redraw = () => drawQuiz(canvas, img, frame, view, x, qq);
  radarImage(frame.src).then(i => { img = i; redraw(); });
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('click', e => {
    if (answered || (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)) return;
    const r = canvas.getBoundingClientRect();
    const px = view.x + (e.clientX - r.left) / r.width * RADAR_SIZE / view.k, py = view.y + (e.clientY - r.top) / r.height * RADAR_SIZE / view.k;
    quizAnswer(qq, x, [frame.x + px * frame.scale, frame.y - py * frame.scale]);
  });
  const prompt = qq.kind === 'land' ? `Click where this ${utLabel(UT_TYPES, x.type).toLowerCase()} lands.` : `Click where you throw this ${utLabel(UT_TYPES, x.type).toLowerCase()} from.`;
  const pics = qq.kind === 'land' && x.images.length ? h('div', { class: 'quiz-pics' }, ...x.images.slice(0, 2).map(f => h('img', { src: utImg(f) }))) : null;
  modal([head, h('h2', {}, answered ? (qq.kind === 'land' ? 'Where it lands' : 'Where it is thrown from') : prompt),
    qq.kind === 'land' ? technique : h('div', { class: 'quiz-tech' }, answered ? technique.textContent : (x.name)),
    h('div', { class: 'quiz-body' }, h('div', { class: 'quiz-stage' }, zoomable(canvas, view, redraw), h('div', { class: 'stage-hint' }, ref ? 'Scroll to zoom · drag to move · click to answer' : '')), pics),
    result, foot], { wide: true, onClose: false }).classList.add('quiz-modal');
}

function drawQuiz(canvas, img, frame, v, x, qq) {
  const ctx = canvas.getContext('2d');
  const k = canvas.width / RADAR_SIZE * Math.min(1.8, 0.8 + 0.2 * v.k);
  const px = (wx, wy) => { const [cx, cy] = viewPt(canvas, v, ...toPx(frame, wx, wy)); return [cx / k, cy / k]; };
  const units = w => w / frame.scale * viewScale(canvas, v) / k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (img) { applyView(ctx, canvas, v); ctx.globalAlpha = 0.9; ctx.drawImage(img, 0, 0, RADAR_SIZE, RADAR_SIZE); ctx.globalAlpha = 1; }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.lineCap = 'round';
  const c = NADE_COLOR[x.type];
  const answered = qq.answer != null;
  const spot = p => { ctx.fillStyle = c; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(...p, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); };
  const landing = p => {
    const r = x.type === 'smoke' ? units(SMOKE_RADIUS) : x.type === 'molotov' ? units(MOLOTOV_RADIUS) : 9;
    ctx.fillStyle = c + '55'; ctx.strokeStyle = c; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(...p, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };
  const from = px(x.from[0], x.from[1]), to = px(x.to[0], x.to[1]);
  if (answered) {
    ctx.strokeStyle = c; ctx.lineWidth = 3;
    ctx.beginPath();
    if (x.path?.length > 1) x.path.forEach((p, i) => { const [a, b] = px(p[0], p[1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    else { ctx.moveTo(...from); ctx.lineTo(...to); }
    ctx.stroke();
  }
  if (qq.kind === 'land' || answered) {
    if (x.angle) { const yaw = x.angle[1] * Math.PI / 180; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(from[0] + Math.cos(yaw) * 22, from[1] - Math.sin(yaw) * 22); ctx.stroke(); }
    spot(from);
  }
  if (qq.kind === 'from' || answered) landing(to);
  if (Array.isArray(qq.answer)) {
    const g = px(qq.answer[0], qq.answer[1]), truth = qq.kind === 'land' ? to : from;
    ctx.setLineDash([5, 5]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(...g); ctx.lineTo(...truth); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = qq.right ? '#3ee08f' : '#ff3d5e'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(g[0] - 7, g[1] - 7); ctx.lineTo(g[0] + 7, g[1] + 7); ctx.moveTo(g[0] + 7, g[1] - 7); ctx.lineTo(g[0] - 7, g[1] + 7); ctx.stroke();
  }
}

async function quizAnswer(qq, x, answer) {
  if (qq.answer != null) return;
  if (Array.isArray(answer)) {
    const truth = qq.kind === 'land' ? x.to : x.from;
    qq.dist = Math.round(Math.hypot(answer[0] - truth[0], answer[1] - truth[1]));
    qq.right = qq.dist <= (qq.kind === 'land' ? LAND_OK : FROM_OK);
    qq.answer = answer;
  } else {
    qq.answer = answer ?? 'skip';
    qq.right = answer === x.id;
  }
  const it = await api.utilityPatch(x.id, { quiz: !!qq.right }).catch(() => null);
  if (it) Object.assign(x, it);
  quizQuestion();
}

function quizEnd() {
  const q = state.quiz;
  const right = q.questions.filter(x => x.right).length;
  const missed = q.questions.filter(x => !x.right).map(x => state.ut.items.find(y => y.id === x.id)).filter(Boolean);
  modal([
    h('h2', {}, `${right} / ${q.questions.length} right`),
    h('p', {}, right === q.questions.length ? 'Perfect run.' : 'The ones you missed come first next time.'),
    missed.length ? h('div', { class: 'quiz-missed' }, ...missed.map(x => h('button', { class: 'ut-same-item', style: { '--c': NADE_COLOR[x.type] },
      onclick: () => { closeModal(); state.ut.map = x.map; state.ut.sel = x.id; resetZoom(state.ut.view); renderUtility(); } },
    h('span', { class: 'ut-dot' }), h('span', { class: 'ut-name-t' }, x.name), h('span', { class: 'ut-sub' }, mapName(x.map))))) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { closeModal(); renderUtility(); } }, 'Close'), h('button', { class: 'btn primary', onclick: () => quizSetup() }, 'Again')),
  ]);
}

// ---------- Export for sharing ----------
const SHARE_ICON = '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>';
const shareBadge = c => ({ vertical: 'VERTICAL', verticalFit: 'VERTICAL', square: 'SQUARE' })[c.format] || 'SHARE';
const SHARE_FORMATS = [['vertical', 'Vertical 9:16 · cropped (TikTok, Shorts, Reels)'], ['verticalFit', 'Vertical 9:16 · whole frame on a blurred background'], ['square', 'Square 1:1'], ['original', 'Original 16:9']];
async function shareDialog(c) {
  const o = state.shareOpts ||= { format: 'vertical', slowmo: true, speed: 0.5, feed: true, titleOn: true, music: '', volume: 0.5, gameVolume: 0.9 };
  const isClip = c.kind === 'clip';
  const info = isClip ? await api.shareInfo(c.id).catch(() => ({ kills: null })) : { kills: null };
  const kills = info.kills;
  const title = h('input', { type: 'text', value: c.kind === 'clip' ? c.title : c.title, maxlength: 60 });
  const subtitle = h('input', { type: 'text', value: isClip ? [c.player, mapName(c.map), c.round ? `Round ${c.round}` : null].filter(Boolean).join(' · ') : '', maxlength: 80 });
  const musicLabel = h('span', { class: 'share-music' }, o.music ? o.music.split(/[\\/]/).pop() : 'No music');
  const vol = (value, on) => h('input', { type: 'range', min: 0, max: 1.5, step: 0.05, value, oninput: e => on(+e.target.value) });
  const row = (label, ctl, hint) => h('div', { class: 'share-row' }, h('label', {}, label), h('div', {}, ctl, hint ? h('div', { class: 'hint' }, hint) : null));
  const cb = (on, label, set, disabled) => h('label', { class: `share-check ${disabled ? 'off' : ''}` }, h('input', { type: 'checkbox', checked: on && !disabled, disabled, onchange: e => set(e.target.checked) }), label);
  const go = h('button', { class: 'btn primary', onclick: () => shareRun(c, { ...o, title: o.titleOn ? title.value : '', subtitle: o.titleOn ? subtitle.value : '' }) }, 'Export');
  modal([
    h('h2', {}, 'Export for sharing'),
    h('p', { class: 'hint' }, c.title),
    h('div', { class: 'share-form' },
      row('Format', select(o.format, SHARE_FORMATS, v => { o.format = v; })),
      row('Slow motion', [cb(o.slowmo, 'Slow down the last kill', v => { o.slowmo = v; }, !kills?.length),
        select(String(o.speed), [['0.5', 'Half speed'], ['0.33', 'Third speed'], ['0.25', 'Quarter speed']], v => { o.speed = +v; })],
      kills?.length ? null : isClip ? 'The kill times of this clip are unknown (its demo is gone or the timing settings changed since it was recorded).' : 'Only for single clips.'),
      row('Kill feed', cb(o.feed, 'Show your kills as a kill feed (the vertical crop cuts the game’s own off)', v => { o.feed = v; }, !kills?.length)),
      row('Title', [cb(o.titleOn, 'Title for the first 3 seconds', v => { o.titleOn = v; }), title, subtitle]),
      row('Music', [h('div', { class: 'share-music-row' }, musicLabel,
        h('button', { class: 'btn', onclick: async () => { const f = await guard(() => api.pickFile('Music', [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'] }])); if (f) { o.music = f; musicLabel.textContent = f.split(/[\\/]/).pop(); } } }, 'Choose…'),
        h('button', { class: 'link-btn', onclick: () => { o.music = ''; musicLabel.textContent = 'No music'; } }, 'None')),
      h('div', { class: 'share-vol' }, 'Music', vol(o.volume, v => { o.volume = v; }), 'Game sound', vol(o.gameVolume, v => { o.gameVolume = v; }))],
      'Loops if shorter than the video and fades out at the end.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'), go),
  ]);
}

async function shareRun(c, o) {
  const bar = h('div', {});
  modal([h('h2', {}, 'Exporting…'), h('div', { class: 'progress' }, bar), h('p', {}, 'Re-encoding with ffmpeg. Saved in the Shared folder of your clips.')], { onClose: false });
  const off = api.onShare(u => { if (u.progress !== undefined) bar.style.width = `${Math.round(u.progress * 100)}%`; });
  try {
    const item = await api.share(c.id, {
      format: o.format, slowmo: o.slowmo, speed: o.speed, feed: o.feed, title: o.title, subtitle: o.subtitle,
      music: o.music ? { file: o.music, volume: o.volume, gameVolume: o.gameVolume } : null,
    });
    closeModal();
    await loadClips();
    playClip(item);
  } catch (e) {
    modal([h('h2', {}, 'Export failed'), h('div', { class: 'err-box' }, e.message), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'))]);
  } finally { off(); }
}
