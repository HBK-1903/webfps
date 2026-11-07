// Headless match simulator: runs full matches with no renderer, to validate
// round flow, bot behaviour and balance from the command line.
//   node tools/sim.mjs [difficulty] [seed] [matches]
import { createGame, updateGame, hudState } from '../src/core/game.js';
import { PHASE } from '../src/core/match.js';

const difficulty = process.argv[2] || 'normal';
const seed = Number(process.argv[3] || 7);
const count = Number(process.argv[4] || 1);

for (let i = 0; i < count; i++) {
  const game = createGame({ difficulty, seed: seed + i });
  let t = 0;
  let rounds = 0;
  let lastPhase = null;
  const roundTimes = [];
  let roundStart = 0;
  const botStats = new Map();
  while (game.match.phase !== PHASE.MATCH_END && t < 600) {
    updateGame(game, 1 / 60);
    t += 1 / 60;
    if (game.match.phase !== lastPhase) {
      if (game.match.phase === PHASE.LIVE) roundStart = t;
      if (game.match.phase === PHASE.ROUND_END) {
        rounds++;
        roundTimes.push(+(t - roundStart).toFixed(2));
      }
      lastPhase = game.match.phase;
    }
  }
  for (const a of game.match.actors) {
    if (a.isPlayer) continue;
    const key = `${a.team}:${a.name}`;
    botStats.set(key, { kills: a.kills, deaths: a.deaths, shots: a.brain.shots, hits: a.brain.hits });
  }
  const snap = hudState(game);
  console.log(
    `${difficulty.padEnd(6)} seed=${seed + i} winner=${game.match.matchWinner} score=${game.match.score.A}-${game.match.score.B} ` +
      `rounds=${rounds} simTime=${t.toFixed(1)}s roundTimes=${JSON.stringify(roundTimes)}`,
  );
  console.log(`        player alive=${snap.playerAlive} hp=${snap.health} armor=${snap.armor} score=${snap.scores.A}:${snap.scores.B}`);
  const acc = [];
  for (const [k, v] of botStats) acc.push(`${k} ${v.hits}/${v.shots}`);
  console.log('        bot accuracy: ' + acc.join('  '));
  if (game.match.phase !== PHASE.MATCH_END) {
    console.log('        !! match did not finish, phase=' + game.match.phase + ' round=' + game.match.round);
  }
}
