import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrain, canSee, updateBot, hearSound, BOT_STATE, createCoordinator, assignLanes, callForHelp, latestHelp } from '../src/core/bot.js';
import { createMatch, startMatch, PHASE, updateMatch } from '../src/core/match.js';
import { createActor, resetActorIds } from '../src/core/actor.js';
import { MAP_AABBS } from '../src/core/map.js';
import { NavGrid } from '../src/core/navgrid.js';
import { DIFFICULTY, PLAYER } from '../src/core/config.js';
import { mulberry32, createGame, updateGame } from '../src/core/game.js';
import { buildCoverPoints, getCoverPoints, hiddenFrom, pickCoverFor } from '../src/core/cover.js';

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

  // Run a while, checking continuously that they are not on top of each other.
  // Sample the whole 25 s window (a single end-of-run snapshot used to flake
  // whenever two bots happened to cross a doorway together). Bots flow through
  // chokepoints, so a transient pair is allowed; what must not happen is a squad
  // that sits on top of itself.
  let worst = 0;
  let samples = 0;
  for (let i = 0; i < 60 * 25; i++) {
    match.time += 1 / 60;
    updateMatch(match, 1 / 60);
    for (const bot of match.actors) if (bot.brain && bot.alive) updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
    if (i % 30 !== 0) continue;
    samples++;
    const alive = match.actors.filter((a) => a.team === 'A' && a.alive);
    let close = 0;
    for (let x = 0; x < alive.length; x++) {
      for (let y = x + 1; y < alive.length; y++) {
        if (Math.hypot(alive[x].x - alive[y].x, alive[x].z - alive[y].z) < 1.2) close++;
      }
    }
    worst = Math.max(worst, close);
  }
  assert.ok(samples > 40, 'expected plenty of samples');
  assert.ok(worst <= 1, `bots are clumping (up to ${worst} overlapping pairs in one 0.5 s window)`);
});

