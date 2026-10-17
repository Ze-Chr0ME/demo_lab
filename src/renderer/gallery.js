// ---------- "My highlights" page ----------
// Clips published here get a web copy uploaded to catbox.moe and show on a page anyone can open from one
// link (docs/share on GitHub Pages; the link carries the whole gallery, see lib/gallery.js).
// Hooks in app.js: galleryBadge / galleryAction in clipCard, galleryHeadButton in renderClips,
// galleryPlayButton in playClip.
const GLOBE_ICON = '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5s1.2-6.1 3.8-8.5z" fill="none" stroke="currentColor" stroke-width="1.6"/>';
const LINK_ICON = '<path d="M10 14a4.5 4.5 0 0 0 6.4.2l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4-.2l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
const UP_ICON = '<path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
const STAR_ICON = '<path d="M12 3.6l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z" fill="currentColor"/>';
const DOWN_ICON = '<path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';

// What the page looks like (lib/gallery.js cleanLook): the app's theme, and the Overview's numbers over
// all your matches, small enough for the link (no per-match values except the last 20 ratings).
async function galleryLook() {
  const t = themeById(state.settings?.theme || 'demolab');
  const logoLook = t.scene === 'team' && t.logo ? await Scene.teamLook(t.logo).catch(() => 'neon') : undefined;
  return {
    theme: { base: t.base, accent: t.accent, data: t.data || '', pattern: t.pattern || '', scene: t.scene, logo: t.logo || '', shot: t.shot || '', logoLook },
    stats: galleryStats(),
  };
}
function galleryStats() {
  const list = [...(state.profile?.matches || [])].sort((a, b) => b.date - a.date);
  if (!list.length) return undefined;
  const t = aggregate(list), l10 = list.length > 10 ? aggregate(list.slice(0, 10)) : null;
  const r = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const rated = list.filter(m => m.rating != null).slice(0, 20).reverse();
  return {
    n: t.played, r: t.rounds, rt: r(t.rating), r10: l10 ? r(l10.rating) : undefined,
    w: t.won, l: t.lost, d: t.tied, k: t.kills, de: t.deaths, kd: r(t.kd), adr: r(t.adr, 1),
    kast: r(per(100 * t.kastRounds, t.rounds), 1), hs: r(per(100 * t.hs, t.kills), 1),
    ti: TILES.map(d => r(d.t(t), d.d)), t10: l10 ? TILES.map(d => r(d.t(l10), d.d)) : undefined,
    // each tile's histogram as in the app (histogram()): its range and 16 bar heights from 0 to 9
    hg: TILES.map(d => {
      const vals = list.map(d.m).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
      if (vals.length < 3) return null;
      const q = f => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
      let lo = q(0.03), hi = q(0.97);
      if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
      const bins = new Array(16).fill(0);
      for (const v of vals) bins[clamp(Math.floor((v - lo) / (hi - lo) * 16), 0, 15)]++;
      const max = Math.max(...bins);
      return [r(lo, 3), r(hi, 3), bins.map(b => (b ? Math.max(1, Math.round(9 * b / max)) : 0)).join('')];
    }),
    f: list.slice(0, 10).map(m => m.result).join(''),
    tr: rated.map(m => Math.round(m.rating * 100)), tw: rated.map(m => m.result).join(''),
    mp: Object.values(t.maps).sort((a, b) => b.played - a.played).slice(0, 6).map(m => [m.map, m.played, m.won]),
    mk: [2, 3, 4, 5].map(n => t.multi[n]), tk: t.trades, fa: t.flashAssists,
    cl: [1, 2, 3, 4, 5].map(n => t.clutch[n]),
    op: [t.fk, t.fd, t.side.T.fk, t.side.T.fd, t.side.CT.fk, t.side.CT.fd],
  };
}

async function loadGallery() {
  const look = await galleryLook();
  state.gallery = await guard(() => api.gallery(look)) || state.gallery || { items: [] };
  // Something changed (a clip, the theme, the Steam picture, the stats): upload what the page needs and
  // its data, which gives the short link. At most once a minute, so a failing upload doesn't loop.
  if (state.gallery.missing && !loadGallery.syncing && Date.now() - (loadGallery.last || 0) > 60e3) {
    loadGallery.last = Date.now();
    loadGallery.syncing = api.gallerySync(look).then(g => {
      state.gallery = g;
      if (!$('#overlay').classList.contains('hidden') && $('#overlay .gal-link input')) galleryDialog();
    }).catch(() => {}).finally(() => { loadGallery.syncing = null; });
  }
  return state.gallery;
}
const galleryHas = c => !!state.gallery?.items.some(x => x.id === c.id);

