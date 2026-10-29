// The bots' brains for the training drills: CS2 behavior trees (KV3 text, the format of the game's own
// scripts/ai/*.kv3), written to <csgo>/scripts/ai/demolab/ and picked with mp_bot_ai_bt before the
// bots join. Unlike bot_stop / bot_freeze, which switch a bot's AI off (it then neither turns nor
// shoots), these keep the bot thinking but give it no way to walk:
//   hold    stays on its spot, faces the nearest enemy (through walls, so it holds the angle the player
//           comes from), shoots once it sees them
//   still   the same without shooting (pre-aim, crosshair placement, counter-strafe targets)
//   strafe  doesn't shoot either, but dodges left and right like in a duel (tracking)
// config_<level>.kv3: aim and reaction speed, 0 easy … 3 expert.
// Scenario bots (lib/scenarios.js) get a tree each, with their spot and the point they hold written in:
// they walk back to the spot when they're off it and look at that point (not at the player through
// walls), shoot or not, crouched or not, jiggle (step left and right across the angle until they see
// the player, then stop to shoot), with the gun they're given.
const fs = require('fs');
const path = require('path');

const DIR = 'scripts/ai/demolab';
const HEAD = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n';

// Enemies the bot sees, remembered for a moment (what "shoot once it sees them" reacts to).
const VISION = `{
	type = "decorator_sensor"
	shape = { type = "sensor_shape_fov" }
	entity_type_filter = "PLAYERS"
	team_filter = "ENEMY"
	output = "Vision"
	priority = 0
	child =
	{
		type = "decorator_picker_visible"
		input = "Vision"
		child =
		{
			type = "decorator_set_reaction_time"
			input = "Vision"
			child = { type = "decorator_memory" input = "Vision" output = "ShortTermAttackMemory" }
		}
	}
}`;
// The enemy to deal with now: seen, reaction time passed.
const enemy = child => `{
	type = "decorator_picker_reaction_time"
	input = "ShortTermAttackMemory"
	output = "Enemy"
	child =
	{
		type = "decorator_ranker_dist"
		input = "Enemy"
		child =
		{
			type = "decorator_picker_max_score"
			input = "Enemy"
			child = { type = "condition_is_empty" input = "Enemy" negated = 1 child = ${child} }
		}
	}
}`;
const ATTACK = enemy(`{
	type = "parallel"
	children =
	[
		{ type = "action_equip_weapon" weapon = "BEST" },
		{ type = "decorator_repeat" child = { type = "action_aim" input = "Enemy" ready = "AimReady" } },
		{ type = "decorator_repeat" child = { type = "action_attack" input = "Enemy" output = "Attacking" ready = "AimReady" } }
	]
}`);
const DODGE = enemy(`{
	type = "parallel"
	children =
	[
		{ type = "decorator_repeat" child = { type = "action_aim" input = "Enemy" ready = "AimReady" } },
		{ type = "decorator_repeat" child = { type = "action_combat_positioning" input = "Enemy" is_attacking = "Dodging" } }
	]
}`);
// Faces the nearest enemy wherever they are: a bot holding an angle looks where the player will appear.
const FACE = `{
	type = "sequencer"
	children =
	[
		{
			type = "decorator_sensor"
			entity_type_filter = "PLAYERS"
			team_filter = "ENEMY"
			output = "Watch"
			child = { type = "decorator_ranker_dist" input = "Watch" child = { type = "decorator_picker_max_score" input = "Watch" } }
		},
		{ type = "action_look_at" input_location = "Watch" }
	]
}`;

function tree(level, busy, idle = FACE, also = null, prep = null) {
	const more = [also].flat().filter(Boolean).map(x => `,
				{ type = "decorator_repeat" child = ${x} }`).join('');
	const main = `{
			type = "parallel"
			children =
			[
				{ type = "decorator_repeat" child = ${VISION} },
				{ type = "decorator_repeat" child = { type = "selector" children = [ ${busy ? `${busy}, ` : ''}${idle} ] } }${more}
			]
		}`;
	return `${HEAD}{
	config = "${DIR}/config_${level}.kv3"
	root =
	{
		type = "decorator_bot_service"
		memory_to_expire = [ { key = "ShortTermAttackMemory" time = 0.7 distance = 0 }, { key = "HeardMemory" time = ${HEARD_SECONDS} distance = 0 } ]
		child = ${prep ? `{ type = "sequencer" children = [ ${prep}, ${main} ] }` : main}
	}
}
`;
}

