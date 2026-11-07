// DOM-level tests for the HUD and settings. jsdom has no WebGL, but the HUD is
// plain DOM, so this validates the real markup + real binding code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createHud } from '../src/ui/hud.js';
import { sanitize, loadSettings, saveSettings } from '../src/ui/settings.js';
import { createGame, updateGame, hudState } from '../src/core/game.js';
import { PHASE } from '../src/core/match.js';
import { DEFAULT_SETTINGS } from '../src/core/config.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function bootDom() {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  return dom;
}

test('HUD renders scores, vitals, ammo and rosters from real game state', () => {
  const dom = bootDom();
  const hud = createHud();
  const game = createGame({ difficulty: 'hard', seed: 21 });
  for (let i = 0; i < 240; i++) updateGame(game, 1 / 60);
  hud.update(hudState(game), 1 / 60);

  const doc = dom.window.document;
  assert.equal(doc.getElementById('health-value').textContent, String(Math.round(game.player.health)));
  assert.equal(doc.getElementById('armor-value').textContent, String(Math.round(game.player.armor)));
  assert.equal(doc.getElementById('ammo-mag').textContent, String(game.player.loadout.slots[game.player.loadout.current].mag));
  assert.match(doc.getElementById('weapon-name').textContent, /AR-14|K-7/);
  assert.equal(doc.getElementById('score-a').textContent, String(game.match.score.A));
  assert.equal(doc.getElementById('score-b').textContent, String(game.match.score.B));
  assert.match(doc.getElementById('round-label').textContent, /RAUND 1 \/ 5/);
  assert.equal(doc.getElementById('difficulty-tag').textContent, 'HARD');
  assert.equal(doc.getElementById('hud').classList.contains('hidden'), true);

  // Own team roster: five entries, one of which is the player. The enemy list
  // only reveals how many are alive.
  const teamA = doc.getElementById('team-a-list').children;
  assert.equal(teamA.length, 5);
  assert.equal(teamA[0].textContent.includes('SEN'), true);
  const teamB = doc.getElementById('team-b-list').children;
  assert.equal(teamB.length, 5);
  assert.equal([...teamB].every((li) => li.textContent.includes('HEDEF')), true, 'enemy identities are not leaked');

  hud.show(true);
  assert.equal(doc.getElementById('hud').classList.contains('hidden'), false);
});

test('HUD shows the reload ring, reload progress and empty magazine state', () => {
  const dom = bootDom();
  const hud = createHud();
  const game = createGame({ difficulty: 'normal', seed: 22 });
  for (let i = 0; i < 240; i++) updateGame(game, 1 / 60);
  const w = game.player.loadout.slots.rifle;
  w.mag = 0;
  w.reloading = true;
  w.reloadTimer = w.def.reloadTime * 0.5;
  hud.update(hudState(game), 0.016);
  const doc = dom.window.document;
  assert.equal(doc.getElementById('reload-ring').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('ammo-mag').classList.contains('empty'), true);
});

test('HUD reflects round and match outcomes', () => {
  const dom = bootDom();
  const hud = createHud();
  const game = createGame({ difficulty: 'normal', seed: 23 });
  for (let i = 0; i < 240; i++) updateGame(game, 1 / 60);
  // Wipe team B: the round should be awarded and the banner should announce it.
  for (const a of game.match.actors) if (a.team === 'B') {
    a.health = 0;
    a.alive = false;
  }
  updateGame(game, 1 / 60);
  hud.update(hudState(game), 1 / 60);
  const doc = dom.window.document;
  assert.equal(game.match.phase, PHASE.ROUND_END);
  assert.match(doc.getElementById('round-status').textContent, /ALFA RAUNDU ALDI/);
  assert.equal(doc.getElementById('score-a').textContent, '1');
});

test('settings are validated, clamped and persisted', () => {
  const dom = bootDom();
  const store = dom.window.localStorage;
  global.localStorage = store;
  store.clear();
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS, 'defaults when nothing is stored');

  const bad = sanitize({
    sensitivity: 99,
    volume: -3,
    quality: 'ultra',
    fov: 'x',
    shake: 'yes',
    difficulty: 'nightmare',
  });
  assert.equal(bad.sensitivity, 3);
  assert.equal(bad.volume, 0);
  assert.equal(bad.quality, 'medium');
  assert.equal(bad.fov, DEFAULT_SETTINGS.fov);
  assert.equal(bad.shake, true);
  assert.equal(bad.difficulty, 'normal');

  saveSettings({ ...DEFAULT_SETTINGS, sensitivity: 1.75, volume: 0.2, quality: 'low', difficulty: 'hard' });
  const loaded = loadSettings();
  assert.equal(loaded.sensitivity, 1.75);
  assert.equal(loaded.volume, 0.2);
  assert.equal(loaded.quality, 'low');
  assert.equal(loaded.difficulty, 'hard');

  store.setItem('sifirnokta.settings.v1', '{not json');
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS, 'corrupt payload falls back to defaults');
});

test('the markup exposes every control the game binds to', () => {
  const dom = bootDom();
  const doc = dom.window.document;
  for (const id of [
    'view', 'hud', 'menu', 'difficulty-screen', 'settings-screen', 'controls-screen',
    'pause-screen', 'match-end-screen', 'sense', 'volume', 'fov', 'quality', 'shake',
    'crosshair', 'hitmarker', 'reload-ring', 'lock-hint', 'toast',
  ]) {
    assert.ok(doc.getElementById(id), `missing #${id}`);
  }
  for (const action of [
    'play', 'settings', 'controls', 'quit', 'start-match', 'resume', 'restart',
    'rematch', 'menu', 'apply-settings', 'back', 'pause-settings',
  ]) {
    assert.ok(doc.querySelector(`[data-action="${action}"]`), `missing data-action=${action}`);
  }
  for (const d of ['easy', 'normal', 'hard']) {
    assert.ok(doc.querySelector(`[data-difficulty="${d}"]`), `missing difficulty card ${d}`);
  }
  // Shipped markup has no hand-written inline code: only the dev import map
  // and the module entry point (the production build inlines a bundle).
  const scripts = [...doc.querySelectorAll('script')];
  for (const script of scripts) {
    if (script.type === 'importmap') continue; // dev-only module resolution map
    assert.equal((script.textContent || '').trim(), '', 'index.html must not contain inline gameplay code');
  }
  assert.ok(doc.querySelector('script[type="importmap"]'), 'dev mode needs the three import map');
  assert.ok(doc.querySelector('script[type="module"][src="./src/main.js"]'));
});