function galleryBadge(c) {
  return galleryHas(c) ? h('div', { class: 'pub', title: 'On your highlights page' }, icon(GLOBE_ICON), 'PUBLIC') : null;
}
function galleryAction(c) {
  const on = galleryHas(c);
  return h('button', { class: on ? 'on' : '', title: on ? 'On your highlights page: open it' : 'Publish to your highlights page (a link anyone can open)',
    onclick: e => { e.stopPropagation(); on ? galleryDialog() : publishDialog(c); } }, icon(GLOBE_ICON));
}
function galleryPlayButton(c) {
  return galleryHas(c)
    ? h('button', { class: 'btn', onclick: () => galleryDialog() }, icon(GLOBE_ICON), 'On your page')
    : h('button', { class: 'btn', onclick: () => publishDialog(c) }, icon(GLOBE_ICON), 'Publish');
}
function galleryHeadButton() {
  if (!state.gallery) loadGallery().then(() => { if (state.view === 'clips') renderClips(); });
  const n = state.gallery?.items.length || 0;
  return h('button', { class: 'btn', title: 'Your highlights page: one link with your best clips', onclick: () => galleryDialog() },
    icon(GLOBE_ICON), 'My highlights page', n ? h('span', { class: 'gal-count' }, n) : null);
}

async function copyGalleryLink(link) {
  try { await navigator.clipboard.writeText(link); toast('Link copied. Paste it anywhere: Discord, Steam, …', 'ok'); } catch (e) { toast(e.message, 'error'); }
}

function publishDialog(c) {
  modal([
    h('h2', {}, 'Publish to your highlights page?'),
    h('p', {}, h('b', {}, c.title), ` · ${fmtDur(c.duration || 0)}`),
    h('ul', { class: 'steps' },
      h('li', {}, 'A web copy of the clip (1080p) is uploaded to ', h('b', {}, 'catbox.moe'), ', a free video host. No account needed.'),
      h('li', {}, h('b', {}, 'Anyone with your page link can watch it'), '. Your page link changes each time you add or remove a clip.'),
      h('li', {}, 'The page wears your DemoLab theme and shows your Overview stats. Your Steam picture and the theme’s picture (team logo or map) are uploaded too, once.'),
      h('li', {}, 'Catbox keeps files as long as someone watches them now and then (it deletes them after 2 years without views).')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => closeModal() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => publishRun(c) }, icon(GLOBE_ICON), 'Publish')),
  ]);
}

