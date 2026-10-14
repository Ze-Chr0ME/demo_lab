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
  screen: '<rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
const fmtNum = n => Math.round(n).toLocaleString();
const resultOf = (mine, enemy) => (mine > enemy ? 'w' : mine < enemy ? 'l' : 'd');
const spinner = (px = 24) => h('span', { class: 'spinner', style: { width: `${px}px`, height: `${px}px` } });

// ---------- State ----------
const state = {
  env: null, settings: null, demos: [], search: '',
  demo: null, analysis: null, analyzing: false, player: null,
  selected: new Set(),
  clips: [], clipFilter: 'all', montageSel: [],
  recording: null, view: 'overview',
};

// ---------- Navigation ----------
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
  state.view = v;
  if (v === 'overview') renderOverview();
  if (v === 'maps') renderMaps();
  if (v === 'matches' && !state.demo && state.demos[0]) openDemo(state.demos[0]);
  if (v === 'clips') loadClips();
  if (v === 'downloads') loadDownloads();
  if (v === 'settings') renderSettings();
}

// Repaints whatever page is showing (e.g. once the radar images' positions are known).
function rerender() {
  if (state.view === 'overview') renderOverview();
  if (state.view === 'maps') renderMaps();
  if (state.view === 'matches') { renderDemoList(); renderDetail(); }
}

// ---------- UI scale ----------
// The layout is designed at 1920 px wide. Wider windows (1440p and up) get a matching zoom so text and
// charts don't shrink; Settings → Display can force a scale instead.
function autoScale() {
  const dipWidth = window.innerWidth * api.getZoom();
  return clamp(Math.round(dipWidth / 2100 * 20) / 20, 1, 1.25);
}
function applyScale() {
  const want = state.settings?.uiScale || autoScale();
  if (Math.abs(api.getZoom() - want) > 0.001) api.setZoom(want);
}
let scaleTimer = 0;
window.addEventListener('resize', () => { clearTimeout(scaleTimer); scaleTimer = setTimeout(applyScale, 150); });

// ---------- Status ----------
function renderStatus() {
  const e = state.env;
  const rows = [
    ['CS2', e.cs2Dir ? (e.cs2Running ? 'ok' : 'warn') : 'bad', e.cs2Dir ? (e.cs2Running ? 'Running' : 'Installed') : 'Not found'],
    ['ffmpeg', e.ffmpeg ? 'ok' : 'bad', e.ffmpeg ? (e.encoder || '').replace('h264_', '').replace('lib', '') : 'Missing'],
    ['Recorder', e.hlae?.installed ? 'ok' : 'bad', e.hlae?.installed ? `HLAE ${e.hlae.version}` : 'HLAE missing'],
  ];
  $('#status').replaceChildren(...rows.map(([k, cls, v]) => h('div', { class: 'status-row' }, h('span', { class: `dot ${cls}` }), k, h('b', { title: v }, v))));
  renderMeCard();
}

// The signed-in player at the top of the sidebar.
function renderMeCard() {
  const e = state.env;
  const name = state.profile?.name || e?.steamUser?.name || 'Unknown player';
  const n = state.profile?.matches.length;
  $('#meCard').replaceChildren(
    h('div', { class: 'avatar' }, (name.replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase()),
    h('div', { class: 'me-text' },
      h('div', { class: 'me-name', title: name }, name),
      h('div', { class: 'me-sub' }, e?.mySteamId ? (n != null ? `${n} match${n === 1 ? '' : 'es'} analyzed` : 'Steam account') : 'Set your SteamID in Settings')),
    h('span', { class: `dot ${e?.mySteamId ? 'ok' : 'bad'}`, title: e?.mySteamId ? `SteamID ${e.mySteamId}` : 'No Steam account found' }),
  );
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
  loadProfile();
  backgroundAnalyze();
}

// My per-match numbers (overview, maps). Reloaded as background parsing adds matches.
async function loadProfile() {
  const p = await api.profile().catch(e => ({ error: e.message, matches: [] }));
  state.profile = p;
  renderMeCard();
  if (state.view === 'overview') renderOverview();
  if (state.view === 'maps' && !state.mp.map) renderMaps();
}
let profileTimer = 0;
const reloadProfileSoon = () => { clearTimeout(profileTimer); profileTimer = setTimeout(loadProfile, 1500); };

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
        reloadProfileSoon();
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
  $('#matchCount').textContent = state.demos.length || '';
  $('#demoListSub').replaceChildren(
    `${state.demos.length} match${state.demos.length === 1 ? '' : 'es'}`,
    pending ? h('span', {}, ' · ', h('span', { class: 'spinner', style: { width: '11px', height: '11px', borderWidth: '2px' } }), ` analyzing ${pending}…`) : '',
  );
  const mine = new Map((state.profile?.matches || []).map(m => [m.id, m]));
  $('#demos').replaceChildren(...list.map(d => {
    const s = d.summary;
    const sc = s?.score;
    const res = sc ? resultOf(sc.mine, sc.enemy) : null;
    const isMM = /^match730_/.test(d.name);
    const me = mine.get(d.id);
    const title = h('div', { class: 'demo-title', title: 'Double-click to rename', ondblclick: e => { e.stopPropagation(); editName(d, title); } }, demoTitle(d));
    const where = isRush(d) ? 'could not be read' : isMM ? 'Valve match' : d.name.replace(/\.dem$/i, '');
    return h('div', { class: `demo res-${res || 'none'} ${state.demo?.path === d.path ? 'active' : ''}`, onclick: () => openDemo(d) },
      mapThumb(s?.map, s ? null : isRush(d) ? 'RSH' : d.failed ? '!' : '…'),
      h('div', { style: { minWidth: 0 } },
        title,
        h('div', { class: 'demo-meta', title: d.path }, `${fmtDate(d.date)} · ${d.customName && s ? mapName(s.map) : where}`),
      ),
      h('div', { class: 'demo-right' },
        sc ? h('div', { class: `demo-score score-${res}` }, `${sc.mine}:${sc.enemy}`) : h('div', { class: 'demo-score score-d' }, s ? '—' : ''),
        me ? h('div', { class: 'demo-kd' }, `${me.kills}–${me.deaths}`, me.rating != null ? h('span', { class: `rtg ${ratingClass(me.rating)}` }, me.rating.toFixed(2)) : null)
          : s?.stats ? h('div', { class: 'demo-kd' }, `${s.stats.kills}–${s.stats.deaths}`) : null,
      ));
  }));
}

// Small square map badge: the radar image when there is one, else the map's color.
function mapThumb(map, fallback) {
  const info = map && radarMaps ? radarInfo(map) : null;
  const src = info ? `radar/${radarName(info, map)}.png` : null;
  return h('div', { class: 'map-thumb', style: { '--c': mapColor(map), backgroundImage: src ? `url("${src}")` : null } },
    h('span', {}, map ? mapName(map).slice(0, 3).toUpperCase() : fallback));
}

async function openDemo(d, player, tab) {
  if (state.demo?.id !== d.id) { state.stats = null; state.tab = tab || 'scoreboard'; resetZoom(state.heat.view); resetZoom(state.radar.view); }
  else if (tab) state.tab = tab;
  if (state.view !== 'matches') showView('matches');
  state.demo = d;
  state.selected.clear();
  state.analyzing = true;
  state.analysis = null;
  renderDemoList();
  renderDetail();
  try {
    state.analysis = await api.analyze(d.path, player || undefined);
    state.player = state.analysis.player || null;
    // preselect strong highlights that weren't clipped yet
    for (const hl of state.analysis.highlights || []) if (hl.score >= 40 && !clipsOf(hl).length) state.selected.add(hl.id);
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
    el.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner', style: { width: '28px', height: '28px' } }), h('h2', {}, 'Reading demo…'), h('div', {}, 'Reading rounds, kills and stats. Each demo is only read once.')));
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

  const res = a.score ? resultOf(a.score.mine, a.score.enemy) : 'd';
  // Numbers of the point-of-view player: from the scoreboard once it's loaded (it has ADR and rating).
  const sb = matchStats()?.value?.teams.flatMap(t => t.players).find(p => p.steamid === a.player?.steamid);
  const info = radarInfo(a.map);
  const stat = (k, v, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v));
  const hero = h('div', { class: 'hero', style: { '--hero-c': mapColor(a.map), '--hero-img': info ? `url("radar/${radarName(info, a.map)}.png")` : 'none' } },
    h('div', { class: 'hero-top' },
      h('div', { class: 'hero-title' },
        h('div', { class: 'hero-kicker' }, mapName(a.map), a.playerFound ? h('span', { class: `result-pill r-${res}` }, res === 'w' ? 'Win' : res === 'l' ? 'Loss' : 'Draw') : null),
        h('div', { class: 'title-row' },
          h('h1', {}, d.customName || mapName(a.map)),
          h('button', { class: 'icon-btn rename', title: 'Rename this match (only in ClipMaker, the file keeps its name)', onclick: e => editName(d, e.currentTarget.previousSibling) }, icon(PENCIL))),
        h('div', { class: 'sub' }, `${fmtDate(d.date)} · ${a.rounds} rounds · ${fmtSize(d.size)}`),
      ),
      a.playerFound ? h('div', { class: 'stat-row' },
        stat('Score', `${a.score.mine} : ${a.score.enemy}`, `score-${res}`),
        stat('K – D', sb ? `${sb.kills} – ${sb.deaths}` : `${a.stats.kills} – ${a.stats.deaths}`),
        sb ? stat('ADR', sb.adr.toFixed(0)) : null,
        stat('HS %', `${sb ? sb.hsPct : a.stats.hsPct}%`),
        sb ? stat('Rating', sb.rating == null ? '—' : sb.rating.toFixed(2), ratingClass(sb.rating)) : null,
      ) : null,
    ),
    h('div', { class: 'player-pick' }, icon('<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="1.8"/>'), 'Point of view', playerSelect,
      h('span', { class: 'spacer' }),
      viewInCs2Button('View demo', 'btn', 'Opens this demo in CS2 (through HLAE) at the first round, in the eyes of the point-of-view player',
        () => ({ name: a.player?.name }), 'The demo is playing in the CS2 window.')),
  );

  const tab = state.tab;
  const nHl = a.highlights?.length || 0;
  const tabs = h('div', { class: 'match-tabs' }, ...MATCH_TABS.map(([k, l]) =>
    h('button', { class: tab === k ? 'on' : '', onclick: () => { state.tab = k; renderDetail(); } }, l,
      k === 'highlights' && nHl ? h('span', { class: 'tab-count' }, nHl) : null)));
  const body = tab === 'scoreboard' ? scoreboardView()
    : tab === 'duels' ? duelsView()
      : tab === 'heatmap' ? heatmapView()
        : tab === 'radar' ? radarView()
          : tab === 'integrity' ? integrityView()
            : highlightsView(a);
  el.replaceChildren(
    h('div', { class: 'detail-scroll' }, hero, tabs, ...[body].flat()),
    ...(tab === 'highlights' ? [actionBar()] : []),
  );
}

const MATCH_TABS = [['scoreboard', 'Scoreboard'], ['duels', 'Duels'], ['heatmap', 'Heatmap'], ['radar', '2D Replay'], ['integrity', 'Integrity'], ['highlights', 'Highlights & clips']];
state.tab = 'scoreboard';

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
      h('tbody', {}, ...rows.map(p => h('tr', { class: p.steamid === me ? 'me' : '', title: `View the match as ${p.name}`, onclick: pick(p.steamid) },
        h('td', { class: 'name' }, p.name),
        ...cols.map(([, , val, fmt, cls]) => h('td', { class: cls ? cls(p) : '' }, fmt ? fmt(p) : val(p)))))),
    );
  };
  return [
    h('div', { class: 'section-head' }, h('h3', {}, 'Scoreboard'),
      h('div', { class: 'tabs' }, ...[[false, 'Compact'], [true, 'Detailed']].map(([v, l]) =>
        h('button', { class: detailed === v ? 'on' : '', onclick: () => { state.sbDetailed = v; renderDetail(); } }, l))),
      h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Click a column to sort it, a player to view the match as them. Hover a column for its meaning.')),
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

// ---------- Integrity (aim and game-sense anomalies) ----------
// Built once per demo in the main process (about a minute the first time), then cached.
function integrityData() {
  const d = state.demo;
  if (state.integ?.id === d.id) return state.integ;
  if (state.integLoading !== d.id) {
    state.integLoading = d.id;
    state.integProgress = 0;
    state.integPhase = null;
    api.integrity(d.path)
      .then(v => { state.integ = { id: d.id, value: v }; })
      .catch(e => { state.integ = { id: d.id, error: e.message }; })
      .finally(() => { if (state.integLoading === d.id) state.integLoading = null; if (state.demo?.id === d.id && state.tab === 'integrity') renderDetail(); });
  }
  return null;
}
const integProgressText = () => state.integPhase === 'geometry'
  ? 'Downloading the map geometry first (57 MB, only once)…'
  : `${Math.round((state.integProgress || 0) * 100)}%`;
api.onIntegrityProgress(({ id, progress, phase }) => {
  if (state.integLoading !== id) return;
  state.integProgress = progress;
  state.integPhase = phase;
  const el = document.getElementById('integ-progress');
  if (el) el.textContent = integProgressText();
});

const INTEG_LEVEL = { normal: ['Normal', 'ok'], unusual: ['Unusual', 'new'], very: ['Very unusual', 'bad'] };
const MOMENT_KIND = { snap: 'Aim without mouse', track: 'Followed through a wall', wallhit: 'Hit through a wall', contact: 'Aimed where they appeared' };

function integrityView() {
  const st = integrityData();
  if (!st) return h('div', { class: 'empty' }, spinner(24), h('h2', {}, 'Checking every player’s aim…'),
    h('div', {}, 'Going through every tick of the match: view angles, mouse movement and who could see whom through the map’s walls. Only the first time for each match: it takes under a minute. ',
      h('b', { id: 'integ-progress' }, integProgressText())));
  if (st.error) return h('div', { class: 'empty' }, h('h2', {}, 'Could not check this demo'), h('div', { class: 'err-box' }, st.error));

  const { players } = st.value;
  if (!players.length) return h('div', { class: 'empty' }, h('h2', {}, 'No players to check'));
  const sel = players.find(p => p.steamid === state.integPlayer) || players[0];
  const teamName = p => p.team == null ? '' : p.team === st.value.myTeam ? 'Your team' : 'Opponents';
  const table = h('table', { class: 'sb integ' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'team' }, 'Player'),
      h('th', { title: 'One very unusual signal, or two unusual ones, make a player very unusual' }, 'Overall'),
      ...sel.signals.map(c => h('th', { title: `${c.tip}\n\nNormal: ${c.normal}` }, c.label)),
      h('th', { title: 'Kills and headshot percentage, for context' }, 'K · HS%'))),
    h('tbody', {}, ...players.map(p => h('tr', { class: `${p.steamid === sel.steamid ? 'on' : ''} ${p.mine ? 'me' : ''}`, title: 'Show this player’s moments', onclick: () => { state.integPlayer = p.steamid; renderDetail(); } },
      h('td', { class: 'name' }, p.name, h('span', { class: 'integ-team' }, teamName(p))),
      h('td', {}, h('span', { class: `pill ${INTEG_LEVEL[p.level][1]}` }, INTEG_LEVEL[p.level][0])),
      ...p.signals.map(s => h('td', { class: `integ-${s.level}`, title: `Normal: ${s.normal}` }, s.display)),
      h('td', {}, `${p.context.kills} · ${p.context.hsPct}%`)))));

  return [
    h('div', { class: 'section-head' }, h('h3', {}, 'Integrity'), h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, 'Red flags read from the demo, not proof. Watch the moments before judging anyone. Hover a column for what it measures.')),
    st.value.lineOfSight ? null : h('div', { class: 'integ-note' }, 'No map geometry for this map (or it could not be downloaded), so who could see whom comes from the in-game radar, which lags behind quick peeks. The wall-related numbers are rougher than usual.'),
    h('div', { class: 'sb-wrap' }, table),
    ...integrityMoments(sel),
  ];
}

