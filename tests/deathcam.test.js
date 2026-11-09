// Death report, spectating and the killcam.
//
// The failure modes that matter here are not cosmetic: a spectator camera that
// follows a corpse shows the inside of the floor, one that clips into walls
// shows the inside of a box, and a killcam buffer that is never trimmed is a
// memory leak that only shows up after ten minutes of play.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEATH_REPORT_SECONDS,
  KILLCAM_SECONDS,
  createKillcam,
  recordKillcam,
  makeKillerInfo,
  deathReport,
  spectateCandidates,
  cycleSpectate,
  clampCamera,
  spectateEye,
  deathFade,
  sampleKillcam,
  lerpAngle,
  cameraOccluded,
  freeCameraStep,
  killcamUsable,
} from '../src/core/deathcam.js';

const PLAYER = 1;
const actors = [
  { id: 1, name: 'SEN', team: 'A', alive: false, health: 0 },
  { id: 2, name: 'DEMIR', team: 'A', alive: true, health: 80 },
  { id: 3, name: 'KAYA', team: 'A', alive: true, health: 45 },
  { id: 4, name: 'YILMAZ', team: 'A', alive: false, health: 0 },
  { id: 5, name: 'ERSOY', team: 'B', alive: true, health: 100 },
];

// ── death report ────────────────────────────────────────────────────────────

test('a death report names the killer and what they used', () => {
  const r = deathReport({
    attacker: { id: 5, name: 'ERSOY', team: 'B', health: 62 },
    weapon: 'AR-14 TÜFEK',
    headshot: true,
    distance: 17.4,
    round: 2,
    remaining: actors.filter((a) => a.team === 'A'),
  });
  assert.equal(r.killer.name, 'ERSOY');
  assert.equal(r.killer.weapon, 'AR-14 TÜFEK');
  assert.equal(r.killer.headshot, true);
  assert.equal(r.killer.distance, 17.4);
  assert.equal(r.killer.killerHealth, 62);
  assert.equal(r.round, 2);
});

test('a death report survives having no known killer', () => {
  // You can be killed by something that no longer exists — a bot that died on
  // the same tick. The screen still has to say something coherent.
  const r = deathReport({ attacker: null, remaining: [] });
  assert.equal(r.killer.id, -1);
  assert.equal(r.killer.name, 'BİLİNMİYOR');
  assert.ok(Number.isFinite(r.killer.killerHealth));
});

test('a death report counts only living teammates', () => {
  const r = deathReport({ remaining: actors.filter((a) => a.team === 'A') });
  // DEMIR and KAYA live; the player and YILMAZ do not.
  assert.equal(r.teammatesAlive, 2);
  assert.deepEqual(r.aliveNames, ['DEMIR', 'KAYA']);
});

test('a death report does not count the dead player as a teammate', () => {
  const r = deathReport({ remaining: [{ id: 99, name: 'SEN', alive: false }] });
  assert.equal(r.teammatesAlive, 0);
});

test('killer info rounds the health it is given', () => {
  const k = makeKillerInfo({ id: 1, name: 'X', team: 'B', health: 62.7 });
  assert.equal(k.killerHealth, 63);
});

// ── spectate candidates ─────────────────────────────────────────────────────

test('only living teammates can be spectated', () => {
  const c = spectateCandidates({ actors, playerId: PLAYER, team: 'A' });
  assert.deepEqual(c.map((x) => x.name), ['DEMIR', 'KAYA']);
});

test('the player themselves is never a spectate candidate', () => {
  const alive = [{ id: 1, name: 'SEN', team: 'A', alive: true }];
  const c = spectateCandidates({ actors: alive, playerId: 1, team: 'A' });
  assert.equal(c.length, 0);
});

test('enemies are never spectate candidates', () => {
  const c = spectateCandidates({ actors, playerId: PLAYER, team: 'A' });
  assert.ok(!c.some((x) => x.name === 'ERSOY'));
});