async function publishRun(c) {
  const bar = h('div', {});
  const step = h('p', {}, 'Preparing the web version…');
  modal([h('h2', {}, 'Publishing…'), h('p', { class: 'hint' }, c.title), h('div', { class: 'progress' }, bar), step], { onClose: false });
  const off = api.onGallery(u => {
    if (u.id !== c.id) return;
    if (u.progress !== undefined) bar.style.width = `${Math.round(u.progress * 100)}%`;
    if (u.step) step.textContent = u.step;
  });
  try {
    state.gallery = await api.galleryPublish(c.id, await galleryLook());
    if (state.view === 'clips') renderClips();
    const link = state.gallery.link;
    modal([
      h('h2', {}, 'It’s on your page'),
      h('p', {}, 'Share this link. It shows every clip on your page, so send the new one each time you add a clip.'),
      h('div', { class: 'gal-link' }, h('input', { type: 'text', readonly: true, value: link, onfocus: e => e.target.select() })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => galleryDialog() }, 'Manage page'),
        h('button', { class: 'btn', onclick: () => api.galleryOpen(link) }, 'Open in browser'),
        h('button', { class: 'btn primary', onclick: () => copyGalleryLink(link) }, icon(LINK_ICON), 'Copy link')),
    ]);
  } catch (e) {
    modal([h('h2', {}, 'Publishing failed'), h('div', { class: 'err-box' }, e.message),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close'), h('button', { class: 'btn primary', onclick: () => publishRun(c) }, 'Try again'))]);
  } finally { off(); }
}

async function galleryDialog() {
  const g = await loadGallery();
  const look = await galleryLook();
  const update = async fn => { const r = await guard(fn); if (r) { state.gallery = r; galleryDialog(); if (state.view === 'clips') renderClips(); } return r; };
  const local = id => state.clips.find(c => c.id === id);

  const name = h('input', { type: 'text', value: g.name || '', maxlength: 32, placeholder: g.items.find(x => x.player)?.player || 'Your name' });
  const steam = h('input', { type: 'checkbox', checked: g.showSteam });
  const saveProfile = () => update(() => api.gallerySet({ name: name.value, showSteam: steam.checked }, look));
  name.addEventListener('change', saveProfile);
  steam.addEventListener('change', saveProfile);

  const hash = h('input', { type: 'password', placeholder: g.hasUserhash ? 'Saved (type a new one to replace it)' : 'catbox user hash', autocomplete: 'off' });

  const rows = g.items.map((x, i) => {
    const c = local(x.id);
    return h('div', { class: 'gal-row' },
      h('div', { class: 'gal-thumb', style: c?.thumb ? { backgroundImage: `url("${api.fileUrl(c.thumb)}")` } : {} }, h('span', {}, fmtDur(x.duration))),
      h('div', { class: 'gal-info' },
        h('div', { class: 'gal-title' }, x.title),
        h('div', { class: 'hint' }, [x.kind === 'montage' ? 'Montage' : mapName(x.map), x.weapon, `published ${new Date(x.publishedAt).toLocaleDateString()}`].filter(Boolean).join(' · '))),
      h('button', { class: `icon-btn ${g.featured === x.id ? 'on' : ''}`, title: g.featured === x.id ? 'Featured at the top of the page (click to let the page pick the best clip)' : 'Feature it: shown big at the top of the page', onclick: () => update(() => api.galleryFeature(x.id, look)) }, icon(STAR_ICON)),
      h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => update(() => api.galleryMove(x.id, -1, look)) }, icon(UP_ICON)),
      h('button', { class: 'icon-btn', title: 'Move down', disabled: i === g.items.length - 1, onclick: () => update(() => api.galleryMove(x.id, 1, look)) }, icon(DOWN_ICON)),
      h('button', { class: 'icon-btn', title: 'Take off the page', onclick: () => removeFromGallery(x) }, icon(ICONS.trash)));
  });

  modal([
    h('h2', {}, 'My highlights page'),
    h('p', {}, 'One link with your best clips, that anyone can open in a browser. Publish clips with the ', icon(GLOBE_ICON, 'class="inline-ico"'), ' button on the Clips page.'),
    g.link ? h('div', { class: 'gal-link' },
      h('input', { type: 'text', readonly: true, value: g.link, onfocus: e => e.target.select() }),
      h('button', { class: 'btn', onclick: () => api.galleryOpen(g.link) }, 'Open'),
      h('button', { class: 'btn primary', onclick: () => copyGalleryLink(g.link) }, icon(LINK_ICON), 'Copy link'))
      : h('div', { class: 'warn-box' }, 'Your page is empty. Publish a clip first.'),
    g.link && !g.short ? h('div', { class: 'hint gal-wait' }, loadGallery.syncing ? [spinner(11), ' Making the short link… (this long one works too)'] : 'The short link could not be made right now (catbox.moe did not answer). This long link works too.') : null,
    h('div', { class: 'gal-profile' },
      h('label', {}, 'Name on the page', name),
      h('label', { class: 'gal-check' }, steam, 'Show my Steam picture and a link to my Steam profile')),
    rows.length ? h('div', { class: 'gal-list' }, ...rows) : null,
    h('details', { class: 'gal-adv' },
      h('summary', {}, 'catbox.moe account (optional)'),
      h('p', { class: 'hint' }, 'Clips are uploaded without an account. With a free catbox.moe account, they never expire and taking a clip off your page also deletes the video from catbox. Paste the "user hash" from catbox.moe → Manage account. It only applies to clips you publish after saving it.'),
      h('div', { class: 'gal-link' }, hash,
        h('button', { class: 'btn', onclick: () => update(() => api.gallerySet({ userhash: hash.value }, look)) }, 'Save'),
        g.hasUserhash ? h('button', { class: 'link-btn', onclick: () => update(() => api.gallerySet({ userhash: '' }, look)) }, 'Forget') : null)),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close')),
  ]);
}

function removeFromGallery(x) {
  modal([
    h('h2', {}, 'Take this clip off your page?'),
    h('p', {}, h('b', {}, x.title)),
    h('p', {}, x.owned && state.gallery.hasUserhash
      ? 'It is also deleted from catbox.moe. Your page gets a new link: old links still list the clip, but it won’t play any more.'
      : 'Your page gets a new link without it. The video itself stays on catbox.moe (it was uploaded without an account), so people who have an older link can still watch it.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => galleryDialog() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const look = await galleryLook();
        const r = await guard(() => api.galleryRemove(x.id, look));
        if (!r) return;
        state.gallery = r;
        if (state.view === 'clips') renderClips();
        galleryDialog();
      } }, 'Take it off')),
  ]);
}
