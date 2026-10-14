/* global api, state, h, fmtNum, spinner, select, renderDetail, povId, aimLevel, AIM_STATS */
'use strict';
// The Weapons tab: per weapon kills, damage, accuracy and kill types, and where the bullets landed on
// the body. Filters (rounds, player, team, side, weapon type) and the weapon selection only repaint
// this tab: the rows come once per demo from lib/weapons.js and are added up here.

state.wp = { key: null, data: null, loading: null, sel: new Set(), f: {}, metric: 'general', sort: null, hover: null };

const WP_TYPES = [['rifles', 'Rifles'], ['snipers', 'Snipers'], ['pistols', 'Pistols'], ['smgs', 'SMGs'], ['heavy', 'Heavy'], ['grenades', 'Grenades'], ['other', 'Other']];
const wpType = w => /^(ak47|m4a1|m4a1_silencer|famas|galilar|aug|sg556)$/.test(w) ? 'rifles'
  : /^(awp|ssg08|g3sg1|scar20)$/.test(w) ? 'snipers'
    : /^(glock|usp_silencer|hkp2000|p250|fiveseven|tec9|cz75a|elite|deagle|revolver)$/.test(w) ? 'pistols'
      : /^(mac10|mp9|mp7|mp5sd|ump45|p90|bizon)$/.test(w) ? 'smgs'
        : /^(nova|xm1014|mag7|sawedoff|m249|negev)$/.test(w) ? 'heavy'
          : /grenade|inferno|molotov|flashbang|decoy/.test(w) ? 'grenades' : 'other';
const WP_NAME = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', famas: 'FAMAS', galilar: 'Galil AR', aug: 'AUG', sg556: 'SG 553',
  awp: 'AWP', ssg08: 'SSG 08', g3sg1: 'G3SG1', scar20: 'SCAR-20',
  glock: 'Glock-18', usp_silencer: 'USP-S', hkp2000: 'P2000', p250: 'P250', fiveseven: 'Five-SeveN', tec9: 'Tec-9', cz75a: 'CZ75-Auto',
  elite: 'Dual Berettas', deagle: 'Desert Eagle', revolver: 'R8 Revolver',
  mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7', mp5sd: 'MP5-SD', ump45: 'UMP-45', p90: 'P90', bizon: 'PP-Bizon',
  nova: 'Nova', xm1014: 'XM1014', mag7: 'MAG-7', sawedoff: 'Sawed-Off', m249: 'M249', negev: 'Negev',
  hegrenade: 'HE Grenade', inferno: 'Molotov', molotov: 'Molotov', incgrenade: 'Incendiary', flashbang: 'Flashbang', smokegrenade: 'Smoke', decoy: 'Decoy',
  taser: 'Zeus x27', knife: 'Knife', planted_c4: 'C4', world: 'World',
};
const wpName = w => WP_NAME[w] || (/^knife|bayonet/.test(w) ? 'Knife' : w.toUpperCase());
// Hit groups as the demo names them; "left" is the player's own left (the figure faces you).
const REGIONS = [['head', 'Head'], ['neck', 'Neck'], ['chest', 'Chest'], ['stomach', 'Stomach'], ['left_arm', 'Left arm'], ['right_arm', 'Right arm'], ['left_leg', 'Left leg'], ['right_leg', 'Right leg']];

// The kill-feed silhouettes from the CS2 install (lib/themeArt.js), cached per weapon.
const wpIconUrls = new Map();
function weaponIcon(w) {
  const code = /^knife|bayonet/.test(w) ? 'knife' : w;
  const img = h('img', { class: 'wp-img', alt: '' });
  if (!wpIconUrls.has(code)) wpIconUrls.set(code, api.artWeapon(code).then(f => (f ? api.fileUrl(f) : null)).catch(() => null));
  wpIconUrls.get(code).then(u => { if (u) img.src = u; else img.classList.add('none'); });
  return img;
}

function weaponsData() {
  const d = state.demo, wp = state.wp;
  if (wp.key !== d.id) Object.assign(wp, { key: d.id, data: null, sel: new Set(), f: {}, hover: null });
  if (wp.data) return wp.data;
  if (wp.loading !== d.id) {
    wp.loading = d.id;
    api.weapons(d.path)
      .then(v => { if (wp.key === d.id) wp.data = { value: v }; })
      .catch(e => { if (wp.key === d.id) wp.data = { error: e.message }; })
      .finally(() => { if (wp.loading === d.id) wp.loading = null; if (state.demo?.id === d.id && state.tab === 'weapons') renderDetail(); });
  }
  return null;
}

