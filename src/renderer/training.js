/* global pageBackdrop, $, api, state, h, icon, ICONS, toast, card, barList, big, kv, select, toggle, modal, closeModal, spinner, ago, fmtDate, fmtDur, clamp, showView, mapName, mapColor, mapShotUrl, artImg, mapEmblem, renderOverview */
'use strict';
// The Training page: four cards (Utility, My scenarios, Warm-up, Procedural map), each opening a page
// with a look of its own, and a session's results. The sessions run in CS2 (lib/training.js); results
// come from the demo recorded meanwhile (lib/drillStats.js). Utility (the lineups page) is one of the cards.

state.tr = { info: null, loading: false, drill: null, map: null, status: null };

// the cards after Utility (the lineups page); pre-aim, crosshair, peek, strafe and tracking are older
// sessions' drills, still shown in their results
const DRILL_ORDER = ['scenario', 'warmup', 'procedural'];
const GUNS = [['ak47', 'AK-47'], ['m4a1', 'M4A4'], ['m4a1_silencer', 'M4A1-S'], ['galilar', 'Galil AR'], ['famas', 'FAMAS'], ['awp', 'AWP'], ['deagle', 'Desert Eagle'], ['usp_silencer', 'USP-S'], ['glock', 'Glock-18'], ['mp9', 'MP9']];
const LEVELS = [[0, 'Easy'], [1, 'Normal'], [2, 'Hard'], [3, 'Expert']];
const TR_ICONS = {
  warmup: '<path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.8.8-3 2-4 0 2 1 3 2 3 0-3-1-5 0-7.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  procedural: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  preaim: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  crosshair: '<path d="M3 12h18" stroke="currentColor" stroke-width="1.7" stroke-dasharray="2 2"/><circle cx="7" cy="12" r="2" fill="currentColor"/><circle cx="17" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  peek: '<path d="M10 3v18M10 7h6M10 17h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="17.5" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  strafe: '<path d="M4 12h6M14 12h6M7 9l-3 3 3 3M17 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  tracking: '<path d="M3 15c3-6 6-6 9 0s6 6 9 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="15" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  scenario: '<path d="M4 5l5-2 6 2 5-2v16l-5 2-6-2-5 2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M14.5 13.5l3 3M17.5 13.5l-3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  utility: '<circle cx="11" cy="14.5" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 8.8V6h4v2.8M13 6.5l5-2.5M16.5 12.5h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};
