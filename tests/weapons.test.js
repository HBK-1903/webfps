import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeaponState, createLoadout, tryShoot, updateWeapon, startReload, switchWeapon, activeWeapon, canFire, ammoInfo, releaseTrigger } from '../src/core/weapon.js';
import { WEAPONS } from '../src/core/config.js';

function fire(w, opts = {}) {
  return tryShoot(w, { aimPitch: 0, aimYaw: 0, ...opts });
}

test('firing spends a round and enforces the rate of fire', () => {
  const w = createWeaponState('rifle');
  const shot = fire(w);
  assert.ok(shot);
  assert.equal(w.mag, WEAPONS.rifle.magSize - 1);
  assert.equal(fire(w), null, 'cooldown must block an instant second shot');
  updateWeapon(w, 60 / WEAPONS.rifle.rpm);
  releaseTrigger(w);
  assert.ok(fire(w), 'shot allowed once the cooldown expired');
});

test('semi-auto pistol needs the trigger released between shots', () => {
  const w = createWeaponState('pistol');
  assert.ok(fire(w));
  updateWeapon(w, 1);
  assert.equal(fire(w), null, 'held trigger must not auto-fire the pistol');
  releaseTrigger(w);
  assert.ok(fire(w), 'released trigger allows the next semi-auto shot');
});

test('an empty magazine cannot fire', () => {
  const w = createWeaponState('pistol');
  w.mag = 0;
  releaseTrigger(w);
  assert.equal(fire(w), null);
  assert.equal(canFire(w), false);
});

test('reload transfers rounds from reserve and respects capacity', () => {
  const w = createWeaponState('rifle');
  w.mag = 3;
  assert.ok(startReload(w));
  updateWeapon(w, WEAPONS.rifle.reloadTime + 0.01);
  assert.equal(w.mag, WEAPONS.rifle.magSize);
  assert.equal(w.reserve, WEAPONS.rifle.reserveAmmo - (WEAPONS.rifle.magSize - 3));
  assert.equal(w.reloading, false);
});

test('reload cannot be started with a full magazine or empty reserve', () => {
  const full = createWeaponState('rifle');
  assert.equal(startReload(full), false);
  const dry = createWeaponState('rifle');
  dry.mag = 5;
  dry.reserve = 0;
  assert.equal(startReload(dry), false);
});

test('firing is blocked while reloading and switching', () => {
  const w = createWeaponState('rifle');
  w.mag = 10;
  startReload(w);
  assert.equal(fire(w), null);
  updateWeapon(w, 5);
  const loadout = createLoadout();
  assert.ok(switchWeapon(loadout, 'pistol'));
  const pistol = activeWeapon(loadout);
  // A latched trigger after the swap blocks the first semi-auto shot.
  assert.equal(tryShoot(pistol, { aimPitch: 0, aimYaw: 0 }), null, 'stale trigger blocks the first shot');
  assert.equal(tryShoot(pistol, { aimPitch: 0, aimYaw: 0 }), null, 'switching blocks fire');
  updateWeapon(pistol, pistol.def.switchTime + 0.01);
  releaseTrigger(pistol); // the player lets go of the mouse button
  assert.ok(tryShoot(pistol, { aimPitch: 0, aimYaw: 0 }), 'can fire after the switch finishes');
});

test('switching away cancels an in-progress reload', () => {
  const loadout = createLoadout();
  loadout.slots.rifle.mag = 4;
  startReload(loadout.slots.rifle);
  assert.equal(loadout.slots.rifle.reloading, true);
  switchWeapon(loadout, 'pistol');
  assert.equal(loadout.slots.rifle.reloading, false);
  assert.equal(loadout.slots.rifle.mag, 4, 'cancelled reload must not grant ammo');
});

test('recoil accumulates per shot and recovers over time', () => {
  const w = createWeaponState('rifle');
  fire(w);
  const afterOne = w.recoilPitch;
  assert.ok(afterOne > 0);
  w.cooldown = 0; // isolate recoil accumulation from the fire-rate limit
  releaseTrigger(w);
  fire(w);
  assert.ok(w.recoilPitch > afterOne, 'consecutive shots kick more');
  const peak = w.recoilPitch;
  updateWeapon(w, 0.05);
  assert.ok(w.recoilPitch < peak && w.recoilPitch > 0, 'recoil decays gradually');
  updateWeapon(w, 3);
  assert.equal(w.recoilPitch, 0, 'recoil fully recovers');
});

test('spread grows when firing and decays back to base', () => {
  const w = createWeaponState('rifle');
  const base = w.spread;
  fire(w);
  assert.ok(w.spread > base);
  updateWeapon(w, 3);
  assert.equal(w.spread, base);
});

test('recoil and spread are weapon-specific', () => {
  assert.ok(WEAPONS.rifle.recoil.pitch !== WEAPONS.pistol.recoil.pitch);
  assert.ok(WEAPONS.rifle.spread.max > WEAPONS.pistol.spread.max);
  assert.ok(WEAPONS.rifle.magSize > WEAPONS.pistol.magSize);
});

test('shots leave inside the current cone', () => {
  const w = createWeaponState('rifle');
  const shot = fire(w);
  assert.ok(Math.abs(shot.yaw) <= (w.def.spread.max * (Math.PI / 180)) + 1e-9);
  assert.ok(shot.range === WEAPONS.rifle.range);
});

test('ammo info for HUD reflects state', () => {
  const loadout = createLoadout();
  loadout.slots.rifle.mag = 7;
  const info = ammoInfo(loadout);
  assert.equal(info.mag, 7);
  assert.equal(info.magSize, WEAPONS.rifle.magSize);
  assert.equal(info.name, WEAPONS.rifle.shortName);
  assert.equal(info.reloading, false);
});
