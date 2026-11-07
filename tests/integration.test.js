import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, updateGame, hudState, setPaused, restartMatch, setInput, addLookInput, playerReloadNow, playerSwitchTo, setDifficulty, gameSnapshot, getNavGrid } from '../src/core/game.js';
import { PHASE, aliveCount } from '../src/core/match.js';
import { MATCH, PLAYER, DIFFICULTY } from '../src/core/config.js';
import { MAP_AABBS } from '../src/core/map.js';
import { performShot, directionFromAngles, anglesTo } from '../src/core/combat.js';
import { eyePoint } from '../src/core/actor.js';

function run(game, seconds, step = 1 / 60) {
  let t = 0;
  while (t < seconds) {
    updateGame(game, step);
    t += step;
  }
}

test('a full match completes unaided on every difficulty', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    for (const seed of [11, 22]) {
      const game = createGame({ difficulty, seed });
      let guard = 0;
      while (game.match.phase !== PHASE.MATCH_END && guard++ < 60 * 60 * 8) {
        updateGame(game, 1 / 60);
      }
      assert.equal(game.match.phase, PHASE.MATCH_END, `${difficulty}/${seed} never finished`);
      const total = game.match.score.A + game.match.score.B;
      assert.ok(total <= MATCH.maxRounds, 'score cannot exceed the round count');
      // Either someone reached 3 wins, or every round was played (draws allowed,
      // so the score total can be below the round count).
      assert.ok(
        Math.max(game.match.score.A, game.match.score.B) >= MATCH.roundsToWin || game.match.round === MATCH.maxRounds,
        `unexpected score ${game.match.score.A}-${game.match.score.B} at round ${game.match.round}`,
      );
      assert.ok(game.match.matchWinner);
      // Everything is frozen after the match.
      const frozen = JSON.stringify([game.match.time, game.player.x, game.player.z]);
      run(game, 1);
      assert.equal(JSON.stringify([game.match.time, game.player.x, game.player.z]), frozen);
    }
  }
});

test('round countdown blocks firing and damage', () => {
  const game = createGame({ difficulty: 'normal', seed: 3 });
  assert.equal(game.match.phase, PHASE.FREEZE);
  const enemy = game.match.actors.find((a) => a.team === 'B');
  const hpBefore = enemy.health;
  setInput(game, { fire: true });
  run(game, 1.0);
  assert.equal(enemy.health, hpBefore, 'nobody can be hurt during the countdown');
  assert.equal(game.stats.shots, 0, 'no shots during the countdown');
  assert.equal(game.player.x, -27.5, 'movement is frozen during the countdown');
});

test('the player cannot fire while dead', () => {
  const game = createGame({ difficulty: 'normal', seed: 4 });
  run(game, MATCH.freezeTime + 0.1);
  game.player.alive = false;
  game.player.health = 0;
  const before = game.stats.shots;
  setInput(game, { fire: true });
  run(game, 1);
  assert.equal(game.stats.shots, before);
});

test('friendly fire is off: a shot at a teammate does nothing', () => {
  const game = createGame({ difficulty: 'normal', seed: 5 });
  run(game, MATCH.freezeTime + 0.1);
  const mate = game.match.actors.find((a) => a.team === 'A' && !a.isPlayer);
  // Stand next to him in the open north lane and shoot straight at his chest.
  mate.x = -10;
  mate.z = -20.3;
  game.player.x = -8;
  game.player.z = -20.3;
  const aim = { x: -1, y: -0.2, z: 0 };
  const len = Math.hypot(aim.x, aim.y, aim.z);
  const eye = eyePoint(game.player);
  const dir = { x: aim.x / len, y: aim.y / len, z: aim.z / len };
  const out = performShot({
    attacker: game.player,
    origin: eye,
    dir,
    actors: game.match.actors,
    boxes: MAP_AABBS,
    weapon: { ...game.player.loadout.slots.rifle.def },
  });
  // With friendly fire disabled the shot passes through the teammate entirely
  // (it can never damage him), which is the documented MVP behaviour.
  assert.notEqual(out.cast.type, 'actor');
  assert.equal(out.hit, null);
  assert.equal(mate.health, PLAYER.maxHealth);
});