// Per level: [acquisition lerp, its deviation, angle penalty, ready tolerance, max aim duration, reaction time, burst (rifle seconds)]
const LEVELS = [
  [0.6, 0.1, 12, 25, 0.9, 0.55, 0.1],
  [0.35, 0.08, 7, 10, 0.75, 0.32, 0.15],
  [0.18, 0.05, 4, 3, 0.6, 0.18, 0.2],
  [0.1, 0.02, 3, 1, 0.45, 0.08, 0.3],
];
function config(level) {
  const [lerp, dev, penalty, ready, aimMax, reaction, burst] = LEVELS[level];
  const no = '[ -1.0, -1.0, -1.0, -1.0, -1.0 ]';
  return `${HEAD}{
	default =
	{
		aim_target_acquisition_lerp_time = ${lerp}
		aim_target_acquisition_lerp_time_deviation = ${dev}
		aim_target_acquisition_angle_penalty = ${penalty}
		aim_target_acquisition_angle_penalty_deviation = 1.5
		aim_target_acquisition_angle_penalty_reduction_ratio = 0.2
		aim_target_acquisition_angle_tolerance = 1.0
		aim_target_acquisition_angle_lerp_bias = 0.3
		aim_target_tracking_lerp_time = 0.12
		aim_target_tracking_lerp_time_deviation = 0.05
		aim_target_tracking_focus_interval = 0.06
		aim_target_tracking_focus_interval_deviation = 0.02
		aim_target_tracking_angle_lerp_bias = 0.3
		aim_ready_angle_tolerance = ${ready}
		aim_new_target_angle_tolerance = 30.0
		aim_max_duration = ${aimMax}
		aim_max_duration_deviation = 0.2
		aim_punch_angle_reaction_chance = 0.9
		look_around_awareness_yaw_range = 60
		look_around_awareness_pitch_range = 20
		look_around_focus_interval = 0.4
		look_around_focus_interval_deviation = 0.1
		look_around_lerp_time = 0.12
		look_around_lerp_time_deviation = 0.03
		look_around_lerp_bias = 0.25
		reaction_time = ${reaction}
		combat_crouch_chance = 0.0
		combat_dodge_command_duration = 0.8
		combat_dodge_command_duration_deviation = 0.3
		attack =
		[
			// duration, duration deviation, cadence, cooldown, cooldown deviation
			// knife, pistol, submachine gun
			${no}, [ 0.15, 0.05, 0.15, 0.4, 0.05 ], [ 0.4, 0.07, 0.0, 0.15, 0.05 ],
			// rifle, shotgun, sniper rifle
			[ ${burst}, 0.05, 0.1, 0.2, 0.05 ], [ 0.25, 0.0, 0.0, 0.15, 0.05 ], [ 0.01, 0.0, 0.01, 0.01, 0.0 ],
			// machine gun, c4, taser
			[ 0.9, 0.3, 0.0, 0.15, 0.05 ], ${no}, ${no},
			// grenade, equipment, stackable item
			${no}, ${no}, ${no},
			// unknown
			${no}
		]
	}
}
`;
}

// Writes every brain for this level; returns { hold, still, strafe } as mp_bot_ai_bt values.
function installBrains(csgoDir, level = 2) {
  level = Math.max(0, Math.min(3, Math.round(level)));
  const dir = path.join(csgoDir, ...DIR.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    [`config_${level}.kv3`]: config(level),
    'hold.kv3': tree(level, ATTACK),
    'still.kv3': tree(level, null),
    'strafe.kv3': tree(level, DODGE),
  };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    try { if (fs.readFileSync(file, 'utf8') === text) continue; } catch {}
    fs.writeFileSync(file, text);
  }
  return { hold: `${DIR}/hold.kv3`, still: `${DIR}/still.kv3`, strafe: `${DIR}/strafe.kv3` };
}

