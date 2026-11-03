// Shared catalog and normalization for the locally saved Overview layout.
const OverviewLayout = (() => {
  // Entries marked hidden start in the editor's "+" chips: the default Overview stays as it was.
  const sections = [
    { id: 'performance', label: 'Performance', modules: [
      { id: 'rating', label: 'Rating & results' }, { id: 'stats', label: 'Stats overview' },
    ] },
    { id: 'history', label: 'Match history', modules: [
      { id: 'trend', label: 'Rating trend' }, { id: 'recent', label: 'Last matches' },
    ] },
    { id: 'duels', label: 'Rounds & duels', modules: [
      { id: 'clutches', label: 'Clutches' }, { id: 'opening', label: 'Opening duels' },
      { id: 'sides', label: 'T / CT sides' }, { id: 'multi', label: 'Multi-kill rounds' },
      { id: 'aimTiming', label: 'Aim timing', hidden: true }, { id: 'headshots', label: 'Headshots', hidden: true },
      { id: 'utilityUse', label: 'Utility', hidden: true }, { id: 'impact', label: 'Impact per round', hidden: true },
    ] },
    { id: 'maps', label: 'Maps', hidden: true, modules: [
      { id: 'mapPool', label: 'Map pool' }, { id: 'mapRating', label: 'Rating by map' },
      { id: 'mapSides', label: 'Best side per map' }, { id: 'mapExtremes', label: 'Best & worst map' },
    ] },
    { id: 'weapons', label: 'Weapons', hidden: true, modules: [
      { id: 'topWeapons', label: 'Top weapons' }, { id: 'weaponTypes', label: 'Kills by weapon type' },
      { id: 'weaponHs', label: 'Headshot % by weapon' },
    ] },
    { id: 'squad', label: 'Squad', hidden: true, modules: [
      { id: 'mates', label: 'Frequent teammates' }, { id: 'duos', label: 'Best duos' },
    ] },
    { id: 'habits', label: 'Habits & records', hidden: true, modules: [
      { id: 'streaks', label: 'Streaks' }, { id: 'records', label: 'Personal bests' },
      { id: 'ratingSpread', label: 'Rating spread' }, { id: 'closeGames', label: 'Close games' },
      { id: 'timeOfDay', label: 'Time of day' }, { id: 'weekdays', label: 'Weekdays' },
      { id: 'modes', label: 'Game modes' },
    ] },
  ];
  const stats = [
    ['kd', 'K/D ratio'], ['adr', 'ADR'], ['kills', 'Kills / round'], ['deaths', 'Deaths / round'],
    ['kast', 'KAST'], ['opening', 'Opening duels won'], ['multi', 'Multi-kill rounds'], ['headshot', 'Headshot %'],
    ['reaction', 'Reaction time'], ['damageTime', 'Time to Damage'],
    ['utility', 'Utility damage / round'], ['flashed', 'Enemies flashed / round'],
  ].map(([id, label]) => ({ id, label }));
  const ratingStats = [
    { id: 'winRate', label: 'Win rate' },
    ...['kd', 'adr', 'kast', 'headshot'].map(id => stats.find(stat => stat.id === id)),
    ...stats.filter(stat => !['kd', 'adr', 'kast', 'headshot'].includes(stat.id)).map(stat => ({ ...stat, hidden: true })),
  ];

  // Append newly added entries automatically, ignore stale IDs, and never trust duplicate entries.
  function ordered(saved, catalog, extra = () => ({})) {
    const ids = new Set(catalog.map(x => x.id)), seen = new Set();
    const list = [];
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (!entry || !ids.has(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      list.push({ id: entry.id, hidden: entry.hidden === true, ...extra(entry) });
    }
    for (const { id, hidden } of catalog) if (!seen.has(id)) list.push({ id, hidden: hidden === true, ...extra({}) });
    return list;
  }
  // Section width in twelfths of the page: two sections of 6 sit side by side.
  // Height is a minimum in CSS pixels (null: as tall as its content); a section never gets shorter than its content.
  const MIN_SPAN = 4, MAX_HEIGHT = 3000;
  const sectionSize = entry => ({
    span: Number.isInteger(entry.span) ? Math.max(MIN_SPAN, Math.min(12, entry.span)) : 12,
    height: Number.isFinite(entry.height) && entry.height > 0 ? Math.min(MAX_HEIGHT, Math.round(entry.height)) : null,
  });
  // Modules: span null keeps the section's built-in arrangement; once one module in a section is resized, the section
  // lays its modules on a 12-column grid. Height works like a section's: a minimum, never below the content.
  const MIN_MODULE_SPAN = 3;
  const moduleSize = entry => ({
    span: Number.isInteger(entry.span) ? Math.max(MIN_MODULE_SPAN, Math.min(12, entry.span)) : null,
    height: Number.isFinite(entry.height) && entry.height > 0 ? Math.min(MAX_HEIGHT, Math.round(entry.height)) : null,
  });
  // Used for modules added to a section that already has custom widths.
  const DEFAULT_MODULE_SPAN = { rating: 4, stats: 8, trend: 8, recent: 4 };
  const defaultModuleSpan = id => DEFAULT_MODULE_SPAN[id] || 4;
  function normalize(saved) {
    const value = saved && typeof saved === 'object' ? saved : {};
    const modules = {};
    for (const section of sections) modules[section.id] = ordered(value.modules?.[section.id], section.modules, moduleSize);
    return {
      sections: ordered(value.sections, sections, sectionSize), modules, stats: ordered(value.stats, stats),
      ratingStats: ordered(value.ratingStats, ratingStats, moduleSize),
      density: value.density === 'comfortable' ? 'comfortable' : 'compact',
      histograms: value.histograms !== false,
    };
  }
  return { sections, stats, ratingStats, normalize, MIN_SPAN, MIN_MODULE_SPAN, MAX_HEIGHT, defaultModuleSpan };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = OverviewLayout;
