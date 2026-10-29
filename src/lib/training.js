// Runs a training session in the HLAE CS2 (the same one "Practice in CS2" uses) and records a demo of
// it, which lib/drillStats.js reads afterwards.
//
// Drills with bots (lib/drills.js): a private server where my team is CT and the bots T, everyone
// respawning. The bots run DemoLab's behavior trees (lib/botBrains.js: hold the spot, face me, shoot or
// not). Each repetition puts the bots on their spots (setpos_player) and me on mine (setpos/setang),
// then waits until they're all dead, I die (the rep is tried once more) or REP_SECONDS pass. Kills and deaths come live from Game State Integration (CS2 posts the
// player's state to a local HTTP server, see Gsi): the config file is only read when CS2 starts, so
// a CS2 opened before DemoLab installed it runs the reps on a timer instead.
//
// Scenarios (lib/scenarios.js, recorded in CS2 or made on the 2D map): the same layout every rep, each
// rep a round of its own (the score counts them). Each rep kicks the bots and adds them again, each with
// its own tree (the angle it holds, its gun), puts them on their spots and me on my start (checked
// with getpos_exact, tried again if I'm not there). Nobody respawns during a rep: it ends when the bots
// are all dead, I die or the scenario's time runs out.
//
// The procedurally generated map (SCOPE.GG workshop map) runs by itself; its script prints
// "OnPGTEnterRoom | …" and "OnPGTFinished | …" to the console, and the cheat command
// test_pgt_print_highscore prints its saved scores as JSON ({ last_score, scores: [{ score, name }] }).
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { DRILLS } = require('./drills');
const { installBrains, installScenarioBrains } = require('./botBrains');

const REP_SECONDS = 20;       // a rep nobody finishes ends after this
const TIMED_REP_SECONDS = 12; // without live kills: every rep lasts this long
const RESPAWN_WAIT = 1800;    // ms for killed bots to respawn before the next rep moves them
const sleep = ms => new Promise(r => setTimeout(r, ms));
// every gun of the buy menu (My scenarios), and the grenades a session can start with: no smokes
const WEAPONS = Object.fromEntries(['glock', 'usp_silencer', 'hkp2000', 'elite', 'p250', 'tec9', 'fiveseven', 'cz75a', 'deagle', 'revolver',
  'mac10', 'mp9', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon', 'nova', 'xm1014', 'mag7', 'sawedoff', 'negev', 'm249',
  'galilar', 'famas', 'ak47', 'm4a1', 'm4a1_silencer', 'sg556', 'aug', 'ssg08', 'awp', 'g3sg1', 'scar20'].map(k => [k, `weapon_${k}`]));
const GRENADES = { flashbang: 2, hegrenade: 1, incgrenade: 1, molotov: 1, decoy: 1 }; // how many of each CS2 lets you carry

// ---------- Game State Integration ----------
class Gsi {
  constructor({ port, token, log = () => {} }) {
    Object.assign(this, { port, token, log });
    this.state = null;
    this.last = 0;
    this.liveAt = 0; // when the last round started (its phase turned "live")
    this.listeners = new Set();
    this.server = null;
  }

  // The file CS2 reads from csgo/cfg when it starts.
  cfgText() {
    return `"DemoLab Training"\r\n{\r\n  "uri" "http://127.0.0.1:${this.port}/"\r\n  "timeout" "1.0"\r\n  "buffer" "0.0"\r\n  "throttle" "0.05"\r\n  "heartbeat" "5.0"\r\n`
      + `  "auth"\r\n  {\r\n    "token" "${this.token}"\r\n  }\r\n  "data"\r\n  {\r\n    "provider" "1"\r\n    "map" "1"\r\n    "round" "1"\r\n    "player_id" "1"\r\n    "player_state" "1"\r\n    "player_match_stats" "1"\r\n    "player_weapons" "1"\r\n  }\r\n}\r\n`;
  }

  // Writes csgo/cfg/gamestate_integration_demolab.cfg; true when it changed (CS2 needs a restart to read it).
  install(csgoDir) {
    const file = path.join(csgoDir, 'cfg', 'gamestate_integration_demolab.cfg');
    const text = this.cfgText();
    try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch {}
    fs.writeFileSync(file, text);
    this.log(`training: game state integration installed in ${file}`);
    return true;
  }

  start() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', d => { if (body.length < 1_000_000) body += d; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('');
          let msg;
          try { msg = JSON.parse(body); } catch { return; }
          if (msg?.auth?.token !== this.token) return;
          if (msg.round?.phase === 'live' && this.state?.round?.phase !== 'live') this.liveAt = Date.now();
          this.state = msg;
          this.last = Date.now();
          for (const f of this.listeners) { try { f(msg); } catch {} }
        });
      });
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }

  alive() { return Date.now() - this.last < 12000; }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  // Whether I'm playing: { team, alive, watching } (watching: the state is of a player I spectate).
  mine() {
    const s = this.state, p = s?.player;
    if (!p) return null;
    return { team: p.team || null, alive: (p.state?.health ?? 0) > 0, watching: !!(s.provider?.steamid && p.steamid && p.steamid !== s.provider.steamid) };
  }
  // The local player's numbers: { kills, deaths, health, steamid } (null before CS2 posted anything).
  me() {
    const p = this.state?.player;
    if (!p?.match_stats) return null;
    return { kills: p.match_stats.kills ?? 0, deaths: p.match_stats.deaths ?? 0, health: p.state?.health ?? 100, steamid: p.steamid, hs: p.state?.round_killhs ?? 0 };
  }
}