// Each card's colour and the line above its name; the Workshop maps' screenshots (img/training, taken
// from their Steam Workshop pages) with their captions.
const TR_LOOK = {
  utility: { c: '#e8a93c' },
  scenario: { c: '#ff5468' },
  warmup: { c: '#ffc21a', tag: 'Steam Workshop · Aim Botz' },
  procedural: { c: '#a8e84a', tag: 'Steam Workshop · SCOPE.GG' },
};
const TR_SHOTS = {
  warmup: ['Rows of bots to flick between', 'Bots running across the arena', 'Cover walls to peek from', 'The settings board: bots, guns, movement', 'Bots at every range', 'The arena'],
  procedural: ['A new layout every run', 'Bots check every position', 'Score as many points as you can', 'Bring your friends', 'Rooms of competitive maps, joined at random'],
};
const trShot = (id, i) => `img/training/${id}-${i + 1}.jpg`;
// The numbers shown per drill: [label, value(metrics), lower is better].
const fmtMs = v => (v == null ? '—' : `${Math.round(v)} ms`);
const fmtDeg = v => (v == null ? '—' : `${v.toFixed(1)}°`);
const fmtPct = v => (v == null ? '—' : `${Math.round(v)}%`);
const KEY = {
  preaim: [['Crosshair off', m => fmtDeg(m.xhair)], ['Time to kill', m => fmtMs(m.ttk)], ['Reaction', m => fmtMs(m.react)], ['Headshot kills', m => fmtPct(m.hsRate)]],
  crosshair: [['Crosshair off', m => fmtDeg(m.xhair)], ['Height error', m => fmtDeg(m.pitch)], ['Time to kill', m => fmtMs(m.ttk)], ['Headshot kills', m => fmtPct(m.hsRate)]],
  peek: [['Duels won', m => fmtPct(m.duels)], ['First bullet hit', m => fmtPct(m.firstHit)], ['First bullet still', m => fmtPct(m.firstOk)], ['Time to kill', m => fmtMs(m.ttk)]],
  strafe: [['Shots standing still', m => fmtPct(m.moving == null ? null : 100 - m.moving)], ['Accuracy', m => fmtPct(m.accuracy)], ['First bullet still', m => fmtPct(m.firstOk)], ['Shots', m => m.shots]],
  tracking: [['On target', m => fmtPct(m.tracking)], ['Crosshair off (spray)', m => fmtDeg(m.trackErr)], ['Accuracy', m => fmtPct(m.accuracy)], ['Headshot hits', m => m.headHits]],
  scenario: [['Duels won', m => fmtPct(m.duels)], ['Crosshair off', m => fmtDeg(m.xhair)], ['Time to kill', m => fmtMs(m.ttk)], ['Headshot kills', m => fmtPct(m.hsRate)]],
  procedural: [['Kills', m => m.kills], ['Deaths', m => m.deaths], ['Accuracy', m => fmtPct(m.accuracy)], ['Reaction', m => fmtMs(m.react)]],
  warmup: [['Kills', m => m.kills], ['Accuracy', m => fmtPct(m.accuracy)], ['Headshot kills', m => fmtPct(m.hsRate)], ['Reaction', m => fmtMs(m.react)]],
};
const TR_DEATH_TAGS = {
  caught: ['Caught', 'the crosshair was 15° or more away when they came into view'],
  outaimed: ['Out-aimed', 'the crosshair was close, they were just faster'],
  unseen: ['Not seen', 'they never came into view in front of you: behind you, or off to the side'],
  slow: ['Slow', 'no shot within 600 ms of seeing them'],
  moving: ['Moving', 'your last shot was fired while still moving'],
  missed: ['Missed', 'you shot but never hit them'],
  hitfirst: ['Hit first', 'you hit them first and still lost'],
  flashed: ['Flashed', 'blind when you died'],
  reloading: ['Reloading', 'you reloaded just before'],
};

const drillDef = id => state.tr.info?.drills?.[id];
// the session's guns and bot level (Setup of My scenarios), kept while the app runs
const trOpts = () => {
  const cfg = state.settings?.training || {};
  return state.tr.opt || (state.tr.opt = { weapon: cfg.weapon || 'ak47', botWeapon: cfg.botWeapon || 'ak47', difficulty: cfg.difficulty ?? 2, hsOnly: false,
    pistol: cfg.pistol || 'usp_silencer', nades: cfg.nades || [], armor: cfg.armor ?? 'assaultsuit' });
};
const historyOf = id => (state.tr.info?.history || []).filter(e => e.drill === id).sort((a, b) => a.date - b.date);

function loadTraining(force = false) {
  const tr = state.tr;
  if ((tr.info && !force) || tr.loading) return;
  tr.loading = true;
  api.training().then(info => {
    tr.info = info;
    if (info.status && !tr.status) tr.status = info.status;
    if (!tr.map) tr.map = info.maps[0]?.map || null;
  }).catch(e => toast(e.message, 'error')).finally(() => {
    tr.loading = false;
    if (state.view === 'training') renderTraining();
    if (state.view === 'overview') renderOverview();
  });
}

let lastBeep = 0;
api.onTraining(st => {
  const tr = state.tr;
  tr.status = st;
  if (st.drill === 'record') {
    if (st.beep && st.beep !== lastBeep) recBeep();
    lastBeep = st.beep || 0;
    if (st.phase === 'recorded') recordedScenario(st);
    if (st.phase === 'cancelled') tr.status = null;
  }
  if (st.phase === 'done') { toast(`Training saved${st.result?.score != null ? `: score ${st.result.score}` : ''}.`, 'ok'); loadTraining(true); }
  if (st.phase === 'error') toast(st.error.replace(/^.*(HLAE_MISSING|WORKSHOP_MISSING):\s*/, ''), 'error');
  const bar = $('#trLive');
  if (state.view === 'training' && bar && st.phase === 'running') bar.replaceWith(liveBar());
  else if (state.view === 'training') renderTraining();
});

