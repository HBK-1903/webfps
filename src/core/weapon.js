// Weapon state machine: fire cadence, spread, recoil, reload and switching.
// No rendering and no DOM: the renderer reads the state each frame.

import { WEAPONS } from './config.js';

export function createWeaponState(weaponId) {
  const def = WEAPONS[weaponId];
  return {
    id: weaponId,
    def,
    mag: def.magSize,
    reserve: def.reserveAmmo,
    cooldown: 0,
    reloadTimer: 0,
    reloading: false,
    switchTimer: 0,
    switching: false,
    // Recoil is stored as an offset applied to the aim direction.
    recoilPitch: 0,
    recoilYaw: 0,
    spread: def.spread.base,
    triggerHeld: false,
    shotsFired: 0,
    burstLeft: 0,
  };
}

export function resetWeapon(state, weaponId) {
  const def = WEAPONS[weaponId];
  state.id = weaponId;
  state.def = def;
  state.mag = def.magSize;
  state.reserve = def.reserveAmmo;
  state.cooldown = 0;
  state.reloadTimer = 0;
  state.reloading = false;
  state.switchTimer = 0;
  state.switching = false;
  state.recoilPitch = 0;
  state.recoilYaw = 0;
  state.spread = def.spread.base;
  state.triggerHeld = false;
  state.shotsFired = 0;
  state.burstLeft = 0;
}

export function createLoadout() {
  return { current: 'rifle', slots: { pistol: createWeaponState('pistol'), rifle: createWeaponState('rifle') } };
}

export function resetLoadout(loadout) {
  resetWeapon(loadout.slots.pistol, 'pistol');
  resetWeapon(loadout.slots.rifle, 'rifle');
  loadout.current = 'rifle';
}

export function activeWeapon(loadout) {
  return loadout.slots[loadout.current];
}

/**
 * Advance timers. Returns true if a reload finished this tick.
 * `dt` must already be zero when the game is paused / frozen by the caller.
 */
export function updateWeapon(w, dt) {
  let reloadFinished = false;
  if (w.cooldown > 0) w.cooldown = Math.max(0, w.cooldown - dt);
  if (w.switching) {
    w.switchTimer -= dt;
    if (w.switchTimer <= 0) {
      w.switchTimer = 0;
      w.switching = false;
    }
  }
  if (w.reloading) {
    w.reloadTimer -= dt;
    if (w.reloadTimer <= 0) {
      w.reloadTimer = 0;
      finishReload(w);
      reloadFinished = true;
    }
  }
  // Spread recovers toward base, recoil recovers toward zero.
  const sp = w.def.spread;
  if (w.spread > sp.base) {
    w.spread = Math.max(sp.base, w.spread - sp.recovery * dt);
  }
  const rec = w.def.recoil.recovery * dt;
  if (w.recoilPitch > 0) w.recoilPitch = Math.max(0, w.recoilPitch - rec);
  if (w.recoilYaw > 0) w.recoilYaw = Math.max(0, w.recoilYaw - rec * 1.15);
  return reloadFinished;
}

export function canFire(w) {
  return !w.reloading && !w.switching && w.cooldown <= 0 && w.mag > 0;
}

export function needsReload(w) {
  return w.mag <= 0 && w.reserve > 0;
}

export function startReload(w) {
  if (w.reloading || w.switching) return false;
  if (w.mag >= w.def.magSize || w.reserve <= 0) return false;
  w.reloading = true;
  w.reloadTimer = w.def.reloadTime;
  w.cooldown = 0;
  return true;
}

export function finishReload(w) {
  if (!w.reloading && w.reloadTimer > 0) return;
  const need = w.def.magSize - w.mag;
  const take = Math.min(need, w.reserve);
  w.mag += take;
  w.reserve -= take;
  w.reloading = false;
  w.reloadTimer = 0;
}