function integrityMoments(p) {
  const minor = p.moments.filter(m => m.minor);
  const showMinor = !!state.integMinor;
  const list = showMinor ? p.moments : p.moments.filter(m => !m.minor);
  const row = m => h('div', { class: `integ-moment ${m.strong ? 'strong' : ''}` },
    h('div', { class: 'round-box' }, h('div', { class: 'l' }, 'Round'), h('div', { class: 'n' }, m.round), h('div', { class: 'l' }, fmtDur(m.clock))),
    h('div', { class: 'integ-text' }, h('span', { class: `tag integ-${m.kind}` }, MOMENT_KIND[m.kind]), h('div', {}, m.text)),
    h('div', { class: 'integ-actions' },
      h('button', { class: 'btn', title: 'Open the 2D replay 2 s before this moment, viewing the match as this player', onclick: () => showInReplay(p.steamid, m.tick) }, '2D replay'),
      viewInCs2Button('View in CS2', 'btn', m.kind === 'snap'
        ? 'Opens the demo in CS2 in this player’s eyes 3 s before the snap and pauses right after it'
        : 'Opens the demo in CS2 in this player’s eyes 3 s before this moment',
      () => ({ tick: m.kind === 'snap' ? m.tick + 2 : m.tick, lead: 3, pause: m.kind === 'snap', name: p.name }),
      m.kind === 'snap' ? 'Paused right after the snap in CS2. Use the demo controls (Shift+F2) to step back and forth.' : 'The demo is playing in the CS2 window.')));
  return [
    h('div', { class: 'section-head' },
      h('h3', {}, `Moments · ${p.name}`),
      minor.length ? toggle(`Show ${minor.length} weaker moment${minor.length > 1 ? 's' : ''}`, showMinor, v => { state.integMinor = v; renderDetail(); },
        'Every time the crosshair was already on an unknown enemy as they came into view (good crosshair placement does this too, so one by one they mean little), and snaps onto an enemy without a shot.') : null,
      h('span', { class: 'spacer' }),
      p.context.mouselessOther ? h('span', { class: 'hint', title: 'Snaps without mouse movement that were not onto an enemy followed by a shot: turn keys, a controller, lag or the server moving the view. Not counted.' },
        p.context.mouselessOther >= 20 ? `Often turns without the mouse (${p.context.mouselessOther}×): turn keys or a controller?` : `${p.context.mouselessOther} other snap${p.context.mouselessOther > 1 ? 's' : ''} without mouse (not counted)`) : null),
    list.length ? h('div', { class: 'integ-moments' }, ...list.map(row))
      : h('div', { class: 'integ-none' }, 'Nothing stood out for this player.'),
  ];
}

// Opens the 2D replay at a tick, viewing the match as that player.
function showInReplay(steamid, tick) {
  state.radar.jump = tick;
  if (state.analysis?.player?.steamid !== steamid) openDemo(state.demo, steamid, 'radar');
  else { state.tab = 'radar'; renderDetail(); }
}

// ---------- Radar images (shared by the heatmaps, the Maps page and the 2D replay) ----------
// Bundled in radar/ by scripts/extract-radars.js: 1024 px images plus, per map, the world position of
// the image's upper-left corner and the world units per pixel. Two-floor maps have a _lower image.
const RADAR_SIZE = 1024;
let radarMaps = null;
const radarImages = new Map();
function radarInfo(map) {
  if (!radarMaps) {
    radarMaps = {};
    api.radarMaps().then(m => { radarMaps = m; rerender(); }).catch(() => {});
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

// ---------- Zoom & pan (heatmaps, Maps page, 2D replay) ----------
// Canvases draw in radar pixels (0…1024). A view is the zoom k plus the radar pixel (x, y) shown at the
// canvas' upper-left corner. The wheel zooms towards the cursor, dragging pans, double-click resets.
const MAX_ZOOM = 12;
const newView = () => ({ k: 1, x: 0, y: 0 });
const resetZoom = v => Object.assign(v, newView());
function clampView(v) {
  v.k = clamp(v.k, 1, MAX_ZOOM);
  const span = RADAR_SIZE - RADAR_SIZE / v.k;
  v.x = clamp(v.x, 0, span);
  v.y = clamp(v.y, 0, span);
}
// Zooms by f keeping the radar pixel under (mx, my) — canvas position in 0…1024 — where it is.
function zoomAt(v, mx, my, f) {
  const wx = v.x + mx / v.k, wy = v.y + my / v.k;
  v.k = clamp(v.k * f, 1, MAX_ZOOM);
  v.x = wx - mx / v.k;
  v.y = wy - my / v.k;
  clampView(v);
}
const viewScale = (canvas, v) => canvas.width / RADAR_SIZE * v.k;
// Canvas pixel where a radar pixel is drawn, and the 2D-context transform doing the same.
const viewPt = (canvas, v, x, y) => { const s = viewScale(canvas, v); return [(x - v.x) * s, (y - v.y) * s]; };
function applyView(ctx, canvas, v) { const s = viewScale(canvas, v); ctx.setTransform(s, 0, 0, s, -v.x * s, -v.y * s); }

// Makes a canvas zoomable and returns it wrapped with +/−/reset buttons. Several canvases can share
// one view (the heatmap's T and CT maps zoom together); redraw has to repaint all of them.
function zoomable(canvas, v, redraw) {
  const level = h('span', { class: 'zoom-level' });
  v.labels = [...(v.labels || []).filter(l => l.isConnected), level];
  const sync = () => {
    redraw();
    for (const l of v.labels) l.textContent = v.k > 1.01 ? `${v.k.toFixed(1)}×` : '';
    for (const c of document.querySelectorAll('canvas.zoomable')) if (c.zoomView === v) c.classList.toggle('zoomed', v.k > 1.01);
  };
  canvas.zoomView = v;
  canvas.classList.add('zoomable');
  canvas.classList.toggle('zoomed', v.k > 1.01);
  level.textContent = v.k > 1.01 ? `${v.k.toFixed(1)}×` : '';
  const at = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * RADAR_SIZE, (e.clientY - r.top) / r.height * RADAR_SIZE]; };
  canvas.addEventListener('wheel', e => { e.preventDefault(); const [mx, my] = at(e); zoomAt(v, mx, my, Math.exp(-e.deltaY * 0.0018)); sync(); }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || v.k <= 1.01) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    v.x -= (e.clientX - drag.x) / r.width * RADAR_SIZE / v.k;
    v.y -= (e.clientY - drag.y) / r.height * RADAR_SIZE / v.k;
    drag = { x: e.clientX, y: e.clientY };
    clampView(v);
    sync();
  });
  const end = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', () => { resetZoom(v); sync(); });
  const btn = (title, d, fn) => h('button', { title, onclick: e => { e.stopPropagation(); fn(); sync(); } }, icon(d));
  return h('div', { class: 'zoom-wrap' }, canvas,
    h('div', { class: 'zoom-ctl' },
      btn('Zoom in (mouse wheel)', '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>', () => zoomAt(v, RADAR_SIZE / 2, RADAR_SIZE / 2, 1.5)),
      btn('Zoom out', '<path d="M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>', () => zoomAt(v, RADAR_SIZE / 2, RADAR_SIZE / 2, 1 / 1.5)),
      btn('Whole map (double-click)', '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>', () => resetZoom(v)),
      level));
}

// ---------- Heatmaps ----------
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
const GRENADE_KINDS = new Set(['smoke', 'flash', 'he', 'molotov']);
const WEAPON_KINDS = new Set([0, 2, 3]); // kill, shot, dealt: the weapon filter means "your weapon"
state.heat = { layers: new Set(['kill', 'death']), scope: 'match', weapon: 'all', floor: 'upper', room: 'auto', display: 'heat', lines: true, data: null, loading: null, view: newView() };

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

// Display controls shared by the match heatmap and the Maps page: blobs or dots, grenade throw lines.
function heatDisplayControls(hs, rerender) {
  const grenades = [...hs.layers].some(k => GRENADE_KINDS.has(k));
  return [
    h('div', { class: 'tabs' }, ...[['heat', 'Heat'], ['dots', 'Dots']].map(([k, l]) =>
      h('button', { class: hs.display === k ? 'on' : '', onclick: () => { hs.display = k; rerender(); } }, l))),
    grenades ? toggle('Throw lines', hs.lines, v => { hs.lines = v; rerender(); }, 'Draw a line from where each grenade was thrown to where it landed') : null,
  ];
}

// Layer toggles with the number of points each one has.
function heatLayerChips(hs, pts, rerender, available = () => true) {
  return h('div', { class: 'chips heat-layers' }, ...HEAT_LAYERS.map(([k, l, color], idx) => {
    if (!available(k)) return null;
    const on = hs.layers.has(k);
    const n = pts.reduce((s, p) => s + (p[0] === idx), 0);
    return h('button', { class: `chip-toggle heat-chip ${on ? 'on' : ''}`, style: { '--c': color }, onclick: () => { on ? hs.layers.delete(k) : hs.layers.add(k); rerender(); } },
      h('span', { class: 'swatch' }), l, h('span', { class: 'n' }, fmtNum(n)));
  }));
}

function heatmapView() {
  const a = state.analysis;
  if (!a.playerFound) return h('div', { class: 'empty' }, h('h2', {}, 'Pick a player'), h('div', {}, 'Choose whose heatmap to show in "Point of view" above.'));
  const info = radarInfo(a.map);
  if (info === null) return h('div', { class: 'empty' }, h('h2', {}, 'No radar for this map'), h('div', {}, `There is no radar image for ${mapName(a.map)} yet. Run scripts/extract-radars.js after a CS2 update to add new maps.`));
  const data = info && heatData();
  if (!data) return h('div', { class: 'empty' }, spinner(), h('h2', {}, 'Loading heatmap…'));
  if (data.error) return h('div', { class: 'empty' }, h('h2', {}, 'No heatmap for this demo'), h('div', { class: 'err-box' }, data.error));

  const hs = state.heat;
  const weapons = [...new Set(data.points.filter(p => WEAPON_KINDS.has(p[0]) && p[2]).map(p => p[2]))].sort();
  if (hs.weapon !== 'all' && !weapons.includes(hs.weapon)) hs.weapon = 'all';
  const floors = info.lowerBelow !== undefined;
  const pts = data.points.filter(p =>
    (hs.weapon === 'all' || !WEAPON_KINDS.has(p[0]) || p[2] === hs.weapon) &&
    (!floors || onLower(info, p[5]) === (hs.floor === 'lower')));
  // Rush: show the room with the most points (or the one picked), points per room in the picker.
  let room = null, roomCounts = null;
  if (info.rooms) {
    const shown = pts.filter(p => hs.layers.has(HEAT_LAYERS[p[0]][0]));
    roomCounts = {};
    for (const p of shown) { const r = bestRoom(info, [[p[3], p[4]]]); if (r) roomCounts[r] = (roomCounts[r] || 0) + 1; }
    room = hs.room === 'auto' ? Object.entries(roomCounts).sort((x, y) => y[1] - x[1])[0]?.[0] || null : hs.room === 'overview' ? null : hs.room;
  }
  const frame = radarFrame(info, a.map, { room, lower: floors && hs.floor === 'lower' });
  if (hs.frameSrc !== frame.src) { hs.frameSrc = frame.src; resetZoom(hs.view); }

  const controls = h('div', { class: 'heat-controls' },
    h('div', { class: 'tabs' }, ...[['match', 'This match'], ['map', `All my ${mapName(a.map)} matches`]].map(([k, l]) =>
      h('button', { class: hs.scope === k ? 'on' : '', onclick: () => { hs.scope = k; renderDetail(); } }, l))),
    select(hs.weapon, [['all', 'All weapons'], ...weapons.map(w => [w, w])], v => { hs.weapon = v; renderDetail(); }),
    floors ? h('div', { class: 'tabs' }, ...[['upper', 'Upper floor'], ['lower', 'Lower floor']].map(([k, l]) =>
      h('button', { class: hs.floor === k ? 'on' : '', onclick: () => { hs.floor = k; renderDetail(); } }, l))) : null,
    roomSelect(info, hs.room, v => { hs.room = v; renderDetail(); }, roomCounts),
    ...heatDisplayControls(hs, renderDetail),
    h('span', { class: 'spacer' }),
    hs.scope === 'map' ? h('span', { class: 'hint' }, `${data.matches} analyzed match${data.matches === 1 ? '' : 'es'} with ${a.player.name}`) : null,
  );
  const layers = heatLayerChips(hs, pts, renderDetail);

  // T and CT side next to each other, zooming together.
  const v = hs.view, opts = { dots: hs.display === 'dots', lines: hs.lines };
  const painted = [];
  const redraw = () => painted.forEach(p => p && drawHeat(p.canvas, p.img, v, p.layers, opts));
  const maps = h('div', { class: 'heat-maps' }, ...[['T', 0], ['CT', 1]].map(([side, si]) => {
    const canvas = h('canvas', { width: 1280, height: 1280 });
    const prepared = prepareHeat(frame, pts.filter(p => p[1] === si), hs.layers);
    radarImage(frame.src).then(img => { painted[si] = { canvas, img, layers: prepared }; drawHeat(canvas, img, v, prepared, opts); });
    return h('div', { class: 'heat-map' }, h('div', { class: `heat-side side-${side}` }, `${side} side`, h('span', {}, ` · ${a.player.name}`)), zoomable(canvas, v, redraw));
  }));
  return [h('div', { class: 'section-head' }, h('h3', {}, 'Heatmap'), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Scroll to zoom · drag to move · double-click for the whole map')), controls, layers, maps];
}

// Each layer is a density grid (points splatted with a Gaussian), drawn as a colored, mostly
// transparent blob over the radar; with few points (or in dot mode) every position is drawn as a dot.
const HEAT_GRID = 256, HEAT_SIGMA = 2.6, HEAT_R = 7;
const HEAT_KERNEL = (() => {
  const k = [];
  for (let dy = -HEAT_R; dy <= HEAT_R; dy++) for (let dx = -HEAT_R; dx <= HEAT_R; dx++) {
    const v = Math.exp(-(dx * dx + dy * dy) / (2 * HEAT_SIGMA * HEAT_SIGMA));
    if (v > 0.02) k.push([dx, dy, v]);
  }
  return k;
})();

// Radar-pixel positions and density image of every visible layer; done once, redrawn on every zoom.
function prepareHeat(frame, pts, layers) {
  const out = [];
  HEAT_LAYERS.forEach(([k, , color], idx) => {
    if (!layers.has(k)) return;
    const px = [];
    for (const p of pts) {
      if (p[0] !== idx) continue;
      const [x, y] = toPx(frame, p[3], p[4]);
      px.push(p.length > 6 ? [x, y, ...toPx(frame, p[6], p[7])] : [x, y]);
    }
    if (px.length) out.push({ kind: k, color, px, density: null });
  });
  return out;
}

function densityImage(px, color) {
  const cell = RADAR_SIZE / HEAT_GRID;
  const grid = new Float32Array(HEAT_GRID * HEAT_GRID);
  for (const [x0, y0] of px) {
    const cx = Math.round(x0 / cell), cy = Math.round(y0 / cell);
    for (const [dx, dy, v] of HEAT_KERNEL) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < HEAT_GRID && y < HEAT_GRID) grid[y * HEAT_GRID + x] += v;
    }
  }
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  const norm = Math.max(1, max * 0.75);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = HEAT_GRID;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(HEAT_GRID, HEAT_GRID);
  for (let i = 0; i < grid.length; i++) {
    const a = Math.min(1, grid[i] / norm);
    if (a < 0.05) continue;
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.round(255 * Math.min(0.9, 0.25 + 0.7 * Math.pow(a, 0.8)));
  }
  tctx.putImageData(img, 0, 0);
  return tmp;
}

