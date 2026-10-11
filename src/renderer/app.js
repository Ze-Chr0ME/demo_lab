/* global api */
'use strict';

// ---------- Helpers ----------
const $ = sel => document.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (d, extra = '') => { const s = document.createElement('span'); s.innerHTML = `<svg viewBox="0 0 24 24" ${extra}>${d}</svg>`; return s.firstChild; };
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" stroke="currentColor" stroke-width="1.8"/>',
  demo: '<path d="M4 5h16v14H4zM4 9h16M9 5v14" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'error'); return undefined; }
}

const MAPS = {
  de_dust2: ['Dust II', '#c9a36b'], de_mirage: ['Mirage', '#d9a35f'], de_inferno: ['Inferno', '#c8693f'], de_nuke: ['Nuke', '#6b9ac9'],
  de_overpass: ['Overpass', '#6fa77a'], de_ancient: ['Ancient', '#5fa08a'], de_anubis: ['Anubis', '#d4b45a'], de_vertigo: ['Vertigo', '#8aa3c4'],
  de_train: ['Train', '#8c8f99'], cs_office: ['Office', '#9aa6b5'], cs_italy: ['Italy', '#c98c5a'], de_cache: ['Cache', '#7fa36b'],
  rush_001: ['Rush', '#c45b8a'],
};
const mapName = m => MAPS[m]?.[0] || (m || '?').replace(/^(de|cs|ar)_/, '').replace(/^\w/, c => c.toUpperCase());
const mapColor = m => MAPS[m]?.[1] || '#7a8494';
const fmtDate = ms => new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDur = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSize = b => `${(b / 1048576).toFixed(0)} MB`;
const stars = score => '★'.repeat(Math.max(1, Math.min(5, Math.round(score / 25)))) ;

// ---------- State ----------
const state = {
  env: null, settings: null, demos: [], search: '',
  demo: null, analysis: null, analyzing: false, player: null,
  selected: new Set(),
  clips: [], clipFilter: 'all', montageSel: [],
  recording: null,
};

// ---------- Navigation ----------
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'clips') loadClips();
  if (v === 'downloads') loadDownloads();
  if (v === 'settings') renderSettings();
  state.view = v;
}

// ---------- Status ----------
function renderStatus() {
  const e = state.env;
  const rows = [
    ['CS2', e.cs2Dir ? (e.cs2Running ? 'ok' : 'warn') : 'bad', e.cs2Dir ? (e.cs2Running ? 'Running' : 'Installed') : 'Not found'],
    ['Steam', e.mySteamId ? 'ok' : 'bad', state.player?.name || e.steamUser?.name || 'Unknown'],
    ['ffmpeg', e.ffmpeg ? 'ok' : 'bad', e.ffmpeg ? (e.encoder || '').replace('h264_', '').replace('lib', '') : 'Missing'],
    ['Recorder', e.hlae?.installed ? 'ok' : 'bad', e.hlae?.installed ? `HLAE ${e.hlae.version}` : 'HLAE missing'],
  ];
  $('#status').replaceChildren(...rows.map(([k, cls, v]) => h('div', { class: 'status-row' }, h('span', { class: `dot ${cls}` }), k, h('b', { title: v }, v))));
}

async function refreshEnv() {
  state.env = await api.env();
  renderStatus();
}

// ---------- Demos ----------
$('#demoSearch').addEventListener('input', e => { state.search = e.target.value.toLowerCase(); renderDemoList(); });
$('#refreshDemos').addEventListener('click', () => loadDemos());

async function loadDemos() {
  $('#demoListSub').textContent = 'Scanning…';
  state.demos = await guard(() => api.listDemos()) || [];
  // Demos the parser already rejected stay rejected (until the app's parser changes): don't retry them.
  for (const d of state.demos) if (d.failure) d.failed = true;
  if (state.demo) state.demo = state.demos.find(d => d.path === state.demo.path) || state.demo;
  renderDemoList();
  backgroundAnalyze();
}

// Parses demos one by one in the background so the list can show map + highlight counts.
let bgRunning = false;
async function backgroundAnalyze() {
  if (bgRunning) return;
  bgRunning = true;
  try {
    for (;;) {
      const next = state.demos.find(d => !d.summary && !d.failed);
      if (!next) break;
      try {
        const a = await api.analyze(next.path);
        next.summary = { map: a.map, highlights: a.highlights?.length ?? null, best: Math.max(0, ...(a.highlights || []).map(x => x.score)), score: a.score, stats: a.stats };
      } catch (e) {
        next.failed = true;
        const m = /Rush match \((\w+)\)/.exec(e.message);
        if (m) next.failure = { map: m[1] };
      }
      renderDemoList();
    }
  } finally { bgRunning = false; renderDemoList(); }
}

// The name shown for a demo: the user's custom name, else the map (once known), else the file name.
function demoTitle(d) {
  if (d.customName) return d.customName;
  if (d.summary) return mapName(d.summary.map);
  if (isRush(d)) return 'Rush match';
  return /^match730_/.test(d.name) ? 'Premier / MM match' : d.name.replace(/.dem$/i, '');
}

// Swaps a title element for a text box; Enter or leaving the box saves, Escape cancels.
function editName(d, el) {
  const input = h('input', { type: 'text', class: 'name-edit', value: d.customName || '', placeholder: d.summary ? mapName(d.summary.map) : d.name.replace(/.dem$/i, ''), maxlength: 80 });
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    if (save && input.value.trim() !== (d.customName || '')) {
      const name = await guard(() => api.renameDemo(d.path, input.value));
      if (name !== undefined) for (const x of state.demos) if (x.id === d.id) x.customName = name;
      d.customName = name ?? d.customName;
    }
    renderDemoList();
    if (state.demo?.id === d.id) renderDetail();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  el.replaceWith(input);
  input.focus();
  input.select();
}

const PENCIL = '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';

const isRush = d => /^rush/i.test(d?.failure?.map || '') || /Rush match/.test(d === state.demo ? state.analysisError || '' : '');

function renderDemoList() {
  const q = state.search;
  const list = state.demos.filter(d => !q || d.name.toLowerCase().includes(q) || mapName(d.summary?.map).toLowerCase().includes(q) || (d.customName || '').toLowerCase().includes(q));
  const pending = state.demos.filter(d => !d.summary && !d.failed).length;
  const total = state.demos.reduce((s, d) => s + (d.summary?.highlights || 0), 0);
  $('#demoListSub').replaceChildren(
    `${state.demos.length} demos · ${total} highlights`,
    pending ? h('span', {}, ' · ', h('span', { class: 'spinner', style: { width: '11px', height: '11px', borderWidth: '2px' } }), ` analyzing ${pending}…`) : '',
  );
  $('#demos').replaceChildren(...list.map(d => {
    const s = d.summary;
    const sc = s?.score;
    const res = sc ? (sc.mine > sc.enemy ? 'w' : sc.mine < sc.enemy ? 'l' : 'd') : null;
    const isMM = /^match730_/.test(d.name);
    const title = h('div', { class: 'demo-title', title: 'Double-click to rename', ondblclick: e => { e.stopPropagation(); editName(d, title); } }, demoTitle(d));
    const where = isRush(d) ? 'could not be read' : isMM ? 'Valve match' : d.name.replace(/\.dem$/i, '');
    return h('div', { class: `demo ${state.demo?.path === d.path ? 'active' : ''}`, onclick: () => openDemo(d) },
      h('div', { class: 'map-thumb', style: { background: s ? `linear-gradient(135deg, ${mapColor(s.map)}, #20242c)` : 'var(--panel-3)' } }, s ? mapName(s.map).slice(0, 3).toUpperCase() : isRush(d) ? 'RSH' : d.failed ? '!' : '…'),
      h('div', { style: { minWidth: 0 } },
        title,
        h('div', { class: 'demo-meta', title: d.path }, `${fmtDate(d.date)} · ${d.customName && s ? mapName(s.map) : where}`),
      ),
      h('div', { class: 'demo-right' },
        sc ? h('div', { class: `score-${res}` }, `${sc.mine}–${sc.enemy}`) : h('div', { class: 'score-d' }, s ? '—' : ''),
        s && s.highlights !== null ? h('span', { class: `hl-badge ${s.highlights ? '' : 'zero'}` }, `${s.highlights} ★`) : null,
      ));
  }));
}

async function openDemo(d, player, tab) {
  if (state.demo?.id !== d.id) { state.stats = null; state.tab = tab || 'highlights'; }
  state.demo = d;
  state.selected.clear();
  state.analyzing = true;
  state.analysis = null;
  renderDemoList();
  renderDetail();
  try {
    state.analysis = await api.analyze(d.path, player || undefined);
    state.player = state.analysis.player || null;
    // preselect strong highlights
    for (const hl of state.analysis.highlights || []) if (hl.score >= 40) state.selected.add(hl.id);
    state.analysisError = null;
  } catch (e) { state.analysisError = e.message; }
  state.analyzing = false;
  renderDetail();
  renderStatus();
}

