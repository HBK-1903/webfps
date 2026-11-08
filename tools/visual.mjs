#!/usr/bin/env node
// Real-browser test: boots the game in Chromium with software WebGL and checks
// the things jsdom structurally cannot — that it renders, where the crosshair
// actually lands, and whether the input/aim curves behave.
//
//   node tools/visual.mjs [--out DIR] [--difficulty normal] [--url URL] [--json]
//
// Setup once: npm run visual:setup   (see tools/visual-setup.mjs for why the
// browser has to come from npm)
//
// ── What this measures, and what it does not ────────────────────────────────
// Measurable here:      frames are produced at all; the reticle's pixel offset
//                       from the viewport centre; mouse-look linearity; pitch
//                       clamp; ADS and crouch transition curves; console errors.
// NOT measurable here:  how it *feels* on real hardware. This sandbox has 2
//                       vCPUs and no GPU, so it renders at ~2 FPS. Frame rate
//                       and input latency measured here say nothing about a
//                       real machine — they are hardware numbers, not game
//                       numbers. Do not quote them as game performance.
//
// Known environment quirk: the page is not a foreground window, so pointer lock
// is refused and the game pauses itself on start, and the round clock advances
// in wall-clock slow motion (~2 FPS means 5 real seconds per game second). The
// helper below unpauses via the game's own state and waits on phase instead of
// on a fixed timeout.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

// The UI labels the tiers in Turkish; the CLI keeps the ids used by config.js
// and the rest of the tooling (matrix.mjs, sim.mjs).
const DIFFICULTY_LABELS = { easy: 'KOLAY', normal: 'NORMAL', hard: 'ZOR' };
const DIFFICULTY = flag('difficulty', 'normal');
const OUT = path.resolve(ROOT, flag('out', 'screenshots'));
const URL_UNDER_TEST = flag('url', `http://127.0.0.1:${process.env.PORT || 5173}/dist/SifirNokta.html`);
const WANT_JSON = args.includes('--json');
const VENDOR = path.join(ROOT, '.playwright');

if (!DIFFICULTY_LABELS[DIFFICULTY]) {
  console.error(`bilinmeyen zorluk "${DIFFICULTY}" — şunlardan biri: ${Object.keys(DIFFICULTY_LABELS).join(', ')}`);
  process.exit(2);
}

const results = [];
const errors = [];
const measurements = {};