const running = () => ['starting', 'loading', 'running', 'recording', 'analyzing'].includes(state.tr.status?.phase);

// ---------- page ----------
function renderTraining() {
  const tr = state.tr, view = $('#view-training');
  if (!tr.info) { loadTraining(); return view.replaceChildren(h('div', { class: 'empty' }, spinner(28))); }
  view.replaceChildren(h('div', { class: 'page' }, tr.drill === 'scenario' ? scenarioPage() : tr.drill ? workshopPage(tr.drill) : hubPage()));
  pageBackdrop();
}

function hubPage() {
  const tr = state.tr;
  const head = h('div', { class: 'page-head' }, h('h2', {}, 'Training'),
    h('span', { class: 'dl-head-info' }, 'Four ways to practise in CS2. Every session is recorded and scored from its demo.'));
  // the map with the most lineups shows on the Utility card
  const lineups = state.ut?.items || [];
  const per = {};
  for (const x of lineups) per[x.map] = (per[x.map] || 0) + 1;
  const utMap = Object.keys(per).sort((a, b) => per[b] - per[a])[0] || 'de_mirage';
  const utMaps = Object.keys(per).length;
  const utility = hubCard('utility', { name: 'Utility', art: mapShotUrl(utMap), onclick: () => showView('utility'),
    sub: lineups.length ? `${lineups.length} lineup${lineups.length === 1 ? '' : 's'} on ${utMaps} map${utMaps === 1 ? '' : 's'}` : 'No lineup saved yet',
    about: 'Your smokes, flashes and molotovs, map by map. Quiz yourself, then throw them on a practice server.' });
  // the cards fill the window; the progress is under them
  return [h('div', { class: 'tr-hub' }, head, running() || ['done', 'error'].includes(tr.status?.phase) ? liveBar() : null,
    h('div', { class: 'tr-grid' }, utility, ...DRILL_ORDER.map(id => drillCard(id)))), progressSection()];
}

function drillCard(id) {
  const d = drillDef(id);
  const hist = historyOf(id);
  const last = hist.at(-1), best = hist.reduce((m, e) => Math.max(m, e.score ?? -1), -1);
  const scMap = [...(state.sc?.items || [])].sort((a, b) => b.updated - a.updated)[0]?.map || last?.map || 'de_mirage';
  return hubCard(id, { name: d.name, about: d.about, art: TR_SHOTS[id] ? Promise.resolve(trShot(id, 0)) : mapShotUrl(scMap),
    sub: last ? `${hist.length} session${hist.length === 1 ? '' : 's'} · last ${ago(last.date)}` : 'Not played yet',
    onclick: () => { state.tr.drill = id; renderTraining(); },
    score: hist.length ? h('div', { class: 'tr-card-score' },
      h('span', {}, 'Last', h('b', {}, last.score ?? '—')), h('span', {}, 'Best', h('b', {}, best >= 0 ? best : '—')),
      hist.length > 1 ? sparkline(hist.map(e => e.score)) : null) : null });
}

// A hub card: a picture, the card's own colour and the line above its name.
function hubCard(id, { name, sub, about, art, onclick, score = null }) {
  const look = TR_LOOK[id];
  return h('button', { class: `map-card tr-card tr-card-${id}`, style: { '--c': look.c }, onclick },
    artImg('map-card-photo', art),
    look.tag ? h('span', { class: 'tr-card-tag' }, look.tag) : null,
    h('div', { class: 'map-card-body' },
      h('div', { class: 'map-card-title' }, h('span', { class: 'tr-icon' }, icon(TR_ICONS[id])),
        h('div', { class: 'map-card-t' }, h('div', { class: 'map-card-name' }, name), h('div', { class: 'map-card-sub' }, sub))),
      h('div', { class: 'tr-card-about' }, about),
      score));
}

