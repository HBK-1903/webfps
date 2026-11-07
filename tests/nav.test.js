import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../src/core/navgrid.js';
import { MAP_AABBS, SPAWNS, ROUTES, MAP_BOXES } from '../src/core/map.js';
import { moveCircle, losClear, raycastBoxes, circleOverlapsBox } from '../src/core/collision.js';
import { PLAYER } from '../src/core/config.js';

const grid = new NavGrid(MAP_AABBS);

test('the nav grid covers the whole playable area', () => {
  assert.ok(grid.cols > 40 && grid.rows > 30);
  let walkable = 0;
  for (let i = 0; i < grid.walkable.length; i++) walkable += grid.walkable[i];
  const ratio = walkable / grid.walkable.length;
  assert.ok(ratio > 0.55, `too much of the map is blocked (${(ratio * 100).toFixed(1)}%)`);
});

test('both spawn points are walkable and not blocked by cover', () => {
  for (const team of ['A', 'B']) {
    for (const s of SPAWNS[team]) {
      assert.ok(grid.isWalkableAt(s.x, s.z), `spawn ${team} ${s.x},${s.z} must be walkable`);
      for (const b of MAP_AABBS) {
        assert.equal(circleOverlapsBox(s.x, s.z, PLAYER.radius, b), false, 'spawn point must not be inside a box');
      }
    }
  }
});

test('spawns are symmetric between the two teams', () => {
  assert.equal(SPAWNS.A.length, SPAWNS.B.length);
  SPAWNS.A.forEach((a, i) => {
    const b = SPAWNS.B[i];
    assert.ok(Math.abs(a.x + b.x) < 1e-6, 'spawns must mirror on X');
    assert.ok(Math.abs(a.z - b.z) < 1e-6, 'spawns must mirror on Z');
  });
});

test('spawn areas have no direct line of sight to each other', () => {
  const eye = { x: SPAWNS.A[2].x, y: 1.62, z: SPAWNS.A[2].z };
  const target = { x: SPAWNS.B[2].x, y: 1.62, z: SPAWNS.B[2].z };
  assert.equal(losClear(eye, target, MAP_AABBS), false, 'spawns must not snipe each other across the map');
});

test('A* finds a path across the map through the lanes', () => {
  const path = grid.findPath(SPAWNS.A[0].x, SPAWNS.A[0].z, 18, 0);
  assert.ok(path.length > 1, 'a cross-map path must exist');
  const last = path[path.length - 1];
  assert.ok(Math.hypot(last.x - 18, last.z - 0) < 6, 'path must end near the goal');
});

test('every lane waypoint is reachable from both spawns', () => {
  for (const team of ['A', 'B']) {
    for (const lane of Object.keys(ROUTES[team])) {
      for (const wp of ROUTES[team][lane]) {
        const path = grid.findPath(SPAWNS[team][0].x, SPAWNS[team][0].z, wp.x, wp.z);
        assert.ok(path.length > 0, `lane ${lane} waypoint ${wp.x},${wp.z} unreachable for ${team}`);
      }
    }
  }
});

test('paths never pass through walls', () => {
  const path = grid.findPath(-27.5, 0, 27.5, 0);
  assert.ok(path.length > 0);
  for (const p of path) {
    assert.ok(grid.isWalkableAt(p.x, p.z), 'waypoints must be walkable');
  }
});

test('the map is symmetric: box count is mirrored on both axes', () => {
  const key = (b) => `${b.x.toFixed(1)}|${b.y.toFixed(1)}|${b.z.toFixed(1)}|${b.w}|${b.h}|${b.d}`;
  const set = new Set(MAP_BOXES.map(key));
  for (const b of MAP_BOXES) {
    // A mirror may coincide with itself for boxes centred on an axis.
    const mirrored = { ...b, x: -b.x, z: -b.z };
    const mirroredX = { ...b, x: -b.x };
    assert.ok(
      set.has(key(mirrored)) || set.has(key(mirroredX)) || b.x === 0 || b.z === 0,
      `box ${key(b)} has no mirror`,
    );
  }
});

test('wall sliding keeps a moving circle out of geometry', () => {
  // Walk straight into the centre block from the south.
  let x = 0;
  let z = 7;
  for (let i = 0; i < 200; i++) {
    const moved = moveCircle(x, z, 0, -0.2, PLAYER.radius, MAP_AABBS);
    x = moved.x;
    z = moved.z;
  }
  assert.ok(z > 4 - 0.001, `player must not pass through the centre block (z=${z})`);
});

test('fast movement cannot tunnel through a thin wall', () => {
  let x = -6;
  const z = -10.6; // the north/mid divider wall lives here
  for (let i = 0; i < 60; i++) {
    const moved = moveCircle(x, z, 0.6, 0, PLAYER.radius, MAP_AABBS);
    x = moved.x;
  }
  // The divider spans x in [-14,-4] at z=-10.6; sliding along it must keep us out.
  assert.equal(circleOverlapsBox(x, z, PLAYER.radius - 0.01, MAP_AABBS.find((b) => b.kind === 'wall' && b.minZ < -10 && b.maxZ > -11) || { minX: 1, maxX: 2, minZ: 1, maxZ: 2, minY: 0, maxY: 1 }), false);
});

test('raycasts hit the nearest wall only', () => {
  const hit = raycastBoxes(0, 1.6, 18, 0, 0, -1, MAP_AABBS, 60);
  assert.ok(hit, 'ray from the south edge must hit something');
  assert.ok(hit.distance > 0 && hit.distance < 60);
  const none = raycastBoxes(0, 1.6, 18, 0, 1, 0, MAP_AABBS, 60);
  assert.equal(none, null, 'looking straight up in the open hits nothing');
});

test('line of sight is blocked by the centre block', () => {
  assert.equal(losClear({ x: 0, y: 1.6, z: 6 }, { x: 0, y: 1.6, z: -6 }, MAP_AABBS), false);
  assert.equal(losClear({ x: -16, y: 1.6, z: -18 }, { x: -16, y: 1.6, z: -16 }, MAP_AABBS), true);
});

test('the map is 180° rotationally symmetric (no side has better cover)', () => {
  const key = (b) =>
    [b.x, b.y, b.z, b.w, b.h, b.d].map((v) => v.toFixed(3)).join('|');
  const set = new Set(MAP_BOXES.map(key));
  const missing = MAP_BOXES.filter((b) => !set.has(key({ ...b, x: -b.x, z: -b.z })));
  assert.equal(missing.length, 0, `boxes without a mirror: ${missing.map(key).join(', ')}`);
});