function step(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!WANT_JSON) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  let pw;
  let chromium;
  try {
    pw = (await import('playwright-core')).chromium;
    chromium = (await import('@sparticuz/chromium')).default;
  } catch {
    console.error('playwright-core / @sparticuz/chromium kurulu değil.');
    console.error('Çalıştır: npm run visual:setup');
    process.exit(2);
  }

  // The bundled browser needs the AL2023 .so set on its search path; it is not
  // registered with ldconfig, so it must be injected.
  const libs = path.join(VENDOR, 'lib');
  process.env.LD_LIBRARY_PATH = libs + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');

  const browser = await pw.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  // The single-file build tries to register a service worker that is not there.
  // That 404 is expected; anything else is a real failure.
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/404/.test(t) && /script|service/i.test(t)) return;
    errors.push(`console: ${t}`);
  });

  if (!WANT_JSON) {
    console.log(`\nSIFIR NOKTA — görsel + hissiyat testi`);
    console.log(`  url: ${URL_UNDER_TEST}`);
    console.log(`  çıktı: ${OUT}\n`);
  }

  await page.goto(URL_UNDER_TEST, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1800);

  const clickByText = (re) => page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const el = [...document.querySelectorAll('button, [role="button"]')].find((b) => rx.test(b.textContent || ''));
    if (!el) return false;
    el.click();
    return true;
  }, re.source);

  // ── 1. WebGL ──────────────────────────────────────────────────────────────
  const gl = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { ok: false, why: 'canvas yok' };
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    if (!ctx) return { ok: false, why: 'webgl bağlamı yok' };
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      version: ctx.getParameter(ctx.VERSION),
      renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'bilinmiyor',
      size: `${c.width}x${c.height}`,
    };
  });
  step('WebGL bağlamı açıldı', gl.ok, gl.ok ? `${gl.version} · ${gl.size}` : gl.why);
  measurements.webgl = gl;
  assert(gl.ok, 'oyun WebGL bağlamı olmadan çalışamaz');

  // ── 2. menu ───────────────────────────────────────────────────────────────
  await page.screenshot({ path: path.join(OUT, '01-menu.png') });
  const menu = await page.evaluate(() => ({
    title: document.title,
    build: document.getElementById('build-tag')?.textContent?.trim(),
    screen: [...document.querySelectorAll('.screen')].find((s) => !s.classList.contains('hidden'))?.id,
  }));
  step('Ana menü açıldı', menu.screen === 'menu', `${menu.build}`);
  assert(menu.screen === 'menu', 'açılışta menü beklenir');

  // ── 3. difficulty ─────────────────────────────────────────────────────────
  assert(await clickByText(/^OYNA/), 'OYNA düğmesi yok');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '02-difficulty.png') });
  const diff = await page.evaluate(() =>
    [...document.querySelectorAll('.screen')].find((s) => !s.classList.contains('hidden'))?.id);
  step('Zorluk seçimi açıldı', diff === 'difficulty-screen', diff);

  // ── 4. match starts ───────────────────────────────────────────────────────
  assert(await clickByText(new RegExp(DIFFICULTY_LABELS[DIFFICULTY], 'i')), `${DIFFICULTY} düğmesi yok`);
  await page.waitForTimeout(350);
  assert(await clickByText(/MAÇI BAŞLAT/), 'MAÇI BAŞLAT düğmesi yok');
  await page.waitForTimeout(1200);

  // Pointer lock is refused in a headless page, so the game paused itself.
  // Unpause through the game's own state, then wait on the phase — never on a
  // fixed timeout, because a 2 FPS sandbox advances the round clock ~7x slower
  // than wall clock.
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (app && app.game) app.game.paused = false;
  });
  await clickByText(/DEVAM/);

  let phase = 'freeze';
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    phase = await page.evaluate(() => globalThis.__SIFIR_NOKTA__?.game?.match?.phase || 'none');
    if (phase === 'live') break;
  }
  step('Tur LIVE oldu', phase === 'live', `${(await page.evaluate(() => globalThis.__SIFIR_NOKTA__?.game?.match?.round)) ?? '?'}. raund`);

  await page.screenshot({ path: path.join(OUT, '03-ingame.png') });
  const live = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return {
      hud: !document.getElementById('hud')?.classList.contains('hidden'),
      menus: [...document.querySelectorAll('.screen')].filter((s) => !s.classList.contains('hidden')).map((s) => s.id),
      canvas: c ? `${c.width}x${c.height}` : null,
    };
  });
  step('HUD görünür, menü kapalı', live.hud && live.menus.length === 0, live.canvas);

  // ── 5. crosshair geometry ─────────────────────────────────────────────────
  // This answers the original complaint ("the crosshair is not where I shoot")
  // with numbers. Two independent checks:
  //   a) the reticle layer sits exactly at the viewport centre, and
  //   b) the four arms are symmetric about it — an off-centre arm would mean
  //      the drawn crosshair's own centre disagrees with its container.
  const reticle = await page.evaluate(() => {
    const layer = document.querySelector('.reticle-layer');
    if (!layer) return { error: '.reticle-layer yok' };
    const box = layer.getBoundingClientRect();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const arms = [...layer.querySelectorAll('.ch')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        cls: el.className,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2,
      };
    });
    // The crosshair's own origin: the arm offsets are symmetric around it, so
    // take the midpoint of opposite arms.
    const top = arms.find((a) => a.cls.includes('ch-top'));
    const bottom = arms.find((a) => a.cls.includes('ch-bottom'));
    const left = arms.find((a) => a.cls.includes('ch-left'));
    const right = arms.find((a) => a.cls.includes('ch-right'));
    const origin = {
      x: top && bottom ? (top.centerX + bottom.centerX) / 2 : null,
      y: left && right ? (left.centerY + right.centerY) / 2 : null,
    };
    // Vertical origin comes from the top/bottom arms, horizontal from left/right.
    const originY = top && bottom ? (top.centerY + bottom.centerY) / 2 : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, cx, cy },
      layer: { x: box.left, y: box.top },
      armCount: arms.length,
      armOrigin: { x: left && right ? (left.centerX + right.centerX) / 2 : null, y: originY },
      layerOffset: { dx: +(box.left - cx).toFixed(2), dy: +(box.top - cy).toFixed(2) },
      voidOrigin: origin.x === null ? null : { x: +origin.x.toFixed(2), y: origin.y === null ? null : +origin.y.toFixed(2) },
    };
  });

  if (reticle.error) {
    step('Nişangah merkezde', false, reticle.error);
  } else {
    const d = reticle.layerOffset;
    const centred = Math.abs(d.dx) <= 0.5 && Math.abs(d.dy) <= 0.5;
    step('Nişangah katmanı merkezde', centred, `sapma dx=${d.dx}px dy=${d.dy}px`);
    measurements.reticle = reticle;

    // The drawn crosshair's own centre must agree with the layer it lives in.
    const armDx = reticle.armOrigin.x === null ? null : +(reticle.armOrigin.x - reticle.viewport.cx).toFixed(2);
    const armDy = reticle.armOrigin.y === null ? null : +(reticle.armOrigin.y - reticle.viewport.cy).toFixed(2);
    const armsCentred = armDx !== null && armDy !== null && Math.abs(armDx) <= 0.5 && Math.abs(armDy) <= 0.5;
    step('Haç kolları simetrik', armsCentred, `merkez dx=${armDx}px dy=${armDy}px · ${reticle.armCount} kol`);
    if (!centred || !armsCentred) {
      await page.screenshot({ path: path.join(OUT, '05-reticle-offset.png') });
    }
  }

  // ── 6. input and transition curves ────────────────────────────────────────
  const feel = await page.evaluate(async () => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (!app || !app.game) return { error: 'window.__SIFIR_NOKTA__ yok' };
    const g = app.game;
    const canvas = document.querySelector('canvas');
    const fire = (dx, dy) => canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }));
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    // Mouse-look linearity: the same total movement, split differently, must
    // turn the camera by the same angle. A curve or an acceleration would make
    // 10x10 differ from 100x1.
    const y0 = g.pc.yaw;
    fire(100, 0); await frame();
    const one = g.pc.yaw - y0;
    const y1 = g.pc.yaw;
    for (let i = 0; i < 10; i++) fire(10, 0);
    await frame();
    const ten = g.pc.yaw - y1;

    // Pitch clamp.
    for (let i = 0; i < 200; i++) fire(0, 100);
    await frame();
    const pitchUp = +(g.pc.pitch * 180 / Math.PI).toFixed(1);
    for (let i = 0; i < 400; i++) fire(0, -100);
    await frame();
    const pitchDown = +(g.pc.pitch * 180 / Math.PI).toFixed(1);

    // ADS curve: must ramp rather than snap.
    g.input.ads = true; g.pc.ads = true;
    const ads = [];
    for (let i = 0; i < 20; i++) { await frame(); ads.push(+g.pc.adsBlend.toFixed(3)); }
    g.input.ads = false; g.pc.ads = false;

    return {
      look: { oneBy100: +one.toFixed(6), tenBy10: +ten.toFixed(6), linear: Math.abs(one - ten) < 1e-4 },
      pitchClampDeg: { up: pitchUp, down: pitchDown },
      adsCurve: ads,
      fov: g.fov,
    };
  });

  if (feel.error) {
    step('Girdi eğrileri ölçüldü', false, feel.error);
  } else {
    step('Fare bakışı doğrusal', feel.look.linear,
      `100×1 = ${feel.look.oneBy100} rad, 10×10 = ${feel.look.tenBy10} rad`);
    const clamped = Math.abs(feel.pitchClampDeg.up) <= 89.5 && Math.abs(feel.pitchClampDeg.down) <= 89.5;
    step('Bakış açısı sınırlı', clamped, `${feel.pitchClampDeg.up}° / ${feel.pitchClampDeg.down}°`);
    const ramps = feel.adsCurve.some((v) => v > 0.05 && v < 0.95);
    step('ADS eğrisi sıçramıyor', ramps, `ilk kare ${feel.adsCurve[0]}, son ${feel.adsCurve[feel.adsCurve.length - 1]}`);
    measurements.feel = feel;
  }

  // ── 7. crouch transition (real key events, so the game's own input path runs)
  await page.keyboard.down('ControlLeft');
  const crouch = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(140);
    crouch.push(await page.evaluate(() => +(globalThis.__SIFIR_NOKTA__?.game?.player?.crouch ?? -1).toFixed(3)));
  }
  await page.keyboard.up('ControlLeft');
  const crouched = crouch.some((v) => v > 0.9);
  step('Çömelme çalışıyor', crouched, `eğri ${crouch[0]} → ${crouch[crouch.length - 1]}`);
  measurements.crouchCurve = crouch;

  // ── 8. F3 overlay shows live simulation data ──────────────────────────────
  await page.keyboard.press('F3');
  await page.waitForTimeout(700);
  const dbg1 = await page.evaluate(() => document.getElementById('debug-overlay')?.textContent || '');
  await page.waitForTimeout(1400);
  const dbg2 = await page.evaluate(() => document.getElementById('debug-overlay')?.textContent || '');
  await page.screenshot({ path: path.join(OUT, '04-debug-overlay.png') });
  step('F3 katmanı canlı', dbg1.length > 0 && dbg1 !== dbg2, dbg1 ? `${dbg1.split('\n').length} satır` : 'boş');
  if (dbg1) writeFileSync(path.join(OUT, 'debug-overlay.txt'), `${dbg1}\n\n--- 1.4s sonra ---\n\n${dbg2}`, 'utf8');

  // ── 9. exposure ───────────────────────────────────────────────────────────
  // The scene used to render almost black: measured, the median luminance of a
  // live frame was 21/255 and the brightest pixel in the whole viewport was
  // 47/255. Three separate causes (albedo, three.js physical light units, a
  // missing sky) each contributed, and none of them was visible as an error —
  // the game simply looked broken. These thresholds are deliberately loose
  // bands, not a target: they catch "unlit" and "blown out", not "a bit darker
  // than I would like". Reading the framebuffer directly rather than the
  // screenshot means no PNG decoding and no colour-management surprises.
  // Measure at a *defined* orientation. Without this the number depends on
  // where the previous step left the camera — the pitch-clamp step parks it at
  // +88 degrees, i.e. staring at the sky, which made the same scene read 28/255
  // instead of 53/255. A brightness check that changes answer with the camera
  // is not a check.
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (app?.game?.pc) {
      app.game.pc.pitch = 0;
      app.game.pc.yaw = 0;
    }
  });
  await page.waitForTimeout(600);

  const frame = await page.evaluate(() => {
    const sc = globalThis.__SIFIR_NOKTA__?.scene;
    if (!sc || !sc.renderer) return { error: 'sahne yok' };
    const gl = sc.renderer.getContext();
    // Render exactly once and read exactly once, straight after.
    //
    // The context is created without preserveDrawingBuffer, so the drawing
    // buffer is cleared after the compositor takes its copy. A readPixels that
    // does not follow a render of our own returns all zeros — which is exactly
    // what happened here first: the screenshot looked correct while the
    // measurement reported a median of 6/255. Any second render before the
    // read would be fine; two reads around one render is not.
    sc.renderer.render(sc.scene, sc.camera);
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = (i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    const all = [];
    for (let i = 0; i < w * h; i++) all.push(lum(i));
    all.sort((a, b) => a - b);
    const q = (x) => Math.round(all[Math.min(all.length - 1, Math.floor(all.length * x))]);
    // The gameplay frame, excluding the HUD bands, so UI text cannot carry the
    // measurement on its own.
    const centre = [];
    for (let y = Math.floor(h * 0.3); y < Math.floor(h * 0.7); y += 2) {
      for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x += 2) centre.push(lum(y * w + x));
    }
    centre.sort((a, b) => a - b);
    return {
      p10: q(0.1),
      p50: q(0.5),
      p90: q(0.9),
      p99: q(0.99),
      max: q(0.9999),
      blackFraction: +(all.filter((v) => v < 8).length / all.length).toFixed(4),
      centreMedian: Math.round(centre[Math.floor(centre.length / 2)]),
    };
  });
  measurements.exposure = frame;
  if (frame.error) {
    step('Sahne pozlaması', false, frame.error);
  } else {
    // Reference for the bands below: before the fix p50 was 21 and max was 47.
    step('Sahne yeterince aydınlık', frame.p50 >= 38, `p50 ${frame.p50}/255 (önce 21)`);
    step('Sahne patlamıyor', frame.max <= 250 && frame.p90 <= 150, `max ${frame.max}, p90 ${frame.p90}`);
    step('Siyah alan yok', frame.blackFraction < 0.02, `%${(frame.blackFraction * 100).toFixed(1)} saf siyah`);
    step('Ortada görünür bir sahne var', frame.centreMedian >= 30, `merkez medyanı ${frame.centreMedian}`);
    // Not: these are brightness bands, not a claim about art direction. Whether
    // the scene *looks* good is a judgement this tool cannot make.
  }

  // ── 10. sky ───────────────────────────────────────────────────────────────
  // Separate from the exposure check because it fails differently. The map has
  // no ceiling, so a large part of every upward view is sky, and the sky is a
  // hand-written ShaderMaterial — the one material three.js does *not* apply
  // tone mapping or the sRGB conversion to. When that was missing the sky
  // rendered at 7/255 while everything else looked correct, which no
  // overall-brightness check can see at a level camera angle.
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (app?.game?.pc) app.game.pc.pitch = 0.72; // ~41 degrees up
  });
  await page.waitForTimeout(600);
  const sky = await page.evaluate(() => {
    const sc = globalThis.__SIFIR_NOKTA__?.scene;
    if (!sc || !sc.renderer) return { error: 'sahne yok' };
    const gl = sc.renderer.getContext();
    sc.renderer.render(sc.scene, sc.camera);
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Upper middle band: looking up, this is dome, not geometry.
    const band = [];
    for (let y = 0; y < Math.floor(h * 0.25); y += 2) {
      for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x += 2) {
        const i = y * w + x;
        band.push(0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]);
      }
    }
    band.sort((a, b) => a - b);
    return { median: Math.round(band[Math.floor(band.length / 2)]), max: Math.round(band[band.length - 1]) };
  });
  measurements.sky = sky;
  if (sky.error) {
    step('Gökyüzü', false, sky.error);
  } else {
    // Measured: 52/255 with the colour-space fix, 25/255 without it. The band
    // is 52 because it is not pure sky — walls and the tower poke into the top
    // quarter of the frame. The threshold sits between the two, well clear of
    // both, so the check is about the fix and not about the exact camera angle.
    step('Gökyüzü aydınlık (renk uzayı doğru)', sky.median >= 35, `medyan ${sky.median}/255 (düzeltmesiz 25)`);
    step('Gökyüzü gradyanlı, düz siyah değil', sky.max - sky.median >= 4, `medyan ${sky.median}, max ${sky.max}`);
  }
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (app?.game?.pc) app.game.pc.pitch = 0;
  });

  // ── 11. tactical map ──────────────────────────────────────────────────────
  // Two things can go wrong with a minimap and neither is a crash: it can draw
  // nothing at all, or it can point the wrong way. Both are checked here.
  const map = await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    const canvas = document.getElementById('minimap');
    if (!canvas || !app?.game) return { error: 'minimap yok' };
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Count distinct non-background pixels: a blank canvas returns a single
    // colour and the map would be "present" but useless.
    let nonEmpty = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 8 && (data[i] + data[i + 1] + data[i + 2]) > 90) nonEmpty += 1;
    }
    return {
      w: canvas.width,
      h: canvas.height,
      fill: +(nonEmpty / (canvas.width * canvas.height)).toFixed(3),
      lane: document.getElementById('minimap-lane')?.textContent || '',
    };
  });
  measurements.map = map;
  if (map.error) {
    step('Minimap', false, map.error);
  } else {
    step('Minimap çiziyor', map.fill > 0.02, `piksel dolu ${(map.fill * 100).toFixed(1)}%`);
    step('Konum etiketi dolu', map.lane.length > 3, map.lane);
  }

  // Compass: the letter under the needle must match the heading at all four
  // cardinals. This is the check that would catch an inverted or offset strip —
  // the kind of bug that is invisible until you are lost.
  const compass = [];
  for (const [, yaw] of [['K', 0], ['D', Math.PI / 2], ['G', Math.PI], ['B', -Math.PI / 2]]) {
    await page.evaluate((y) => {
      const app = globalThis.__SIFIR_NOKTA__;
      if (app?.game?.pc) app.game.pc.yaw = y;
    }, yaw);
    // Wait for the HUD to catch up, don't sleep a fixed amount. This sandbox
    // renders at ~2 FPS, so a 320 ms sleep can land before the frame that
    // applies the new heading — which made this check flaky: it passed in
    // isolation and failed intermittently inside the full run. Polling on the
    // actual condition is the only honest wait here.
    const expectedDeg = Math.round((((yaw * 180) / Math.PI) + 360) % 360);
    let settled = true;
    try {
      await page.waitForFunction(
        (want) => {
          const text = document.getElementById('compass-text')?.textContent || '';
          const m = text.match(/(-?\d+)°/);
          if (!m) return false;
          const deg = ((Number(m[1]) % 360) + 360) % 360;
          return Math.abs(deg - want) < 3;
        },
        expectedDeg,
        { timeout: 12000 },
      );
    } catch {
      // The heading never arrived. Record it as a failed step rather than
      // letting the throw abort the whole run: a broken compass should read as
      // "the compass is wrong", not as "the test crashed", and the remaining
      // checks (console, summary) still deserve to run.
      settled = false;
    }
    if (!settled) {
      const actual = await page.evaluate(() => document.getElementById('compass-text')?.textContent || '');
      compass.push({ shown: `(açı gelmedi: ${actual})`, offset: -1 });
      continue;
    }
    compass.push(await page.evaluate(() => {
      const wrap = document.querySelector('.compass-wrap');
      const strip = document.getElementById('compass-strip');
      if (!wrap || !strip) return { error: 'pusula yok' };
      const box = wrap.getBoundingClientRect();
      const centre = box.left + box.width / 2;
      let best = null;
      let bestDelta = Infinity;
      for (const tick of strip.children) {
        const r = tick.getBoundingClientRect();
        const delta = Math.abs(r.left + r.width / 2 - centre);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = tick.textContent;
        }
      }
      return { shown: best, offset: +bestDelta.toFixed(1) };
    }));
  }
  measurements.compass = compass;
  const expected = ['K', 'D', 'G', 'B'];
  const shown = compass.map((c) => c.shown);
  const compassOk = shown.every((v, i) => v === expected[i]);
  step(
    'Pusula dört yönde doğru',
    compassOk,
    compassOk ? shown.join(' / ') : `beklenen ${expected.join(' / ')}, görünen ${shown.join(' / ')}`,
  );
  await page.evaluate(() => {
    const app = globalThis.__SIFIR_NOKTA__;
    if (app?.game?.pc) app.game.pc.yaw = 0;
  });

  // ── 12. career screen ─────────────────────────────────────────────────────
  // Two failure modes worth catching: the screen does not render at all, and a
  // corrupt stored career takes the whole screen down instead of degrading.
  await page.evaluate(() => {
    // A hand-edited file with impossible numbers, a broken history entry and a
    // NaN. If sanitisation is doing its job this renders cleanly.
    const now = new Date().toISOString();
    window.localStorage.setItem('sifirnokta.career.v1', JSON.stringify({
      matches: 4, wins: 99, losses: -3, kills: 'çok', deaths: 20,
      shots: 400, hits: 9999, headshots: NaN, playtimeSeconds: 900,
      byDifficulty: { hard: { matches: 2, wins: 5, kills: 10, deaths: 8, shots: 100, hits: 40 } },
      history: [null, 'çöp', { at: now, difficulty: 'hard', win: true, scoreA: 3, scoreB: 1, kills: 9, deaths: 4, shots: 80, hits: 40, kd: 99 }],
    }));
  });
  await page.evaluate(() => {
    const before = document.getElementById('menu');
    const btn = [...before.querySelectorAll('button')].find((b) => /KARİYER/.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(500);
  const career = await page.evaluate(() => {
    const screen = document.getElementById('career-screen');
    const visible = screen && !screen.classList.contains('hidden');
    const highlights = [...screen.querySelectorAll('.career-highlight b')].map((b) => b.textContent);
    // A NaN or Infinity leaking through sanitisation would render as these.
    const text = screen.textContent || '';
    return {
      visible,
      highlights,
      rows: screen.querySelectorAll('.career-row').length,
      winRate: highlights[0],
      hasBadValue: /NaN|Infinity|undefined/.test(text),
    };
  });
  measurements.career = career;
  step('Kariyer ekranı açılıyor', career.visible, career.highlights.join(' / '));
  step(
    'Bozuk kariyer dosyası çökertmiyor',
    career.visible && !career.hasBadValue,
    career.hasBadValue ? 'ekranda NaN/Infinity/undefined var' : 'temiz',
  );
  step(
    'Galibiyet oranı %100 ü geçmiyor',
    career.winRate === '100%',
    `gösterilen ${career.winRate} (dosyada 4 maçta 99 galibiyet yazıyordu)`,
  );
  await page.evaluate(() => {
    window.localStorage.removeItem('sifirnokta.career.v1');
    const screen = document.getElementById('career-screen');
    const back = [...screen.querySelectorAll('button')].find((b) => /GERİ/.test(b.textContent || ''));
    if (back) back.click();
  });
  await page.waitForTimeout(300);

  // ── 13. console ───────────────────────────────────────────────────────────
  step('Konsol hatası yok', errors.length === 0, errors.length ? errors.slice(0, 2).join(' | ') : 'temiz');

  await browser.close();

  if (WANT_JSON) {
    console.log(JSON.stringify({ results, measurements, errors }, null, 2));
  } else {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n  ${results.length - failed.length}/${results.length} adım geçti → ${path.relative(ROOT, OUT)}/\n`);
    if (measurements.feel) {
      console.log('  Not: bu ortamda ~2 FPS (2 vCPU, GPU yok). Kare hızı ve girdi gecikmesi');
      console.log('  burada ölçülmez — ölçülse de donanımı anlatır, oyunu değil.\n');
    }
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error('\nGörsel test başarısız:', err.message, '\n');
  process.exit(1);
});
