/* global api */
'use strict';

// ---------- Helpers ----------
const $ = sel => document.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
    state.settings?.recording.method === 'hlae'
      ? ['Recorder', e.hlae?.installed ? 'ok' : 'bad', e.hlae?.installed ? `HLAE ${e.hlae.version}` : 'HLAE missing']
      : ['OBS', state.obsOk === undefined ? '' : state.obsOk ? 'ok' : 'bad', state.obsOk === undefined ? 'Not checked' : state.obsOk ? 'Connected' : 'Offline'],
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

const isRush = d => /^rush/i.test(d?.failure?.map || '') || /Rush match/.test(d === state.demo ? state.analysisError || '' : '');

function renderDemoList() {
  const q = state.search;
  const list = state.demos.filter(d => !q || d.name.toLowerCase().includes(q) || mapName(d.summary?.map).toLowerCase().includes(q));
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
    return h('div', { class: `demo ${state.demo?.path === d.path ? 'active' : ''}`, onclick: () => openDemo(d) },
      h('div', { class: 'map-thumb', style: { background: s ? `linear-gradient(135deg, ${mapColor(s.map)}, #20242c)` : 'var(--panel-3)' } }, s ? mapName(s.map).slice(0, 3).toUpperCase() : isRush(d) ? 'RSH' : d.failed ? '!' : '…'),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'demo-title' }, s ? mapName(s.map) : isRush(d) ? 'Rush match' : (isMM ? 'Premier / MM match' : d.name.replace(/\.dem$/i, ''))),
        h('div', { class: 'demo-meta', title: d.path }, `${fmtDate(d.date)} · ${isRush(d) ? 'could not be read' : isMM ? 'Valve match' : d.name.replace(/\.dem$/i, '')}`),
      ),
      h('div', { class: 'demo-right' },
        sc ? h('div', { class: `score-${res}` }, `${sc.mine}–${sc.enemy}`) : h('div', { class: 'score-d' }, s ? '—' : ''),
        s && s.highlights !== null ? h('span', { class: `hl-badge ${s.highlights ? '' : 'zero'}` }, `${s.highlights} ★`) : null,
      ));
  }));
}

async function openDemo(d, player) {
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
        h('h1', {}, mapName(a.map)),
        h('div', { class: 'sub' }, `${fmtDate(d.date)} · ${a.rounds} rounds · ${fmtSize(d.size)}`),
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

  const hls = a.highlights || [];
  const list = !a.playerFound
    ? [h('div', { class: 'empty' }, h('h2', {}, 'You are not in this demo'), h('div', {}, 'Pick the player whose highlights you want above.'))]
    : !hls.length
      ? [h('div', { class: 'empty' }, h('h2', {}, 'No highlights in this match'), h('div', {}, 'No multi-kills, clutches or special kills with the current rules. You can loosen them in Settings.'))]
      : hls.map(hl => highlightCard(hl));

  const allOn = hls.length && hls.every(x => state.selected.has(x.id));
  el.replaceChildren(
    h('div', { class: 'detail-scroll' },
      hero,
      hls.length ? h('div', { class: 'section-head' },
        h('h3', {}, 'Highlights'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'link-btn', onclick: () => { allOn ? state.selected.clear() : hls.forEach(x => state.selected.add(x.id)); renderDetail(); } }, allOn ? 'Select none' : 'Select all'),
      ) : null,
      ...list,
    ),
    actionBar(),
  );
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

const isBackground = () => state.settings.recording.method === 'hlae';

function estimateSeconds(hls) {
  const t = state.settings.timing;
  const segs = hls.reduce((n, x) => n + x.segments.length, 0);
  const play = hls.reduce((n, x) => n + x.duration, 0);
  // Background: CS2 start + demo load + ~1.3x game time (more if CS2 is minimized) + closing CS2.
  if (isBackground()) return t.startupWait + 40 + 15 + segs * 6 + play * 1.3 + hls.length * 4 + 20;
  return (state.env.cs2Running ? 0 : t.startupWait + 30) + t.demoLoadWait + segs * (t.seekWait + t.specWait + 3) + play + hls.length * 6;
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
  const method = state.settings.control.method;
  const steps = isBackground()
    ? [
      h('li', {}, 'CS2 opens ', h('b', {}, 'in a window through HLAE'), '. ', h('b', {}, 'Keep using your PC'), ': put other windows over it or minimize it (it renders a bit slower when minimized).'),
      state.env.cs2Running ? h('li', {}, h('b', {}, 'Close your running CS2 first'), ' — the recording session needs its own CS2.') : null,
      h('li', {}, 'CS2 runs with ', h('code', {}, '-insecure'), ' (no VAC servers) and ', h('b', {}, 'is closed automatically'), ' when done. Never join matches from that session.'),
      h('li', {}, 'Clips are saved to ', h('code', {}, state.env.outputDir)),
    ]
    : [
      h('li', {}, 'Keep ', h('b', {}, 'OBS open'), ' (the app creates its own "CS2 ClipMaker" scene).'),
      state.env.cs2Running ? null : h('li', {}, h('b', {}, 'CS2 will be started'), ' automatically.'),
      method === 'keypress' ? h('li', {}, h('b', {}, "Don't touch the mouse or keyboard"), ' while it records — the app sends commands by pressing a key in the CS2 window.') : null,
      h('li', {}, 'Clips are saved to ', h('code', {}, state.env.outputDir)),
    ];
  modal([
    h('h2', {}, `Record ${hls.length} clip${hls.length > 1 ? 's' : ''}?`),
    h('p', {}, `${isBackground() ? 'CS2 will play the demo in the background and HLAE will record each highlight frame by frame.' : 'CS2 will play the demo and OBS will record each highlight.'} This takes about ${mins} minute${mins > 1 ? 's' : ''}.`),
    h('ul', { class: 'steps' }, ...steps),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => startRecord(hls) }, icon(ICONS.rec), 'Start recording'),
    ),
  ]);
}

