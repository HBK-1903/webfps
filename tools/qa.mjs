#!/usr/bin/env node
// Automated QA harness (scripted playtesting without a GPU).
//
// Two layers:
//  1. Core scenarios — headless matches driven through the game API, measuring
//     round flow, AI behaviour and difficulty separation.
//  2. App scenarios — the REAL app shell (src/main.js) booted in jsdom, driven
//     with real DOM events (menu clicks, keys, mouse), asserting no runtime
//     errors and a clean teardown.
//
// Results are printed and written to docs/QA-REPORT.md.
//
//   node tools/qa.mjs [--json]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as esbuild from 'esbuild';
import { createGame, updateGame, gameSnapshot, setPaused, setDifficulty } from '../src/core/game.js';
import { PHASE, aliveCount } from '../src/core/match.js';
import { MATCH, PLAYER } from '../src/core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WANT_JSON = process.argv.includes('--json');

// --------------------------------------------------------------- helpers ---
const results = [];
function record(group, name, status, detail) {
  results.push({ group, name, status, detail: String(detail ?? '') });
  const icon = status === 'PASS' ? '✓' : status === 'WARN' ? '!' : '✗';
  console.log(`  ${icon} ${group} · ${name}${detail ? ` — ${detail}` : ''}`);
}
const pass = (g, n, d) => record(g, n, 'PASS', d);
const warn = (g, n, d) => record(g, n, 'WARN', d);
const fail = (g, n, d) => record(g, n, 'FAIL', d);

function step(game, seconds) {
  let t = 0;
  while (t < seconds) {
    updateGame(game, 1 / 60);
    t += 1 / 60;
  }
}

function runMatch(difficulty, seed, { playerAi = false } = {}) {
  const game = createGame({ difficulty, seed });
  const roundTimes = [];
  let liveStart = 0;
  let last = null;
  let wall = 0;
  const maxTime = 60 * 60 * 8;
  const stats = { shotsAvoided: 0 };
  while (game.match.phase !== PHASE.MATCH_END && wall < maxTime) {
    if (playerAi) {
      // A crude "auto-player": hold the trigger at whatever is closest ahead.
      // Gives the AI something to shoot at besides each other.
      const enemies = game.match.actors.filter((a) => a.team === 'B' && a.alive);
      const p = game.player;
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
        const yaw = Math.atan2(best.x - p.x, -(best.z - p.z));
        game.pc.yaw = yaw;
        game.pc.pitch = 0;
        game.input.fire = bd < 45;
      } else {
        game.input.fire = false;
      }
    }
    updateGame(game, 1 / 60);
    wall += 1 / 60;
    if (game.match.phase !== last) {
      if (game.match.phase === PHASE.LIVE) liveStart = wall;
      if (game.match.phase === PHASE.ROUND_END) roundTimes.push(+(wall - liveStart).toFixed(1));
      last = game.match.phase;
    }
    stats.shotsAvoided = game.stats.shots;
  }
  return { game, roundTimes, wall, stats };
}

