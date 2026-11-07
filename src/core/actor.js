// Actor model: player and bots share one representation so damage, hitboxes and
// win conditions are identical for both sides.

import { PLAYER, COMBAT } from './config.js';
import { createLoadout, resetLoadout, activeWeapon } from './weapon.js';

let nextId = 1;

export function resetActorIds() {
  nextId = 1;
}

export const NAMES_A = ['SEN', 'DEMİR', 'KAYA', 'YILMAZ', 'ERSOY'];
export const NAMES_B = ['AKIN', 'SOLMAZ', 'TURAN', 'BARÇIN', 'GÜL'];

export function createActor({ team, name, isPlayer = false, index = 0 }) {
  const actor = {
    id: nextId++,
    name,
    team,
    isPlayer,
    index,
    x: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    vx: 0,
    vz: 0,
    crouch: 0,
    health: PLAYER.maxHealth,
    armor: PLAYER.maxArmor,
    alive: false,
    deaths: 0,
    kills: 0,
    loadout: createLoadout(),
    // Bot-only state attached by the AI layer.
    brain: null,
    // 0..1, drives the leg animation / visibility of a moving actor.
    speedFactor: 0,
    lastDamageAt: -999,
    lastAttackerId: 0,
  };
  return actor;
}

export function resetActorForRound(actor, spawn) {
  actor.x = spawn.x;
  actor.z = spawn.z;
  actor.yaw = spawn.yaw;
  actor.pitch = 0;
  actor.vx = 0;
  actor.vz = 0;
  actor.crouch = 0;
  actor.health = PLAYER.maxHealth;
  actor.armor = PLAYER.maxArmor;
  actor.alive = true;
  actor.speedFactor = 0;
  actor.lastDamageAt = -999;
  actor.lastAttackerId = 0;
  resetLoadout(actor.loadout);
  if (actor.brain) {
    actor.brain.reset(spawn);
  }
}

export function markDead(actor) {
  if (!actor.alive) return false;
  actor.alive = false;
  actor.health = 0;
  actor.deaths += 1;
  actor.vx = 0;
  actor.vz = 0;
  const w = activeWeapon(actor.loadout);
  w.reloading = false;
  w.reloadTimer = 0;
  w.triggerHeld = false;
  return true;
}

export function eyeHeight(actor) {
  const base = PLAYER.eyeHeight;
  const crouched = PLAYER.crouchEyeHeight;
  return base + (crouched - base) * actor.crouch;
}

export function eyePoint(actor) {
  return { x: actor.x, y: eyeHeight(actor), z: actor.z };
}

/** Approximate body radius used for collision and for being hit. */
export function bodyRadius(actor) {
  return PLAYER.radius * (1 - 0.06 * actor.crouch);
}

/**
 * Hit volumes. Head is a separate sphere so headshots are unambiguous.
 * Body is a vertical cylinder. Values are tuned for a 1.8m actor.
 */
export function hitVolumes(actor) {
  const eye = eyeHeight(actor);
  const scale = 1 - 0.18 * actor.crouch;
  return {
    head: { x: actor.x, y: eye - 0.06 * scale, z: actor.z, r: 0.23 },
    body: {
      x: actor.x,
      z: actor.z,
      r: bodyRadius(actor),
      minY: 0.25 * scale,
      maxY: eye - 0.26 * scale,
    },
    headMultiplier: COMBAT.headMultiplier,
  };
}