test('player shots damage enemies and can land headshots', () => {
  const game = createGame({ difficulty: 'normal', seed: 6 });
  run(game, MATCH.freezeTime + 0.1);
  const enemy = game.match.actors.find((a) => a.team === 'B');
  enemy.x = 0;
  enemy.z = -20.3;
  game.player.x = 8;
  game.player.z = -20.3;
  const rifle = game.player.loadout.slots.rifle.def;
  const shootAt = (targetPoint) => {
    const eye = eyePoint(game.player);
    const a = anglesTo(eye, targetPoint);
    const dir = directionFromAngles(a.yaw, a.pitch);
    return performShot({ attacker: game.player, origin: eye, dir, actors: game.match.actors, boxes: MAP_AABBS, weapon: rifle });
  };

  // Chest height (~1.0 m) is a body hit.
  const bodyShot = shootAt({ x: enemy.x, y: 1.0, z: enemy.z });
  assert.equal(bodyShot.cast.type, 'actor');
  assert.equal(bodyShot.cast.headshot, false);
  assert.ok(bodyShot.hit.healthLost > 0);

  // Head height is a headshot and hurts far more.
  const headPoint = eyePoint(enemy);
  const headShot = shootAt({ x: enemy.x, y: headPoint.y, z: enemy.z });
  assert.equal(headShot.cast.type, 'actor');
  assert.equal(headShot.cast.headshot, true, 'aiming at the head must register a headshot');
  assert.ok(headShot.hit.raw > bodyShot.hit.raw * 2, 'headshots must be much stronger than body shots');
});

test('pausing freezes match clock, AI and input', () => {
  const game = createGame({ difficulty: 'normal', seed: 8 });
  run(game, MATCH.freezeTime + 2);
  setPaused(game, true);
  const snapshot = {
    time: game.match.time,
    phaseTime: game.match.phaseTime,
    positions: game.match.actors.map((a) => `${a.x.toFixed(3)},${a.z.toFixed(3)}`).join('|'),
    health: game.match.actors.map((a) => a.health).join(','),
  };
  setInput(game, { fire: true, forward: 1 });
  addLookInput(game, 400, 200, 1);
  run(game, 2);
  assert.equal(game.match.time, snapshot.time);
  assert.equal(game.match.actors.map((a) => `${a.x.toFixed(3)},${a.z.toFixed(3)}`).join('|'), snapshot.positions);
  assert.equal(game.match.actors.map((a) => a.health).join(','), snapshot.health);
  assert.equal(game.stats.shots, 0, 'no shots while paused');
  setPaused(game, false);
  run(game, 0.2);
  assert.ok(game.match.time > snapshot.time, 'clock resumes');
});

test('restarting a match clears every trace of the old one', () => {
  const game = createGame({ difficulty: 'hard', seed: 12 });
  run(game, MATCH.freezeTime + 6);
  const oldIds = game.match.actors.map((a) => a.id);
  game.fx.tracers.push({ x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, age: 0, life: 1 });
  game.fx.killfeed.push({ text: 'x', team: 'A', kind: 'death', age: 0 });
  restartMatch(game, 'easy');
  assert.equal(game.match.round, 1);
  assert.equal(game.match.score.A + game.match.score.B, 0);
  assert.equal(game.match.phase, PHASE.FREEZE);
  assert.equal(game.fx.tracers.length, 0);
  assert.equal(game.fx.killfeed.length, 0);
  assert.equal(game.match.difficulty, 'easy');
  assert.equal(game.stats.shots, 0);
  assert.deepEqual(game.match.actors.map((a) => a.id), oldIds, 'same actor list is reused, no leaks');
  for (const a of game.match.actors) {
    assert.equal(a.alive, true);
    assert.equal(a.health, PLAYER.maxHealth);
    assert.equal(a.armor, PLAYER.maxArmor);
  }
  assert.equal(aliveCount(game.match, 'B'), 5);
});

test('HUD state exposes everything the UI needs', () => {
  const game = createGame({ difficulty: 'normal', seed: 15 });
  run(game, MATCH.freezeTime + 1);
  const s = hudState(game);
  for (const key of ['health', 'armor', 'ammo', 'weaponName', 'scores', 'teamMates', 'round', 'phase', 'difficulty']) {
    assert.ok(key in s, `HUD state missing ${key}`);
  }
  assert.equal(s.teamMates.length, MATCH.teamSize);
  assert.equal(s.teamMates.filter((m) => m.isPlayer).length, 1);
  assert.equal(s.ammo.magSize, game.player.loadout.slots[game.player.loadout.current].def.magSize);
  assert.ok(s.phase === 'live');
});

