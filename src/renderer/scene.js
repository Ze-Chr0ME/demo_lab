/* global api */
'use strict';

// Theme backdrops that react to scrolling (THEMES in app.js picks one per theme):
//  - map:     a screenshot of the map from the CS2 install, big at the top of a page; scrolling slides it
//             up more slowly than the page, zooms out a little and blurs/darkens it so cards stay readable
//  - team:    the team's logo drawn as a neon sign over a pattern (hex grid, stripes…); the pattern drifts,
//             the logo rises, tilts and dims while scrolling
//  - pattern: just the pattern and the glow
// Loaded before app.js. Pictures come from main (lib/themeArt.js) as file paths; the resolved URLs are
// kept on the theme object so the window can open in its theme before main answers.
const Scene = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.querySelector('.theme-art');
  const el = (cls, tag = 'div') => { const e = document.createElement(tag); e.className = cls; return e; };
  const photo = el('sc-photo'), sharp = el('sc-img'), soft = el('sc-img soft');
  const patWrap = el('sc-pattern-wrap'), pattern = el('sc-pattern');
  const glowA = el('sc-glow a'), glowB = el('sc-glow b');
  const logoWrap = el('sc-logo'), logo = el('', 'img');
  const shade = el('sc-shade');
  photo.append(sharp, soft);
  patWrap.append(pattern);
  logoWrap.append(logo);
  logo.alt = '';
  logo.decoding = 'async';
  root.append(photo, patWrap, glowA, glowB, logoWrap, shade);
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.setAttribute('class', 'sc-defs');
  defs.setAttribute('aria-hidden', 'true');
  document.body.append(defs);

  // ---------- Patterns (SVG tiles in the accent color) ----------
  const HEX_R = 46, HEX_W = Math.sqrt(3) * HEX_R;
  const PATTERNS = {
    hex: { w: HEX_W, h: 3 * HEX_R, d: `M${HEX_W / 2} 0L${HEX_W} ${HEX_R / 2}V${1.5 * HEX_R}L${HEX_W / 2} ${2 * HEX_R}L0 ${1.5 * HEX_R}V${HEX_R / 2}ZM${HEX_W / 2} ${2 * HEX_R}V${3 * HEX_R}` },
    tri: { w: 64, h: 64 * Math.sqrt(3), d: (() => { const w = 64, r = w * Math.sqrt(3) / 2; return `M0 0L${w} ${2 * r}M${w} 0L0 ${2 * r}M${w / 2} 0L${w} ${r}M0 ${r}L${w / 2} ${2 * r}M${w / 2} 0L0 ${r}M${w} ${r}L${w / 2} ${2 * r}M0 0H${w}M0 ${r}H${w}`; })() },
    grid: { w: 56, h: 56, d: 'M0 0H56M0 0V56M24 28H32M28 24V32' },
    diag: { w: 30, h: 30, d: 'M-8 38L38 -8M-8 8L8 -8M22 38L38 22' },
    dots: { w: 26, h: 26, dots: true },
  };
  const svgUrl = svg => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  function patternTile(kind, color) {
    const p = PATTERNS[kind];
    if (!p) return null;
    const body = p.dots ? `<circle cx="${p.w / 2}" cy="${p.h / 2}" r="1.6" fill="${color}"/>` : `<path d="${p.d}" fill="none" stroke="${color}" stroke-width="1.3"/>`;
    return { ...p, url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${p.w}" height="${p.h}">${body}</svg>`) };
  }

  // ---------- Neon logo ----------
  // Any logo becomes a neon sign: its silhouette's outline plus the edges between its light and dark
  // parts (NAVI's letters, G2's mask) are drawn as a tube in the accent color, with a thin bright core,
  // two glows and a faint fill. k scales the line width to the size the logo is shown at (1 ≈ 300 px).
  function neonFilter(id, color, k = 1) {
    const f = n => +(n * k).toFixed(2);
    let node = defs.querySelector(`#${id}`);
    if (!node) { node = document.createElementNS('http://www.w3.org/2000/svg', 'filter'); node.id = id; defs.append(node); }
    node.setAttribute('x', '-30%'); node.setAttribute('y', '-30%'); node.setAttribute('width', '160%'); node.setAttribute('height', '160%');
    node.setAttribute('color-interpolation-filters', 'sRGB');
    node.innerHTML = `
      <feMorphology in="SourceAlpha" operator="dilate" radius="${f(2.2)}" result="dil"/>
      <feMorphology in="SourceAlpha" operator="erode" radius="${f(1)}" result="ero"/>
      <feComposite in="dil" in2="ero" operator="out" result="ring"/>
      <feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="lum"/>
      <feComponentTransfer in="lum" result="lumT"><feFuncA type="discrete" tableValues="0 0 1 1 1"/></feComponentTransfer>
      <feMorphology in="lumT" operator="dilate" radius="${f(1.2)}" result="ld"/>
      <feMorphology in="lumT" operator="erode" radius="${f(0.6)}" result="le"/>
      <feComposite in="ld" in2="le" operator="out" result="lring"/>
      <feComposite in="lring" in2="ero" operator="in" result="inner"/>
      <feMerge result="lines"><feMergeNode in="ring"/><feMergeNode in="inner"/></feMerge>
      <feFlood flood-color="${color}"/><feComposite in2="lines" operator="in" result="line"/>
      <feGaussianBlur in="line" stdDeviation="${f(3)}" result="g1"/>
      <feGaussianBlur in="line" stdDeviation="${f(16)}" result="g2"/>
      <feFlood flood-color="${color}" flood-opacity=".09"/><feComposite in2="SourceAlpha" operator="in" result="fill"/>
      <feMorphology in="lines" operator="erode" radius="${f(0.9)}" result="thin"/>
      <feFlood flood-color="#fff" flood-opacity=".55"/><feComposite in2="thin" operator="in" result="core"/>
      <feMerge><feMergeNode in="g2"/><feMergeNode in="g2"/><feMergeNode in="fill"/><feMergeNode in="g1"/><feMergeNode in="line"/><feMergeNode in="core"/></feMerge>`;
    return `url(#${id})`;
  }

  // ---------- Pictures ----------
  const urlCache = new Map(); // 'shot:de_mirage_2' / 'team:vita' → file URL (or null if missing)
  function resolve(key, load) {
    if (urlCache.has(key)) return Promise.resolve(urlCache.get(key));
    const p = load().then(file => (file ? api.fileUrl(file) : null)).catch(() => null);
    urlCache.set(key, p);
    return p.then(u => { urlCache.set(key, u); return u; });
  }
  const shotUrl = (shot, thumb = false) => resolve(`shot:${shot}${thumb ? ':thumb' : ''}`, () => api.artShot(shot, thumb));
  const teamUrl = code => resolve(`team:${code}`, () => api.artTeam(code));
  let artList = null;
  const list = () => (artList ||= api.themeArt().catch(() => null));

  // ---------- Applying a theme ----------
  let kind = 'pattern', tileH = 1, token = 0, shownPhoto = '', shownLogo = '';
  // t: { base, accent, scene: 'map' | 'team' | 'pattern', shot, map, logo, pattern, photoUrl, logoUrl }
  // onResolved(patch) is called with the picture URLs once known, so the caller can cache them.
  // Pictures already showing stay put (no flash while dragging a color in the custom theme).
  function set(t, onResolved) {
    const my = ++token;
    kind = t.scene || 'pattern';
    root.dataset.kind = kind;
    document.documentElement.dataset.scene = kind;
    const tile = patternTile(t.pattern, t.accent);
    patWrap.hidden = !tile;
    if (tile) { pattern.style.backgroundImage = tile.url; pattern.style.backgroundSize = `${tile.w}px ${tile.h}px`; tileH = tile.h; pattern.style.setProperty('--tile-h', `${tile.h}px`); }

    const showPhoto = (url, radar = false) => {
      if (my !== token || url === shownPhoto) return;
      shownPhoto = url;
      photo.classList.remove('ready');
      photo.classList.toggle('radar', radar);
      const img = new Image();
      img.onload = () => {
        if (shownPhoto !== url) return;
        for (const layer of [sharp, soft]) layer.style.backgroundImage = `url("${url}")`;
        photo.classList.add('ready');
      };
      img.src = url;
    };
    photo.hidden = !(kind === 'map' && t.shot);
    if (!photo.hidden) {
      if (t.photoUrl) showPhoto(t.photoUrl);
      shotUrl(t.shot).then(u => {
        if (u) { showPhoto(u); if (u !== t.photoUrl) onResolved?.({ photoUrl: u }); }
        // No CS2 picture (CS2 not found): the radar instead, faint, like a map print.
        else if (!t.photoUrl) showPhoto(`radar/${t.map}.png`, true);
      });
    } else shownPhoto = '';

    logoWrap.hidden = !(kind === 'team' && t.logo);
    if (!logoWrap.hidden) {
      logo.style.filter = neonFilter('sc-neon', t.accent, logoSize() / 300);
      const showLogo = url => {
        if (my !== token || !url || url === shownLogo) return;
        shownLogo = url;
        logo.classList.remove('ready');
        logo.onload = () => logo.classList.add('ready');
        logo.src = url;
      };
      if (t.logoUrl) showLogo(t.logoUrl);
      teamUrl(t.logo).then(u => { if (u) { showLogo(u); if (u !== t.logoUrl) onResolved?.({ logoUrl: u }); } });
    } else { shownLogo = ''; logo.removeAttribute('src'); }
    paint(cur, true);
  }
  const logoSize = () => Math.round(Math.min(innerHeight * 0.74, innerWidth * 0.42, 760));

  // ---------- Scrolling ----------
  // Any scroll container that fills most of the window drives the scene (pages, the match detail).
  let target = 0, cur = 0, raf = 0;
  document.addEventListener('scroll', e => {
    const s = e.target;
    if (!(s instanceof Element) || s.clientHeight < innerHeight * 0.45 || s.closest('.demo-list')) return;
    target = s.scrollTop;
    kick();
  }, { capture: true, passive: true });
  // After switching pages: follow the scroll position of the page now showing.
  function follow(view) {
    const s = [view, ...view.querySelectorAll('.detail-scroll')].find(x => x.scrollHeight > x.clientHeight + 1);
    target = s ? s.scrollTop : 0;
    kick();
  }
  function kick() { if (!raf) raf = requestAnimationFrame(step); }
  function step() {
    raf = 0;
    cur = reduced.matches ? target : cur + (target - cur) * 0.16;
    if (Math.abs(target - cur) < 0.4) cur = target;
    paint(cur);
    if (cur !== target) kick();
  }
  function paint(y, force) {
    if (reduced.matches && !force) y = 0;
    const vh = innerHeight;
    const p = Math.min(1, y / (vh * 0.85)); // 0 at the top of a page → 1 after most of a screen
    root.style.setProperty('--p', p.toFixed(3));
    if (kind === 'map') {
      photo.style.transform = `translate3d(0, ${(-Math.min(y * 0.2, vh * 0.2)).toFixed(1)}px, 0) scale(${(1.08 - 0.05 * p).toFixed(4)})`;
      soft.style.opacity = p.toFixed(3);
    }
    pattern.style.transform = `translate3d(0, ${(-((y * 0.14) % tileH)).toFixed(1)}px, 0)`;
    glowA.style.transform = `translate3d(0, ${(-Math.min(y * 0.32, vh * 0.5)).toFixed(1)}px, 0)`;
    glowB.style.transform = `translate3d(0, ${(Math.min(y * 0.12, vh * 0.2)).toFixed(1)}px, 0) scale(${(1 + 0.25 * p).toFixed(3)})`;
    if (kind === 'team') {
      logoWrap.style.transform = `translate3d(${(-30 * p).toFixed(1)}px, ${(-Math.min(y * 0.3, vh * 0.3)).toFixed(1)}px, 0) rotate(${(-7 * p).toFixed(2)}deg) scale(${(1 - 0.14 * p).toFixed(3)})`;
    }
  }
  addEventListener('resize', () => {
    if (kind === 'team' && logo.style.filter) logo.style.filter = neonFilter('sc-neon', getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), logoSize() / 300);
    logoWrap.style.setProperty('--size', `${logoSize()}px`);
    paint(cur, true);
  });
  logoWrap.style.setProperty('--size', `${logoSize()}px`);

  return { set, follow, list, shotUrl, teamUrl, neonFilter, patternTile, PATTERNS };
})();