test('candidates are in a stable order regardless of input order', () => {
  const shuffled = [actors[4], actors[2], actors[1], actors[3], actors[0]];
  const a = spectateCandidates({ actors, playerId: PLAYER, team: 'A' });
  const b = spectateCandidates({ actors: shuffled, playerId: PLAYER, team: 'A' });
  assert.deepEqual(a, b);
});

test('a null or malformed actor list does not throw', () => {
  assert.deepEqual(spectateCandidates({ actors: [], playerId: 1, team: 'A' }), []);
  assert.deepEqual(spectateCandidates({ actors: [null, undefined], playerId: 1, team: 'A' }), []);
  assert.deepEqual(spectateCandidates(), []);
});

// ── cycling (Q / E) ─────────────────────────────────────────────────────────

test('E steps forward through teammates and wraps', () => {
  const c = [{ id: 2 }, { id: 3 }, { id: 4 }];
  assert.equal(cycleSpectate(c, 2, 1).id, 3);
  assert.equal(cycleSpectate(c, 3, 1).id, 4);
  assert.equal(cycleSpectate(c, 4, 1).id, 2, 'sondan başa sarmalı');
});

test('Q steps backward through teammates and wraps', () => {
  const c = [{ id: 2 }, { id: 3 }, { id: 4 }];
  assert.equal(cycleSpectate(c, 2, -1).id, 4, 'baştan sona sarmalı');
  assert.equal(cycleSpectate(c, 3, -1).id, 2);
});

test('stepping into an empty team yields null, not a crash', () => {
  assert.equal(cycleSpectate([], 2, 1), null);
  assert.equal(cycleSpectate([], 2, -1), null);
});

test('stepping with nothing selected enters at a sensible end', () => {
  const c = [{ id: 2 }, { id: 3 }];
  assert.equal(cycleSpectate(c, 999, 1).id, 2, 'ileri: baştan');
  assert.equal(cycleSpectate(c, 999, -1).id, 3, 'geri: sondan');
});

test('a single teammate always resolves to themselves, both directions', () => {
  const c = [{ id: 7 }];
  assert.equal(cycleSpectate(c, 7, 1).id, 7);
  assert.equal(cycleSpectate(c, 7, -1).id, 7);
});

test('cycling never lands on a dead teammate', () => {
  // The candidate list is rebuilt from live state every frame, so this is
  // really a test that the caller cannot hold a stale id.
  const c = spectateCandidates({ actors, playerId: PLAYER, team: 'A' });
  let current = null;
  for (let i = 0; i < 10; i++) {
    current = cycleSpectate(c, current && current.id, 1);
    assert.ok(current && current.id !== PLAYER);
    assert.ok(actors.find((a) => a.id === current.id).alive);
  }
});

// ── camera placement ────────────────────────────────────────────────────────

test('the spectate eye sits behind the followed actor, not in front', () => {
  // yaw 0 faces -Z, so "behind" is +Z.
  const eye = spectateEye({ x: 0, z: 0, yaw: 0, eyeHeight: 1.6 });
  assert.ok(eye.z > 0.5, `kamera arkada değil: z=${eye.z}`);
  assert.ok(Math.abs(eye.x) < 0.01);
});

test('the spectate eye follows the actor around the compass', () => {
  // Facing +X (yaw = π/2) means behind is -X.
  const eye = spectateEye({ x: 0, z: 0, yaw: Math.PI / 2, eyeHeight: 1.6 });
  assert.ok(eye.x < -0.5, `kamera arkada değil: x=${eye.x}`);
  assert.ok(Math.abs(eye.z) < 0.01);
});

test('the spectate eye lowers when the followed actor crouches', () => {
  const up = spectateEye({ x: 0, z: 0, yaw: 0, eyeHeight: 1.6, crouch: 0 });
  const down = spectateEye({ x: 0, z: 0, yaw: 0, eyeHeight: 1.6, crouch: 1 });
  assert.ok(down.y < up.y, 'çömelen oyuncunun kamerası alçalmıyor');
});

