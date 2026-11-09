// Taking control of a teammate (CS2-style possession).
//
// This is the only feature in the game that changes *who the player is*, so the
// tests are about invariants rather than symptoms: exactly one actor may be the
// player, the actor you drive must never also be simulated by a brain, and the
// body you leave behind must stay a valid part of the round.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, updateGame, possessTeammate, hudState } from '../src/core/game.js';
import { resetActorIds } from '../src/core/actor.js';

function freshGame(seed = 21) {
  resetActorIds();
  const game = createGame({ difficulty: 'normal', seed });
  game.paused = false;
  game.started = true;
  // Skip the freeze phase so occupancy changes are exercised in a live round.
  game.match.phase = 'live';
  game.match.phaseTime = 0;
  return game;
}

function teammates(game) {
  return game.match.actors.filter((a) => a.team === game.player.team && !a.isPlayer);
}

/** Advance the simulation for `seconds` in small steps. */
function run(game, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) updateGame(game, dt);
}

test('exactly one actor is the player at the start', () => {
  const game = freshGame();
  const players = game.match.actors.filter((a) => a.isPlayer);
  assert.equal(players.length, 1);
  assert.equal(players[0].id, game.player.id);
});

test('taking a teammate makes them the player', () => {
  const game = freshGame();
  const mate = teammates(game)[0];
  const before = game.player;
  const taken = possessTeammate(game, mate.id);
  assert.ok(taken);
  assert.equal(game.player.id, mate.id);
  assert.equal(game.pc.actor.id, mate.id);
  assert.notEqual(game.player.id, before.id);
});

test('there is still exactly one player after possession', () => {
  const game = freshGame();
  possessTeammate(game, teammates(game)[0].id);
  const players = game.match.actors.filter((a) => a.isPlayer);
  assert.equal(players.length, 1, `oyuncu sayısı ${players.length}`);
  assert.equal(players[0].id, game.player.id);
});

test('the actor you drive has no brain — otherwise it fights you for control', () => {
  const game = freshGame();
  const mate = teammates(game)[0];
  assert.ok(mate.brain, 'testin önkoşulu: botun beyni olmalı');
  possessTeammate(game, mate.id);
  assert.equal(game.player.brain, null);
});

test('the body you leave behind gets a brain and keeps playing', () => {
  const game = freshGame();
  const left = game.player;
  possessTeammate(game, teammates(game)[0].id);
  assert.equal(left.isPlayer, false);
  assert.ok(left.brain, 'bırakılan gövde donup kalmamalı');
});

test('the possessed actor is no longer simulated by the bot loop', () => {
  const game = freshGame();
  const mate = teammates(game)[0];
  possessTeammate(game, mate.id);
  // The loop that drives bots selects on `brain`, so the driven actor must be
  // absent from it.
  const driven = game.match.actors.filter((a) => a.brain && a.alive).map((a) => a.id);
  assert.ok(!driven.includes(game.player.id), 'devralınan aktör hâlâ bot gibi güncelleniyor');
});

test('you cannot possess a dead teammate', () => {
  const game = freshGame();
  const mate = teammates(game)[0];
  mate.alive = false;
  assert.equal(possessTeammate(game, mate.id), null);
  assert.notEqual(game.player.id, mate.id);
});

test('you cannot possess an enemy', () => {
  const game = freshGame();
  const enemy = game.match.actors.find((a) => a.team !== game.player.team && a.alive);
  assert.ok(enemy);
  assert.equal(possessTeammate(game, enemy.id), null);
});

test('you cannot possess yourself', () => {
  const game = freshGame();
  assert.equal(possessTeammate(game, game.player.id), null);
});

test('possessing an unknown id is refused without throwing', () => {
  const game = freshGame();
  assert.equal(possessTeammate(game, 999999), null);
  assert.equal(possessTeammate(game, null), null);
  assert.equal(possessTeammate(game, undefined), null);
});

test('possession stops the spectator camera', () => {
  const game = freshGame();
  game.player.alive = false;
  game.spectate.mode = 'follow';
  const mate = teammates(game).find((a) => a.alive);
  possessTeammate(game, mate.id);
  assert.equal(game.spectate.mode, 'none');
  assert.equal(game.spectate.cam, null);
});

