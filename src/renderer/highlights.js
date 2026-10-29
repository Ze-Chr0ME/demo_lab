/* global $, api, state, h, icon, ICONS, toast, spinner, mapName, mapEmblem, fmtDate, fmtDur, clamp, select, openDemo, renderDetail, modal, closeModal, weaponIcon, BUY_COLS, confirmRecord */
'use strict';
// The Highlights page: every highlight of every parsed match in one place, as cards on the right, with
// the filters on the left. Weapons are picked in a copy of the scenarios' buy menu; kill types show the
// marks of CS2's kill feed (lib/themeArt.js killIcon) instead of their names.

state.hl = { items: null, loading: false, error: null, parsed: 0, total: 0, q: '', weapons: new Set(), stars: 0,
  tags: new Set(), maps: new Set(), bannedMaps: new Set(), side: 'all', hsOnly: false, notClipped: false, sort: 'score', limit: 60, queue: new Map() };

const hlRating = hl => clamp(Math.round(hl.score / 25), 1, 5);
const hlTag = tag => tag.type === 'clutch' ? 'Clutch' : tag.label;

// The kill feed's marks: [source, file] per special kill (lib/highlights.js SPECIALS), shown as icons.
const HL_MARKS = {
  headshot: ['kill', 'icon_headshot'], noscope: ['kill', 'noscope'], wallbang: ['kill', 'penetrate'], smoke: ['kill', 'smoke_kill'],
  blind: ['kill', 'blind_kill'], jumpshot: ['kill', 'inairkill'], knife: ['weapon', 'knife'], zeus: ['weapon', 'taser'],
};
const HL_FLAG_KEYS = { 'No-scope': 'noscope', Wallbang: 'wallbang', 'Through smoke': 'smoke', 'While blind': 'blind', Jumpshot: 'jumpshot' };
const killIconUrls = new Map();
// A kill feed mark with its name as tooltip; the name itself when there's no icon (or no CS2 install).
function hlMark(key, label) {
  const art = HL_MARKS[key];
  if (!art) return h('span', { class: 'hl-mark-text' }, label);
  if (art[0] === 'weapon') return h('span', { class: 'hl-mark', title: label }, weaponIcon(art[1]));
  const el = h('span', { class: 'hl-mark', title: label }), img = h('img', { class: 'hl-mark-img', alt: label });
  if (!killIconUrls.has(art[1])) killIconUrls.set(art[1], api.artKillIcon(art[1]).then(f => (f ? api.fileUrl(f) : null)).catch(() => null));
  killIconUrls.get(art[1]).then(u => { if (u) img.src = u; else el.replaceWith(h('span', { class: 'hl-mark-text' }, label)); });
  el.append(img);
  return el;
}
const tagMark = t => hlMark(t.type === 'special' ? t.key : null, t.label);

async function loadHighlights() {
  const st = state.hl;
  if (st.loading) return;
  st.loading = true;
  st.error = null;
  renderHighlights(false);
  try {
    const data = await api.allHighlights();
    st.items = data.items;
    // Refresh queued metadata without losing selections hidden by filters or removed matches.
    for (const item of st.items) if (st.queue.has(hlQueueKey(item))) st.queue.set(hlQueueKey(item), item);
    st.parsed = data.parsed;
    st.total = data.total;
    $('#hlCount').textContent = String(st.items.length);
  } catch (e) { st.error = e.message; }
  finally { st.loading = false; if (state.view === 'highlights') renderHighlights(false); }
}

// Match clipsOf's demo/round/player identity without changing the match currently open.
function hlClipKey(demo, round, player) { return JSON.stringify([demo, round, player]); }
function hlClipKeys() {
  const keys = new Set();
  for (const c of state.clips || []) {
    if (c.kind !== 'clip') continue;
    keys.add(hlClipKey(c.demoId ? `id:${c.demoId}` : `file:${c.demo}`, c.round, c.steamid ? `id:${c.steamid}` : `name:${c.player}`));
  }
  return keys;
}
function hlIsClipped(item, keys) {
  const demos = [`id:${item.demo.id}`, `file:${item.demo.path.split(/[\\/]/).pop()}`];
  const players = [`id:${item.player.steamid}`, `name:${item.player.name}`];
  return demos.some(d => players.some(p => keys.has(hlClipKey(d, item.highlight.round, p))));
}

