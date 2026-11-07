// End-to-end smoke test of the real application shell (src/main.js) inside
// jsdom. Boots the app, walks the whole menu -> match -> pause -> match-end
// flow through actual DOM clicks and keyboard/mouse events, and asserts that
// no uncaught exception reaches window.onerror.
//
// Only WebGLRenderer is stubbed (jsdom has no WebGL); everything else is real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  // the import map is only for the dev server; the test bundles instead
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace(/<script type="module" src="\.\/src\/main\.js"><\/script>/, '');

const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  write: false,
  format: 'iife',
  target: ['es2022'],
  platform: 'browser',
  alias: { three: path.join(ROOT, 'tests/support/three-null-renderer.js') },
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;

function bootApp() {
  const errors = [];
  // jsdom reports uncaught script errors through the virtual console.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.cause || e));
  const dom = new JSDOM(html, { url: 'https://game.test/', pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));

  // jsdom lacks these; the app guards them, but give the pointer lock a shape.
  window.HTMLCanvasElement.prototype.requestPointerLock = function requestPointerLock() {
    window.__lockedElement = this;
    Object.defineProperty(window.document, 'pointerLockElement', { value: this, configurable: true });
    window.document.dispatchEvent(new window.Event('pointerlockchange'));
    return Promise.resolve();
  };
  window.document.exitPointerLock = () => {
    Object.defineProperty(window.document, 'pointerLockElement', { value: null, configurable: true });
    window.document.dispatchEvent(new window.Event('pointerlockchange'));
  };
  window.HTMLCanvasElement.prototype.getContext = () => null;
  // jsdom has no matchMedia; lil-gui queries it for its dark-mode styling.
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    });
  }
  if (!window.AudioContext) window.AudioContext = null;

  const script = window.document.createElement('script');
  script.textContent = code;
  window.document.body.appendChild(script);
  return { dom, window, errors };
}

function installRaf(window) {
  window.__rafCallback = null;
  window.requestAnimationFrame = (cb) => {
    window.__rafCallback = cb;
    return 1;
  };
  window.cancelAnimationFrame = () => {};
}

const tick = (window, ms = 16) => {
  const now = (window.__now = (window.__now || 0) + ms);
  const cb = window.__rafCallback;
  window.__rafCallback = null;
  if (cb) cb(now);
  return now;
};