// Everything the current filters let through, added up per weapon.
function weaponRows(v, f) {
  const half = new Map(v.rounds.map(r => [r.num, r.half]));
  const pistol = new Set(v.rounds.filter((r, i) => r.half <= 1 && (!i || v.rounds[i - 1].half !== r.half)).map(r => r.num));
  const team = Object.fromEntries(v.players.map(p => [p.steamid, p.team]));
  const myTeam = team[povId()];
  const roundOk = n => f.rounds === 'all' || (f.rounds === 'h0' ? half.get(n) === 0 : f.rounds === 'h1' ? half.get(n) === 1
    : f.rounds === 'ot' ? half.get(n) >= 2 : f.rounds === 'pistol' ? pistol.has(n) : `r${n}` === f.rounds);
  const ok = (round, id, side, w) => roundOk(round) && (f.player === 'all' || id === f.player)
    && (f.team === 'all' || (f.team === 'mine') === (team[id] === myTeam)) && (f.side === 'all' || side === f.side)
    && (f.type === 'all' || wpType(w) === f.type);
  const by = new Map();
  const row = w => by.get(w) || by.set(w, { w, type: wpType(w), kills: 0, hs: 0, wall: 0, smoke: 0, noscope: 0, blind: 0, air: 0, distSum: 0, distN: 0,
    dmg: 0, hits: 0, bodyHits: 0, headHits: 0, shotHits: 0, shots: 0, groups: {} }).get(w);
  for (const [round, id, side, w, flags, dist] of v.kills) {
    if (!ok(round, id, side, w)) continue;
    const r = row(w);
    r.kills++;
    if (flags & 1) r.hs++; if (flags & 2) r.wall++; if (flags & 4) r.smoke++; if (flags & 8) r.noscope++; if (flags & 16) r.blind++; if (flags & 32) r.air++;
    if (dist != null) { r.distSum += dist; r.distN++; }
  }
  for (const [round, id, side, w, group, dmg, , first] of v.hits) {
    if (!ok(round, id, side, w)) continue;
    const r = row(w);
    r.dmg += dmg; r.hits++;
    if (group !== 'generic') {
      r.bodyHits++; r.shotHits += first;
      if (group === 'head') r.headHits++;
      const g = r.groups[group] ||= [0, 0];
      g[0]++; g[1] += dmg;
    }
  }
  for (const [round, id, side, w, n] of v.shots) if (ok(round, id, side, w)) row(w).shots += n;
  return { rows: [...by.values()].filter(r => r.kills || r.dmg || r.shots), myTeam };
}

const sumRows = rows => {
  const t = { kills: 0, hs: 0, dmg: 0, bodyHits: 0, headHits: 0, shotHits: 0, shots: 0, groups: {} };
  for (const r of rows) {
    for (const k of ['kills', 'hs', 'dmg', 'bodyHits', 'headHits', 'shotHits']) t[k] += r[k];
    if (r.type !== 'grenades' && r.type !== 'other') t.shots += r.shots;
    for (const [g, [n, d]] of Object.entries(r.groups)) { const x = t.groups[g] ||= [0, 0]; x[0] += n; x[1] += d; }
  }
  return t;
};
const pctTxt = (a, b, digits = 1) => (b ? `${(100 * a / b).toFixed(digits)}%` : '—');
const accuracyOf = r => (r.shots && r.type !== 'grenades' && r.type !== 'other' ? r.shotHits / r.shots : null);

