/* global OverviewLayout, state, h, icon, toggle, api, toast, renderOverview, $ */
// Overview editor: Customize turns the Overview itself into the editor. Cards, stat tiles and whole sections are
// dragged into place, hidden with their eye button and brought back from the Hidden tray. Nothing is saved until Save.
const OverviewEditor = (() => {
  const HIDE = '<path d="M3 3l18 18M10.6 5.1A9.9 9.9 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.3 8 2.7 10.2 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5.1-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  const PLUS = '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
  let dragged = null;

  const sectionOf = id => OverviewLayout.sections.find(s => s.id === id);
  const labelOf = (kind, id, section) => (kind === 'section' ? sectionOf(id).label
    : kind === 'stat' ? OverviewLayout.stats.find(s => s.id === id).label
    : kind === 'ratingStat' ? OverviewLayout.ratingStats.find(s => s.id === id).label
      : sectionOf(section).modules.find(m => m.id === id).label);

  function open() {
    if (!state.ovEdit) state.ovEdit = { draft: OverviewLayout.normalize(state.settings?.overviewLayout), saving: false, note: '' };
    renderOverview();
  }
  function cancel() {
    if (state.ovEdit?.saving) return;
    state.ovEdit = null;
    renderOverview();
    $('#meCard')?.focus();
  }
  async function save() {
    const ed = state.ovEdit;
    if (!ed || ed.saving) return;
    ed.saving = true;
    ed.note = 'Saving layout…';
    renderOverview();
    try {
      state.settings = await api.setSettings({ overviewLayout: OverviewLayout.normalize(ed.draft) });
      state.ovEdit = null;
      renderOverview();
      $('#meCard')?.focus();
      toast('Overview layout saved', 'ok');
    } catch (e) {
      ed.saving = false;
      ed.note = `Could not save layout: ${e.message}`;
      renderOverview();
    }
  }
  function reset() {
    const ed = state.ovEdit;
    if (!ed || ed.saving) return;
    ed.draft = OverviewLayout.normalize(null);
    ed.note = 'Default layout restored. Save to keep it.';
    renderOverview();
  }
  // A refresh while dragging would replace the dragged card and cancel the drag: it runs after the drop instead.
  let resizing = false;
  const paused = () => !!dragged || resizing;
  const SPAN_NAMES = { 12: 'Full width', 9: 'Three quarters', 8: 'Two thirds', 6: 'Half', 4: 'One third', 3: 'Quarter' };
  const spanName = span => SPAN_NAMES[span] || `${Math.round(span / 12 * 100)}%`;

  // The shown entries take the new order; hidden ones keep their slots, so they come back where they were.
  function reorder(list, ids) {
    const byId = new Map(list.map(e => [e.id, e])), queue = ids.filter(id => byId.has(id) && !byId.get(id).hidden);
    const moved = new Set(queue);
    list.splice(0, list.length, ...list.map(e => (moved.has(e.id) ? byId.get(queue.shift()) : e)));
  }
  function step(list, id, delta) {
    const ids = list.filter(e => !e.hidden).map(e => e.id), i = ids.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(list, ids);
    return true;
  }
  function setHidden(entry, hidden) {
    entry.hidden = hidden;
    if (state.ovEdit) state.ovEdit.note = '';
    renderOverview();
  }

  // Live sorting inside one container: the dragged item moves as the pointer crosses its neighbours, which slide aside.
  function sortable(container, list, onmove) {
    const items = () => [...container.children].filter(c => c.dataset.ovId);
    let settleUntil = 0;
    container.addEventListener('dragstart', e => {
      if (resizing) { e.preventDefault(); return; }
      if (e.target.parentElement !== container || !e.target.dataset?.ovId) return;
      e.stopPropagation();
      dragged = e.target;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragged.dataset.ovId);
      container.classList.add('ov-sorting');
      setTimeout(() => dragged?.classList.add('ov-dragging')); // after the browser has captured the drag image
    });
    container.addEventListener('dragover', e => {
      if (!dragged || dragged.parentElement !== container) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      let over = e.target;
      while (over && over.parentElement !== container) over = over.parentElement;
      if (!over || over === dragged || !over.dataset.ovId || performance.now() < settleUntil) return;
      const all = items(), after = all.indexOf(dragged) < all.indexOf(over);
      // Move only once the pointer would still be on the dragged item afterwards. Otherwise a small item swapped
      // with a large one lands away from the pointer, the large one ends up under it again and they bounce back and forth.
      const r = over.getBoundingClientRect(), d = dragged.getBoundingClientRect();
      const sameRow = Math.abs(r.top - d.top) < Math.min(r.height, d.height) / 2;
      const fits = sameRow ? (after ? e.clientX > r.right - d.width : e.clientX < r.left + d.width)
        : (after ? e.clientY > r.bottom - d.height : e.clientY < r.top + d.height);
      if (!fits) return;
      const from = new Map(all.map(n => [n, n.getBoundingClientRect()]));
      container.insertBefore(dragged, after ? over.nextSibling : over);
      settleUntil = performance.now() + 140; // neighbours are mid-slide: their boxes are not where they will end up
      onmove?.(items().map(n => n.dataset.ovId));
      for (const n of all) {
        if (n === dragged) continue;
        const a = from.get(n), b = n.getBoundingClientRect();
        if (a.left !== b.left || a.top !== b.top) {
          n.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        }
      }
    });
    container.addEventListener('drop', e => {
      if (dragged?.parentElement !== container) return;
      e.preventDefault();
      e.stopPropagation();
    });
    container.addEventListener('dragend', e => {
      if (!dragged || e.target !== dragged || dragged.parentElement !== container) return;
      e.stopPropagation();
      container.classList.remove('ov-sorting');
      dragged.classList.remove('ov-dragging');
      const ids = items().map(n => n.dataset.ovId);
      dragged = null;
      // Escape or a drop outside the group puts everything back where it was.
      if (e.dataTransfer.dropEffect !== 'none') reorder(list, ids);
      renderOverview();
    });
    return container;
  }

  // Cards, tiles and sections can be dragged or focused and moved with arrow keys; the eye button hides them.
  function editable(node, kind, entry, list, section, extra = null) {
    const label = labelOf(kind, entry.id, section), focus = `${kind}-${section || ''}-${entry.id}`;
    node.classList.add('ov-editable', `ov-editable-${kind}`);
    node.draggable = true;
    node.dataset.ovId = entry.id;
    node.tabIndex = 0;
    node.dataset.ovFocus = focus;
    node.setAttribute('aria-label', `${label}. Drag or use arrow keys to move.`);
    node.addEventListener('keydown', e => {
      if (e.target !== node) return;
      const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
      if (!delta) return;
      e.preventDefault();
      e.stopPropagation();
      if (!step(list, entry.id, delta)) return;
      renderOverview();
      document.querySelector(`[data-ov-focus="${focus}"]`)?.focus();
    });
    if (kind !== 'ratingStat') {
      const hide = h('button', { class: 'ov-hide', type: 'button', title: `Hide ${label}`, 'aria-label': `Hide ${label}`,
        onclick: () => setHidden(entry, true) }, icon(HIDE));
      node.prepend(h('div', { class: 'ov-edit-chrome' }, kind === 'section' ? h('span', { class: 'ov-edit-name' }, label) : null, hide, extra));
    }
    if (kind === 'module') node.append(...['x', 'y', 'xy'].map(axis => resizer(node, entry, label, axis, { list, section })));
    if (kind === 'ratingStat') node.append(...['x', 'y', 'xy'].map(axis => resizer(node, entry, label, axis,
      { list, section: 'rating-breakdown', fixedGrid: true, defaultSpan: 6 })));
    return node;
  }
  // "+" chips for the hidden modules of a section (beside its name) or the hidden stat tiles (beside Stats overview).
  function chips(kind, list, sectionId) {
    const hidden = list.filter(e => e.hidden), busy = state.ovEdit?.saving;
    if (!hidden.length) return null;
    return h('span', { class: 'ov-chips', role: 'group', 'aria-label': kind === 'ratingStat' ? 'Hidden rating breakdown stats' : kind === 'stat' ? 'Hidden stats' : `Hidden ${sectionOf(sectionId).label} modules` },
      ...hidden.map(e => {
        const label = labelOf(kind, e.id, sectionId);
        return h('button', { class: 'ov-tray-chip', type: 'button', disabled: busy, draggable: 'false', title: `Add ${label}`,
          onclick: () => setHidden(e, false) }, icon(PLUS), label);
      }));
  }
  function hideRatingStat(entry) {
    const label = labelOf('ratingStat', entry.id);
    return h('button', { class: 'ov-breakdown-hide', type: 'button', draggable: 'false', disabled: state.ovEdit?.saving,
      title: `Remove ${label} from breakdown`, 'aria-label': `Remove ${label} from breakdown`,
      onclick: () => setHidden(entry, true) }, icon(HIDE));
  }
  function section(entry, content) {
    const label = sectionOf(entry.id).label;
    const node = editable(h('div', { class: `ov-edit-section ov-slot${entry.span === 12 ? ' ov-full' : ''}`,
      style: { '--span': entry.span, '--h': entry.height ? `${entry.height}px` : null } },
    content || h('div', { class: 'ov-edit-empty' }, `Every ${label} module is hidden. Add them back with the + buttons above.`)),
    'section', entry, state.ovEdit.draft.sections, null, chips('module', state.ovEdit.draft.modules[entry.id], entry.id));
    node.append(...['x', 'y', 'xy'].map(axis => resizer(node, entry, label, axis)));
    return node;
  }
  const sizeName = (axis, span, height) => [axis !== 'y' ? spanName(span) : null,
    axis !== 'x' ? (height ? `${height} px tall` : 'Auto height') : null].filter(Boolean).join(' · ');
  // An item's natural height: what its content needs, ignoring its saved height and taller neighbours in its row.
  function naturalHeight(node) {
    const { minHeight, alignSelf } = node.style;
    node.style.minHeight = '0px';
    node.style.alignSelf = 'start';
    const height = node.getBoundingClientRect().height;
    node.style.minHeight = minHeight;
    node.style.alignSelf = alignSelf;
    return height;
  }
  // A section's modules switch to a 12-column grid on their first width change, starting from the widths they have now.
  function moduleGrid(container, minSpan) {
    const cards = [...container.children].filter(c => c.dataset.ovId);
    if (!container.classList.contains('ov-mgrid')) {
      const box = container.getBoundingClientRect(), gap = parseFloat(getComputedStyle(container).columnGap) || 0;
      const column = (box.width + gap) / 12;
      for (const card of cards) {
        const span = Math.max(minSpan, Math.min(12, Math.round((card.getBoundingClientRect().width + gap) / column)));
        card.style.setProperty('--mspan', span);
      }
      container.classList.add('ov-mgrid');
    }
    return cards;
  }
  const keepSpans = (cards, list) => {
    for (const card of cards) {
      const entry = list.find(e => e.id === card.dataset.ovId);
      if (entry) entry.span = +card.style.getPropertyValue('--mspan') || entry.span;
    }
  };
  // Edge handles on sections and modules: the right edge sets the width in twelfths (snapping to columns), the bottom
  // edge the height (10 px steps, never below the content), the corner both. Previewed live and kept on release.
  function resizer(node, entry, label, axis, mod = null) {
    const spanVar = mod ? '--mspan' : '--span', heightVar = mod?.fixedGrid ? '--rh' : mod ? '--mh' : '--h';
    const minSpan = mod ? OverviewLayout.MIN_MODULE_SPAN : OverviewLayout.MIN_SPAN;
    const clampSpan = span => Math.max(minSpan, Math.min(12, span));
    const defaultSpan = mod?.defaultSpan || 12;
    const shownSpan = () => entry.span || (mod ? +node.style.getPropertyValue('--mspan') || defaultSpan : defaultSpan);
    const badge = h('span', { class: 'ov-resize-badge' }, sizeName(axis, shownSpan() || 12, entry.height));
    const focus = `resize-${axis}-${mod ? `${mod.section}-` : ''}${entry.id}`;
    const container = () => node.parentElement;
    const prepareGrid = () => mod.fixedGrid ? [...container().children].filter(c => c.dataset.ovId) : moduleGrid(container(), minSpan);
    const commit = () => {
      renderOverview();
      document.querySelector(`[data-ov-focus="${focus}"]`)?.focus();
    };
    const what = { x: 'width', y: 'height', xy: 'size' }[axis];
    const handle = h('button', { class: `ov-resize ov-resize-${axis}`, type: 'button', draggable: 'false', 'data-ov-focus': focus,
      'aria-label': `Resize ${label} ${what}`,
      title: `Drag to change the ${what}. Arrow keys work too; double-click to reset it${mod && !mod.fixedGrid && axis !== 'y' ? ' (widths reset for the whole section)' : ''}.`,
      onmousedown: e => e.preventDefault(), // keeps the item itself from starting a move
      ondblclick: () => {
        if (axis !== 'y') { if (mod?.fixedGrid) entry.span = null; else if (mod) for (const e of mod.list) e.span = null; else entry.span = 12; }
        if (axis !== 'x') entry.height = null;
        commit();
      },
      onkeydown: e => {
        const dx = axis !== 'y' ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0 : 0;
        const dy = axis !== 'x' ? { ArrowUp: -20, ArrowDown: 20 }[e.key] || 0 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        if (dx) {
          if (mod) keepSpans(prepareGrid(), mod.list);
          entry.span = clampSpan((entry.span || defaultSpan) + dx);
        }
        if (dy) {
          const natural = naturalHeight(node), start = entry.height || Math.round(natural / 10) * 10;
          entry.height = start + dy <= natural + 4 ? null : Math.min(OverviewLayout.MAX_HEIGHT, start + dy);
        }
        commit();
      },
      onpointerdown: e => {
        if (e.button !== 0 || state.ovEdit?.saving) return;
        e.preventDefault();
        e.stopPropagation();
        const grid = container(), cards = mod && axis !== 'y' ? prepareGrid() : null;
        const box = grid.getBoundingClientRect(), gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
        const rect = node.getBoundingClientRect(), column = (box.width + gap) / 12;
        const natural = naturalHeight(node), startY = e.clientY, startHeight = entry.height ? Math.max(entry.height, rect.height) : rect.height;
        let span = +node.style.getPropertyValue(spanVar) || entry.span || defaultSpan, height = entry.height, done = false;
        resizing = true;
        node.classList.add('ov-resizing', `ov-resizing-${axis}`);
        try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        const move = ev => {
          if (axis !== 'y') span = clampSpan(Math.round((ev.clientX - rect.left + gap) / column));
          if (axis !== 'x') {
            const want = Math.round((startHeight + ev.clientY - startY) / 10) * 10;
            height = want <= natural + 8 ? null : Math.min(OverviewLayout.MAX_HEIGHT, want); // snaps back to content height
          }
          if (axis !== 'y') node.style.setProperty(spanVar, span);
          if (height) node.style.setProperty(heightVar, `${height}px`); else node.style.removeProperty(heightVar);
          badge.textContent = sizeName(axis, span, height);
        };
        const end = () => {
          if (done) return;
          done = true;
          resizing = false;
          handle.removeEventListener('pointermove', move);
          node.classList.remove('ov-resizing', `ov-resizing-${axis}`);
          if (cards) keepSpans(cards, mod.list);
          if (axis !== 'y') entry.span = span;
          entry.height = height;
          renderOverview();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
      } }, badge);
    return handle;
  }

  function bar() {
    const ed = state.ovEdit, d = ed.draft, busy = ed.saving;
    const chip = (entry, label, title) => h('button', { class: 'ov-tray-chip', type: 'button', disabled: busy, title: title || `Show ${label} again`,
      onclick: () => setHidden(entry, false) }, icon(PLUS), label);
    const hidden = d.sections.filter(e => e.hidden).map(e => {
      const { label, modules } = sectionOf(e.id), shown = d.modules[e.id].filter(m => !m.hidden).length;
      return h('button', { class: 'ov-tray-chip', type: 'button', disabled: busy,
        title: `Add the ${label} section (${shown} of ${modules.length} modules shown, more with its + buttons)`,
        onclick: () => setHidden(e, false) }, icon(PLUS), label);
    });
    const density = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Spacing' },
      ...[['compact', 'Compact'], ['comfortable', 'Comfortable']].map(([value, label]) => h('button', {
        type: 'button', class: d.density === value ? 'on' : '', 'aria-pressed': String(d.density === value), disabled: busy,
        onclick: () => { d.density = value; renderOverview(); } }, label)));
    return h('div', { class: 'ov-editbar', role: 'region', 'aria-label': 'Overview editor', inert: busy },
      h('div', { class: 'ov-editbar-main' },
        h('div', { class: 'ov-editbar-title' }, h('b', {}, 'Editing your Overview'),
          h('span', { class: 'hint' }, 'Drag cards, tiles and sections to move them, and their right or bottom edges to resize them. The eye hides, + adds.')),
        h('span', { class: 'spacer' }),
        density,
        toggle('Histograms', d.histograms, v => { d.histograms = v; renderOverview(); }, 'Show the distribution chart in each stat tile'),
        h('button', { class: 'link-btn', type: 'button', onclick: reset }, 'Reset to default'),
        h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: save }, busy ? 'Saving…' : 'Save layout')),
      h('div', { class: 'ov-tray' }, h('span', { class: 'ov-tray-k' }, 'Hidden'),
        hidden.length ? h('div', { class: 'ov-tray-group', role: 'group', 'aria-label': 'Hidden sections' }, ...hidden)
          : h('span', { class: 'hint' }, 'Every section is shown. Sections you hide wait here.')),
      ed.note ? h('div', { class: `ov-editbar-note ${/^Could not/.test(ed.note) ? 'bad' : ''}`, role: 'status', 'aria-live': 'polite' }, ed.note) : null);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.defaultPrevented || !state.ovEdit || dragged) return;
      if (!$('#view-overview')?.classList.contains('active') || document.querySelector('.modal')) return;
      cancel();
    });
  }
  return { open, cancel, save, reset, paused, reorder, step, sortable, editable, chips, hideRatingStat, section, bar };
})();
const customizeOverview = () => OverviewEditor.open();
if (typeof module !== 'undefined' && module.exports) module.exports = OverviewEditor;
