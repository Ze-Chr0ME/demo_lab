// Per-round facts the main parse doesn't keep: every player's money and loadout when the round goes
// live, and where on the map they were (CS2's own callout names, e.g. "BombsiteA", "Banana"). Two quick
// parser passes over a handful of ticks (a few seconds per demo), stored as <id>.rounds.json.
//
//  rounds[i].eco[steamid] = [money at the start, loadout value, spent this round, armor (0 none, 1 vest,
//                            2 vest + helmet), defuse kit (0/1), grenades, items (no knife)]
//  rounds[i].pos[steamid] = callout index (into places) once per second from freeze end to round end,
//                           -1 once dead
//  killPlaces[k]          = [attacker callout, victim callout] for core.kills[k] (-1 = unknown)
//  killState[k]           = just before core.kills[k] (2 ticks): { pos: {steamid: [x, y, z]} of everyone alive,
//                           nades: the victim's grenades } (death review: who was near, utility left unused)
const parser = require('./parser');

const ROUNDS_VERSION = 2;
const BUY_TIME = 20;   // seconds after freeze end players can still buy (mp_buytime)
const SAMPLE = 64;     // one position sample per second
const NADES = /grenade|flashbang|molotov|incendiary|decoy/i;
const KNIFE = /knife|bayonet|karambit|daggers|^c4|bomb/i;

function extractRounds(file, core) {
  const tr = core.tickrate || 64;
  const rounds = core.rounds;
  const sid = s => (s && s !== '0' ? s : null);

  // ---- money and loadouts: when the round goes live, and at the end of the buy time (late buys)
  const live = rounds.map(r => r.freezeEndTick);
  const late = rounds.map(r => Math.min(r.endTick, r.freezeEndTick + BUY_TIME * tr));
  const econ = new Map();
  for (const row of parser.parseTicks(file, ['balance', 'current_equip_value', 'cash_spent_this_round', 'armor_value', 'has_helmet', 'has_defuser', 'inventory', 'is_alive', 'team_num'], [...new Set([...live, ...late])])) {
    if (sid(row.steamid) && (row.team_num === 2 || row.team_num === 3)) econ.set(`${row.tick}|${row.steamid}`, row);
  }

  // ---- callouts: once per second while the round is live, plus at every kill
  const placeIndex = new Map();
  const places = [];
  const place = name => {
    if (!name) return -1;
    if (!placeIndex.has(name)) { placeIndex.set(name, places.length); places.push(name); }
    return placeIndex.get(name);
  };
  const samples = [];
  for (const r of rounds) for (let t = r.freezeEndTick; t <= r.endTick; t += SAMPLE) samples.push(t);
  const killTicks = core.kills.map(k => k.tick);
  const at = new Map();
  for (const row of parser.parseTicks(file, ['last_place_name', 'is_alive'], [...new Set([...samples, ...killTicks])].sort((a, b) => a - b))) {
    if (sid(row.steamid)) at.set(`${row.tick}|${row.steamid}`, row);
  }

  const out = rounds.map((r, i) => {
    const eco = {}, pos = {};
    for (const id of Object.keys(r.roster)) {
      const a = econ.get(`${live[i]}|${id}`), b = econ.get(`${late[i]}|${id}`);
      if (a) {
        const spentLate = b && b.is_alive ? Math.max(0, (b.cash_spent_this_round || 0) - (a.cash_spent_this_round || 0)) : 0;
        const inv = (b && b.is_alive ? b.inventory : a.inventory) || a.inventory || [];
        const armor = Math.max(a.armor_value || 0, b?.is_alive ? b.armor_value || 0 : 0) > 0 ? (a.has_helmet || b?.has_helmet ? 2 : 1) : 0;
        eco[id] = [
          (a.balance || 0) + (a.cash_spent_this_round || 0),
          (a.current_equip_value || 0) + spentLate,
          (a.cash_spent_this_round || 0) + spentLate,
          armor,
          a.has_defuser || b?.has_defuser ? 1 : 0,
          Math.max((a.inventory || []).filter(x => NADES.test(x)).length, (b?.is_alive ? b.inventory || [] : []).filter(x => NADES.test(x)).length),
          inv.filter(x => !KNIFE.test(x)),
        ];
      }
      const list = [];
      for (let t = r.freezeEndTick; t <= r.endTick; t += SAMPLE) {
        const s = at.get(`${t}|${id}`);
        list.push(s && s.is_alive ? place(s.last_place_name) : -1);
      }
      while (list.length && list.at(-1) === -1) list.pop();
      pos[id] = list;
    }
    return { num: r.num, eco, pos };
  });

  // ---- just before every kill: where everyone alive stood, and what the victim still held
  const before = new Map();
  const beforeTicks = [...new Set(killTicks.map(t => Math.max(1, t - 2)))].sort((a, b) => a - b);
  for (const row of parser.parseTicks(file, ['X', 'Y', 'Z', 'is_alive', 'inventory'], beforeTicks)) {
    if (sid(row.steamid) && row.is_alive && Number.isFinite(row.X)) before.set(`${row.tick}|${row.steamid}`, row);
  }
  const rosterOf = new Map(rounds.map(r => [r.num, r.roster]));
  const killState = core.kills.map(k => {
    const t = Math.max(1, k.tick - 2), pos = {};
    for (const id of Object.keys(rosterOf.get(k.round) || {})) {
      const row = before.get(`${t}|${id}`);
      if (row) pos[id] = [Math.round(row.X), Math.round(row.Y), Math.round(row.Z)];
    }
    const inv = before.get(`${t}|${k.victim}`)?.inventory || [];
    return { pos, nades: inv.filter(x => NADES.test(x)) };
  });

  const killPlaces = core.kills.map(k => [
    k.attacker ? place(at.get(`${k.tick}|${k.attacker}`)?.last_place_name) : -1,
    place(at.get(`${k.tick}|${k.victim}`)?.last_place_name),
  ]);
  return { version: ROUNDS_VERSION, sample: SAMPLE, places, rounds: out, killPlaces, killState };
}

module.exports = { extractRounds, ROUNDS_VERSION };