function renderDetail() {
  const el = $('#detail');
  if (!state.demo) {
    el.replaceChildren(h('div', { class: 'empty' }, icon(ICONS.demo, 'class="big"'), h('h2', {}, 'Pick a match'),
      h('div', {}, 'Your Premier & matchmaking demos are found automatically. Download them in CS2 from Watch → Your Matches.')));
    return;
  }
  if (state.analyzing) {
    el.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner', style: { width: '28px', height: '28px' } }), h('h2', {}, 'Reading demo…'), h('div', {}, 'Looking for multi-kills, clutches and special kills.')));
    return;
  }
  const a = state.analysis;
  if (!a) {
    el.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Could not read this demo'),
      h('div', {}, isRush(state.demo)
        ? 'This Rush demo could not be read. If CS2 changed the Rush format again, the demo parser needs another update.'
        : 'The demo parser does not understand this file. This happens with new game modes or corrupted downloads.'),
      state.analysisError ? h('div', { class: 'err-box' }, state.analysisError) : null));
    return;
  }

  const d = state.demo;
  const playerSelect = h('select', { onchange: e => openDemo(d, e.target.value) },
    ...[...a.players].sort((x, y) => x.name.localeCompare(y.name)).map(p => h('option', { value: p.steamid, selected: a.player?.steamid === p.steamid }, p.name)));
  if (!a.playerFound) playerSelect.prepend(h('option', { value: '', selected: true, disabled: true }, 'Choose a player…'));

  const res = a.score ? (a.score.mine > a.score.enemy ? 'w' : a.score.mine < a.score.enemy ? 'l' : 'd') : 'd';
  const hero = h('div', { class: 'hero', style: { '--hero': `linear-gradient(120deg, ${mapColor(a.map)}, transparent)` } },
    h('div', { class: 'hero-top' },
      h('div', {},
        h('div', { class: 'title-row' },
          h('h1', {}, d.customName || mapName(a.map)),
          h('button', { class: 'icon-btn rename', title: 'Rename this match (only in ClipMaker, the file keeps its name)', onclick: e => editName(d, e.currentTarget.previousSibling) }, icon(PENCIL))),
        h('div', { class: 'sub' }, `${d.customName ? mapName(a.map) + ' · ' : ''}${fmtDate(d.date)} · ${a.rounds} rounds · ${fmtSize(d.size)}`),
      ),
      a.playerFound ? h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Score'), h('div', { class: `v score-${res}` }, `${a.score.mine} – ${a.score.enemy}`)),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'K / D'), h('div', { class: 'v' }, `${a.stats.kills} / ${a.stats.deaths}`)),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'HS %'), h('div', { class: 'v' }, `${a.stats.hsPct}%`)),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Highlights'), h('div', { class: 'v', style: { color: 'var(--accent-2)' } }, a.highlights.length)),
      ) : null,
    ),
    h('div', { class: 'player-pick' }, 'Point of view', playerSelect),
  );

  const tab = state.tab;
  const tabs = h('div', { class: 'tabs match-tabs' }, ...MATCH_TABS.map(([k, l]) =>
    h('button', { class: tab === k ? 'on' : '', onclick: () => { state.tab = k; renderDetail(); } }, l)));
  const body = tab === 'scoreboard' ? scoreboardView()
    : tab === 'duels' ? duelsView()
      : tab === 'heatmap' ? heatmapView()
        : tab === 'radar' ? radarView()
          : highlightsView(a);
  el.replaceChildren(
    h('div', { class: 'detail-scroll' }, hero, tabs, ...[body].flat()),
    ...(tab === 'highlights' ? [actionBar()] : []),
  );
}

const MATCH_TABS = [['highlights', 'Highlights'], ['scoreboard', 'Scoreboard'], ['duels', 'Duels'], ['heatmap', 'Heatmap'], ['radar', 'Radar']];
state.tab = 'highlights';

function highlightsView(a) {
  const hls = a.highlights || [];
  const list = !a.playerFound
    ? [h('div', { class: 'empty' }, h('h2', {}, 'You are not in this demo'), h('div', {}, 'Pick the player whose highlights you want above.'))]
    : !hls.length
      ? [h('div', { class: 'empty' }, h('h2', {}, 'No highlights in this match'), h('div', {}, 'No multi-kills, clutches or special kills with the current rules. You can loosen them in Settings.'))]
      : hls.map(hl => highlightCard(hl));
  const allOn = hls.length && hls.every(x => state.selected.has(x.id));
  return [
    hls.length ? h('div', { class: 'section-head' },
      h('h3', {}, 'Highlights'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link-btn', onclick: () => { allOn ? state.selected.clear() : hls.forEach(x => state.selected.add(x.id)); renderDetail(); } }, allOn ? 'Select none' : 'Select all'),
    ) : null,
    ...list,
  ];
}

// ---------- Match stats (scoreboard, duels) ----------
// Loaded once per demo when a stats tab is first shown; computed in the main process from cached data.
function matchStats() {
  const d = state.demo;
  if (state.stats?.id === d.id) return state.stats;
  if (state.statsLoading !== d.id) {
    state.statsLoading = d.id;
    api.stats(d.path)
      .then(v => { state.stats = { id: d.id, value: v }; })
      .catch(e => { state.stats = { id: d.id, error: e.message }; })
      .finally(() => { state.statsLoading = null; if (state.demo?.id === d.id) renderDetail(); });
  }
  return null;
}

function statsPending() {
  const st = matchStats();
  if (!st) return h('div', { class: 'empty' }, h('span', { class: 'spinner', style: { width: '24px', height: '24px' } }), h('h2', {}, 'Computing stats…'));
  if (st.error) return h('div', { class: 'empty' }, h('h2', {}, 'No stats for this demo'), h('div', { class: 'err-box' }, st.error));
  return null;
}

const teamLabel = t => t.mine ? 'Your team' : 'Opponents';
const pick = steamid => () => { if (state.analysis?.player?.steamid !== steamid) openDemo(state.demo, steamid); };
const ratingClass = r => r == null ? '' : r >= 1.15 ? 'good' : r < 0.85 ? 'bad' : '';

// [header, tooltip, sort value, display (optional), cell class (optional)]
// The compact view shows the first SB_BASIC columns plus Rating.
const SB_COLS = [
  ['K', 'Kills', p => p.kills],
  ['D', 'Deaths', p => p.deaths],
  ['A', 'Assists (flash assists are counted separately, see FA)', p => p.assists],
  ['+/-', 'Kills minus deaths', p => p.diff, p => (p.diff > 0 ? '+' : '') + p.diff, p => p.diff > 0 ? 'good' : p.diff < 0 ? 'bad' : ''],
  ['K/D', 'Kills per death', p => p.kd, p => p.kd.toFixed(2)],
  ['ADR', 'Average damage per round', p => p.adr, p => p.adr.toFixed(1)],
  ['HS%', 'Share of kills that were headshots', p => p.hsPct, p => p.hsPct + '%'],
  ['KAST', 'Rounds with a Kill, Assist, Survival or Trade', p => p.kast, p => p.kast.toFixed(0) + '%'],
  ['Rating', 'Approximation of HLTV Rating 2.0 (HLTV does not publish its formula; usually within ±0.02)', p => p.rating ?? 0, p => p.rating == null ? '—' : '≈' + p.rating.toFixed(2), p => ratingClass(p.rating)],
  ['FK', 'First kills (opening duels won)', p => p.firstKills],
  ['FD', 'First deaths (opening duels lost)', p => p.firstDeaths],
  ['Multi', 'Rounds with 2 / 3 / 4 / 5 kills', p => p.multi[2] + 2 * p.multi[3] + 4 * p.multi[4] + 8 * p.multi[5], p => [2, 3, 4, 5].map(n => p.multi[n]).join(' / ')],
  ['Clutch', 'Clutches won / played (last player alive on the team)', p => p.clutches.won * 10 + p.clutches.best, p => `${p.clutches.won} / ${p.clutches.played}`],
  ['Trades', 'Trade kills: killing an enemy who had just killed a teammate', p => p.tradeKills],
  ['UD', 'Utility damage (HE and molotov/incendiary)', p => p.utilityDamage],
  ['EF', 'Enemies flashed (for at least 0.5 s)', p => p.enemiesFlashed],
  ['FA', 'Flash assists', p => p.flashAssists],
];
const SB_BASIC = 9; // K … Rating

function scoreboardView() {
  const pending = statsPending();
  if (pending) return pending;
  const st = state.stats.value;
  const sort = state.sbSort || { col: 'Rating', dir: -1 };
  const col = SB_COLS.find(c => c[0] === sort.col) || SB_COLS.at(-1);
  const me = state.analysis?.player?.steamid;
  const detailed = !!state.sbDetailed;
  const cols = detailed ? SB_COLS : SB_COLS.slice(0, SB_BASIC);
  const table = t => {
    const other = st.teams.find(o => o !== t);
    const rows = [...t.players].sort((x, y) => sort.dir * (col[2](x) - col[2](y)) || x.name.localeCompare(y.name));
    return h('table', { class: 'sb' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'team' },
          h('span', { class: `team-score score-${t.score > other.score ? 'w' : t.score < other.score ? 'l' : 'd'}` }, t.score),
          teamLabel(t), h('span', { class: `side side-${t.startSide}` }, `started ${t.startSide}`)),
        ...cols.map(([k, tip]) => h('th', {
          title: tip, class: sort.col === k ? 'sorted' : '',
          onclick: () => { state.sbSort = { col: k, dir: sort.col === k ? -sort.dir : -1 }; renderDetail(); },
        }, k, sort.col === k ? (sort.dir < 0 ? ' ▾' : ' ▴') : '')))),
      h('tbody', {}, ...rows.map(p => h('tr', { class: p.steamid === me ? 'me' : '', title: `Show ${p.name}'s highlights`, onclick: pick(p.steamid) },
        h('td', { class: 'name' }, p.name),
        ...cols.map(([, , val, fmt, cls]) => h('td', { class: cls ? cls(p) : '' }, fmt ? fmt(p) : val(p)))))),
    );
  };
  return [
    h('div', { class: 'section-head' }, h('h3', {}, 'Scoreboard'),
      h('div', { class: 'tabs' }, ...[[false, 'Compact'], [true, 'Detailed']].map(([v, l]) =>
        h('button', { class: detailed === v ? 'on' : '', onclick: () => { state.sbDetailed = v; renderDetail(); } }, l))),
      h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Click a column to sort, a player to see their highlights. Hover a column for its meaning.')),
    ...st.teams.map(t => h('div', { class: 'sb-wrap' }, table(t))),
  ];
}

function duelsView() {
  const pending = statsPending();
  if (pending) return pending;
  const st = state.stats.value;
  const mode = state.duelMode || 'all';
  const m = mode === 'opening' ? st.openings : st.duels;
  const [rowsT, colsT] = st.teams;
  const n = (a, b) => m[a]?.[b] || 0;
  const me = state.analysis?.player?.steamid;
  const verdict = (k, d) => !k && !d ? 'none' : k > d ? 'good' : k < d ? 'bad' : 'even';
  const cell = (a, b) => {
    const k = n(a.steamid, b.steamid), d = n(b.steamid, a.steamid);
    return h('td', { class: `duel ${verdict(k, d)}`, title: `${a.name} killed ${b.name} ${k}×, died to them ${d}×` }, k || d ? `${k}–${d}` : '·');
  };
  const total = a => {
    let k = 0, d = 0;
    for (const b of colsT.players) { k += n(a.steamid, b.steamid); d += n(b.steamid, a.steamid); }
    return h('td', { class: `duel total ${verdict(k, d)}` }, `${k}–${d}`);
  };
  return [
    h('div', { class: 'section-head' },
      h('h3', {}, 'Duels'),
      h('div', { class: 'tabs' }, ...[['all', 'All kills'], ['opening', 'Opening duels']].map(([k, l]) =>
        h('button', { class: mode === k ? 'on' : '', onclick: () => { state.duelMode = k; renderDetail(); } }, l))),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, `Row player's kills on the column player – deaths to them${mode === 'opening' ? ', first kill of each round only' : ''}.`)),
    h('div', { class: 'sb-wrap' }, h('table', { class: 'sb duels' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'team' }, `${teamLabel(rowsT)} ↓  vs  ${teamLabel(colsT)} →`),
        ...colsT.players.map(b => h('th', { class: 'vert', title: b.name }, h('span', {}, b.name))),
        h('th', {}, 'Total'))),
      h('tbody', {}, ...rowsT.players.map(a => h('tr', { class: a.steamid === me ? 'me' : '', onclick: pick(a.steamid) },
        h('td', { class: 'name' }, a.name),
        ...colsT.players.map(b => cell(a, b)),
        total(a)))))),
  ];
}