async function openHighlight(item) {
  const demo = state.demos.find(d => d.id === item.demo.id);
  if (!demo) return toast('This match is no longer in your demo folders. Refresh your matches.', 'error');
  await openDemo(demo, undefined, 'highlights');
  // A user may have navigated to a different match while analysis was running.
  if (state.view !== 'matches' || state.demo?.id !== demo.id || state.tab !== 'highlights') return;
  if (!state.analysis) return;
  if (state.analysis.player?.steamid !== item.player.steamid) {
    await openDemo(demo, item.player.steamid, 'highlights');
    if (state.view !== 'matches' || state.demo?.id !== demo.id || state.tab !== 'highlights' || !state.analysis) return;
  }
  const index = (state.analysis.highlights || []).findIndex(hl => hl.id === item.highlight.id);
  if (index < 0) return toast('This highlight changed. Refresh Highlights to see the current results.');
  state.selected.clear();
  state.selected.add(item.highlight.id);
  renderDetail();
  $('#detail').querySelectorAll('.hl')[index]?.scrollIntoView({ block: 'center' });
}

// The buy menu's guns (scenarios.js BUY_COLS) as weapon filters: fire kills are all 'inferno' in demos.
const HL_BUY_SKIP = new Set(['kevlar', 'assaultsuit', 'defuser', 'flashbang', 'decoy', 'incgrenade']);
const hlBuyCols = () => BUY_COLS.map(([name, , items]) => [name, items.filter(([k]) => !HL_BUY_SKIP.has(k))
  .map(([k, label]) => (k === 'molotov' ? ['inferno', 'Molotov / Incendiary', 'molotov'] : [k, label, k]))]);
const hlCodes = hl => new Set((hl.kills || []).map(k => k.code).filter(Boolean));

function hlWeaponMenu() {
  const st = state.hl, counts = new Map();
  for (const { highlight } of st.items || []) for (const c of hlCodes(highlight)) counts.set(c, (counts.get(c) || 0) + 1);
  const root = h('div', { class: 'buy hl-buy', tabindex: '-1' });
  const done = () => closeModal(() => renderHighlights(false));
  const paint = () => {
    const scrolls = [...root.querySelectorAll('.buy-scroll')].map(el => el.scrollTop);
    root.replaceChildren(
      h('header', { class: 'buy-top' },
        h('span', { class: 'buy-money' }, st.weapons.size ? `${st.weapons.size} picked` : 'Any gun'),
        h('span', { class: 'buy-title' }, 'Highlights ', h('b', {}, 'by weapon')),
        h('span', { class: 'buy-min' }, 'Shows highlights with a kill from any picked weapon')),
      h('div', { class: 'buy-cols' }, ...hlBuyCols().map(([name, items], ci) => h('section', { class: 'buy-col' },
        h('h3', {}, h('span', { class: 'buy-col-n' }, ci + 1), name),
        h('div', { class: 'buy-scroll', role: 'group', 'aria-label': name }, ...items.map(([k, label, art], ri) => {
          const n = counts.get(k) || 0, on = st.weapons.has(k);
          return h('button', { class: 'buy-item' + (on ? ' owned' : '') + (n ? '' : ' off'), 'aria-pressed': String(on), 'aria-disabled': String(!n && !on),
            title: n ? label : `No highlights with the ${label}`,
            onclick: () => { if (!n && !on) return; on ? st.weapons.delete(k) : st.weapons.add(k); st.limit = 60; paint(); } },
          h('span', { class: 'buy-slot' }, ri + 1), h('span', { class: 'buy-name' }, label), weaponIcon(art),
          h('span', { class: 'buy-price' }, n ? `${n} highlight${n > 1 ? 's' : ''}` : '—'));
        }))))),
      h('footer', { class: 'buy-foot' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'buy-btn', disabled: !st.weapons.size, onclick: () => { st.weapons.clear(); paint(); } }, 'Clear'),
        h('button', { class: 'buy-btn go', onclick: done }, h('kbd', {}, 'Enter'), 'Done')));
    root.querySelectorAll('.buy-scroll').forEach((el, i) => { el.scrollTop = scrolls[i] || 0; });
  };
  root.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); } });
  paint();
  modal(root, { wide: true, onClose: () => renderHighlights(false) }).classList.add('buy-modal');
  root.focus();
}

