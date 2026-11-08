// The death animation on an actor rig.
//
// This exists because the sandbox cannot show it: it renders at roughly two
// frames per second, so a 0.55 s topple falls between frames and looks like the
// body teleports to the floor. The animation is therefore verified by driving
// the rig directly with an explicit clock, which is what a real browser does at
// 60 fps and what a screenshot here can never demonstrate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRig, updateRig } from '../src/render/actorRigs.js';

/** A minimal actor: only the fields updateRig reads. */
function fakeActor(overrides = {}) {
  return {
    id: 3,
    alive: true,
    x: 4,
    z: -2,
    yaw: 0,
    pitch: 0,
    crouch: 0,
    speedFactor: 0,
    muzzleTimer: 0,
    ...overrides,
  };
}

/** Step the rig across `seconds` at 60 fps, returning the poses. */
function run(rig, actor, seconds, startTime = 100) {
  const frames = [];
  const step = 1 / 60;
  for (let t = 0; t <= seconds; t += step) {
    updateRig(rig, actor, step, startTime + t, false);
    frames.push({
      t,
      visible: rig.visible,
      rotX: rig.rotation.x,
      rotZ: rig.rotation.z,
      y: rig.position.y,
    });
  }
  return frames;
}

test('a dead actor is still visible while it falls', () => {
  const rig = createRig(fakeActor());
  const actor = fakeActor({ alive: false });
  const frames = run(rig, actor, 0.4);
  // Every frame of the fall must draw the body. The old code had
  // `rig.visible = actor.alive`, which made the corpse vanish instantly.
  assert.ok(frames.every((f) => f.visible), 'düşerken gövde görünmez olmuş');
});

test('the body tips over progressively, not instantly', () => {
  const rig = createRig(fakeActor());
  const actor = fakeActor({ alive: false });
  const frames = run(rig, actor, 0.5);
  assert.ok(frames[1].rotX > -0.2, `ilk karede çok fazla devrilme: ${frames[1].rotX}`);
  const mid = frames[Math.floor(frames.length / 2)];
  assert.ok(mid.rotX < -0.4 && mid.rotX > -1.5, `orta karede devrilme beklenmedik: ${mid.rotX}`);
});

test('the fall finishes face down', () => {
  const rig = createRig(fakeActor());
  run(rig, fakeActor({ alive: false }), 1.2);
  assert.ok(Math.abs(rig.rotation.x + Math.PI / 2) < 0.05, `son açı: ${rig.rotation.x}`);
});

test('the fall is monotonic — it never springs back up', () => {
  const rig = createRig(fakeActor());
  const frames = run(rig, fakeActor({ alive: false }), 0.6);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].rotX <= frames[i - 1].rotX + 1e-9, `kare ${i} geri sıçradı`);
  }
});

test('the body sinks toward the floor as it falls', () => {
  const rig = createRig(fakeActor());
  const frames = run(rig, fakeActor({ alive: false }), 1.2);
  assert.ok(frames[0].y < 0.02, 'başlangıçta zeminden yukarıda');
  assert.ok(frames[frames.length - 1].y > 0.1, 'gövde yere oturmuyor');
});

test('the corpse stays on the floor for a while, then is released', () => {
  const rig = createRig(fakeActor());
  const actor = fakeActor({ alive: false });
  updateRig(rig, actor, 0.016, 100, false);
  // Just after it settles.
  updateRig(rig, actor, 0.016, 101.5, false);
  assert.equal(rig.visible, true, 'ceset hemen kaybolmamalı');
  // Long after.
  updateRig(rig, actor, 0.016, 106, false);
  assert.equal(rig.visible, false, 'ceset sonsuza kadar kalmamalı');
});

test('different actors tip to different sides', () => {
  const rolls = new Set();
  for (let id = 1; id <= 12; id++) {
    const rig = createRig(fakeActor({ id }));
    run(rig, fakeActor({ id, alive: false }), 1.2);
    rolls.add(rig.rotation.z.toFixed(4));
  }
  assert.ok(rolls.size > 1, 'her ceset aynı yöne düşüyor');
});

test('reviving resets the pose so the next death animates again', () => {
  const rig = createRig(fakeActor());
  const dead = fakeActor({ alive: false });
  run(rig, dead, 1.2);
  assert.ok(rig.rotation.x < -1, 'ölü pozisyonda değil');
  // New round.
  updateRig(rig, fakeActor({ alive: true }), 0.016, 200, false);
  assert.equal(rig.rotation.x, 0, 'dirilişte devrilme sıfırlanmadı');
  assert.equal(rig.rotation.z, 0);
  assert.equal(rig.visible, true);
  // Dying again must animate from upright, not from the floor.
  updateRig(rig, fakeActor({ alive: false }), 0.016, 201, false);
  assert.ok(rig.rotation.x > -0.1, 'ikinci ölüm animasyonsuz başladı');
});

test('an alive actor is always visible and upright', () => {
  const rig = createRig(fakeActor());
  const frames = run(rig, fakeActor({ alive: true }), 0.5);
  assert.ok(frames.every((f) => f.visible && Math.abs(f.rotX) < 1e-9), 'canlı oyuncu eğik');
});

test('a rig that has never died has no death timestamp', () => {
  const rig = createRig(fakeActor());
  updateRig(rig, fakeActor({ alive: true }), 0.016, 50, false);
  assert.equal(rig.userData.deathAt, null);
});
