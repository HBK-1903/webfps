// Player movement/aim controller. Pure state + fixed-step friendly update.

import { PLAYER } from './config.js';
import { moveCircle } from './collision.js';
import { updateWeapon, activeWeapon, switchWeapon, startReload, tryShoot, releaseTrigger, cancelReload } from './weapon.js';
import { eyePoint } from './actor.js';
import { directionFromAngles, performShot } from './combat.js';

export function createPlayerController(actor) {
  return {
    actor,
    yaw: actor.yaw,
    pitch: 0,
    ads: false,
    // 0 = hip, 1 = fully aimed. The sight takes ~200ms to settle, and the
    // accuracy bonus must follow the *same* curve: the player used to get the
    // full ADS spread reduction on the frame the button went down, while the
    // sight was still visibly off-axis for a fifth of a second.
    adsBlend: 0,
    localX: 0,
    localZ: 0,
    sprint: false,
    crouchHeld: false,
    bobPhase: 0,
    shakeTime: 0,
    shotsThisFrame: [],
    kickPitch: 0,
  };
}

function setAngles(pc, yaw, pitch) {
  pc.yaw = yaw;
  pc.pitch = Math.max(-(PLAYER.pitchLimit * Math.PI) / 180, Math.min((PLAYER.pitchLimit * Math.PI) / 180, pitch));
  pc.actor.yaw = yaw;
  pc.actor.pitch = pc.pitch;
}

/** Apply mouse delta (already scaled by sensitivity). */
export function addLook(pc, dxDeg, dyDeg) {
  const yaw = pc.yaw + (dxDeg * Math.PI) / 180;
  const pitch = pc.pitch - (dyDeg * Math.PI) / 180;
  setAngles(pc, wrapYaw(yaw), pitch);
}

function wrapYaw(y) {
  const t = Math.PI * 2;
  let r = y % t;
  if (r > Math.PI) r -= t;
  if (r < -Math.PI) r += t;
  return r;
}

/**
 * @param {object} input {forward, right, sprint, crouch}
 * @param {object} ctx {boxes, dt}
 */