async function startRecord(hls, opts = {}) {
  const items = hls.map(x => ({ demoPath: state.demo.path, highlightId: x.id }));
  const steamid = state.analysis.player?.steamid;
  try {
    const r = await api.record(items, steamid, opts);
    if (r.needsBind) return askBind(hls);
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
        startRecord(hls, opts);
      } catch (err) { status.textContent = '✗ ' + err.message; btn.disabled = false; }
    } }, 'Install HLAE') : null;
    modal([h('h2', {}, 'Could not start'), h('div', { class: 'err-box' }, msg), status,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'), install)]);
  }
}

function askBind(hls) {
  const key = state.settings.control.key;
  modal([
    h('h2', {}, 'CS2 is already running'),
    h('p', {}, `The app talks to CS2 through a key bind (${key.toUpperCase()}). Since CS2 was started without it, do one of these:`),
    h('ul', { class: 'steps' },
      h('li', {}, 'Open the CS2 console (~) and type ', h('code', {}, 'exec clipmaker_init'), ', then click "I did it".'),
      h('li', {}, 'Or close CS2 and click "Start recording" again — the app will launch CS2 with the bind.'),
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { await api.cs2MarkBound(); startRecord(hls, { assumeBound: true }); } }, 'I did it'),
    ),
  ]);
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
    r.state === 'running' && !isBackground() && state.settings.control.method === 'keypress' ? h('div', { class: 'warn-box' }, "Hands off the keyboard and mouse — CS2 needs to stay in the foreground. Press Cancel here to stop.") : null,
    r.state === 'running' && isBackground() ? h('div', { class: 'info-box' }, 'Recording in the background — keep using your PC. CS2 can stay behind other windows or minimized.') : null,
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
  } }, `Update to ${u.latest}`) : null;
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

  const obsResult = h('span', { class: 'hint' });
  const cs2Result = h('span', { class: 'hint' });

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
      h('div', { class: 'desc' }, 'Background mode records through HLAE while you keep using your PC. OBS mode needs CS2 in the foreground.'),
      row('Method', select(st.recording.method, [['hlae', 'Background — HLAE (recommended)'], ['obs', 'Foreground — OBS']], v => save({ recording: { method: v } }).then(() => { renderSettings(); renderStatus(); }))),
      ...(st.recording.method === 'hlae' ? [
        row('HLAE folder', h('div', { class: 'ctl' },
          h('span', { class: 'mono', style: { flex: 1 } }, e.hlae?.dir || ''),
          h('span', { class: `pill ${e.hlae?.installed ? 'ok' : 'bad'}` }, e.hlae?.installed ? `HLAE ${e.hlae.version}` : 'Not found'),
          h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder('HLAE folder (contains HLAE.exe)'); if (p) { await save({ hlae: { path: p } }); await refreshEnv(); renderSettings(); } } }, 'Browse')),
          'HLAE must match your CS2 version. After a CS2 update, recording can fail until HLAE is updated.'),
        row('HLAE updates', hlaeUpdateCtl()),
        row('Resolution', select(`${st.hlae.width}x${st.hlae.height}`, [['1280x720', '1280 × 720'], ['1920x1080', '1920 × 1080'], ['2560x1440', '2560 × 1440']],
          v => { const [w, hh] = v.split('x').map(Number); save({ hlae: { width: w, height: hh } }); })),
        row('Frame rate', select(String(st.hlae.fps), [['30', '30 fps'], ['60', '60 fps'], ['120', '120 fps']], v => save({ hlae: { fps: +v } }))),
      ] : []),
    ),

    h('div', { class: 'card' },
      h('h3', {}, st.recording.method === 'hlae' ? 'OBS Studio (only for foreground mode)' : 'OBS Studio'),
      h('div', { class: 'desc', html: 'In OBS: <b>Tools → WebSocket Server Settings</b> → tick <b>Enable WebSocket server</b>, then <b>Show Connect Info</b> to copy the password here.' }),
      row('Host / port', h('div', { class: 'ctl' }, text(st.obs.host, v => save({ obs: { host: v } }), { style: 'flex:0 0 160px' }), num(st.obs.port, v => save({ obs: { port: v } }), { max: 65535 }))),
      row('Password', h('input', { type: 'password', value: st.obs.password, onchange: ev => save({ obs: { password: ev.target.value } }) })),
      row('', h('div', { class: 'ctl' },
        h('button', { class: 'btn', onclick: async () => {
          obsResult.textContent = 'Connecting…';
          try { const v = await api.obsTest(); state.obsOk = true; obsResult.textContent = `✓ Connected to OBS ${v.obsVersion} — scene "CS2 ClipMaker" is ready.`; }
          catch (err) { state.obsOk = false; obsResult.textContent = '✗ ' + err.message; }
          renderStatus();
        } }, 'Test & set up scene'), obsResult)),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Counter-Strike 2'),
      h('div', { class: 'desc' }, 'How the app controls demo playback.'),
      row('CS2 folder', h('div', { class: 'ctl' }, text(st.cs2Dir || e.cs2Dir || '', v => save({ cs2Dir: v }).then(refreshEnv), { class: 'mono' }),
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder('Counter-Strike Global Offensive folder'); if (p) { await save({ cs2Dir: p }); await refreshEnv(); renderSettings(); } } }, 'Browse'))),
      row('Your SteamID64', text(st.steamId, v => save({ steamId: v }, true).then(refreshEnv), { placeholder: e.steamUser ? `${e.steamUser.steamid} (${e.steamUser.name}, auto)` : '7656119…', class: 'mono' }), 'Leave empty to use the Steam account logged in on this PC.'),
      row('Control method', select(st.control.method, [['keypress', 'Key press (normal game)'], ['netcon', 'Console port (needs -tools)']], v => save({ control: { method: v } }).then(renderSettings)),
        st.control.method === 'keypress'
          ? 'Writes commands to a cfg file and presses the trigger key in CS2. Works with the normal game.'
          : 'Uses -netconport. On Windows, CS2 must run with -tools (Workshop Tools installed).'),
      st.control.method === 'keypress'
        ? row('Trigger key', select(st.control.key, [['scrolllock', 'Scroll Lock'], ['f13', 'F13'], ['insert', 'Insert']], v => save({ control: { key: v } })), "Pick a key you don't use in game.")
        : row('Console port', num(st.control.netconPort, v => save({ control: { netconPort: v } }), { max: 65535 })),
      row('', h('div', { class: 'ctl' },
        h('button', { class: 'btn', onclick: async () => { cs2Result.textContent = 'Launching…'; try { await api.cs2Launch(); cs2Result.textContent = '✓ CS2 is starting with the ClipMaker bind.'; } catch (err) { cs2Result.textContent = '✗ ' + err.message; } refreshEnv(); } }, 'Launch CS2'),
        h('button', { class: 'btn', onclick: async () => { cs2Result.textContent = 'Sending…'; try { await api.cs2Test(); cs2Result.textContent = '✓ Sent. Did the CS2 console open and close? If yes, control works.'; } catch (err) { cs2Result.textContent = '✗ ' + err.message; } } }, 'Test control'),
        cs2Result)),
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
      row('Keep raw recordings', toggle('Keep', st.keepRaw, v => save({ keepRaw: v })), 'Saves the untrimmed OBS files in a _raw folder.'),
      row('ffmpeg', h('div', { class: 'ctl' }, h('span', { class: 'mono', style: { flex: 1 } }, e.ffmpeg || 'not found'),
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFile('ffmpeg.exe', [{ name: 'ffmpeg', extensions: ['exe'] }]); if (p) { await save({ ffmpegPath: p }); await refreshEnv(); renderSettings(); } } }, 'Browse'))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, 'Advanced timing & commands'),
      h('div', { class: 'desc' }, 'Increase the waits if clips start too early or show loading screens. Commands are separated by ";" — {tick}, {accountid} and {name} are filled in.'),
      row('CS2 startup wait', h('div', { class: 'ctl' }, num(t.startupWait, v => save({ timing: { startupWait: v } }), { max: 300 }), 'seconds')),
      row('Demo load wait', h('div', { class: 'ctl' }, num(t.demoLoadWait, v => save({ timing: { demoLoadWait: v } }), { max: 300 }), 'seconds')),
      row('Seek wait', h('div', { class: 'ctl' }, num(t.seekWait, v => save({ timing: { seekWait: v } }), { max: 60, step: 0.5 }), 'seconds')),
      row('Spectate wait', h('div', { class: 'ctl' }, num(t.specWait, v => save({ timing: { specWait: v } }), { max: 30, step: 0.5 }), 'seconds')),
      row('Setup commands', text(st.commands.setup, v => save({ commands: { setup: v } }), { class: 'mono' })),
      row('Seek command', text(st.commands.seek, v => save({ commands: { seek: v } }), { class: 'mono' })),
      row('Spectate command', text(st.commands.spectate, v => save({ commands: { spectate: v } }), { class: 'mono' })),
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