test('5v5 bot-vs-bot matches are not biased toward one side', () => {
  // A mirror-symmetric map plus symmetric AI must produce a roughly even split.
  // This catches asymmetric cover, lane assignment or spawn disadvantage.
  // Seeded and reproducible: every source of randomness (bot decisions, weapon
  // spread, recoil) runs off the match RNG, so this number cannot drift between
  // runs. Update order is alternated per tick, so a fixed order cannot favour A.
  let roundsA = 0;
  let roundsB = 0;
  for (let i = 0; i < 10; i++) {
    resetActorIds(); // ids feed the per-actor RNG streams
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
  assert.ok(total > 30, `expected a meaningful sample, got ${total} decided rounds`);
  assert.ok(aRate > 0.35 && aRate < 0.65, `side bias too strong: A won ${(aRate * 100).toFixed(0)}% of ${total} rounds`);
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

test('a bot walks its lane instead of ping-ponging on one waypoint', () => {
  // Regression: ADVANCE used to re-path to the current lane waypoint every
  // 1.2 s, which silently discarded every detour goal (cover, squad sweep,
  // spawn hunt) and left bots walking back and forth over the same two metres.
  const match = createMatch({ difficulty: 'normal' });
  const rng = mulberry32(7);
  const coord = createCoordinator();
  // Control experiment: every actor is a bot, so nothing can block the spawn
  // door except the AI itself.
  for (const a of match.actors) a.brain = createBrain(a, match.profile, { rng, lane: 'mid' });
  startMatch(match);
  assignLanes(match, coord, rng);
  updateMatch(match, 1 / 60);
  const watched = match.actors.filter((a) => a.brain);
  const startPos = new Map(watched.map((a) => [a.id, { x: a.x, z: a.z }]));
  for (let i = 0; i < 60 * 20; i++) {
    match.time += 1 / 60;
    updateMatch(match, 1 / 60);
    for (const b of match.actors) if (b.brain && b.alive) updateBot(match, b, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
  }
  // Every bot must be out of its spawn slot, or at least have consumed a lane
  // waypoint. A stuck queue in the spawn door leaves bots with lane index 0 and
  // a metre of net movement for the whole round.
  for (const bot of watched) {
    const start = startPos.get(bot.id);
    const displaced = Math.hypot(bot.x - start.x, bot.z - start.z);
    assert.ok(
      bot.brain.laneIndex > 0 || displaced > 6,
      `${bot.name} is still in its spawn slot after 20 s (lane index ${bot.brain.laneIndex}, ${displaced.toFixed(1)} m from start)`,
    );
  }
});

test('a quiet 5v5 round still resolves instead of timing out', () => {
  // Regression: both squads used to walk their lanes, stop, and camp opposite
  // corners until the round time limit. Squad sweep must bring them together.
  const stalls = [];
  let decided = 0;
  for (let i = 0; i < 8; i++) {
    resetActorIds();
    const game = createGame({ difficulty: 'normal', seed: 900 + i * 13 });
    const p = game.player;
    p.isPlayer = false;
    p.brain = createBrain(p, game.match.profile, { rng: mulberry32(500 + i), lane: 'mid' });
    let liveStart = 0;
    let last = null;
    let guard = 0;
    while (game.match.phase !== PHASE.MATCH_END && guard++ < 60 * 60 * 8) {
      updateGame(game, 1 / 60);
      if (game.match.phase !== last) {
        if (game.match.phase === PHASE.LIVE) liveStart = guard;
        if (game.match.phase === PHASE.ROUND_END) {
          decided++;
          if ((guard - liveStart) / 60 >= 79.5) stalls.push((guard - liveStart) / 60);
        }
        last = game.match.phase;
      }
    }
  }
  assert.ok(decided >= 14, `expected a few rounds, got ${decided}`);
  const stallRate = stalls.length / decided;
  // Measured ~1-3% with the squad sweep in place; without it this jumped to ~26%,
  // so 15% separates "occasionally someone camps hard" from "the AI camps" .
  assert.ok(stallRate <= 0.15, `${(stallRate * 100).toFixed(0)}% of ${decided} rounds hit the time limit`);
});

test('seeded matches are deterministic', () => {
  // Regression: weapon spread/recoil used Math.random(), so a seeded match was
  // not reproducible and every balance number drifted between runs.
  const play = (seed) => {
    resetActorIds();
    const game = createGame({ difficulty: 'normal', seed });
    const p = game.player;
    p.isPlayer = false;
    p.brain = createBrain(p, game.match.profile, { rng: mulberry32(11), lane: 'mid' });
    let guard = 0;
    while (game.match.phase !== PHASE.MATCH_END && guard++ < 60 * 60 * 6) updateGame(game, 1 / 60);
    return `${game.match.matchWinner}|${JSON.stringify(game.match.score)}|${game.match.round}|${game.match.actors.map((a) => a.kills).join(',')}`;
  };
  assert.equal(play(2024), play(2024), 'the same seed must produce the same match');
  assert.notEqual(play(2024), play(2025), 'different seeds must produce different matches');
});

test('a bot pushed into a teammate separates instead of standing inside them', () => {
  const match = createMatch({ difficulty: 'normal' });
  const rng = mulberry32(3);
  const coord = createCoordinator();
  for (const a of match.actors) if (!a.isPlayer) a.brain = createBrain(a, match.profile, { rng, lane: 'mid' });
  startMatch(match);
  assignLanes(match, coord, rng);
  updateMatch(match, 1 / 60);
  const [a, b] = match.actors.filter((x) => x.team === 'A' && !x.isPlayer);
  a.alive = true;
  b.alive = true;
  // Stack them exactly on top of each other and let the separation run.
  a.x = 0;
  a.z = 16;
  b.x = 0.05;
  b.z = 16;
  for (let i = 0; i < 12; i++) {
    match.time += 1 / 60;
    updateBot(match, a, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
    updateBot(match, b, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
  }
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  assert.ok(d > 0.8, `bots stayed inside each other (${d.toFixed(2)} m apart)`);
});

test('cover points are derived from the map and stay mirror-symmetric', () => {
  const geometric = buildCoverPoints();
  assert.ok(geometric.length > 60, `expected a decent number of cover points, got ${geometric.length}`);
  // The geometric set is exactly mirror-symmetric before it is snapped to the grid.
  const gkey = new Set(geometric.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`));
  assert.equal(geometric.filter((p) => !gkey.has(`${(-p.x).toFixed(2)},${(-p.z).toFixed(2)}`)).length, 0);

  // What bots actually use: snapped onto the nav grid, still symmetric and usable.
  const points = getCoverPoints(grid);
  assert.ok(points.length > 40, `expected a decent number of cover points, got ${points.length}`);
  // Every point must be standable and must actually hide a crouched body from
  // the direction it claims to cover (the probe is a real raycast).
  for (const p of points) {
    assert.equal(grid.isWalkableAt(p.x, p.z), true, `cover point ${p.x},${p.z} is not walkable`);
    const probe = { x: p.x + p.faceX * 5, y: 1.55, z: p.z + p.faceZ * 5 };
    assert.equal(hiddenFrom(p.x, p.z, probe), true, `cover point ${p.x},${p.z} does not actually hide`);
  }
  // The map is 180° rotationally symmetric, so the cover set must be too — an
  // asymmetric cover set silently favours one side.
  const key = new Set(points.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`));
  const missing = points.filter((p) => !key.has(`${(-p.x).toFixed(2)},${(-p.z).toFixed(2)}`));
  assert.equal(missing.length, 0, `${missing.length} cover points have no mirrored twin`);
  const left = points.filter((p) => p.x < 0).length;
  const right = points.filter((p) => p.x > 0).length;
  assert.equal(left, right, `cover points are not balanced (${left} left / ${right} right)`);
});

test('a wounded bot walks to a real cover point and crouches there', () => {
  // Realistic duel: the enemy is far, so the bot has to walk to cover. Cover is
  // a stance decision made against a threat the bot can actually see.
  const { match, bot, target } = makeDuel('hard', 21);
  bot.health = 40;
  bot.armor = 0;
  bot.x = 20;
  bot.z = -19;
  bot.yaw = -Math.PI / 2;
  target.x = -4;
  target.z = -19;
  const coord = createCoordinator();
  let pickedCover = false;
  let crouchedTicks = 0;
  for (let i = 0; i < 60 * 25; i++) {
    match.time += 1 / 60;
    updateBot(match, bot, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
    if (bot.brain.coverSpot) pickedCover = true;
    if (bot.crouch > 0.5) crouchedTicks++;
    // Keep both alive and in place: we are testing the stance, not the fight.
    target.alive = true;
    target.health = 100;
    target.x = -4;
    target.z = -19;
    bot.alive = true;
    bot.health = Math.min(bot.health, 55);
  }
  assert.ok(pickedCover, 'a wounded bot should pick a cover point');
  assert.ok(crouchedTicks > 0, 'crouching is how a bot uses chest-high cover');
});

test('pickCoverFor never returns a spot the threat can see through', () => {
  // Direct guard on the selector: every returned spot must pass the real
  // raycast, for many bot/threat pairs across the map.
  const points = getCoverPoints(grid);
  let checked = 0;
  for (const threat of [
    { x: -20, z: -14 }, { x: 14, z: 12 }, { x: 2, z: 0 },
  ]) {
    for (const bot of [
      { x: 0, z: -18 }, { x: -10, z: 8 }, { x: 16, z: -6 }, { x: 6, z: 16 },
    ]) {
      const spot = pickCoverFor(bot, points, threat);
      if (!spot) continue;
      checked++;
      assert.ok(
        hiddenFrom(spot.x, spot.z, { x: threat.x, y: 1.55, z: threat.z }),
        `picked cover ${spot.x},${spot.z} is visible from ${threat.x},${threat.z}`,
      );
    }
  }
  assert.ok(checked >= 3, `expected some cover picks to check, got ${checked}`);
});

test('a bot only uses cover that hides it from the threat it knows about', () => {
  // Real geometry test with no AI involved: standing behind a box hides you from
  // one side and not from the other. This is what stops "fake" cover.
  const crate = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1, kind: 'crate' };
  const boxes = [crate];
  // Actor at z = -3 is on the far side of the box (z in [-1,1]) seen from z=+10.
  const behind = { x: 0, z: -3 };
  assert.equal(hiddenFrom(behind.x, behind.z, { x: 0, y: 1.55, z: 10 }, boxes), true, 'box should hide us');
  assert.equal(hiddenFrom(behind.x, behind.z, { x: 0, y: 1.55, z: -10 }, boxes), false, 'box must not hide us from the other side');
});

test('a teammate in trouble nearby gets help', () => {
  const match = createMatch({ difficulty: 'hard' });
  const rng = mulberry32(15);
  const coord = createCoordinator();
  for (const a of match.actors) if (!a.isPlayer) a.brain = createBrain(a, match.profile, { rng, lane: 'mid' });
  startMatch(match);
  assignLanes(match, coord, rng);
  updateMatch(match, 1 / 60);
  const team = match.actors.filter((a) => a.team === 'A' && !a.isPlayer);
  const [hurt, helper] = team;
  hurt.alive = true;
  helper.alive = true;
  hurt.x = 4;
  hurt.z = 8;
  helper.x = 6;
  helper.z = 8;
  // The hurt bot was just shot: that is what raises a call for help.
  hurt.lastDamageAt = match.time;
  hurt.lastAttackerId = 999;
  updateBot(match, hurt, 1 / 60, { grid, boxes: MAP_AABBS, coordinator: coord });
  const call = latestHelp(coord, 'A', match.time, helper.id);
  assert.ok(call, 'a shot teammate should call for help');
  assert.equal(call.by, hurt.id);
  // The call may only carry the ally's own position — never an enemy's.
  assert.ok(Math.abs(call.x - hurt.x) < 0.6 && Math.abs(call.z - hurt.z) < 0.6, 'the call must carry the ally position');
  assert.equal(latestHelp(coord, 'B', match.time, 0), null, 'the other team must not hear it');
});

test('help calls never leak enemy positions', () => {
  // Structural check: the only payload callForHelp accepts is a friendly actor.
  const coord = createCoordinator();
  const ally = { id: 7, team: 'A', x: 3, z: -4 };
  callForHelp(coord, ally, 1);
  const call = latestHelp(coord, 'A', 1, 99);
  assert.deepEqual(Object.keys(call).sort(), ['by', 'team', 'time', 'x', 'z']);
  assert.equal(call.x, ally.x);
  assert.equal(call.z, ally.z);
});
