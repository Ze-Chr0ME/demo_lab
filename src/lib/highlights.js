// Turns extracted demo data into highlights for one player. One highlight per round at most:
// if a round has a 4K that is also a clutch with a noscope, it becomes a single clip.

const SPECIALS = {
  noscope: { label: 'No-scope', score: 20, test: k => k.noscope },
  wallbang: { label: 'Wallbang', score: 15, test: k => k.wallbang },
  smoke: { label: 'Through smoke', score: 15, test: k => k.smoke },
  blind: { label: 'While blind', score: 15, test: k => k.blind },
  jumpshot: { label: 'Jumpshot', score: 15, test: k => k.inAir && !isKnife(k.weapon) },
  knife: { label: 'Knife kill', score: 25, test: k => isKnife(k.weapon) },
  zeus: { label: 'Zeus kill', score: 20, test: k => k.weapon === 'taser' },
  collateral: { label: 'Collateral', score: 25, test: null }, // handled separately (2+ kills, same tick)
};

function isKnife(w) { return !!w && (w.startsWith('knife') || w === 'bayonet'); }

function multiKillLabel(n) { return n >= 5 ? 'ACE' : `${n}K`; }
const MULTI_SCORE = { 3: 40, 4: 70, 5: 100 };
const CLUTCH_SCORE = { 1: 15, 2: 35, 3: 60, 4: 85, 5: 110 };