test('a missing eye height still produces a finite camera', () => {
  const eye = spectateEye({ x: 1, z: 2, yaw: 0.3 });
  assert.ok(Number.isFinite(eye.x) && Number.isFinite(eye.y) && Number.isFinite(eye.z));
});

test('the spectator camera is clamped inside the map', () => {
  const bounds = { minX: -31, maxX: 31, minY: 0, maxY: 12, minZ: -21, maxZ: 21, margin: 0.4 };
  const out = clampCamera(500, -20, -900, bounds);
  assert.ok(out.x <= 31 && out.x >= -31);
  assert.ok(out.y >= 0 && out.y <= 12);
  assert.ok(out.z <= 21 && out.z >= -21);
});

test('clamping leaves an in-bounds camera alone', () => {
  const bounds = { minX: -31, maxX: 31, minY: 0, maxY: 12, minZ: -21, maxZ: 21 };
  const out = clampCamera(3, 2, -4, bounds);
  assert.deepEqual(out, { x: 3, y: 2, z: -4 });
});

test('an occluded camera is detected through a wall', () => {
  // A raycast that always hits above length 3, standing in for a wall.
  const raycast = () => ({ distance: 3 });
  assert.equal(cameraOccluded({ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }, raycast), true);
});

test('a clear line of sight is not reported as occluded', () => {
  const raycast = () => null;
  assert.equal(cameraOccluded({ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }, raycast), false);
});

test('a zero-length sight line is not occluded', () => {
  const raycast = () => ({ distance: 0 });
  assert.equal(cameraOccluded({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, raycast), false);
});

// ── free camera ─────────────────────────────────────────────────────────────

test('the free camera moves forward along its facing', () => {
  const out = freeCameraStep({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }, { forward: 1 }, 1);
  // yaw 0 faces -Z.
  assert.ok(out.z < -1, `ileri gitmiyor: z=${out.z}`);
});

test('the free camera strafes to the right', () => {
  const out = freeCameraStep({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }, { right: 1 }, 1);
  assert.ok(out.x > 1, `sağa gitmiyor: x=${out.x}`);
});

test('the free camera rises on up input', () => {
  const out = freeCameraStep({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }, { up: 1 }, 1);
  assert.ok(out.y > 1.6);
});

test('no input means no movement', () => {
  const out = freeCameraStep({ x: 5, y: 2, z: -3, yaw: 1, pitch: 0.2 }, {}, 1);
  assert.equal(out.x, 5);
  assert.equal(out.y, 2);
  assert.equal(out.z, -3);
});

test('the free camera never produces NaN', () => {
  const out = freeCameraStep({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, { forward: 0, right: 0 }, 0);
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z));
});

// ── fade ────────────────────────────────────────────────────────────────────

test('the death fade goes from clear to black smoothly', () => {
  assert.equal(deathFade(0), 0);
  assert.equal(deathFade(1), 1);
  const mid = deathFade(0.175, 0.35);
  assert.ok(mid > 0.4 && mid < 0.6, `orta değer ${mid}`);
});

test('the death fade is monotonic', () => {
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.02) {
    const v = deathFade(t, 0.35);
    assert.ok(v >= prev - 1e-9, `fade geri gitti: ${t}`);
    prev = v;
  }
});

// ── killcam buffer ──────────────────────────────────────────────────────────

test('the killcam buffer holds roughly the requested window', () => {
  const k = createKillcam(2);
  for (let i = 0; i <= 600; i++) {
    recordKillcam(k, i / 60, { x: i * 0.01, y: 1.6, z: 0, yaw: 0, pitch: 0 });
  }
  const span = k.frames[k.frames.length - 1].t - k.frames[0].t;
  assert.ok(span <= 2.05, `tampon çok uzun: ${span}`);
  assert.ok(span >= 1.8, `tampon çok kısa: ${span}`);
});

