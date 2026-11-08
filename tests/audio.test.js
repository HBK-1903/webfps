import test from 'node:test';
import assert from 'node:assert/strict';
import { soundPlacement } from '../src/ui/audio.js';
import { createGame, updateGame } from '../src/core/game.js';
import { playerReload } from '../src/core/player.js';
import { activeWeapon } from '../src/core/weapon.js';

// The listener sits at the origin and, at yaw 0, looks down -z (the game's
// convention: see `anglesTo`). +x is to the right.
const at = (x, z) => ({ x, z });
const LISTENER = at(0, 0);

test('sound in front is centred and not behind', () => {
  const p = soundPlacement(LISTENER, at(0, -10), 0);
  assert.equal(p.pan, 0);
  assert.equal(p.distance, 10);
  assert.equal(p.behind, false);
});

test('sound to the right pans hard right', () => {
  const p = soundPlacement(LISTENER, at(10, 0), 0);
  assert.equal(p.pan, 1);
  assert.equal(p.behind, false);
});

test('sound to the left pans hard left', () => {
  const p = soundPlacement(LISTENER, at(-10, 0), 0);
  assert.equal(p.pan, -1);
  assert.equal(p.behind, false);
});

test('sound directly behind is centred but flagged as behind', () => {
  const p = soundPlacement(LISTENER, at(0, 10), 0);
  assert.ok(Math.abs(p.pan) < 1e-9);
  assert.equal(p.behind, true);
});

test('pan follows the camera: turning right moves a front source to the left ear', () => {
  // Yawing +pi/2 turns the camera to face +x, so the source that was straight
  // ahead at (0,-10) is now 90 degrees to the left.
  const p = soundPlacement(LISTENER, at(0, -10), Math.PI / 2);
  assert.ok(Math.abs(p.pan - -1) < 1e-9, `expected -1, got ${p.pan}`);
  assert.equal(p.behind, false);
});

test('pan follows the camera: a right-side source becomes centred when facing it', () => {
  const p = soundPlacement(LISTENER, at(10, 0), Math.PI / 2);
  assert.ok(Math.abs(p.pan) < 1e-9, `expected 0, got ${p.pan}`);
  assert.equal(p.behind, false);
});

test('a source behind the camera when facing it reads as behind', () => {
  const p = soundPlacement(LISTENER, at(-10, 0), Math.PI / 2);
  assert.equal(p.behind, true);
});

test('distance is measured from the listener, not the world origin', () => {
  const p = soundPlacement(at(100, 100), at(100, 90), 0);
  assert.equal(p.distance, 10);
  assert.equal(p.pan, 0);
});

test('pan stays clamped to [-1, 1]', () => {
  for (let i = 0; i < 360; i++) {
    const a = (i * Math.PI) / 180;
    const p = soundPlacement(LISTENER, at(Math.cos(a) * 20, Math.sin(a) * 20), 0);
    assert.ok(p.pan >= -1 && p.pan <= 1, `pan out of range at ${i} deg: ${p.pan}`);
  }
});

test('a source on top of the listener is silent and centred, not NaN', () => {
  const p = soundPlacement(LISTENER, at(0, 0), 1.2);
  assert.equal(p.pan, 0);
  assert.equal(p.distance, 0);
  assert.equal(p.behind, false);
});

test('quantised yaw from the game does not flip sides', () => {
  // Regression guard: the whole point of the stereo work is that an enemy
  // behind-left stays behind-left. Sweep a full turn and check the sign of the
  // pan matches the geometric side, never its mirror.
  for (let i = 0; i < 64; i++) {
    const yaw = (i / 64) * Math.PI * 2 - Math.PI;
    const p = soundPlacement(LISTENER, at(10, 0), yaw);
    const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
    const along = 10 * right.x; // how far right the source sits
    // Skip yaws where the source is (nearly) in line with the view axis: a pan
    // of 0 is the correct answer there, not a failure.
    if (Math.abs(along) < 0.5) continue;
    assert.equal(Math.sign(p.pan), Math.sign(along), `wrong side at yaw ${yaw}`);
  }
});