// The players in CS2's "status" output: [{ id, name, bot }] (id = player slot; GOTV left out).
function parseStatus(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(BOT|\d[\d:]*)\s+.*?'([^']*)'\s*$/.exec(line);
    if (!m || +m[1] >= 65535 || /^(SourceTV|GOTV)/i.test(m[3]) || out.some(b => b.id === +m[1])) continue;
    out.push({ id: +m[1], name: m[3], bot: m[2] === 'BOT' });
  }
  return out;
}
// "setpos x y z;setang …" as printed by getpos, or null.
function parseGetpos(text) {
  const all = [...text.matchAll(/setpos(?:_exact)?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/g)];
  return all.length ? all.at(-1).slice(1, 4).map(Number) : null;
}

// "setpos_exact x y z;setang_exact p y r" as printed by getpos_exact (my feet, not my eyes): { pos, ang } or null.
function parseExact(text) {
  const all = [...text.matchAll(/setpos_exact\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*setang_exact\s+(-?[\d.]+)\s+(-?[\d.]+)/g)];
  if (!all.length) return null;
  const m = all.at(-1).slice(1).map(Number);
  return { pos: m.slice(0, 3), ang: m.slice(3, 5) };
}

// Whatever the player (or an earlier session) left set in CS2 that would change how the drills
// play: sv_cheats 0 puts every cheat cvar back to its default, the rest are set one by one.
// bot_quota first: the game mode's own quota (fill to 10) would add teammates and enemies of its own.
const RESET = ['sv_cheats 0', 'sv_cheats 1', 'bot_quota_mode normal', 'bot_quota 0', 'bot_join_team any', 'mp_humanteam any', 'host_timescale 1', 'bot_stop 0', 'bot_freeze 0', 'bot_zombie 0', 'bot_dont_shoot 0', 'bot_ignore_players 0',
  'bot_strafe 0', 'bot_crouch 0', 'bot_mimic 0', 'bot_controllable 1', 'bot_knives_only 0', 'bot_pistols_only 0', 'bot_snipers_only 0', 'bot_all_weapons',
  'bot_defer_to_human_goals 0', 'bot_defer_to_human_items 0', 'mp_teammates_are_enemies 0', 'mp_damage_headshot_only 0', 'mp_friendlyfire 0',
  'sv_infinite_ammo 0', 'mp_ct_default_grenades ""', 'mp_drop_knife_enable 0', 'sv_showimpacts 0', 'sv_grenade_trajectory_prac_pipreview 0', 'mp_solid_teammates 1'];
// GOTV records the session: its demos are the ones the parser reads best (a client "record" demo of a
// local server came out without any player data). Has to be on before the map loads.
const TV = ['tv_enable 1', 'tv_delay 0', 'tv_transmitall 1', 'tv_autorecord 0', 'tv_advertise_watchable 0'];
// game_type/game_mode only count when a map loads, and they outlive it. Casual (CS2's default, what the
// drills expect) fills the server with bots on both teams; the procedural map wants Custom.
const gameMode = ([type, mode] = [0, 0]) => [`game_type ${type}`, `game_mode ${mode}`];

// The scores test_pgt_print_highscore printed after `from` in the console text, or null.
function parseHighscore(text) {
  let found = null;
  for (const m of text.matchAll(/\{"last_score":[^\n]*\}/g)) {
    try { found = JSON.parse(m[0]); } catch {}
  }
  return found;
}

const fmt = v => v.map(x => x.toFixed(1)).join(' ');