// ---------- Radar images (shared by the heatmap and the 2D replay) ----------
// Bundled in radar/ by scripts/extract-radars.js: 1024 px images plus, per map, the world position of
// the image's upper-left corner and the world units per pixel. Two-floor maps have a _lower image.
const RADAR_SIZE = 1024;
let radarMaps = null;
const radarImages = new Map();
function radarInfo(map) {
  if (!radarMaps) {
    radarMaps = {};
    api.radarMaps().then(m => { radarMaps = m; renderDetail(); }).catch(() => {});
    return undefined; // still loading
  }
  return radarMaps[map] || radarMaps[(map || '').replace(/_(night|v\d)$/, '')] || null;
}
function radarImage(src) {
  if (!radarImages.has(src)) {
    const img = new Image();
    radarImages.set(src, new Promise(r => { img.onload = () => r(img); img.onerror = () => r(null); }));
    img.src = src;
  }
  return radarImages.get(src);
}
const radarName = (info, map) => Object.keys(radarMaps).find(k => radarMaps[k] === info) || map;
const toPx = (info, x, y) => [(x - info.x) / info.scale, (info.y - y) / info.scale];
// What one canvas shows: the whole map (optionally its lower floor) or, on Rush, one room's close-up.
function radarFrame(info, map, { room = null, lower = false } = {}) {
  const base = radarName(info, map);
  if (room && info.rooms?.[room]) return { ...info.rooms[room], src: `radar/${base}_${room}.png` };
  return { x: info.x, y: info.y, scale: info.scale, lowerBelow: info.lowerBelow, src: `radar/${base}${lower ? '_lower' : ''}.png` };
}
// The Rush room whose image covers the most of these world positions ([x, y] pairs).
function bestRoom(info, xy) {
  let best = null, most = 0;
  for (const [name, v] of Object.entries(info.rooms || {})) {
    const x1 = v.x + RADAR_SIZE * v.scale, y0 = v.y - RADAR_SIZE * v.scale;
    const n = xy.filter(([x, y]) => x >= v.x && x <= x1 && y >= y0 && y <= v.y).length;
    if (n > most) { most = n; best = name; }
  }
  return best;
}
const roomLabel = r => r === 'roomparty' ? 'Party room' : r === 'convoy' ? 'Convoy' : r.replace(/^room/, 'Room ');
function roomSelect(info, value, onchange, counts) {
  if (!info.rooms) return null;
  const rooms = Object.keys(info.rooms).filter(r => !counts || counts[r]).sort();
  return select(value, [['auto', 'Room: automatic'], ['overview', 'Whole hotel'], ...rooms.map(r => [r, roomLabel(r) + (counts ? ` (${counts[r]})` : '')])], onchange);
}
const onLower = (info, z) => info.lowerBelow !== undefined && z < info.lowerBelow;

// ---------- Heatmap ----------
const HEAT_LAYERS = [
  ['kill', 'Kill locations', '#3ee08f'],
  ['death', 'Death locations', '#ff3d5e'],
  ['shot', 'Shots', '#ffd23f'],
  ['dealt', 'Damage dealt', '#4cc9ff'],
  ['taken', 'Damage taken', '#ff8a3d'],
  ['smoke', 'Smokes', '#d9dee7'],
  ['flash', 'Flashes', '#fff59a'],
  ['he', 'HE grenades', '#ff6b6b'],
  ['molotov', 'Molotovs', '#ff9d2e'],
];
const WEAPON_KINDS = new Set([0, 2, 3]); // kill, shot, dealt: the weapon filter means "your weapon"
state.heat = { layers: new Set(['kill', 'death']), scope: 'match', weapon: 'all', floor: 'upper', room: 'auto', data: null, loading: null };

function heatData() {
  const steamid = state.analysis?.player?.steamid;
  const key = `${state.demo.id}|${steamid}|${state.heat.scope}`;
  const hs = state.heat;
  if (hs.data?.key === key) return hs.data;
  if (hs.loading !== key) {
    hs.loading = key;
    api.heat(state.demo.path, steamid, hs.scope)
      .then(v => { hs.data = { key, ...v }; })
      .catch(e => { hs.data = { key, error: e.message }; })
      .finally(() => { if (hs.loading === key) hs.loading = null; if (state.tab === 'heatmap') renderDetail(); });
  }
  return null;
}

function heatmapView() {
  const a = state.analysis;
  if (!a.playerFound) return h('div', { class: 'empty' }, h('h2', {}, 'Pick a player'), h('div', {}, 'Choose whose heatmap to show in "Point of view" above.'));
  const info = radarInfo(a.map);
  if (info === null) return h('div', { class: 'empty' }, h('h2', {}, 'No radar for this map'), h('div', {}, `There is no radar image for ${mapName(a.map)} yet. Run scripts/extract-radars.js after a CS2 update to add new maps.`));
  const data = info && heatData();
  if (!data) return h('div', { class: 'empty' }, h('span', { class: 'spinner', style: { width: '24px', height: '24px' } }), h('h2', {}, 'Loading heatmap…'));
  if (data.error) return h('div', { class: 'empty' }, h('h2', {}, 'No heatmap for this demo'), h('div', { class: 'err-box' }, data.error));

  const hs = state.heat;
  const weapons = [...new Set(data.points.filter(p => WEAPON_KINDS.has(p[0]) && p[2]).map(p => p[2]))].sort();
  if (hs.weapon !== 'all' && !weapons.includes(hs.weapon)) hs.weapon = 'all';
  const floors = info.lowerBelow !== undefined;
  const pts = data.points.filter(p =>
    (hs.weapon === 'all' || !WEAPON_KINDS.has(p[0]) || p[2] === hs.weapon) &&
    (!floors || onLower(info, p[5]) === (hs.floor === 'lower')));
  const count = k => pts.filter(p => HEAT_LAYERS[p[0]][0] === k).length;
  // Rush: show the room with the most points (or the one picked), points per room in the picker.
  let room = null, roomCounts = null;
  if (info.rooms) {
    const shown = pts.filter(p => hs.layers.has(HEAT_LAYERS[p[0]][0]));
    roomCounts = {};
    for (const p of shown) { const r = bestRoom(info, [[p[3], p[4]]]); if (r) roomCounts[r] = (roomCounts[r] || 0) + 1; }
    room = hs.room === 'auto' ? Object.entries(roomCounts).sort((x, y) => y[1] - x[1])[0]?.[0] || null : hs.room === 'overview' ? null : hs.room;
  }
  const frame = radarFrame(info, a.map, { room, lower: floors && hs.floor === 'lower' });

  const controls = h('div', { class: 'heat-controls' },
    h('div', { class: 'tabs' }, ...[['match', 'This match'], ['map', `All my ${mapName(a.map)} matches`]].map(([k, l]) =>
      h('button', { class: hs.scope === k ? 'on' : '', onclick: () => { hs.scope = k; renderDetail(); } }, l))),
    select(hs.weapon, [['all', 'All weapons'], ...weapons.map(w => [w, w])], v => { hs.weapon = v; renderDetail(); }),
    floors ? h('div', { class: 'tabs' }, ...[['upper', 'Upper floor'], ['lower', 'Lower floor']].map(([k, l]) =>
      h('button', { class: hs.floor === k ? 'on' : '', onclick: () => { hs.floor = k; renderDetail(); } }, l))) : null,
    roomSelect(info, hs.room, v => { hs.room = v; renderDetail(); }, roomCounts),
    h('span', { class: 'spacer' }),
    hs.scope === 'map' ? h('span', { class: 'hint' }, `${data.matches} analyzed match${data.matches === 1 ? '' : 'es'} with ${a.player.name}`) : null,
  );
  const layers = h('div', { class: 'chips heat-layers' }, ...HEAT_LAYERS.map(([k, l, color]) => {
    const on = hs.layers.has(k);
    return h('button', { class: `chip-toggle heat-chip ${on ? 'on' : ''}`, style: { '--c': color }, onclick: () => { on ? hs.layers.delete(k) : hs.layers.add(k); renderDetail(); } },
      h('span', { class: 'swatch' }), l, h('span', { class: 'n' }, count(k)));
  }));

  const maps = h('div', { class: 'heat-maps' }, ...[['T', 0], ['CT', 1]].map(([side, si]) => {
    const canvas = h('canvas', { width: RADAR_SIZE, height: RADAR_SIZE });
    const sidePts = pts.filter(p => p[1] === si);
    radarImage(frame.src).then(img => paintHeatmap(canvas, img, frame, sidePts, hs.layers));
    return h('div', { class: 'heat-map' }, h('div', { class: `heat-side side-${side}` }, `${side} side`, h('span', {}, ` · ${a.player.name}`)), canvas);
  }));
  return [h('div', { class: 'section-head' }, h('h3', {}, 'Heatmap')), controls, layers, maps];
}

// Each layer is a density grid (points splatted with a Gaussian), drawn as a colored, mostly
// transparent blob over the radar; with few points the individual positions are dotted as well.
const HEAT_GRID = 256, HEAT_SIGMA = 2.6, HEAT_R = 7;
const HEAT_KERNEL = (() => {
  const k = [];
  for (let dy = -HEAT_R; dy <= HEAT_R; dy++) for (let dx = -HEAT_R; dx <= HEAT_R; dx++) {
    const v = Math.exp(-(dx * dx + dy * dy) / (2 * HEAT_SIGMA * HEAT_SIGMA));
    if (v > 0.02) k.push([dx, dy, v]);
  }
  return k;
})();