// The live state of a running session, or how the last one ended.
function liveBar() {
  const st = state.tr.status || {};
  const d = drillDef(st.drill) || {};
  const stop = h('button', { class: 'btn', onclick: () => trGuard(() => api.trainingStop()) }, drillDef(st.drill)?.free ? 'Finish' : 'Stop', h('kbd', { class: 'tr-kbd', title: 'Works from CS2 too' }, 'F3'));
  let body;
  if (st.phase === 'done') {
    const r = st.result;
    body = [h('b', {}, `${d.name} done`), r?.score != null ? h('span', {}, `score ${r.score}`) : null,
      h('span', { class: 'spacer' }), r ? h('button', { class: 'btn primary', onclick: () => openSession(r.id) }, 'See results') : null,
      h('button', { class: 'btn', onclick: () => { state.tr.status = null; renderTraining(); } }, 'Dismiss')];
  } else if (st.phase === 'error') {
    const workshop = /WORKSHOP_MISSING/.test(st.error);
    body = [h('b', { class: 'bad' }, 'Training stopped'), h('span', {}, st.error.replace(/^.*(HLAE_MISSING|WORKSHOP_MISSING):\s*/, '')), h('span', { class: 'spacer' }),
      workshop ? h('button', { class: 'btn primary', onclick: () => api.trainingWorkshop() }, 'Open in the Workshop') : null,
      h('button', { class: 'btn', onclick: () => { state.tr.status = null; renderTraining(); } }, 'Dismiss')];
  } else {
    const rep = st.rep ? (st.reps ? `rep ${st.rep}/${st.reps}` : `rep ${st.rep}${st.left != null ? ` · ${fmtDur(st.left)} left` : ''}`) : null;
    body = [spinner(14), h('b', {}, d.name || 'Training'), st.map ? h('span', {}, mapName(st.map)) : null,
      st.phase === 'running' ? [rep ? h('span', {}, rep) : null,
        st.rooms != null ? h('span', {}, `room ${st.rooms || '—'}`) : null, st.runs ? h('span', {}, `${st.runs} run${st.runs === 1 ? '' : 's'} finished`) : null,
        st.kills != null ? h('span', {}, `${st.kills} kills · ${st.deaths} deaths`) : null] : h('span', {}, st.message || (st.phase === 'analyzing' ? 'Reading the training demo…' : 'Starting CS2…')),
      st.phase === 'running' && st.message ? h('span', { class: 'muted' }, st.message) : null,
      st.gsiNew && st.phase !== 'running' ? h('span', { class: 'muted' }, 'Live kill tracking was just installed: it starts with CS2\'s next start.') : null,
      h('span', { class: 'spacer' }), st.phase === 'analyzing' ? null : stop];
  }
  return h('div', { class: `tr-live ${st.phase || ''}`, id: 'trLive' }, ...body);
}

function trGuard(fn) { return fn().catch(e => toast(e.message.replace(/^.*(HLAE_MISSING|WORKSHOP_MISSING):\s*/, ''), 'error')); }

// Scores over time, per drill.
function progressSection() {
  const hist = state.tr.info.history || [];
  if (!hist.length) return null;
  const rows = DRILL_ORDER.map(id => [id, historyOf(id)]).filter(([, l]) => l.length);
  return h('section', { class: 'ov-sec' }, h('div', { class: 'sec' }, h('h3', {}, 'Progress')),
    h('div', { class: 'dash' },
      card('Scores', h('div', { class: 'tr-prog' }, ...rows.map(([id, l]) => {
        const s = l.filter(e => e.score != null).map(e => e.score);
        const first = s.slice(0, 3), lastN = s.slice(-3);
        const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
        const delta = s.length >= 4 ? avg(lastN) - avg(first) : null;
        return h('button', { class: 'tr-prog-row', onclick: () => { state.tr.drill = id; renderTraining(); } },
          h('span', { class: 'tr-icon sm' }, icon(TR_ICONS[id])), h('span', { class: 'tr-prog-name' }, drillDef(id).name),
          sparkline(l.map(e => e.score), 160, 28),
          h('b', {}, s.at(-1) ?? '—'),
          delta == null ? h('span', { class: 'muted' }, `${l.length}×`) : h('span', { class: delta >= 0 ? 'good' : 'bad' }, `${delta >= 0 ? '+' : ''}${delta}`));
      })), { span: 2 }),
      card('Recent sessions', sessionList(hist.slice(-8).reverse()), { span: 2 })));
}

