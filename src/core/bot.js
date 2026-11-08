// Bot AI: perception (FOV + LOS + hearing), navigation, combat, cover, reload
// and light team coordination. Everything here is deterministic given a seeded
// RNG, so difficulty behaviour can be measured in headless simulations.

import { PLAYER, MATCH } from './config.js';
import { moveCircle, losClear } from './collision.js';
import { eyePoint, bodyRadius, hitVolumes } from './actor.js';
import { directionFromAngles, performShot, anglesTo, castShot } from './combat.js';
import { activeWeapon, updateWeapon, startReload, tryShoot, releaseTrigger, switchWeapon, cancelReload } from './weapon.js';
import { ROUTES, ENEMY_SPAWN_AREA, SPAWNS, laneForMirroredSlot } from './map.js';
import { getCoverPoints, pickCoverFor, hiddenFrom } from './cover.js';
import { registerDamage } from './match.js';

export const BOT_STATE = {
  SPAWN: 'spawn',
  ADVANCE: 'advance',
  ENGAGE: 'engage',
  INVESTIGATE: 'investigate',
  RELOAD: 'reload',
  RETREAT: 'retreat',
  HOLD: 'hold',
  DEAD: 'dead',
};

export function createBrain(actor, profile, { rng = Math.random, lane = 'mid' } = {}) {
  const brain = {
    actor,
    profile,
    state: BOT_STATE.SPAWN,
    lane,
    rng,
    // perception
    target: null,
    targetVisible: false,
    lastSeen: null, // {x,z,time}
    lastSeenTime: -999,
    reactionTimer: 0,
    trackTimer: 0,
    aimRamp: 0,
    aimErrorYaw: 0,
    aimErrorPitch: 0,
    aimErrorNext: 0,
    recoilAccum: 0,
    // navigation
    path: [],
    pathGoal: null,
    repathTimer: 0,
    stuckTimer: 0,
    lastX: 0,
    lastZ: 0,
    laneIndex: 0,
    // combat
    burstLeft: 0,
    burstPause: 0,
    strafeDir: 1,
    strafeTimer: 0,
    decisionTimer: 0,
    investigateTimer: 0,
    coverTarget: null,
    // Cover: the spot we are crouching behind and the enemy it hides us from.
    // `coverThreatId` is deliberately an id, not a live position: the bot only
    // keeps using a spot while the threat is still roughly where it was.
    coverSpot: null,
    coverThreatId: 0,
    coverUntil: 0,
    coverPeek: 0,
    coverHold: 0,
    coverCooldown: 0,
    // Ally support: remember who called for help and how long we are helping.
    supportUntil: 0,
    supportId: 0,
    supportCall: null,
    supportCooldown: 0,
    helpCalls: 0,
    // status flags for HUD/debug
    statusText: 'hazır',
    shots: 0,
    hits: 0,
    reset(actorAtSpawn) {
      this.state = BOT_STATE.SPAWN;
      this.target = null;
      this.targetVisible = false;
      this.lastSeen = null;
      this.lastSeenTime = -999;
      this.reactionTimer = 0;
      this.aimRamp = 0;
      this.aimErrorYaw = (rng() * 2 - 1) * profile.aimError * 0.5;
      this.aimErrorPitch = (rng() * 2 - 1) * profile.aimError * 0.5;
      this.path = [];
      this.pathGoal = null;
      this.repathTimer = 0;
      this.stuckTimer = 0;
      this.laneIndex = 0;
      this.burstLeft = profile.burstShots;
      this.burstPause = 0;
      this.decisionTimer = 0;
      this.investigateTimer = 0;
      this.coverTarget = null;
      this.holdTimer = 0;
      this.pushTimer = 0;
      this.sweepTimer = 0;
      this.detourUntil = 0;
      this.coverSpot = null;
      this.coverThreatId = 0;
      this.coverUntil = 0;
      this.coverPeek = 0;
      this.coverHold = 0;
      this.coverCooldown = 0;
      this.supportUntil = 0;
      this.supportId = 0;
      this.supportCall = null;
      this.supportCooldown = 0;
      this.helpCalls = 0;
      this.shots = 0;
      this.hits = 0;
      this.statusText = 'hazır';
      if (actorAtSpawn) {
        this.lastX = actorAtSpawn.x;
        this.lastZ = actorAtSpawn.z;
      }
    },
  };
  brain.reset({ x: actor.x, z: actor.z });
  return brain;
}

/** Simple team coordinator: lanes + shared contacts, no cheating positions. */
export function createCoordinator() {
  return {
    contacts: {}, // team -> {targetId, x, z, time, by}
    lanes: { A: {}, B: {} },
    // Shared search zone per team: refreshed periodically so a squad that has
    // lost contact sweeps the same area instead of splitting across the map.
    hunt: { A: null, B: null },
    huntTimer: 0,
    // Recent contact positions ("hot areas"). Squads converge on the last place
    // a fight happened instead of sweeping random corners of the map.
    hot: [],
    // Ally calls for help: {team, by, x, z, time}. Teammates may always know
    // where their own squad is, so this leaks no enemy information.
    help: [],
    // Which cover point each teammate has claimed: {team, by, key, time}.
    // Without this the whole squad dives behind the same crate.
    claims: [],
  };
}

/** Claim a cover point for this bot (teammates then pick something else). */
export function claimCover(coordinator, bot, point, time) {
  if (!coordinator || !coordinator.claims) return;
  const key = `${point.x.toFixed(1)},${point.z.toFixed(1)}`;
  coordinator.claims = coordinator.claims.filter((c) => time - c.time < 8 && c.by !== bot.id && c.key !== key);
  coordinator.claims.push({ team: bot.team, by: bot.id, key, time });
  if (coordinator.claims.length > 20) coordinator.claims.shift();
}

/** True when a living teammate already claimed this cover point. */
export function coverClaimed(coordinator, bot, point, time) {
  if (!coordinator || !coordinator.claims) return false;
  const key = `${point.x.toFixed(1)},${point.z.toFixed(1)}`;
  return coordinator.claims.some((c) => c.team === bot.team && c.by !== bot.id && c.key === key && time - c.time < 8);
}

/**
 * Record that `ally` is in trouble. Everyone on the same team can see this, but
 * it carries only the ally's own position — never an enemy's.
 */
export function callForHelp(coordinator, ally, time) {
  if (!coordinator || !coordinator.help) return;
  coordinator.help = coordinator.help.filter((h) => time - h.time < 6 && h.by !== ally.id);
  coordinator.help.push({ team: ally.team, by: ally.id, x: ally.x, z: ally.z, time });
  if (coordinator.help.length > 8) coordinator.help.shift();
}