function paintHeatmap(canvas, img, info, pts, layers) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  if (img) { ctx.globalAlpha = 0.85; ctx.drawImage(img, 0, 0, RADAR_SIZE, RADAR_SIZE); ctx.globalAlpha = 1; }
  const cell = RADAR_SIZE / HEAT_GRID;
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = HEAT_GRID;
  const tctx = tmp.getContext('2d');
  HEAT_LAYERS.forEach(([k, , color], idx) => {
    if (!layers.has(k)) return;
    const mine = pts.filter(p => p[0] === idx).map(p => toPx(info, p[3], p[4]));
    if (!mine.length) return;
    const grid = new Float32Array(HEAT_GRID * HEAT_GRID);
    for (const [px, py] of mine) {
      const cx = Math.round(px / cell), cy = Math.round(py / cell);
      for (const [dx, dy, v] of HEAT_KERNEL) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < HEAT_GRID && y < HEAT_GRID) grid[y * HEAT_GRID + x] += v;
      }
    }
    let max = 0;
    for (const v of grid) if (v > max) max = v;
    const norm = Math.max(1, max * 0.75);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const imgData = tctx.createImageData(HEAT_GRID, HEAT_GRID);
    for (let i = 0; i < grid.length; i++) {
      const a = Math.min(1, grid[i] / norm);
      if (a < 0.05) continue;
      imgData.data[i * 4] = r; imgData.data[i * 4 + 1] = g; imgData.data[i * 4 + 2] = b;
      imgData.data[i * 4 + 3] = Math.round(255 * Math.min(0.9, 0.25 + 0.7 * Math.pow(a, 0.8)));
    }
    tctx.putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, RADAR_SIZE, RADAR_SIZE);
    if (mine.length <= 400) {
      ctx.fillStyle = color;
      for (const [px, py] of mine) { ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); }
    }
  });
}

// ---------- Radar (2D replay) ----------
// Positions come sampled 8 times per second (see lib/track.js) and are interpolated per frame.
const SMOKE_RADIUS = 144, MOLOTOV_RADIUS = 120;
const SMOKE_TICKS = 18 * 64, MOLOTOV_TICKS = 7 * 64, BURST_TICKS = 32;
state.radar = { data: null, loading: null, round: 1, tick: 0, playing: false, speed: 2, floor: 'upper', room: 'auto', raf: 0 };

function replayData() {
  const r = state.radar, d = state.demo;
  if (r.data?.id === d.id) return r.data;
  if (r.loading !== d.id) {
    r.loading = d.id;
    api.replay(d.path)
      .then(v => {
        const data = { id: d.id, ...v };
        const bytes = v.track.data;
        data.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        data.names = Object.fromEntries(v.players.map(p => [p.steamid, p.name]));
        r.data = data;
        // Start on the round of the selected highlight's player… or simply round 1.
        setRadarRound(1, false);
      })
      .catch(e => { r.data = { id: d.id, error: e.message }; })
      .finally(() => { if (r.loading === d.id) r.loading = null; if (state.tab === 'radar') renderDetail(); });
  }
  return null;
}

const radarRound = () => state.radar.data.rounds.find(x => x.num === state.radar.round) || state.radar.data.rounds[0];
const roundStop = (data, r) => Math.min(r.nextStartTick ?? Infinity, r.endTick + 6 * data.tickrate);
function setRadarRound(num, play = state.radar.playing) {
  const r = state.radar;
  r.round = num;
  const rd = radarRound();
  r.tick = Math.max(rd.startTick, rd.freezeEndTick - 3 * r.data.tickrate);
  r.playing = play;
}

