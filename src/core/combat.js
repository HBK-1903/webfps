// Hit detection + damage application shared by the player and every bot.

import { raycastBoxes } from './collision.js';
import { damageAtDistance, resolveDamage, damageAllowed } from './damage.js';
import { hitVolumes } from './actor.js';

/** Ray vs sphere; returns distance or -1. `dir` normalised. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return -1;
  return t;
}

/** Ray vs vertical cylinder (finite height); returns distance or -1. */
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, r, minY, maxY, maxDist) {
  const lx = ox - cx;
  const lz = oz - cz;
  const a = dx * dx + dz * dz;
  let t = -1;
  if (a < 1e-8) {
    // Vertical ray: only hits if already inside the circle.
    if (lx * lx + lz * lz > r * r) return -1;
    const y0 = oy;
    const y1 = oy + dy * maxDist;
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    if (hi < minY || lo > maxY) return -1;
    const target = dy > 0 ? minY : maxY;
    return Math.abs(target - oy);
  }
  const b = 2 * (lx * dx + lz * dz);
  const c = lx * lx + lz * lz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  for (const cand of [t1, t2]) {
    if (cand < 0 || cand > maxDist) continue;
    const y = oy + dy * cand;
    if (y >= minY && y <= maxY) {
      t = cand;
      break;
    }
  }
  if (t >= 0) return t;
  // Ray may pass above/below the cylinder ends: check the caps.
  if (Math.abs(dy) > 1e-8) {
    for (const capY of [minY, maxY]) {
      const ct = (capY - oy) / dy;
      if (ct < 0 || ct > maxDist) continue;
      const px = ox + dx * ct;
      const pz = oz + dz * ct;
      if ((px - cx) * (px - cx) + (pz - cz) * (pz - cz) <= r * r) {
        if (t < 0 || ct < t) t = ct;
      }
    }
  }
  return t;
}

/**
 * Cast a shot through the world.
 * @returns {{type:'actor'|'world'|'none', actor?:object, headshot?:boolean,
 *            distance:number, point:{x,y,z}, normalY?:number, weapon:object}}
 */
export function castShot({ origin, dir, actors, boxes, maxDist, shooterTeam, shooterId, ignoreFriends = true }) {
  const wall = raycastBoxes(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, boxes, maxDist);
  let bestDist = wall ? wall.distance : maxDist;
  let bestActor = null;
  let headshot = false;
  let bestPoint = wall ? wall.point : null;

  for (const a of actors) {
    if (!a.alive || a.id === shooterId) continue;
    const friendly = a.team === shooterTeam;
    if (friendly && ignoreFriends) continue; // bullets pass through teammates
    const vol = hitVolumes(a);
    const dHead = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, vol.head.x, vol.head.y, vol.head.z, vol.head.r, bestDist);
    const dBody = rayCylinder(
      origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      vol.body.x, vol.body.z, vol.body.r, vol.body.minY, vol.body.maxY, bestDist,
    );
    let d = -1;
    let isHead = false;
    if (dHead >= 0 && (dBody < 0 || dHead <= dBody)) {
      d = dHead;
      isHead = true;
    } else if (dBody >= 0) {
      d = dBody;
    }
    if (d >= 0 && d < bestDist) {
      bestDist = d;
      bestActor = a;
      headshot = isHead;
      bestPoint = { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d };
    }
  }

  if (bestActor) {
    return { type: 'actor', actor: bestActor, headshot, distance: bestDist, point: bestPoint };
  }
  if (wall) {
    return { type: 'wall', distance: bestDist, point: bestPoint, box: wall.box };
  }
  return { type: 'none', distance: bestDist, point: bestPoint };
}

/**
 * Apply a hit to an actor using the shared damage rules.
 * Returns null when the shot is not allowed (friendly fire disabled, dead target)
 * or a result describing what happened.
 */
function applyHit(attacker, victim, { weapon, distance, headshot }) {
  if (!victim.alive) return null;
  if (!damageAllowed(attacker.team, victim.team)) return null;
  const dmg = damageAtDistance(weapon, distance);
  const result = resolveDamage({
    health: victim.health,
    armor: victim.armor,
    damage: dmg,
    headshot,
    headMultiplier: weapon.headMultiplier,
  });
  victim.health = result.health;
  victim.armor = result.armor;
  victim.lastAttackerId = attacker.id;
  if (result.killed) victim.health = 0;
  return { ...result, victimId: victim.id, attackerId: attacker.id, distance };
}

/** Convenience: run a full shot (cast + damage) and return the outcome. */
export function performShot({ attacker, origin, dir, actors, boxes, weapon, ignoreFriends = true }) {
  const cast = castShot({
    origin,
    dir,
    actors,
    boxes,
    maxDist: weapon.range,
    shooterTeam: attacker.team,
    shooterId: attacker.id,
    ignoreFriends,
  });
  const out = { cast, hit: null, killed: false };
  if (cast.type === 'actor') {
    const applied = applyHit(attacker, cast.actor, { weapon, distance: cast.distance, headshot: cast.headshot });
    out.hit = applied;
    out.killed = Boolean(applied && applied.killed);
    if (!applied) {
      // Friendly fire disabled: the bullet is simply stopped by the teammate.
      out.cast = { ...cast, type: 'friendly' };
    }
  }
  return out;
}

/** Direction vector from yaw/pitch (yaw 0 looks toward -Z). */
export function directionFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Yaw/pitch that point from `from` to `to` (both eye points). */
export function anglesTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  return {
    yaw: Math.atan2(dx, -dz),
    pitch: Math.atan2(dy, horiz),
  };
}