/** Newest unanswered call for help from `team` (excluding the caller). */
export function latestHelp(coordinator, team, time, selfId, maxAge = 5) {
  if (!coordinator || !coordinator.help) return null;
  for (let i = coordinator.help.length - 1; i >= 0; i--) {
    const h = coordinator.help[i];
    if (h.team !== team || h.by === selfId) continue;
    if (time - h.time <= maxAge) return h;
  }
  return null;
}

/** Remember where a contact was lost so the squad can converge there. */
export function markHot(coordinator, x, z, time) {
  if (!coordinator || !coordinator.hot) return;
  const recent = coordinator.hot[coordinator.hot.length - 1];
  if (recent && Math.hypot(recent.x - x, recent.z - z) < 6) {
    recent.time = time;
    return;
  }
  coordinator.hot.push({ x, z, time });
  if (coordinator.hot.length > 6) coordinator.hot.shift();
}

export function latestHot(coordinator, time, maxAge = 25) {
  if (!coordinator || !coordinator.hot) return null;
  for (let i = coordinator.hot.length - 1; i >= 0; i--) {
    const h = coordinator.hot[i];
    if (time - h.time <= maxAge) return h;
  }
  return null;
}

/**
 * Refresh the per-team search zone. This uses only map facts and the squad's own
 * (already stale) contact memory — never the live position of an enemy.
 */
export function refreshHuntZones(coordinator, grid, rng, match) {
  for (const team of ['A', 'B']) {
    const current = coordinator.hunt[team];
    const stale = !current || match.time - current.time > 6;
    if (!stale) continue;

    // 1) A recent fight: converge there (last known contact area).
    const hot = latestHot(coordinator, match.time, 25);
    if (hot) {
      const spot = grid.randomWalkable(rng, { minX: hot.x - 7, maxX: hot.x + 7, minZ: hot.z - 7, maxZ: hot.z + 7 });
      coordinator.hunt[team] = { x: spot.x, z: spot.z, time: match.time };
      continue;
    }
    const elapsed = match.roundElapsed || 0;
    if (elapsed > 26) {
      // 2) The round is dragging with no contact at all. Both squads fall back
      // to sweeping the middle of the map — a pure map fact both teams know, so
      // this leaks nothing — and the sweep ladder walks the centre so a round
      // cannot end with the two squads having swapped spawns and missed.
      const step = Math.floor((elapsed - 26) / 5);
      const ladder = [
        [0, 0], [-6, 6], [7, -6], [2, 10], [-8, -9],
      ];
      const [lx, lz] = ladder[step % ladder.length];
      const side = team === 'A' ? -1 : 1;
      const spot = grid.randomWalkable(rng, {
        minX: lx - 4 + side * 2,
        maxX: lx + 4 + side * 2,
        minZ: lz - 4,
        maxZ: lz + 4,
      });
      coordinator.hunt[team] = { x: spot.x, z: spot.z, time: match.time };
      continue;
    }
    // 3) No fight yet: sweep the middle, then drift toward the enemy side.
    const towardEnemy = team === 'A' ? 1 : -1;
    const drift = Math.min(14, elapsed * 0.35) * towardEnemy;
    const spot = grid.randomWalkable(rng, {
      minX: Math.max(-24, Math.min(24, drift - 10)),
      maxX: Math.max(-24, Math.min(24, drift + 10)),
      minZ: -14,
      maxZ: 14,
    });
    coordinator.hunt[team] = { x: spot.x, z: spot.z, time: match.time };
  }
}

