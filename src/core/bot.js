// Bot AI: perception (FOV + LOS + hearing), navigation, combat, cover, reload
// and light team coordination. Everything here is deterministic given a seeded
// RNG, so difficulty behaviour can be measured in headless simulations.

import { PLAYER, MATCH } from './config.js';
import { moveCircle, losClear } from './collision.js';
import { eyePoint, bodyRadius, hitVolumes } from './actor.js';
import { directionFromAngles, performShot, anglesTo, castShot } from './combat.js';
import { activeWeapon, updateWeapon, startReload, tryShoot, releaseTrigger, switchWeapon, cancelReload } from './weapon.js';
import { ROUTES, ENEMY_SPAWN_AREA } from './map.js';
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
  };
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
    // 2) No fight yet: sweep the middle, then drift toward the enemy side.
    const towardEnemy = team === 'A' ? 1 : -1;
    const drift = Math.min(14, (match.roundElapsed || 0) * 0.35) * towardEnemy;
    const spot = grid.randomWalkable(rng, {
      minX: Math.max(-24, Math.min(24, drift - 10)),
      maxX: Math.max(-24, Math.min(24, drift + 10)),
      minZ: -14,
      maxZ: 14,
    });
    coordinator.hunt[team] = { x: spot.x, z: spot.z, time: match.time };
  }
}

// The map is 180° rotationally symmetric, so "north" for ALFA is the mirror of
// "south" for BRAVO. Lane assignment must be rotated for team B as well,
// otherwise one team ends up numerically stronger in mid.
const LANE_PATTERN = ['mid', 'north', 'south', 'mid', 'north'];
const ROTATE_LANE = { mid: 'mid', north: 'south', south: 'north' };

export function laneForSlot(team, index) {
  const base = LANE_PATTERN[index % LANE_PATTERN.length];
  return team === 'B' ? ROTATE_LANE[base] : base;
}

export function assignLanes(match, coordinator) {
  for (const team of ['A', 'B']) {
    const bots = match.actors.filter((a) => a.team === team && a.brain);
    coordinator.lanes[team] = {};
    const order = bots.slice().sort((a, b) => a.index - b.index);
    for (const bot of order) {
      const lane = laneForSlot(team, bot.index);
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
  const jitterX = ((bot.index % 3) - 1) * 1.6;
  const jitterZ = (bot.index % 2 === 0 ? 1 : -1) * 1.2;
  const gx = route.x + jitterX;
  const gz = route.z + jitterZ;
  const cell = grid.nearestWalkable(gx, gz);
  if (!cell) return { x: route.x, z: route.z };
  const c = grid.cellCenter(cell.c, cell.r);
  return { x: c.x, z: c.z };
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
  const tEye = eyePoint(target);
  const angles = anglesTo(eye, tEye);

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
  if (brain.burstLeft <= 0 && brain.burstPause <= 0) brain.burstLeft = profile.burstShots;

  if (ready && aligned && brain.burstPause <= 0 && brain.burstLeft > 0) {
    const shot = tryShoot(w, {
      aimPitch: a.pitch,
      aimYaw: a.yaw,
      moving: a.speedFactor > 0.3,
      ads: true,
      triggerHeld: w.triggerHeld,
    });
    if (shot) {
      brain.shots++;
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

/** Main bot update. */
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
      if (brain.path.length === 0 || brain.repathTimer <= 0) {
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
        const before = brain.laneIndex;
        tryAdvanceLane(bot);
        if (before === brain.laneIndex) {
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
      // Nothing to shoot for a while: push deeper so rounds always resolve.
      if (ctx.coordinator && ctx.coordinator.hunt[bot.team] && (brain.holdTimer > prof.pushAfter * 0.7 || match.roundElapsed > 24)) {
        const hz = ctx.coordinator.hunt[bot.team];
        const offX = ((bot.index % 3) - 1) * 3.2;
        const offZ = (Math.floor(bot.index / 3) - 0.5) * 3.2;
        const spot = grid.nearestWalkable(hz.x + offX, hz.z + offZ);
        if (spot) {
          const p = grid.cellCenter(spot.c, spot.r);
          setPathTo(bot, grid, p.x, p.z);
          brain.state = BOT_STATE.ADVANCE;
          brain.statusText = 'bölge tarıyor';
          brain.holdTimer = 0;
          break;
        }
      }
      if (brain.holdTimer > prof.pushAfter || match.roundElapsed > 32) {
        brain.holdTimer = 0;
        const route = ROUTES[bot.team][brain.lane];
        if (brain.laneIndex < route.length - 1) {
          // Still a lane ahead: push deeper instead of camping.
          brain.laneIndex += 1;
          const next = route[brain.laneIndex];
          const spot = grid.randomWalkable(brain.rng, {
            minX: next.x - 3, maxX: next.x + 3, minZ: next.z - 4, maxZ: next.z + 4,
          });
          if (spot) {
            setPathTo(bot, grid, spot.x, spot.z);
            brain.state = BOT_STATE.ADVANCE;
            brain.statusText = 'ilerliyor';
          }
        } else {
          // Lane exhausted: hunt the enemy spawn area (a known map fact, not
          // knowledge of where a specific enemy stands).
          const area = ENEMY_SPAWN_AREA[bot.team];
          const spot = grid.randomWalkable(brain.rng, area);
          if (spot) {
            setPathTo(bot, grid, spot.x, spot.z);
            brain.state = BOT_STATE.ADVANCE;
            brain.statusText = 'ilerliyor';
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
          // Look around where the contact was, then resume advancing.
          brain.lastSeen = null;
          brain.investigateTimer = 0;
          brain.path = [];
          brain.state = BOT_STATE.ADVANCE;
          brain.laneIndex = Math.min(brain.laneIndex + 1, (ROUTES[bot.team][brain.lane] || []).length - 1);
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
        // Strafe for a harder target, with cover awareness on higher difficulty.
        if (brain.strafeTimer <= 0) {
          brain.strafeTimer = rngRange(brain, 0.9, 2.2);
          brain.strafeDir = brain.rng() < 0.5 ? -1 : 1;
          brain.strafeActive = brain.rng() < prof.strafeChance;
        }
        if (brain.strafeActive) {
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
        // Close the distance when the fight is far away: long-range duels with
        // big aim error never resolve, so the bot pushes in.
        const dist = Math.hypot(brain.target.x - bot.x, brain.target.z - bot.z);
        if (dist > 16) {
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

  // Safety: keep everyone inside the map.
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

/** Bot weapon ammo snapshot for HUD/debug. */
export function botAmmo(bot) {
  const w = activeWeapon(bot.loadout);
  return { mag: w.mag, reserve: w.reserve, name: w.def.shortName, reloading: w.reloading };
}

/** Debug: where a bot thinks the threat is. */
export function botDebug(bot) {
  const b = bot.brain;
  return {
    state: b.state,
    lane: b.lane,
    targetId: b.target ? b.target.id : 0,
    visible: b.targetVisible,
    lastSeen: b.lastSeen,
    shots: b.shots,
    hits: b.hits,
    status: b.statusText,
  };
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