test('the camera restarts on the new body rather than inheriting the old heading', () => {
  const game = freshGame();
  game.pc.yaw = 2.5;
  game.pc.pitch = -0.4;
  const mate = teammates(game)[0];
  mate.yaw = -1.1;
  possessTeammate(game, mate.id);
  assert.ok(Math.abs(game.pc.pitch) < 1e-9, 'eğim devralınmamalı');
  assert.ok(Math.abs(game.pc.yaw - mate.yaw) < 1e-9, 'yön yeni gövdeye göre olmalı');
});

test('the player can move after taking over', () => {
  const game = freshGame();
  const mate = teammates(game).find((a) => a.alive);
  possessTeammate(game, mate.id);
  const startX = game.player.x;
  const startZ = game.player.z;
  game.pc.yaw = 0;
  game.input.forward = 1;
  run(game, 0.6);
  const moved = Math.hypot(game.player.x - startX, game.player.z - startZ);
  assert.ok(moved > 0.3, `devraldıktan sonra hareket yok: ${moved.toFixed(3)} m`);
});

test('the previous body does not follow the player around', () => {
  const game = freshGame();
  const left = game.player;
  const leftPos = { x: left.x, z: left.z };
  possessTeammate(game, teammates(game)[0].id);
  game.pc.yaw = 0;
  game.input.forward = 1;
  run(game, 0.6);
  game.input.forward = 0;
  // The left body may drift a little on its own brain, but it must not teleport
  // to the player's new position — that is the classic possession bug where the
  // old body becomes a shadow.
  const d = Math.hypot(left.x - leftPos.x, left.z - leftPos.z);
  assert.ok(d < 5, `bırakılan gövde fırladı: ${d.toFixed(1)} m`);
});

test('the scoreboard shows one player, not two', () => {
  const game = freshGame();
  possessTeammate(game, teammates(game)[0].id);
  const state = hudState(game);
  // `teamMates` is the side list the HUD renders. Exactly one row may be
  // marked as the player, otherwise the list highlights two names at once after
  // a takeover.
  const flagged = state.teamMates.filter((a) => a.isPlayer);
  assert.equal(flagged.length, 1, `${flagged.length} satır oyuncu olarak işaretli`);
  assert.equal(flagged[0].id, game.player.id);
  // The whole roster, not just the player's side, must agree.
  const allPlayers = game.match.actors.filter((a) => a.isPlayer);
  assert.equal(allPlayers.length, 1);
});

test('possessing twice in a row works and never leaves two players', () => {
  const game = freshGame();
  const first = teammates(game).find((a) => a.alive);
  possessTeammate(game, first.id);
  const second = game.match.actors.find(
    (a) => a.team === game.player.team && !a.isPlayer && a.alive && !a.possessedFrom,
  );
  if (second) {
    possessTeammate(game, second.id);
    assert.equal(game.match.actors.filter((a) => a.isPlayer).length, 1);
  }
});

test('a round restart restores a single player and no spectator', () => {
  const game = freshGame();
  possessTeammate(game, teammates(game)[0].id);
  game.spectate.mode = 'free';
  // Force a round start.
  game.match.phase = 'freeze';
  game.match.phaseTime = 0;
  run(game, 1.2);
  if (game.match.phase === 'round_start' || game.match.round > 1) {
    assert.equal(game.spectate.mode === 'free' && game.player.alive === false, false);
  }
  // Whatever happens, the invariant holds.
  assert.equal(game.match.actors.filter((a) => a.isPlayer).length, 1);
});

test('the game is still playable after a takeover', () => {
  const game = freshGame();
  possessTeammate(game, teammates(game).find((a) => a.alive).id);
  run(game, 1.5);
  const state = hudState(game);
  assert.ok(Number.isFinite(state.health));
  assert.ok(Number.isFinite(game.player.x) && Number.isFinite(game.player.z));
  assert.ok(game.player.x >= -31 && game.player.x <= 31, `haritadan çıktı: ${game.player.x}`);
});