// [key, header, tooltip, sort value, display, cell class]
const WP_METRICS = {
  general: [
    ['kills', 'Kills', 'Enemies killed', r => r.kills],
    ['dmg', 'Damage', 'Damage dealt to enemies (capped at the health they had left)', r => r.dmg, r => fmtNum(r.dmg)],
    ['head', 'Head hit %', 'Share of the bullets that hit someone that hit the head', r => (r.bodyHits ? r.headHits / r.bodyHits : -1),
      r => pctTxt(r.headHits, r.bodyHits), r => (r.bodyHits >= 10 ? aimLevel(AIM_STATS[3], r.headHits / r.bodyHits) : '')],
    ['dist', 'Avg dist', 'Average distance of the kills', r => (r.distN ? r.distSum / r.distN : -1), r => (r.distN ? `${(r.distSum / r.distN).toFixed(1)}m` : '—')],
  ],
  accuracy: [
    ['shots', 'Shots', 'Bullets fired', r => r.shots],
    ['hits', 'Hits', 'Bullet hits on enemies (each shotgun pellet counts)', r => r.bodyHits],
    ['acc', 'Accuracy', 'Bullets that hit an enemy, of all bullets fired (a shotgun blast counts once)', r => accuracyOf(r) ?? -1, r => (accuracyOf(r) == null ? '—' : pctTxt(r.shotHits, r.shots))],
    ['dph', 'Dmg / hit', 'Average damage of a hit', r => (r.hits ? r.dmg / r.hits : -1), r => (r.hits ? (r.dmg / r.hits).toFixed(1) : '—')],
  ],
  kills: [
    ['hs', 'Headshots', 'Kills with a headshot', r => r.hs, r => (r.kills ? `${r.hs} · ${pctTxt(r.hs, r.kills, 0)}` : '—')],
    ['wall', 'Wallbang', 'Kills through a wall or object', r => r.wall],
    ['smoke', 'Smoke', 'Kills through a smoke', r => r.smoke],
    ['noscope', 'No-scope', 'Sniper kills without scoping in', r => r.noscope],
    ['blind', 'Blind', 'Kills while flashed', r => r.blind],
    ['air', 'In air', 'Kills while jumping or falling', r => r.air],
  ],
};
const WP_METRIC_TABS = [['general', 'General'], ['accuracy', 'Accuracy'], ['kills', 'Kill type']];

function weaponsView() {
  const st = weaponsData();
  if (!st) return h('div', { class: 'empty' }, spinner(24), h('h2', {}, 'Adding up every bullet…'));
  if (st.error) return h('div', { class: 'empty' }, h('h2', {}, 'No weapon stats for this demo'), h('div', { class: 'err-box' }, st.error));
  const root = h('div', { class: 'wp' });
  paintWeapons(root, st.value);
  return root;
}