// Lane assignment lives in map.js next to ROUTES, because whether two lanes are
// mirror images is a map fact, not an AI decision. Keep the derivation here so
// the AI still records each bot's slot for jitter/spread purposes.
//
// The slot must come from the spawn row, never from `actor.index`: the human
// player occupies ALFA's index 0, so index-based slots pushed every ALFA bot one
// slot up and put every BRAVO bot on slot 0.
export function laneSlot(actor) {
  const row = SPAWNS[actor.team];
  if (!row || !Number.isFinite(actor.spawnZ)) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < row.length; i++) {
    const d = Math.abs(row[i].z - actor.spawnZ);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Where the squad should sweep next. Uses only the team's shared search zone
 * (map facts + stale contacts), so it never leaks a live enemy position. The
 * squads are deliberately aimed at each other's half, which is what makes a
 * contact-free round converge instead of circling.
 */
export function squadSweepGoal(coordinator, bot, grid) {
  const zone = coordinator.hunt[bot.team];
  const hz = zone || ENEMY_SPAWN_AREA[bot.team];
  // Spread the squad around the zone in a loose line rather than stacking on the
  // exact same cell; the offsets are staggered by slot, not random, so the squad
  // keeps its shape while it moves.
  const offX = ((bot.index % 3) - 1) * 3.4;
  const offZ = (Math.floor(bot.index / 3) - 0.5) * 4.0;
  const cell = grid.nearestWalkable(hz.x + offX, hz.z + offZ);
  if (!cell) return null;
  return grid.cellCenter(cell.c, cell.r);
}

export function assignLanes(match, coordinator) {
  for (const team of ['A', 'B']) {
    const bots = match.actors.filter((a) => a.team === team && a.brain);
    coordinator.lanes[team] = {};
    const order = bots.slice().sort((a, b) => laneSlot(a) - laneSlot(b));
    for (const bot of order) {
      const lane = laneForMirroredSlot(team, laneSlot(bot));
      bot.brain.lane = lane;
      coordinator.lanes[team][bot.id] = lane;
    }
  }
}

function rngRange(brain, min, max) {
  return min + brain.rng() * (max - min);
}

function wrapAngle(a) {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  if (r < -Math.PI) r += t;
  return r;
}

/**
 * Where a bot aims on an enemy's body.
 *
 * Bots used to aim at the *eye* point, which is inside the head sphere: every
 * single shot at any range was a headshot (measured: 7/7 at 4-34 m), so a
 * normal bot killed the player with ~0.3 s of contact. Aiming at the chest is
 * what a human does; the difficulty then decides how far up the aim creeps.
 * The head is still reachable, it just has to be earned.
 */
export function aimPoint(bot, target) {
  const profile = bot.brain ? bot.brain.profile : null;
  // 0 = middle of the chest, 1 = head centre. Bots start at the body and settle
  // a little higher as their aim ramps up, but the difficulty decides the rest.
  const base = profile ? headBias(profile) : 0.2;
  const bias = Math.min(1, base + 0.2 * base * (bot.brain ? bot.brain.aimRamp : 0));
  // Actors have no y field: they stand on the floor, so heights are absolute.
  // The chest height is interpolated through the crouch blend rather than
  // snapped at a threshold: `crouch` ramps from 0 to 1 over ~100ms, and a hard
  // `crouch > 0.5` test made the whole aim point jump ~34 cm in one frame the
  // instant a target crossed the midpoint — a bot would miss high for that
  // frame no matter how well it was tracking.
  const eyeY = eyePoint(target).y;
  const standingChest = PLAYER.chestHeight;
  const crouchedChest = PLAYER.crouchChestHeight;
  const chestY = standingChest + (crouchedChest - standingChest) * target.crouch;
  return { x: target.x, y: chestY + (eyeY - chestY) * bias, z: target.z };
}

/** How far up the body the profile aims, before aim-ramp (0 = chest, 1 = head). */
function headBias(profile) {
  return Math.max(0, Math.min(1, profile.headBias ?? 0.2));
}

/** Can `bot` see `target`? FOV cone + world LOS. No knowledge of unseen actors. */
export function canSee(bot, target, boxes) {
  if (!target.alive || target.team === bot.team) return false;
  const profile = bot.brain.profile;
  const eye = eyePoint(bot);
  const tEye = eyePoint(target);
  const dx = tEye.x - eye.x;
  const dz = tEye.z - eye.z;
  const dist = Math.hypot(dx, dz);
  if (dist > profile.viewDistance) return false;
  const toTargetYaw = Math.atan2(dx, -dz);
  const delta = Math.abs(wrapAngle(toTargetYaw - bot.yaw));
  // Close range always counts (someone standing on top of you), otherwise cone.
  if (dist > 2.2 && delta > (profile.fov * Math.PI) / 360) return false;
  // Nothing blocks the chest or the head.
  const chest = { x: target.x, y: tEye.y - 0.45, z: target.z };
  if (losClear(eye, chest, boxes)) return true;
  return losClear(eye, tEye, boxes);
}

function visibleEnemies(match, bot, boxes) {
  const out = [];
  for (const a of match.actors) {
    if (a.team === bot.team || !a.alive) continue;
    if (canSee(bot, a, boxes)) out.push(a);
  }
  return out;
}

function chooseTarget(bot, visible) {
  if (!visible.length) return null;
  const eye = eyePoint(bot);
  let best = visible[0];
  let bestScore = Infinity;
  for (const v of visible) {
    const d = Math.hypot(v.x - eye.x, v.z - eye.z);
    // Prefer the closest threat, and whoever is currently shooting at us.
    // The human gets no extra "focus me" weight or penalty.
    const score = d - (v.lastAttackerId === bot.id ? 3 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

function setPathTo(bot, grid, x, z) {
  const brain = bot.brain;
  brain.path = grid.findPath(bot.x, bot.z, x, z);
  brain.pathGoal = { x, z };
  brain.repathTimer = 1.2;
}

/**
 * Walk to a temporary goal (cover, squad sweep, spawn hunt) for `secs` seconds.
 * ADVANCE honours this instead of immediately pathing back to the lane.
 */
function setDetour(bot, grid, x, z, match, secs = 6) {
  setPathTo(bot, grid, x, z);
  bot.brain.detourUntil = (match.time || 0) + secs;
}

function routePoint(bot, lane, index) {
  const routes = ROUTES[bot.team] && ROUTES[bot.team][lane];
  if (!routes || !routes.length) return null;
  return routes[Math.min(index, routes.length - 1)];
}

/** Pick a route waypoint for advancing, with per-bot lane offsets against clumping. */
function advanceGoal(bot, grid) {
  const brain = bot.brain;
  const lane = brain.lane;
  const route = routePoint(bot, lane, brain.laneIndex);
  if (!route) return null;
  const slot = laneSlot(bot);
  const jitterX = ((slot % 3) - 1) * 1.6;
  const jitterZ = (slot % 2 === 0 ? 1 : -1) * 1.2;
  const gx = route.x + jitterX;
  const gz = route.z + jitterZ;
  const cell = grid.nearestWalkable(gx, gz);
  if (!cell) return { x: route.x, z: route.z };
  const c = grid.cellCenter(cell.c, cell.r);
  return { x: c.x, z: c.z };
}

/** Distance to the current lane waypoint (used to decide if it was really reached). */
function advanceGoalDistance(bot, grid) {
  const goal = advanceGoal(bot, grid);
  if (!goal) return Infinity;
  return Math.hypot(goal.x - bot.x, goal.z - bot.z);
}

function tryAdvanceLane(bot) {
  const brain = bot.brain;
  const route = ROUTES[bot.team][brain.lane];
  if (!route) return;
  if (brain.laneIndex < route.length - 1) brain.laneIndex += 1;
}

/** Move the bot along its path; returns true when it reached the goal. */
function followPath(bot, grid, boxes, dt, speedMul = 1) {
  const brain = bot.brain;
  if (!brain.path.length) return true;
  const wp = brain.path[0];
  const dx = wp.x - bot.x;
  const dz = wp.z - bot.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.65) {
    brain.path.shift();
    if (!brain.path.length) return true;
    return false;
  }
  let speed = PLAYER.walkSpeed * 0.92 * speedMul;
  if (brain.state === BOT_STATE.RETREAT) speed *= 1.12;
  if (brain.targetVisible) speed *= 0.68; // slow down while shooting
  const stepX = (dx / dist) * speed * dt;
  const stepZ = (dz / dist) * speed * dt;
  const moved = moveCircle(bot.x, bot.z, stepX, stepZ, PLAYER.radius, boxes);
  bot.x = moved.x;
  bot.z = moved.z;
  bot.speedFactor = Math.min(1, speed / PLAYER.walkSpeed);

  // Stuck detection: if we barely moved while trying to, repath.
  const progress = Math.hypot(bot.x - brain.lastX, bot.z - brain.lastZ);
  brain.lastX = bot.x;
  brain.lastZ = bot.z;
  if (progress < 0.012) {
    brain.stuckTimer += dt;
    if (brain.stuckTimer > 0.7) {
      brain.stuckTimer = 0;
      if (brain.pathGoal) setPathTo(bot, grid, brain.pathGoal.x, brain.pathGoal.z);
      else brain.path = [];
    }
  } else {
    brain.stuckTimer = 0;
  }
  // Face the movement direction when not engaging.
  if (!brain.targetVisible) {
    bot.yaw = Math.atan2(dx, -dz);
    bot.pitch = 0;
  }
  return false;
}

/** Combat: turn toward target with profile speed, fire when aligned. */
function combatTick(match, bot, dt, ctx) {
  const brain = bot.brain;
  const profile = brain.profile;
  const target = brain.target;
  if (!target || !target.alive) {
    brain.targetVisible = false;
    return;
  }
  const a = bot;
  const eye = eyePoint(a);
  const angles = anglesTo(eye, aimPoint(a, target));

  // Recoil climb decays between bursts (and inside long pauses).
  brain.recoilAccum = Math.max(0, (brain.recoilAccum || 0) - profile.recoilAimKick * 2.6 * dt);

  // Aim error: persistent offset that drifts, shrinking as the bot keeps track.
  brain.aimErrorNext -= dt;
  if (brain.aimErrorNext <= 0) {
    brain.aimErrorNext = rngRange(brain, 0.4, 1.1);
    const spread = profile.aimError * (1 - 0.22 * brain.aimRamp);
    brain.aimErrorYaw = (brain.rng() * 2 - 1) * spread * (Math.PI / 180);
    brain.aimErrorPitch = (brain.rng() * 2 - 1) * spread * 0.6 * (Math.PI / 180);
  }
  // Movement makes them shakier, aiming ramps up accuracy.
  const movementPenalty = 1 + bot.speedFactor * 0.8;
  const desiredYaw = angles.yaw + brain.aimErrorYaw * movementPenalty;
  const desiredPitch = Math.max(-0.6, Math.min(0.6, angles.pitch + brain.aimErrorPitch * movementPenalty));

  const turn = profile.aimSpeed * dt;
  const dyaw = wrapAngle(desiredYaw - a.yaw);
  // Record the shortest angular error so tests can assert "a bot must turn
  // toward the target, never away from it".
  brain.lastTurnError = dyaw;
  a.yaw = wrapAngle(a.yaw + Math.max(-turn, Math.min(turn, dyaw)));
  const dpitch = desiredPitch - a.pitch;
  a.pitch += Math.max(-turn, Math.min(turn, dpitch));

  brain.aimRamp = Math.min(1, brain.aimRamp + dt / Math.max(0.1, profile.aimRamp));

  const w = activeWeapon(a.loadout);
  // Reload logic: never fire an empty gun, sometimes top up while unseen.
  if (w.mag <= 0) {
    if (w.reserve > 0) startReload(w);
    else switchWeapon(a.loadout, 'pistol');
    brain.state = BOT_STATE.RELOAD;
    brain.statusText = 'şarjör değiştiriyor';
    return;
  }
  if (brain.burstPause > 0) {
    brain.burstPause = Math.max(0, brain.burstPause - dt);
    releaseTrigger(w);
    return;
  }

  const aimErrorDeg = Math.abs(wrapAngle(angles.yaw - a.yaw)) * (180 / Math.PI) +
    Math.abs(angles.pitch - a.pitch) * (180 / Math.PI);
  const ready = brain.reactionTimer <= 0 && brain.aimRamp > 0.25;
  const aligned = aimErrorDeg < profile.fireAngleTolerance + (1 - brain.aimRamp) * profile.aimError;
  if (brain.burstLeft <= 0 && brain.burstPause <= 0) {
    brain.burstLeft = profile.burstShots;
  }

  if (ready && aligned && brain.burstPause <= 0 && brain.burstLeft > 0) {
    // Recoil throws the rounds off the aim line. Without this a burst stays
    // pixel-accurate and every burst is a guaranteed headshot chain; the climb
    // is what makes bursts a trade-off instead of a free kill.
    const recoilKick = brain.recoilAccum || 0;
    const shot = tryShoot(w, {
      aimPitch: a.pitch + recoilKick * (Math.PI / 180),
      aimYaw: a.yaw,
      moving: bot.speedFactor > 0.3,
      ads: brain.aimRamp > 0.5,
      triggerHeld: w.triggerHeld,
      rng: brain.rng,
    });
    if (shot) {
      brain.shots++;
      // Climb through the burst: each round leaves a little higher than the
      // last, and it decays back down between bursts (see combatTick). This is
      // what stops a burst from being four guaranteed headshots.
      brain.recoilAccum = Math.min(profile.recoilAimKick * 3,
        (brain.recoilAccum || 0) + profile.recoilAimKick);
      w.recoilPitch = 0; // the bot owns its climb; do not let it pile up here
      const dir = directionFromAngles(shot.yaw, shot.pitch);
      const result = performShot({ attacker: a, origin: eye, dir, actors: match.actors, boxes: ctx.boxes, weapon: w.def });
      if (result.hit) {
        brain.hits++;
        registerDamage(match, a, result.cast.actor, result.hit);
      }
      ctx.onShot && ctx.onShot({ shooter: a, shot, result, origin: eye, dir });
      if (ctx.onSound) ctx.onSound({ type: 'shot', x: a.x, z: a.z, team: a.team });
      // Burst control, different per difficulty.
      brain.burstLeft -= 1;
      if (brain.burstLeft <= 0) {
        brain.burstPause = profile.burstPause;
        releaseTrigger(w);
        brain.burstLeft = profile.burstShots;
      }
    }
  }
}

/**
 * Keep actors from standing inside each other. Pushes the bot out of any ally
 * (and the player) that is closer than `separateRadius`, using the same
 * box-aware movement as everything else, so it can never be shoved into a wall.
 */
export function separateFromOthers(match, bot, boxes, separateRadius = 0.92) {
  // Only true body overlap is resolved (2 * PLAYER.radius is ~0.84 m). A larger
  // radius would fight the path follower: in the narrow spawn door the bots have
  // to queue single file, and pushing them apart there just cancelled the
  // forward step and left the whole squad stuck in the corridor.
  let px = bot.x;
  let pz = bot.z;
  const myGoal = bot.brain && bot.brain.pathGoal;
  const myDist = myGoal ? Math.hypot(myGoal.x - px, myGoal.z - pz) : Infinity;
  for (const other of match.actors) {
    if (other === bot || !other.alive) continue;
    const dx = px - other.x;
    const dz = pz - other.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= separateRadius) continue;
    // Asymmetric on purpose: the actor that is further from its own goal yields.
    // Pushing both out at once made two bots in a corridor shove each other
    // backwards in a deadlock; this way the squad queues through doorways.
    if (!other.isPlayer) {
      const otherGoal = other.brain && other.brain.pathGoal;
      const otherDist = otherGoal ? Math.hypot(otherGoal.x - other.x, otherGoal.z - other.z) : Infinity;
      if (myDist <= otherDist) continue;
    }
    if (dist < 1e-4) {
      // Exactly stacked: pick a deterministic direction from the slot index.
      const ang = (bot.index + 1) * 2.399963;
      px += Math.sin(ang) * 0.02;
      pz += Math.cos(ang) * 0.02;
      continue;
    }
    // Push the full overlap out, mostly out of the way of the other actor.
    const push = separateRadius - dist;
    const moved = moveCircle(px, pz, (dx / dist) * push, (dz / dist) * push, PLAYER.radius, boxes);
    px = moved.x;
    pz = moved.z;
  }
  if (px !== bot.x || pz !== bot.z) {
    bot.x = px;
    bot.z = pz;
  }
}

/** Main bot update. */
/**
 * Decide whether to use cover, and which spot.
 *
 * Rules, in order:
 *  1. Only a bot that is actually being shot at (visible threat or recent damage)
 *     looks for cover — bots never pre-hide from a threat they cannot know about.
 *  2. The spot must really hide a crouched body from *that specific* threat
 *     (real raycast against the same boxes the player collides with).
 *  3. It is dropped as soon as the threat moves out of the tested direction, so a
 *     bot never stares at a wall hiding from someone who flanked it.
 *
 * Higher difficulties use cover more often and re-check it more eagerly; the
 * geometry test itself is identical for every difficulty (no cheating cover).
 */
function updateCoverDecision(match, bot, grid, boxes, ctx) {
  const brain = bot.brain;
  const prof = brain.profile;
  const threat = brain.targetVisible ? brain.target : null;
  const shotAt = bot.lastDamageAt > match.time - 1.2;
  if (!threat && !shotAt) {
    brain.coverSpot = null;
    brain.coverThreatId = 0;
    return;
  }
  // Cover is a "wounded" behaviour: a healthy bot keeps fighting and pushing
  // (hiding with full health just hands the enemy the initiative). While in
  // cover it still peeks out and shoots, so it never goes passive.
  const hurt = bot.health + bot.armor < (PLAYER.maxHealth + PLAYER.maxArmor) * 0.5;
  const dry = activeWeapon(bot.loadout).mag === 0;
  const wantsCover = threat && (hurt || dry) && brain.rng() < prof.coverUse * 0.5;
  if (!wantsCover) {
    if (brain.coverSpot && match.time > brain.coverUntil) brain.coverSpot = null;
    return;
  }
  // Cover may not stall the round: after a few seconds the bot gives it up and
  // re-joins the push even if it is still hurt.
  if (brain.coverSpot && match.time > brain.coverUntil) {
    brain.coverSpot = null;
    brain.coverCooldown = match.time + 8;
  }
  if (match.time < brain.coverCooldown) return;
  const threatId = threat ? threat.id : bot.lastAttackerId;
  // Keep the current spot while it still hides us from the same threat.
  if (brain.coverSpot && brain.coverThreatId === threatId && match.time < brain.coverUntil) {
    const moved = Math.hypot(brain.coverSpot.x - bot.x, brain.coverSpot.z - bot.z);
    if (moved >= 1.2) {
      // Still walking there. Re-pathing every tick would thrash the target (and
      // the previous version dropped the spot entirely, so bots never arrived).
      if (brain.path.length === 0) setDetour(bot, grid, brain.coverSpot.x, brain.coverSpot.z, match, 5);
      return;
    }
    const hideFrom = threat ? { x: threat.x, y: 1.55, z: threat.z } : brain.lastSeen ? { x: brain.lastSeen.x, y: 1.55, z: brain.lastSeen.z } : null;
    const stillHidden = hideFrom && hiddenFrom(brain.coverSpot.x, brain.coverSpot.z, hideFrom, boxes);
    if (stillHidden) {
      brain.coverSpot.hiding = true;
      return;
    }
    brain.coverSpot = null;
  }
  const points = getCoverPoints(grid);
  const hideFrom = threat || (brain.lastSeen ? { x: brain.lastSeen.x, z: brain.lastSeen.z } : null);
  let spot = pickCoverFor(bot, points, hideFrom);
  if (spot && coverClaimed(ctx.coordinator, bot, spot, match.time)) spot = null;
  if (!spot) {
    // Everything close is taken: stay near the squad but pick a different spot.
    for (const cand of points) {
      if (coverClaimed(ctx.coordinator, bot, cand, match.time)) continue;
      const d = Math.hypot(cand.x - bot.x, cand.z - bot.z);
      if (d > 14) continue;
      const threatPos = hideFrom;
      if (!threatPos) continue;
      if (!hiddenFrom(cand.x, cand.z, { x: threatPos.x, y: 1.55, z: threatPos.z }, boxes)) continue;
      spot = cand;
      break;
    }
  }
  if (spot) {
    if (ctx.coordinator) claimCover(ctx.coordinator, bot, spot, match.time);
    brain.coverSpot = { ...spot, hiding: false };
    brain.coverThreatId = threatId;
    // Reach the spot, then hold there for a few seconds before re-evaluating.
    brain.coverUntil = match.time + rngRange(brain, 1.6, 2.8);
    brain.coverPeek = 0;
    brain.coverHold = rngRange(brain, 0.4, 0.9);
    setDetour(bot, grid, spot.x, spot.z, match, 5);
    brain.statusText = 'sipere giriyor';
    // Deliberately NOT switching state: the bot keeps engaging while it walks to
    // its cover point, otherwise moving to cover looks like disengaging.
    if (brain.state === BOT_STATE.HOLD) brain.state = BOT_STATE.ADVANCE;
  }
}

export function updateBot(match, bot, dt, ctx) {
  const brain = bot.brain;
  if (!brain) return;
  const { grid, boxes } = ctx;

  if (!bot.alive) {
    brain.state = BOT_STATE.DEAD;
    brain.statusText = 'elendi';
    releaseTrigger(activeWeapon(bot.loadout));
    return;
  }

  const w = activeWeapon(bot.loadout);
  updateWeapon(w, dt);
  // Refresh the profile in case the difficulty changed between rounds.
  if (match.profile !== brain.profile) brain.profile = match.profile;
  const prof = brain.profile;

  brain.decisionTimer -= dt;
  brain.reactionTimer = Math.max(0, brain.reactionTimer - dt);
  brain.repathTimer = Math.max(0, brain.repathTimer - dt);
  brain.strafeTimer -= dt;

  // --- perception -------------------------------------------------------
  const visible = visibleEnemies(match, bot, boxes);
  const previousTargetId = brain.target ? brain.target.id : 0;
  const newTarget = chooseTarget(bot, visible);
  brain.targetVisible = Boolean(newTarget);
  if (newTarget) {
    if (!brain.target || brain.target.id !== newTarget.id) {
      brain.target = newTarget;
      brain.reactionTimer = prof.reactionTime * rngRange(brain, 0.85, 1.25);
      brain.aimRamp = 0.15;
      brain.fireAngleTolerance = prof.fireAngleTolerance;
    } else {
      brain.target = newTarget;
    }
    brain.lastSeen = { x: newTarget.x, z: newTarget.z };
    brain.lastSeenTime = match.time;
    // Share the contact with the squad, limited by coordination.
    if (ctx.coordinator && previousTargetId !== newTarget.id) {
      const team = bot.team;
      const existing = ctx.coordinator.contacts[team];
      if (!existing || match.time - existing.time > 1.5) {
        if (brain.rng() < prof.coordination) {
          ctx.coordinator.contacts[team] = { targetId: newTarget.id, x: newTarget.x, z: newTarget.z, time: match.time, by: bot.id };
        }
      }
    }
  } else if (brain.target && match.time - brain.lastSeenTime > 0.4) {
    // Lost the target: switch to searching its last known position, not its
    // live one.
    if (brain.state === BOT_STATE.ENGAGE) {
      brain.state = BOT_STATE.INVESTIGATE;
      brain.investigateTimer = prof.investigateTime;
      brain.statusText = 'son görülen yeri arıyor';
      if (brain.lastSeen) markHot(ctx.coordinator, brain.lastSeen.x, brain.lastSeen.z, match.time);
    }
  }

  // Team call: if a teammate reported a contact and we have none, investigate
  // the *reported* position (already stale by definition).
  if (!brain.target && ctx.coordinator) {
    const call = ctx.coordinator.contacts[bot.team];
    if (call && call.by !== bot.id && match.time - call.time < 6 && brain.state !== BOT_STATE.INVESTIGATE) {
      brain.lastSeen = { x: call.x, z: call.z };
      brain.lastSeenTime = call.time;
      brain.state = BOT_STATE.INVESTIGATE;
      brain.investigateTimer = prof.investigateTime;
      brain.statusText = 'takım çağrısı';
    }
  }

  // --- ally support -----------------------------------------------------
  // A teammate that is being shot at calls for help (limited by coordination, so
  // easy bots mostly ignore each other and hard bots respond reliably).
  if (bot.lastDamageAt > match.time - 0.35 && ctx.coordinator && brain.rng() < prof.coordination) {
    callForHelp(ctx.coordinator, bot, match.time);
  }
  const distress = latestHelp(ctx.coordinator, bot.team, match.time, bot.id);
  brain.supportCall = distress;
  if (distress && match.time > brain.supportCooldown) {
    const allyDist = Math.hypot(distress.x - bot.x, distress.z - bot.z);
    // Reinforcement is a *nearby* reflex, not a map-wide rescue: sprinting across
    // the map to a teammate who is usually already dead hands the round away and
    // pulls the bot back out of the lane it had pushed into.
    const free = !brain.targetVisible && brain.state !== BOT_STATE.ENGAGE &&
      brain.state !== BOT_STATE.RETREAT && brain.state !== BOT_STATE.RELOAD;
    const sign = bot.team === 'A' ? 1 : -1;
    const forward = distress.x * sign >= bot.x * sign - 2;
    if (allyDist < 14 && free && forward && brain.rng() < prof.coordination * 0.8) {
      brain.supportUntil = match.time + 3;
      brain.supportId = distress.by;
      brain.helpCalls += 1;
      brain.statusText = 'arkadaşına destek';
      // Head towards the ally's own position — a friendly, always-known fact.
      setDetour(bot, grid, distress.x, distress.z, match, 3);
      brain.state = BOT_STATE.ADVANCE;
      brain.supportCooldown = match.time + 6;
    } else {
      brain.supportCooldown = match.time + 2.5;
    }
  }

  // --- cover decision ---------------------------------------------------
  updateCoverDecision(match, bot, grid, boxes, ctx);

  // --- damage reaction ------------------------------------------------
  if (bot.lastDamageAt > match.time - 0.25 && bot.lastAttackerId !== 0) {
    const attacker = match.actors.find((x) => x.id === bot.lastAttackerId);
    if (attacker && attacker.alive) {
      // Direction of fire is known (with error), position is not.
      const err = rngRange(brain, 1.5, 4.5) * (prof.id === 'hard' ? 0.5 : 1);
      const ang = Math.atan2(bot.x - attacker.x, bot.z - attacker.z) + rngRange(brain, -0.6, 0.6);
      if (!brain.targetVisible) {
        brain.lastSeen = { x: bot.x + Math.sin(ang) * err, z: bot.z + Math.cos(ang) * err };
        brain.lastSeenTime = match.time;
        if (brain.state !== BOT_STATE.INVESTIGATE) {
          brain.state = BOT_STATE.INVESTIGATE;
          brain.investigateTimer = prof.investigateTime;
          brain.statusText = 'ateş altında';
        }
        // Turn toward the incoming fire.
        const targetYaw = Math.atan2(attacker.x - bot.x, -(attacker.z - bot.z));
        bot.yaw = wrapAngle(bot.yaw + Math.max(-2.4 * dt, Math.min(2.4 * dt, wrapAngle(targetYaw - bot.yaw))));
      }
    }
  }

  // --- state machine --------------------------------------------------
  if (brain.targetVisible) {
    brain.state = BOT_STATE.ENGAGE;
    brain.statusText = 'çatışıyor';
    // Retreat when badly hurt (difficulty dependent).
    if (prof.retreatHealth > 0 && bot.health / PLAYER.maxHealth < prof.retreatHealth && brain.rng() < 0.6) {
      brain.state = BOT_STATE.RETREAT;
      brain.statusText = 'geri çekiliyor';
    }
  } else if (brain.state === BOT_STATE.ENGAGE) {
    brain.state = BOT_STATE.INVESTIGATE;
    brain.investigateTimer = prof.investigateTime;
  }

  switch (brain.state) {
    case BOT_STATE.SPAWN:
    case BOT_STATE.ADVANCE: {
      brain.statusText = 'ilerliyor';
      const onDetour = brain.detourUntil > match.time && brain.path.length > 0;
      if (!onDetour && (brain.path.length === 0 || brain.repathTimer <= 0)) {
        const goal = advanceGoal(bot, grid);
        if (goal) {
          if (!brain.pathGoal || Math.hypot(goal.x - brain.pathGoal.x, goal.z - brain.pathGoal.z) > 1.5) {
            setPathTo(bot, grid, goal.x, goal.z);
          } else {
            brain.repathTimer = 2;
          }
        }
      }
      const arrived = followPath(bot, grid, boxes, dt);
      if (arrived) {
        if (brain.state === BOT_STATE.SPAWN) brain.state = BOT_STATE.ADVANCE;
        // Only consume a lane waypoint when the bot actually walked to the lane
        // point. Detour goals (squad sweep, cover, spawn hunt) also finish here,
        // and treating those as "waypoint done" burned through the whole lane
        // list in a few seconds.
        const atLanePoint = advanceGoalDistance(bot, grid) < 3.2;
        const before = brain.laneIndex;
        if (atLanePoint) tryAdvanceLane(bot);
        if (before === brain.laneIndex && atLanePoint) {
          // Reached the end of the lane: hold with a little strafing.
          brain.state = BOT_STATE.HOLD;
          brain.statusText = 'mevzi tutuyor';
          brain.coverTarget = null;
        }
        brain.path = [];
        brain.pathGoal = null;
      }
      break;
    }
    case BOT_STATE.HOLD: {
      brain.statusText = 'mevzi tutuyor';
      brain.holdTimer += dt;
      brain.sweepTimer += dt;
      // Nothing to shoot for a while: push deeper so rounds always resolve.
      if (ctx.coordinator && ctx.coordinator.hunt[bot.team] && (brain.holdTimer > prof.pushAfter * 0.7 || match.roundElapsed > 24)) {
        // Move to the squad's search zone. This is a *detour*: the lane index is
        // untouched, so the bot can resume its route afterwards.
        const goal = squadSweepGoal(ctx.coordinator, bot, grid);
        if (goal) {
          setDetour(bot, grid, goal.x, goal.z, match, 7);
          brain.state = BOT_STATE.ADVANCE;
          brain.statusText = 'bölge tarıyor';
          brain.holdTimer = 0;
          break;
        }
      }
      if (brain.holdTimer > prof.pushAfter || match.roundElapsed > 32) {
        brain.holdTimer = 0;
        const route = ROUTES[bot.team][brain.lane];
        const laneDone = brain.laneIndex >= route.length - 1;
        if (!laneDone && brain.sweepTimer < 6 && ctx.coordinator) {
          // Lane waypoint left, but the round is young and quiet: sweep the
          // squad zone first. Without this a squad walks its lanes, stops, and
          // both teams end up camping opposite corners.
          const goal = squadSweepGoal(ctx.coordinator, bot, grid);
          if (goal) {
            setDetour(bot, grid, goal.x, goal.z, match, 7);
            brain.state = BOT_STATE.ADVANCE;
            brain.statusText = 'bölge süpürüyor';
            break;
          }
        }
        if (!laneDone) {
          // Still a lane ahead: push deeper instead of camping.
          brain.laneIndex += 1;
          const next = route[brain.laneIndex];
          const spot = grid.randomWalkable(brain.rng, {
            minX: next.x - 3, maxX: next.x + 3, minZ: next.z - 4, maxZ: next.z + 4,
          });
          if (spot) {
            setDetour(bot, grid, spot.x, spot.z, match, 8);
            brain.state = BOT_STATE.ADVANCE;
            brain.statusText = 'ilerliyor';
          }
        } else {
          // Lane exhausted: sweep the squad zone, or hunt the enemy spawn area
          // (a known map fact, not knowledge of where a specific enemy stands).
          const sweep = ctx.coordinator ? squadSweepGoal(ctx.coordinator, bot, grid) : null;
          const spot = sweep || grid.randomWalkable(brain.rng, ENEMY_SPAWN_AREA[bot.team]);
          if (spot) {
            setDetour(bot, grid, spot.x, spot.z, match, sweep ? 7 : 9);
            brain.state = BOT_STATE.ADVANCE;
            brain.statusText = sweep ? 'bölge süpürüyor' : 'ilerliyor';
          }
        }
      }
      // Scan the lane by slowly sweeping, and occasionally reposition.
      if (brain.strafeTimer <= 0) {
        brain.strafeTimer = rngRange(brain, 1.4, 3.2);
        brain.strafeDir = brain.rng() < 0.5 ? -1 : 1;
      }
      const lookYaw = bot.yaw + brain.strafeDir * 0.35 * dt;
      bot.yaw = wrapAngle(lookYaw);
      if (brain.decisionTimer <= 0) {
        brain.decisionTimer = prof.decisionInterval * 3 + brain.rng() * 2;
        if (brain.rng() < prof.coverUse * 0.5) {
          const route = ROUTES[bot.team][brain.lane];
          const p = route[Math.min(brain.laneIndex, route.length - 1)];
          const spot = grid.randomWalkable(brain.rng, { minX: p.x - 4, maxX: p.x + 4, minZ: p.z - 4, maxZ: p.z + 4 });
          setPathTo(bot, grid, spot.x, spot.z);
          brain.state = BOT_STATE.ADVANCE;
        }
      }
      bot.speedFactor = 0;
      break;
    }
    case BOT_STATE.INVESTIGATE: {
      brain.statusText = brain.statusText || 'araştırıyor';
      brain.investigateTimer -= dt;
      if (brain.lastSeen) {
        if (brain.path.length === 0) setPathTo(bot, grid, brain.lastSeen.x, brain.lastSeen.z);
        const arrived = followPath(bot, grid, boxes, dt, 0.95);
        if (arrived || brain.investigateTimer <= 0) {
          // Look around where the contact was, then resume advancing. The lane
          // counter may only advance when the bot actually reached the lane
          // point — otherwise investigating a sound on the far side of the map
          // skipped whole waypoints and left the bot wandering near the enemy
          // spawn with no route left to follow.
          brain.lastSeen = null;
          brain.investigateTimer = 0;
          brain.path = [];
          brain.state = BOT_STATE.ADVANCE;
          if (advanceGoalDistance(bot, grid) < 3.2) tryAdvanceLane(bot);
        }
      } else if (brain.investigateTimer <= 0) {
        brain.state = BOT_STATE.ADVANCE;
      } else {
        // No remembered position: sweep the lane area rather than freeze.
        if (brain.path.length === 0 && brain.repathTimer <= 0) {
          const route = ROUTES[bot.team][brain.lane];
          const p = route[Math.min(brain.laneIndex, route.length - 1)];
          const spot = grid.randomWalkable(brain.rng, { minX: p.x - 6, maxX: p.x + 6, minZ: p.z - 6, maxZ: p.z + 6 });
          if (spot) setPathTo(bot, grid, spot.x, spot.z);
        }
        if (brain.path.length) followPath(bot, grid, boxes, dt, 0.85);
        else {
          bot.speedFactor = 0;
          bot.yaw = wrapAngle(bot.yaw + 0.6 * dt);
        }
      }
      break;
    }
    case BOT_STATE.RETREAT: {
      brain.statusText = 'geri çekiliyor';
      if (brain.target && brain.targetVisible) {
        // Back away from the threat while keeping it in view.
        const dx = bot.x - brain.target.x;
        const dz = bot.z - brain.target.z;
        const len = Math.hypot(dx, dz) || 1;
        const moved = moveCircle(bot.x, bot.z, (dx / len) * 3.2 * dt, (dz / len) * 3.2 * dt, PLAYER.radius, boxes);
        if (moved.hit) {
          brain.state = BOT_STATE.ENGAGE;
        }
        bot.x = moved.x;
        bot.z = moved.z;
        bot.speedFactor = 0.8;
        combatTick(match, bot, dt, ctx);
      } else {
        brain.state = BOT_STATE.ADVANCE;
      }
      break;
    }
    case BOT_STATE.RELOAD: {
      brain.statusText = 'şarjör değiştiriyor';
      if (!w.reloading && w.mag > 0) {
        brain.state = brain.targetVisible ? BOT_STATE.ENGAGE : BOT_STATE.ADVANCE;
      } else if (!w.reloading && w.mag === 0 && w.reserve === 0) {
        switchWeapon(bot.loadout, 'pistol');
      }
      bot.speedFactor = 0;
      break;
    }
    case BOT_STATE.ENGAGE:
    default: {
      brain.statusText = 'çatışıyor';
      if (brain.target && brain.targetVisible) {
        // Cover first: a hurt bot (or any bot on the higher difficulties) breaks
        // the fight by crouching behind real geometry, then peeks back out.
        const coverDist = Math.hypot(brain.target.x - bot.x, brain.target.z - bot.z);
        // Cover is a *stance*, not a separate state: the bot keeps aiming,
        // shooting and tracking while it crouches. (An earlier version returned
        // early here, which silently stopped bots from fighting at all and made
        // every difficulty easier.)
        const inCover = brain.coverSpot && brain.coverSpot.hiding && match.time < brain.coverUntil && coverDist < 26 && coverDist > 9;
        if (inCover) {
          brain.statusText = 'siperde';
          bot.speedFactor = 0;
          // Peek/hide cycle: stay down for `coverHold`, pop up for `coverPeek`.
          // (Re-arming the peek in the same tick it expired meant the bot was
          // always standing and never actually used the cover.)
          brain.coverPeek -= dt;
          brain.coverHold -= dt;
          if (brain.coverPeek > 0) {
            bot.crouch = Math.max(0, bot.crouch - dt * 8);
          } else {
            bot.crouch = Math.min(1, bot.crouch + dt * 8);
            if (brain.coverHold <= 0 && bot.crouch >= 0.9 && brain.aimRamp > 0.4) {
              brain.coverPeek = rngRange(brain, 0.8, 1.4);
              brain.coverHold = rngRange(brain, 0.7, 1.4);
            }
          }
          combatTick(match, bot, dt, ctx);
          // Spend the mag, then drop the spot so the bot re-engages normally.
          if (coverDist < 9) {
            // Enemy too close for cover to mean anything: stand and fight.
            brain.coverSpot = null;
            brain.coverUntil = 0;
          }
        }
        if (!inCover) bot.crouch = Math.max(0, bot.crouch - dt * 4);
        // Strafe for a harder target, with cover awareness on higher difficulty.
        if (brain.strafeTimer <= 0) {
          brain.strafeTimer = rngRange(brain, 0.9, 2.2);
          brain.strafeDir = brain.rng() < 0.5 ? -1 : 1;
          brain.strafeActive = brain.rng() < prof.strafeChance;
        }
        if (brain.strafeActive && !inCover) {
          const perpYaw = bot.yaw + (Math.PI / 2) * brain.strafeDir;
          const sx = Math.sin(perpYaw) * 2.6 * dt;
          const sz = -Math.cos(perpYaw) * 2.6 * dt;
          const moved = moveCircle(bot.x, bot.z, sx, sz, PLAYER.radius, boxes);
          bot.x = moved.x;
          bot.z = moved.z;
          bot.speedFactor = 0.5;
        } else {
          bot.speedFactor = 0;
        }
        // Walking to a cover point takes priority over closing the distance.
        const seekCover = brain.coverSpot && !brain.coverSpot.hiding;
        const dist = Math.hypot(brain.target.x - bot.x, brain.target.z - bot.z);
        if (seekCover) {
          const spot = brain.coverSpot;
          const toSpot = Math.hypot(spot.x - bot.x, spot.z - bot.z);
          if (toSpot > 1.2) {
            // Note: followPath() reports "arrived" for an empty path, so the
            // distance check has to come first — otherwise the bot decides it is
            // already in cover while standing five metres away and drops it.
            if (brain.path.length === 0) setDetour(bot, grid, spot.x, spot.z, match, 5);
            followPath(bot, grid, boxes, dt, 1.05);
          } else {
            const threatPos = { x: brain.target.x, y: 1.55, z: brain.target.z };
            spot.hiding = hiddenFrom(spot.x, spot.z, threatPos, boxes);
            if (!spot.hiding) {
              brain.coverSpot = null;
              brain.coverUntil = 0;
            }
          }
        } else if (dist > 16) {
          if (brain.decisionTimer <= 0 || brain.path.length === 0) {
            brain.decisionTimer = 1.5;
            setPathTo(bot, grid, brain.target.x, brain.target.z);
          }
          followPath(bot, grid, boxes, dt, dist > 30 ? 1.15 : 1.0);
        } else {
          brain.path = [];
        }
        combatTick(match, bot, dt, ctx);
      } else {
        brain.state = BOT_STATE.ADVANCE;
      }
      break;
    }
  }

  // Safety: keep everyone inside the map, and never stand inside a teammate.
  separateFromOthers(match, bot, boxes);
  bot.x = Math.max(-30.5, Math.min(30.5, bot.x));
  bot.z = Math.max(-20.5, Math.min(20.5, bot.z));

  // Reload when idle and low on ammo, so bots are never caught dry.
  if (!w.reloading && !w.switching && w.mag === 0 && w.reserve > 0) {
    startReload(w);
    cancelReloadIfDead(bot);
  }
  if (!brain.targetVisible && !w.reloading && w.mag <= Math.floor(w.def.magSize * 0.4) && w.reserve > 0 && brain.state === BOT_STATE.HOLD) {
    startReload(w);
  }
  if (!bot.alive) releaseTrigger(w);
}

function cancelReloadIfDead(bot) {
  if (!bot.alive) cancelReload(activeWeapon(bot.loadout));
}

/**
 * Player shot resolution hook: bots should notice being shot even when the
 * shooter is behind them (handled via lastDamageAt/lastAttackerId).
 */
export function notifyHit(actor, attackerId, time) {
  actor.lastDamageAt = time;
  actor.lastAttackerId = attackerId;
}



export { hitVolumes, bodyRadius, castShot, MATCH };

/**
 * Hearing: a gunshot within `hearingRadius` gives an *approximate* position, not
 * the shooter's exact coordinates, and only pulls the bot into investigation
 * when it is not already engaged. Line of sight is never granted by sound.
 */
export function hearSound(bot, origin, match) {
  const brain = bot.brain;
  if (!brain || !bot.alive) return false;
  const dist = Math.hypot(origin.x - bot.x, origin.z - bot.z);
  const prof = brain.profile;
  if (dist > prof.hearingRadius) return false;
  if (brain.targetVisible) return false;
  const err = Math.min(6, 1.2 + dist * 0.22);
  const ang = brain.rng() * Math.PI * 2;
  const px = origin.x + Math.sin(ang) * err * brain.rng();
  const pz = origin.z + Math.cos(ang) * err * brain.rng();
  if (!brain.lastSeen || match.time - brain.lastSeenTime > 1.0) {
    brain.lastSeen = { x: px, z: pz };
    brain.lastSeenTime = match.time;
    if (brain.state === BOT_STATE.HOLD || brain.state === BOT_STATE.ADVANCE || brain.state === BOT_STATE.SPAWN) {
      brain.state = BOT_STATE.INVESTIGATE;
      brain.investigateTimer = prof.investigateTime;
      brain.statusText = 'ses duydu';
      brain.path = [];
    }
  }
  return true;
}