const hlQueueKey = item => JSON.stringify([item.demo.id, item.player.steamid, item.highlight.id]);
function hlToggleQueue(item) {
  const queue = state.hl.queue, key = hlQueueKey(item);
  queue.has(key) ? queue.delete(key) : queue.set(key, item);
  renderHighlights(false);
}

function hlRecordQueue() {
  if (state.recording || state.recordStarting || !state.hl.queue.size) return;
  const queued = [...state.hl.queue.values()];
  const byHighlight = new Map(queued.map(item => [item.highlight, item]));
  const clipped = hlClipKeys();
  confirmRecord(queued.map(item => item.highlight), {
    demoCount: new Set(queued.map(item => item.demo.id)).size,
    isClipped: hl => hlIsClipped(byHighlight.get(hl), clipped),
    itemsFor: hls => hls.map(hl => {
      const item = byHighlight.get(hl);
      return { demoPath: item.demo.path, highlightId: hl.id, steamid: item.player.steamid };
    }),
    onStarted: hls => {
      for (const hl of hls) state.hl.queue.delete(hlQueueKey(byHighlight.get(hl)));
      if (state.view === 'highlights') renderHighlights(false);
    },
  });
}

function hlQueueBar() {
  const queued = [...state.hl.queue.values()];
  const matches = new Set(queued.map(item => item.demo.id)).size;
  return h('div', { class: 'hl-queue' },
    h('details', { class: 'hl-queue-list', open: state.hl.queueOpen,
      ontoggle: e => { state.hl.queueOpen = e.currentTarget.open; } },
      h('summary', {}, `Clip queue · ${queued.length} clip${queued.length === 1 ? '' : 's'}`, queued.length ? ` from ${matches} match${matches === 1 ? '' : 'es'}` : ''),
      queued.length ? h('div', { class: 'hl-queue-items' }, ...queued.map(item => h('div', { class: 'hl-queue-row' },
        mapEmblem(item.map, 'hl-map-emblem'),
        h('span', {}, `${mapName(item.map)} · R${item.highlight.round} · ${item.player.name}`,
          h('small', {}, item.demo.customName || item.demo.name)),
        h('button', { class: 'icon-btn', type: 'button', title: 'Remove from queue', 'aria-label': `Remove ${mapName(item.map)} round ${item.highlight.round} from queue`,
          onclick: () => hlToggleQueue(item) }, icon(ICONS.x))))) : null),
    !queued.length ? h('span', { class: 'hl-queue-hint' }, 'Click highlights to add clips') : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost', type: 'button', disabled: !queued.length,
      onclick: () => { state.hl.queue.clear(); renderHighlights(false); } }, 'Clear queue'),
    h('button', { class: 'btn primary', type: 'button', disabled: !queued.length || !!state.recording || !!state.recordStarting,
      onclick: hlRecordQueue }, icon(ICONS.rec), `Record queue (${queued.length})`));
}