// One session. plan: { drill, map, parts: [{ drill, reps, seconds }], options: { weapon, botWeapon,
// difficulty, hsOnly }, scenario (drill 'scenario': the saved scenario) }. io: { session, gsi, csgoDir, loadMap(map, cmd), log, status(obj), cancelled() }.
// Returns { demo, demoPov (file names in csgo/), started, ended, parts: [{ drill, from, to, reps, done }],
// runs, highscore, reps (scenario: [{ result: 'cleared' | 'died' | 'time', ms, kills }]) }.
// Puts me on a spot (my feet), checked with getpos_exact, again when I'm not there. Plain
// setpos, then noclip 0: setpos_exact into the ground turns noclip on (CS2 prints "noclip ON") and it
// stays on, setpos moves me out instead (checked in CS2). Every miss is logged. The number of tries
// it took (1 = at once), 0 when it never stuck.
async function teleport(session, log, pos, yaw, watch = false) {
  const cmds = [`setpos ${fmt([pos[0], pos[1], pos[2] + 2])}`, `setang 0 ${(+yaw || 0).toFixed(1)} 0`, 'noclip 0'];
  const where = async () => { const from = session.seen; await session.send(['getpos_exact']); await sleep(300); return parseExact(session.since(from))?.pos || null; };
  const off = p => (p ? Math.hypot(p[0] - pos[0], p[1] - pos[1]) : Infinity);
  const show = p => (p ? fmt(p) : '?');
  const start = session.seen;
  for (let k = 0; k < 6; k++) {
    await session.send(cmds);
    // one reading on the spot is enough: I may walk off it right away
    const a = await where();
    if (off(a) < 48) {
      if (watch || k) log(`training: on the spot ${fmt(pos)} after ${k + 1} tr${k ? 'ies' : 'y'} (${show(a)})`);
      return k + 1;
    }
    const said = session.since(start).split(/\r?\n/).filter(l => /noclip|stuck|clamped/i.test(l)).slice(-3);
    log(`training: teleport to ${fmt(pos)}, try ${k + 1}: at ${show(a)}${said.length ? ` (CS2: ${said.join(' | ')})` : ''}`);
    await sleep(200);
  }
  return 0;
}
async function runTraining(plan, io) {
  const { session, gsi, log, status, cancelled } = io;
  const free = DRILLS[plan.drill]?.free;
  const o = plan.options || {};
  let cursor = session.buf.length;
  const consoleSince = () => { if (session.buf.length < cursor) cursor = 0; const s = session.buf.slice(cursor); cursor = session.buf.length; return s; };
  // A cvar's current text value (CS2 prints `name = value` when given just the name).
  const cvar = async name => {
    consoleSince();
    await session.send([name]);
    await sleep(500);
    const m = new RegExp(`\\b${name}[ \\t]*=[ \\t]*"?([^"\\r\\n]*?)"?[ \\t]*(?:\\(|$|\\r?\\n)`, 'm').exec(consoleSince());
    return m ? m[1].trim() : null;
  };

  status({ phase: 'loading', message: `Loading ${plan.map}…` });
  // cvars outlive a map change: reset before loading so the map's own setup (the workshop map's
  // script) comes after, and again after for the drills with bots
  await session.send([...RESET, ...TV, ...gameMode(DRILLS[plan.drill]?.mode)]);
  await io.loadMap(plan.map, free ? `map_workshop ${DRILLS[plan.drill].workshop} ${plan.map}` : `map ${plan.map}`);
  if (cancelled()) return null;

  const name = `demolab_training_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  // GOTV's demo only: a client demo (record) freezes the game for seconds when it starts (it waits for a
  // full update from the server, which only comes after a timeout: the player hangs and snaps back)
  const out = { demo: `${name}.dem`, demoPov: null, started: 0, ended: 0, parts: [], runs: [], highscore: null, reps: [] };
  const startRecording = () => session.send([`tv_record ${name}`]);
  const stopRecording = () => session.send(['tv_stoprecord']);

  if (free) {
    await startRecording();
    out.started = Date.now();
    // the procedural map's script prints its rooms and runs (the warm-up's Aim Botz has none)
    const pgt = plan.drill === 'procedural';
    status({ phase: 'running', message: 'Play the map in CS2. Press Finish here when you are done.', rooms: pgt ? 0 : null, runs: pgt ? 0 : null });
    let rooms = 0;
    while (!cancelled()) {
      if (!session.sock) throw new Error('CS2 closed during the training.');
      const text = consoleSince();
      for (const m of text.matchAll(/OnPGTEnterRoom \| [^|]*\| (\{[^\n]*\})/g)) { try { rooms = Math.max(rooms, (JSON.parse(m[1]).room_num ?? 0) + 1); } catch {} }
      if (/OnPGTFinished \|/.test(text)) {
        out.runs.push({ at: Math.round((Date.now() - out.started) / 1000), rooms });
        await session.send(['test_pgt_print_highscore']);
        await sleep(1500);
        const hs = parseHighscore(session.buf);
        if (hs) { out.highscore = hs; out.runs.at(-1).score = Number(hs.last_score) || null; }
        rooms = 0;
      }
      const me = gsi.me();
      status({ phase: 'running', message: 'Play the map in CS2. Press Finish here when you are done.', rooms: pgt ? rooms : null, runs: pgt ? out.runs.length : null, kills: me?.kills, deaths: me?.deaths, live: gsi.alive() });
      await sleep(1000);
    }
    await session.send(['test_pgt_print_highscore']);
    await sleep(1200);
    out.highscore = parseHighscore(session.buf) || out.highscore;
    await stopRecording();
    await session.send(RESET);
    out.ended = Date.now();
    // Finish (including F3) saves the demo before closing the workshop session.
    status({ phase: 'running', message: 'Closing CS2…' });
    await sleep(1000);
    await session.quit();
    return out;
  }

  // ---- drills with bots
  const brains = installBrains(io.csgoDir, o.difficulty ?? 2);
  // a CS2 behind another window sleeps between frames (engine_no_focus_sleep): its player barely moves
  // and the server pulls him back to where he was. Off for the session, put back after.
  const sleepBefore = await cvar('engine_no_focus_sleep');
  const brainBefore = await cvar('mp_bot_ai_bt');
  log(`training: mp_bot_ai_bt was "${brainBefore}"`);
  // Knife and Zeus replace the primary; the selected sidearm remains available.
  const specialWeapon = o.weapon === 'knife' || o.weapon === 'taser';
  const myGun = specialWeapon ? '' : WEAPONS[o.weapon] || 'weapon_ak47', botGun = WEAPONS[o.botWeapon] || 'weapon_ak47', myPistol = WEAPONS[o.pistol] || 'weapon_usp_silencer';
  // at most 4 grenades, as many of each as CS2 allows
  const myNades = (o.nades || []).filter((g, i, all) => GRENADES[g] && all.slice(0, i + 1).filter(x => x === g).length <= GRENADES[g]).slice(0, 4).map(g => `weapon_${g}`);
  // also sent again after the first bots join: that restarts the game ("Game commencing"), which runs
  // the game mode's config again (bot_quota 10 in fill mode: teammates and extra enemies)
  const SETUP = [
    ...RESET, 'bot_kick', 'mp_warmup_end', 'mp_humanteam CT', 'mp_autoteambalance 0', 'mp_limitteams 0', 'mp_ignore_round_win_conditions 1',
    'mp_roundtime 60', 'mp_roundtime_defuse 60', 'mp_freezetime 0', 'mp_respawn_on_death_t 1', 'mp_respawn_on_death_ct 1',
    'mp_respawn_immunitytime 0', 'mp_death_drop_gun 0', 'sv_infinite_ammo 2', 'mp_buy_anywhere 1', 'mp_buytime 9999', 'mp_maxmoney 60000', 'mp_startmoney 60000',
    `mp_ct_default_primary "${myGun}"`, `mp_t_default_primary ${botGun}`, `mp_ct_default_secondary ${myPistol}`, `mp_ct_default_grenades "${myNades.join(' ')}"`, `mp_free_armor ${{ kevlar: 1, assaultsuit: 2 }[o.armor] ?? 0}`, `mp_damage_headshot_only ${o.hsOnly ? 1 : 0}`,
    'bot_join_after_player 0', 'bot_chatter off', 'bot_auto_vacate 0',
    'mp_maxrounds 100', 'mp_halftime 0', 'mp_match_can_clinch 0', 'mp_round_restart_delay 2',
  ];
  await session.send([...SETUP, 'engine_no_focus_sleep 0', 'mp_restartgame 1']);
  await sleep(1500);
  await session.send(['jointeam 3 1']);
  await sleep(1000);

  // the bots' player slots for setpos_player
  let bots = [], players = [];
  const readBots = async () => {
    consoleSince();
    await session.send(['status']);
    await sleep(900);
    const text = consoleSince();
    const found = parseStatus(text);
    if (found.length) { players = found; bots = found.filter(p => p.bot); }
    else log('training: nothing found in the status output:', text.slice(-600));
    return bots;
  };
  // setpos_player wants an index that isn't the slot "status" shows (+1 on the first try): move me
  // with it and ask getpos whether I moved, before moving any bot.
  let slotOffset = 1;
  await readBots();
  const me = players.find(p => !p.bot);
  if (me) {
    // getpos_exact: my feet (getpos gives my eyes, 64 higher: moving me there left me in the air)
    const where = async () => { consoleSince(); await session.send(['getpos_exact']); await sleep(500); return parseExact(consoleSince())?.pos || null; };
    const home = await where();
    if (home) {
      for (const off of [1, 0, 2]) {
        await session.send([`setpos_player ${me.id + off} ${fmt([home[0] + 40, home[1], home[2]])}`]);
        await sleep(400);
        const now = await where();
        if (now && Math.hypot(now[0] - home[0], now[1] - home[1]) > 20) { slotOffset = off; break; }
      }
      await session.send([`setpos ${fmt([home[0], home[1], home[2] + 2])}`, 'noclip 0']);
    }
    log(`training: setpos_player index = status id + ${slotOffset}${home ? '' : ' (getpos did not answer, guessed)'}`);
  }
  // New bots with the brain this drill needs: mp_bot_ai_bt is read when a bot joins.
  let brain = null;
  const botsFor = async (file, count) => {
    if (brain === file && bots.length >= count) return;
    await session.send(['bot_kick', `mp_bot_ai_bt "${file}"`]);
    await sleep(600);
    // bot_quota, not bot_add_t (in CS2 that adds two bots per call)
    await session.send(['bot_join_team T', 'bot_quota_mode normal', `bot_quota ${count}`]);
    await sleep(2500);
    // CS2 complains in the console when a behavior tree doesn't load: keep that in the log
    const said = consoleSince().split(/\r?\n/).filter(l => /behavior|\.kv3|mp_bot_ai_bt|error|fail/i.test(l)).slice(-8);
    if (said.length) log(`training: CS2 said: ${said.join(' | ')}`);
    await readBots();
    brain = file;
    log(`training: ${bots.length} bots with ${file}: ${bots.map(b => `${b.name}#${b.id}`).join(', ')}`);
  };
  const place = rep => rep.bots.map((b, k) => (bots[k] ? `setpos_player ${bots[k].id + slotOffset} ${fmt(b)}` : null)).filter(Boolean);
  const useGsi = gsi.alive();
  log(`training: live kills ${useGsi ? 'on' : 'off (no game state from CS2)'}`);

  // ---- a scenario: same layout every rep
  // list: one scenario, or a map's mix (a random one every rep: shuffled, shuffled again once all
  // were played, never the same twice in a row). Each rep's timer is its scenario's.
  const scenarioRun = async (list, { reps, firstTo = 0 }) => {
    // a tree per bot of every scenario at once (installing removes the trees installed before)
    const all = installScenarioBrains(io.csgoDir, o.difficulty ?? 2, list.flatMap(x => x.bots));
    const filesOf = new Map();
    list.reduce((k, x) => { filesOf.set(x, all.slice(k, k + x.bots.length)); return k + x.bots.length; }, 0);
    let sc = null, files = [], deck = [];
    const draw = () => {
      if (!deck.length) {
        deck = [...list];
        for (let k = deck.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [deck[k], deck[j]] = [deck[j], deck[k]]; }
        if (deck.length > 1 && deck[0] === sc) deck.push(deck.shift());
      }
      return deck.shift();
    };
    let next = draw();
    for (const x of list) log(`training: scenario "${x.name}" on ${x.map}: ${x.bots.length} bots, start ${fmt(x.me.pos)}`);
    const roundOver = () => gsi.state?.round?.phase === 'over';
    // Every rep is a round of its own (the score: CT's point when every bot is dead, T's when I die).
    // A new round respawns everyone and frees the T spawn points: a bot only joins a
    // team with a free one ("Team is full" otherwise), and a kicked bot's stays taken until the round ends.
    // The round ends with the last death and the next one starts mp_round_restart_delay (2 s) later:
    // wait it out whatever the game state says (it can be late), bots added before it would get the
    // default guns from it. Win conditions off right after: kicking the bots would end the new round
    // (T eliminated) and the round after it would take the new bots' guns.
    const nextRound = async () => {
      await sleep(2600);
      for (const until = Date.now() + 3000; roundOver() && Date.now() < until;) await sleep(100);
      await session.send(['mp_ignore_round_win_conditions 1']);
      await sleep(150);
    };
    // The round timer at the top of the screen counts the rep's time down: the round lasts the time the
    // setup took on the last rep (bots joining, teleport) plus the rep's (mp_roundtime is read when a
    // round starts). Out of time is T's round: I'm killed just before it ends (CT's when it runs out).
    let setupMs = 2500, roundMs = 0, roundAsked = Date.now();
    const roundTime = () => {
      roundMs = setupMs + next.options.seconds * 1000;
      const m = (roundMs / 60000).toFixed(3);
      return [`mp_roundtime ${m}`, `mp_roundtime_defuse ${m}`];
    };
    // Fresh bots, each joining with its own tree (mp_bot_ai_bt is read when it joins: its spot, angle
    // and gun; a bot that respawns in the next round keeps its tree but gets the default gun back).
    // bot_quota one higher adds exactly one bot at once. Not bot_add_t: in CS2 it raises bot_quota by
    // 2 and the quota adds a second bot with whatever tree is set by then (checked in CS2).
    const addBots = async () => {
      await session.send(['mp_ignore_round_win_conditions 1', 'bot_kick', 'bot_quota_mode normal', 'bot_quota 0', 'bot_join_team T',
        'mp_respawn_on_death_t 1', 'mp_respawn_on_death_ct 1', 'bot_dont_shoot 1']);
      await sleep(300);
      consoleSince();
      await session.send(files.flatMap((f, k) => [`mp_bot_ai_bt "${f}"`, `bot_quota ${k + 1}`]));
      await sleep(300);
      await readBots();
      const said = consoleSince().split(/\r?\n/).filter(l => /full|could not|behavior|\.kv3|error|fail/i.test(l)).slice(-6);
      if (said.length) log(`training: CS2 said: ${said.join(' | ')}`);
      return [...bots].sort((a, b) => a.id - b.id);
    };
    const part = { drill: 'scenario', from: 0, to: 0, reps: 0, done: 0 };
    out.parts.push(part);
    let won = 0, lost = 0;
    const shown = firstTo ? null : reps;
    // rep 1 in a fresh round too (the one the setup started has been running for a while), with bots on
    // T already: a player joining an empty team restarts the game
    status({ phase: 'running', drill: 'scenario', rep: 1, reps: shown, message: 'Setting up the rep…', live: useGsi });
    files = filesOf.get(next);
    await addBots();
    roundAsked = Date.now();
    await session.send([...roundTime(), 'mp_ignore_round_win_conditions 0', 'endround']);
    for (let i = 0; (firstTo ? Math.max(won, lost) < firstTo : i < reps) && !cancelled(); i++) {
      status({ phase: 'running', drill: 'scenario', rep: i + 1, reps: shown, message: 'Setting up the rep…', live: useGsi });
      await nextRound();
      sc = next;
      files = filesOf.get(sc);
      if (list.length > 1) log(`training: rep ${i + 1}: "${sc.name}"`);
      const mine = await addBots();
      if (mine.length !== files.length) log(`training: rep ${i + 1}: ${mine.length} bots instead of ${files.length}: ${mine.map(b => b.name).join(', ')}`);
      const placeBots = () => session.send(mine.slice(0, sc.bots.length).map((b, k) => `setpos_player ${b.id + slotOffset} ${fmt([sc.bots[k].pos[0], sc.bots[k].pos[1], sc.bots[k].pos[2] + 24])}`));
      await placeBots();
      await sleep(150);
      const tries = await teleport(session, log, sc.me.pos, sc.me.yaw, i === 0);
      if (!tries) log(`training: rep ${i + 1}: could not keep me on the start spot`);
      if (tries > 1) { await placeBots(); await sleep(150); }
      if (i === 0) log(`training: rep 1: ${mine.length}/${sc.bots.length} bots ${mine.map(b => `${b.name}#${b.id}`).join(', ')}, me ${JSON.stringify(gsi.mine())}`);
      // Every fresh round equips the selected melee/special weapon after teleporting.
      if (o.weapon === 'taser') await session.send(['give weapon_taser', 'use weapon_taser']);
      else if (o.weapon === 'knife') await session.send(['use weapon_knife']);
      await session.send(['mp_respawn_on_death_t 0', 'mp_respawn_on_death_ct 0', 'bot_dont_shoot 0', 'mp_ignore_round_win_conditions 0']);
      const before = gsi.me(), t0 = Date.now();
      const startedAt = gsi.liveAt > roundAsked ? gsi.liveAt : t0;
      if (startedAt < t0) setupMs = Math.min(15000, t0 - startedAt);
      const deadline = Math.max(t0 + 3000, startedAt + roundMs - 300);
      part.reps++;
      status({ phase: 'running', drill: 'scenario', rep: i + 1, reps: shown, message: [firstTo ? `${won}–${lost}` : null, list.length > 1 ? sc.name : null].filter(Boolean).join(' · ') || null, live: useGsi, done: part.done });
      let result = 'time';
      while (Date.now() < deadline && !cancelled()) {
        await sleep(150);
        if (!session.sock) throw new Error('CS2 closed during the training.');
        if (roundOver()) { result = gsi.state.round.win_team === 'CT' && Date.now() < deadline - 200 ? 'cleared' : 'died'; break; }
        const now = gsi.me();
        if (useGsi && now && before) {
          if (now.kills - before.kills >= sc.bots.length) { result = 'cleared'; break; }
          if (now.deaths > before.deaths) { result = 'died'; break; }
        }
      }
      if (result === 'time' && !cancelled()) await session.send(['kill']);
      roundAsked = Date.now();
      next = draw();
      await session.send(roundTime());
      if (result === 'cleared') won++; else lost++;
      const kills = useGsi && before ? Math.max(0, (gsi.me()?.kills ?? before.kills) - before.kills) : null;
      out.reps.push({ result, ms: Date.now() - t0, kills, ...(list.length > 1 ? { scenario: sc.name } : {}) });
      if (result === 'cleared') part.done++;
      log(`training: rep ${i + 1}: ${result}${kills != null ? `, ${kills} kills` : ''} (${won}-${lost})`);
    }
    part.to = (Date.now() - out.started) / 1000;
    // played to the end (first to N, or every rep): the result in the chat, then CS2 closes (after the
    // demo is saved, below)
    if (!cancelled()) {
      const text = won === lost ? `Draw ${won}-${lost}` : `You ${won > lost ? 'won' : 'lost'} ${won}-${lost}`;
      log(`training: scenario over: ${text}`);
      status({ phase: 'running', drill: 'scenario', message: `${text}. Closing CS2…` });
      await session.send(['mp_ignore_round_win_conditions 1', 'bot_kick', `say "[DemoLab] ${text.toUpperCase()}"`]);
      await sleep(5000);
      out.quit = true;
    }
  };
  await startRecording();
  out.started = Date.now();
  const drillParts = async () => {
    status({ phase: 'running', message: useGsi ? null : 'Live kill tracking starts with CS2\'s next start: reps run on a timer this time.' });
    let total = 0, done = 0;
    for (const p of plan.parts) total += p.seconds ? 0 : p.reps.length;
    for (const p of plan.parts) {
      if (cancelled()) break;
      const d = DRILLS[p.drill];
      await botsFor(d.shoot ? brains.hold : d.strafe ? brains.strafe : brains.still, Math.max(1, ...p.reps.map(r => r.bots.length)));
      const part = { drill: p.drill, from: (Date.now() - out.started) / 1000, to: 0, reps: 0, done: 0 };
      out.parts.push(part);
      const until = p.seconds ? Date.now() + p.seconds * 1000 : Infinity;
      for (let i = 0; !cancelled() && (p.seconds ? Date.now() < until : i < p.reps.length); i++) {
        const rep = p.reps[i % p.reps.length];
        part.reps++;
        let tries = 0, finished = false;
        while (!finished && tries < 2 && !cancelled()) {
          tries++;
          const before = gsi.me();
          // bots first, then me: they face me as soon as I land
          await session.send(place(rep));
          await sleep(150);
          await session.send([`setpos ${fmt(rep.me)}`, `setang ${rep.ang[0]} ${rep.ang[1]} 0`]);
          status({ phase: 'running', drill: p.drill, rep: part.reps, reps: p.seconds ? null : p.reps.length, left: p.seconds ? Math.max(0, Math.round((until - Date.now()) / 1000)) : null, tag: rep.tag, live: useGsi, done, total });
          const repEnd = Date.now() + (useGsi ? REP_SECONDS : TIMED_REP_SECONDS) * 1000;
          let died = false;
          let back = Date.now() + 5000; // tracking: a dodging bot drifts, put it back on its spot now and then
          while (Date.now() < repEnd && !cancelled()) {
            await sleep(150);
            if (!session.sock) throw new Error('CS2 closed during the training.');
            if (p.seconds && Date.now() >= until) break;
            const now = gsi.me();
            if (useGsi && now && before) {
              if (now.kills - before.kills >= rep.bots.length) { finished = true; break; }
              if (now.deaths > before.deaths) { died = true; break; }
            }
            if (d.strafe && Date.now() > back) { back = Date.now() + 5000; await session.send(place(rep)); }
          }
          if (!useGsi) finished = true;
          if (finished) { part.done++; done++; }
          if (died) await sleep(2200); // my respawn
          if (!finished && !died) break; // ran out of time: next rep
          await sleep(finished ? RESPAWN_WAIT : 300);
        }
      }
      part.to = (Date.now() - out.started) / 1000;
    }
  };
  try {
    if (plan.scenarios || plan.scenario) await scenarioRun(plan.scenarios || [plan.scenario], plan.mix || plan.scenario.options);
    else await drillParts();
  } finally {
    // also when the session fails half way: leave CS2 the way it was found
    if (session.sock) {
      try {
        await stopRecording();
        await session.send(['bot_kick', `mp_bot_ai_bt "${brainBefore || ''}"`, 'mp_respawn_on_death_t 0', 'noclip 0', `engine_no_focus_sleep ${/^\d+$/.test(sleepBefore || '') ? sleepBefore : 20}`, ...RESET]);
      } catch {}
    }
  }
  out.ended = Date.now();
  if (out.quit && session.sock) {
    await sleep(1000);
    await session.send(['quit']).catch(() => {});
  }
  return out;
}

// ---------- recording a scenario in CS2 ----------
// A practice server on the map (buy anywhere, no bots) and keys bound for the session: each one
// echoes a marker then getpos_exact (feet + view angles) and getpos (eyes: crouched when they're
// low), which come back through the console. The gun I hold comes from Game State Integration. The
// keys get their old binds back at the end (and at the next start when CS2 closed meanwhile).
const REC_KEYS = { F5: 'bot', F6: 'me', F7: 'undo', F8: 'test' };
const REC_SAID = { bot: 'add a bot where I stand, aiming where I aim', me: 'my start spot', undo: 'remove the last bot', test: 'teleport me to my start' };
const NOT_A_GUN = /knife|bayonet|grenade|flashbang|smoke|molotov|decoy|c4|taser|healthshot|fists|melee|tablet|shield|snowball|breachcharge/;
const CROUCH_EYES = 56; // standing eyes are 64 above the feet, crouched 46

// What CS2 says a key is bound to: the command, '' when unbound, null when it didn't say.
async function bindOf(session, key) {
  const from = session.seen;
  await session.send([`bind ${key}`]);
  await sleep(300);
  const text = session.since(from);
  const m = new RegExp(`"?${key}"?\\s*(?:=|is bound to)\\s*"([^"\\r\\n]*)"`, 'i').exec(text);
  if (m) return m[1] === '<unbound>' ? '' : m[1];
  return new RegExp(`${key}.*not bound|unbound`, 'i').test(text) ? '' : null;
}
const rebind = binds => Object.entries(binds).map(([k, v]) => (v ? `bind ${k} "${v}"` : `unbind ${k}`));