test('the killcam buffer is bounded even when time jumps', () => {
  const k = createKillcam(2);
  bookFrame(k, 0);
  // A long pause, then a frame ten minutes later.
  recordKillcam(k, 600, { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 });
  assert.ok(k.frames.length <= 400, `tampon sınırsız büyüdü: ${k.frames.length}`);
});

function bookFrame(k, t) {
  for (let i = 0; i < 900; i++) {
    recordKillcam(k, t + i / 60, { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 });
  }
}

test('duplicate timestamps are ignored', () => {
  const k = createKillcam(2);
  recordKillcam(k, 5, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  recordKillcam(k, 5, { x: 9, y: 9, z: 9, yaw: 9, pitch: 9 });
  assert.equal(k.frames.length, 1);
  assert.equal(k.frames[0].x, 0);
});

test('a missing camera is not recorded', () => {
  const k = createKillcam(2);
  recordKillcam(k, 5, null);
  assert.equal(k.frames.length, 0);
});

test('killcam sampling interpolates between frames', () => {
  const k = createKillcam(2);
  recordKillcam(k, 0, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  recordKillcam(k, 1, { x: 10, y: 0, z: 0, yaw: 0, pitch: 0 });
  const mid = sampleKillcam(k, 0.5);
  assert.ok(Math.abs(mid.x - 5) < 1e-9, `orta nokta ${mid.x}`);
});

test('killcam sampling clamps outside the buffer', () => {
  const k = createKillcam(2);
  recordKillcam(k, 1, { x: 1, y: 0, z: 0, yaw: 0, pitch: 0 });
  recordKillcam(k, 2, { x: 2, y: 0, z: 0, yaw: 0, pitch: 0 });
  assert.equal(sampleKillcam(k, -50).x, 1);
  assert.equal(sampleKillcam(k, 50).x, 2);
});

test('an empty killcam samples to null', () => {
  assert.equal(sampleKillcam(createKillcam(2), 5), null);
});

test('killcam yaw interpolation takes the short way round', () => {
  // From just under +π to just over -π. Naive lerp spins nearly the whole way.
  const k = createKillcam(2);
  recordKillcam(k, 0, { x: 0, y: 0, z: 0, yaw: Math.PI - 0.1, pitch: 0 });
  recordKillcam(k, 1, { x: 0, y: 0, z: 0, yaw: -Math.PI + 0.1, pitch: 0 });
  const mid = sampleKillcam(k, 0.5);
  const distToPi = Math.abs(Math.abs(mid.yaw) - Math.PI);
  assert.ok(distToPi < 0.05, `uzun yoldan döndü: ${mid.yaw}`);
});

test('lerpAngle handles the wrap explicitly', () => {
  const out = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
  assert.ok(Math.abs(Math.abs(out) - Math.PI) < 0.05);
});

test('lerpAngle is a plain interpolation away from the wrap', () => {
  assert.ok(Math.abs(lerpAngle(0, 1, 0.5) - 0.5) < 1e-9);
});

test('a killcam with barely any frames is not usable', () => {
  const k = createKillcam(KILLCAM_SECONDS);
  recordKillcam(k, 10, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  assert.equal(killcamUsable(k, 10), false);
});

test('a killcam covering the window is usable', () => {
  const k = createKillcam(KILLCAM_SECONDS);
  for (let i = 0; i <= 120; i++) {
    recordKillcam(k, 10 + i / 60, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  }
  assert.equal(killcamUsable(k, 12), true);
});

test('the death report is shown long enough to read', () => {
  // Two and a half seconds is roughly one short line of Turkish at a glance.
  assert.ok(DEATH_REPORT_SECONDS >= 2 && DEATH_REPORT_SECONDS <= 4);
});

// ── wiring: the state the HUD actually reads ────────────────────────────────
//
// The pure helpers above all passed while the death report was empty on screen,
// because the values never reached `hudState`. These tests assert the contract
// between the simulation and the HUD, which is the seam that broke.

import { createGame, updateGame, hudState } from '../src/core/game.js';
import { resetActorIds } from '../src/core/actor.js';
import { registerDamage } from '../src/core/match.js';

function liveGame(seed = 21) {
  resetActorIds();
  const g = createGame({ difficulty: 'normal', seed });
  g.paused = false;
  g.match.phase = 'live';
  g.match.phaseTime = 0;
  return g;
}

/** Kill the player through the real damage path so the death event fires. */
function killPlayer(game, { headshot = true, distance = 6 } = {}) {
  const foe = game.match.actors.find((a) => a.team !== game.player.team && a.alive);
  foe.x = game.player.x + distance;
  foe.z = game.player.z;
  registerDamage(game.match, foe, game.player, {
    healthLost: game.player.health,
    headshot,
    killed: true,
  });
  updateGame(game, 1 / 60);
  return foe;
}

test('the HUD state carries the death report, not just the debug snapshot', () => {
  const game = liveGame();
  const foe = killPlayer(game);
  const state = hudState(game);
  assert.ok(state.deathInfo, 'deathInfo HUD durumunda yok');
  assert.equal(state.deathInfo.killer.name, foe.name);
  assert.equal(state.deathInfo.killer.headshot, true);
  assert.ok(state.deathInfo.killer.weapon, 'silah adı boş');
});

test('the killer weapon is resolved for bots, which have no weaponName', () => {
  const game = liveGame();
  killPlayer(game);
  const state = hudState(game);
  assert.match(state.deathInfo.killer.weapon, /\S/, 'botun silahı çözülemedi');
});

test('the HUD state reports which teammate is being spectated', () => {
  const game = liveGame();
  killPlayer(game);
  const state = hudState(game);
  assert.equal(state.spectate.mode, 'follow');
  assert.ok(state.spectate.targetId);
  assert.ok(state.spectate.targetName, 'seyredilen takım arkadaşının adı yok');
});

test('dying puts the camera in spectate rather than leaving it on the corpse', () => {
  const game = liveGame();
  killPlayer(game);
  assert.notEqual(game.spectate.mode, 'none');
  assert.notEqual(game.spectate.targetId, game.player.id);
});

test('a new round clears the death report and the spectator camera', () => {
  const game = liveGame();
  killPlayer(game);
  assert.ok(game.deathInfo, 'ölüm raporu oluşmadı');
  assert.notEqual(game.spectate.mode, 'none');

  // Drive the real round cycle rather than poking the phase: end the round by
  // wiping the enemy team, then let the round-end timer run down. Shortening
  // the timer is the only thing skipped — freeze is three seconds of match
  // time, which would make this test take longer than the whole suite.
  for (const foe of game.match.actors) {
    if (foe.team !== game.player.team) {
      foe.alive = false;
      foe.hp = 0;
    }
  }
  updateGame(game, 1 / 60);
  assert.equal(game.match.phase, 'round_end');

  game.match.roundEndTimer = 0.001;
  updateGame(game, 1 / 60);
  game.match.phaseTime = 0;
  updateGame(game, 1 / 60);

  assert.equal(game.deathInfo, null, 'yeni raundda ölüm raporu kalmış');
  assert.equal(game.spectate.mode, 'none', 'yeni raundda seyirci kamerası açık kalmış');
  assert.equal(game.spectate.cam, null);
});

test('the death report never renders a weapon from the wrong actor', () => {
  // Two enemies die in the same tick: the second must not inherit the first's
  // lastDeath record, because the report is matched on victimId.
  const game = liveGame();
  const foes = game.match.actors.filter((a) => a.team !== game.player.team && a.alive);
  registerDamage(game.match, foes[0], foes[1], { healthLost: 100, killed: true });
  const foe = killPlayer(game);
  const state = hudState(game);
  assert.equal(state.deathInfo.killer.id, foe.id, 'rapor yanlış katili gösteriyor');
});