function hlCard(item) {
  const hl = item.highlight, kills = hl.kills || [], rating = hlRating(hl), queued = state.hl.queue.has(hlQueueKey(item));
  const words = hl.tags.filter(t => t.type !== 'special' || !HL_MARKS[t.key]), marks = hl.tags.filter(t => t.type === 'special' && HL_MARKS[t.key]);
  return h('article', { class: `dcard hl-card ${queued ? 'queued' : ''}` },
    h('button', { class: 'hl-card-pick', type: 'button', title: queued ? 'Remove from clip queue' : 'Add to clip queue',
      'aria-pressed': String(queued), 'aria-label': `${queued ? 'Remove from' : 'Add to'} clip queue: ${mapName(item.map)}, round ${hl.round}, ${item.player.name}`,
      onclick: () => hlToggleQueue(item) },
    h('div', { class: 'hl-card-head' }, mapEmblem(item.map, 'hl-card-emblem'),
      h('div', { class: 'hl-card-when' },
        h('div', { class: 'hl-card-map' }, h('b', {}, mapName(item.map)), h('span', { class: `side-${hl.side}` }, hl.side), h('span', {}, `Round ${hl.round}`)),
        h('div', { class: 'hl-card-date' }, fmtDate(item.demo.date)),
        h('div', { class: 'hl-card-file' }, item.demo.customName || item.demo.name)),
      h('span', { class: 'hl-card-stars', title: `${rating} star${rating > 1 ? 's' : ''}` }, '★'.repeat(rating))),
    h('div', { class: 'hl-card-tags' }, ...words.map(t => h('b', {}, t.label)), ...marks.map(tagMark)),
    h('div', { class: 'hl-feed' }, ...kills.map(k => h('div', { class: 'hl-feed-row' },
      h('span', { class: 'hl-feed-gun', title: k.weapon }, weaponIcon(k.code || 'knife')),
      ...(k.flags || []).filter(f => HL_FLAG_KEYS[f]).map(f => hlMark(HL_FLAG_KEYS[f], f)),
      k.headshot ? hlMark('headshot', 'Headshot') : null,
      h('span', { class: `hl-feed-victim side-${hl.side === 'T' ? 'CT' : 'T'}` }, k.victim)))),
    h('div', { class: 'hl-card-stats' }, `${kills.length} kill${kills.length === 1 ? '' : 's'} · ${fmtDur(hl.duration)}`)),
    h('div', { class: 'hl-card-foot' },
      h('button', { class: `hl-queue-status ${queued ? 'on' : ''}`, type: 'button', 'aria-pressed': String(queued),
        onclick: () => hlToggleQueue(item) }, queued ? icon(ICONS.check) : icon(ICONS.rec), queued ? 'Queued' : 'Add to queue'),
      h('button', { class: 'hl-open', type: 'button', onclick: e => { e.stopPropagation(); openHighlight(item); } }, 'Match Page →')));
}

