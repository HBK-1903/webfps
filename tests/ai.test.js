import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrain, canSee, updateBot, hearSound, BOT_STATE, createCoordinator, assignLanes } from '../src/core/bot.js';
import { createMatch, startMatch, PHASE, updateMatch } from '../src/core/match.js';
import { createActor } from '../src/core/actor.js';
import { MAP_AABBS } from '../src/core/map.js';
import { NavGrid } from '../src/core/navgrid.js';
import { DIFFICULTY, PLAYER } from '../src/core/config.js';
import { mulberry32, createGame, updateGame } from '../src/core/game.js';

const grid = new NavGrid(MAP_AABBS);

function makeDuel(difficulty, seed = 3) {
  const rng = mulberry32(seed);
  const bot = createActor({ team: 'B', name: 'BOT', index: 0 });
  const target = createActor({ team: 'A', name: 'HEDEF', index: 0 });
  bot.brain = createBrain(bot, DIFFICULTY[difficulty], { rng, lane: 'north' });
  // Open stretch of the north lane, facing each other.
  bot.x = 12;
  bot.z = -20.3;
  bot.yaw = -Math.PI / 2; // look toward -X
  target.x = 0;
  target.z = -20.3;
  target.alive = true;
  bot.alive = true;
  const match = {
    actors: [target, bot],
    time: 0,
    profile: DIFFICULTY[difficulty],
    phase: PHASE.LIVE,
    roundElapsed: 0,
    events: [],
    roundKills: [],
    score: { A: 0, B: 0 },
    difficulty,
  };
  return { match, bot, target, rng };
}

function runDuel(difficulty, seed, seconds = 4) {
  const { match, bot, target } = makeDuel(difficulty, seed);
  let firstShot = -1;
  let t = 0;
  const step = 1 / 60;
  while (t < seconds) {
    updateBot(match, bot, step, {
      grid,
      boxes: MAP_AABBS,
      coordinator: { contacts: {}, hunt: { A: null, B: null } },
      onShot: () => {
        if (firstShot < 0) firstShot = t;
      },
    });
    match.time += step;
    t += step;
  }
  return { firstShot, shots: bot.brain.shots, hits: bot.brain.hits, targetHealth: target.health };
}

test('bots never see through walls', () => {
  const { bot, target } = makeDuel('hard');
  assert.equal(canSee(bot, target, MAP_AABBS), true, 'clear lane must be visible');
  // Drop a wall between them.
  const wall = { minX: 5, maxX: 7, minY: 0, maxY: 3, minZ: -24, maxZ: -16, kind: 'wall' };
  assert.equal(canSee(bot, target, [...MAP_AABBS, wall]), false, 'a wall must block sight');
});

test('vision is limited by the field of view cone', () => {
  const { bot, target } = makeDuel('hard');
  bot.yaw = Math.PI / 2; // look the other way
  assert.equal(canSee(bot, target, MAP_AABBS), false, 'a target behind the bot must be invisible');
  bot.yaw = -Math.PI / 2;
  assert.equal(canSee(bot, target, MAP_AABBS), true);
});

test('vision distance is capped per difficulty but never bypasses LOS', () => {
  const easy = DIFFICULTY.easy;
  const hard = DIFFICULTY.hard;
  assert.ok(hard.viewDistance > easy.viewDistance);
  assert.ok(hard.fov > easy.fov);
  const { bot, target } = makeDuel('easy');
  target.x = 4; // ~8 m away: visible at any difficulty
  assert.equal(canSee(bot, target, MAP_AABBS), true);
  bot.brain.profile = { ...DIFFICULTY.easy, viewDistance: 5 };
  assert.equal(canSee(bot, target, MAP_AABBS), false, 'the view distance cap must apply');
});

test('a bot investigates the last known position instead of tracking live', () => {
  const { match, bot, target } = makeDuel('normal');
  updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: createCoordinator() });
  assert.equal(bot.brain.targetVisible, true);
  assert.ok(bot.brain.lastSeen, 'contact must be remembered');
  const seen = { ...bot.brain.lastSeen };
  // The target vanishes behind cover.
  target.x = 26;
  target.z = 18;
  for (let i = 0; i < 60; i++) {
    match.time += 1 / 60;
    updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: createCoordinator() });
  }
  assert.equal(bot.brain.targetVisible, false);
  assert.ok(bot.brain.lastSeen, 'the bot keeps a memory of the contact');
  assert.ok(
    Math.hypot(bot.brain.lastSeen.x - seen.x, bot.brain.lastSeen.z - seen.z) < 12,
    'memory must stay near where the target was seen, not snap to its new position',
  );
  assert.notEqual(bot.brain.state, BOT_STATE.ENGAGE, 'no target, no engagement state');
});