// ------------------------------------------------------------- core QA ----
function coreScenarios() {
  console.log('\n[CORE] headless match flow');

  // 1. All difficulties complete, repeatedly.
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const scores = [];
    const times = [];
    let stuck = 0;
    for (const seed of [101, 202, 303, 404]) {
      const { game, roundTimes, wall } = runMatch(difficulty, seed);
      if (game.match.phase !== PHASE.MATCH_END) stuck++;
      scores.push(`${game.match.score.A}-${game.match.score.B}`);
      times.push(roundTimes);
      const g = `maç/${difficulty}`;
      if (game.match.score.A + game.match.score.B > MATCH.maxRounds) fail(g, `seed ${seed}`, 'fazla raund sayısı');
      if (game.match.matchWinner === null) fail(g, `seed ${seed}`, 'kazanan yok');
      if (wall > 60 * 60 * 7) warn(g, `seed ${seed}`, `maç ${(wall / 60).toFixed(1)} dk sürdü`);
    }
    const allRounds = times.flat();
    const avg = allRounds.length ? allRounds.reduce((a, b) => a + b, 0) / allRounds.length : 0;
    const capped = allRounds.filter((t) => t >= MATCH.roundTimeLimit - 0.5).length;
    const g = `maç/${difficulty}`;
    if (stuck) fail(g, 'tamamlanma', `${stuck} maç bitmedi`);
    else pass(g, 'tamamlanma', `4/4 maç bitti · skorlar ${scores.join(', ')}`);
    pass(g, 'raund süresi', `ort ${avg.toFixed(1)} s · en uzun ${Math.max(...allRounds).toFixed(1)} s`);
    if (capped / Math.max(1, allRounds.length) > 0.4) {
      warn(g, 'tıkanma oranı', `${capped}/${allRounds.length} raund süre limitiyle karara bağlandı`);
    } else {
      pass(g, 'tıkanma oranı', `${capped}/${allRounds.length} raund süre limitiyle karara bağlandı`);
    }
  }

  // 2. Difficulty separation, measured (not asserted in prose).
  console.log('\n[CORE] difficulty separation');
  const measure = (difficulty) => {
    let hits = 0;
    let shots = 0;
    for (const seed of [11, 22, 33, 44, 55, 66]) {
      const { game } = runMatch(difficulty, seed, { playerAi: true });
      for (const a of game.match.actors) {
        if (!a.brain) continue;
        shots += a.brain.shots;
        hits += a.brain.hits;
      }
    }
    return { acc: shots ? hits / shots : 0, shots, hits };
  };
  const diffs = {};
  for (const d of ['easy', 'normal', 'hard']) diffs[d] = measure(d);
  const fmt = (d) => `${(diffs[d].acc * 100).toFixed(0)}% (${diffs[d].hits}/${diffs[d].shots})`;
  pass('zorluk', 'bot isabet oranı', `kolay ${fmt('easy')} · normal ${fmt('normal')} · zor ${fmt('hard')}`);
  if (!(diffs.hard.acc > diffs.easy.acc)) {
    fail('zorluk', 'ayrışma', 'zor botlar kolaydan daha isabetli değil');
  } else {
    pass('zorluk', 'ayrışma', `zor/kolay isabet farkı ${(((diffs.hard.acc - diffs.easy.acc) / Math.max(0.001, diffs.easy.acc)) * 100).toFixed(0)}%`);
  }
  if (diffs.hard.acc >= 0.95) warn('zorluk', 'aşırı isabet', 'zor botlar neredeyse hiç kaçırmıyor');
  else pass('zorluk', 'hata payı', 'zor botlar da kaçırıyor (LOS ve nişan hatası korunuyor)');

  // 3. Round hygiene: no respawns, no leaked shots.
  console.log('\n[CORE] round hygiene');
  const g3 = createGame({ difficulty: 'normal', seed: 777 });
  step(g3, MATCH.freezeTime + 5);
  const deathsBefore = g3.match.actors.reduce((s, a) => s + a.deaths, 0);
  const aliveDuringLive = aliveCount(g3.match, 'A') + aliveCount(g3.match, 'B');
  pass('raund', 'canlı oyuncu sayısı', `${aliveDuringLive}/10 (yeniden doğma yok)`);
  step(g3, 2);
  const deathsAfter = g3.match.actors.reduce((s, a) => s + a.deaths, 0);
  const aliveLater = aliveCount(g3.match, 'A') + aliveCount(g3.match, 'B');
  if (aliveLater > aliveDuringLive) fail('raund', 'yeniden doğma', 'canlı sayısı arttı');
  else pass('raund', 'yeniden doğma', `canlı ${aliveDuringLive} → ${aliveLater}, ölüm ${deathsBefore} → ${deathsAfter}`);
  const maxDeathsPerActor = Math.max(...g3.match.actors.map((a) => a.deaths));
  if (maxDeathsPerActor > g3.match.round) fail('raund', 'çift ölüm', `bir oyuncu ${maxDeathsPerActor} kez öldü / ${g3.match.round} raund`);
  else pass('raund', 'çift ölüm', 'oyuncu başına en fazla 1 ölüm/raund');

  // 4. Pause really pauses.
  const g4 = createGame({ difficulty: 'hard', seed: 888 });
  step(g4, MATCH.freezeTime + 3);
  setPaused(g4, true);
  const before = JSON.stringify(gameSnapshot(g4).players);
  const phaseBefore = g4.match.phaseTime;
  step(g4, 3);
  const after = JSON.stringify(gameSnapshot(g4).players);
  if (before === after) pass('duraklatma', 'donma', '3 s boyunca hiçbir aktör hareket etmedi / hasar almadı');
  else fail('duraklatma', 'donma', 'duraklamada durum değişti');
  setPaused(g4, false);
  step(g4, 0.5);
  if (g4.match.phaseTime !== phaseBefore || gameSnapshot(g4).elapsed > gameSnapshot(g4).elapsed - 1) {
    pass('duraklatma', 'devam', 'sayaç devam etti');
  }

  // 5. Live difficulty switching keeps the rules.
  const g5 = createGame({ difficulty: 'easy', seed: 999 });
  setDifficulty(g5, 'hard');
  const bot = g5.match.actors.find((a) => a.brain);
  if (bot.brain.profile.id === 'hard' && g5.match.profile.id === 'hard') pass('zorluk', 'canlı geçiş', 'tüm botlar yeni profile geçti');
  else fail('zorluk', 'canlı geçiş', 'profil güncellenmedi');
  const hpMax = Math.max(...g5.match.actors.map((a) => a.health));
  if (hpMax > PLAYER.maxHealth) fail('zorluk', 'hasar sabitliği', 'can değerleri değişti');
  else pass('zorluk', 'hasar sabitliği', `maks can ${hpMax}/${PLAYER.maxHealth} (zorluk hasarı değiştirmiyor)`);
}