// ── the sounds the game actually emits ──────────────────────────────────────
// `soundPlacement` is only half the feature: the geometry can be perfect and
// still never be called. These run a headless match and inspect the sound queue
// the renderer drains, so the wiring is covered deterministically instead of
// hoping a 2 FPS browser session happens to catch a bot reload.

/** Run a headless match and collect every sound it pushes. */
function collectSounds({ seconds = 180, seed = 7, difficulty = 'normal' } = {}) {
  const game = createGame({ difficulty, seed });
  game.paused = false;
  const counts = {};
  const withPos = [];
  const ticks = Math.round(seconds * 60);
  for (let i = 0; i < ticks; i++) {
    updateGame(game, 1 / 60);
    while (game.fx.sounds.length) {
      const s = game.fx.sounds.shift();
      counts[s.type] = (counts[s.type] || 0) + 1;
      if (s.x !== undefined) withPos.push(s);
    }
  }
  return { counts, withPos };
}

test('a headless match produces the full sound vocabulary', () => {
  const { counts } = collectSounds();
  for (const name of ['shot', 'death', 'go']) {
    assert.ok(counts[name] > 0, `hiç "${name}" sesi üretilmedi: ${JSON.stringify(counts)}`);
  }
});

test('enemy fire is emitted with a world position, so it can be placed in stereo', () => {
  const { withPos } = collectSounds();
  const shots = withPos.filter((s) => s.type === 'shot');
  assert.ok(shots.length > 20, `sadece ${shots.length} konumlu atış`);
  for (const s of shots) {
    assert.equal(typeof s.x, 'number');
    assert.equal(typeof s.z, 'number');
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z));
  }
});

test('bullets that pass close but miss produce a whizz', () => {
  // Regression guard: this is the only cue that tells the player they are
  // being shot *at*. It was silently absent in the first audio pass.
  const { counts } = collectSounds();
  assert.ok(counts.whizz > 0, `hiç whizz yok: ${JSON.stringify(counts)}`);
});

test('a bot entering a reload is audible and positioned', () => {
  const { counts, withPos } = collectSounds();
  assert.ok(counts.enemy_reload > 0, `hiç enemy_reload yok: ${JSON.stringify(counts)}`);
  const reloads = withPos.filter((s) => s.type === 'enemy_reload');
  assert.ok(reloads.length > 0);
  for (const s of reloads) assert.equal(typeof s.x, 'number');
});

test('the player reload is split into stages rather than one sound', () => {
  const game = createGame({ difficulty: 'normal', seed: 3 });
  game.paused = false;
  // Force a live round, then empty the magazine so a reload will be accepted.
  for (let i = 0; i < 60 * 5 && game.match.phase !== 'live'; i++) updateGame(game, 1 / 60);
  const w = activeWeapon(game.player.loadout);
  w.mag = 0;

  const counts = {};
  let sawStart = false;
  let sawMagOut = false;
  let sawMagIn = false;
  // Call the controller's reload the way the R key does, then advance until the
  // reload completes, collecting the feedback it pushes.
  assert.equal(playerReload(game.pc), true, 'şarjör değişimi kabul edilmedi');
  for (let i = 0; i < 60 * 4; i++) {
    updateGame(game, 1 / 60);
    while (game.fx.sounds.length) {
      const s = game.fx.sounds.shift();
      counts[s.type] = (counts[s.type] || 0) + 1;
      if (s.type === 'reload_start') sawStart = true;
      if (s.type === 'reload_mag_out') sawMagOut = true;
      if (s.type === 'reload_mag_in') sawMagIn = true;
    }
  }
  assert.ok(sawStart, `reload_start yok: ${JSON.stringify(counts)}`);
  assert.ok(sawMagOut, `reload_mag_out yok (şarjör düşme sesi): ${JSON.stringify(counts)}`);
  assert.ok(sawMagIn, `reload_mag_in yok (yeni şarjör oturma sesi): ${JSON.stringify(counts)}`);
});