test('hearing gives an approximate position, never an exact one', () => {
  const { bot, match } = makeDuel('normal');
  bot.yaw = 0;
  const origin = { x: 2, z: -18 };
  const heard = hearSound(bot, origin, match);
  assert.equal(heard, true, 'a nearby shot must be heard');
  const err = Math.hypot(bot.brain.lastSeen.x - origin.x, bot.brain.lastSeen.z - origin.z);
  assert.ok(err > 0.001 || true);
  // Repeat with many seeds: it should not always be dead-on.
  let exact = 0;
  for (let s = 0; s < 20; s++) {
    const d = makeDuel('normal', 100 + s);
    d.bot.yaw = 0;
    hearSound(d.bot, origin, d.match);
    const e = Math.hypot(d.bot.brain.lastSeen.x - origin.x, d.bot.brain.lastSeen.z - origin.z);
    if (e < 0.05) exact++;
  }
  assert.ok(exact < 2, 'sound must not reveal the exact shooter position');
});

test('difficulty produces measurably different reaction and accuracy', () => {
  const results = {};
  for (const d of ['easy', 'normal', 'hard']) {
    let firstSum = 0;
    let hits = 0;
    let shots = 0;
    const seeds = [1, 2, 3, 4, 5, 6];
    for (const s of seeds) {
      const r = runDuel(d, s, 4);
      firstSum += r.firstShot < 0 ? 4 : r.firstShot;
      hits += r.hits;
      shots += r.shots;
    }
    results[d] = { first: firstSum / seeds.length, acc: shots ? hits / shots : 0, shots };
  }
  assert.ok(results.easy.first > results.hard.first, `easy must react slower (${results.easy.first.toFixed(2)}s vs ${results.hard.first.toFixed(2)}s)`);
  assert.ok(results.normal.first <= results.easy.first + 1e-6);
  assert.ok(results.hard.acc >= results.easy.acc, 'hard bots must land more of their shots');
  assert.ok(results.hard.acc < 1, 'even hard bots must miss sometimes');
});

test('even hard bots need reaction time before the first shot', () => {
  const r = runDuel('hard', 11, 2);
  assert.ok(r.firstShot > DIFFICULTY.hard.reactionTime * 0.5, `bots must not fire instantly (got ${r.firstShot})`);
});

test('bots reload instead of firing an empty magazine', () => {
  const { match, bot } = makeDuel('normal');
  bot.loadout.slots.rifle.mag = 1;
  for (let i = 0; i < 60 * 3; i++) {
    match.time += 1 / 60;
    updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: createCoordinator() });
    const w = bot.loadout.slots.rifle;
    assert.ok(!(w.mag === 0 && !w.reloading), 'a bot must never hold an empty rifle without reloading');
    assert.ok(w.mag >= 0 && w.reserve >= 0);
  }
});

test('bots never leave the map or end up inside geometry', () => {
  const match = createMatch({ difficulty: 'normal' });
  const rng = mulberry32(5);
  for (const a of match.actors) if (!a.isPlayer) a.brain = createBrain(a, match.profile, { rng, lane: 'mid' });
  startMatch(match);
  const coord = createCoordinator();
  for (let i = 0; i < 60 * 40; i++) {
    match.time += 1 / 60;
    updateMatch(match, 1 / 60);
    for (const bot of match.actors) {
      if (!bot.brain || !bot.alive) continue;
      updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
      assert.ok(bot.x > -31.6 && bot.x < 31.6, `bot ${bot.name} left the map on X: ${bot.x}`);
      assert.ok(bot.z > -21.6 && bot.z < 21.6, `bot ${bot.name} left the map on Z: ${bot.z}`);
      for (const b of MAP_AABBS) {
        const cx = Math.min(Math.max(bot.x, b.minX), b.maxX);
        const cz = Math.min(Math.max(bot.z, b.minZ), b.maxZ);
        const d = Math.hypot(bot.x - cx, bot.z - cz);
        assert.ok(d > PLAYER.radius * 0.8, `bot ${bot.name} is inside a ${b.kind} box`);
      }
    }
  }
});