function renderHighlights(check = true) {
  const st = state.hl, view = $('#view-highlights');
  // Each visit reads the list again (new demos, player or detection rules); internal renders never fetch.
  if (check && !st.loading) { loadHighlights(); return; }
  const change = patch => { Object.assign(st, patch); st.limit = 60; renderHighlights(false); };
  const all = st.items || [], tags = new Map(), mapCounts = new Map();
  for (const item of all) {
    for (const t of new Map(item.highlight.tags.map(t => [hlTag(t), t])).values()) {
      const e = tags.get(hlTag(t)) || tags.set(hlTag(t), { tag: t, n: 0 }).get(hlTag(t));
      e.n++;
    }
    mapCounts.set(item.map, (mapCounts.get(item.map) || 0) + 1);
  }
  const clipped = st.notClipped ? hlClipKeys() : null, q = st.q.trim().toLowerCase();
  let items = all.filter(item => {
    const hl = item.highlight, kills = hl.kills || [];
    if (st.bannedMaps.has(item.map) || st.maps.size && !st.maps.has(item.map)) return false;
    if (st.side !== 'all' && st.side !== hl.side) return false;
    if (st.weapons.size && ![...hlCodes(hl)].some(c => st.weapons.has(c))) return false;
    if (st.tags.size && !hl.tags.some(t => st.tags.has(hlTag(t)))) return false;
    if (st.hsOnly && (!kills.length || !kills.every(k => k.headshot))) return false;
    if (clipped && hlIsClipped(item, clipped)) return false;
    return !q || [item.demo.name, item.demo.customName, item.map, mapName(item.map), hl.title,
      ...(hl.weapons || []), ...hl.tags.map(t => t.label), ...kills.flatMap(k => [k.victim, k.weapon])].join(' ').toLowerCase().includes(q);
  });
  const counts = [0, 0, 0, 0, 0, 0];
  for (const item of items) counts[hlRating(item.highlight)]++;
  if (st.stars) items = items.filter(item => hlRating(item.highlight) === st.stars);
  items.sort((a, b) => st.sort === 'date' ? new Date(b.demo.date) - new Date(a.demo.date) || b.highlight.score - a.highlight.score
    : b.highlight.score - a.highlight.score || new Date(b.demo.date) - new Date(a.demo.date));

  const group = (label, ...body) => h('section', { class: 'hl-group' }, h('h4', {}, label), ...body);
  const search = h('input', { id: 'hlSearch', type: 'search', value: st.q, placeholder: 'Victim, weapon, map, match…',
    'aria-label': 'Search highlights', oninput: e => {
      const start = e.target.selectionStart, end = e.target.selectionEnd;
      change({ q: e.target.value });
      const input = $('#hlSearch'); input.focus(); input.setSelectionRange(start, end);
    } });
  const picker = h('div', { class: `clip-stars-pick ${st.stars ? 'set' : ''}`, role: 'group', 'aria-label': 'Exact star rating' },
    ...[5, 4, 3, 2, 1].map(n => h('button', { type: 'button', class: n <= st.stars ? 'on' : '', 'aria-pressed': String(st.stars === n),
      title: `${n}-star highlights (${counts[n]}). Click again to clear.`, 'aria-label': `${n} stars, ${counts[n]} highlights`,
      onclick: () => change({ stars: st.stars === n ? 0 : n }) }, '★', h('small', {}, counts[n]))));
  const picked = [...st.weapons];
  const weaponsBtn = h('button', { class: `hl-weapons-btn ${picked.length ? 'set' : ''}`, type: 'button', onclick: hlWeaponMenu },
    picked.length ? h('span', { class: 'hl-weapons-picked' }, ...picked.slice(0, 4).map(c => weaponIcon(c === 'inferno' ? 'molotov' : c)),
      picked.length > 4 ? h('small', {}, `+${picked.length - 4}`) : null) : h('span', {}, 'Any weapon'),
    h('span', { class: 'hl-weapons-go' }, 'Buy menu →'));
  const tagChips = h('div', { class: 'hl-chips', title: 'Shows highlights with any picked kill type' },
    ...[...tags.values()].sort((a, b) => b.n - a.n).map(({ tag, n }) => {
      const key = hlTag(tag), on = st.tags.has(key);
      return h('button', { class: `hl-chip ${on ? 'on' : ''}`, type: 'button', 'aria-pressed': String(on), title: key,
        onclick: () => { on ? st.tags.delete(key) : st.tags.add(key); change({}); } },
      tag.type === 'clutch' ? h('span', { class: 'hl-mark-text' }, 'Clutch') : tagMark(tag), h('small', {}, n));
    }));
  const maps = [...mapCounts].sort((a, b) => b[1] - a[1] || mapName(a[0]).localeCompare(mapName(b[0])));
  const cycleMap = m => {
    if (st.maps.has(m)) { st.maps.delete(m); st.bannedMaps.add(m); }
    else if (st.bannedMaps.has(m)) st.bannedMaps.delete(m);
    else st.maps.add(m);
    change({});
  };
  const mapList = h('div', { class: 'hl-maps' },
    h('button', { class: `hl-map ${!st.maps.size && !st.bannedMaps.size ? 'on' : ''}`, type: 'button',
      onclick: () => change({ maps: new Set(), bannedMaps: new Set() }) }, h('span', { class: 'hl-map-all' }), 'All maps', h('small', {}, all.length)),
    ...maps.map(([m, n]) => {
      const selected = st.maps.has(m), banned = st.bannedMaps.has(m);
      const status = selected ? 'Selected' : banned ? 'Banned' : 'Any';
      return h('button', { class: `hl-map ${selected ? 'on' : banned ? 'banned' : ''}`, type: 'button',
        'aria-label': `${mapName(m)}: ${status}. Click to ${selected ? 'ban' : banned ? 'reset' : 'select'}.`,
        title: `${status} · Click to ${selected ? 'ban' : banned ? 'reset' : 'select'}`, onclick: () => cycleMap(m) },
      mapEmblem(m, 'hl-map-emblem'), h('span', { class: 'hl-map-name' }, mapName(m)),
      selected || banned ? h('span', { class: 'hl-map-status', 'aria-hidden': 'true' }, selected ? '✓' : '⊘') : null, h('small', {}, n));
    }));
  const sides = h('div', { class: 'hl-seg' }, ...[['all', 'Both'], ['T', 'T'], ['CT', 'CT']].map(([v, l]) =>
    h('button', { class: `${st.side === v ? 'on' : ''} ${v !== 'all' ? `side-${v}` : ''}`, type: 'button', onclick: () => change({ side: v }) }, l)));
  const toggle = (key, label, mark) => h('button', { class: `hl-chip hl-icon-toggle ${st[key] ? 'on' : ''}`, type: 'button',
    'aria-label': label, 'aria-pressed': String(st[key]), title: label,
    onclick: () => change({ [key]: !st[key] }) }, mark);
  const active = q || st.weapons.size || st.tags.size || st.stars || st.maps.size || st.bannedMaps.size || st.side !== 'all' || st.hsOnly || st.notClipped;
  const side = h('aside', { class: 'hl-side' },
    search,
    group('Rating', picker),
    group('Weapon', weaponsBtn),
    tags.size ? group('Kill type', tagChips) : null,
    group('Side', sides),
    group('Kills', h('div', { class: 'hl-chips' },
      toggle('hsOnly', 'Headshots only', hlMark('headshot', 'Headshots only')),
      toggle('notClipped', 'Not clipped yet', icon(ICONS.film + '<path d="M2 2l20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 'aria-hidden="true"')))),
    maps.length ? group('Map', mapList) : null,
    active ? h('button', { class: 'link-btn hl-clear', onclick: () => change({ q: '', weapons: new Set(), stars: 0, tags: new Set(), maps: new Set(), bannedMaps: new Set(), side: 'all', hsOnly: false, notClipped: false }) }, 'Clear filters') : null);

  const body = st.loading && !st.items ? h('div', { class: 'empty' }, spinner(28), h('h2', {}, 'Loading highlights…'))
    : !all.length ? h('div', { class: 'empty' }, h('h2', {}, st.parsed < st.total ? 'Matches are still being parsed' : 'No highlights yet'),
      h('div', {}, st.parsed < st.total ? 'Refresh as parsing progresses to see new highlights.' : 'Highlights from parsed matches appear here. Check your match folders and highlight rules in Settings.'))
      : !items.length ? h('div', { class: 'empty' }, h('h2', {}, 'No highlights match'), h('div', {}, 'Try clearing a filter or searching for another victim, weapon or map.'))
        : h('div', { class: 'hl-grid' }, ...items.slice(0, st.limit).map(hlCard));
  view.replaceChildren(h('div', { class: 'page hl-page' }, side,
    h('div', { class: 'hl-main' },
      h('div', { class: 'page-head' }, h('h2', {}, 'Highlights'), h('span', { class: 'hl-summary', 'aria-live': 'polite' }, `${items.length} of ${all.length}`),
        h('span', { class: 'spacer' }), h('label', { class: 'hl-select' }, 'Sort', select(st.sort, [['score', 'Best rated'], ['date', 'Newest match']], sort => change({ sort }))),
        h('button', { class: 'btn ghost', disabled: st.loading, onclick: () => loadHighlights() }, st.loading ? spinner(14) : null, 'Refresh')),
      st.parsed < st.total ? h('div', { class: 'hl-progress', role: 'status' }, `${st.parsed} of ${st.total} matches parsed · Refresh to include newly parsed matches.`) : null,
      st.error ? h('div', { class: 'hl-error', role: 'alert' }, `Could not load highlights: ${st.error}`, h('button', { class: 'link-btn', onclick: () => loadHighlights() }, 'Try again')) : null,
      hlQueueBar(),
      body,
      items.length > st.limit ? h('button', { class: 'link-btn hl-more', onclick: () => { st.limit += 60; renderHighlights(false); } }, `Show more (${items.length - st.limit} remaining)`) : null)));
}