function drawHeat(canvas, img, v, layers, { dots = false, lines = false } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, W);
  applyView(ctx, canvas, v);
  if (img) { ctx.globalAlpha = 0.85; ctx.drawImage(img, 0, 0, RADAR_SIZE, RADAR_SIZE); ctx.globalAlpha = 1; }
  ctx.imageSmoothingEnabled = true;
  if (!dots) for (const l of layers) ctx.drawImage(l.density ||= densityImage(l.px, l.color), 0, 0, RADAR_SIZE, RADAR_SIZE);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Dots and lines are drawn in canvas pixels so they stay sharp (and grow only a little) when zoomed.
  const base = W / RADAR_SIZE;
  const grow = Math.min(2.2, 0.8 + v.k * 0.2);
  const r = base * (dots ? 3.2 : 4) * grow;
  const pt = (x, y) => viewPt(canvas, v, x, y);
  const inside = (x, y) => x > -20 && y > -20 && x < W + 20 && y < W + 20;
  for (const l of layers) {
    if (!dots && l.px.length > 400) continue;
    if (lines && GRENADE_KINDS.has(l.kind)) {
      ctx.strokeStyle = l.color;
      ctx.lineWidth = Math.max(1, base * 1.3 * grow * 0.7);
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      for (const p of l.px) {
        if (p.length < 4) continue;
        const [x0, y0] = pt(p[2], p[3]), [x1, y1] = pt(p[0], p[1]);
        if (!inside(x0, y0) && !inside(x1, y1)) continue;
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      // Throw spots: small rings
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (const p of l.px) {
        if (p.length < 4) continue;
        const [x0, y0] = pt(p[2], p[3]);
        if (!inside(x0, y0)) continue;
        ctx.moveTo(x0 + r * 0.8, y0); ctx.arc(x0, y0, r * 0.8, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = l.color;
    ctx.strokeStyle = 'rgba(5,8,14,.75)';
    ctx.lineWidth = Math.max(1, base);
    ctx.beginPath();
    for (const p of l.px) {
      const [x, y] = pt(p[0], p[1]);
      if (!inside(x, y)) continue;
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------- Radar (2D replay) ----------
// Positions come sampled 8 times per second (see lib/track.js) and are interpolated per frame; grenade
// flights, shots, damage and bomb events are exact to the tick.
const SMOKE_RADIUS = 144, MOLOTOV_RADIUS = 120;
const SMOKE_TICKS = 18 * 64, MOLOTOV_TICKS = 7 * 64, BURST_TICKS = 32, DECOY_TICKS = 15 * 64;
const PLANT_TICKS = 200, TRACER_TICKS = 8, TRACER_LEN = 1100, DMG_TICKS = 80, EXPLOSION_TICKS = 96, TRAIL_TICKS = 96;
const NADE_COLOR = { smoke: '#d9dee7', flash: '#fff59a', he: '#ff6b6b', molotov: '#ff9d2e', decoy: '#9aa6b5' };
const NADE_LABEL = { smoke: 'Smoke', flash: 'Flash', he: 'HE', molotov: 'Molotov', decoy: 'Decoy' };
const NADE_NAME = { smokegrenade: 'Smoke', flashbang: 'Flashbang', hegrenade: 'HE grenade', molotov: 'Molotov', incgrenade: 'Incendiary', decoy: 'Decoy' };
const KEY_LETTER = { FORWARD: 'W', LEFT: 'A', BACK: 'S', RIGHT: 'D' };
const isGun = w => !!w && !/grenade|inferno|molotov|flashbang|decoy|knife|bayonet|world|c4|taser/.test(w);
state.radar = {
  data: null, loading: null, round: 1, tick: 0, playing: false, speed: 2, floor: 'upper', room: 'auto', raf: 0, view: newView(),
  nade: null, hover: null, paths: false, shots: true, list: 'kills',
};

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
        prepareReplay(data);
        r.data = data;
        r.nade = r.hover = null;
        setRadarRound(1, false);
        applyRadarJump();
      })
      .catch(e => { r.data = { id: d.id, error: e.message }; })
      .finally(() => { if (r.loading === d.id) r.loading = null; if (state.tab === 'radar') renderDetail(); });
  }
  return null;
}

// Sorts everything into rounds once, links each shot to the damage it did and each grenade flight to
// its detonation, so a frame only looks at the current round.
function prepareReplay(data) {
  const tr = data.tickrate;
  data.pidx = new Map(data.track.header.players.map((id, i) => [id, i]));
  const roundAt = tick => {
    for (let i = data.rounds.length - 1; i >= 0; i--) {
      const r = data.rounds[i];
      if (tick >= r.startTick) return tick < (r.nextStartTick ?? Infinity) ? r.num : null;
    }
    return null;
  };
  data.per = new Map(data.rounds.map(r => [r.num, { kills: [], shots: [], damage: [], nades: [], blinds: [], bomb: [], grenades: [] }]));
  const put = (key, tick, item) => { const n = roundAt(tick); if (n != null) data.per.get(n)[key].push(item); };

  for (const k of data.kills) put('kills', k.tick, k);
  for (const g of data.grenades) put('grenades', g.tick, g);
  for (const b of data.bomb) put('bomb', b.tick, b);
  for (const [tick, victim, duration] of data.blinds) if (duration >= 0.3) put('blinds', tick, { tick, victim, end: tick + duration * tr, duration });

  // [tick, attacker, victim, damage, hitgroup, weapon, victim x, victim y]
  const hits = new Map();
  for (const d of data.damage) {
    const dmg = { tick: d[0], attacker: d[1], victim: d[2], dmg: d[3], head: d[4] === 'head', weapon: d[5], x: d[6], y: d[7], gun: isGun(d[5]) };
    put('damage', dmg.tick, dmg);
    if (!dmg.gun || !dmg.attacker) continue;
    const key = `${dmg.tick}|${dmg.attacker}`;
    if (!hits.has(key)) hits.set(key, []);
    hits.get(key).push(dmg);
  }
  const players = data.track.header.players;
  for (const [tick, p, x, y, z, yaw] of data.shots || []) {
    const id = players[p];
    let hit = null;
    for (const dt of [0, 1, -1]) {
      const list = hits.get(`${tick + dt}|${id}`);
      if (list?.length) { hit = list.shift(); break; }
    }
    put('shots', tick, { tick, p, x, y, z, yaw, hit });
  }

  const effects = data.grenades.filter(g => !g.expire);
  (data.nades || []).forEach((n, i) => {
    n.i = i;
    n.pts = [];
    for (let k = 0; k < n.path.length; k += 4) n.pts.push([n.t0 + n.path[k], n.path[k + 1], n.path[k + 2], n.path[k + 3]]);
    n.land = n.pts.at(-1);
    n.round = roundAt(n.throw?.tick ?? n.t0);
    // Detonation: same entity, else the same player's same grenade type closest to where the flight ended.
    n.det = effects.find(g => g.type === n.type && g.entity === n.entity && g.tick >= n.t0 && g.tick <= n.t1 + 20 * tr)
      || effects.filter(g => g.type === n.type && g.thrower === n.thrower && Math.abs(g.tick - n.t1) <= tr).sort((a, b) => Math.abs(a.tick - n.t1) - Math.abs(b.tick - n.t1))[0]
      || null;
    const at = n.det?.tick ?? n.t1;
    const expire = n.det && data.grenades.find(g => g.expire && g.type === n.type && g.entity === n.det.entity && g.tick >= at);
    n.effectEnd = expire ? expire.tick
      : at + (n.type === 'smoke' ? SMOKE_TICKS : n.type === 'molotov' ? MOLOTOV_TICKS : n.type === 'decoy' ? DECOY_TICKS : BURST_TICKS);
    // Bounces: where the flight turns back horizontally or starts going up again.
    n.bounces = [];
    for (let k = 1; k < n.pts.length - 1; k++) {
      const [, x0, y0, z0] = n.pts[k - 1], [, x1, y1, z1] = n.pts[k], [, x2, y2, z2] = n.pts[k + 1];
      const back = (x1 - x0) * (x2 - x1) + (y1 - y0) * (y2 - y1) < 0;
      const up = z1 - z0 < -0.5 && z2 - z1 > 0.5;
      if (back || up) n.bounces.push(n.pts[k]);
    }
    if (n.round != null) data.per.get(n.round).nades.push(n);
  });
  for (const r of data.per.values()) for (const k of Object.keys(r)) r[k].sort((a, b) => a.tick !== undefined ? a.tick - b.tick : (a.throw?.tick ?? a.t0) - (b.throw?.tick ?? b.t0));
}

// "2D replay" from another tab: R.jump is the tick to show, applied once the replay is loaded.
function applyRadarJump() {
  const R = state.radar, data = R.data;
  if (R.jump == null || !data?.rounds?.length || data.id !== state.demo?.id) return;
  const tick = R.jump;
  R.jump = null;
  const rd = [...data.rounds].reverse().find(r => tick >= r.startTick) || data.rounds[0];
  setRadarRound(rd.num, false);
  R.tick = Math.max(rd.startTick, tick - 2 * data.tickrate);
}

const radarRound = () => state.radar.data.rounds.find(x => x.num === state.radar.round) || state.radar.data.rounds[0];
const roundStop = (data, r) => Math.min(r.nextStartTick ?? Infinity, r.endTick + 6 * data.tickrate);
function setRadarRound(num, play = state.radar.playing) {
  const r = state.radar;
  r.round = num;
  const rd = radarRound();
  r.tick = Math.max(rd.startTick, rd.freezeEndTick - 3 * r.data.tickrate);
  r.playing = play;
  if (r.nade != null && r.data.nades[r.nade]?.round !== rd.num) r.nade = null;
  r.hover = null;
}

// Where a grenade is at a (fractional) tick.
function nadePos(n, t) {
  const p = n.pts;
  if (t <= p[0][0]) return p[0];
  if (t >= n.land[0]) return n.land;
  let i = 1;
  while (p[i][0] < t) i++;
  const a = p[i - 1], b = p[i], f = (t - a[0]) / (b[0] - a[0]);
  return [t, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

// Bomb carrier, dropped bomb, plant, defuse and timer at tick t.
function bombState(data, rd, t) {
  const tr = data.tickrate, c4 = (data.timers?.c4 || 40) * tr;
  const st = { carrier: null, dropped: null, planted: null, ended: null, planting: null, defusing: null, explodeAt: null, c4 };
  for (const e of data.per.get(rd.num).bomb) {
    if (e.tick > t) break;
    if (e.type === 'pickup') { st.carrier = e.player; st.dropped = null; }
    else if (e.type === 'dropped') { st.carrier = null; st.dropped = e.pos; }
    else if (e.type === 'beginplant') st.planting = e;
    else if (e.type === 'planted') Object.assign(st, { planted: e, carrier: null, dropped: null, planting: null, explodeAt: e.tick + c4 });
    else if (e.type === 'begindefuse') st.defusing = e;
    else if (e.type === 'defused' || e.type === 'exploded') Object.assign(st, { ended: e, defusing: null });
  }
  // A plant or defuse stops early when the player moves away or dies (CS2 has no event for that).
  const going = (e, len) => {
    if (!e || t > e.tick + len) return null;
    const i = data.pidx.get(e.player);
    const p = i === undefined ? null : playerAt(data, i, t);
    if (!p?.alive || (e.pos && Math.hypot(p.x - e.pos[0], p.y - e.pos[1]) > 40)) return null;
    return { ...e, len, frac: (t - e.tick) / len };
  };
  st.planting = going(st.planting, PLANT_TICKS);
  st.defusing = st.planted && !st.ended ? going(st.defusing, (st.defusing?.kit ? 5 : 10) * tr) : null;
  if (st.defusing && t > st.explodeAt) st.defusing = null;
  return st;
}

// The in-game round clock at tick t: freeze time, round time left, or the bomb timer once planted.
function roundClock(data, rd, t, bs) {
  const tr = data.tickrate;
  if (t < rd.freezeEndTick) return { kind: 'freeze', time: (rd.freezeEndTick - t) / tr };
  if (bs?.planted && !bs.ended) return { kind: 'bomb', time: Math.max(0, (bs.explodeAt - t) / tr) };
  if (t >= rd.endTick) return { kind: 'end', time: null };
  return { kind: 'live', time: Math.max(0, (data.timers?.roundTime || 115) - (t - rd.freezeEndTick) / tr) };
}
const fmtClock = (s, tenths = false) => (tenths && s < 10 ? s.toFixed(1) : fmtDur(Math.ceil(s - 1e-6)));
// Round clock as a label for lists ("1:32", "bomb 0:21", "freeze")
function clockLabel(data, rd, tick) {
  const c = roundClock(data, rd, tick, bombState(data, rd, tick));
  return c.kind === 'freeze' ? 'freeze' : c.kind === 'bomb' ? `💣 ${fmtClock(c.time)}` : c.kind === 'end' ? 'after' : fmtClock(c.time);
}

function radarView() {
  const a = state.analysis;
  const info = radarInfo(a.map);
  if (info === null) return h('div', { class: 'empty' }, h('h2', {}, 'No radar for this map'), h('div', {}, `There is no radar image for ${mapName(a.map)} yet.`));
  const data = info && replayData();
  if (!data) return h('div', { class: 'empty' }, h('span', { class: 'spinner', style: { width: '24px', height: '24px' } }), h('h2', {}, 'Reading the replay…'), h('div', {}, 'Player positions, grenade flights, shots and the bomb. Only the first time for each match: it takes about 20 seconds.'));
  if (data.error) return h('div', { class: 'empty' }, h('h2', {}, 'No replay for this demo'), h('div', { class: 'err-box' }, data.error));

  const R = state.radar;
  applyRadarJump();
  const rd = radarRound();
  const rr = data.per.get(rd.num);
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

  const canvas = h('canvas', { width: 1400, height: 1400, class: 'radar-canvas' });
  if (R.frameSrc !== frame.src) { R.frameSrc = frame.src; resetZoom(R.view); }
  const stop = roundStop(data, rd);
  const slider = h('input', { type: 'range', class: 'radar-slider', min: rd.startTick, max: stop, step: 1, value: R.tick,
    oninput: e => { R.tick = +e.target.value; } });
  const playBtn = h('button', { class: 'icon-btn', title: 'Play / pause (Space)', onclick: () => { R.playing = !R.playing; if (R.tick >= stop) setRadarRound(R.round, true); } });
  const hud = h('div', { class: 'radar-hud' });
  const card = h('div', { class: 'nade-card-slot' });
  const feed = h('div', { class: 'radar-feed' });
  const teams = h('div', { class: 'radar-teams' });
  R.els = { canvas, slider, playBtn, hud, card, feed, teams, built: null, hudKey: null };

  const rounds = h('div', { class: 'radar-rounds' }, ...data.rounds.map(x => h('button', {
    class: `rr win-${x.winner} ${x.num === R.round ? 'on' : ''}`, title: `Round ${x.num}: ${x.winner} won (${(x.reason || '').replace(/_/g, ' ')})`,
    onclick: () => { setRadarRound(x.num); renderDetail(); },
  }, x.num)));

  // Timeline marks under the slider: kills, grenades, plant, defuse/explosion. Click one to jump there.
  const span = stop - rd.startTick;
  const mark = (tick, cls, title, color, onclick) => h('button', {
    class: `tl-mark ${cls}`, title, style: { left: `${clamp((tick - rd.startTick) / span, 0, 1) * 100}%`, ...(color ? { '--c': color } : {}) },
    onclick: onclick || (() => { R.tick = tick - 2 * data.tickrate; }),
  });
  const marks = h('div', { class: 'tl-marks' },
    mark(rd.freezeEndTick, 'freeze', 'Freeze time ends'),
    ...rr.nades.filter(n => n.throw).map(n => mark(n.throw.tick, `nade ${n.i === R.nade ? 'sel' : ''}`, `${data.names[n.thrower] || '?'}: ${NADE_LABEL[n.type]}`, NADE_COLOR[n.type], () => selectNade(n.i, true))),
    ...rr.kills.map(k => mark(k.tick, `kill side-${k.victimTeam}`, `${data.names[k.attacker] || 'World'} killed ${data.names[k.victim] || '?'} (${k.weapon})`)),
    ...rr.bomb.filter(b => ['planted', 'defused', 'exploded'].includes(b.type)).map(b => mark(b.tick, `bomb ${b.type}`, `Bomb ${b.type}${b.player ? ` by ${data.names[b.player] || '?'}` : ''}`)),
  );
  const timeline = h('div', { class: 'radar-timeline' }, slider, marks);

  const controls = h('div', { class: 'radar-controls' },
    h('button', { class: 'icon-btn', title: 'Previous round (↑)', disabled: R.round <= 1, onclick: () => { setRadarRound(R.round - 1); renderDetail(); } }, icon('<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2"/>')),
    playBtn,
    h('button', { class: 'icon-btn', title: 'Next round (↓)', disabled: R.round >= data.rounds.length, onclick: () => { setRadarRound(R.round + 1); renderDetail(); } }, icon('<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/>')),
    timeline,
    select(String(R.speed), [['0.25', '0.25×'], ['0.5', '0.5×'], ['1', '1×'], ['2', '2×'], ['4', '4×'], ['8', '8×']], v => { R.speed = +v; }),
  );
  const options = h('div', { class: 'radar-options' },
    toggle('Shots', R.shots, v => { R.shots = v; }, 'Bullet tracers, hits and damage numbers'),
    toggle('Grenade paths', R.paths, v => { R.paths = v; }, 'Keep the flight path of every grenade thrown so far this round on the map'),
    floors ? h('div', { class: 'tabs' }, ...[['upper', 'Upper'], ['lower', 'Lower']].map(([k, l]) =>
      h('button', { class: R.floor === k ? 'on' : '', onclick: () => { R.floor = k; renderDetail(); } }, l))) : null,
    roomSelect(info, R.room, v => { R.room = v; renderDetail(); }),
    h('span', { class: 'spacer' }),
    h('span', { class: 'hint' }, 'Click a grenade to see how it was thrown'),
    viewInCs2Button('View in CS2', 'btn', 'Opens this demo in CS2 (through HLAE) 2 s before this moment, in the eyes of the point-of-view player',
      () => ({ tick: R.tick, lead: 2, name: state.analysis?.player?.name }), 'The demo is playing in the CS2 window.'),
  );

  // Clicking a grenade (in flight, its smoke/fire, or its path) opens how it was thrown.
  const toCanvas = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * canvas.width, (e.clientY - r.top) / r.height * canvas.height]; };
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('click', e => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const n = nadeAt(...toCanvas(e));
    if (n || R.nade != null) selectNade(n ? n.i : null);
  });
  canvas.addEventListener('pointermove', e => {
    if (e.buttons) return;
    const n = nadeAt(...toCanvas(e));
    R.hover = n ? n.i : null;
    canvas.style.cursor = n ? 'pointer' : '';
  });
  canvas.addEventListener('pointerleave', () => { R.hover = null; });

  const wrap = zoomable(canvas, R.view, () => {});
  wrap.append(hud);
  const listTabs = h('div', { class: 'tabs side-tabs' }, ...[['kills', 'Kills'], ['utility', `Utility (${rr.nades.length})`]].map(([k, l]) =>
    h('button', { class: R.list === k ? 'on' : '', onclick: () => { R.list = k; R.els.built = null; renderSideTabs(); } }, l)));
  const renderSideTabs = () => listTabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['kills', 'utility'][i] === R.list));
  renderNadeCard();
  startRadarLoop();
  return [
    h('div', { class: 'section-head' }, h('h3', {}, `Round ${R.round}`), h('span', { class: `pill side-${rd.winner}` }, `${rd.winner} win`), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Space: play/pause · ←/→: 5 s (Shift: ⅛ s) · ↑/↓: round · Esc: close grenade')),
    rounds,
    controls,
    options,
    h('div', { class: 'radar-layout' },
      h('div', { class: 'radar-main' }, wrap),
      h('div', { class: 'radar-side' }, card, teams, h('div', { class: 'radar-list' }, listTabs, feed))),
  ];
}