function radarView() {
  const a = state.analysis;
  const info = radarInfo(a.map);
  if (info === null) return h('div', { class: 'empty' }, h('h2', {}, 'No radar for this map'), h('div', {}, `There is no radar image for ${mapName(a.map)} yet.`));
  const data = info && replayData();
  if (!data) return h('div', { class: 'empty' }, h('span', { class: 'spinner', style: { width: '24px', height: '24px' } }), h('h2', {}, 'Reading player positions…'), h('div', {}, 'Only the first time for each match: it takes a few seconds.'));
  if (data.error) return h('div', { class: 'empty' }, h('h2', {}, 'No replay for this demo'), h('div', { class: 'err-box' }, data.error));

  const R = state.radar;
  const rd = radarRound();
  const floors = info.lowerBelow !== undefined;
  // Rush rounds each happen in one room: by default show the room where the players start.
  let room = null;
  if (info.rooms) {
    const start = data.track.header.players.map((id, i) => playerAt(data, i, rd.freezeEndTick)).filter(p => p?.alive).map(p => [p.x, p.y]);
    room = R.room === 'auto' ? bestRoom(info, start) : R.room === 'overview' ? null : R.room;
  }
  const frame = radarFrame(info, a.map, { room, lower: floors && R.floor === 'lower' });
  R.info = frame;
  R.image = null;
  radarImage(frame.src).then(img => { if (R.info === frame) R.image = img; });

  const canvas = h('canvas', { width: RADAR_SIZE, height: RADAR_SIZE, class: 'radar-canvas' });
  const slider = h('input', { type: 'range', class: 'radar-slider', min: rd.startTick, max: roundStop(data, rd), step: 1, value: R.tick,
    oninput: e => { R.tick = +e.target.value; } });
  const clock = h('span', { class: 'radar-clock' });
  const playBtn = h('button', { class: 'icon-btn', title: 'Play / pause (Space)', onclick: () => { R.playing = !R.playing; if (R.tick >= roundStop(data, rd)) setRadarRound(R.round, true); } });
  const feed = h('div', { class: 'radar-feed' });
  const teams = h('div', { class: 'radar-teams' });
  R.els = { canvas, slider, clock, playBtn, feed, teams, built: null };

  const rounds = h('div', { class: 'radar-rounds' }, ...data.rounds.map(x => h('button', {
    class: `rr win-${x.winner} ${x.num === R.round ? 'on' : ''}`, title: `Round ${x.num}: ${x.winner} won (${(x.reason || '').replace(/_/g, ' ')})`,
    onclick: () => { setRadarRound(x.num); renderDetail(); },
  }, x.num)));

  const controls = h('div', { class: 'radar-controls' },
    h('button', { class: 'icon-btn', title: 'Previous round', disabled: R.round <= 1, onclick: () => { setRadarRound(R.round - 1); renderDetail(); } }, icon('<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2"/>')),
    playBtn,
    h('button', { class: 'icon-btn', title: 'Next round', disabled: R.round >= data.rounds.length, onclick: () => { setRadarRound(R.round + 1); renderDetail(); } }, icon('<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/>')),
    slider, clock,
    select(String(R.speed), [['0.5', '0.5×'], ['1', '1×'], ['2', '2×'], ['4', '4×'], ['8', '8×']], v => { R.speed = +v; }),
    floors ? h('div', { class: 'tabs' }, ...[['upper', 'Upper'], ['lower', 'Lower']].map(([k, l]) =>
      h('button', { class: R.floor === k ? 'on' : '', onclick: () => { R.floor = k; renderDetail(); } }, l))) : null,
    roomSelect(info, R.room, v => { R.room = v; renderDetail(); }),
  );

  startRadarLoop();
  return [
    h('div', { class: 'section-head' }, h('h3', {}, `Round ${R.round}`), h('span', { class: `pill side-${rd.winner}` }, `${rd.winner} win`), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Space: play/pause · ←/→: 5 s · ↑/↓: round')),
    rounds,
    controls,
    h('div', { class: 'radar-layout' }, h('div', { class: 'radar-main' }, canvas), h('div', { class: 'radar-side' }, teams, feed)),
  ];
}

document.addEventListener('keydown', e => {
  if (state.tab !== 'radar' || !state.radar.data?.rounds || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range') return;
  const R = state.radar, tr = R.data.tickrate;
  if (e.key === ' ') { R.playing = !R.playing; e.preventDefault(); }
  else if (e.key === 'ArrowRight') { R.tick += 5 * tr; e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { R.tick -= 5 * tr; e.preventDefault(); }
  else if (e.key === 'ArrowDown' && R.round < R.data.rounds.length) { setRadarRound(R.round + 1); renderDetail(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && R.round > 1) { setRadarRound(R.round - 1); renderDetail(); e.preventDefault(); }
});

function startRadarLoop() {
  const R = state.radar;
  if (R.raf) return;
  let last = performance.now();
  const frame = now => {
    const dt = Math.min(100, now - last);
    last = now;
    if (state.tab !== 'radar' || !R.els?.canvas.isConnected || R.data?.id !== state.demo?.id) { R.raf = 0; R.playing = false; return; }
    const rd = radarRound(), stop = roundStop(R.data, rd);
    if (R.playing) R.tick += dt / 1000 * R.data.tickrate * R.speed;
    R.tick = Math.max(rd.startTick, Math.min(stop, R.tick));
    if (R.tick >= stop) R.playing = false;
    drawRadar();
    R.raf = requestAnimationFrame(frame);
  };
  R.raf = requestAnimationFrame(frame);
}

// One player's state at a (fractional) tick, interpolated between the two surrounding samples.
function playerAt(data, p, tick) {
  const { header } = data.track, v = data.view, P = header.players.length;
  const s = (tick - header.firstTick) / header.step;
  const s0 = Math.max(0, Math.min(header.samples - 1, Math.floor(s)));
  const s1 = Math.min(header.samples - 1, s0 + 1);
  const f = Math.max(0, Math.min(1, s - s0));
  const o0 = (s0 * P + p) * header.rec, o1 = (s1 * P + p) * header.rec;
  const flags = v.getUint8(o0 + 9);
  if (!(flags & 1)) return null;
  const lerp = (a, b) => a + (b - a) * f;
  const pres1 = v.getUint8(o1 + 9) & 1;
  const g = (o, k) => v.getInt16(o + k, true);
  let yaw0 = v.getUint8(o0 + 6), yaw1 = pres1 ? v.getUint8(o1 + 6) : yaw0;
  if (yaw1 - yaw0 > 128) yaw1 -= 256; else if (yaw0 - yaw1 > 128) yaw1 += 256;
  const w = v.getUint8(o0 + 8);
  return {
    x: pres1 ? lerp(g(o0, 0), g(o1, 0)) : g(o0, 0),
    y: pres1 ? lerp(g(o0, 2), g(o1, 2)) : g(o0, 2),
    z: g(o0, 4),
    yaw: lerp(yaw0, yaw1) / 256 * 360,
    hp: v.getUint8(o0 + 7),
    weapon: w === 255 ? '' : header.weapons[w],
    alive: !!(flags & 2),
    ct: !!(flags & 4),
  };
}

function drawRadar() {
  const R = state.radar, data = R.data, info = R.info, els = R.els;
  const ctx = els.canvas.getContext('2d');
  const t = R.tick, tr = data.tickrate, rd = radarRound();
  const lowerView = R.floor === 'lower';
  const px = (x, y) => toPx(info, x, y);
  const fade = z => info.lowerBelow !== undefined && onLower(info, z) !== lowerView;
  const units = u => u / info.scale;

  ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  if (R.image) ctx.drawImage(R.image, 0, 0, RADAR_SIZE, RADAR_SIZE);

  // Grenades: smokes and fires last until their expire event, flashes and HEs are short bursts.
  const gr = data.grenades.filter(g => g.round === rd.num);
  for (const g of gr) {
    if (g.expire || g.tick > t) continue;
    const end = g.type === 'smoke' || g.type === 'molotov'
      ? (gr.find(x => x.expire && x.type === g.type && x.entity === g.entity && x.tick >= g.tick)?.tick ?? g.tick + (g.type === 'smoke' ? SMOKE_TICKS : MOLOTOV_TICKS))
      : g.tick + BURST_TICKS;
    if (t > end) continue;
    const [x, y] = px(g.pos[0], g.pos[1]);
    ctx.globalAlpha = fade(g.pos[2]) ? 0.3 : 1;
    if (g.type === 'smoke') {
      ctx.fillStyle = 'rgba(200,206,216,0.75)'; ctx.strokeStyle = g.team === 'CT' ? '#6ea8ff' : '#e9b949'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, units(SMOKE_RADIUS), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (g.type === 'molotov') {
      ctx.fillStyle = 'rgba(255,110,30,0.45)'; ctx.beginPath(); ctx.arc(x, y, units(MOLOTOV_RADIUS), 0, Math.PI * 2); ctx.fill();
    } else if (g.type === 'flash' || g.type === 'he') {
      const k = (t - g.tick) / BURST_TICKS;
      ctx.strokeStyle = g.type === 'flash' ? `rgba(255,255,255,${1 - k})` : `rgba(255,80,60,${1 - k})`;
      ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(x, y, 8 + k * (g.type === 'he' ? units(300) : 30), 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Bomb
  const bombs = data.bomb.filter(b => b.round === rd.num && b.tick <= t);
  const planted = bombs.find(b => b.type === 'planted');
  const ended = bombs.find(b => b.type === 'defused' || b.type === 'exploded');
  if (planted?.pos) {
    const [x, y] = px(planted.pos[0], planted.pos[1]);
    const pulse = ended ? 0 : (Math.sin(t / 8) + 1) / 2;
    ctx.fillStyle = ended?.type === 'defused' ? '#6ea8ff' : '#ff4d4d';
    ctx.globalAlpha = 0.35 + 0.4 * pulse; ctx.beginPath(); ctx.arc(x, y, 18 + 8 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillRect(x - 7, y - 7, 14, 14);
  }

  // Deaths so far this round
  const kills = data.kills.filter(k => k.round === rd.num);
  ctx.lineWidth = 4;
  for (const k of kills) {
    if (k.tick > t || !k.victimPos) continue;
    const [x, y] = px(k.victimPos[0], k.victimPos[1]);
    ctx.globalAlpha = fade(k.victimPos[2]) ? 0.25 : 0.8;
    ctx.strokeStyle = k.victimTeam === 'CT' ? '#6ea8ff' : '#e9b949';
    ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Players
  const pov = state.analysis?.player?.steamid;
  const players = data.track.header.players.map((id, i) => ({ id, name: data.names[id] || id, s: playerAt(data, i, t) })).filter(p => p.s);
  ctx.font = '600 20px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  for (const p of players) {
    if (!p.s.alive) continue;
    const [x, y] = px(p.s.x, p.s.y);
    const color = p.s.ct ? '#6ea8ff' : '#e9b949';
    ctx.globalAlpha = fade(p.s.z) ? 0.3 : 1;
    const a = -p.s.yaw * Math.PI / 180;
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 30, y + Math.sin(a) * 30); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = p.id === pov ? 4 : 2; ctx.strokeStyle = p.id === pov ? '#fff' : '#0d0f12';
    ctx.stroke();
    ctx.fillStyle = '#0d0f12cc'; const label = p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name;
    const wdt = ctx.measureText(label).width + 10;
    ctx.fillRect(x - wdt / 2, y - 42, wdt, 24);
    ctx.fillStyle = p.id === pov ? '#fff' : color; ctx.fillText(label, x, y - 23);
  }
  ctx.globalAlpha = 1;

  // Controls, team lists and kill feed (DOM; only touched when something visible changed)
  if (document.activeElement !== els.slider) els.slider.value = t;
  const since = (t - rd.freezeEndTick) / tr;
  els.clock.textContent = since < 0 ? `Freeze ${Math.ceil(-since)}s` : fmtDur(since);
  if (els.playing !== R.playing) {
    els.playing = R.playing;
    els.playBtn.replaceChildren(icon(R.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>' : ICONS.play));
  }
  const sig = players.map(p => `${p.s.alive ? p.s.hp : 0}${p.s.weapon}`).join() + kills.filter(k => k.tick <= t).length;
  if (els.built !== sig) {
    els.built = sig;
    const side = ct => players.filter(p => p.s.ct === ct).sort((x, y) => x.name.localeCompare(y.name)).map(p =>
      h('div', { class: `rp ${p.s.alive ? '' : 'dead'} ${p.id === pov ? 'me' : ''}` },
        h('div', { class: 'rp-top' }, h('span', { class: 'rp-name' }, p.name), h('span', { class: 'rp-hp' }, p.s.alive ? p.s.hp : '✕')),
        h('div', { class: 'rp-bar' }, h('div', { style: { width: `${p.s.alive ? p.s.hp : 0}%`, background: ct ? 'var(--ct)' : 'var(--t)' } })),
        h('div', { class: 'rp-w' }, p.s.alive ? p.s.weapon : '')));
    els.teams.replaceChildren(h('div', { class: 'rt side-CT' }, 'CT'), ...side(true), h('div', { class: 'rt side-T' }, 'T'), ...side(false));
    els.feed.replaceChildren(h('div', { class: 'rt' }, 'Kills'), ...kills.map(k => h('div', {
      class: `rk ${k.tick <= t ? '' : 'future'}`, title: 'Jump to this kill', onclick: () => { R.tick = k.tick - 2 * tr; },
    },
    h('span', { class: 'rk-t' }, fmtDur(Math.max(0, (k.tick - rd.freezeEndTick) / tr))),
    h('span', { class: `side-${k.attackerTeam}` }, data.names[k.attacker] || 'World'),
    h('span', { class: 'rk-w' }, k.weapon, k.headshot ? ' ◎' : ''),
    h('span', { class: `side-${k.victimTeam}` }, data.names[k.victim] || '?'))));
  }
}


function highlightCard(hl) {
  const sel = state.selected.has(hl.id);
  return h('div', { class: `hl ${sel ? 'selected' : ''}`, onclick: () => { sel ? state.selected.delete(hl.id) : state.selected.add(hl.id); renderDetail(); } },
    h('div', { class: 'check' }, icon(ICONS.check)),
    h('div', { class: 'round-box' }, h('div', { class: 'l' }, 'Round'), h('div', { class: 'n' }, hl.round), h('div', { class: `l side-${hl.side}` }, hl.side)),
    h('div', {},
      h('div', { class: 'hl-title' }, ...hl.tags.map(t => h('span', { class: `tag ${t.type}` }, t.label))),
      h('div', { class: 'kills' }, ...hl.kills.map(k => h('div', { class: 'kill' },
        h('span', { class: 'w' }, k.weapon),
        k.headshot ? h('span', { class: 'hs' }, 'HS') : null,
        h('span', {}, '→ ', k.victim),
        k.flags.length ? h('span', { class: 'f' }, k.flags.join(', ')) : null,
      ))),
    ),
    h('div', { class: 'hl-right' },
      h('div', { class: 'stars' }, stars(hl.score)),
      h('div', {}, `${Math.round(hl.duration)}s clip`),
      hl.segments.length > 1 ? h('div', {}, `${hl.segments.length} cuts`) : null,
      h('div', {}, `at ${fmtDur(hl.time)}`),
    ),
  );
}

function estimateSeconds(hls) {
  const t = state.settings.timing;
  const segs = hls.reduce((n, x) => n + x.segments.length, 0);
  const play = hls.reduce((n, x) => n + x.duration, 0);
  // CS2 start + demo load + ~1.3x game time (more if CS2 is minimized) + closing CS2.
  return t.startupWait + 40 + 15 + segs * 6 + play * 1.3 + hls.length * 4 + 20;
}

function actionBar() {
  const hls = (state.analysis?.highlights || []).filter(x => state.selected.has(x.id));
  const n = hls.length;
  return h('div', { class: 'action-bar' },
    h('div', { class: 'info' }, n ? h('span', {}, h('b', {}, `${n} highlight${n > 1 ? 's' : ''}`), ` selected · about ${Math.ceil(estimateSeconds(hls) / 60)} min to record`) : 'Select highlights to record'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn primary', disabled: !n || !!state.recording, onclick: () => confirmRecord(hls) }, icon(ICONS.rec), `Record ${n || ''} clip${n === 1 ? '' : 's'}`),
  );
}

// ---------- Recording ----------
function modal(content, { wide = false, onClose } = {}) {
  const ov = $('#overlay');
  const m = h('div', { class: `modal ${wide ? 'wide' : ''}` }, content);
  ov.replaceChildren(m);
  ov.classList.remove('hidden');
  ov.onclick = e => { if (e.target === ov && onClose !== false) closeModal(onClose); };
  return m;
}
function closeModal(cb) { $('#overlay').classList.add('hidden'); $('#overlay').replaceChildren(); if (typeof cb === 'function') cb(); }

function confirmRecord(hls) {
  const mins = Math.ceil(estimateSeconds(hls) / 60);
  const steps = [
    h('li', {}, 'CS2 opens ', h('b', {}, 'in a window through HLAE'), '. ', h('b', {}, 'Keep using your PC'), ': put other windows over it or minimize it (it renders a bit slower when minimized).'),
    state.env.cs2Running ? h('li', {}, h('b', {}, 'Close your running CS2 first'), ' — the recording session needs its own CS2.') : null,
    h('li', {}, 'CS2 runs with ', h('code', {}, '-insecure'), ' (no VAC servers) and ', h('b', {}, 'is closed automatically'), ' when done. Never join matches from that session.'),
    h('li', {}, 'Clips are saved to ', h('code', {}, state.env.outputDir)),
  ];
  modal([
    h('h2', {}, `Record ${hls.length} clip${hls.length > 1 ? 's' : ''}?`),
    h('p', {}, `CS2 will play the demo in the background and HLAE will record each highlight frame by frame. This takes about ${mins} minute${mins > 1 ? 's' : ''}.`),
    h('ul', { class: 'steps' }, ...steps),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => startRecord(hls) }, icon(ICONS.rec), 'Start recording'),
    ),
  ]);
}

async function startRecord(hls) {
  const items = hls.map(x => ({ demoPath: state.demo.path, highlightId: x.id }));
  const steamid = state.analysis.player?.steamid;
  try {
    const r = await api.record(items, steamid);
    state.recording = { total: r.count, log: [] };
    renderRecording({ state: 'running', step: 'Starting…', progress: 0 });
  } catch (e) {
    const hlaeMissing = e.message.includes('HLAE_MISSING:');
    const msg = e.message.replace(/^.*HLAE_MISSING:\s*/, '');
    const status = h('div', { class: 'hint' });
    const install = hlaeMissing ? h('button', { class: 'btn primary', onclick: async ev => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      status.textContent = 'Downloading the latest HLAE from advancedfx (GitHub)…';
      try {
        const r = await api.hlaeUpdate();
        toast(`HLAE ${r.version} installed`, 'ok');
        await refreshEnv();
        closeModal();
        startRecord(hls);
      } catch (err) { status.textContent = '✗ ' + err.message; btn.disabled = false; }
    } }, 'Install HLAE') : null;
    modal([h('h2', {}, 'Could not start'), h('div', { class: 'err-box' }, msg), status,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'), install)]);
  }
}

function renderRecording(u) {
  const r = state.recording || { log: [] };
  if (u.log) r.log.push(u.log);
  if (u.step) r.step = u.step;
  if (u.progress !== undefined) r.progress = u.progress;
  if (u.state) r.state = u.state;
  if (u.error) r.error = u.error;
  state.recording = r;
  const done = ['done', 'error', 'cancelled'].includes(r.state);
  modal([
    h('h2', {}, r.state === 'done' ? 'Clips ready 🎬' : r.state === 'error' ? 'Recording failed' : r.state === 'cancelled' ? 'Recording cancelled' : 'Recording highlights…'),
    h('div', { class: 'step' }, r.step || ''),
    h('div', { class: `progress ${r.state === 'running' && !r.progress ? 'indet' : ''}` }, h('div', { style: { width: `${Math.round((r.progress || 0) * 100)}%` } })),
    r.state === 'running' ? h('div', { class: 'info-box' }, 'Recording in the background — keep using your PC. CS2 can stay behind other windows or minimized.') : null,
    r.error ? h('div', { class: 'err-box' }, r.error) : null,
    r.log.length ? h('div', { class: 'log' }, ...r.log.map(l => h('div', {}, l))) : null,
    h('div', { class: 'actions' },
      done
        ? [h('button', { class: 'btn', onclick: () => { state.recording = null; closeModal(); renderDetail(); } }, 'Close'),
          r.state === 'done' ? h('button', { class: 'btn primary', onclick: () => { state.recording = null; closeModal(); showView('clips'); } }, icon(ICONS.film), 'View clips') : null]
        : h('button', { class: 'btn danger', onclick: () => api.cancelRecord() }, 'Cancel'),
    ),
  ], { onClose: false });
  if (done) { refreshEnv(); loadClipCount(); }
}
api.onRecord(u => renderRecording(u));

// ---------- Clips ----------
async function loadClipCount() {
  state.clips = await guard(() => api.listClips()) || [];
  $('#clipCount').textContent = state.clips.length || '';
}
async function loadClips() { await loadClipCount(); renderClips(); }

// Weapon categories, in the order groups are shown. Names match highlights.js weaponName().
const WEAPON_TYPES = [
  ['Rifles', ['AK-47', 'M4A4', 'M4A1-S', 'FAMAS', 'Galil', 'AUG', 'SG 553']],
  ['Snipers', ['AWP', 'Scout', 'G3SG1', 'SCAR-20']],
  ['Pistols', ['Deagle', 'R8', 'USP-S', 'P2000', 'Glock', 'P250', 'Five-SeveN', 'Tec-9', 'CZ75', 'Dualies']],
  ['SMGs', ['MAC-10', 'MP9', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon']],
  ['Shotguns', ['Nova', 'XM1014', 'MAG-7', 'Sawed-Off']],
  ['Heavy', ['M249', 'Negev']],
  ['Knife & Zeus', ['Knife', 'Zeus']],
  ['Grenades', ['HE', 'Molotov', 'Incendiary']],
];
const weaponType = w => WEAPON_TYPES.find(([, list]) => list.includes(w))?.[0] || 'Other';

// The weapon a clip is "about": the one with the most kills (older clips only know the weapon list).
function mainWeapon(c) {
  const kills = c.killWeapons?.length ? c.killWeapons : c.weapons || [];
  if (!kills.length) return null;
  const count = {};
  for (const w of kills) count[w] = (count[w] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
}

function renderClips() {
  const view = $('#view-clips');
  const wf = state.weaponFilter || 'all';
  const sort = state.clipSort || 'type';
  let items = state.clips.filter(c => state.clipFilter === 'all' || c.kind === state.clipFilter);
  items = items.filter(c => {
    if (wf === 'all') return true;
    const ws = c.weapons || [];
    return wf.startsWith('type:') ? ws.some(w => weaponType(w) === wf.slice(5)) : ws.includes(wf);
  });
  const typeRank = c => {
    if (c.kind === 'montage') return 100;
    const i = WEAPON_TYPES.findIndex(([t]) => t === weaponType(mainWeapon(c)));
    return i < 0 ? 99 : i;
  };
  const byType = (a, b) => typeRank(a) - typeRank(b) || (mainWeapon(a) || '').localeCompare(mainWeapon(b) || '') || (b.score || 0) - (a.score || 0);
  items.sort(sort === 'best' ? (a, b) => (b.score || 0) - (a.score || 0)
    : sort === 'type' ? byType
      : (a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Weapon filter offers the categories and the individual weapons present in your clips.
  const present = [...new Set(state.clips.flatMap(c => c.weapons || []))];
  const types = WEAPON_TYPES.map(([t]) => t).filter(t => present.some(w => weaponType(w) === t));
  const weaponSelect = select(wf, [
    ['all', 'All weapons'],
    ...types.map(t => [`type:${t}`, t]),
    ...types.flatMap(t => present.filter(w => weaponType(w) === t).sort().map(w => [w, `   ${w}`])),
  ], v => { state.weaponFilter = v; renderClips(); });
  const sortSelect = select(sort, [['type', 'Sort: weapon type'], ['best', 'Sort: best first'], ['new', 'Sort: newest']], v => { state.clipSort = v; renderClips(); });

  const head = h('div', { class: 'page-head' },
    h('h2', {}, 'Clips'),
    h('div', { class: 'tabs' }, ...[['all', 'All'], ['clip', 'Clips'], ['montage', 'Montages']].map(([k, l]) =>
      h('button', { class: state.clipFilter === k ? 'on' : '', onclick: () => { state.clipFilter = k; renderClips(); } }, l))),
    weaponSelect, sortSelect,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => api.open(state.env.outputDir) }, icon(ICONS.folder), 'Open folder'),
  );

  // Sorting by weapon type shows one section per category; montages go last.
  let body;
  if (!items.length) {
    body = h('div', { class: 'empty' }, icon(ICONS.film, 'class="big"'),
      h('h2', {}, state.clips.length ? 'No clips match' : 'No clips yet'),
      h('div', {}, state.clips.length ? 'Try another weapon filter.' : 'Record highlights from the Matches tab and they will show up here.'));
  } else if (sort === 'type') {
    const groups = new Map();
    for (const c of items) {
      const key = c.kind === 'montage' ? 'Montages' : weaponType(mainWeapon(c));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    body = h('div', {}, ...[...groups].map(([name, list]) => h('div', { class: 'clip-group' },
      h('div', { class: 'group-head' }, name, h('span', {}, `${list.length} clip${list.length > 1 ? 's' : ''}`)),
      h('div', { class: 'grid' }, ...list.map(clipCard)))));
  } else body = h('div', { class: 'grid' }, ...items.map(clipCard));
  const grid = body;
  const hint = state.clips.some(c => c.kind === 'clip') ? h('div', { class: 'list-sub', style: { padding: '0 0 14px' } }, 'Click clips to select them for a montage — they will be joined in the order you click them.') : null;
  view.replaceChildren(h('div', { class: 'page' }, head, hint, grid), montageBar());
}

function clipCard(c) {
  const order = state.montageSel.indexOf(c.id);
  const thumbStyle = c.thumb ? { backgroundImage: `url("${api.fileUrl(c.thumb)}")` } : {};
  const thumb = h('div', { class: 'thumb', style: thumbStyle },
    order >= 0 ? h('div', { class: 'order' }, order + 1) : null,
    c.kind === 'montage' ? h('div', { class: 'kind' }, 'MONTAGE') : null,
    h('div', { class: 'dur' }, fmtDur(c.duration || 0)));
  let video = null;
  const card = h('div', {
    class: `clip ${order >= 0 ? 'selected' : ''}`,
    onclick: () => {
      if (c.kind === 'montage') return playClip(c);
      const i = state.montageSel.indexOf(c.id);
      i >= 0 ? state.montageSel.splice(i, 1) : state.montageSel.push(c.id);
      renderClips();
    },
    onmouseenter: () => { video = h('video', { src: api.fileUrl(c.file), muted: true, autoplay: true, loop: true }); video.muted = true; thumb.prepend(video); },
    onmouseleave: () => { video?.remove(); video = null; },
  },
  thumb,
  h('div', { class: 'clip-actions' },
    h('button', { title: 'Play', onclick: e => { e.stopPropagation(); playClip(c); } }, icon(ICONS.play)),
    h('button', { title: 'Show in folder', onclick: e => { e.stopPropagation(); api.reveal(c.file); } }, icon(ICONS.folder)),
    h('button', { title: 'Delete (to Recycle Bin)', onclick: e => { e.stopPropagation(); deleteClip(c); } }, icon(ICONS.trash)),
  ),
  h('div', { class: 'clip-body' },
    h('div', { class: 'clip-title', title: c.title }, c.title),
    h('div', { class: 'clip-meta' }, c.kind === 'montage' ? `${c.tags?.[0] || ''} · ${new Date(c.createdAt).toLocaleDateString()}` : `${mapName(c.map)} · Round ${c.round} · ${(c.weapons || []).join(', ')}`),
  ));
  return card;
}

function playClip(c) {
  modal([
    h('video', { src: api.fileUrl(c.file), controls: true, autoplay: true }),
    h('div', { class: 'video-foot' },
      h('div', { class: 't' }, c.title),
      h('button', { class: 'btn', onclick: () => api.reveal(c.file) }, icon(ICONS.folder), 'Show in folder'),
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'),
    ),
  ], { wide: true });
}

function deleteClip(c) {
  modal([
    h('h2', {}, 'Delete this clip?'),
    h('p', {}, `"${c.title}" will be moved to the Recycle Bin.`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        closeModal();
        await guard(() => api.deleteClip(c.id));
        state.montageSel = state.montageSel.filter(id => id !== c.id);
        loadClips();
      } }, 'Delete'),
    ),
  ]);
}

function montageBar() {
  const n = state.montageSel.length;
  const total = state.montageSel.reduce((s, id) => s + (state.clips.find(c => c.id === id)?.duration || 0), 0);
  const name = h('input', { type: 'text', placeholder: 'Montage name (optional)' });
  return h('div', { class: `montage-bar ${n ? 'show' : ''}` },
    h('div', { class: 'info' }, h('b', {}, `${n} clip${n === 1 ? '' : 's'}`), ` · ${fmtDur(total)}`),
    h('button', { class: 'link-btn', onclick: () => { state.montageSel = []; renderClips(); } }, 'Clear'),
    h('span', { style: { flex: 1 } }),
    name,
    h('button', { class: 'btn primary', disabled: n < 2, onclick: () => makeMontage(name.value.trim()) }, icon(ICONS.film), 'Create montage'),
  );
}

async function makeMontage(name) {
  const ids = [...state.montageSel];
  const progress = h('div', {});
  modal([h('h2', {}, 'Building montage…'), h('div', { class: 'progress' }, progress), h('p', {}, 'Joining clips with ffmpeg.')], { onClose: false });
  const off = api.onMontage(u => { if (u.progress !== undefined) progress.style.width = `${Math.round(u.progress * 100)}%`; });
  try {
    const item = await api.montage(ids, name);
    state.montageSel = [];
    closeModal();
    await loadClips();
    playClip(item);
  } catch (e) {
    modal([h('h2', {}, 'Montage failed'), h('div', { class: 'err-box' }, e.message), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'))]);
  } finally { off(); }
}

// ---------- Settings ----------
async function save(patch, reanalyze = false) {
  state.settings = await guard(() => api.setSettings(patch)) || state.settings;
  if (reanalyze) {
    state.demos.forEach(d => { d.summary = null; d.failed = false; });
    loadDemos();
    if (state.demo) openDemo(state.demo, state.analysis?.player?.steamid);
  }
}

function row(label, ctl, hint) {
  return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ctl, hint ? h('div', { class: 'hint' }, hint) : null));
}
function num(value, onchange, { min = 0, max = 999, step = 1 } = {}) {
  return h('input', { type: 'number', value, min, max, step, onchange: e => onchange(Number(e.target.value)) });
}
function text(value, onchange, attrs = {}) { return h('input', { type: 'text', value: value ?? '', ...attrs, onchange: e => onchange(e.target.value.trim()) }); }
function toggle(label, on, onchange) {
  return h('button', { class: `chip-toggle ${on ? 'on' : ''}`, onclick: e => { on = !on; e.currentTarget.classList.toggle('on', on); onchange(on); } }, label);
}
function select(value, options, onchange) {
  return h('select', { onchange: e => onchange(e.target.value) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

// ---------- HLAE updates ----------
state.hlaeUpdate = null; // { installed, latest, updateAvailable, ... } once checked

function hlaeUpdateCtl() {
  const u = state.hlaeUpdate;
  const status = h('span', { class: 'hint' },
    !u ? 'Not checked yet' : u.updateAvailable ? `HLAE ${u.latest} is available (${new Date(u.published).toLocaleDateString()})` : `Up to date (latest is ${u.latest})`);
  const checkBtn = h('button', { class: 'btn', onclick: async () => {
    status.textContent = 'Checking…';
    try { state.hlaeUpdate = await api.hlaeCheck(); } catch (e) { status.textContent = '✗ ' + e.message; return; }
    renderSettings();
  } }, 'Check for updates');
  const updateBtn = u?.updateAvailable ? h('button', { class: 'btn primary', onclick: async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    status.textContent = `Downloading HLAE ${u.latest} (${(u.size / 1e6).toFixed(0)} MB)…`;
    try {
      const r = await api.hlaeUpdate();
      toast(`HLAE updated to ${r.version}`, 'ok');
      state.hlaeUpdate = { ...u, installed: r.version, updateAvailable: false };
      await refreshEnv();
      renderSettings();
    } catch (err) { status.textContent = '✗ ' + err.message; btn.disabled = false; }
  } }, `${u.installed ? 'Update to' : 'Install'} HLAE ${u.latest}`) : null;
  return h('div', { class: 'ctl' }, checkBtn, updateBtn, status);
}

api.onHlaeUpdate(u => {
  state.hlaeUpdate = u;
  toast(`HLAE ${u.latest} is available — update it in Settings → Recording so recording keeps working after CS2 updates.`, 'ok');
  if (state.view === 'settings') renderSettings();
});

function renderSettings() {
  const st = state.settings, e = state.env;
  const d = st.detection, t = st.timing;
  const SPECIAL_LABELS = { noscope: 'No-scope', wallbang: 'Wallbang', smoke: 'Through smoke', blind: 'While flashed', jumpshot: 'Jumpshot', knife: 'Knife', zeus: 'Zeus', collateral: 'Collateral' };

  const cards = [
    h('div', { class: 'card' },
      h('h3', {}, 'Highlights'),
      h('div', { class: 'desc' }, 'What counts as a highlight. Each round becomes at most one clip.'),
      row('Multi-kill from', select(String(d.minMultiKill), [['2', '2 kills'], ['3', '3 kills (3K)'], ['4', '4 kills (4K)'], ['5', 'Aces only']], v => save({ detection: { minMultiKill: +v } }, true))),
      row('Clutches', h('div', { class: 'ctl' },
        toggle('Include clutches', d.clutch, v => save({ detection: { clutch: v } }, true)),
        select(String(d.minClutch), [['1', 'from 1v1'], ['2', 'from 1v2'], ['3', 'from 1v3'], ['4', 'from 1v4'], ['5', '1v5 only']], v => save({ detection: { minClutch: +v } }, true)))),
      row('Special kills', h('div', { class: 'chips' }, ...Object.entries(SPECIAL_LABELS).map(([k, l]) => toggle(l, d.specials[k], v => save({ detection: { specials: { [k]: v } } }, true))))),
      row('Seconds before / after', h('div', { class: 'ctl' },
        num(t.padBefore, v => save({ timing: { padBefore: v } }, true), { max: 15, step: 0.5 }), ' / ',
        num(t.padAfter, v => save({ timing: { padAfter: v } }, true), { max: 15, step: 0.5 })), 'Footage kept around each kill.'),
      row('Cut gaps longer than', h('div', { class: 'ctl' }, num(t.mergeGap, v => save({ timing: { mergeGap: v } }, true), { max: 120, step: 1 }), 'seconds'), 'Long waits between kills are cut out. Set high (e.g. 60) to keep full sequences.'),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Recording'),
      h('div', { class: 'desc' }, 'CS2 runs through HLAE, which records in the background while you keep using your PC.'),
      row('HLAE folder', h('div', { class: 'ctl' },
        h('span', { class: 'mono', style: { flex: 1 } }, e.hlae?.dir || ''),
        h('span', { class: `pill ${e.hlae?.installed ? 'ok' : 'bad'}` }, e.hlae?.installed ? `HLAE ${e.hlae.version}` : 'Not found'),
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder('HLAE folder (contains HLAE.exe)'); if (p) { await save({ hlae: { path: p } }); await refreshEnv(); renderSettings(); } } }, 'Browse')),
        'HLAE must match your CS2 version. After a CS2 update, recording can fail until HLAE is updated.'),
      row('HLAE updates', hlaeUpdateCtl()),
      row('Resolution', select(`${st.hlae.width}x${st.hlae.height}`, [['1280x720', '1280 × 720'], ['1920x1080', '1920 × 1080'], ['2560x1440', '2560 × 1440']],
        v => { const [w, hh] = v.split('x').map(Number); save({ hlae: { width: w, height: hh } }); })),
      row('Frame rate', select(String(st.hlae.fps), [['30', '30 fps'], ['60', '60 fps'], ['120', '120 fps']], v => save({ hlae: { fps: +v } }))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Counter-Strike 2'),
      row('CS2 folder', h('div', { class: 'ctl' }, text(st.cs2Dir || e.cs2Dir || '', v => save({ cs2Dir: v }).then(refreshEnv), { class: 'mono' }),
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder('Counter-Strike Global Offensive folder'); if (p) { await save({ cs2Dir: p }); await refreshEnv(); renderSettings(); } } }, 'Browse'))),
      row('Your SteamID64', text(st.steamId, v => save({ steamId: v }, true).then(refreshEnv), { placeholder: e.steamUser ? `${e.steamUser.steamid} (${e.steamUser.name}, auto)` : '7656119…', class: 'mono' }), 'Leave empty to use the Steam account logged in on this PC.'),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Demo folders'),
      h('div', { class: 'desc' }, 'Your CS2 replays folder is always scanned. Add folders with other demos (scrims, community servers…).'),
      h('div', { class: 'folder-list' },
        ...[e.csgoDir && `${e.csgoDir}\\replays`, e.csgoDir].filter(Boolean).map(f => h('div', { class: 'folder-item' }, h('span', { class: 'mono' }, f), h('span', { class: 'hint', style: { flex: 'none' } }, 'auto'))),
        ...st.demoFolders.map(f => h('div', { class: 'folder-item' }, h('span', { class: 'mono' }, f),
          h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, onclick: async () => { await save({ demoFolders: st.demoFolders.filter(x => x !== f) }); renderSettings(); loadDemos(); } }, icon(ICONS.x)))),
      ),
      h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: async () => {
        const p = await api.pickFolder('Folder with .dem files');
        if (p && !st.demoFolders.includes(p)) { await save({ demoFolders: [...st.demoFolders, p] }); renderSettings(); loadDemos(); }
      } }, icon(ICONS.folder), 'Add folder')),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Output'),
      row('Save clips to', h('div', { class: 'ctl' }, h('span', { class: 'mono', style: { flex: 1 } }, e.outputDir),
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder('Where to save clips'); if (p) { await save({ outputDir: p }); await refreshEnv(); renderSettings(); } } }, 'Change'))),
      row('Video encoder', select(st.encoder, [['auto', `Auto (using ${e.encoder})`], ['libx264', 'CPU (x264)'], ['h264_nvenc', 'NVIDIA (NVENC)'], ['h264_amf', 'AMD (AMF)'], ['h264_qsv', 'Intel (QuickSync)']], v => save({ encoder: v }).then(refreshEnv))),
      row('Montage fade', h('div', { class: 'ctl' }, num(st.montage.fade, v => save({ montage: { fade: v } }), { max: 2, step: 0.05 }), 'seconds')),
      row('Keep raw recordings', toggle('Keep', st.keepRaw, v => save({ keepRaw: v })), "Keeps HLAE's separate video and audio files in a _raw folder."),
      row('ffmpeg', h('div', { class: 'ctl' }, h('span', { class: 'mono', style: { flex: 1 } }, e.ffmpeg || 'not found'),
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFile('ffmpeg.exe', [{ name: 'ffmpeg', extensions: ['exe'] }]); if (p) { await save({ ffmpegPath: p }); await refreshEnv(); renderSettings(); } } }, 'Browse'))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Advanced timing & commands'),
      h('div', { class: 'desc' }, 'Increase the startup wait if the first clip fails right after CS2 opens. Setup commands run once when CS2 starts, separated by ";".'),
      row('CS2 startup wait', h('div', { class: 'ctl' }, num(t.startupWait, v => save({ timing: { startupWait: v } }), { max: 300 }), 'seconds')),
      row('Setup commands', text(st.commands.setup, v => save({ commands: { setup: v } }), { class: 'mono' })),
    ),
  ];
  $('#view-settings').replaceChildren(h('div', { class: 'page settings' }, h('div', { class: 'page-head' }, h('h2', {}, 'Settings')), ...cards));
}

