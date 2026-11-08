#!/usr/bin/env node
// Balance matrix: plays many matches per (difficulty, player mode) cell and
// prints a compact table of outcome rates. Used to keep difficulty honest.
//
//   node tools/matrix.mjs [--matches N] [--seed-base N] [--json]

import { eyePoint } from '../src/core/actor.js';
import { PLAYER } from '../src/core/config.js';
import { createGame, updateGame } from '../src/core/game.js';
import { resetActorIds } from '../src/core/actor.js';
import { PHASE } from '../src/core/match.js';
import { MATCH } from '../src/core/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const MATCHES = flag('matches', 12);
// Seed base lets a run be repeated on a disjoint block of matches. A single
// block can be 10 points off across difficulties (absolute win rates are noisy
// even though the simulation is deterministic), so a claim about a difficulty
// tier should be checked on at least two bases before it is believed.
const SEED_BASE = flag('seed-base', 1000);
const WANT_JSON = args.includes('--json');

/** `idle` player stands still at spawn; `auto` aims and fires at the closest enemy. */
function playMatch(difficulty, seed, playerMode) {
  // Actor ids feed the per-actor RNG streams, so they must start from the same
  // baseline for every match — otherwise a cell's numbers depend on how many
  // matches ran before it and the table is not reproducible.
  resetActorIds();
  const game = createGame({ difficulty, seed });
  const roundTimes = [];
  let liveStart = 0;
  let last = null;
  let wall = 0;
  while (game.match.phase !== PHASE.MATCH_END && wall < 60 * 60 * 10) {
    if (playerMode === 'auto') {
      const p = game.player;
      const enemies = game.match.actors.filter((a) => a.team === 'B' && a.alive);
      if (p.alive && enemies.length) {
        let best = enemies[0];
        let bd = Infinity;
        for (const e of enemies) {
          const d = Math.hypot(e.x - p.x, e.z - p.z);
          if (d < bd) {
            bd = d;
            best = e;
          }
        }
        game.pc.yaw = Math.atan2(best.x - p.x, -(best.z - p.z));
        // Aim at the target's chest, not at the horizon. With pitch=0 this
        // harness only hits the legs of anyone standing on another platform,
        // and it stopped being a fair proxy once bots started aiming at the
        // body: it was measuring the harness's blind spot, not the game.
        const eyeY = eyePoint(p).y;
        const dx = best.x - p.x;
        const dz = best.z - p.z;
        // Chest height, not a literal: this harness is a stand-in for a player,
        // so it must aim where a player would. The previous 1.15 was within 3cm
        // of PLAYER.chestHeight and drifted silently when the body moved.
        const chestY = PLAYER.chestHeight + (PLAYER.crouchChestHeight - PLAYER.chestHeight) * best.crouch;
        game.pc.pitch = Math.atan2(chestY - eyeY, Math.hypot(dx, dz));
        game.input.fire = bd < 45;
      } else {
        game.input.fire = false;
      }
    }
    updateGame(game, 1 / 60);
    wall += 1 / 60;
    if (game.match.phase !== last) {
      if (game.match.phase === PHASE.LIVE) liveStart = wall;
      if (game.match.phase === PHASE.ROUND_END) roundTimes.push(wall - liveStart);
      last = game.match.phase;
    }
  }
  const finished = game.match.phase === PHASE.MATCH_END;
  return {
    finished,
    winner: game.match.matchWinner,
    score: game.match.score,
    rounds: game.match.round,
    roundTimes,
    playerKills: game.player.kills,
    playerDeaths: game.player.deaths,
  };
}

const rows = [];
console.log(`\nSIFIR NOKTA — denge matrisi (${MATCHES} maç / hücre, toplam ${MATCHES * 6} maç)\n`);
console.log('zorluk   oyuncu   bitti  A kazanma  ort raund  ort raund süresi  tıkanma  K/D');

for (const difficulty of ['easy', 'normal', 'hard']) {
  for (const mode of ['idle', 'auto']) {
    let winsA = 0;
    let finished = 0;
    let rounds = 0;
    let stalled = 0;
    let kills = 0;
    let deaths = 0;
    let timeSum = 0;
    let timeCount = 0;
    for (let i = 0; i < MATCHES; i++) {
      const r = playMatch(difficulty, SEED_BASE + i * 37, mode);
      if (r.finished) finished++;
      if (r.winner === 'A') winsA++;
      rounds += r.rounds;
      for (const t of r.roundTimes) {
        timeSum += t;
        timeCount++;
        if (t >= MATCH.roundTimeLimit - 0.5) stalled++;
      }
      kills += r.playerKills;
      deaths += r.playerDeaths;
    }
    const row = {
      difficulty,
      mode,
      finished,
      total: MATCHES,
      aWinRate: winsA / MATCHES,
      avgRounds: rounds / MATCHES,
      avgRoundTime: timeCount ? timeSum / timeCount : 0,
      stallRate: timeCount ? stalled / timeCount : 0,
      kd: deaths === 0 ? kills : kills / deaths,
    };
    rows.push(row);
    console.log(
      `${row.difficulty.padEnd(8)} ${row.mode.padEnd(8)} ${String(row.finished).padStart(2)}/${row.total}   ` +
        `${(row.aWinRate * 100).toFixed(0).padStart(3)}%      ` +
        `${row.avgRounds.toFixed(1).padStart(4)}      ` +
        `${row.avgRoundTime.toFixed(1).padStart(5)} s         ` +
        `${(row.stallRate * 100).toFixed(0).padStart(3)}%     ` +
        `${row.kd.toFixed(2)}`,
    );
  }
}

console.log(`\nNot: "A kazanma" oyuncunun takımının kazanma oranı. "idle" = hareketsiz oyuncu,`);
console.log('"auto" = en yakın düşmana nişan alıp ateş eden basit otomatik oyuncu.');
console.log('Tıkanma = süre limitiyle karara bağlanan raund oranı (hedef: <%25).\n');

if (WANT_JSON) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/qa-matrix.json', JSON.stringify(rows, null, 2), 'utf8');
  console.log('  → docs/qa-matrix.json');
}

// A finished match is a hard requirement, a healthy stall rate a soft one.
const unfinished = rows.filter((r) => r.finished < r.total);
if (unfinished.length) {
  console.error(`HATA: bitmeyen maçlar var: ${unfinished.map((r) => `${r.difficulty}/${r.mode}`).join(', ')}`);
  process.exit(1);
}
