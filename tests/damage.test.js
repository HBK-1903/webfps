import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDamage, damageAtDistance, damageAllowed } from '../src/core/damage.js';
import { WEAPONS, COMBAT } from '../src/core/config.js';

test('armour absorbs only part of the damage and is never immunity', () => {
  const r = resolveDamage({ health: 100, armor: 50, damage: 40 });
  assert.equal(r.armorAbsorbed, 20); // 50% of 40
  assert.equal(r.healthLost, 20);
  assert.equal(r.health, 80);
  assert.equal(r.armor, 30);
  assert.equal(r.killed, false);
});

test('armour never reduces health damage to zero while armour remains', () => {
  const r = resolveDamage({ health: 100, armor: 50, damage: 10 });
  assert.ok(r.healthLost > 0, 'some health damage must always land');
  assert.ok(r.armorAbsorbed < 10);
});

test('armour depletion spills the remainder into health', () => {
  const r = resolveDamage({ health: 100, armor: 4, damage: 30 });
  assert.equal(r.armor, 0);
  assert.equal(r.armorAbsorbed, 4);
  assert.equal(r.healthLost, 26);
  assert.equal(r.health, 74);
});

test('headshot multiplies damage for both teams equally', () => {
  const body = resolveDamage({ health: 100, armor: 0, damage: 20 });
  const head = resolveDamage({ health: 100, armor: 0, damage: 20, headshot: true });
  assert.equal(head.raw, body.raw * COMBAT.headMultiplier);
  assert.ok(head.healthLost > body.healthLost);
});

test('headshot can kill a full-health target with the rifle', () => {
  const r = resolveDamage({ health: 100, armor: 0, damage: WEAPONS.rifle.damage, headshot: true });
  assert.ok(r.raw > 50, 'headshots must be strongly punishing');
});

test('killing blows clamp health at zero and flag the kill once', () => {
  const r = resolveDamage({ health: 5, armor: 0, damage: 100 });
  assert.equal(r.health, 0);
  assert.equal(r.killed, true);
  const dead = resolveDamage({ health: 0, armor: 0, damage: 100 });
  assert.equal(dead.killed, false, 'already-dead targets must not re-trigger a kill');
});

test('damage falls off with distance but never below the floor', () => {
  const w = WEAPONS.rifle;
  const near = damageAtDistance(w, 0);
  const mid = damageAtDistance(w, w.range * 0.8);
  const far = damageAtDistance(w, w.range * 1.5);
  assert.equal(near, w.damage);
  assert.ok(mid < near && mid > far);
  assert.ok(far >= w.damage * w.falloffFactor - 1e-9);
});

test('friendly fire is disabled for the MVP and documented', () => {
  assert.equal(COMBAT.friendlyFire, false);
  assert.equal(damageAllowed('A', 'A'), false);
  assert.equal(damageAllowed('A', 'B'), true);
});

test('weapon definitions are original and complete', () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.equal(w.id, id);
    for (const key of ['damage', 'rpm', 'magSize', 'reserveAmmo', 'reloadTime', 'range']) {
      assert.ok(w[key] > 0, `${id}.${key} must be positive`);
    }
    assert.ok(w.recoil.pitch > 0 && w.recoil.recovery > 0);
    assert.ok(w.spread.max >= w.spread.base);
    assert.ok(!/ak-?47|m4|glock|usp|awp|deagle|colt|kalashnikov/i.test(w.name), `${w.name} is too close to a real model`);
  }
});