function weaponName(w) {
  if (!w) return '?';
  if (isKnife(w)) return 'Knife';
  const map = { taser: 'Zeus', hkp2000: 'P2000', usp_silencer: 'USP-S', m4a1_silencer: 'M4A1-S', m4a1: 'M4A4', cz75a: 'CZ75', deagle: 'Deagle', revolver: 'R8', mp5sd: 'MP5-SD', ssg08: 'Scout', awp: 'AWP', ak47: 'AK-47', galilar: 'Galil', famas: 'FAMAS', aug: 'AUG', sg556: 'SG 553', glock: 'Glock', p250: 'P250', fiveseven: 'Five-SeveN', tec9: 'Tec-9', elite: 'Dualies', mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7', ump45: 'UMP-45', p90: 'P90', bizon: 'PP-Bizon', nova: 'Nova', xm1014: 'XM1014', mag7: 'MAG-7', sawedoff: 'Sawed-Off', m249: 'M249', negev: 'Negev', g3sg1: 'G3SG1', scar20: 'SCAR-20', hegrenade: 'HE', inferno: 'Molotov', molotov: 'Molotov', incgrenade: 'Incendiary', world: 'World' };
  return map[w] || w.toUpperCase();
}

/**
 * Build highlights for `steamid`.
 * opts: { minMultiKill, clutch, minClutch, specials: {noscope:true,...}, padBefore, padAfter, mergeGap }
 */
function buildHighlights(data, steamid, opts) {
  const tr = data.tickrate;
  const myKillsAll = data.kills.filter(k => k.attacker === steamid && k.victim !== steamid && k.attackerTeam !== k.victimTeam);
  const myDeaths = data.kills.filter(k => k.victim === steamid);
  const highlights = [];
  let myScore = 0, enemyScore = 0;

  for (const r of data.rounds) {
    const me = r.roster[steamid];
    if (me) { if (r.winner === me.team) myScore++; else enemyScore++; }
    if (!me) continue;

    const kills = myKillsAll.filter(k => k.round === r.num);
    const tags = [];
    const anchors = []; // ticks that must appear in the clip
    let score = 0;

    // Multi-kill. Killing the whole enemy team is an ace, also in smaller modes (Rush is 3v3, Wingman 2v2).
    if (kills.length >= opts.minMultiKill) {
      const enemies = Object.values(r.roster).filter(p => p.team !== me.team).length;
      const ace = kills.length >= 5 || (enemies >= 3 && kills.length >= enemies);
      tags.push({ type: 'multikill', label: ace ? 'ACE' : multiKillLabel(kills.length) });
      score += ace ? MULTI_SCORE[5] : MULTI_SCORE[Math.min(kills.length, 5)] ?? 40;
      anchors.push(...kills.map(k => k.tick));
    }

    // Clutch: replay deaths up to round end and watch for the moment I'm the last one alive.
    if (opts.clutch) {
      const alive = new Map(Object.entries(r.roster).filter(([, p]) => p.alive).map(([id, p]) => [id, p.team]));
      let clutch = null;
      const check = tick => {
        if (clutch || !alive.has(steamid)) return;
        let mates = 0, enemies = 0;
        for (const team of alive.values()) team === me.team ? mates++ : enemies++;
        if (mates === 1 && enemies >= 1) clutch = { tick, vs: enemies };
      };
      check(r.freezeEndTick);
      for (const d of data.kills) {
        if (d.round !== r.num || d.tick > r.endTick) continue;
        alive.delete(d.victim);
        check(d.tick);
      }
      if (clutch && r.winner === me.team && clutch.vs >= opts.minClutch) {
        tags.push({ type: 'clutch', label: `1v${clutch.vs} clutch` });
        score += CLUTCH_SCORE[Math.min(clutch.vs, 5)];
        anchors.push(clutch.tick, r.endTick, ...kills.filter(k => k.tick >= clutch.tick).map(k => k.tick));
      }
    }

    // Special kills
    const specialKills = new Set();
    for (const [key, def] of Object.entries(SPECIALS)) {
      if (!opts.specials[key] || !def.test) continue;
      const hits = kills.filter(def.test);
      if (!hits.length) continue;
      tags.push({ type: 'special', key, label: def.label });
      score += def.score * hits.length;
      hits.forEach(k => specialKills.add(k));
    }
    if (opts.specials.collateral) {
      const byTick = {};
      for (const k of kills) (byTick[k.tick] ||= []).push(k);
      const coll = Object.values(byTick).filter(g => g.length >= 2);
      if (coll.length) {
        tags.push({ type: 'special', key: 'collateral', label: 'Collateral' });
        score += SPECIALS.collateral.score * coll.length;
        coll.flat().forEach(k => specialKills.add(k));
      }
    }
    anchors.push(...[...specialKills].map(k => k.tick));

    if (!tags.length) continue;

    const segments = buildSegments(anchors, {
      before: opts.padBefore * tr, after: opts.padAfter * tr, gap: opts.mergeGap * tr,
      min: r.freezeEndTick - 2 * tr,
    });
    const weapons = [...new Set(kills.map(k => weaponName(k.weapon)))];
    highlights.push({
      id: `r${r.num}`,
      round: r.num,
      side: me.team,
      tags,
      score,
      title: tags.map(t => t.label).join(' · '),
      weapons,
      kills: kills.map(k => ({
        tick: k.tick, victim: k.victimName, weapon: weaponName(k.weapon), headshot: k.headshot,
        flags: Object.entries(SPECIALS).filter(([key, d]) => d.test && d.test(k)).map(([, d]) => d.label),
      })),
      segments,
      duration: segments.reduce((s, g) => s + (g.end - g.start), 0) / tr,
      time: (kills[0]?.tick ?? anchors[0]) / tr,
    });
  }

  const hs = myKillsAll.filter(k => k.headshot).length;
  return {
    player: { steamid, name: data.players.find(p => p.steamid === steamid)?.name || steamid },
    stats: { kills: myKillsAll.length, deaths: myDeaths.length, hsPct: myKillsAll.length ? Math.round(100 * hs / myKillsAll.length) : 0 },
    score: { mine: myScore, enemy: enemyScore },
    highlights,
  };
}

// Pads each anchor tick, then merges windows that overlap or sit within `gap` of each other.
function buildSegments(anchors, { before, after, gap, min }) {
  const wins = [...new Set(anchors)].sort((a, b) => a - b).map(t => ({ start: Math.max(min, t - before), end: t + after }));
  const out = [];
  for (const w of wins) {
    const last = out[out.length - 1];
    if (last && w.start - last.end <= gap) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out.map(s => ({ start: Math.round(s.start), end: Math.round(s.end) }));
}

module.exports = { buildHighlights, SPECIALS };