function sessionList(list) {
  if (!list.length) return h('div', { class: 'muted-note' }, 'No sessions yet');
  return h('div', { class: 'tr-sessions' }, ...list.map(e => h('button', { class: 'tr-session', onclick: () => openSession(e.id) },
    h('span', { class: 'tr-icon sm' }, icon(TR_ICONS[e.drill] || TR_ICONS.preaim)),
    h('span', { class: 'tr-session-t' }, h('b', {}, e.scenario?.name || drillDef(e.drill)?.name || e.drill), h('small', {}, `${mapName(e.map)} · ${fmtDate(e.date)} · ${fmtDur(e.seconds || 0)}`)),
    h('span', { class: 'tr-session-m' }, ...(KEY[e.drill] || KEY.preaim).slice(0, 2).map(([k, f]) => h('span', {}, h('small', {}, k), h('b', {}, f(e.metrics || {}))))),
    h('span', { class: 'tr-score' }, e.score ?? (e.mapScore != null ? e.mapScore : '—')))));
}

// A small line of scores, oldest to newest.
function sparkline(values, w = 120, hgt = 26) {
  const v = values.filter(x => x != null);
  if (v.length < 2) return h('span', {});
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1) * (w - 4) + 2).toFixed(1)},${(hgt - 3 - (x - lo) / span * (hgt - 6)).toFixed(1)}`).join(' ');
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${hgt}`); s.setAttribute('class', 'tr-spark');
  s.style.width = `${w}px`; s.style.height = `${hgt}px`;
  s.innerHTML = `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${pts.split(' ').at(-1).split(',')[0]}" cy="${pts.split(' ').at(-1).split(',')[1]}" r="2.6" fill="currentColor"/>`;
  return s;
}

// ---------- the Workshop maps (Warm-up, Procedural map) ----------
// Each has a page of its own: Aim Botz a wide banner going through its screenshots, the procedural
// map its pitch next to a mosaic of them. Under both: how the last session went, then the sessions.
function workshopPage(id) {
  const tr = state.tr, info = tr.info, d = drillDef(id);
  const installed = !!info.workshop?.[id];
  const back = h('button', { class: 'link-btn', onclick: () => { tr.drill = null; renderTraining(); } }, '← Training');
  const start = h('button', { class: 'btn primary big-btn', disabled: running() || !installed,
    onclick: () => trGuard(async () => {
      await api.trainingStart({ drill: id, ...trOpts() });
      state.tr.status = { drill: id, map: d.map, phase: 'starting' };
      tr.drill = null;
      renderTraining();
    }) }, icon(ICONS.play), running() ? 'A session is running' : 'Start in CS2');
  const ready = installed ? h('span', { class: 'tr-ws-ok' }, '✓ Installed from the Workshop')
    : h('button', { class: 'btn', onclick: () => api.trainingWorkshop(id) }, 'Subscribe in the Workshop');
  const actions = h('div', { class: 'tr-ws-actions' }, start, ready);
  const top = id === 'warmup' ? warmupTop(d, actions) : proceduralTop(d, actions);
  return [h('div', { class: 'page-head' }, back), running() ? liveBar() : null,
    h('div', { class: `tr-ws tr-ws-${id}`, style: { '--c': TR_LOOK[id].c } }, ...top, ...drillResults(id))];
}

// Aim Botz: the banner cross-fades through the screenshots, the strip under it picks one.
function warmupTop(d, actions) {
  const shots = TR_SHOTS.warmup;
  const layers = [0, 1].map(() => h('div', { class: 'tr-hero-img' }));
  let at = -1, front = 0;
  const thumbs = shots.map((cap, i) => h('button', { class: 'tr-thumb', title: `${cap} (click to enlarge)`, onclick: () => trLightbox('warmup', i), onpointerenter: () => show(i) },
    h('img', { src: trShot('warmup', i), alt: cap, draggable: 'false' })));
  function show(i) {
    if (i === at) return;
    at = i; front ^= 1;
    layers[front].style.backgroundImage = `url("${trShot('warmup', i)}")`;
    layers[front].classList.add('on'); layers[front ^ 1].classList.remove('on');
    thumbs.forEach((t, k) => t.classList.toggle('on', k === i));
  }
  show(0);
  const hero = h('div', { class: 'tr-hero' }, ...layers,
    h('div', { class: 'tr-hero-body' },
      h('span', { class: 'tr-ws-tag' }, TR_LOOK.warmup.tag),
      h('h1', {}, d.name), h('p', {}, d.about), actions));
  const timer = setInterval(() => { if (!hero.isConnected) return clearInterval(timer); if (!hero.matches(':hover')) show((at + 1) % shots.length); }, 6000);
  const steps = [['Start in CS2', 'DemoLab opens Aim Botz on a private server and records the session.'],
    ['Set up the bots', d.how], ['Press Finish', 'Here, or F3 in CS2: your score, reaction times and why you died, read from the demo.']];
  return [hero, h('div', { class: 'tr-thumbs' }, ...thumbs),
    h('div', { class: 'tr-steps' }, ...steps.map(([t, s], i) => h('div', { class: 'tr-step' }, h('span', { class: 'tr-step-n' }, i + 1), h('div', {}, h('b', {}, t), h('p', {}, s)))))];
}

