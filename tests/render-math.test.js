// The render angle convention must match the gameplay convention exactly,
// otherwise the crosshair and the bullets disagree (or bots face backwards).

import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Object3D } from 'three';
import { applyCameraAngles, cameraForwardCore, renderYaw } from '../src/render/math.js';
import { directionFromAngles, anglesTo } from '../src/core/combat.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('camera yaw/pitch reproduce the core aim direction', () => {
  const cam = new PerspectiveCamera();
  const cases = [
    [0, 0],
    [Math.PI / 2, 0],
    [-Math.PI / 2, 0],
    [Math.PI, 0],
    [0.7, 0.35],
    [-2.4, -0.5],
    [3.0, 0.02],
  ];
  for (const [yaw, pitch] of cases) {
    applyCameraAngles(cam, yaw, pitch);
    cam.updateMatrixWorld(true);
    const core = directionFromAngles(yaw, pitch);
    const back = cameraForwardCore(cam);
    assert.ok(close(back.dir.x, core.x, 1e-6), `x mismatch at yaw=${yaw}: ${back.dir.x} vs ${core.x}`);
    assert.ok(close(back.dir.y, core.y, 1e-6), `y mismatch at pitch=${pitch}`);
    assert.ok(close(back.dir.z, core.z, 1e-6), `z mismatch at yaw=${yaw}`);
  }
});

test('looking at a target with the camera matches anglesTo()', () => {
  const cam = new PerspectiveCamera();
  const eye = { x: -6, y: 1.62, z: 3 };
  const targets = [
    { x: 12, y: 1.6, z: -8 },
    { x: 0, y: 2.4, z: 9 },
    { x: -20, y: 1.2, z: -20 },
  ];
  for (const t of targets) {
    const a = anglesTo(eye, t);
    applyCameraAngles(cam, a.yaw, a.pitch);
    cam.updateMatrixWorld(true);
    const fwd = cameraForwardCore(cam).dir;
    // The forward vector must point straight at the target.
    const dx = t.x - eye.x;
    const dy = t.y - eye.y;
    const dz = t.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    assert.ok(close(fwd.x, dx / len, 1e-6));
    assert.ok(close(fwd.y, dy / len, 1e-6));
    assert.ok(close(fwd.z, dz / len, 1e-6));
  }
});

test('mouse right turns the view right, not left', () => {
  const cam = new PerspectiveCamera();
  applyCameraAngles(cam, 0, 0);
  cam.updateMatrixWorld(true);
  const before = cameraForwardCore(cam).dir;
  applyCameraAngles(cam, 0.3, 0); // positive yaw = mouse moved right
  const after = cameraForwardCore(cam).dir;
  assert.ok(after.x > before.x, 'increasing yaw must turn toward +X (screen right)');
});

test('an actor rig facing yaw looks along the core direction', () => {
  const rig = new Object3D();
  const cases = [0, 0.9, -1.4, Math.PI, 2.9];
  for (const yaw of cases) {
    rig.rotation.set(0, renderYaw(yaw), 0);
    rig.updateMatrixWorld(true);
    // Rig models are built with the gun pointing along local -Z; the third
    // column of the world matrix is the local +Z axis in world space.
    const m = rig.matrixWorld.elements;
    const forward = { x: -m[8], y: -m[9], z: -m[10] };
    const core = directionFromAngles(yaw, 0);
    assert.ok(close(forward.x, core.x, 1e-6), `rig x ${forward.x} vs core ${core.x} at yaw=${yaw}`);
    assert.ok(close(forward.z, core.z, 1e-6), `rig z ${forward.z} vs core ${core.z} at yaw=${yaw}`);
  }
});