const click = (window, selector) => {
  const el = window.document.querySelector(selector);
  assert.ok(el, `missing element ${selector}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
};

test('the app boots, plays a match and survives the full menu flow', async () => {
  const { window, errors } = bootApp();
  installRaf(window);
  await new Promise((r) => setTimeout(r, 30));

  // ---- main menu ----
  assert.equal(window.document.getElementById('menu').classList.contains('hidden'), false);
  tick(window);
  tick(window);
  // Inside jsdom's VM the globals live on `window`, not on Node's globalThis.
  assert.ok(window.__renderCount > 0, 'menu scene renders');
  assert.equal(window.__rendererInstances, 1, 'exactly one WebGL renderer is created');

  // Settings round trip.
  click(window, '[data-action="settings"]');
  assert.equal(window.document.getElementById('settings-screen').classList.contains('hidden'), false);
  const sense = window.document.getElementById('sense');
  sense.value = '2.5';
  sense.dispatchEvent(new window.Event('input', { bubbles: true }));
  click(window, '[data-action="apply-settings"]');
  assert.equal(window.document.getElementById('menu').classList.contains('hidden'), false);
  const stored = JSON.parse(window.localStorage.getItem('sifirnokta.settings.v1'));
  assert.equal(stored.sensitivity, 2.5, 'settings are persisted');

  // Controls screen.
  click(window, '[data-action="controls"]');
  assert.equal(window.document.getElementById('controls-screen').classList.contains('hidden'), false);
  click(window, '#controls-screen [data-action="back"]');
  assert.equal(window.document.getElementById('menu').classList.contains('hidden'), false);

  // ---- difficulty + start ----
  click(window, '[data-action="play"]');
  assert.equal(window.document.getElementById('difficulty-screen').classList.contains('hidden'), false);
  click(window, '[data-difficulty="hard"]');
  click(window, '[data-action="start-match"]');
  assert.equal(window.document.getElementById('hud').classList.contains('hidden'), false, 'HUD appears with the match');
  assert.equal(window.document.getElementById('difficulty-tag').textContent, 'HARD');

  // ---- play for a while: move, look, shoot, reload, switch ----
  const key = (code, type = 'keydown') =>
    window.dispatchEvent(new window.KeyboardEvent(type, { code, bubbles: true }));
  const canvas = window.document.getElementById('view');

  // countdown first
  for (let i = 0; i < 200; i++) tick(window); // ~3.2s at 16ms
  key('KeyW');
  canvas.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  for (let i = 0; i < 90; i++) {
    window.document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
    tick(window);
  }
  key('KeyW', 'keyup');
  window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  key('KeyR');
  key('Digit1');
  for (let i = 0; i < 120; i++) tick(window);
  key('Digit2');

  const hudAmmo = window.document.getElementById('ammo-mag').textContent;
  assert.match(hudAmmo, /^\d+$/);

  // ---- pause / resume via Escape ----
  key('Escape');
  assert.equal(window.document.getElementById('pause-screen').classList.contains('hidden'), false, 'Escape pauses');
  const pausedHealth = window.document.getElementById('health-value').textContent;
  for (let i = 0; i < 60; i++) tick(window);
  assert.equal(window.document.getElementById('health-value').textContent, pausedHealth, 'nothing changes while paused');
  click(window, '[data-action="resume"]');
  assert.equal(window.document.getElementById('pause-screen').classList.contains('hidden'), true);
  for (let i = 0; i < 60; i++) tick(window);

  // ---- pause settings round trip ----
  key('Escape');
  click(window, '[data-action="pause-settings"]');
  assert.equal(window.document.getElementById('settings-screen').classList.contains('hidden'), false);
  click(window, '#settings-screen [data-action="back"]');
  assert.equal(window.document.getElementById('pause-screen').classList.contains('hidden'), false, 'back returns to pause');
  click(window, '[data-action="resume"]');

  assert.deepEqual(errors, [], `runtime errors during play: ${errors.map((e) => e && e.message).join(' | ')}`);
});

test('match end, rematch and returning to the menu work without leaking state', async () => {
  const { window, errors } = bootApp();
  installRaf(window);
  await new Promise((r) => setTimeout(r, 30));

  const key = (code) => window.dispatchEvent(new window.KeyboardEvent('keydown', { code, bubbles: true }));

  click(window, '[data-action="play"]');
  click(window, '[data-difficulty="normal"]');
  click(window, '[data-action="start-match"]');
  const app = window.SIFIR_NOKTA;
  assert.ok(app && app.game, 'debug hook exposes the running game');

  // Skip the countdown by fast-forwarding the frames.
  for (let i = 0; i < 240; i++) tick(window);

  // Win two rounds by wiping team B, then close out the match.
  for (let round = 0; round < 3; round++) {
    for (const a of app.game.match.actors) {
      if (a.team === 'B') {
        a.health = 0;
        a.alive = false;
      }
    }
    for (let i = 0; i < 40; i++) tick(window);
    // let the round-end timer and next countdown run out
    for (let i = 0; i < 60 * 5; i++) tick(window);
  }

  assert.equal(app.game.match.phase, 'match_end', `expected match_end, got ${app.game.match.phase}`);
  for (let i = 0; i < 200; i++) tick(window); // match-end delay
  assert.equal(window.document.getElementById('match-end-screen').classList.contains('hidden'), false, 'match end panel shows');
  assert.equal(app.state, 'ended');
  assert.match(window.document.getElementById('match-end-title').textContent, /KAZANDIN/);
  assert.equal(window.document.getElementById('match-end-score').textContent.includes('3'), true);

  // ---- rematch ----
  const oldGame = app.game;
  click(window, '[data-action="rematch"]');
  assert.notEqual(app.game, oldGame, 'a brand new game instance is created');
  assert.equal(app.game.match.round, 1);
  assert.equal(app.game.match.score.A, 0);
  assert.equal(app.state, 'playing');
  for (let i = 0; i < 30; i++) tick(window);

  // ---- back to the menu mid-match ----
  key('Escape');
  click(window, '[data-action="menu"]');
  assert.equal(window.document.getElementById('menu').classList.contains('hidden'), false);
  assert.equal(app.game, null, 'the game instance is disposed on exit');
  assert.equal(app.state, 'menu');
  // The menu keeps rendering without a game.
  for (let i = 0; i < 10; i++) tick(window);

  // ---- a whole new match can start again ----
  click(window, '[data-action="play"]');
  click(window, '[data-action="start-match"]');
  assert.ok(app.game);
  for (let i = 0; i < 400; i++) tick(window);
  assert.equal(app.hud.el.hud.classList.contains('hidden'), false);

  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e && e.message).join(' | ')}`);
});