// The procedural map: what it is on the left, a mosaic of its screenshots on the right.
const PG_POINTS = [
  ['A new layout every run', TR_ICONS.procedural],
  ['Rooms taken from competitive maps', '<path d="M4 5l5-2 6 2 5-2v16l-5 2-6-2-5 2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'],
  ['Bots that strafe, flash and peek you', TR_ICONS.preaim],
  ['A score per run, next to the map\'s highscores', '<path d="M5 20V10M12 20V4M19 20v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'],
];
function proceduralTop(d, actions) {
  return [h('div', { class: 'tr-split' },
    h('div', { class: 'tr-pitch' },
      h('span', { class: 'tr-ws-tag' }, TR_LOOK.procedural.tag),
      h('h1', {}, d.name), h('p', {}, d.about),
      h('ul', { class: 'tr-points' }, ...PG_POINTS.map(([t, ic]) => h('li', {}, h('span', { class: 'tr-point-ic' }, icon(ic)), t))),
      h('div', { class: 'tr-note' }, d.how),
      actions),
    h('div', { class: 'tr-bento' }, ...TR_SHOTS.procedural.map((cap, i) => h('button', { class: 'tr-bento-shot', title: 'Click to enlarge', onclick: () => trLightbox('procedural', i) },
      h('img', { src: trShot('procedural', i), alt: cap, draggable: 'false' }), h('span', {}, cap)))))];
}

