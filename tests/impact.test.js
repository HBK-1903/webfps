// Impact geometry.
//
// These are the bugs that are invisible in code review and obvious on screen:
// a decal lying flat in mid-air, sparks firing into the wall they came from,
// debris that never falls. All of it is arithmetic, so all of it is testable
// here without a GPU.

import test from 'node:test';
import assert from 'node:assert/strict';

import { faceNormal, offsetAlong, sparkBurst, stepSpark, sparkAlpha } from '../src/render/impact.js';

const WALL = { minX: -1, maxX: 1, minY: 0, maxY: 4, minZ: -1, maxZ: 1 };

/**
 * The direction sparks are actually thrown, given a face normal.
 *
 * Walls and ceilings throw outward along the normal. A floor (normal pointing
 * down) throws upward instead: debris comes back out of the hole the round made.
 */
function effectiveDirection(normal) {
  return normal[1] < -0.5 ? [0, 1, 0] : normal;
}

/** Deterministic generator, so scatter tests are exact rather than statistical. */
function seeded(seed = 12345) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

test('a point on the top of a box reports the top face', () => {
  const f = faceNormal(WALL, { x: 0.1, y: 4, z: 0.1 });
  assert.equal(f.axis, 'y');
  assert.equal(f.sign, 1);
  assert.deepEqual(f.normal, [0, 1, 0]);
});

test('a point on the floor of a box reports the bottom face', () => {
  const f = faceNormal(WALL, { x: 0.1, y: 0, z: 0.1 });
  assert.equal(f.axis, 'y');
  assert.equal(f.sign, -1);
  assert.deepEqual(f.normal, [0, -1, 0]);
});

test('each of the four side faces is identified with the right sign', () => {
  assert.deepEqual(faceNormal(WALL, { x: 1, y: 2, z: 0 }).normal, [1, 0, 0]);
  assert.deepEqual(faceNormal(WALL, { x: -1, y: 2, z: 0 }).normal, [-1, 0, 0]);
  assert.deepEqual(faceNormal(WALL, { x: 0, y: 2, z: 1 }).normal, [0, 0, 1]);
  assert.deepEqual(faceNormal(WALL, { x: 0, y: 2, z: -1 }).normal, [0, 0, -1]);
});

test('a long thin box does not always win on its long axis', () => {
  // A boundary wall 62 m long, 4 m tall, 1 m thick. A hit on the narrow X end
  // is 31 m from the centre, which is large in absolute terms — a naive
  // "largest absolute distance" test would still get this right, but one based
  // on un-normalised distance to each plane would not.
  const longWall = { minX: -31, maxX: 31, minY: 0, maxY: 4, minZ: -0.5, maxZ: 0.5 };
  assert.equal(faceNormal(longWall, { x: 31, y: 2, z: 0 }).axis, 'x');
  assert.equal(faceNormal(longWall, { x: 0, y: 4, z: 0 }).axis, 'y');
  assert.equal(faceNormal(longWall, { x: 0, y: 2, z: 0.5 }).axis, 'z');
});

test('a zero-thickness box does not divide by zero', () => {
  const flat = { minX: 0, maxX: 0, minY: 0, maxY: 4, minZ: -1, maxZ: 1 };
  const f = faceNormal(flat, { x: 0, y: 2, z: 0.2 });
  assert.ok(Number.isFinite(f.sign));
  assert.ok(f.normal.every((n) => Number.isFinite(n)));
});

test('every normal is a unit vector pointing along one axis', () => {
  const rng = seeded(7);
  for (let i = 0; i < 200; i++) {
    const p = {
      x: WALL.minX + rng() * (WALL.maxX - WALL.minX),
      y: WALL.minY + rng() * (WALL.maxY - WALL.minY),
      z: WALL.minZ + rng() * (WALL.maxZ - WALL.minZ),
    };
    const { normal } = faceNormal(WALL, p);
    const len = Math.hypot(...normal);
    assert.ok(Math.abs(len - 1) < 1e-9, `birim vektör değil: ${normal}`);
    assert.equal(normal.filter((n) => n !== 0).length, 1, `eksen dışı normal: ${normal}`);
  }
});

test('the normal always points away from the box interior', () => {
  // This is the property that actually matters: a sign flip here paints the
  // decal on the inside of the wall, where nobody can see it.
  const rng = seeded(99);
  const cx = 0;
  const cy = 2;
  const cz = 0;
  for (let i = 0; i < 200; i++) {
    const p = {
      x: WALL.minX + rng() * 2,
      y: WALL.minY + rng() * 4,
      z: WALL.minZ + rng() * 2,
    };
    const { normal } = faceNormal(WALL, p);
    const away = (p.x - cx) * normal[0] + (p.y - cy) * normal[1] + (p.z - cz) * normal[2];
    assert.ok(away >= 0, `normal içeri bakıyor: nokta ${JSON.stringify(p)} normal ${normal}`);
  }
});

