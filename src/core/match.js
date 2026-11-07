// Match / round state machine. One authority for score, round phase and clock.
// The renderer and the AI only read from this; nothing else mutates the score.

import { MATCH, PLAYER, DIFFICULTY } from './config.js';
import { createActor, resetActorForRound, markDead, NAMES_A, NAMES_B } from './actor.js';
import { SPAWNS } from './map.js';

export const PHASE = {
  FREEZE: 'freeze', // countdown before the round: no fire, no movement
  LIVE: 'live',
  ROUND_END: 'round_end',
  MATCH_END: 'match_end',
};

export function createMatch({ difficulty = 'normal' } = {}) {
  const profile = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const actors = [];
  for (let i = 0; i < MATCH.teamSize; i++) {
    actors.push(
      createActor({
        team: 'A',
        name: NAMES_A[i],
        isPlayer: i === 0,
        index: i,
      }),
    );
  }
  for (let i = 0; i < MATCH.teamSize; i++) {
    actors.push(
      createActor({
        team: 'B',
        name: NAMES_B[i],
        isPlayer: false,
        index: i,
      }),
    );
  }

  const match = {
    difficulty: profile.id,
    profile,
    actors,
    phase: PHASE.FREEZE,
    phaseTime: MATCH.freezeTime,
    round: 1,
    score: { A: 0, B: 0 },
    roundWinner: null,
    matchWinner: null,
    roundKills: [],
    time: 0,
    events: [],
    lastRoundResult: null,
    matchEndTimer: 0,
    roundEndTimer: 0,
    roundSettled: false,
  };
  return match;
}

export function actorsOfTeam(match, team) {
  return match.actors.filter((a) => a.team === team);
}

export function aliveCount(match, team) {
  let n = 0;
  for (const a of match.actors) if (a.team === team && a.alive) n++;
  return n;
}

export function playerActor(match) {
  return match.actors.find((a) => a.isPlayer);
}

function emit(match, type, payload = {}) {
  match.events.push({ type, t: match.time, ...payload });
}

/** Start (or restart) the whole match. */
export function startMatch(match, { difficulty } = {}) {
  if (difficulty) {
    match.difficulty = difficulty;
    match.profile = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  }
  match.score.A = 0;
  match.score.B = 0;
  match.round = 1;
  match.phases = undefined;
  match.roundWinner = null;
  match.matchWinner = null;
  match.roundKills = [];
  match.lastRoundResult = null;
  match.matchEndTimer = 0;
  match.roundSettled = false;
  for (const a of match.actors) {
    a.kills = 0;
    a.deaths = 0;
    if (a.brain) a.brain.reset();
  }
  beginRound(match);
}

export function beginRound(match) {
  match.phase = PHASE.FREEZE;
  match.phaseTime = MATCH.freezeTime;
  match.roundWinner = null;
  match.roundSettled = false;
  match.roundEndTimer = 0;
  match.roundKills = [];
  match.roundElapsed = 0;
  const spawnsA = SPAWNS.A;
  const spawnsB = SPAWNS.B;
  for (const a of match.actors) {
    const spawn = a.team === 'A' ? spawnsA[a.index % spawnsA.length] : spawnsB[a.index % spawnsB.length];
    resetActorForRound(a, spawn);
  }
  emit(match, 'round_start', { round: match.round, score: { ...match.score } });
}

/**
 * Tick the match clock.
 * @param {number} dt seconds (already zero while paused or after match end)
 * @returns {{phaseChanged:boolean}}
 */
export function updateMatch(match, dt) {
  let phaseChanged = false;
  if (match.phase === PHASE.MATCH_END) {
    return { phaseChanged };
  }
  match.time += dt;
  match.phaseTime = Math.max(0, match.phaseTime - dt);

  if (match.phase === PHASE.FREEZE) {
    if (match.phaseTime <= 0) {
      match.phase = PHASE.LIVE;
      match.phaseTime = 0;
      phaseChanged = true;
      emit(match, 'round_live', { round: match.round });
    }
    return { phaseChanged };
  }

  if (match.phase === PHASE.LIVE) {
    // Round ends only when a whole team is eliminated (no respawns).
    match.roundElapsed += dt;
    const aliveA = aliveCount(match, 'A');
    const aliveB = aliveCount(match, 'B');
    if (aliveA === 0 || aliveB === 0) {
      endRound(match, aliveA === 0 && aliveB === 0 ? 'draw' : aliveA === 0 ? 'B' : 'A');
      phaseChanged = true;
      return { phaseChanged };
    }
    if (match.roundElapsed >= MATCH.roundTimeLimit) {
      endRound(match, decideBySurvivors(match, aliveA, aliveB));
      phaseChanged = true;
    }
    return { phaseChanged };
  }

  if (match.phase === PHASE.ROUND_END) {
    match.roundEndTimer -= dt;
    if (match.roundEndTimer <= 0) {
      if (match.score.A >= MATCH.roundsToWin || match.score.B >= MATCH.roundsToWin) {
        finishMatch(match);
      } else if (match.round >= MATCH.maxRounds) {
        finishMatch(match);
      } else {
        match.round += 1;
        beginRound(match);
      }
      phaseChanged = true;
    }
    return { phaseChanged };
  }

  return { phaseChanged };
}