/** Cancel an in-progress reload (death, round end, weapon swap). */
export function cancelReload(w) {
  w.reloading = false;
  w.reloadTimer = 0;
}

/**
 * Try to fire one shot. Returns a shot description or null.
 * The caller turns this into a raycast and damage.
 */
/**
 * @param {object} opts
 * @param {boolean|number} [opts.ads] `true`/`false` for an on/off caller (bots),
 *   or a 0..1 blend for the player. A partial blend gives a partial spread
 *   reduction, which is what makes the cone track the sight instead of
 *   snapping to fully-aimed the instant the button is pressed.
 */
export function tryShoot(w, { aimPitch = 0, aimYaw = 0, moving = false, ads = false, adsBlend, triggerHeld, rng = Math.random } = {}) {
  // `adsBlend` wins when present: it is the continuous version of `ads`.
  const blend = adsBlend === undefined ? (ads ? 1 : 0) : Math.max(0, Math.min(1, adsBlend));
  if (!canFire(w)) return null;
  // Semi-auto weapons need a fresh click; the caller passes the live trigger
  // state so a latched trigger (e.g. after a weapon switch) blocks the shot.
  const held = triggerHeld === undefined ? w.triggerHeld : triggerHeld;
  if (!w.def.auto && held) return null;
  // Recoil/spread: the shot leaves with the current cone half-angle.
  const sp = w.def.spread;
  const moveMul = moving ? sp.moveFactor : 1;
  // Interpolate between hip and aimed cone, not between 0 and the multiplier.
  const adsMul = 1 + (sp.adsFactor - 1) * blend;
  const half = Math.min(sp.max, w.spread) * moveMul * adsMul;
  const yawOffset = (rng() * 2 - 1) * half;
  const pitchOffset = (rng() * 2 - 1) * half * 0.75;
  w.mag -= 1;
  w.cooldown = 60 / w.def.rpm;
  w.triggerHeld = true;
  w.shotsFired += 1;
  w.spread = Math.min(sp.max, w.spread + sp.perShot);
  // Recoil accumulates through a burst and is drained by the controller
  // (`updateWeapon`/`absorbRecoil`). It used to be *set* here and then zeroed
  // after a single read, so a burst had exactly the climb of one shot.
  w.recoilPitch = Math.min(8, w.recoilPitch + w.def.recoil.pitch * (1 + (0.75 - 1) * blend));
  w.recoilYaw += (rng() * 2 - 1) * w.def.recoil.yaw;
  return {
    weaponId: w.id,
    yaw: aimYaw + degToRad(yawOffset),
    pitch: clampPitch(aimPitch - degToRad(pitchOffset)),
    spreadDeg: half,
    damage: w.def.damage,
    range: w.def.range,
  };
}

export function releaseTrigger(w) {
  w.triggerHeld = false;
}

/**
 * Switch weapon. Reload in progress is cancelled; a switch takes `switchTime`
 * during which firing is blocked.
 */
export function switchWeapon(loadout, slotId) {
  if (!loadout.slots[slotId] || loadout.current === slotId) return false;
  const from = activeWeapon(loadout);
  cancelReload(from);
  loadout.current = slotId;
  const to = activeWeapon(loadout);
  to.triggerHeld = true; // avoid instant fire from a held trigger
  to.switching = true;
  to.switchTimer = to.def.switchTime;
  to.spread = to.def.spread.base;
  return true;
}

/** Ammo for HUD. */
export function ammoInfo(loadout) {
  const w = activeWeapon(loadout);
  return { mag: w.mag, reserve: w.reserve, magSize: w.def.magSize, reloading: w.reloading, switching: w.switching, name: w.def.shortName };
}

export function degToRad(d) {
  return (d * Math.PI) / 180;
}
export function radToDeg(r) {
  return (r * 180) / Math.PI;
}
export function clampPitch(p) {
  const lim = degToRad(89);
  return Math.max(-lim, Math.min(lim, p));
}