test('a decal is offset off its surface, along the normal', () => {
  const p = { x: 1, y: 2, z: 0 };
  const out = offsetAlong(p, [1, 0, 0], 0.003);
  assert.ok(out.x > p.x);
  assert.equal(out.y, p.y);
  assert.equal(out.z, p.z);
  assert.ok(Math.abs(out.x - p.x - 0.003) < 1e-12);
});

test('the offset is small enough to be invisible and large enough to matter', () => {
  // Below ~1 mm a decal z-fights; above ~1 cm it floats visibly off the wall at
  // close range. Three millimetres is the middle of that window.
  const out = offsetAlong({ x: 0, y: 0, z: 0 }, [0, 0, 1]);
  assert.ok(out.z >= 0.001 && out.z <= 0.01, `ofset ${out.z}`);
});

test('sparks always leave the surface, never enter it', () => {
  // The single most visible failure mode: a burst fired into the wall is
  // invisible, and it looks like the hit did nothing.
  //
  // For walls and ceilings "away from the surface" is the face normal. For a
  // floor it is the opposite, because the chips come back out the way the round
  // went in — see `effectiveDirection`.
  const rng = seeded(42);
  for (const normal of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const outward = effectiveDirection(normal);
    const sparks = sparkBurst(normal, 40, rng);
    for (const s of sparks) {
      const along = s.vx * outward[0] + s.vy * outward[1] + s.vz * outward[2];
      assert.ok(along > 0, `kıvılcım yüzeye giriyor: normal ${normal}, izdüşüm ${along}`);
    }
  }
});

test('a floor pick-up still throws sparks away from the ground', () => {
  // Specifically the case that was broken: the normal is (0,-1,0), and using it
  // literally buried the whole burst.
  const sparks = sparkBurst([0, -1, 0], 40, seeded(8));
  for (const s of sparks) {
    assert.ok(s.vy > 0, `zemin kıvılcımı aşağı gidiyor: ${s.vy}`);
  }
});

test('sparks on a floor still get a little lift', () => {
  // A floor impact fires downward-ish; without the lift the debris is invisible
  // below the surface immediately.
  const sparks = sparkBurst([0, -1, 0], 30, seeded(5));
  assert.ok(sparks.some((s) => s.vy > 0), 'hiçbir kıvılcım yukarı gitmiyor');
});

test('spark speed stays in a sane band', () => {
  const rng = seeded(3);
  const sparks = sparkBurst([0, 1, 0], 100, rng, 0.85, 3.2);
  for (const s of sparks) {
    const v = Math.hypot(s.vx, s.vy, s.vz);
    assert.ok(v > 0.5 && v < 14, `hız aralık dışı: ${v}`);
  }
});

test('a burst returns the number of sparks asked for', () => {
  assert.equal(sparkBurst([0, 1, 0], 0, seeded()).length, 0);
  assert.equal(sparkBurst([0, 1, 0], 7, seeded()).length, 7);
});

test('a burst is reproducible for a given seed', () => {
  const a = sparkBurst([0, 1, 0], 12, seeded(11));
  const b = sparkBurst([0, 1, 0], 12, seeded(11));
  assert.deepEqual(a, b);
});

test('gravity pulls a spark down over time', () => {
  let s = { x: 0, y: 1, z: 0, vx: 0, vy: 5, vz: 0, age: 0, life: 1 };
  const before = s.vy;
  s = stepSpark(s, 0.1);
  assert.ok(s.vy < before, 'yerçekimi hızı azaltmıyor');
  // It should rise, slow, and eventually fall back.
  for (let i = 0; i < 60; i++) s = stepSpark(s, 1 / 60);
  assert.ok(s.vy < 0, 'kıvılcım hiç düşmüyor');
});

test('a spark moves along its velocity', () => {
  const s = stepSpark({ x: 0, y: 0, z: 0, vx: 2, vy: 0, vz: 0, age: 0, life: 1 }, 0.5);
  // 0.5 s at 2 m/s, minus nothing horizontally (gravity only affects y).
  assert.ok(Math.abs(s.x - 1) < 1e-9);
});

test('spark alpha fades from opaque to nothing', () => {
  const base = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1 };
  assert.equal(sparkAlpha({ ...base, age: 0 }), 1);
  assert.ok(Math.abs(sparkAlpha({ ...base, age: 1 })) < 1e-9);
  const mid = sparkAlpha({ ...base, age: 0.5 });
  assert.ok(mid < 1 && mid > 0);
  // Not linear: the ease-out keeps it bright early.
  assert.ok(mid > 0.25, `orta değer çok sönük: ${mid}`);
});

test('spark alpha is clamped outside its lifetime', () => {
  const base = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1 };
  assert.equal(sparkAlpha({ ...base, age: -5 }), 1);
  assert.equal(sparkAlpha({ ...base, age: 99 }), 0);
});

test('a zero-lifetime spark does not produce NaN', () => {
  const a = sparkAlpha({ age: 0.5, life: 0 });
  assert.ok(Number.isFinite(a));
});