// A screenshot full size, with the others a click away.
function trLightbox(id, i) {
  const caps = TR_SHOTS[id], n = caps.length;
  modal([h('img', { class: 'ut-big', src: trShot(id, i) }),
    h('div', { class: 'video-foot' },
      h('div', { class: 't' }, caps[i], h('span', { class: 'muted' }, `  ·  ${i + 1} / ${n}`)),
      h('button', { class: 'btn', onclick: () => trLightbox(id, (i + n - 1) % n) }, '‹ Previous'),
      h('button', { class: 'btn', onclick: () => trLightbox(id, (i + 1) % n) }, 'Next ›'),
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'))], { wide: true });
}

// The last session's numbers (with the one before), the score over time and every session.
function drillResults(id) {
  const hist = historyOf(id), last = hist.at(-1), prev = hist.at(-2);
  const how = state.tr.info.how?.[id];
  if (!last) {
    return [h('div', { class: 'tr-ws-empty' }, h('b', {}, 'No session yet'),
      h('span', {}, `Your numbers show here after the first one${how ? `. Score = ${how}` : ''}.`))];
  }
  const best = Math.max(...hist.map(e => e.score ?? 0));
  const tiles = (KEY[id] || []).map(([k, f]) => h('div', { class: 'tr-stat' }, h('small', {}, k), h('b', {}, f(last.metrics || {})),
    prev ? h('span', { class: 'tr-stat-prev' }, `before: ${f(prev.metrics || {})}`) : null));
  return [
    h('div', { class: 'tr-ws-sec' }, h('h3', {}, 'Last session'), h('span', { class: 'hint' }, `${ago(last.date)} · ${fmtDur(last.seconds || 0)}`),
      h('span', { class: 'spacer' }), h('button', { class: 'link-btn', onclick: () => openSession(last.id) }, 'Full results →')),
    h('div', { class: 'tr-stats' },
      h('div', { class: 'tr-stat score' }, h('small', {}, 'Score'), h('b', {}, last.score ?? '—', h('small', {}, ' /100')),
        h('span', { class: 'tr-stat-prev' }, `best ${best} · ${hist.length} session${hist.length === 1 ? '' : 's'}`)),
      ...tiles),
    h('div', { class: 'dash' },
      hist.length > 1 ? card('Score over time', [scoreChart(hist), how ? h('div', { class: 'tr-note' }, `Score = ${how}.`) : null], { span: 2 }) : null,
      card('Sessions', sessionList([...hist].reverse()), { span: hist.length > 1 ? 2 : 4 }))];
}

// Score per session with the sessions' dates under it.
function scoreChart(hist) {
  const w = 520, hh = 120, pad = 18;
  const pts = hist.map((e, i) => [pad + (hist.length === 1 ? 0 : i / (hist.length - 1)) * (w - 2 * pad), hh - pad - (e.score ?? 0) / 100 * (hh - 2 * pad), e]);
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${hh}`); s.setAttribute('class', 'tr-chart');
  s.innerHTML = [25, 50, 75].map(v => `<line x1="${pad}" x2="${w - pad}" y1="${hh - pad - v / 100 * (hh - 2 * pad)}" y2="${hh - pad - v / 100 * (hh - 2 * pad)}" class="grid"/><text x="2" y="${hh - pad - v / 100 * (hh - 2 * pad) + 4}">${v}</text>`).join('')
    + `<polyline points="${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" class="line"/>`
    + pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" class="dot"><title>${p[2].score ?? '—'} · ${fmtDate(p[2].date)}</title></circle>`).join('');
  return s;
}

// ---------- one session ----------
async function openSession(id) {
  let e;
  try { e = await api.trainingSession(id); } catch (err) { return toast(err.message, 'error'); }
  const d = drillDef(e.drill) || { name: e.drill };
  const m = e.metrics || {};
  const tiles = (KEY[e.drill] || KEY.preaim).map(([k, f]) => h('div', { class: 'tr-tile' }, h('small', {}, k), h('b', {}, f(m))));
  const counts = {};
  for (const x of e.deaths || []) for (const t of x.tags) counts[t] = (counts[t] || 0) + 1;
  const why = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const worst = [...(e.engagements || [])].filter(x => x.xhair != null).sort((a, b) => b.xhair - a.xhair).slice(0, 6);
  const body = h('div', { class: 'tr-result' },
    h('div', { class: 'tr-result-head' },
      h('span', { class: 'tr-icon' }, icon(TR_ICONS[e.drill] || TR_ICONS.preaim)),
      h('div', {}, h('h2', {}, e.scenario?.name || d.name), h('div', { class: 'muted' }, `${mapName(e.map)} · ${fmtDate(e.date)} · ${fmtDur(e.seconds || 0)}${e.measured === 'none' && e.drill !== 'procedural' ? ' · no map mesh: crosshair numbers need the map download of the Integrity tab' : ''}`)),
      h('span', { class: 'spacer' }),
      e.mapScore != null ? h('div', { class: 'tr-bigscore' }, h('small', {}, 'Map score'), h('b', {}, e.mapScore)) : null,
      h('div', { class: 'tr-bigscore' }, h('small', {}, 'DemoLab score'), h('b', {}, e.score ?? '—'))),
    h('div', { class: 'tr-tiles' }, ...tiles,
      ['procedural', 'warmup'].includes(e.drill) ? null : h('div', { class: 'tr-tile' }, h('small', {}, 'Kills / deaths'), h('b', {}, `${m.kills ?? 0} / ${m.deaths ?? 0}`)),
      e.reps?.length ? h('div', { class: 'tr-tile', title: `${e.reps.filter(r => r.result === 'died').length} died · ${e.reps.filter(r => r.result === 'time').length} out of time` }, h('small', {}, 'Cleared'), h('b', {}, `${e.reps.filter(r => r.result === 'cleared').length} / ${e.reps.length}`)) : null,
      h('div', { class: 'tr-tile' }, h('small', {}, 'Shots · hits'), h('b', {}, `${m.shots ?? 0} · ${m.hits ?? 0}`))),
    e.parts?.length > 1 ? h('div', { class: 'tr-block' }, h('h4', {}, 'Drills'), barList(e.parts.map(p => ({ label: drillDef(p.drill)?.name || p.drill, note: `${p.done}/${p.reps} reps · ${fmtDur(p.to - p.from)}`, value: p.score ?? '—', frac: (p.score || 0) / 100 })))) : null,
    e.runs?.length ? h('div', { class: 'tr-block' }, h('h4', {}, 'Runs'), barList(e.runs.map((r, i) => ({ label: `Run ${i + 1}`, note: `${r.rooms} rooms · after ${fmtDur(r.at)}`, value: r.score ?? '—', frac: (r.score || 0) / Math.max(1, ...e.runs.map(x => x.score || 0)) })))) : null,
    e.highscore?.length ? h('div', { class: 'tr-block' }, h('h4', {}, 'Map highscores'), kv(e.highscore.map((x, i) => [`${i + 1}. ${x.name}`, String(x.score)]))) : null,
    h('div', { class: 'tr-block' }, h('h4', {}, `Why you died (${(e.deaths || []).length})`),
      why.length ? barList(why.map(([t, n]) => ({ label: TR_DEATH_TAGS[t]?.[0] || t, note: TR_DEATH_TAGS[t]?.[1], value: n, frac: n / (e.deaths.length || 1), fillCls: 'bad' }))) : h('div', { class: 'muted-note' }, 'No deaths.'),
      (e.deaths || []).length ? h('div', { class: 'tr-deaths' }, ...e.deaths.slice(0, 40).map(x => h('div', { class: 'tr-death' },
        h('span', { class: 'muted' }, fmtDur(x.at)), h('b', {}, x.killer || '?'), h('span', {}, `${x.weapon}${x.headshot ? ' · headshot' : ''}`),
        x.xhair != null ? h('span', {}, `crosshair ${x.xhair.toFixed(1)}° off`) : null,
        h('span', { class: 'spacer' }), ...x.tags.map(t => h('span', { class: 'tr-tag', title: TR_DEATH_TAGS[t]?.[1] }, TR_DEATH_TAGS[t]?.[0] || t))))) : null),
    worst.length ? h('div', { class: 'tr-block' }, h('h4', {}, 'Furthest off when a bot came into view'),
      h('div', { class: 'tr-deaths' }, ...worst.map(x => h('div', { class: 'tr-death' }, h('span', { class: 'muted' }, fmtDur(x.at)), h('b', {}, x.target),
        h('span', {}, `${x.xhair.toFixed(1)}° off (${Math.abs(x.pitch).toFixed(1)}° ${x.pitch > 0 ? 'too high' : 'too low'})`), h('span', {}, `${x.dist} units`),
        h('span', { class: 'spacer' }), x.ttk != null ? h('span', {}, `killed in ${x.ttk} ms`) : h('span', { class: 'muted' }, 'not killed'))))) : null,
    h('div', { class: 'tr-actions' },
      h('button', { class: 'btn', onclick: async () => { if (!confirm('Delete this training session?')) return; await trGuard(() => api.trainingDelete(e.id)); closeModal(); loadTraining(true); } }, icon(ICONS.trash), 'Delete'),
      h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => closeModal() }, 'Close')));
  modal(body, { wide: true });
}

// ---------- Overview ----------
// Training on the Overview: last sessions and the trend per drill (nothing until there is a session).
function trainingCards() {
  const tr = state.tr;
  if (!tr.info) { loadTraining(); return []; }
  const hist = tr.info.history || [];
  if (!hist.length) return [];
  const rows = DRILL_ORDER.map(id => [id, historyOf(id)]).filter(([, l]) => l.length);
  return [card('Score per drill', h('div', { class: 'tr-prog' }, ...rows.map(([id, l]) => h('button', { class: 'tr-prog-row', onclick: () => { tr.drill = id; showView('training'); } },
    h('span', { class: 'tr-icon sm' }, icon(TR_ICONS[id])), h('span', { class: 'tr-prog-name' }, drillDef(id).name), sparkline(l.map(e => e.score), 120, 24), h('b', {}, l.at(-1).score ?? '—')))),
  { span: 2, extra: h('button', { class: 'link-btn', onclick: () => { tr.drill = null; showView('training'); } }, 'Training →') }),
  card('Last training', sessionList(hist.slice(-4).reverse()), { span: 2 })];
}