function paintWeapons(root, v) {
  const wp = state.wp, repaint = () => paintWeapons(root, v);
  const pov = povId();
  const f = { rounds: 'all', team: 'all', side: 'all', type: 'all', ...wp.f };
  f.player = wp.f.player ?? (v.players.some(p => p.steamid === pov) ? pov : 'all');
  const { rows, myTeam } = weaponRows(v, f);
  const metric = WP_METRICS[wp.metric] ? wp.metric : 'general';
  const cols = WP_METRICS[metric];
  const sort = wp.sort?.metric === metric ? wp.sort : { metric, col: cols[0][0], dir: -1 };
  const col = cols.find(c => c[0] === sort.col) || cols[0];
  rows.sort((a, b) => sort.dir * (col[3](a) - col[3](b)) || b.kills - a.kills || b.dmg - a.dmg);

  const sel = rows.filter(r => wp.sel.has(r.w));
  const shown = sel.length ? sel : rows;
  const tot = sumRows(shown), all = sumRows(rows);

  // ---- filters
  const setF = (k, val) => { wp.f = { ...wp.f, [k]: val }; repaint(); };
  const halves = new Set(v.rounds.map(r => r.half));
  const teamName = t => (myTeam ? (t === myTeam ? 'Your team' : 'Opponents') : `Team ${t}`);
  const players = [...v.players].sort((a, b) => (b.team === myTeam) - (a.team === myTeam) || a.name.localeCompare(b.name));
  const types = new Set(weaponRows(v, { ...f, type: 'all' }).rows.map(r => r.type));
  const filters = h('div', { class: 'filters wp-filters' },
    select(f.rounds, [['all', 'All rounds'], ['h0', 'First half'], ...(halves.has(1) ? [['h1', 'Second half']] : []), ...(halves.has(2) ? [['ot', 'Overtime']] : []),
      ['pistol', 'Pistol rounds'], ...v.rounds.map(r => [`r${r.num}`, `Round ${r.num}`])], x => setF('rounds', x)),
    select(f.player, [['all', 'All players'], ...players.map(p => [p.steamid, `${p.name}${p.steamid === pov ? ' (point of view)' : ''}`])], x => setF('player', x)),
    select(f.team, [['all', 'Both teams'], ['mine', myTeam ? 'Your team' : 'Team of the point of view'], ['theirs', 'Opponents']], x => setF('team', x)),
    select(f.side, [['all', 'Both sides'], ['T', 'T side'], ['CT', 'CT side']], x => setF('side', x)),
    select(f.type, [['all', 'All weapon types'], ...WP_TYPES.filter(([k]) => types.has(k) || k === f.type)], x => setF('type', x)),
    h('span', { class: 'spacer' }),
    Object.keys(wp.f).length ? h('button', { class: 'link-btn', onclick: () => { wp.f = {}; repaint(); } }, 'Reset filters') : null);

  // ---- totals (of the selected weapons, else of everything shown)
  const kpi = (k, val, sub, tip) => h('div', { class: 'wp-kpi', title: tip || '' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, val, sub ? h('small', {}, sub) : null));
  const kpis = h('div', { class: 'wp-kpis' },
    kpi('Total kills', fmtNum(tot.kills)),
    kpi('Total damage', fmtNum(tot.dmg)),
    kpi('Headshot rate', pctTxt(tot.hs, tot.kills), `${tot.hs} HS`, 'Kills with a headshot'),
    kpi('Total hits', fmtNum(tot.bodyHits), null, 'Bullet hits on enemies'),
    kpi('Accuracy', pctTxt(tot.shotHits, tot.shots), `${fmtNum(tot.shots)} shots`, 'Bullets that hit an enemy, of all bullets fired with guns'));

  // ---- weapon list
  const grid = { style: { '--wp-cols': cols.length } };
  const share = r => (all.kills ? r.kills / all.kills : all.dmg ? r.dmg / all.dmg : 0);
  const toggle = w => { wp.sel.has(w) ? wp.sel.delete(w) : wp.sel.add(w); repaint(); };
  const head = h('div', { class: 'wp-row wp-cols', ...grid }, h('span'), h('span', { class: 'wp-sel-info' },
    sel.length ? [`${sel.length} selected · `, h('button', { class: 'link-btn', onclick: () => { wp.sel.clear(); repaint(); } }, 'clear')] : 'Click weapons to compare them'),
  ...cols.map(([k, label, tip]) => h('button', { class: `wp-th ${sort.col === k ? 'on' : ''}`, title: tip,
    onclick: () => { wp.sort = { metric, col: k, dir: sort.col === k ? -sort.dir : -1 }; repaint(); } }, sort.col === k ? (sort.dir < 0 ? '▾ ' : '▴ ') : '', label)));
  const list = rows.map(r => h('div', { class: `wp-row ${wp.sel.has(r.w) ? 'on' : sel.length ? 'dim' : ''}`, ...grid, onclick: () => toggle(r.w), title: wp.sel.has(r.w) ? 'Click to unselect' : 'Click to select' },
    h('span', { class: 'wp-ic' }, weaponIcon(r.w)),
    h('span', { class: 'wp-name' },
      h('span', { class: 'wp-name-top' }, h('b', {}, wpName(r.w)), h('span', { class: 'wp-chip' }, (WP_TYPES.find(t => t[0] === r.type) || [, ''])[1])),
      h('span', { class: 'wp-share' }, h('span', { class: 'wp-track' }, h('i', { style: { width: `${100 * share(r)}%` } })), `${(100 * share(r)).toFixed(1)}%`)),
    ...cols.map(([, , , val, fmt, cls]) => h('span', { class: `wp-td ${cls ? cls(r) : ''}` }, fmt ? fmt(r) : val(r)))));

  const left = h('div', { class: 'wp-main' },
    h('div', { class: 'wp-metrics' }, h('span', { class: 'wp-label' }, 'Metrics'), h('span', { class: 'spacer' }),
      h('div', { class: 'tabs' }, ...WP_METRIC_TABS.map(([k, l]) => h('button', { class: metric === k ? 'on' : '', onclick: () => { wp.metric = k; repaint(); } }, l)))),
    head,
    ...(list.length ? list : [h('div', { class: 'muted-note' }, 'No kills, damage or shots with these filters.')]));

  root.replaceChildren(filters, kpis, h('div', { class: 'wp-layout' }, left, hitPanel(tot, sel, rows)));
}