async function runRecorder(plan, io) {
  const { session, gsi, log, status, cancelled, rec } = io;
  status({ phase: 'loading', message: `Loading ${plan.map}…` });
  const left = io.binds.pending();
  if (left && session.sock) { await session.send(rebind(left)); io.binds.save(null); }
  await session.send([...RESET, ...gameMode()]);
  await io.loadMap(plan.map, `map ${plan.map}`);
  if (cancelled()) return null;
  await session.send([...RESET, 'bot_kick', 'mp_warmup_end', 'mp_humanteam CT', 'mp_autoteambalance 0', 'mp_limitteams 0', 'mp_ignore_round_win_conditions 1',
    'mp_roundtime 60', 'mp_roundtime_defuse 60', 'mp_freezetime 0', 'mp_respawn_on_death_ct 1', 'mp_respawn_immunitytime 0', 'mp_buy_anywhere 1', 'mp_buytime 9999',
    'mp_maxmoney 60000', 'mp_startmoney 60000', 'sv_infinite_ammo 1', 'mp_restartgame 1']);
  await sleep(1500);
  await session.send(['jointeam 3 1']);
  await sleep(800);

  const before = {};
  for (const k of Object.keys(REC_KEYS)) before[k] = await bindOf(session, k);
  log(`recorder: binds before ${JSON.stringify(before)}`);
  // a key CS2 didn't tell the bind of gets unbound at the end
  const restore = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v || '']));
  io.binds.save(restore);
  await session.send(Object.entries(REC_KEYS).map(([k, what]) => `bind ${k} "echo demolab_rec_${what};getpos_exact;getpos"`));
  await session.send(['echo', 'echo ---- DemoLab: F5 = bot here, F6 = my start, F7 = undo, F8 = teleport test ----', 'echo']);

  const say = text => session.send([`say "[DemoLab] ${text.replace(/"/g, "'")}"`]).catch(() => {});
  const show = (extra = {}) => status({ phase: 'recording', message: null, keys: REC_SAID, bots: rec.bots.length, me: !!rec.me, ...extra });
  show();
  let from = session.seen, text = '', beep = 0, waiting = 0;
  try {
    while (!cancelled()) {
      await sleep(120);
      if (!session.sock) throw new Error('CS2 closed during the recording.');
      text += session.since(from);
      from = session.seen;
      let m;
      while ((m = /demolab_rec_(bot|me|undo|test)\b/.exec(text))) {
        const rest = text.slice(m.index + m[0].length);
        const exact = /setpos_exact[^\n]*\n/.test(rest) ? parseExact(rest) : null;
        const eyes = /\bsetpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)[^\n]*\n/.exec(rest);
        const what = m[1];
        // getpos's answers come a moment after the marker: wait for them (1 s at most)
        if ((what === 'bot' || what === 'me') && (!exact || !eyes)) {
          if (!waiting) waiting = Date.now();
          if (Date.now() - waiting < 1000) break;
        }
        waiting = 0;
        text = rest;
        if (what === 'undo') {
          const b = rec.bots.pop();
          say(b ? `bot ${rec.bots.length + 1} removed` : 'no bot to remove');
        } else if (what === 'test') {
          if (!rec.me) say('no start spot yet: F6 where you want to start');
          else { say('teleport test'); if (!await teleport(session, log, rec.me.pos, rec.me.yaw, true)) say('the teleport missed: see the log'); }
        } else if (!exact) {
          log(`recorder: no getpos_exact answer for ${what}`);
          say('CS2 did not tell where you are: press it again');
        } else {
          const drop = eyes ? Number(eyes[3]) - exact.pos[2] : null;
          const pos = exact.pos.map(v => Math.round(v));
          const [pitch, yaw] = exact.ang;
          if (what === 'me') {
            rec.me = { pos, yaw: Math.round(yaw) };
            say('start spot saved');
          } else if (rec.bots.length >= 10) {
            say('10 bots already: F7 removes the last one');
          } else {
            const crouch = drop != null && drop > 20 && drop < CROUCH_EYES;
            const eye = [exact.pos[0], exact.pos[1], exact.pos[2] + (crouch ? 46 : 64)];
            const active = Object.values(gsi.state?.player?.weapons || {}).find(w => w.state === 'active')?.name || '';
            const gun = active.replace(/^weapon_/, '');
            const weapon = gun && !NOT_A_GUN.test(gun) ? gun : '';
            rec.bots.push({ pos, look: io.aim(eye, pitch, yaw).map(v => Math.round(v)), crouch, weapon, shoot: true, jiggle: 0 });
            if (rec.bots.length === 1) log(`recorder: eyes ${drop?.toFixed(1)} above the feet, gun "${active}" (game state ${gsi.alive() ? 'on' : 'off'})`);
            say(`bot ${rec.bots.length} saved${crouch ? ', crouched' : ''}${weapon ? `, ${weapon}` : ''}`);
          }
        }
        show({ beep: ++beep });
      }
      if (text.length > 20000) text = text.slice(-4000);
    }
  } finally {
    if (session.sock) {
      try { await session.send([...rebind(restore), ...RESET]); io.binds.save(null); } catch {}
    }
  }
  return { me: rec.me, bots: rec.bots };
}

const newToken = () => crypto.randomBytes(12).toString('hex');

module.exports = { Gsi, runTraining, runRecorder, REC_KEYS, parseStatus, parseGetpos, parseHighscore, newToken, WEAPONS, RESET };