export function updatePlayer(pc, input, ctx) {
  const a = pc.actor;
  const dt = ctx.dt;
  if (!a.alive) {
    pc.ads = false;
    releaseTrigger(activeWeapon(a.loadout));
    return;
  }
  const w = activeWeapon(a.loadout);
  const wantCrouch = Boolean(input.crouch);
  const crouchTarget = wantCrouch ? 1 : 0;
  a.crouch += (crouchTarget - a.crouch) * Math.min(1, PLAYER.crouchLerpSpeed * dt);
  if (Math.abs(a.crouch - crouchTarget) < 0.01) a.crouch = crouchTarget;

  // The ADS blend runs on the same rate the viewmodel uses for its sight
  // (1 - (1 - 14*dt) per frame in viewmodel.js), so what the player sees and
  // what the spread cone does are the same curve.
  const adsTarget = pc.ads ? 1 : 0;
  pc.adsBlend += (adsTarget - pc.adsBlend) * Math.min(1, PLAYER.adsLerpSpeed * dt);
  if (Math.abs(pc.adsBlend - adsTarget) < 0.01) pc.adsBlend = adsTarget;

  const moving = Math.abs(input.forward) > 0.01 || Math.abs(input.right) > 0.01;
  const sprinting = Boolean(input.sprint) && input.forward > 0.1 && !pc.ads && a.crouch < 0.5;
  pc.sprint = sprinting;
  let speed = PLAYER.walkSpeed;
  if (sprinting) speed = PLAYER.sprintSpeed;
  if (a.crouch > 0.5) speed = PLAYER.crouchSpeed;
  if (pc.ads) speed *= PLAYER.adsSpeedFactor;
  if (w.switching) speed *= 0.85;

  // Desired velocity in world space from camera yaw.
  let wx = 0;
  let wz = 0;
  if (moving) {
    const len = Math.hypot(input.forward, input.right) || 1;
    const f = input.forward / len;
    const r = input.right / len;
    const sin = Math.sin(pc.yaw);
    const cos = Math.cos(pc.yaw);
    // forward = (-sin? ) derived from directionFromAngles(yaw,0) = (sin,0,-cos)
    wx = (sin * f + cos * r) * speed;
    wz = (-cos * f + sin * r) * speed;
  }

  const accel = PLAYER.accel * (a.crouch > 0.5 ? 0.6 : 1);
  a.vx += (wx - a.vx) * Math.min(1, accel * dt / Math.max(speed, 1));
  a.vz += (wz - a.vz) * Math.min(1, accel * dt / Math.max(speed, 1));
  if (!moving) {
    const damp = Math.max(0, 1 - PLAYER.friction * dt);
    a.vx *= damp;
    a.vz *= damp;
    if (Math.abs(a.vx) < 0.02) a.vx = 0;
    if (Math.abs(a.vz) < 0.02) a.vz = 0;
  }

  const moved = moveCircle(a.x, a.z, a.vx * dt, a.vz * dt, PLAYER.radius, ctx.boxes);
  // If we hit a wall, kill the velocity component along the wall so we don't
  // keep "pressing" into it. Cheap approximation: if blocked, damp both.
  if (moved.blocked) {
    a.vx *= 0.35;
    a.vz *= 0.35;
  }
  a.x = moved.x;
  a.z = moved.z;
  const spd = Math.hypot(a.vx, a.vz);
  a.speedFactor = Math.min(1, spd / PLAYER.walkSpeed);

  // Weapon timers (only advance while the match is running).
  if (ctx.advanceTime !== false) updateWeapon(w, dt);
  // Auto-reload an empty mag for convenience.
  if (w.mag === 0 && !w.reloading && w.reserve > 0) startReload(w);
  // Camera kick from recoil decays here so the view returns calmly.
  pc.kickPitch += (0 - pc.kickPitch) * Math.min(1, 12 * dt);
  pc.bobPhase += spd * dt * 2.4;
}

/** Fire handling with weapon state; returns array of shot outcomes. */
export function playerTryFire(pc, { actors, boxes, rng = Math.random }) {
  const a = pc.actor;
  const out = [];
  if (!a.alive) return out;
  const w = activeWeapon(a.loadout);
  const shot = tryShoot(w, {
    aimPitch: pc.pitch,
    aimYaw: pc.yaw,
    moving: a.speedFactor > 0.15,
    adsBlend: pc.adsBlend,
    triggerHeld: w.triggerHeld,
    rng,
  });
  if (!shot) return out;
  const eye = eyePoint(a);
  const dir = directionFromAngles(shot.yaw, shot.pitch);
  const origin = { x: eye.x, y: eye.y, z: eye.z };
  const result = performShot({ attacker: a, origin, dir, actors, boxes, weapon: w.def });
  out.push({ shot, result, origin, dir });
  return out;
}

export function playerReload(pc) {
  return startReload(activeWeapon(pc.actor.loadout));
}

export function playerSwitch(pc, slotId) {
  const ok = switchWeapon(pc.actor.loadout, slotId);
  if (ok) pc.ads = false;
  return ok;
}

export function playerReleaseTrigger(pc) {
  releaseTrigger(activeWeapon(pc.actor.loadout));
}

export function stopPlayerWeapon(pc) {
  const w = activeWeapon(pc.actor.loadout);
  cancelReload(w);
  releaseTrigger(w);
}

/** Camera pitch including recoil kick (visual only, aim uses pc.pitch). */
export function cameraPitch(pc) {
  return Math.max(
    -(PLAYER.pitchLimit * Math.PI) / 180,
    Math.min((PLAYER.pitchLimit * Math.PI) / 180, pc.pitch - (pc.kickPitch * Math.PI) / 180),
  );
}