const v3 = p => p.map(n => (+n).toFixed(1)).join(' ');
const moveTo = (p, eps, walk = false) => `{ type = "action_move_to" destination = "${v3(p)}" movement_type = "BT_ACTION_MOVETO_${walk ? 'WALK' : 'RUN'}" route_type = "BT_ACTION_MOVETO_FASTEST_ROUTE" arrival_epsilon = ${eps} auto_look_adjust = 0 }`;
// the stop at each end of a jiggle: around bot.jigglePause seconds (0.25 when not set), a bit random
const pause = bot => {
  const t = bot.jigglePause ?? 0.25;
  return `{ type = "action_wait" wait_time_min = ${(t * 0.6).toFixed(2)} wait_time_max = ${(t * 1.4 + 0.05).toFixed(2)} }`;
};
// Looking at the point it holds, never walking anywhere: it's put on its spot (setpos_player). A
// jiggling one steps back and forth between its two jiggle points (bot.jiggleAt, across the angle),
// after a wait: a bot plans its walk when it joins, from its spawn, and would follow that path back
// after being moved to its spot. bot.jiggleWalk: it walks (shift) between them instead of running. The look is re-aimed over and over (like FACE): aimed once, it kept
// the direction it had from its spawn, before being moved.
const holdAngle = bot => {
  const look = `{ type = "action_look_at" input_location = "${v3(bot.look)}" }`;
  return bot.jiggleAt ? `{
	type = "parallel"
	children =
	[
		{ type = "sequencer" children = [ { type = "action_wait" wait_time_min = 2 wait_time_max = 2 }, { type = "decorator_repeat" child = { type = "sequencer" children = [ ${moveTo(bot.jiggleAt[0], 8, bot.jiggleWalk)}, ${pause(bot)}, ${moveTo(bot.jiggleAt[1], 8, bot.jiggleWalk)}, ${pause(bot)} ] } } ] },
		{ type = "decorator_repeat" child = ${look} }
	]
}` : look;
};
// Hearing (every scenario bot; bot.hear: how far, in world units, 1200 when not set): the enemy noises around it (footsteps,
// shots, reloads, as the game's own bots hear them: scripts/ai/modules/bt_memorize_noises.kv3), kept
// HEARD_SECONDS; while it remembers one it turns to it (instead of holding its angle or jiggling), and
// shoots once it sees me. Heard at once, with no reaction time (that one is for seeing: with it on top
// of the footsteps' own spacing, it turned late), and its sensor first in line (priority 0).
const HEARD_SECONDS = 3;
const HEARING = radius => `{
	type = "decorator_sensor"
	shape = { type = "sensor_shape_sphere" radius = ${Math.round(radius)} }
	entity_type_filter = "NOISE"
	team_filter = "ENEMY"
	output = "Hearing"
	priority = 0
	child =
	{
		type = "decorator_picker_max_score"
		input = "Hearing"
		child = { type = "decorator_memory" input = "Hearing" output = "HeardMemory" }
	}
}`;
const REACT = `{
	type = "decorator_ranker_dist"
	input = "HeardMemory"
	child =
	{
		type = "decorator_picker_max_score"
		input = "HeardMemory"
		child = { type = "condition_is_empty" input = "HeardMemory" negated = 1 child = { type = "action_look_at" input_location = "HeardMemory" } }
	}
}`;

// Its gun instead of the default one (weapon id without "weapon_", e.g. "awp"), once, when it joins.
const loadout = weapon => `{ type = "decorator_succeed" child = { type = "action_acquire_items" items = [ "item_assaultsuit", "weapon_knife", "weapon_${weapon}" ] remove_all_items = 1 } },
	{ type = "decorator_succeed" child = { type = "action_equip_weapon" weapon = "BEST" } }`;

// One tree per scenario bot: [{ pos, look, shoot, crouch, weapon, jiggleAt, jigglePause, jiggleWalk, level, hear }]
// (level: its own aim and reaction speed, else the session's). The file names carry a fresh tag (CS2 may
// keep a tree it already loaded), older scenario trees are removed. Returns the mp_bot_ai_bt values.
function installScenarioBrains(csgoDir, level, bots) {
  const lv = l => Math.max(0, Math.min(3, Math.round(l)));
  const dir = path.join(csgoDir, ...DIR.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^sc_/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  for (const l of new Set(bots.map(b => lv(b.level ?? level)))) fs.writeFileSync(path.join(dir, `config_${l}.kv3`), config(l));
  const tag = Date.now().toString(36);
  return bots.map((b, i) => {
    const name = `sc_${tag}_${i + 1}.kv3`;
    const busy = [b.shoot ? ATTACK : null, REACT].filter(Boolean).join(', ');
    const also = [b.crouch ? '{ type = "action_crouch" }' : null, HEARING(b.hear || 1200)];
    fs.writeFileSync(path.join(dir, name), tree(lv(b.level ?? level), busy, holdAngle(b), also, b.weapon ? loadout(b.weapon) : null));
    return `${DIR}/${name}`;
  });
}

module.exports = { installBrains, installScenarioBrains, tree, config };