// The grenade under a canvas position, if any: in flight, its smoke/fire while it lasts, its drawn path or throw spot.
function nadeAt(mx, my) {
  const R = state.radar, data = R.data, info = R.info, canvas = R.els?.canvas;
  if (!data?.per || !info || !canvas) return null;
  const t = R.tick, tr = data.tickrate, v = R.view;
  const cp = (x, y) => viewPt(canvas, v, ...toPx(info, x, y));
  const reach = 14 * canvas.width / canvas.getBoundingClientRect().width;
  const toWorld = viewScale(canvas, v) / info.scale;
  let best = null, bd = Infinity;
  const consider = (n, d) => { if (d < bd) { bd = d; best = n; } };
  const seg = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const k = l ? clamp(((mx - ax) * dx + (my - ay) * dy) / l, 0, 1) : 0;
    return Math.hypot(mx - ax - k * dx, my - ay - k * dy);
  };
  for (const n of data.per.get(radarRound().num).nades) {
    const sel = n.i === R.nade;
    if (n.t0 > t && !sel) continue;
    if (t <= n.t1) { const [, x, y] = nadePos(n, t); consider(n, Math.hypot(mx - cp(x, y)[0], my - cp(x, y)[1])); }
    else if (t <= n.effectEnd) {
      const [x, y] = cp(n.land[1], n.land[2]);
      const radius = n.type === 'smoke' ? SMOKE_RADIUS : n.type === 'molotov' ? MOLOTOV_RADIUS : 0;
      consider(n, Math.max(0, Math.hypot(mx - x, my - y) - radius * toWorld));
    }
    if (sel || R.paths || t - n.t1 < TRAIL_TICKS) {
      const upto = sel ? n.t1 : Math.min(t, n.t1);
      let prev = null;
      for (const p of n.pts) {
        if (p[0] > upto) break;
        const c = cp(p[1], p[2]);
        if (prev) consider(n, seg(prev[0], prev[1], c[0], c[1]));
        prev = c;
      }
      if (n.throw && (sel || R.paths)) { const [x, y] = cp(n.throw.pos[0], n.throw.pos[1]); consider(n, Math.hypot(mx - x, my - y)); }
    }
  }
  return bd <= reach ? best : null;
}

function selectNade(i, jump = false) {
  const R = state.radar;
  R.nade = i;
  if (jump && i != null) { const n = R.data.nades[i]; R.tick = (n.throw?.tick ?? n.t0) - R.data.tickrate; R.playing = false; }
  R.els.built = null;
  renderNadeCard();
  R.els.slider.parentElement.querySelectorAll('.tl-mark.nade').forEach(m => m.classList.remove('sel'));
}

// Replays one throw on the map: zoomed onto its flight, from 2 s before the throw, at half speed.
function replayThrow(n) {
  const R = state.radar, data = R.data, info = R.info, v = R.view;
  const xy = n.pts.map(p => toPx(info, p[1], p[2]));
  if (n.throw) xy.push(toPx(info, n.throw.pos[0], n.throw.pos[1]));
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), hgt = Math.max(...ys) - Math.min(...ys);
  v.k = clamp(RADAR_SIZE * 0.6 / Math.max(w, hgt, 60), 1, 5);
  v.x = (Math.max(...xs) + Math.min(...xs)) / 2 - RADAR_SIZE / v.k / 2;
  v.y = (Math.max(...ys) + Math.min(...ys)) / 2 - RADAR_SIZE / v.k / 2;
  clampView(v);
  R.tick = (n.throw?.tick ?? n.t0) - 2 * data.tickrate;
  R.speed = 0.5;
  R.playing = true;
  R.nade = n.i;
  renderDetail();
}

// How a grenade was thrown, in words: movement, mouse buttons, keys.
function throwTechnique(th) {
  const keys = (th.keys || []).map(k => KEY_LETTER[k]).join(' + ');
  const moving = th.speed != null && th.speed >= 10;
  let move;
  // The jump key held while already in the air also counts: the jump itself isn't always in the demo.
  if (th.air && (th.jumpAgo != null ? th.jumpAgo <= 4 : th.jumpKey)) move = moving && keys ? 'Running jump-throw' : 'Jump-throw';
  else if (th.air) move = th.jumpAgo != null ? `Thrown in the air, ${Math.round(th.jumpAgo / 64 * 1000)} ms after jumping` : 'Thrown while falling';
  else if (!moving) move = th.duck ? 'Crouching, standing still' : 'Standing still';
  else if (th.duck) move = 'Crouch-walking';
  else if (th.walk) move = 'Walking (Shift)';
  else move = 'Running';
  const click = th.left && th.right ? 'Left + right click · medium throw' : th.right ? 'Right click · short underhand throw' : 'Left click · full throw';
  return { move, keys, click };
}

const setposCmd = th => {
  const p = th.air && th.jumpPos ? th.jumpPos : th.pos;
  return `setpos ${p[0]} ${p[1]} ${p[2]}; setang ${th.pitch} ${th.yaw} 0`;
};