// The body with each hit group shaded by its share of the hits, and the numbers under it.
function hitPanel(t, sel, rows) {
  const wp = state.wp;
  const total = Object.values(t.groups).reduce((a, [n]) => a + n, 0);
  const max = Math.max(1, ...Object.values(t.groups).map(([n]) => n));
  const fill = g => { const n = t.groups[g]?.[0] || 0; return n ? `color-mix(in srgb, var(--accent) ${Math.round(22 + 78 * n / max)}%, var(--panel-3))` : 'var(--panel-3)'; };
  const title = !sel.length ? 'All weapons' : sel.length <= 3 ? sel.map(r => wpName(r.w)).join(', ') : `${sel.length} weapons`;
  const sub = `${sel.length || rows.length} weapon${(sel.length || rows.length) === 1 ? '' : 's'}`;
  const tip = g => { const [n, d] = t.groups[g] || [0, 0]; return `${REGIONS.find(r => r[0] === g)[1]}: ${n} hit${n === 1 ? '' : 's'} · ${fmtNum(d)} damage · ${pctTxt(n, total)}`; };
  const R = 'M58 86C48 88 41 98 38 112L30 176L22 234C21 246 26 253 31 253C36 253 39 246 39 236L46 180L55 128L58 100Z';
  const L = 'M63 210C78 218 94 219 99 217L98 300L95 392C96 404 93 412 84 412C74 412 70 405 72 392L68 300L62 240Z';
  const part = (g, d, mirror) => `<path class="rg" data-g="${g}" d="${d}" ${mirror ? 'transform="matrix(-1 0 0 1 200 0)"' : ''} style="fill:${fill(g)}"><title>${tip(g)}</title></path>`;
  const body = h('div', { class: 'wp-body', html: `<svg viewBox="0 0 200 420">
    <ellipse class="rg" data-g="head" cx="100" cy="34" rx="20" ry="25" style="fill:${fill('head')}"><title>${tip('head')}</title></ellipse>
    ${part('neck', 'M90 56H110L112 76H88Z')}
    ${part('chest', 'M66 80C80 74 120 74 134 80L142 88L140 150C126 156 74 156 60 150L58 88Z')}
    ${part('stomach', 'M60 150C74 156 126 156 140 150L137 208C122 216 78 216 63 208Z')}
    ${part('right_arm', R)}${part('left_arm', R, true)}${part('right_leg', L)}${part('left_leg', L, true)}
    <text x="14" y="276" class="wp-side">R</text><text x="186" y="276" class="wp-side">L</text></svg>` });

  const regions = REGIONS.filter(([g]) => g !== 'neck' || t.groups.neck);
  const table = h('table', { class: 'wp-regions' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Region'), h('th', {}, 'Hits'), h('th', {}, 'Dmg'), h('th', {}, '%'))),
    h('tbody', {}, ...regions.map(([g, label]) => { const [n, d] = t.groups[g] || [0, 0]; return h('tr', { 'data-g': g },
      h('td', {}, h('i', { class: 'wp-dot', style: { background: fill(g) } }), label), h('td', {}, n), h('td', {}, fmtNum(d)), h('td', {}, pctTxt(n, total))); })));

  // Hovering a region lights its row and the other way round (no repaint).
  const panel = h('aside', { class: 'wp-panel' },
    h('div', { class: 'wp-label' }, 'Hit distribution'),
    h('div', { class: 'wp-ptitle' }, title), h('div', { class: 'wp-psub' }, sub),
    h('div', { class: 'wp-mini' }, ...[['Kills', t.kills], ['Hits', t.bodyHits], ['Damage', t.dmg]].map(([k, n]) => h('div', {}, h('b', {}, fmtNum(n)), h('span', {}, k)))),
    body, table);
  const light = g => { wp.hover = g; panel.querySelectorAll('[data-g]').forEach(el => el.classList.toggle('hl', el.dataset.g === g)); };
  panel.addEventListener('mouseover', e => { const el = e.target.closest('[data-g]'); light(el ? el.dataset.g : null); });
  panel.addEventListener('mouseleave', () => light(null));
  return panel;
}