// ---------- Downloads ----------
state.dl = { matches: [], lastCheck: null, checking: false, progress: null, error: null, notes: [], community: 'unknown' };

async function loadDownloads() {
  const r = await guard(() => api.listDownloads());
  if (r) Object.assign(state.dl, r);
  renderDownloads();
}

async function checkNow() {
  state.dl.checking = true;
  state.dl.error = null;
  state.dl.notes = [];
  renderDownloads();
  try {
    const r = await api.checkDownloads();
    Object.assign(state.dl, r);
    const auto = state.settings.downloads.auto;
    toast(r.newCount ? `${r.newCount} new match${r.newCount > 1 ? 'es' : ''} found${auto ? ', downloading' : ''}` : 'No new matches', r.newCount ? 'ok' : '');
  } catch (e) {
    state.dl.error = e.message;
    const r = await api.listDownloads().catch(() => null);
    if (r) state.dl.community = r.community;
  }
  state.dl.checking = false;
  renderDownloads();
}

async function steamSignIn() {
  const ok = await guard(() => api.communitySignIn());
  if (ok) { toast('Signed in to Steam Community', 'ok'); checkNow(); } else renderDownloads();
}

api.onDownloads(async e => {
  if (e.progress) {
    state.dl.progress = e.progress;
    const bar = document.querySelector(`[data-dl-progress="${e.progress.id}"]`);
    if (bar && e.progress.total) { bar.style.width = `${Math.round(100 * e.progress.received / e.progress.total)}%`; return; }
  }
  if (e.done) { toast('Match downloaded — added to Matches', 'ok'); state.dl.progress = null; loadDemos(); }
  if (e.failed) { toast(`Download failed: ${e.error}`, 'error'); state.dl.progress = null; }
  if (e.found) toast(`${e.found} new match${e.found > 1 ? 'es' : ''} found`, 'ok');
  if (e.autoError) state.dl.error = e.autoError;
  const r = await api.listDownloads().catch(() => null);
  if (r) Object.assign(state.dl, r);
  if (state.view === 'downloads') renderDownloads(); else updateDlCount();
});

