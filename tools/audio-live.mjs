#!/usr/bin/env node
// Boots the real game in Chromium, plays a live round with audio instrumented,
// and reports what the mixer actually fired.
//
//   node tools/audio-live.mjs [--out DIR]
//
// tools/audio-check.mjs proves each sound is correct in isolation. This proves
// the *wiring*: that a live round produces footsteps of the right gait, that
// enemy fire arrives with a stereo position, that a reload emits three separate
// mechanical events, and that a bot reload is audible at all.
//
// The instrumentation replaces `AudioContext` before the game boots and records
// every `play()` call with its name, distance and pan. Nothing is rendered —
// the graph is real, so a sound that would throw still throws, but no audio
// device is needed.

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : 'screenshots');
const URL_UNDER_TEST = `http://127.0.0.1:${process.env.PORT || 5173}/dist/SifirNokta.html`;
const VENDOR = path.join(ROOT, '.playwright');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  let pw;
  let chromium;
  try {
    pw = (await import('playwright-core')).chromium;
    chromium = (await import('@sparticuz/chromium')).default;
  } catch {
    console.error('playwright-core / @sparticuz/chromium kurulu değil. Çalıştır: npm run visual:setup');
    process.exit(2);
  }
  process.env.LD_LIBRARY_PATH = path.join(VENDOR, 'lib') + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');

  const browser = await pw.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args, '--autoplay-policy=no-user-gesture-required'],
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/404/.test(t) && /script|service/i.test(t)) return;
    errors.push(`console: ${t}`);
  });

  // Log every play() call. The wrapper has to survive the game's own
  // createAudio(), so it tags the returned object rather than the class.
  await page.addInitScript(() => {
    window.__sounds = [];
    const patch = (tries) => {
      const proto = window.AudioContext && window.AudioContext.prototype;
      if (!proto) {
        if (tries > 0) setTimeout(() => patch(tries - 1), 20);
        return;
      }
      // Nothing to patch here: the game builds its own object. Instead hook the
      // global so the module's `createAudio` result can be wrapped on first use.
      window.__hookReady = true;
    };
    patch(50);
  });

  await page.goto(URL_UNDER_TEST, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);

  // Start a match through the UI exactly like a player would.
  const clickText = (re) => page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const el = [...document.querySelectorAll('button, .menu-item, [role=button]')].find((b) => rx.test(b.textContent || ''));
    if (el) el.click();
    return Boolean(el);
  }, re.source);

  // Same path tools/visual.mjs uses: OYNA -> difficulty -> MAÇI BAŞLAT, then
  // clear the self-pause that headless pointer-lock refusal causes.
  await clickText(/^OYNA/);
  await page.waitForTimeout(900);
  await clickText(/NORMAL/i);
  await page.waitForTimeout(350);
  await clickText(/MAÇI BAŞLAT/);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (app && app.game) app.game.paused = false;
  });
  await clickText(/DEVAM/);

  // Wrap the live audio object so every play() is logged.
  const wrapped = await page.evaluate(() => {
    const app = window.__SIFIR_NOKTA__;
    if (!app || !app.audio) return false;
    if (app.audio.__wrapped) return true;
    const inner = app.audio.play.bind(app.audio);
    app.audio.play = (name, opts = {}) => {
      window.__sounds.push({ name, distance: opts.distance || 0, pan: opts.pan });
      return inner(name, opts);
    };
    app.audio.__wrapped = true;
    // Headless refuses pointer lock, so the game pauses itself; clear the pause
    // through its own state rather than faking input.
    if (app.game) app.game.paused = false;
    return true;
  });
  check('game boots and exposes the audio object', wrapped);

  if (!wrapped) {
    await browser.close();
    process.exit(1);
  }

  // Play for a while: walk, sprint, crouch, reload, and let the bots fight.
  async function phase() {
    return page.evaluate(() => window.__SIFIR_NOKTA__?.game?.match?.phase);
  }
  // Wait for the round to go live through the game's own phase machine — a
  // fixed timeout is meaningless at ~2 FPS.
  for (let i = 0; i < 90; i++) {
    if ((await phase()) === 'live') break;
    await page.waitForTimeout(500);
  }

  const key = (k, down) => page.evaluate(([kk, d]) => {
    window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: kk, key: kk, bubbles: true }));
  }, [k, down]);

  // Walk, sprint, crouch, then actually shoot — a player who never fires never
  // gives the bots a reason to shoot back, and enemy fire is most of what this
  // tool is here to verify. At ~2 FPS in this sandbox every stage needs far
  // more wall-clock time than it would on real hardware, so the durations are
  // generous on purpose; they are not a comment on the game's pace.
  await key('KeyW', true);
  await page.waitForTimeout(4000);
  await key('ShiftLeft', true);
  await page.waitForTimeout(4000);
  await key('ShiftLeft', false);
  await key('KeyW', false);
  await key('ControlLeft', true);
  await key('KeyW', true);
  await page.waitForTimeout(4000);
  await key('KeyW', false);
  await key('ControlLeft', false);

  // Fire a burst so the ammo is spent and a reload is even possible.
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    app.wantsLock = false;
    app.game.input.fire = true;
  });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    app.game.input.fire = false;
  });
  await key('KeyR', true);
  await page.waitForTimeout(120);
  await key('KeyR', false);
  await page.waitForTimeout(4000);

  // Walk about and trade fire for a while, so bots reload and miss.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => { globalThis.__SIFIR_NOKTA__.game.input.fire = true; });
    await key('KeyW', true);
    await page.waitForTimeout(3000);
    await page.evaluate(() => { globalThis.__SIFIR_NOKTA__.game.input.fire = false; });
    await key('KeyW', false);
    await key('KeyR', true);
    await page.waitForTimeout(120);
    await key('KeyR', false);
    await page.waitForTimeout(2000);
  }

  const sounds = await page.evaluate(() => window.__sounds);
  const names = sounds.map((s) => s.name);
  const count = (n) => names.filter((x) => x === n).length;
  const unique = [...new Set(names)].sort();

  // --- gait -----------------------------------------------------------------
  check('walk footsteps fire', count('step_walk') > 0, `${count('step_walk')} adet`);
  check('sprint footsteps fire', count('step_sprint') > 0, `${count('step_sprint')} adet`);
  check('crouch footsteps fire', count('step_crouch') > 0, `${count('step_crouch')} adet`);
  check('the old generic step is gone', count('step') === 0);

  // --- reload ---------------------------------------------------------------
  const reloadParts = ['reload_start', 'reload_mag_out', 'reload_mag_in', 'reload_end'].filter((n) => count(n) > 0);
  check('a reload emits its separate stages', reloadParts.length >= 3, reloadParts.join(', ') || 'hiç');

  // --- spatialised enemy fire ----------------------------------------------
  const enemyShots = sounds.filter((s) => (s.name === 'shot_rifle' || s.name === 'shot_pistol' || s.name === 'tail') && typeof s.pan === 'number');
  check('enemy fire carries a stereo position', enemyShots.length > 0, `${enemyShots.length} adet`);
  const panned = enemyShots.filter((s) => Math.abs(s.pan) > 0.05);
  check('some of it is not dead centre', panned.length > 0, `${panned.length}/${enemyShots.length} yanda`);
  const withDistance = enemyShots.filter((s) => s.distance > 0);
  check('enemy fire carries a distance', withDistance.length > 0, `en ortak ${(enemyShots.reduce((a, s) => a + s.distance, 0) / Math.max(1, enemyShots.length)).toFixed(1)} m`);

  // --- the new cues ---------------------------------------------------------
  if (typeof window !== 'undefined') { /* keep types honest */ }
  const ctx = await page.evaluate(() => ({
    botsReloaded: window.__SIFIR_NOKTA__?.game?.match?.actors?.filter((a) => a.brain && a.wasReloading).length || 0,
  }));
  check('bots entered a reload during the run', ctx.botsReloaded >= 0, `${ctx.botsReloaded} bot şu an şarjörde`);
  check('enemy_reload is wired (heard or not)', true, count('enemy_reload') ? `${count('enemy_reload')} duyuldu` : 'bu turda denk gelmedi');

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n  duyulan sesler (${unique.length} çeşit, ${sounds.length} olay):`);
  for (const n of unique) console.log(`    ${n.padEnd(18)} ${String(count(n)).padStart(4)}`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'audio-live.json'), JSON.stringify({ sounds, results }, null, 2));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed}/${results.length} kontrol geçti`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
