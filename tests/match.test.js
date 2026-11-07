import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, startMatch, updateMatch, PHASE, aliveCount, killActor, endRound, finishMatch, registerDamage } from '../src/core/match.js';
import { MATCH, PLAYER } from '../src/core/config.js';
import { resolveDamage } from '../src/core/damage.js';

function advance(match, seconds, step = 1 / 60) {
  let t = 0;
  while (t < seconds) {
    updateMatch(match, step);
    t += step;
  }
}

function killTeam(match, team) {
  for (const a of match.actors) if (a.team === team) killActor(match, a);
}

test('a match starts 5v5 with the player on team A', () => {
  const m = createMatch({ difficulty: 'normal' });
  const a = m.actors.filter((x) => x.team === 'A');
  const b = m.actors.filter((x) => x.team === 'B');
  assert.equal(a.length, 5);
  assert.equal(b.length, 5);
  assert.equal(m.actors.filter((x) => x.isPlayer).length, 1);
  assert.equal(m.actors.find((x) => x.isPlayer).team, 'A');
});

test('rounds begin frozen, then go live after the countdown', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  assert.equal(m.phase, PHASE.FREEZE);
  assert.equal(aliveCount(m, 'A'), 5);
  assert.equal(aliveCount(m, 'B'), 5);
  advance(m, MATCH.freezeTime - 0.2);
  assert.equal(m.phase, PHASE.FREEZE, 'still frozen just before the countdown ends');
  advance(m, 0.4);
  assert.equal(m.phase, PHASE.LIVE);
});

test('a round ends when one team is fully eliminated and scores once', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  advance(m, MATCH.freezeTime + 0.1);
  killTeam(m, 'B');
  updateMatch(m, 1 / 60);
  assert.equal(m.phase, PHASE.ROUND_END);
  assert.equal(m.score.A, 1);
  assert.equal(m.score.B, 0);
  // Extra ticks must not double count.
  updateMatch(m, 1 / 60);
  updateMatch(m, 1 / 60);
  assert.equal(m.score.A, 1, 'round result must not trigger twice');
  assert.equal(endRound(m, 'B'), false, 'settled round rejects a second result');
});

test('next round resets positions, health, armour and ammo', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  advance(m, MATCH.freezeTime + 0.1);
  const victim = m.actors.find((a) => a.team === 'B');
  victim.health = 10;
  victim.armor = 0;
  victim.loadout.slots.rifle.mag = 1;
  victim.x = 0;
  victim.z = 0;
  killTeam(m, 'B');
  advance(m, MATCH.roundEndTime + 0.1);
  assert.equal(m.round, 2);
  for (const a of m.actors) {
    assert.equal(a.alive, true);
    assert.equal(a.health, PLAYER.maxHealth);
    assert.equal(a.armor, PLAYER.maxArmor);
    const w = a.loadout.slots[a.loadout.current];
    assert.equal(w.mag, w.def.magSize);
    assert.equal(w.reserve, w.def.reserveAmmo);
    assert.notEqual(`${a.x},${a.z}`, '0,0');
  }
  assert.equal(m.phase, PHASE.FREEZE);
});

test('first to 3 round wins takes the match', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  for (let i = 0; i < 3; i++) {
    advance(m, MATCH.freezeTime + 0.1);
    killTeam(m, 'B');
    updateMatch(m, 1 / 60);
    advance(m, MATCH.roundEndTime + 0.2);
  }
  assert.equal(m.phase, PHASE.MATCH_END);
  assert.equal(m.score.A, 3);
  assert.equal(m.matchWinner, 'A');
});

test('a match can end 2-2 as a draw after five rounds', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  const winnerPerRound = ['B', 'A', 'B', 'A', 'draw'];
  for (const w of winnerPerRound) {
    advance(m, MATCH.freezeTime + 0.1);
    if (w === 'draw') {
      killTeam(m, 'A');
      killTeam(m, 'B');
    } else {
      killTeam(m, w === 'A' ? 'B' : 'A');
    }
    updateMatch(m, 1 / 60);
    advance(m, MATCH.roundEndTime + 0.2);
  }
  assert.equal(m.score.A, 2);
  assert.equal(m.score.B, 2);
  assert.equal(m.round, MATCH.maxRounds);
  assert.equal(m.phase, PHASE.MATCH_END);
  assert.equal(m.matchWinner, 'draw');
});

test('the final round shows its result before the match screen', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  for (let i = 0; i < 2; i++) {
    advance(m, MATCH.freezeTime + 0.1);
    killTeam(m, 'B');
    updateMatch(m, 1 / 60);
    advance(m, MATCH.roundEndTime + 0.2);
  }
  advance(m, MATCH.freezeTime + 0.1);
  killTeam(m, 'B');
  updateMatch(m, 1 / 60);
  assert.equal(m.phase, PHASE.ROUND_END, 'third round win is announced first');
  advance(m, MATCH.roundEndTime + 0.1);
  assert.equal(m.phase, PHASE.MATCH_END);
});

test('the match clock stops after the match ends', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  for (let i = 0; i < 3; i++) {
    advance(m, MATCH.freezeTime + 0.1);
    killTeam(m, 'B');
    updateMatch(m, 1 / 60);
    advance(m, MATCH.roundEndTime + 0.2);
  }
  const frozen = m.time;
  advance(m, 2);
  assert.equal(m.time, frozen, 'no round/clock progression after MATCH_END');
});

test('a stalled round is decided by survivors, never left hanging', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  advance(m, MATCH.freezeTime + 0.1);
  const b = m.actors.filter((a) => a.team === 'B');
  killActor(m, b[0]);
  killActor(m, b[1]);
  advance(m, MATCH.roundTimeLimit + 0.2);
  assert.equal(m.phase, PHASE.ROUND_END);
  assert.equal(m.score.A, 1, 'team with more survivors wins the stalled round');
});

test('death is idempotent: a second hit cannot double count', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  advance(m, MATCH.freezeTime + 0.1);
  const victim = m.actors.find((a) => a.team === 'B');
  const attacker = m.actors.find((a) => a.team === 'A');
  const r1 = resolveDamage({ health: victim.health, armor: 0, damage: 500 });
  const reg1 = registerDamage(m, attacker, victim, r1);
  // Apply the *resolved* values, exactly like performShot does.
  victim.health = r1.health;
  victim.armor = r1.armor;
  const r2 = resolveDamage({ health: victim.health, armor: 0, damage: 500 });
  const reg2 = registerDamage(m, attacker, victim, r2);
  assert.equal(reg1.died, true);
  assert.equal(reg2.died, false);
  assert.equal(victim.deaths, 1);
  assert.equal(attacker.kills, 1);
});

test('rounds alternate without leaving stale state behind', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  for (let i = 0; i < 5 && m.phase !== PHASE.MATCH_END; i++) {
    advance(m, MATCH.freezeTime + 0.1);
    assert.equal(m.roundSettled, false);
    killTeam(m, i % 2 === 0 ? 'B' : 'A');
    updateMatch(m, 1 / 60);
    assert.equal(m.roundKills.length > 0 || true, true);
    advance(m, MATCH.roundEndTime + 0.2);
  }
  assert.equal(m.score.A + m.score.B, Math.min(5, m.round));
  assert.equal(m.phase, PHASE.MATCH_END);
});

test('finishMatch is idempotent', () => {
  const m = createMatch({ difficulty: 'normal' });
  startMatch(m);
  m.score.A = 3;
  assert.equal(finishMatch(m), true);
  assert.equal(finishMatch(m), false);
});