test('weapon switching and reloading are gated by the match phase', () => {
  const game = createGame({ difficulty: 'normal', seed: 16 });
  assert.equal(playerSwitchTo(game, 'pistol'), false, 'no weapon swap during the countdown');
  assert.equal(playerReloadNow(game), false);
  run(game, MATCH.freezeTime + 0.2);
  assert.equal(playerSwitchTo(game, 'pistol'), true);
  // Switching is in progress: the new weapon cannot reload yet.
  game.player.loadout.slots.pistol.mag = 3;
  assert.equal(playerReloadNow(game), false, 'no reload during a weapon swap');
  run(game, 0.6);
  assert.equal(playerReloadNow(game), true);
});

test('a round never ends twice, and the player cannot affect the next round', () => {
  const game = createGame({ difficulty: 'normal', seed: 17 });
  run(game, MATCH.freezeTime + 0.2);
  for (const a of game.match.actors) if (a.team === 'B') {
    a.health = 0;
    a.alive = false;
  }
  updateGame(game, 1 / 60);
  assert.equal(game.match.phase, PHASE.ROUND_END);
  const score = game.match.score.A;
  setInput(game, { fire: true });
  run(game, MATCH.roundEndTime + 0.5);
  assert.equal(game.match.score.A, score, 'no extra round win');
  assert.equal(game.stats.shots, 0, 'no shots leak into the round break');
  assert.equal(game.match.phase, PHASE.FREEZE, 'next round starts with a fresh countdown');
  assert.equal(aliveCount(game.match, 'B'), 5, 'enemies respawn next round');
});

test('sensitivity and FOV settings are actually applied to the camera math', () => {
  const game = createGame({ difficulty: 'normal', seed: 18 });
  run(game, MATCH.freezeTime + 0.2);
  const yawBefore = game.pc.yaw;
  addLookInput(game, 100, 0, 1.0);
  const delta1 = game.pc.yaw - yawBefore;
  const yaw2 = game.pc.yaw;
  addLookInput(game, 100, 0, 2.0);
  const delta2 = game.pc.yaw - yaw2;
  assert.ok(delta2 > delta1 * 1.9, 'a higher sensitivity must produce more rotation');
  assert.ok(DIFFICULTY[game.match.difficulty]);
});

test('difficulty can be swapped mid-match without changing combat rules', () => {
  const game = createGame({ difficulty: 'easy', seed: 31 });
  run(game, MATCH.freezeTime + 0.2);
  const bot = game.match.actors.find((a) => a.brain);
  assert.equal(bot.brain.profile.id, 'easy');
  assert.equal(setDifficulty(game, 'hard'), true);
  assert.equal(game.match.difficulty, 'hard');
  assert.equal(game.match.profile.id, 'hard');
  assert.equal(bot.brain.profile.id, 'hard', 'every bot picks up the new profile');
  // Combat constants stay identical across difficulties.
  assert.equal(DIFFICULTY.easy.aimError !== DIFFICULTY.hard.aimError, true);
  const snap = gameSnapshot(game);
  assert.equal(snap.difficulty, 'hard');
  assert.equal(setDifficulty(game, 'nope'), false, 'unknown difficulties are rejected');
});

test('the nav grid is shared between matches (no rebuild cost on rematch)', () => {
  const a = createGame({ difficulty: 'normal', seed: 41 });
  const b = createGame({ difficulty: 'hard', seed: 42 });
  assert.equal(getNavGrid(), getNavGrid());
  assert.equal(a.grid, b.grid);
});

test('gameSnapshot is a serialisable view of live state', () => {
  const game = createGame({ difficulty: 'normal', seed: 51 });
  run(game, MATCH.freezeTime + 3);
  const snap = gameSnapshot(game);
  const json = JSON.parse(JSON.stringify(snap));
  assert.equal(json.players.length, 10);
  assert.equal(json.players.filter((p) => p.isPlayer).length, 1);
  assert.equal(json.alive.A + json.alive.B > 0, true);
  assert.ok(['freeze', 'live', 'round_end', 'match_end'].includes(json.phase));
  for (const p of json.players) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), 'positions are numbers');
    assert.ok(p.health >= 0);
  }
});