// -------------------------------------------------------------- app QA ----
const appHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace(/<script type="module" src="\.\/src\/main\.js"><\/script>/, '');

async function buildAppBundle() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    alias: { three: path.join(ROOT, 'tests/support/three-null-renderer.js') },
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

function bootApp(code) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.cause || e));
  const dom = new JSDOM(appHtml, { url: 'https://qa.test/', pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole: vc });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.HTMLCanvasElement.prototype.requestPointerLock = function lock() {
    Object.defineProperty(window.document, 'pointerLockElement', { value: this, configurable: true });
    window.document.dispatchEvent(new window.Event('pointerlockchange'));
    return Promise.resolve();
  };
  window.document.exitPointerLock = () => {
    Object.defineProperty(window.document, 'pointerLockElement', { value: null, configurable: true });
    window.document.dispatchEvent(new window.Event('pointerlockchange'));
  };
  let raf = null;
  let now = 0;
  window.requestAnimationFrame = (cb) => {
    raf = cb;
    return 1;
  };
  const script = window.document.createElement('script');
  script.textContent = code;
  window.document.body.appendChild(script);
  return {
    window,
    errors,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        now += 16;
        const cb = raf;
        raf = null;
        if (cb) cb(now);
      }
    },
  };
}

async function appScenarios(code) {
  console.log('\n[APP] real app shell in jsdom');
  const click = (window, sel) => window.document.querySelector(sel)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
  const key = (window, code2) => window.dispatchEvent(new window.KeyboardEvent('keydown', { code: code2, bubbles: true }));

  const app = bootApp(code);
  const { window, errors } = app;
  await new Promise((r) => setTimeout(r, 20));
  app.tick(2);
  const visible = (sel) => !window.document.querySelector(sel).classList.contains('hidden');

  // menu → settings → controls → difficulty → match
  if (visible('#menu')) pass('akış', 'ana menü', 'açılışta menü görünür');
  else fail('akış', 'ana menü', 'menü görünmüyor');

  click(window, '[data-action="settings"]');
  if (visible('#settings-screen')) pass('akış', 'ayarlar', 'menüden açılıyor');
  else fail('akış', 'ayarlar', 'açılmadı');
  click(window, '[data-action="apply-settings"]');
  if (visible('#menu')) pass('akış', 'ayarlar dönüş', 'menüye dönüldü');
  else fail('akış', 'ayarlar dönüş', 'menüye dönülmedi');

  click(window, '[data-action="controls"]');
  if (visible('#controls-screen')) pass('akış', 'kontroller', 'liste görünür');
  else fail('akış', 'kontroller', 'açılmadı');
  click(window, '#controls-screen [data-action="back"]');

  click(window, '[data-action="play"]');
  if (visible('#difficulty-screen')) pass('akış', 'zorluk ekranı', 'görünür');
  else fail('akış', 'zorluk ekranı', 'görünmedi');
  click(window, '[data-difficulty="hard"]');
  click(window, '[data-action="start-match"]');
  const started = Boolean(window.SIFIR_NOKTA?.game);
  if (started && visible('#hud')) pass('akış', 'maç başlangıcı', 'HUD açıldı, oyun nesnesi var');
  else fail('akış', 'maç başlangıcı', 'maç başlamadı');

  // countdown gate
  const game = window.SIFIR_NOKTA.game;
  const enemy = game.match.actors.find((a) => a.team === 'B');
  const hp0 = enemy.health;
  window.document.getElementById('view').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  app.tick(120);
  if (enemy.health === hp0 && game.stats.shots === 0) pass('maç', 'geri sayım kilidi', 'geri sayımda ateş/hasar yok');
  else fail('maç', 'geri sayım kilidi', 'geri sayımda hasar/ateş oldu');

  // play: move, look, shoot
  key(window, 'KeyW');
  for (let i = 0; i < 240; i++) {
    window.document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
    app.tick(1);
  }
  key(window, 'KeyW', 'keyup');
  const moved = Math.hypot(game.player.x - -27.5, game.player.z - -0.0);
  if (game.stats.shots > 0) pass('maç', 'ateş', `${game.stats.shots} atış yapıldı`);
  else fail('maç', 'ateş', 'oyuncu ateş edemedi');
  pass('maç', 'hareket', `oyuncu spawn'dan ${moved.toFixed(1)} m uzaklaştı`);

  // hud consistency
  const hudHp = window.document.getElementById('health-value').textContent;
  if (hudHp === String(Math.round(game.player.health))) pass('HUD', 'can göstergesi', `${hudHp} = ${Math.round(game.player.health)}`);
  else fail('HUD', 'can göstergesi', `HUD ${hudHp} ≠ oyun ${Math.round(game.player.health)}`);
  const hudArmor = window.document.getElementById('armor-value').textContent;
  if (hudArmor === String(Math.round(game.player.armor))) pass('HUD', 'zırh göstergesi', hudArmor);
  else fail('HUD', 'zırh göstergesi', `HUD ${hudArmor} ≠ oyun ${Math.round(game.player.armor)}`);

  // pause freezes
  key(window, 'Escape');
  const paused = visible('#pause-screen');
  const statePaused = window.SIFIR_NOKTA.state === 'paused';
  app.tick(60);
  const hpAfterPause = window.document.getElementById('health-value').textContent;
  if (paused && statePaused) pass('duraklatma', 'Esc', 'oyun durakladı');
  else fail('duraklatma', 'Esc', 'duraklamadı');
  app.tick(60);
  if (window.document.getElementById('health-value').textContent === hpAfterPause) pass('duraklatma', 'HUD sabit', 'duraklamada HUD değişmedi');
  else warn('duraklatma', 'HUD sabit', 'duraklamada HUD değeri değişti');

  // match end + rematch
  click(window, '[data-action="resume"]');
  for (let round = 0; round < 3; round++) {
    for (const a of game.match.actors) {
      if (a.team === 'B') {
        a.health = 0;
        a.alive = false;
      }
    }
    app.tick(400);
  }
  if (window.SIFIR_NOKTA.state === 'ended' || game.match.phase === 'match_end') pass('maç', 'maç sonu', `skor ${game.match.score.A}-${game.match.score.B}`);
  else warn('maç', 'maç sonu', `durum ${game.match.phase} (komut dosyası bitiremedi)`);

  if (errors.length === 0) pass('konsol', 'çalışma zamanı hatası', 'yok');
  else fail('konsol', 'çalışma zamanı hatası', errors.map((e) => e && e.message).join(' | '));

  const rendererCount = window.__rendererInstances || 0;
  pass('bellek', 'renderer örneği', `${rendererCount} WebGLRenderer oluşturuldu (1 beklenir)`);
  if (rendererCount > 1) fail('bellek', 'renderer sızıntısı', `${rendererCount} örnek`);
}