function updateDlCount() {
  const n = state.dl.matches.filter(m => ['available', 'queued', 'downloading'].includes(m.status)).length;
  $('#dlCount').textContent = n || '';
}

function renderDownloads() {
  updateDlCount();
  const d = state.dl;
  const STATUS = {
    downloaded: ['ok', 'On your PC'], available: ['new', 'Not downloaded'], queued: ['', 'Queued'],
    downloading: ['new', 'Downloading'], removed: ['', 'Deleted / moved'], expired: ['bad', 'Expired'],
  };
  const autoToggle = toggle('Auto-download new matches', state.settings.downloads.auto, async v => { await save({ downloads: { auto: v } }); });
  const head = h('div', { class: 'page-head' },
    h('h2', {}, 'Match downloads'),
    h('span', { class: 'dl-head-info' }, d.lastCheck ? `Last checked ${fmtDate(d.lastCheck)}` : 'Never checked'),
    h('span', { class: 'spacer' }),
    autoToggle,
    h('button', { class: 'btn primary', disabled: d.checking, onclick: checkNow }, d.checking ? h('span', { class: 'spinner' }) : icon('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2"/>'), d.checking ? 'Checking…' : 'Check now'),
  );

  const signedIn = d.community === 'ok';
  const steamCard = h('div', { class: 'info-box steam-box' },
    h('div', { style: { flex: 1 } },
      h('b', {}, 'Steam Community match history '),
      signedIn ? h('span', { class: 'pill ok' }, 'Signed in') : d.community === 'signedOut' ? h('span', { class: 'pill bad' }, 'Not signed in') : null,
      h('div', {}, 'Scrimmage and Rush replays are only listed on your private Steam page (Personal Game Data). ClipMaker reads its Scrimmage, Rush, Premier, Competitive and Wingman tabs. Sign in once in Steam’s own login window — the app never sees your password.')),
    signedIn
      ? h('button', { class: 'btn', onclick: async () => { await guard(() => api.communitySignOut()); loadDownloads(); } }, 'Sign out')
      : h('button', { class: 'btn primary', onclick: steamSignIn }, 'Sign in to Steam'),
  );
  const info = h('div', { class: 'info-box' },
    'Also asks Valve for your latest matches through your Steam client (like CS2’s ', h('b', {}, 'Watch → Your Matches'), ') when CS2 is closed. ',
    state.settings.downloads.auto ? `Checks automatically every ${state.settings.downloads.intervalMin} minutes and downloads new demos to your replays folder.` : 'Automatic checking is off.');

  const items = d.matches.map(m => {
    const [cls, label] = STATUS[m.status] || ['', m.status];
    const prog = d.progress?.id === m.id ? d.progress : null;
    let action = null;
    if (m.status === 'available') action = h('button', { class: 'btn', onclick: async () => { await guard(() => api.download(m.id)); loadDownloads(); } }, 'Download');
    else if (m.status === 'removed') action = h('button', { class: 'btn', title: 'You downloaded this before and then deleted or moved it', onclick: async () => { await guard(() => api.download(m.id)); loadDownloads(); } }, 'Download again');
    else if (m.status === 'downloaded') action = h('button', { class: 'btn', title: m.file || '', onclick: () => {
      const demo = state.demos.find(x => x.path === m.file) || state.demos.find(x => x.name === m.fileBase + '.dem');
      showView('matches');
      if (demo) openDemo(demo);
    } }, 'Open');
    else if (m.status === 'downloading') action = h('div', { class: 'mini-progress' }, h('div', { 'data-dl-progress': m.id, style: { width: prog?.total ? `${Math.round(100 * prog.received / prog.total)}%` : '3%' } }));
    const renamed = m.status === 'downloaded' && m.file && m.fileBase && !m.file.endsWith(m.fileBase + '.dem');
    return h('div', { class: 'dl' },
      h('div', { class: 'when' }, m.time ? new Date(m.time).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '?',
        h('small', {}, m.time ? new Date(m.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '')),
      h('div', { class: 'mode' },
        h('span', { class: 'mode-name' }, m.mode), m.mapLabel ? ` · ${m.mapLabel}` : '', m.durationMin ? ` · ${m.durationMin} min` : '',
        renamed ? h('div', { class: 'hint' }, `Already on your PC as ${m.file.split(/[\\/]/).pop()}`) : null),
      h('div', { class: 'sc' }, m.score?.length === 2 ? `${m.score[0]} – ${m.score[1]}` : ''),
      h('div', { class: 'act' }, h('span', { class: `pill ${cls}` }, label), action),
    );
  });
  $('#view-downloads').replaceChildren(h('div', { class: 'page' },
    head, steamCard, info,
    d.error ? h('div', { class: 'err-box', style: { maxWidth: '980px' } }, d.error) : null,
    d.notes?.length && !d.error ? h('div', { class: 'warn-box', style: { maxWidth: '980px' } }, d.notes.join('\n')) : null,
    items.length ? h('div', { class: 'dl-list' }, ...items)
      : h('div', { class: 'empty' }, h('h2', {}, 'No matches yet'), h('div', {}, 'Sign in to Steam above, then click "Check now".')),
  ));
}

// ---------- Boot ----------
(async () => {
  state.settings = await api.getSettings();
  await refreshEnv();
  renderDetail();
  loadClipCount();
  api.listDownloads().then(r => { Object.assign(state.dl, r); updateDlCount(); }).catch(() => {});
  await loadDemos();
  if (state.demos[0]) openDemo(state.demos[0]);
  setInterval(refreshEnv, 10000);
})();
