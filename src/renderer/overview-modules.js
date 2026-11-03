/* global h, card, barList, big, kv, pct, fmtNum, fmtDate, mapName, mapThumb, openMatch, selectPlayer, avatar, weaponIcon, RATING_LEVELS, overviewMedian, qualityClass, ratingClass, state, renderOverview */
// Optional Overview modules: each one is added from the editor's "+" chips. They read the filtered matches
// (`list`, newest first) and their totals (`t`, from aggregate()).
const OverviewModules = (() => {
  const empty = (title, note) => card(title, h('div', { class: 'muted-note' }, note));
  const winRate = x => pct(x.won, x.played);
  const rating = x => (x.ratingRounds ? x.ratingSum / x.ratingRounds : null);
  const fmtR = r => (r == null ? '—' : r.toFixed(2));
  const quarter = vals => (vals.length ? [...vals].sort((a, b) => a - b)[Math.floor((vals.length - 1) / 4)] : null);
  const ms = v => (v == null ? '—' : `${Math.round(v)} ms`);
  const byResult = rows => {
    const g = { played: 0, won: 0, lost: 0, ratingSum: 0, ratingRounds: 0 };
    for (const m of rows) {
      g.played++; if (m.result === 'W') g.won++; if (m.result === 'L') g.lost++;
      if (m.rating != null) { g.ratingSum += m.rating * m.rounds; g.ratingRounds += m.rounds; }
    }
    return g;
  };
  const groupRow = (label, g, extra = {}) => ({
    label, value: g.played ? `${winRate(g)}%` : '—', note: g.played ? `${g.won}–${g.lost} · ${fmtR(rating(g))}` : 'no matches',
    frac: g.played ? g.won / g.played : 0, cls: g.played ? qualityClass(winRate(g), 55, 45) : '',
    title: `${label}: ${g.played} match${g.played === 1 ? '' : 'es'}, ${g.won} won, ${g.lost} lost · rating ${fmtR(rating(g))}`, ...extra,
  });
  // Clicking a map narrows the whole Overview to it (the same as the map filter).
  const pickMap = map => () => { state.ov.map = map; renderOverview(); };

  // ---------- Rounds & duels ----------
  function aimTiming({ t }) {
    const { reaction, ttd } = t.aim;
    if (!reaction.length && !ttd.length) return empty('Aim timing', 'No aim samples in these matches yet. They come from the aim analysis of each demo.');
    return card('Aim timing', [
      big(reaction.length ? Math.round(overviewMedian(reaction)) : '—', reaction.length ? 'ms' : null, `median reaction · ${fmtNum(reaction.length)} samples`),
      kv([
        ['Reaction, fastest 25%', ms(quarter(reaction))],
        ['Time to damage', ms(overviewMedian(ttd))],
        ['Damage, fastest 25%', ms(quarter(ttd))],
        ['Damage samples', fmtNum(ttd.length)],
      ]),
    ]);
  }
  function headshots({ t }) {
    const rate = pct(t.hs, t.kills);
    const best = Object.entries(t.weapons).filter(([w, [k]]) => k >= 10 && !NO_AIM.has(w)).sort((a, b) => b[1][1] / b[1][0] - a[1][1] / a[1][0])[0];
    return card('Headshots', [
      big(`${rate}`, '%', `${fmtNum(t.hs)} of ${fmtNum(t.kills)} kills`),
      kv([
        ['Headshot kills / round', t.rounds ? (t.hs / t.rounds).toFixed(2) : '—'],
        ['Best weapon', best ? `${best[0]} · ${pct(best[1][1], best[1][0])}%` : '—'],
      ]),
    ]);
  }
  function utilityUse({ t }) {
    return card('Utility', [
      big(t.rounds ? (t.utility / t.rounds).toFixed(1) : '—', null, 'utility damage per round'),
      kv([
        ['Utility damage', fmtNum(t.utility)],
        ['Enemies flashed', fmtNum(t.flashed)],
        ['Flashed / round', t.rounds ? (t.flashed / t.rounds).toFixed(2) : '—'],
        ['Flash assists', fmtNum(t.flashAssists)],
      ]),
    ]);
  }
  function impact({ t }) {
    const r = n => (t.rounds ? (n / t.rounds).toFixed(2) : '—');
    return card('Impact per round', [
      big(r(t.kills), null, 'kills per round'),
      kv([
        ['Deaths / round', r(t.deaths)],
        ['Assists / round', r(t.assists)],
        ['Damage / round', t.rounds ? t.adr.toFixed(1) : '—'],
        ['Trade kills / round', r(t.trades)],
        ['Opening kills / round', r(t.fk)],
      ]),
    ]);
  }

  // ---------- Maps ----------
  const mapRows = t => Object.values(t.maps).sort((a, b) => b.played - a.played || a.map.localeCompare(b.map));
  function mapPool({ t }) {
    return card('Map pool', barList(mapRows(t).slice(0, 8).map(mp => groupRow(mapName(mp.map), mp, { onclick: pickMap(mp.map) })),
      { empty: 'No maps yet' }), { extra: h('span', { class: 'hint' }, 'click a map to filter') });
  }
  function mapRating({ t }) {
    const rows = mapRows(t).filter(mp => rating(mp) != null).sort((a, b) => rating(b) - rating(a)).slice(0, 8);
    return card('Rating by map', barList(rows.map(mp => ({
      label: mapName(mp.map), value: fmtR(rating(mp)), note: `${mp.played} match${mp.played === 1 ? '' : 'es'}`,
      frac: rating(mp) / 2, cls: ratingClass(rating(mp)), onclick: pickMap(mp.map),
      title: `${mapName(mp.map)}: rating ${fmtR(rating(mp))} over ${mp.rounds} rounds`,
    })), { empty: 'No rated matches yet' }));
  }
  function mapSides({ t }) {
    const rows = mapRows(t).filter(mp => mp.side.T.rounds + mp.side.CT.rounds).slice(0, 8).map(mp => {
      const T = pct(mp.side.T.won, mp.side.T.rounds), CT = pct(mp.side.CT.won, mp.side.CT.rounds);
      const best = CT >= T ? 'CT' : 'T';
      return {
        label: mapName(mp.map), value: `${best} ${Math.max(T, CT)}%`, note: `${best === 'CT' ? 'T' : 'CT'} ${Math.min(T, CT)}%`,
        frac: Math.max(T, CT) / 100, fillCls: best.toLowerCase(), onclick: pickMap(mp.map),
        title: `${mapName(mp.map)}: T side ${T}% of ${mp.side.T.rounds} rounds · CT side ${CT}% of ${mp.side.CT.rounds} rounds`,
      };
    });
    return card('Best side per map', barList(rows, { empty: 'No rounds yet' }));
  }
  function mapExtremes({ t }) {
    const all = mapRows(t), min = all.some(mp => mp.played >= 3) ? 3 : 1;
    const ranked = all.filter(mp => mp.played >= min).sort((a, b) => winRate(b) - winRate(a) || (rating(b) ?? 0) - (rating(a) ?? 0));
    if (ranked.length < 2) return empty('Best & worst map', 'Play at least two maps to compare them.');
    const block = (mp, kind) => h('button', { class: `ov-extreme ${kind}`, type: 'button', onclick: pickMap(mp.map), title: `Show only ${mapName(mp.map)}` },
      mapThumb(mp.map),
      h('span', { class: 'ov-extreme-t' }, h('small', {}, kind === 'good' ? 'Best map' : 'Worst map'), h('b', {}, mapName(mp.map)),
        h('span', {}, `${winRate(mp)}% won · ${mp.won}–${mp.lost} · rating ${fmtR(rating(mp))}`)));
    return card('Best & worst map', h('div', { class: 'ov-extremes' }, block(ranked[0], 'good'), block(ranked[ranked.length - 1], 'bad')),
      { extra: min > 1 ? h('span', { class: 'hint' }, '3+ matches') : null });
  }

  // ---------- Weapons ----------
  const CODES = {
    Knife: 'knife', Zeus: 'taser', P2000: 'hkp2000', 'USP-S': 'usp_silencer', 'M4A1-S': 'm4a1_silencer', M4A4: 'm4a1', CZ75: 'cz75a',
    Deagle: 'deagle', R8: 'revolver', 'MP5-SD': 'mp5sd', Scout: 'ssg08', AWP: 'awp', 'AK-47': 'ak47', Galil: 'galilar', FAMAS: 'famas',
    AUG: 'aug', 'SG 553': 'sg556', Glock: 'glock', P250: 'p250', 'Five-SeveN': 'fiveseven', 'Tec-9': 'tec9', Dualies: 'elite',
    'MAC-10': 'mac10', MP9: 'mp9', MP7: 'mp7', 'UMP-45': 'ump45', P90: 'p90', 'PP-Bizon': 'bizon', Nova: 'nova', XM1014: 'xm1014',
    'MAG-7': 'mag7', 'Sawed-Off': 'sawedoff', M249: 'm249', Negev: 'negev', G3SG1: 'g3sg1', 'SCAR-20': 'scar20',
    HE: 'hegrenade', Molotov: 'molotov', Incendiary: 'incgrenade',
  };
  const TYPES = [
    ['Rifles', ['AK-47', 'M4A4', 'M4A1-S', 'Galil', 'FAMAS', 'AUG', 'SG 553']],
    ['Snipers', ['AWP', 'Scout', 'G3SG1', 'SCAR-20']],
    ['Pistols', ['Glock', 'USP-S', 'P2000', 'P250', 'Five-SeveN', 'Tec-9', 'CZ75', 'Deagle', 'R8', 'Dualies']],
    ['SMGs', ['MAC-10', 'MP9', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon']],
    ['Shotguns & heavy', ['Nova', 'XM1014', 'MAG-7', 'Sawed-Off', 'M249', 'Negev']],
    ['Grenades & Zeus', ['HE', 'Molotov', 'Incendiary', 'Zeus']],
    ['Knife', ['Knife']],
  ];
  const NO_AIM = new Set(['HE', 'Molotov', 'Incendiary', 'Knife', 'Zeus', 'World', '?']);
  const gun = w => h('span', { class: 'ov-wpn', 'aria-hidden': 'true' }, CODES[w] ? weaponIcon(CODES[w]) : null);
  const weaponRows = t => Object.entries(t.weapons).filter(([w]) => w !== 'World' && w !== '?').map(([w, [k, hs]]) => ({ w, k, hs }));
  function topWeapons({ t }) {
    const rows = weaponRows(t).sort((a, b) => b.k - a.k).slice(0, 7), max = rows[0]?.k || 1;
    return card('Top weapons', barList(rows.map(x => ({
      lead: gun(x.w), label: x.w, value: fmtNum(x.k), note: NO_AIM.has(x.w) ? '' : `${pct(x.hs, x.k)}% HS`, frac: x.k / max,
      title: `${x.w}: ${x.k} kills, ${x.hs} headshots (${pct(x.k, t.kills)}% of your kills)`,
    })), { empty: 'No kills yet' }));
  }
  function weaponTypes({ t }) {
    const kills = new Map(weaponRows(t).map(x => [x.w, x.k]));
    const rows = TYPES.map(([label, names]) => [label, names.reduce((s, w) => s + (kills.get(w) || 0), 0)]).filter(([, k]) => k);
    return card('Kills by weapon type', barList(rows.sort((a, b) => b[1] - a[1]).map(([label, k]) => ({
      label, value: `${pct(k, t.kills)}%`, note: `${fmtNum(k)} kills`, frac: t.kills ? k / t.kills : 0,
      title: `${label}: ${k} of your ${t.kills} kills`,
    })), { empty: 'No kills yet' }));
  }
  function weaponHs({ t }) {
    const aimed = weaponRows(t).filter(x => !NO_AIM.has(x.w)), min = aimed.some(x => x.k >= 10) ? 10 : 3;
    const rows = aimed.filter(x => x.k >= min).sort((a, b) => b.hs / b.k - a.hs / a.k).slice(0, 7);
    return card('Headshot % by weapon', barList(rows.map(x => ({
      lead: gun(x.w), label: x.w, value: `${pct(x.hs, x.k)}%`, note: `${x.hs}/${x.k}`, frac: x.hs / x.k, cls: qualityClass(pct(x.hs, x.k), 50, 35),
      title: `${x.w}: ${x.hs} headshots in ${x.k} kills`,
    })), { empty: 'Needs a few kills per weapon' }), { extra: h('span', { class: 'hint' }, `${min}+ kills`) });
  }

  // ---------- Squad ----------
  const mateRow = x => ({
    lead: avatar(x.name, x.id, 'xs'), label: x.name || x.id, value: `${winRate(x)}%`, note: `${x.played} together`,
    frac: x.won / x.played, cls: qualityClass(winRate(x), 55, 45), onclick: () => selectPlayer(x.id),
    title: `${x.name}: ${x.played} matches on your team, ${x.won} won, ${x.lost} lost · click to see their stats`,
  });
  function mates({ t }) {
    const rows = Object.values(t.mates).sort((a, b) => b.played - a.played || b.won - a.won).slice(0, 7);
    return card('Frequent teammates', barList(rows.map(mateRow), { empty: 'No teammates yet' }));
  }
  function duos({ t }) {
    const rows = Object.values(t.mates).filter(x => x.played >= 3).sort((a, b) => winRate(b) - winRate(a) || b.played - a.played).slice(0, 7);
    return card('Best duos', barList(rows.map(mateRow), { empty: 'Play 3+ matches with someone' }), { extra: h('span', { class: 'hint' }, '3+ matches') });
  }

  // ---------- Habits & records ----------
  function streaks({ list }) {
    if (!list.length) return empty('Streaks', 'No matches yet.');
    const current = list[0].result;
    let n = 0;
    while (n < list.length && list[n].result === current) n++;
    const longest = r => { let best = 0, run = 0; for (const m of list) { run = m.result === r ? run + 1 : 0; best = Math.max(best, run); } return best; };
    const word = { W: ['win', 'good'], L: ['loss', 'bad'], T: ['tie', ''] }[current] || ['', ''];
    return card('Streaks', [
      h('div', { class: 'big-line' }, h('span', { class: `big ${word[1]}` }, n, h('small', {}, current)), h('span', { class: 'big-note' }, `current ${word[0]} streak`)),
      kv([['Longest win streak', fmtNum(longest('W')), 'good'], ['Longest loss streak', fmtNum(longest('L')), 'bad']]),
    ]);
  }
  function records({ list }) {
    if (!list.length) return empty('Personal bests', 'No matches yet.');
    const top = f => list.reduce((best, m) => (f(m) != null && (best == null || f(m) > f(best)) ? m : best), null);
    const rows = [
      ['Best rating', top(m => m.rating), m => fmtR(m.rating)],
      ['Most kills', top(m => m.kills), m => `${m.kills} kills`],
      ['Highest ADR', top(m => (m.rounds ? m.damage / m.rounds : null)), m => `${(m.damage / m.rounds).toFixed(0)} ADR`],
      ['Most headshots', top(m => m.hsKills), m => `${m.hsKills} HS`],
      ['Most multi-kills', top(m => Object.values(m.multi).reduce((a, b) => a + b, 0)), m => `${Object.values(m.multi).reduce((a, b) => a + b, 0)} rounds`],
    ].filter(([, m]) => m);
    return card('Personal bests', h('div', { class: 'ov-records' }, ...rows.map(([label, m, value]) => h('button', {
      class: 'ov-record', type: 'button', onclick: () => openMatch(m), title: `${mapName(m.map)} ${m.score[0]}:${m.score[1]} · ${fmtDate(m.date)} · open the scoreboard`,
    }, h('span', { class: 'ov-record-k' }, label), h('b', {}, value(m)), h('small', {}, `${mapName(m.map)} · ${new Date(m.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`)))));
  }
  function ratingSpread({ list }) {
    const rated = list.filter(m => m.rating != null);
    if (!rated.length) return empty('Rating spread', 'No rated matches yet.');
    const counts = RATING_LEVELS.map(() => 0);
    for (const m of rated) counts[RATING_LEVELS.findIndex(([min]) => m.rating >= min)]++;
    const max = Math.max(...counts), cls = ['good', 'good', 'mid', 'bad', 'bad'];
    return card('Rating spread', barList(RATING_LEVELS.map(([min, label], i) => ({
      label, value: fmtNum(counts[i]), note: `${pct(counts[i], rated.length)}%`, frac: counts[i] / max, cls: cls[i],
      title: `${counts[i]} matches rated ${label.toLowerCase()}${Number.isFinite(min) ? ` (${min.toFixed(2)} or more)` : ''}`,
    }))));
  }
  function closeGames({ list }) {
    const margin = m => Math.abs(m.score[0] - m.score[1]);
    const groups = [['Close (≤3)', m => margin(m) <= 3, 'won or lost by 3 rounds or less'], ['Clear (4–7)', m => margin(m) >= 4 && margin(m) <= 7, 'decided by 4 to 7 rounds'],
      ['One-sided (8+)', m => margin(m) >= 8, 'decided by 8 rounds or more']];
    const close = byResult(list.filter(groups[0][1]));
    return card('Close games', [
      big(close.played ? `${winRate(close)}` : '—', close.played ? '%' : null, close.played ? `won of ${close.played} close match${close.played === 1 ? '' : 'es'}` : 'no close matches yet'),
      barList(groups.map(([label, f, what]) => { const g = byResult(list.filter(f)); return groupRow(label, g, { title: `${g.played} matches ${what}: ${g.won} won, ${g.lost} lost` }); })),
    ]);
  }
  function timeOfDay({ list }) {
    const slots = [['Morning', 6, 12], ['Afternoon', 12, 18], ['Evening', 18, 24], ['Night', 0, 6]];
    return card('Time of day', barList(slots.map(([label, a, b]) => {
      const g = byResult(list.filter(m => { const hour = new Date(m.date).getHours(); return hour >= a && hour < b; }));
      return groupRow(label, g, { title: `${label} (${a}:00 to ${b}:00): ${g.played} matches, ${g.won} won, ${g.lost} lost` });
    })), { extra: h('span', { class: 'hint' }, 'local time') });
  }
  function weekdays({ list }) {
    const names = [1, 2, 3, 4, 5, 6, 0].map(d => [d, new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'long' }).replace(/^./, c => c.toUpperCase())]);
    return card('Weekdays', barList(names.map(([d, label]) => groupRow(label, byResult(list.filter(m => new Date(m.date).getDay() === d))))));
  }
  function modes({ list }) {
    const by = new Map();
    for (const m of list) by.set(m.mode || 'Other', [...(by.get(m.mode || 'Other') || []), m]);
    const rows = [...by].sort((a, b) => b[1].length - a[1].length).map(([mode, ms]) => groupRow(mode, byResult(ms)));
    return card('Game modes', barList(rows, { empty: 'No matches yet' }));
  }

  return { aimTiming, headshots, utilityUse, impact, mapPool, mapRating, mapSides, mapExtremes, topWeapons, weaponTypes, weaponHs,
    mates, duos, streaks, records, ratingSpread, closeGames, timeOfDay, weekdays, modes };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = OverviewModules;