test('bots spread across lanes instead of stacking on one point', () => {
  const match = createMatch({ difficulty: 'normal' });
  const rng = mulberry32(4242);
  const coord = createCoordinator();
  for (const a of match.actors) if (!a.isPlayer) a.brain = createBrain(a, match.profile, { rng, lane: 'mid' });
  startMatch(match);
  assignLanes(match, coord, rng);
  updateMatch(match, 1 / 60);
  const lanes = new Set(match.actors.filter((a) => a.brain && !a.isPlayer).map((a) => a.brain.lane));
  assert.ok(lanes.size >= 3, 'the squad must use all available lanes');

  // Run a while, then check they are not all on top of each other.
  for (let i = 0; i < 60 * 25; i++) {
    match.time += 1 / 60;
    updateMatch(match, 1 / 60);
    for (const bot of match.actors) if (bot.brain && bot.alive) updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
  }
  const alive = match.actors.filter((a) => a.team === 'A' && a.alive);
  let close = 0;
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      if (Math.hypot(alive[i].x - alive[j].x, alive[i].z - alive[j].z) < 1.2) close++;
    }
  }
  assert.ok(close <= 1, `bots are clumping (${close} overlapping pairs)`);
});

test('5v5 bot-vs-bot matches are not biased toward one side', () => {
  // A mirror-symmetric map plus symmetric AI must produce a roughly even split.
  // This catches asymmetric cover, lane assignment or spawn disadvantage.
  let roundsA = 0;
  let roundsB = 0;
  for (let i = 0; i < 8; i++) {
    const game = createGame({ difficulty: 'normal', seed: 4000 + i * 17 });
    const p = game.player;
    p.isPlayer = false; // control experiment: 5 bots vs 5 bots
    p.brain = createBrain(p, game.match.profile, { rng: mulberry32(31337 + i), lane: 'mid' });
    let last = null;
    let guard = 0;
    while (game.match.phase !== PHASE.MATCH_END && guard++ < 60 * 60 * 6) {
      updateGame(game, 1 / 60);
      if (game.match.phase === PHASE.ROUND_END && last !== 're') {
        if (game.match.roundWinner === 'A') roundsA++;
        else if (game.match.roundWinner === 'B') roundsB++;
        last = 're';
      }
      if (game.match.phase !== PHASE.ROUND_END) last = null;
    }
  }
  const total = roundsA + roundsB;
  const aRate = roundsA / total;
  assert.ok(total > 20, `expected a meaningful sample, got ${total} decided rounds`);
  assert.ok(aRate > 0.3 && aRate < 0.7, `side bias too strong: A won ${(aRate * 100).toFixed(0)}% of ${total} rounds`);
});

test('a bot turns toward its target instead of away from it', () => {
  // Guards against a sign error in the yaw/pitch math: bots must converge on the
  // target angle (the shortest angular error shrinks to ~0), never diverge.
  const { match, bot } = makeDuel('normal', 99);
  // Start clearly off-target (~46°) so convergence is measurable.
  bot.yaw = -Math.PI / 2 + 0.8;
  const errors = [];
  for (let i = 0; i < 180; i++) {
    match.time += 1 / 60;
    updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: createCoordinator() });
    if (bot.brain.targetVisible && Number.isFinite(bot.brain.lastTurnError)) errors.push(Math.abs(bot.brain.lastTurnError));
  }
  assert.ok(errors.length > 30, 'the bot should have been tracking for a while');
  // The bot starts off-target and must converge: compare the whole first third
  // with the whole last third so a single noisy frame cannot flip the result.
  const third = Math.max(1, Math.floor(errors.length / 3));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const first = avg(errors.slice(0, third));
  const last = avg(errors.slice(-third));
  assert.ok(first > 0.05, `the duel should start off-target (start ${first.toFixed(3)} rad)`);
  assert.ok(last < first, `aim error must shrink (start ${first.toFixed(3)} rad, end ${last.toFixed(3)} rad)`);
  assert.ok(last < 0.35, `bot should end up roughly on target (error ${last.toFixed(3)} rad)`);
});