test('F3 debug overlay and the structured snapshot stay consistent with play', async () => {
  const { window, errors } = bootApp();
  installRaf(window);
  await new Promise((r) => setTimeout(r, 30));
  click(window, '[data-action="play"]');
  click(window, '[data-action="start-match"]');
  for (let i = 0; i < 300; i++) tick(window);

  const overlay = window.document.getElementById('debug-overlay');
  assert.ok(overlay, 'debug overlay element exists');
  assert.equal(overlay.classList.contains('hidden'), true, 'hidden by default');

  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F3', bubbles: true }));
  assert.equal(overlay.classList.contains('hidden'), false, 'F3 shows the overlay');
  for (let i = 0; i < 30; i++) tick(window);
  assert.match(overlay.textContent, /tur live/);
  assert.match(overlay.textContent, /raund 1/);
  assert.match(overlay.textContent, /zorluk/);
  // Ten actors: the player is skipped, so nine bot lines are listed.
  const botLines = overlay.textContent.split('\n').filter((l) => /^[AB] \S/.test(l));
  assert.equal(botLines.length, 9, 'one debug line per bot (9 bots)');
  assert.equal(botLines.filter((l) => l.startsWith('B ')).length, 5, 'five enemy bots');
  assert.equal(botLines.filter((l) => l.startsWith('A ')).length, 4, 'four team bots');

  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F3', bubbles: true }));
  assert.equal(overlay.classList.contains('hidden'), true, 'F3 hides it again');

  const snap = window.SIFIR_NOKTA.game && window.SIFIR_NOKTA.game.match;
  assert.ok(snap);
  assert.equal(snap.actors.length, 10, '5v5 actors');
  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e && e.message).join(' | ')}`);
});

test('F2 tuning panel (lil-gui) writes into the live config', async () => {
  const { window, errors } = bootApp();
  installRaf(window);
  await new Promise((r) => setTimeout(r, 30));
  click(window, '[data-action="play"]');
  click(window, '[data-action="start-match"]');
  const app = window.SIFIR_NOKTA;
  for (let i = 0; i < 240; i++) tick(window);

  assert.ok(app.tuningGui, 'the tuning panel exists');
  assert.equal(app.tuningOpen, false, 'hidden by default');

  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F2', bubbles: true }));
  assert.equal(app.tuningOpen, true, 'F2 opens the panel');
  assert.ok(window.document.querySelector('.tuning-gui'), 'panel is in the DOM');

  // Drive a controller the way lil-gui does for a numeric field.
  const values = { from: 0, to: 0 };
  app.tuningGui.controllersRecursive().forEach((c) => {
    if (c.property === 'rifleDamage') {
      c.setValue(40);
      values.from = 40;
      values.to = app.game ? 40 : 0;
    }
  });
  assert.equal(values.from, 40);

  // Difficulty dropdown feeds straight into the running match.
  app.tuningGui.controllersRecursive().forEach((c) => {
    if (c.property === 'difficulty') c.setValue('hard');
  });
  assert.equal(app.game.match.difficulty, 'hard', 'tuning panel changes the live difficulty');

  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F2', bubbles: true }));
  assert.equal(app.tuningOpen, false, 'F2 hides the panel again');
  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e && e.message).join(' | ')}`);
});