// Button opening the current demo in CS2 at a moment (see demo:watch in main.js); opts() is read on click.
function viewInCs2Button(label, cls, title, opts, doneMsg) {
  const text = h('span', {}, label);
  const btn = h('button', { class: cls, title }, icon(ICONS.screen), text);
  btn.onclick = async () => {
    const file = state.demo.path, o = opts();
    btn.disabled = true;
    text.textContent = 'Opening CS2…';
    toast('Opening the demo in CS2. The first time takes a minute or two (CS2 starts, then loads the demo).');
    try { await api.watchDemo(file, o); toast(doneMsg, 'ok'); }
    catch (e) { toast(e.message.replace(/^.*HLAE_MISSING:s*/, ''), 'error'); }
    btn.disabled = false;
    text.textContent = label;
  };
  return btn;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', {}, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

function renderNadeCard() {
  const R = state.radar, els = R.els;
  if (!els) return;
  const n = R.nade != null ? R.data.nades[R.nade] : null;
  els.card.replaceChildren(n ? nadeCard(n) : '');
}

function nadeCard(n) {
  const R = state.radar, data = R.data, tr = data.tickrate, rd = radarRound();
  const th = n.throw;
  const name = data.names[n.thrower] || 'Unknown player';
  const pi = data.pidx.get(n.thrower);
  const side = pi === undefined ? '' : playerAt(data, pi, th?.tick ?? n.t0)?.ct ? 'CT' : 'T';
  const label = (th && NADE_NAME[th.weapon]) || NADE_LABEL[n.type];
  const start = th ? th.pos : n.pts[0].slice(1);
  const dist = Math.round(Math.hypot(n.land[1] - start[0], n.land[2] - start[1]));
  const flight = (n.t1 - (th?.tick ?? n.t0)) / tr;
  const tech = th && throwTechnique(th);
  const fact = (k, v, title) => h('div', { class: 'nc-fact', title }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

  const profile = h('canvas', { class: 'nc-profile', width: 560, height: 170 });
  requestAnimationFrame(() => drawProfile(profile, n));

  const watchBtn = viewInCs2Button('Watch in CS2', 'btn nc-btn',
    'Opens this demo in CS2 (through HLAE) in the thrower\'s eyes, 5 s before the throw, and pauses at the moment the grenade leaves the hand',
    () => ({ tick: th.tick, name, lead: 5, pause: true }),
    'CS2 plays the throw and pauses when the grenade leaves the hand (type demo_resume in the console to continue).');
  watchBtn.disabled = !th;

  return h('div', { class: 'nade-card', style: { '--c': NADE_COLOR[n.type] } },
    h('div', { class: 'nc-head' },
      h('span', { class: 'nc-dot' }),
      h('div', { class: 'nc-title' },
        h('div', { class: 'nc-type' }, label),
        h('div', { class: 'nc-who' }, h('span', { class: `side-${side}` }, name), h('span', { class: 'muted' }, ` · ${clockLabel(data, rd, th?.tick ?? n.t0)}`))),
      h('button', { class: 'nc-close', title: 'Close (Esc)', onclick: () => selectNade(null) }, icon(ICONS.x))),
    th ? h('div', { class: 'nc-tech' },
      h('div', { class: 'nc-move' }, tech.move),
      h('div', { class: 'nc-click' }, tech.click),
      tech.keys ? h('div', { class: 'nc-keys' }, 'Holding ', ...tech.keys.split(' + ').map(k => h('kbd', {}, k)), th.speed ? ` · ${th.speed} u/s` : '') : null)
      : h('div', { class: 'nc-tech muted' }, 'The throw itself is not in the demo.'),
    h('div', { class: 'nc-facts' },
      th ? fact('Aim', `${Math.abs(th.pitch).toFixed(1)}° ${th.pitch <= 0 ? 'up' : 'down'}`, `Pitch ${th.pitch}°, yaw ${th.yaw}°`) : null,
      fact('Flight', `${flight.toFixed(1)} s`, n.type === 'smoke' || n.type === 'decoy' ? 'From the throw until it stopped rolling' : 'From the throw until it went off'),
      fact('Distance', `${fmtNum(dist)} u`),
      fact('Bounces', n.bounces.length)),
    profile,
    h('div', { class: 'nc-actions' },
      h('button', { class: 'btn primary nc-btn', onclick: () => replayThrow(n) }, icon(ICONS.play), 'Replay throw'),
      watchBtn),
    th ? h('button', { class: 'nc-setpos', title: 'Copy. In a private server with sv_cheats 1, paste it in the console to stand where they threw from, aiming the same way.',
      onclick: async () => { await copyText(setposCmd(th)); toast('Copied. Paste it in the console of a private server with sv_cheats 1.', 'ok'); } },
    h('span', { class: 'mono' }, setposCmd(th)), h('span', { class: 'nc-copy' }, 'Copy')) : null,
  );
}

// Side view of a grenade's flight: height over the distance travelled, with the bounces.
function drawProfile(canvas, n) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = 18;
  const d = [0];
  for (let k = 1; k < n.pts.length; k++) d.push(d[k - 1] + Math.hypot(n.pts[k][1] - n.pts[k - 1][1], n.pts[k][2] - n.pts[k - 1][2]));
  const zs = n.pts.map(p => p[3]);
  const zMin = Math.min(...zs), zMax = Math.max(...zs), total = Math.max(1, d.at(-1));
  const sx = (W - 2 * pad) / total, sz = (H - 2 * pad - 14) / Math.max(1, zMax - zMin);
  const s = Math.min(sx, sz * 3); // keep the arc's shape roughly true to scale
  const X = i => pad + d[i] * sx, Y = z => H - pad - (z - zMin) * Math.min(sz, s);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#ffffff14'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pad, Y(zMin)); ctx.lineTo(W - pad, Y(zMin)); ctx.stroke();
  const c = NADE_COLOR[n.type];
  ctx.strokeStyle = c; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  n.pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p[3])) : ctx.moveTo(X(i), Y(p[3]))));
  ctx.stroke();
  ctx.fillStyle = c;
  for (const b of n.bounces) { const i = n.pts.indexOf(b); ctx.beginPath(); ctx.arc(X(i), Y(b[3]), 6, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(X(0), Y(zs[0]), 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(X(n.pts.length - 1), Y(zs.at(-1)), 7, 0, Math.PI * 2); ctx.fill();
  const top = zs.indexOf(zMax);
  ctx.font = '600 22px "Segoe UI", sans-serif'; ctx.fillStyle = '#8d9ab2'; ctx.textAlign = 'center';
  if (zMax - zs[0] > 20) ctx.fillText(`+${Math.round(zMax - zs[0])} u`, clamp(X(top), 40, W - 40), Math.max(20, Y(zMax) - 10));
}

document.addEventListener('keydown', e => {
  if (state.tab !== 'radar' || !state.radar.data?.rounds || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range') return;
  const R = state.radar, tr = R.data.tickrate;
  const step = e.shiftKey ? 8 : 5 * tr;
  if (e.key === ' ') { R.playing = !R.playing; e.preventDefault(); }
  else if (e.key === 'ArrowRight') { R.tick += step; e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { R.tick -= step; e.preventDefault(); }
  else if (e.key === 'ArrowDown' && R.round < R.data.rounds.length) { setRadarRound(R.round + 1); renderDetail(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && R.round > 1) { setRadarRound(R.round - 1); renderDetail(); e.preventDefault(); }
  else if (e.key === 'Escape' && R.nade != null) selectNade(null);
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
  const t = R.tick, tr = data.tickrate, rd = radarRound(), rr = data.per.get(rd.num);
  const lowerView = R.floor === 'lower';
  const fade = z => info.lowerBelow !== undefined && onLower(info, z) !== lowerView;
  // Markers are drawn in units of u canvas pixels, so their sizes below stay readable at any zoom:
  // they grow a little when zoomed in, while smokes and fires keep their real size.
  const canvas = els.canvas, v = R.view;
  const u = canvas.width / RADAR_SIZE * Math.min(1.8, 0.8 + 0.2 * v.k);
  const px = (x, y) => { const [cx, cy] = viewPt(canvas, v, ...toPx(info, x, y)); return [cx / u, cy / u]; };
  const units = w => w / info.scale * viewScale(canvas, v) / u;
  const circle = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); };
  const bs = bombState(data, rd, t);
  const sel = R.nade != null ? data.nades[R.nade] : null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (R.image) { applyView(ctx, canvas, v); ctx.drawImage(R.image, 0, 0, RADAR_SIZE, RADAR_SIZE); }
  ctx.setTransform(u, 0, 0, u, 0, 0);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // Grenade effects: smokes and fires last until their expire event, flashes and HEs are short bursts.
  const gr = rr.grenades;
  for (const g of gr) {
    if (g.expire || g.tick > t) continue;
    const end = g.type === 'smoke' || g.type === 'molotov'
      ? (gr.find(x => x.expire && x.type === g.type && x.entity === g.entity && x.tick >= g.tick)?.tick ?? g.tick + (g.type === 'smoke' ? SMOKE_TICKS : MOLOTOV_TICKS))
      : g.tick + BURST_TICKS;
    if (t > end) continue;
    const [x, y] = px(g.pos[0], g.pos[1]);
    const life = Math.min(1, (t - g.tick) / 12, (end - t) / 24); // grow in, fade out
    ctx.globalAlpha = (fade(g.pos[2]) ? 0.3 : 1) * Math.max(0, life);
    if (g.type === 'smoke') {
      ctx.fillStyle = 'rgba(200,206,216,0.75)'; ctx.strokeStyle = g.team === 'CT' ? '#6ea8ff' : '#e9b949'; ctx.lineWidth = 3;
      circle(x, y, units(SMOKE_RADIUS)); ctx.fill(); ctx.stroke();
    } else if (g.type === 'molotov') {
      ctx.fillStyle = 'rgba(255,110,30,0.45)'; ctx.strokeStyle = 'rgba(255,150,60,0.8)'; ctx.lineWidth = 2;
      circle(x, y, units(MOLOTOV_RADIUS)); ctx.fill(); ctx.stroke();
    } else if (g.type === 'flash' || g.type === 'he') {
      const k = (t - g.tick) / BURST_TICKS;
      ctx.globalAlpha = fade(g.pos[2]) ? 0.3 : 1;
      if (g.type === 'flash') { ctx.fillStyle = `rgba(255,255,230,${0.8 * (1 - k)})`; circle(x, y, 10 + 26 * k); ctx.fill(); }
      ctx.strokeStyle = g.type === 'flash' ? `rgba(255,255,255,${1 - k})` : `rgba(255,80,60,${1 - k})`;
      ctx.lineWidth = 6; circle(x, y, 8 + k * (g.type === 'he' ? units(350) : 34)); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Grenade paths: each flight while in the air and shortly after, every flight this round with
  // "Grenade paths" on, and the selected one in full (dashed where it hasn't flown yet).
  const pathTo = (n, upto) => {
    ctx.beginPath();
    let i = 0;
    for (const p of n.pts) {
      if (p[0] > upto) break;
      const [x, y] = px(p[1], p[2]);
      i++ ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    if (upto > n.t0 && upto < n.t1) { const q = nadePos(n, upto); ctx.lineTo(...px(q[1], q[2])); }
  };
  for (const n of rr.nades) {
    if (n.t0 > t || n === sel) continue;
    const after = t - n.t1;
    if (!R.paths && after > TRAIL_TICKS) continue;
    const hover = R.hover === n.i;
    ctx.globalAlpha = (fade(n.land[3]) ? 0.3 : 1) * (hover ? 1 : after <= 0 ? 0.85 : R.paths ? 0.5 : 0.85 * (1 - after / TRAIL_TICKS));
    ctx.strokeStyle = NADE_COLOR[n.type]; ctx.lineWidth = hover ? 4 : 2.5;
    pathTo(n, Math.min(t, n.t1)); ctx.stroke();
    if (R.paths && n.throw && after > 0) {
      const [x, y] = px(n.throw.pos[0], n.throw.pos[1]);
      ctx.lineWidth = 2; circle(x, y, 5); ctx.stroke();
    }
  }
  if (sel) {
    const c = NADE_COLOR[sel.type];
    ctx.globalAlpha = 1; ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 12;
    ctx.lineWidth = 4; ctx.setLineDash([2, 9]);
    pathTo(sel, sel.t1); ctx.stroke();
    ctx.setLineDash([]);
    if (t > sel.t0) { ctx.lineWidth = 5; pathTo(sel, Math.min(t, sel.t1)); ctx.stroke(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = c;
    for (const b of sel.bounces) { const [x, y] = px(b[1], b[2]); circle(x, y, 5); ctx.fill(); }
    // Landing spot
    const [lx, ly] = px(sel.land[1], sel.land[2]);
    ctx.strokeStyle = '#0a0e16'; ctx.lineWidth = 3; circle(lx, ly, 9); ctx.fill(); ctx.stroke();
    // Throw spot with the direction they aimed
    if (sel.throw) {
      const th = sel.throw, [x, y] = px(th.pos[0], th.pos[1]), a = -th.yaw * Math.PI / 180;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      circle(x, y, 16); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 16, y + Math.sin(a) * 16); ctx.lineTo(x + Math.cos(a) * 46, y + Math.sin(a) * 46); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 54, y + Math.sin(a) * 54);
      ctx.lineTo(x + Math.cos(a + 0.35) * 40, y + Math.sin(a + 0.35) * 40);
      ctx.lineTo(x + Math.cos(a - 0.35) * 40, y + Math.sin(a - 0.35) * 40);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Bomb: dropped, planted with its countdown ring, explosion
  if (bs.dropped && !bs.planted) {
    const [x, y] = px(bs.dropped[0], bs.dropped[1]);
    const pulse = (Math.sin(t / 10) + 1) / 2;
    ctx.globalAlpha = fade(bs.dropped[2]) ? 0.3 : 1;
    ctx.strokeStyle = `rgba(255,77,77,${0.3 + 0.5 * pulse})`; ctx.lineWidth = 3; circle(x, y, 13 + 4 * pulse); ctx.stroke();
    bombIcon(ctx, x, y, 1);
  }
  const planted = bs.planted;
  if (planted?.pos) {
    const [x, y] = px(planted.pos[0], planted.pos[1]);
    const ended = bs.ended;
    ctx.globalAlpha = fade(planted.pos[2]) ? 0.4 : 1;
    if (!ended) {
      const left = clamp((bs.explodeAt - t) / bs.c4, 0, 1);
      const pulse = (Math.sin(t / (3 + 9 * left)) + 1) / 2; // beeps faster near the end
      ctx.fillStyle = `rgba(255,77,77,${0.15 + 0.3 * pulse})`; circle(x, y, 30); ctx.fill();
      ctx.strokeStyle = '#ffffff22'; ctx.lineWidth = 5; circle(x, y, 26); ctx.stroke();
      ctx.strokeStyle = left < 0.25 ? '#ff4d4d' : '#ff8a5c'; ctx.beginPath(); ctx.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); ctx.stroke();
    }
    if (ended?.type === 'exploded' && t - ended.tick < EXPLOSION_TICKS) {
      const k = (t - ended.tick) / EXPLOSION_TICKS;
      const g = ctx.createRadialGradient(x, y, 0, x, y, units(300 + 900 * k));
      g.addColorStop(0, `rgba(255,220,120,${0.9 * (1 - k)})`); g.addColorStop(0.5, `rgba(255,90,40,${0.6 * (1 - k)})`); g.addColorStop(1, 'rgba(255,60,30,0)');
      ctx.fillStyle = g; circle(x, y, units(300 + 900 * k)); ctx.fill();
    }
    if (ended?.type !== 'exploded' || t - ended.tick < 8) bombIcon(ctx, x, y, 1.2, ended?.type === 'defused' ? '#6ea8ff' : '#ff4d4d');
  }
  ctx.globalAlpha = 1;

  // Deaths so far this round
  ctx.lineWidth = 4;
  for (const k of rr.kills) {
    if (k.tick > t || !k.victimPos) continue;
    const [x, y] = px(k.victimPos[0], k.victimPos[1]);
    ctx.globalAlpha = fade(k.victimPos[2]) ? 0.25 : 0.8;
    ctx.strokeStyle = k.victimTeam === 'CT' ? '#6ea8ff' : '#e9b949';
    ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Shots: a tracer from the shooter in the direction they fired, ending on the player when it hit.
  // Tracers stay a little longer at high playback speeds, so they don't vanish between frames.
  if (R.shots) {
    const win = TRACER_TICKS * Math.max(1, R.playing ? R.speed / 2 : 1);
    for (const s of rr.shots) {
      if (s.tick > t) break;
      const age = t - s.tick;
      if (age > win) continue;
      const k = 1 - age / win;
      const [x0, y0] = px(s.x, s.y);
      ctx.globalAlpha = fade(s.z) ? 0.3 : 1;
      if (s.hit) {
        const [x1, y1] = px(s.hit.x, s.hit.y);
        ctx.strokeStyle = `rgba(255,96,80,${k})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      } else {
        const a = s.yaw * Math.PI / 180;
        const [x1, y1] = px(s.x + Math.cos(a) * TRACER_LEN, s.y + Math.sin(a) * TRACER_LEN);
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, `rgba(255,228,150,${0.95 * k})`); g.addColorStop(1, 'rgba(255,228,150,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      if (age < 4) { ctx.fillStyle = `rgba(255,214,110,${1 - age / 4})`; circle(x0, y0, 15); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }

  // Players
  const pov = state.analysis?.player?.steamid;
  const players = data.track.header.players.map((id, i) => ({ id, name: data.names[id] || id, s: playerAt(data, i, t) })).filter(p => p.s);
  const blind = new Map();
  for (const b of rr.blinds) if (b.tick <= t && t < b.end) blind.set(b.victim, Math.max(blind.get(b.victim) || 0, (b.end - t) / (b.end - b.tick)));
  ctx.textAlign = 'center';
  for (const p of players) {
    if (!p.s.alive) continue;
    const [x, y] = px(p.s.x, p.s.y);
    const color = p.s.ct ? '#6ea8ff' : '#e9b949';
    ctx.globalAlpha = fade(p.s.z) ? 0.3 : 1;
    const fl = blind.get(p.id);
    if (fl) {
      const g = ctx.createRadialGradient(x, y, 6, x, y, 30);
      g.addColorStop(0, `rgba(255,255,255,${0.95 * fl})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; circle(x, y, 30); ctx.fill();
    }
    const a = -p.s.yaw * Math.PI / 180;
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 30, y + Math.sin(a) * 30); ctx.stroke();
    ctx.fillStyle = color; circle(x, y, 11); ctx.fill();
    if (fl) { ctx.fillStyle = `rgba(255,255,255,${0.8 * fl})`; ctx.fill(); }
    ctx.lineWidth = p.id === pov ? 4 : 2; ctx.strokeStyle = p.id === pov ? '#fff' : '#0a0e16';
    ctx.stroke();
    // Plant / defuse progress around the player
    const act = bs.planting?.player === p.id ? [bs.planting.frac, '#ff4d4d'] : bs.defusing?.player === p.id ? [bs.defusing.frac, '#6ea8ff'] : null;
    if (act) {
      ctx.strokeStyle = '#0a0e16aa'; ctx.lineWidth = 6; circle(x, y, 19); ctx.stroke();
      ctx.strokeStyle = act[1]; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, 19, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(act[0], 0, 1)); ctx.stroke();
    }
    if (bs.carrier === p.id) bombIcon(ctx, x + 13, y + 11, 0.75);
    ctx.font = '600 20px "Segoe UI", sans-serif';
    ctx.fillStyle = '#0a0e16cc'; const label = p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name;
    const wdt = ctx.measureText(label).width + 10;
    ctx.fillRect(x - wdt / 2, y - 42, wdt, 24);
    ctx.fillStyle = p.id === pov ? '#fff' : color; ctx.fillText(label, x, y - 23);
  }
  ctx.globalAlpha = 1;

  // Grenades in the air, on top of everything
  for (const n of rr.nades) {
    if (n.t0 > t || t > n.t1) continue;
    const [, wx, wy, wz] = nadePos(n, t);
    const [x, y] = px(wx, wy);
    ctx.globalAlpha = fade(wz) ? 0.35 : 1;
    // A little bigger the higher it flies above where it was thrown from
    const r = 6 + clamp((wz - n.pts[0][3]) / 120, 0, 4);
    ctx.fillStyle = NADE_COLOR[n.type]; ctx.strokeStyle = '#0a0e16'; ctx.lineWidth = 2.5;
    circle(x, y, r); ctx.fill(); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Damage numbers floating up from whoever got hit
  if (R.shots) {
    ctx.font = '800 19px "Segoe UI", sans-serif';
    ctx.lineWidth = 4; ctx.strokeStyle = '#0a0e16';
    for (const d of rr.damage) {
      if (d.tick > t) break;
      const age = t - d.tick;
      if (age > DMG_TICKS || /inferno/.test(d.weapon) || !d.dmg) continue;
      const [x, y] = px(d.x, d.y);
      ctx.globalAlpha = 1 - age / DMG_TICKS;
      const yy = y - 54 - age * 0.35;
      const txt = `-${d.dmg}${d.head ? ' HS' : ''}`;
      ctx.strokeText(txt, x + 18, yy);
      ctx.fillStyle = d.head ? '#ff5d5d' : '#ffd0c4'; ctx.fillText(txt, x + 18, yy);
    }
    ctx.globalAlpha = 1;
  }

  // Hover label
  const hv = R.hover != null && R.hover !== R.nade ? data.nades[R.hover] : null;
  if (hv) {
    const at = t >= hv.t0 && t <= hv.t1 ? nadePos(hv, t) : t > hv.t1 ? hv.land : hv.pts[0];
    const [x, y] = px(at[1], at[2]);
    const txt = `${NADE_LABEL[hv.type]} · ${data.names[hv.thrower] || '?'} — click for the throw`;
    ctx.font = '600 18px "Segoe UI", sans-serif'; ctx.textAlign = 'left';
    const w = ctx.measureText(txt).width + 16;
    ctx.fillStyle = '#0a0e16e6'; ctx.fillRect(x + 14, y + 10, w, 28);
    ctx.fillStyle = NADE_COLOR[hv.type]; ctx.fillRect(x + 14, y + 10, 4, 28);
    ctx.fillStyle = '#e8edf6'; ctx.fillText(txt, x + 24, y + 30);
    ctx.textAlign = 'center';
  }

  // Controls, HUD, team lists and side lists (DOM; only touched when something visible changed)
  if (document.activeElement !== els.slider) els.slider.value = t;
  if (els.playing !== R.playing) {
    els.playing = R.playing;
    els.playBtn.replaceChildren(icon(R.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>' : ICONS.play));
  }
  drawHud(data, rd, t, bs);
  const sig = players.map(p => `${p.s.alive ? p.s.hp : 0}${p.s.weapon}${blind.has(p.id) ? 'f' : ''}`).join() + bs.carrier + !!bs.planting + !!bs.defusing
    + rr.kills.filter(k => k.tick <= t).length + '|' + rr.nades.filter(n => (n.throw?.tick ?? n.t0) <= t).length + R.list + R.nade;
  if (els.built !== sig) {
    els.built = sig;
    const side = ct => players.filter(p => p.s.ct === ct).sort((x, y) => x.name.localeCompare(y.name)).map(p =>
      h('div', { class: `rp ${p.s.alive ? '' : 'dead'} ${p.id === pov ? 'me' : ''}` },
        h('div', { class: 'rp-top' },
          h('span', { class: 'rp-name' }, p.name),
          bs.carrier === p.id ? h('span', { class: 'rp-c4', title: 'Carries the bomb' }, 'C4') : null,
          blind.has(p.id) ? h('span', { class: 'rp-flash', title: 'Flashed' }, 'flashed') : null,
          h('span', { class: 'rp-hp' }, p.s.alive ? p.s.hp : '✕')),
        h('div', { class: 'rp-bar' }, h('div', { style: { width: `${p.s.alive ? p.s.hp : 0}%`, background: ct ? 'var(--ct)' : 'var(--t)' } })),
        h('div', { class: 'rp-w' }, !p.s.alive ? '' : bs.planting?.player === p.id ? 'Planting…' : bs.defusing?.player === p.id ? 'Defusing…' : p.s.weapon)));
    els.teams.replaceChildren(h('div', { class: 'rt side-CT' }, 'CT'), ...side(true), h('div', { class: 'rt side-T' }, 'T'), ...side(false));
    if (R.list === 'utility') {
      els.feed.replaceChildren(...(rr.nades.length ? rr.nades.map(n => {
        const tick = n.throw?.tick ?? n.t0;
        const tech = n.throw && throwTechnique(n.throw);
        const team = n.thrower && data.pidx.has(n.thrower) ? (playerAt(data, data.pidx.get(n.thrower), tick)?.ct ? 'CT' : 'T') : '';
        return h('div', { class: `ru ${tick <= t ? '' : 'future'} ${n.i === R.nade ? 'on' : ''}`, style: { '--c': NADE_COLOR[n.type] }, title: 'Show how it was thrown', onclick: () => selectNade(n.i, true) },
          h('span', { class: 'rk-t' }, clockLabel(data, rd, tick)),
          h('span', { class: 'ru-type' }, h('span', { class: 'ru-dot' }), NADE_LABEL[n.type]),
          h('span', { class: `side-${team}` }, data.names[n.thrower] || '?'),
          tech ? h('span', { class: 'rk-w' }, tech.move.toLowerCase().replace(/,.*$/, '')) : null);
      }) : [h('div', { class: 'muted ru-empty' }, 'No grenades this round.')]));
    } else {
      els.feed.replaceChildren(...(rr.kills.length ? rr.kills.map(k => h('div', {
        class: `rk ${k.tick <= t ? '' : 'future'}`, title: 'Jump to this kill', onclick: () => { R.tick = k.tick - 2 * tr; },
      },
      h('span', { class: 'rk-t' }, clockLabel(data, rd, k.tick)),
      h('span', { class: `side-${k.attackerTeam}` }, data.names[k.attacker] || 'World'),
      h('span', { class: 'rk-w' }, k.weapon, k.headshot ? ' · HS' : '', k.wallbang ? ' · wallbang' : '', k.smoke ? ' · through smoke' : ''),
      h('span', { class: `side-${k.victimTeam}` }, data.names[k.victim] || '?'))) : [h('div', { class: 'muted ru-empty' }, 'No kills this round.')]));
    }
  }
}

// Small bomb marker: a red rounded square with "C4" written on it.
function bombIcon(ctx, x, y, s = 1, color = '#ff4d4d') {
  const w = 22 * s, hh = 15 * s;
  ctx.fillStyle = color; ctx.strokeStyle = '#0a0e16'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - hh / 2, w, hh, 3 * s); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#0a0e16'; ctx.font = `800 ${Math.round(11 * s)}px "Segoe UI", sans-serif`; ctx.textAlign = 'center';
  ctx.fillText('C4', x, y + 4 * s);
}

// Round clock over the map, and once the bomb is down: its timer, and any plant or defuse in progress.
function drawHud(data, rd, t, bs) {
  const els = state.radar.els, tr = data.tickrate;
  const c = roundClock(data, rd, t, bs);
  const deadline = bs.defusing ? bs.defusing.tick + bs.defusing.len : 0;
  const key = [c.kind, c.time == null ? '' : fmtClock(c.time, true), bs.planting?.player, Math.round((bs.planting?.frac || 0) * 50), bs.defusing?.player, Math.round((bs.defusing?.frac || 0) * 50), bs.ended?.type].join('|');
  if (els.hudKey === key) return;
  els.hudKey = key;
  const name = id => state.radar.data.names[id] || '?';
  const bar = (frac, cls) => h('div', { class: `hud-bar ${cls}` }, h('div', { style: { width: `${clamp(frac, 0, 1) * 100}%` } }));
  const parts = [];
  if (c.kind === 'bomb') {
    parts.push(h('div', { class: `hud-bomb ${c.time < 10 ? 'late' : ''}` },
      h('span', { class: 'hud-c4' }, 'C4'), h('span', { class: 'hud-time' }, fmtClock(c.time, true)),
      bar(c.time / (bs.c4 / tr), 'red')));
    if (bs.defusing) {
      const inTime = deadline <= bs.explodeAt;
      parts.push(h('div', { class: 'hud-sub' },
        h('span', {}, h('b', { class: 'side-CT' }, name(bs.defusing.player)), ` defusing${bs.defusing.kit ? ' with a kit' : ', no kit'} · ${Math.max(0, (deadline - t) / tr).toFixed(1)} s`),
        h('span', { class: inTime ? 'good' : 'bad' }, inTime ? 'in time' : 'too late'),
        bar(bs.defusing.frac, 'blue')));
    }
  } else {
    const label = c.kind === 'freeze' ? 'Freeze time' : c.kind === 'end' ? `${rd.winner} win · ${(rd.reason || '').replace(/_/g, ' ')}` : null;
    parts.push(h('div', { class: `hud-clock ${c.kind}` }, label ? h('span', { class: 'hud-label' }, label) : null, c.time == null ? null : h('span', { class: 'hud-time' }, fmtClock(c.time))));
    if (bs.ended) parts.push(h('div', { class: 'hud-sub' }, bs.ended.type === 'defused' ? h('span', { class: 'side-CT' }, `Bomb defused by ${name(bs.ended.player)}`) : h('span', { class: 'bad' }, 'Bomb exploded')));
    if (bs.planting) parts.push(h('div', { class: 'hud-sub' }, h('span', {}, h('b', { class: 'side-T' }, name(bs.planting.player)), ' planting the bomb'), bar(bs.planting.frac, 'red')));
  }
  els.hud.replaceChildren(...parts);
}

// ---------- Overview (dashboard) ----------
// Everything is added up here from the per-match summaries (api.profile), so filters are instant.
state.ov = { mode: 'all', map: 'all', period: 'all' };
const PERIODS = [['all', 'All time'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['20', 'Last 20 matches'], ['10', 'Last 10 matches']];

function filteredMatches(f = state.ov) {
  let list = (state.profile?.matches || []).filter(m => (f.mode === 'all' || m.mode === f.mode) && (f.map === 'all' || m.map === f.map));
  list.sort((a, b) => b.date - a.date);
  if (/d$/.test(f.period)) { const since = Date.now() - parseInt(f.period, 10) * 86400000; list = list.filter(m => m.date >= since); }
  else if (f.period !== 'all') list = list.slice(0, +f.period);
  return list;
}

function aggregate(list) {
  const side = () => ({ rounds: 0, won: 0, fk: 0, fd: 0 });
  const t = {
    played: list.length, won: 0, lost: 0, tied: 0, rounds: 0, kills: 0, deaths: 0, assists: 0, hs: 0, damage: 0, kastRounds: 0,
    ratingSum: 0, ratingRounds: 0, fk: 0, fd: 0, side: { T: side(), CT: side() },
    clutch: { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0], 5: [0, 0] }, multi: { 2: 0, 3: 0, 4: 0, 5: 0 },
    trades: 0, utility: 0, flashed: 0, flashAssists: 0, weapons: {}, maps: {}, mates: {},
  };
  for (const m of list) {
    t[m.result === 'W' ? 'won' : m.result === 'L' ? 'lost' : 'tied']++;
    t.rounds += m.rounds; t.kills += m.kills; t.deaths += m.deaths; t.assists += m.assists; t.hs += m.hsKills;
    t.damage += m.damage; t.kastRounds += m.kastRounds; t.fk += m.firstKills; t.fd += m.firstDeaths;
    t.trades += m.tradeKills; t.utility += m.utilityDamage; t.flashed += m.enemiesFlashed; t.flashAssists += m.flashAssists;
    if (m.rating != null) { t.ratingSum += m.rating * m.rounds; t.ratingRounds += m.rounds; }
    for (const s of ['T', 'CT']) for (const k of ['rounds', 'won', 'fk', 'fd']) t.side[s][k] += m.side?.[s]?.[k] || 0;
    for (const n of [1, 2, 3, 4, 5]) { t.clutch[n][0] += m.clutches.vs?.[n]?.[0] || 0; t.clutch[n][1] += m.clutches.vs?.[n]?.[1] || 0; }
    for (const n of [2, 3, 4, 5]) t.multi[n] += m.multi[n] || 0;
    for (const [w, [k, hs]] of Object.entries(m.weapons)) { const r = t.weapons[w] ||= [0, 0]; r[0] += k; r[1] += hs; }
    const mp = t.maps[m.map] ||= { map: m.map, played: 0, won: 0, lost: 0, rounds: 0, kills: 0, deaths: 0, damage: 0, ratingSum: 0, ratingRounds: 0, side: { T: side(), CT: side() } };
    mp.played++; if (m.result === 'W') mp.won++; if (m.result === 'L') mp.lost++;
    mp.rounds += m.rounds; mp.kills += m.kills; mp.deaths += m.deaths; mp.damage += m.damage;
    if (m.rating != null) { mp.ratingSum += m.rating * m.rounds; mp.ratingRounds += m.rounds; }
    for (const s of ['T', 'CT']) for (const k of ['rounds', 'won']) mp.side[s][k] += m.side?.[s]?.[k] || 0;
    for (const [id, name] of m.mates || []) {
      const x = t.mates[id] ||= { id, name, played: 0, won: 0, lost: 0 };
      x.name = name; x.played++; if (m.result === 'W') x.won++; if (m.result === 'L') x.lost++;
    }
  }
  t.kd = t.deaths ? t.kills / t.deaths : t.kills;
  t.adr = t.rounds ? t.damage / t.rounds : 0;
  t.rating = t.ratingRounds ? t.ratingSum / t.ratingRounds : null;
  t.clutchWon = Object.values(t.clutch).reduce((s, c) => s + c[0], 0);
  t.clutchPlayed = Object.values(t.clutch).reduce((s, c) => s + c[1], 0);
  return t;
}

// Small building blocks
function card(title, body, { span = 1, extra = null, cls = '' } = {}) {
  return h('section', { class: `dcard span-${span} ${cls}` },
    title ? h('div', { class: 'dcard-head' }, h('h4', {}, title), h('span', { class: 'spacer' }), extra) : null,
    ...[body].flat());
}
// Circular gauge: frac of the circle filled, the value in the middle.
function ring(frac, value, cls, sub) {
  const r = 54, c = 2 * Math.PI * r;
  return h('div', { class: `ring ${cls}` },
    h('div', { class: 'ring-svg', html: `<svg viewBox="0 0 128 128"><circle cx="64" cy="64" r="${r}" class="ring-bg"/><circle cx="64" cy="64" r="${r}" class="ring-fg" stroke-dasharray="${(c * clamp(frac, 0, 1)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 64 64)"/></svg>` }),
    h('div', { class: 'ring-v' }, value, sub ? h('div', { class: 'ring-sub' }, sub) : null));
}
const pie = (frac, cls = '') => h('div', { class: `pie ${cls}`, style: { '--p': `${(clamp(frac || 0, 0, 1) * 100).toFixed(1)}%` } });
const qualityClass = (v, good, bad) => (v >= good ? 'good' : v < bad ? 'bad' : 'mid');
function trend(now, before, digits = 2, suffix = '') {
  if (before == null || now == null || !Number.isFinite(before)) return null;
  const d = now - before;
  const cls = Math.abs(d) < 10 ** -digits ? 'flat' : d > 0 ? 'up' : 'down';
  return h('span', { class: `trend ${cls}`, title: 'Last 10 matches compared to the whole selection' }, cls === 'up' ? '▲ ' : cls === 'down' ? '▼ ' : '', `last 10: ${now.toFixed(digits)}${suffix}`);
}
function kv(rows) {
  return h('div', { class: 'kv' }, ...rows.map(([k, v, cls]) => h('div', { class: 'kv-row' }, h('span', {}, k), h('b', { class: cls || '' }, v))));
}
function barList(rows, { empty = 'Nothing yet' } = {}) {
  if (!rows.length) return h('div', { class: 'muted-note' }, empty);
  return h('div', { class: 'bars' }, ...rows.map(r => h('div', { class: `bar-row ${r.onclick ? 'clickable' : ''}`, onclick: r.onclick, title: r.title },
    h('div', { class: 'bar-top' }, r.lead || null, h('span', { class: 'bar-label' }, r.label), h('span', { class: 'spacer' }), h('b', { class: r.cls || '' }, r.value)),
    h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${r.fillCls || ''}`, style: { width: `${clamp(r.frac, 0, 1) * 100}%` } })))));
}
const ICON = {
  trophy: '<path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 13v4M8 20h8M9.5 17h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  head: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="1.7"/>',
  burst: '<path d="M12 3l2 5 5-2-2 5 4 3-5 1 1 5-5-3-4 4v-5l-5-1 4-3-2-5 5 2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};

function renderOverview() {
  const view = $('#view-overview');
  const p = state.profile;
  const page = (...body) => view.replaceChildren(h('div', { class: 'page dash-page' }, ...body));
  if (!p) return page(h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Loading your stats…')));
  if (!p.steamid) return page(h('div', { class: 'empty' }, h('h2', {}, 'Which player are you?'), h('div', {}, 'No Steam account was found on this PC. Enter your SteamID64 in Settings → Counter-Strike 2.'),
    h('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: () => showView('settings') }, 'Open Settings')));
  const pending = state.demos.filter(d => !d.summary && !d.failed).length;
  if (!p.matches.length) {
    return page(h('div', { class: 'empty' }, pending ? spinner(28) : icon(ICONS.demo, 'class="big"'),
      h('h2', {}, pending ? `Reading your demos… ${pending} left` : 'No matches with you yet'),
      h('div', {}, pending ? 'Your stats appear here as soon as the first demos are read. Each demo is only read once.' : 'Download your matches in CS2 (Watch → Your Matches) or in the Downloads tab, and they show up here.')));
  }

  const f = state.ov;
  const all = p.matches;
  const modes = [...new Set(all.map(m => m.mode))];
  const maps = [...new Set(all.map(m => m.map))].sort((a, b) => mapName(a).localeCompare(mapName(b)));
  if (f.map !== 'all' && !maps.includes(f.map)) f.map = 'all';
  const list = filteredMatches();
  const t = aggregate(list);
  const last10 = aggregate(list.slice(0, 10));
  const rerender = () => renderOverview();

  const head = h('div', { class: 'dash-head' },
    h('div', { class: 'dash-title' },
      h('h2', {}, p.name || 'Your stats'),
      h('div', { class: 'sub' }, `${t.played} match${t.played === 1 ? '' : 'es'} · ${fmtNum(t.rounds)} rounds`,
        pending ? h('span', {}, ' · ', spinner(11), ` reading ${pending} more`) : null)),
    h('span', { class: 'spacer' }),
    h('div', { class: 'filters' },
      modes.length > 1 ? select(f.mode, [['all', 'All modes'], ...modes.map(m => [m, m])], v => { f.mode = v; rerender(); }) : null,
      select(f.map, [['all', 'All maps'], ...maps.map(m => [m, mapName(m)])], v => { f.map = v; rerender(); }),
      select(f.period, PERIODS, v => { f.period = v; rerender(); })),
  );
  if (!list.length) return page(head, h('div', { class: 'empty' }, h('h2', {}, 'No matches for these filters'), h('div', {}, 'Pick another period, map or mode.')));

  const kdCls = qualityClass(t.kd, 1.05, 0.95);
  const rtCls = t.rating == null ? '' : qualityClass(t.rating, 1.05, 0.95);
  const cards = [
    card('K/D', ring(t.kd / 2, t.kd.toFixed(2), kdCls, list.length > 10 ? trend(last10.kd, t.kd) : null), { cls: 'center' }),
    card('Rating', ring((t.rating ?? 0) / 2, t.rating == null ? '—' : t.rating.toFixed(2), rtCls, list.length > 10 ? trend(last10.rating, t.rating) : null),
      { cls: 'center', extra: h('span', { class: 'hint', title: 'Approximation of HLTV Rating 2.0 (HLTV does not publish its formula; usually within ±0.02)' }, '≈ HLTV 2.0') }),
    clutchCard(t),
    recentCard(list),
    overallCard(t),
    entryCard(t),
    mapsCard(t),
    trendCard(list),
    weaponCard('Most kills', Object.entries(t.weapons).sort((a, b) => b[1][0] - a[1][0]).slice(0, 6), ([, [k]], max) => [fmtNum(k), k / max]),
    weaponCard('Headshot %', Object.entries(t.weapons).filter(([, [k]]) => k >= Math.max(10, t.kills * 0.02)).sort((a, b) => b[1][1] / b[1][0] - a[1][1] / a[1][0]).slice(0, 6),
      ([, [k, hs]]) => [`${pct(hs, k)}%`, hs / k], 'Weapons with at least 10 kills'),
    multiCard(t),
    sidesCard(t),
    matesCard(t),
  ];
  page(head, h('div', { class: 'dash' }, ...cards));
}

function clutchCard(t) {
  return card('Clutch success', [
    h('div', { class: 'big-line' }, h('span', { class: 'big-pre' }, '1vX'), h('span', { class: 'big' }, `${pct(t.clutchWon, t.clutchPlayed)}%`),
      h('span', { class: 'big-note' }, `${t.clutchWon} won of ${t.clutchPlayed}`)),
    h('div', { class: 'clutch-grid' }, ...[1, 2, 3, 4, 5].map(n => {
      const [w, p] = t.clutch[n];
      return h('div', { class: 'clutch-col', title: `1v${n}: won ${w} of ${p}` },
        h('div', { class: 'cl-k' }, `1v${n}`), pie(p ? w / p : 0), h('div', { class: 'cl-v' }, `${pct(w, p)}%`), h('div', { class: 'cl-n' }, `W ${w} · L ${p - w}`));
    })),
  ]);
}

function recentCard(list) {
  const last = list.slice(0, 10);
  const r = aggregate(last);
  return card('Recent matches', [
    h('div', { class: 'recent' }, ...last.map(m => h('button', { class: `recent-m r-${m.result}`, title: `${mapName(m.map)} · ${m.score[0]}:${m.score[1]} · ${fmtDate(m.date)}\nK/D ${m.kills}/${m.deaths}${m.rating != null ? ` · rating ${m.rating.toFixed(2)}` : ''}`, onclick: () => openMatch(m) },
      mapThumb(m.map), h('span', { class: 'rdot' }), h('span', { class: 'rscore' }, `${m.score[0]}:${m.score[1]}`)))),
    kv([
      ['Last ' + last.length, `${r.won}W · ${r.lost}L${r.tied ? ` · ${r.tied}T` : ''}`],
      ['Rating', r.rating == null ? '—' : r.rating.toFixed(2), r.rating == null ? '' : ratingClass(r.rating)],
      ['K/D · ADR', `${r.kd.toFixed(2)} · ${r.adr.toFixed(0)}`],
    ]),
  ], { extra: h('button', { class: 'link-btn', onclick: () => showView('matches') }, 'All matches →') });
}

function overallCard(t) {
  const big = (ic, k, v, cls = '') => h('div', { class: 'big-stat' }, h('span', { class: 'big-ic' }, icon(ic)), h('div', {}, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v)));
  return card(null, [
    h('div', { class: 'big-stats' },
      big(ICON.trophy, 'Win rate', `${pct(t.won, t.played)}%`, pct(t.won, t.played) >= 50 ? 'good' : 'bad'),
      big(ICON.head, 'Headshot %', `${pct(t.hs, t.kills)}%`),
      big(ICON.burst, 'ADR', t.adr.toFixed(0), qualityClass(t.adr, 80, 65))),
    h('div', { class: 'kv-cols' },
      kv([['Played', t.played], ['Won', t.won, 'good'], ['Lost', t.lost, 'bad'], ['Tied', t.tied]]),
      kv([['Kills', fmtNum(t.kills)], ['Deaths', fmtNum(t.deaths)], ['Assists', fmtNum(t.assists)], ['Headshots', fmtNum(t.hs)]]),
      kv([['KAST', `${pct(t.kastRounds, t.rounds)}%`], ['Damage', fmtNum(t.damage)], ['Rounds', fmtNum(t.rounds)], ['Kills / round', (t.rounds ? t.kills / t.rounds : 0).toFixed(2)]])),
  ], { span: 2 });
}

function entryCard(t) {
  const sides = [['Combined', t.fk, t.fd, t.rounds], ['T side', t.side.T.fk, t.side.T.fd, t.side.T.rounds], ['CT side', t.side.CT.fk, t.side.CT.fd, t.side.CT.rounds]];
  return card('Opening duels', [
    h('div', { class: 'big-line' }, h('span', { class: 'big' }, `${pct(t.fk, t.rounds)}%`), h('span', { class: 'big-note' }, 'of rounds you got the first kill')),
    h('table', { class: 'entry' },
      h('thead', {}, h('tr', {}, h('th', {}), ...sides.map(([l], i) => h('th', { class: i === 1 ? 'side-T' : i === 2 ? 'side-CT' : '' }, l)))),
      h('tbody', {},
        h('tr', { title: 'Opening duels won: first kills / (first kills + first deaths)' }, h('td', {}, 'Success'),
          ...sides.map(([, fk, fd], i) => h('td', {}, pie((fk + fd) ? fk / (fk + fd) : 0, ['', 't', 'ct'][i]), h('div', {}, `${pct(fk, fk + fd)}%`)))),
        h('tr', { title: 'Rounds where you were in the opening duel' }, h('td', {}, 'Attempts'),
          ...sides.map(([, fk, fd, r], i) => h('td', {}, pie(r ? (fk + fd) / r : 0, ['', 't', 'ct'][i]), h('div', {}, `${pct(fk + fd, r)}%`)))))),
  ]);
}

function mapsCard(t) {
  const most = Object.values(t.maps).sort((a, b) => b.played - a.played).slice(0, 5);
  const go = m => () => { state.mp.map = m.map; resetZoom(state.mp.view); showView('maps'); };
  // Most played maps; the bar is the win rate.
  return card('Maps', h('div', { class: 'map-rows' }, ...most.map(m => {
    const wr = pct(m.won, m.played);
    return h('div', { class: 'map-row', onclick: go(m), title: `${m.won} won, ${m.lost} lost · open this map` },
      mapThumb(m.map),
      h('div', { class: 'map-row-main' },
        h('div', { class: 'bar-top' }, h('span', { class: 'bar-label' }, mapName(m.map)), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${m.played} played`), h('b', { class: wr >= 50 ? 'good' : 'bad' }, `${wr}%`)),
        h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${wr >= 50 ? 'good' : 'bad'}`, style: { width: `${wr}%` } }))));
  })), { extra: h('button', { class: 'link-btn', onclick: () => showView('maps') }, 'Maps →') });
}

function weaponCard(title, rows, val, note) {
  const max = Math.max(1, ...rows.map(([, [k]]) => k));
  return card(title, barList(rows.map(r => { const [v, frac] = val(r, max); return { label: r[0], value: v, frac }; }), { empty: note || 'No kills yet' }),
    { extra: note ? h('span', { class: 'hint' }, note) : null });
}

// Rating per match, oldest to newest, with the 1.00 line and a 5-match average.
function trendCard(list) {
  const ms = list.filter(m => m.rating != null).slice(0, 40).reverse();
  if (ms.length < 2) return card('Rating per match', h('div', { class: 'muted-note' }, 'Needs at least two matches.'), { span: 2 });
  const W = 800, H = 210, padL = 34, padR = 12, padT = 12, padB = 22;
  const vals = ms.map(m => m.rating);
  const lo = Math.min(0.4, Math.floor(Math.min(...vals) * 5) / 5), hi = Math.max(1.6, Math.ceil(Math.max(...vals) * 5) / 5);
  const x = i => padL + (W - padL - padR) * (ms.length === 1 ? 0.5 : i / (ms.length - 1));
  const y = v => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const avg = vals.map((_, i) => { const s = vals.slice(Math.max(0, i - 4), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
  const grid = [];
  for (let v = Math.ceil(lo * 2) / 2; v <= hi + 1e-9; v += 0.5) grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="${Math.abs(v - 1) < 1e-9 ? 'g-one' : 'g'}"/><text x="${padL - 6}" y="${y(v) + 4}" class="g-t">${v.toFixed(1)}</text>`);
  const line = pts => pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line(vals)}L${x(vals.length - 1)},${H - padB}L${x(0)},${H - padB}Z`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg">${grid.join('')}
    <path d="${area}" class="t-area"/><path d="${line(vals)}" class="t-line"/><path d="${line(avg)}" class="t-avg"/>
    ${ms.map((m, i) => `<circle cx="${x(i)}" cy="${y(m.rating)}" r="4.5" class="t-pt r-${m.result}" data-i="${i}"><title>${mapName(m.map).replace(/[<&]/g, '')} ${m.score[0]}:${m.score[1]} · rating ${m.rating.toFixed(2)} · ${new Date(m.date).toLocaleDateString()}</title></circle>`).join('')}</svg>`;
  const el = h('div', { class: 'trend-wrap', html: svg });
  el.addEventListener('click', e => { const i = e.target.dataset?.i; if (i !== undefined) openMatch(ms[+i]); });
  return card('Rating per match', [el, h('div', { class: 'legend' }, h('span', { class: 'lg l-line' }, 'Rating'), h('span', { class: 'lg l-avg' }, '5-match average'), h('span', { class: 'lg l-w' }, 'Win'), h('span', { class: 'lg l-l' }, 'Loss'))],
    { span: 2, extra: h('span', { class: 'hint' }, `last ${ms.length} matches · click a point to open it`) });
}

function multiCard(t) {
  const per = v => (t.rounds ? (v / t.rounds).toFixed(2) : '0');
  return card('Multi-kills & utility', [
    h('div', { class: 'multi' }, ...[[2, '2K'], [3, '3K'], [4, '4K'], [5, 'ACE']].map(([n, l]) => h('div', { class: `multi-c m${n}` }, h('div', { class: 'v' }, t.multi[n]), h('div', { class: 'k' }, l)))),
    kv([['Trade kills', t.trades], ['Utility damage / round', per(t.utility)], ['Enemies flashed / round', per(t.flashed)], ['Flash assists', t.flashAssists]]),
  ]);
}

function sidesCard(t) {
  const row = (s, cls) => {
    const d = t.side[s];
    return { label: `${s} side`, value: `${pct(d.won, d.rounds)}%`, frac: d.rounds ? d.won / d.rounds : 0, fillCls: cls, title: `${d.won} of ${d.rounds} rounds won` };
  };
  return card('Rounds won per side', [
    barList([row('T', 't'), row('CT', 'ct')]),
    kv([['T rounds played', fmtNum(t.side.T.rounds)], ['CT rounds played', fmtNum(t.side.CT.rounds)]]),
  ]);
}

function matesCard(t) {
  const mates = Object.values(t.mates).filter(m => m.played >= 2).sort((a, b) => b.played - a.played || b.won - a.won).slice(0, 8);
  return card('Played with', mates.length
    ? h('table', { class: 'mates' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Teammate'), h('th', {}, 'Matches'), h('th', {}, 'W – L'), h('th', {}, 'Win rate'))),
      h('tbody', {}, ...mates.map(m => h('tr', {},
        h('td', { class: 'name' }, h('span', { class: 'avatar sm' }, (m.name.replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase()), m.name),
        h('td', {}, m.played), h('td', {}, `${m.won} – ${m.lost}`),
        h('td', {}, h('div', { class: 'wr' }, h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${m.won / m.played >= 0.5 ? 'good' : 'bad'}`, style: { width: `${pct(m.won, m.played)}%` } })), `${pct(m.won, m.played)}%`))))))
    : h('div', { class: 'muted-note' }, 'Teammates you played at least two matches with show up here.'), { span: 2 });
}

// Opens a match from the dashboard or the Maps page (on its scoreboard).
function openMatch(m) {
  const d = state.demos.find(x => x.id === m.id) || state.demos.find(x => x.path === m.path);
  if (!d) return toast('This demo is no longer in your demo folders.', 'error');
  showView('matches');
  openDemo(d, undefined, 'scoreboard');
}

// ---------- Maps ----------
// Every map with parsed demos; per map one big zoomable radar with kills, deaths, damage and grenades
// from all its matches, for you or for everyone.
state.mp = { map: null, who: 'me', side: 'both', layers: new Set(['kill', 'death']), display: 'heat', lines: true, weapon: 'all', floor: 'upper', room: 'auto', data: null, loading: null, view: newView() };

function mapsIndex() {
  const by = new Map();
  const seen = new Set();
  for (const d of state.demos) {
    const m = d.summary?.map;
    if (!m || seen.has(d.id)) continue;
    seen.add(d.id);
    const e = by.get(m) || by.set(m, { map: m, demos: 0, last: 0 }).get(m);
    e.demos++;
    e.last = Math.max(e.last, d.date);
  }
  const mine = aggregate(state.profile?.matches || []).maps;
  return [...by.values()].map(e => ({ ...e, me: mine[e.map] })).sort((a, b) => b.demos - a.demos || b.last - a.last);
}

function renderMaps() {
  const view = $('#view-maps');
  if (state.mp.map) return view.replaceChildren(mapDetail());
  const maps = mapsIndex();
  const pending = state.demos.filter(d => !d.summary && !d.failed).length;
  view.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h2', {}, 'Maps'), h('span', { class: 'dl-head-info' }, 'Kills, deaths, damage and grenades of every match on a map, in one zoomable radar.'),
      h('span', { class: 'spacer' }), pending ? h('span', { class: 'hint' }, spinner(11), ` reading ${pending} demos…`) : null),
    maps.length ? h('div', { class: 'map-grid' }, ...maps.map(e => {
      const info = radarMaps ? radarInfo(e.map) : null;
      const me = e.me;
      const wr = me ? pct(me.won, me.played) : null;
      return h('button', { class: 'map-card', style: { '--c': mapColor(e.map), '--img': info ? `url("radar/${radarName(info, e.map)}.png")` : 'none' }, onclick: () => { state.mp.map = e.map; resetZoom(state.mp.view); renderMaps(); } },
        h('div', { class: 'map-card-bg' }),
        h('div', { class: 'map-card-body' },
          h('div', { class: 'map-card-name' }, mapName(e.map)),
          h('div', { class: 'map-card-sub' }, `${e.demos} match${e.demos === 1 ? '' : 'es'} · last ${new Date(e.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`),
          me ? h('div', { class: 'map-card-rec' },
            h('span', {}, `${me.won}W – ${me.lost}L`), h('b', { class: wr >= 50 ? 'good' : 'bad' }, `${wr}%`),
            h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${wr >= 50 ? 'good' : 'bad'}`, style: { width: `${wr}%` } }))) : h('div', { class: 'map-card-rec muted' }, 'You did not play here'),
          info ? null : h('div', { class: 'map-card-sub' }, 'No radar image for this map')));
    })) : h('div', { class: 'empty' }, pending ? spinner(28) : icon(ICONS.demo, 'class="big"'), h('h2', {}, pending ? 'Reading your demos…' : 'No maps yet'), h('div', {}, 'Maps appear once their demos have been read.')),
  ));
}

function mapHeatData() {
  const mp = state.mp;
  const n = state.demos.filter(d => d.summary?.map === mp.map).length;
  const key = `${mp.map}|${mp.who}|${n}`;
  if (mp.data?.key === key) return mp.data;
  if (mp.loading !== key) {
    mp.loading = key;
    api.mapHeat(mp.map, mp.who === 'all' ? 'all' : null)
      .then(v => { mp.data = { key, ...v }; })
      .catch(e => { mp.data = { key, error: e.message }; })
      .finally(() => { if (mp.loading === key) mp.loading = null; if (state.view === 'maps') renderMaps(); });
  }
  return null;
}

function mapDetail() {
  const mp = state.mp, map = mp.map;
  const info = radarInfo(map);
  const rerender = () => renderMaps();
  const maps = mapsIndex();
  const head = h('div', { class: 'page-head map-head' },
    h('button', { class: 'btn ghost', onclick: () => { mp.map = null; rerender(); } }, icon('<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2"/>'), 'All maps'),
    h('h2', {}, mapName(map)),
    select(map, maps.map(e => [e.map, `${mapName(e.map)} (${e.demos})`]), v => { mp.map = v; resetZoom(mp.view); rerender(); }),
    h('span', { class: 'spacer' }),
    h('div', { class: 'tabs' }, ...[['me', 'Me'], ['all', 'Everyone']].map(([k, l]) =>
      h('button', { class: mp.who === k ? 'on' : '', onclick: () => { mp.who = k; if (k === 'all') mp.layers.delete('shot'); rerender(); } }, l))),
  );
  const wrap = (...body) => h('div', { class: 'page map-page' }, head, ...body);
  if (info === null) return wrap(h('div', { class: 'empty' }, h('h2', {}, 'No radar for this map'), h('div', {}, `There is no radar image for ${mapName(map)} yet. Run scripts/extract-radars.js after a CS2 update to add new maps.`)));
  const data = info && mapHeatData();
  if (!data) return wrap(h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Collecting every match on this map…')));
  if (data.error) return wrap(h('div', { class: 'err-box' }, data.error));

  const weapons = [...new Set(data.points.filter(p => WEAPON_KINDS.has(p[0]) && p[2]).map(p => p[2]))].sort();
  if (mp.weapon !== 'all' && !weapons.includes(mp.weapon)) mp.weapon = 'all';
  const floors = info.lowerBelow !== undefined;
  const pts = data.points.filter(p =>
    (mp.side === 'both' || p[1] === (mp.side === 'T' ? 0 : 1)) &&
    (mp.weapon === 'all' || !WEAPON_KINDS.has(p[0]) || p[2] === mp.weapon) &&
    (!floors || onLower(info, p[5]) === (mp.floor === 'lower')));
  let room = null, roomCounts = null;
  if (info.rooms) {
    roomCounts = {};
    for (const p of pts) if (mp.layers.has(HEAT_LAYERS[p[0]][0])) { const r = bestRoom(info, [[p[3], p[4]]]); if (r) roomCounts[r] = (roomCounts[r] || 0) + 1; }
    room = mp.room === 'auto' ? Object.entries(roomCounts).sort((x, y) => y[1] - x[1])[0]?.[0] || null : mp.room === 'overview' ? null : mp.room;
  }
  const frame = radarFrame(info, map, { room, lower: floors && mp.floor === 'lower' });
  if (mp.frameSrc !== frame.src) { mp.frameSrc = frame.src; resetZoom(mp.view); }

  const canvas = h('canvas', { width: 1800, height: 1800 });
  const prepared = prepareHeat(frame, pts, mp.layers);
  const opts = { dots: mp.display === 'dots', lines: mp.lines };
  let img = null;
  const redraw = () => drawHeat(canvas, img, mp.view, prepared, opts);
  radarImage(frame.src).then(i => { img = i; redraw(); });

  const controls = card('Show', [
    h('div', { class: 'ctl-row' }, h('label', {}, 'Side'), h('div', { class: 'tabs' }, ...[['both', 'Both'], ['T', 'T'], ['CT', 'CT']].map(([k, l]) =>
      h('button', { class: `${mp.side === k ? 'on' : ''} ${k !== 'both' ? 'side-' + k : ''}`, onclick: () => { mp.side = k; rerender(); } }, l)))),
    h('div', { class: 'ctl-row' }, h('label', {}, 'Display'), ...heatDisplayControls(mp, rerender)),
    weapons.length ? h('div', { class: 'ctl-row' }, h('label', {}, 'Weapon'), select(mp.weapon, [['all', 'All weapons'], ...weapons.map(w => [w, w])], v => { mp.weapon = v; rerender(); })) : null,
    floors ? h('div', { class: 'ctl-row' }, h('label', {}, 'Floor'), h('div', { class: 'tabs' }, ...[['upper', 'Upper'], ['lower', 'Lower']].map(([k, l]) =>
      h('button', { class: mp.floor === k ? 'on' : '', onclick: () => { mp.floor = k; rerender(); } }, l)))) : null,
    info.rooms ? h('div', { class: 'ctl-row' }, h('label', {}, 'Room'), roomSelect(info, mp.room, v => { mp.room = v; rerender(); }, roomCounts)) : null,
    h('div', { class: 'sub-head' }, 'Layers'),
    heatLayerChips(mp, pts, rerender, k => !(mp.who === 'all' && k === 'shot')),
    h('div', { class: 'hint' }, `${data.matches} match${data.matches === 1 ? '' : 'es'} · ${mp.who === 'all' ? 'all players' : 'only you'}${mp.display === 'dots' ? '' : ' · switch to Dots to see single positions'}`),
  ], { cls: 'map-controls' });

  const me = aggregate((state.profile?.matches || []).filter(m => m.map === map));
  const mine = (state.profile?.matches || []).filter(m => m.map === map).sort((a, b) => b.date - a.date);
  const stats = me.played ? card('You on ' + mapName(map), [
    h('div', { class: 'mini-stats' },
      ...[['Win rate', `${pct(me.won, me.played)}%`, pct(me.won, me.played) >= 50 ? 'good' : 'bad'], ['Rating', me.rating == null ? '—' : me.rating.toFixed(2), me.rating == null ? '' : ratingClass(me.rating)],
        ['K/D', me.kd.toFixed(2), qualityClass(me.kd, 1.05, 0.95)], ['ADR', me.adr.toFixed(0)]].map(([k, v, cls]) => h('div', { class: 'mini-stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls || ''}` }, v)))),
    barList([
      { label: 'T rounds won', value: `${pct(me.side.T.won, me.side.T.rounds)}%`, frac: me.side.T.rounds ? me.side.T.won / me.side.T.rounds : 0, fillCls: 't' },
      { label: 'CT rounds won', value: `${pct(me.side.CT.won, me.side.CT.rounds)}%`, frac: me.side.CT.rounds ? me.side.CT.won / me.side.CT.rounds : 0, fillCls: 'ct' },
    ]),
    h('div', { class: 'sub-head' }, `Matches (${me.won}W – ${me.lost}L${me.tied ? ` – ${me.tied}T` : ''})`),
    h('div', { class: 'map-matches' }, ...mine.slice(0, 8).map(m => h('button', { class: `mm r-${m.result}`, onclick: () => openMatch(m) },
      h('span', { class: 'rdot' }), h('span', { class: 'mm-date' }, new Date(m.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })),
      h('b', {}, `${m.score[0]}:${m.score[1]}`), h('span', { class: 'mm-kd' }, `${m.kills}–${m.deaths}`),
      h('span', { class: `rtg ${m.rating == null ? '' : ratingClass(m.rating)}` }, m.rating == null ? '' : m.rating.toFixed(2))))),
  ], { cls: 'map-stats' }) : null;

  return wrap(h('div', { class: 'map-layout' },
    h('div', { class: 'map-stage' }, zoomable(canvas, mp.view, redraw), h('div', { class: 'stage-hint' }, 'Scroll to zoom · drag to move · double-click for the whole map')),
    h('div', { class: 'map-side' }, controls, stats)));
}

// ---------- Highlights & recording ----------
function highlightCard(hl) {
  const sel = state.selected.has(hl.id);
  const done = clipsOf(hl);
  const clipped = done.length ? h('span', {
    class: 'tag clipped',
    title: `Already in your clips: ${done.map(c => c.file.split(/[\\/]/).pop()).join(', ')}. Recording it again makes a duplicate.`,
  }, icon(ICONS.check), done.length > 1 ? `Clipped ×${done.length}` : 'Already clipped') : null;
  return h('div', { class: `hl ${sel ? 'selected' : ''} ${done.length ? 'is-clipped' : ''}`, onclick: () => { sel ? state.selected.delete(hl.id) : state.selected.add(hl.id); renderDetail(); } },
    h('div', { class: 'check' }, icon(ICONS.check)),
    h('div', { class: 'round-box' }, h('div', { class: 'l' }, 'Round'), h('div', { class: 'n' }, hl.round), h('div', { class: `l side-${hl.side}` }, hl.side)),
    h('div', {},
      h('div', { class: 'hl-title' }, ...hl.tags.map(t => h('span', { class: `tag ${t.type}` }, t.label)), clipped),
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
    h('div', { class: 'info' }, n ? h('span', {}, h('b', {}, `${n} highlight${n > 1 ? 's' : ''}`), ` selected · about ${Math.ceil(estimateSeconds(hls) / 60)} min to record`,
      dup ? h('span', { class: 'dup-warn' }, ` · ${dup} already clipped`) : null) : 'Select highlights to record'),
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
      dup.length && fresh.length ? h('button', { class: 'btn', onclick: () => startRecord(fresh) }, `Skip clipped · record ${fresh.length}`) : null,
      h('button', { class: 'btn primary', onclick: () => startRecord(hls) }, icon(ICONS.rec), dup.length ? `Record all ${hls.length}` : 'Start recording'),
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
  if (done) { refreshEnv(); loadClipCount().then(() => { if (state.view === 'matches' && state.demo) renderDetail(); }); }
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
      h('div', {}, state.clips.length ? 'Try another weapon filter.' : 'Record highlights from a match’s Highlights & clips tab and they will show up here.'));
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
function toggle(label, on, onchange, title) {
  return h('button', { class: `chip-toggle ${on ? 'on' : ''}`, title, onclick: e => { on = !on; e.currentTarget.classList.toggle('on', on); onchange(on); } }, label);
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
      h('h3', {}, 'Display'),
      row('Interface size', select(String(st.uiScale || 0), [['0', `Automatic (now ${Math.round(autoScale() * 100)}%)`], ['0.9', '90%'], ['1', '100%'], ['1.1', '110%'], ['1.25', '125%'], ['1.4', '140%'], ['1.6', '160%']],
        v => save({ uiScale: +v }).then(() => { applyScale(); renderSettings(); })), 'Automatic makes everything a bit bigger on wide screens such as 2560 × 1440.'),
    ),

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
  applyScale();
  radarMaps = await api.radarMaps().catch(() => ({}));
  await refreshEnv();
  renderOverview();
  renderDetail();
  loadClipCount();
  api.listDownloads().then(r => { Object.assign(state.dl, r); updateDlCount(); }).catch(() => {});
  await loadDemos();
  setInterval(refreshEnv, 10000);
})();
// Clips in the library recorded from this highlight: same demo, round and point-of-view player.
// Clips made before demo ids were stored only know the demo's file name and the player's name.
function clipsOf(hl) {
  const d = state.demo, p = state.analysis?.player;
  if (!d || !p) return [];
  const base = d.path.split(/[\\/]/).pop();
  return (state.clips || []).filter(c => c.kind === 'clip' && c.round === hl.round
    && (c.demoId ? c.demoId === d.id : c.demo === base)
    && (c.steamid ? c.steamid === p.steamid : c.player === p.name));
}

  const dup = hls.filter(x => clipsOf(x).length).length;
  const dup = hls.filter(x => clipsOf(x).length);
  const fresh = hls.filter(x => !dup.includes(x));
    dup.length ? h('div', { class: 'warn-box' }, h('b', {}, `${dup.length === hls.length ? (dup.length > 1 ? 'All of these were' : 'This one was') : `${dup.length} of these ${dup.length > 1 ? 'were' : 'was'}`} already clipped`),
      ` (round${dup.length > 1 ? 's' : ''} ${dup.map(x => x.round).join(', ')}). Recording ${dup.length > 1 ? 'them' : 'it'} again makes duplicates.`) : null,