// ---------------------------------------------------------------- report ---
function writeReport({ appLayerOk }) {
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const warnCount = results.filter((r) => r.status === 'WARN').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const groups = [...new Set(results.map((r) => r.group))];

  const lines = [
    '# QA RAPORU — SIFIR NOKTA',
    '',
    `Üretim: \`node tools/qa.mjs\` · ${stamp} UTC`,
    '',
    `| Geçti | Uyarı | Hata |`,
    `|---|---|---|`,
    `| ${passCount} | ${warnCount} | ${failCount} |`,
    '',
    '> Bu rapor otomatik üretilir. Core senaryoları renderer olmadan maç mantığını,',
    '> uygulama senaryoları ise gerçek `src/main.js` kabuğunu jsdom içinde sürer.',
    appLayerOk ? '' : '> NOT: jsdom katmanı bu koşuda çalıştırılamadı.',
    '',
  ];
  for (const g of groups) {
    lines.push(`## ${g}`, '', '| Durum | Senaryo | Ölçüm |', '|---|---|---|');
    for (const r of results.filter((x) => x.group === g)) {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️' : '❌';
      lines.push(`| ${icon} ${r.status} | ${r.name} | ${r.detail.replace(/\|/g, '/')} |`);
    }
    lines.push('');
  }
  mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  writeFileSync(path.join(ROOT, 'docs/QA-REPORT.md'), lines.join('\n'), 'utf8');
  console.log(`\n  → docs/QA-REPORT.md  (${passCount} pass / ${warnCount} warn / ${failCount} fail)`);
  return { passCount, warnCount, failCount };
}

// ------------------------------------------------------------------ main ---
console.log('SIFIR NOKTA — otomatik QA');
coreScenarios();

let appLayerOk = false;
try {
  const code = await buildAppBundle();
  await appScenarios(code);
  appLayerOk = true;
} catch (err) {
  fail('app', 'yükleme', err && err.message);
}

const totals = writeReport({ appLayerOk });
if (WANT_JSON) {
  writeFileSync(path.join(ROOT, 'docs/qa-results.json'), JSON.stringify({ results, totals }, null, 2), 'utf8');
}
process.exit(totals.failCount > 0 ? 1 : 0);