/** Stall breaker: more survivors wins; tie broken by total remaining health. */
function decideBySurvivors(match, aliveA, aliveB) {
  if (aliveA !== aliveB) return aliveA > aliveB ? 'A' : 'B';
  const hpA = match.actors.filter((a) => a.team === 'A' && a.alive).reduce((s, a) => s + a.health + a.armor, 0);
  const hpB = match.actors.filter((a) => a.team === 'B' && a.alive).reduce((s, a) => s + a.health + a.armor, 0);
  if (Math.abs(hpA - hpB) < 1e-3) return 'draw';
  return hpA > hpB ? 'A' : 'B';
}

export function endRound(match, winner) {
  if (match.roundSettled) return false;
  match.roundSettled = true;
  match.roundWinner = winner === 'draw' ? null : winner;
  if (winner === 'A' || winner === 'B') {
    match.score[winner] += 1;
  }
  match.phase = PHASE.ROUND_END;
  match.phaseTime = 0;
  match.roundEndTimer = MATCH.roundEndTime;
  match.lastRoundResult = {
    round: match.round,
    winner,
    score: { ...match.score },
    aliveA: aliveCount(match, 'A'),
    aliveB: aliveCount(match, 'B'),
    kills: match.roundKills.slice(),
  };
  emit(match, 'round_end', { winner, score: { ...match.score }, round: match.round });
  return true;
}

export function finishMatch(match) {
  if (match.phase === PHASE.MATCH_END) return false;
  match.phase = PHASE.MATCH_END;
  match.phaseTime = 0;
  match.matchEndTimer = 0;
  match.matchWinner =
    match.score.A === match.score.B ? 'draw' : match.score.A > match.score.B ? 'A' : 'B';
  emit(match, 'match_end', { winner: match.matchWinner, score: { ...match.score } });
  return true;
}

/**
 * Central death handler — idempotent, so a second bullet in the same frame
 * cannot double-count.
 */
export function killActor(match, actor) {
  if (!markDead(actor)) return false;
  emit(match, 'death', { actorId: actor.id, name: actor.name, team: actor.team });
  return true;
}

/**
 * Deal damage through the match so kills are recorded centrally.
 * `result` comes from combat.applyHit.
 */
export function registerDamage(match, attacker, victim, result) {
  if (!result) return { died: false };
  emit(match, 'damage', {
    attackerId: attacker.id,
    victimId: victim.id,
    amount: result.healthLost,
    headshot: result.headshot,
  });
  if (result.killed) {
    if (!killActor(match, victim)) return { died: false };
    attacker.kills += 1;
    match.roundKills.push({ by: attacker.name, victim: victim.name, headshot: result.headshot, team: attacker.team });
    return { died: true };
  }
  return { died: false };
}

/** Public snapshot for HUD / renderer. */
export function matchSnapshot(match) {
  return {
    phase: match.phase,
    phaseTime: match.phaseTime,
    round: match.round,
    score: { ...match.score },
    alive: { A: aliveCount(match, 'A'), B: aliveCount(match, 'B') },
    roundWinner: match.roundWinner,
    roundElapsed: match.roundElapsed || 0,
    roundTimeLimit: MATCH.roundTimeLimit,
    matchWinner: match.matchWinner,
    difficulty: match.difficulty,
    lastRoundResult: match.lastRoundResult,
    roundsToWin: MATCH.roundsToWin,
    maxRounds: MATCH.maxRounds,
    teamNames: MATCH.teamNames,
    teamSize: MATCH.teamSize,
  };
}

export function drainEvents(match) {
  const e = match.events;
  match.events = [];
  return e;
}

export function healthSummary(actor) {
  return {
    health: Math.round(actor.health),
    armor: Math.round(actor.armor),
    maxHealth: PLAYER.maxHealth,
    maxArmor: PLAYER.maxArmor,
    alive: actor.alive,
  };
}
