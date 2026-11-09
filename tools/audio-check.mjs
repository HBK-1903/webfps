#!/usr/bin/env node
// Renders every synthesized sound offline and measures it, so the audio can be
// checked without a human listener and without leaving the sandbox.
//
//   node tools/audio-check.mjs [--json] [--out DIR]
//
// ── Why this exists ─────────────────────────────────────────────────────────
// "It sounds fine" is not a test. This tool renders each sound through an
// OfflineAudioContext in real Chromium and reports numbers that correspond to
// things an ear notices:
//
//   peak      the loudest sample, in dBFS — is it audible at all, or clipping?
//   rms       average energy, in dBFS — how present it is over its length
//   length    when the tail drops below -60 dBFS
//   centroid  spectral centre of mass, in Hz — "bright" vs "dull". A rifle
//             crack has to sit far above a footstep's thud or they read as the
//             same event.
//   flatness  Wiener flatness, 0 = tonal, 1 = noise. Mechanical sounds (metal,
//             magazines) must be *less* flat than gunfire, or they sound like
//             hiss rather than parts moving.
//
// The checks below are therefore comparative: no sound may be silent, no sound
// may clip, the gait ladder must be walk > sprint-in-loudness only where it
// should be, and the spectral ordering must hold. Those are the properties a
// regression would break first.
//
// Requires the same Chromium as tools/visual.mjs: `npm run visual:setup`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const WANT_JSON = args.includes('--json');
const outIdx = args.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : 'screenshots');
const VENDOR = path.join(ROOT, '.playwright');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!WANT_JSON) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Sounds the game actually fires, with the minimum an ear would accept.
// `minLength` is in seconds; a gunshot shorter than 40 ms reads as a click.
const EXPECTED = [
  { name: 'shot_rifle', minLength: 0.1 },
  { name: 'shot_pistol', minLength: 0.07 },
  { name: 'tail', minLength: 0.15 },
  { name: 'hit', minLength: 0.02 },
  { name: 'headshot', minLength: 0.05 },
  { name: 'kill', minLength: 0.1 },
  { name: 'hurt', minLength: 0.15 },
  { name: 'reload_start', minLength: 0.04 },
  { name: 'reload_mag_out', minLength: 0.08 },
  { name: 'reload_mag_in', minLength: 0.06 },
  { name: 'reload_end', minLength: 0.05 },
  { name: 'enemy_reload', minLength: 0.06 },
  { name: 'empty', minLength: 0.02 },
  { name: 'switch', minLength: 0.04 },
  { name: 'step_walk', minLength: 0.05 },
  { name: 'step_sprint', minLength: 0.05 },
  { name: 'step_crouch', minLength: 0.04 },
  { name: 'whizz', minLength: 0.1 },
  { name: 'go', minLength: 0.2 },
  { name: 'round_win', minLength: 0.25 },
  { name: 'round_loss', minLength: 0.25 },
  { name: 'match_win', minLength: 0.5 },
  { name: 'match_loss', minLength: 0.5 },
  { name: 'ui', minLength: 0.02 },
  { name: 'death', minLength: 0.25 },
];

async function main() {
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
  // Same browser as tools/visual.mjs, and the same .so injection it needs (the
  // bundled AL2023 libraries are not registered with ldconfig).
  const libs = path.join(VENDOR, 'lib');
  process.env.LD_LIBRARY_PATH = libs + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');

  const browser = await pw.launch({
    executablePath: await chromium.executablePath(),
    args: [...chromium.args, '--autoplay-policy=no-user-gesture-required'],
    headless: true,
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  // A blank page is enough: audio.js has no imports, so its source can be
  // injected straight in as a module. Importing it by file:// URL does not work
  // — the page origin is about:blank and the fetch is blocked.
  await page.goto('about:blank');
  const source = readFileSync(path.join(ROOT, 'src/ui/audio.js'), 'utf8');
  await page.addScriptTag({
    type: 'module',
    content: `${source}\nwindow.__audioModuleReady = Promise.resolve({ createAudio, soundPlacement });`,
  });
  await page.waitForFunction(() => window.__audioModuleReady !== undefined, null, { timeout: 15000 });

  const measured = await page.evaluate(async (names) => {
    const mod = await window.__audioModuleReady;
    // Every call in `createAudio` goes through `ensure()`, which wants a real
    // AudioContext and `window`. Point those at an offline context so the same
    // code renders into a buffer we can measure.
    const RATE = 44100;
    const LENGTH = 3;
    const stats = {};

    function analyse(buf) {
      const data = buf.getChannelData(0);
      const n = data.length;
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
        sum += data[i] * data[i];
      }
      const rmsAll = Math.sqrt(sum / n);
      // Last sample within -40 dB of this sound's own peak. An absolute floor
      // (-60 dBFS) makes a deliberately quiet sound like a crouch step look
      // 4 ms long, which says nothing about whether it is audible.
      // Relative to the peak so quiet sounds keep their real length, but with
      // an absolute floor so a 1.1 s reverb tail at -75 dBFS does not count as
      // "still sounding" and inflate every length to the same number.
      const floor = Math.max(3e-4, peak * 0.01);
      let end = n;
      while (end > 0 && Math.abs(data[end - 1]) < floor) end--;
      // RMS over the sounding part only. Averaging across three seconds of
      // silence makes every short sound read ~20 dB quieter than it is and
      // destroys the loudness comparisons, which are the point of the tool.
      let sumActive = 0;
      for (let i = 0; i < end; i++) sumActive += data[i] * data[i];
      const rms = end > 0 ? Math.sqrt(sumActive / end) : rmsAll;
      // Spectral centroid + flatness from a plain DFT over a 2048-sample window
      // taken near the peak, which is where the character of a transient lives.
      let peakIndex = 0;
      for (let i = 0; i < n; i++) if (Math.abs(data[i]) > Math.abs(data[peakIndex])) peakIndex = i;
      const size = 1024;
      // Centroid + flatness over one window. Called twice (near the onset and
      // later in the sound) so a downward sweep can be *proven* rather than
      // assumed — that sweep is what makes a near miss read as passing you.
      function spectrum(startAt) {
        const start = Math.max(0, Math.min(n - size, startAt));
        let num = 0;
        let den = 0;
        let logSum = 0;
        let magSum = 0;
        for (let k = 1; k < size / 2; k++) {
          let re = 0;
          let im = 0;
          for (let i = 0; i < size; i++) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
            const ang = (2 * Math.PI * k * i) / size;
            const v = data[start + i] * w;
            re += v * Math.cos(ang);
            im -= v * Math.sin(ang);
          }
          const mag = Math.sqrt(re * re + im * im);
          num += mag * ((k * RATE) / size);
          den += mag;
          magSum += mag;
          logSum += Math.log(mag + 1e-12);
        }
        const bins = size / 2 - 1;
        return {
          centroid: den > 0 ? num / den : 0,
          flatness: Math.exp(logSum / bins) / (magSum / bins + 1e-12),
        };
      }
      const onset = spectrum(peakIndex - size / 4);
      // Fixed-offset window, 60 ms after the onset. A window chosen as a
      // fraction of the sound's length lands in the reverb tail for anything
      // short, and the tail is broadband — which made a flattened sweep
      // measure the same as a real one. A fixed offset stays inside the sound.
      const later = spectrum(peakIndex + Math.floor(RATE * 0.06) - size / 4);
      const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
      return {
        peakDb: Number(db(peak).toFixed(2)),
        rmsDb: Number(db(rms).toFixed(2)),
        lengthS: Number((end / RATE).toFixed(3)),
        centroidHz: Math.round(onset.centroid),
        lateCentroidHz: Math.round(later.centroid),
        flatness: Number(onset.flatness.toFixed(3)),
      };
    }

    // The audio module reads `window.AudioContext`; swap it per render so each
    // sound gets a fresh offline graph.
    const RealAC = window.AudioContext;
    // Every sound is randomized per trigger (see `jit`), which is what stops
    // automatic fire sounding like a loop — but it also means one render is a
    // sample, not a measurement. Five renders and take the mean, otherwise two
    // genuinely different sounds can compare as equal by luck, and the checks
    // below stop meaning anything.
    const TRIALS = 5;
    for (const name of names) {
      const runs = [];
      for (let t = 0; t < TRIALS; t++) {
        let captured = null;
        window.AudioContext = function () {
          const c = new OfflineAudioContext(1, RATE * LENGTH, RATE);
          captured = c;
          return c;
        };
        const audio = mod.createAudio();
        audio.setVolume(1);
        audio.play(name, {});
        window.AudioContext = RealAC;
        if (!captured) {
          runs.length = 0;
          break;
        }
        // `createBufferSource.start(t, offset)` is fine offline; the graph is
        // rendered to completion so every scheduled node is included.
        runs.push(analyse(await captured.startRendering()));
      }
      if (runs.length === 0) {
        stats[name] = { error: 'no context created' };
        continue;
      }
      const mean = (key) => runs.reduce((a, r) => a + r[key], 0) / runs.length;
      stats[name] = {
        // Mean peak in dB: dB is logarithmic, so average the linear values of
        // the loudest sample rather than the dB numbers themselves.
        peakDb: Number((20 * Math.log10(runs.reduce((a, r) => a + Math.pow(10, r.peakDb / 20), 0) / runs.length)).toFixed(2)),
        peakSpreadDb: Number((Math.max(...runs.map((r) => r.peakDb)) - Math.min(...runs.map((r) => r.peakDb))).toFixed(2)),
        rmsDb: Number(mean('rmsDb').toFixed(2)),
        lengthS: Number(mean('lengthS').toFixed(3)),
        centroidHz: Math.round(mean('centroidHz')),
        lateCentroidHz: Math.round(mean('lateCentroidHz')),
        flatness: Number(mean('flatness').toFixed(3)),
      };
    }
    return stats;
  }, EXPECTED.map((e) => e.name));

  const rows = [];
  for (const { name, minLength } of EXPECTED) {
    const m = measured[name];
    if (!m || m.error) {
      check(`${name} renders`, false, m ? m.error : 'ölçüm yok');
      continue;
    }
    rows.push({ name, ...m });
    // Audible but not clipping.
    //   Floor -55 dBFS: about 40 dB above the 16-bit noise floor, which is
    //   plainly audible on any output, while still allowing a deliberately
    //   quiet sound (a crouch step) to be quiet. This was -42 first, which is
    //   an arbitrary "feels loud enough" number and flagged the stealth step.
    //   Ceiling -1 dBFS: WebAudio's limiter would otherwise soften exactly the
    //   transients that make a shot read as a shot.
    check(`${name} audible`, m.peakDb > -55, `peak ${m.peakDb} dBFS`);
    check(`${name} no clip`, m.peakDb < -1, `peak ${m.peakDb} dBFS`);
    check(`${name} long enough`, m.lengthS >= minLength, `${m.lengthS}s (min ${minLength})`);
  }

  // --- comparative checks: the ones that catch "everything sounds the same" --
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  // Gait loudness is compared on *peak*, not RMS. A footstep is a transient:
  // the ear judges it by its attack, and RMS over the whole event punishes the
  // sprint step simply for ringing out longer, which is not a loudness cue.
  if (by.step_walk && by.step_sprint) {
    check(
      'sprint is at least 3 dB louder than walk',
      by.step_sprint.peakDb - by.step_walk.peakDb >= 3,
      `sprint ${by.step_sprint.peakDb} vs walk ${by.step_walk.peakDb} dBFS peak`,
    );
  }
  if (by.step_walk && by.step_crouch) {
    // Two-sided on purpose. Too loud and crouching stops being stealthy; too
    // quiet and it reads as a bug (the first version was inaudible). The ear's
    // useful stealth band is roughly 8-16 dB under a normal step.
    const delta = by.step_walk.peakDb - by.step_crouch.peakDb;
    check(
      'crouch sits 6-20 dB under walk',
      delta >= 6 && delta <= 20,
      `${delta.toFixed(1)} dB (crouch ${by.step_crouch.peakDb} vs walk ${by.step_walk.peakDb})`,
    );
  }
  if (by.shot_rifle && by.step_walk) {
    check(
      'a shot is far brighter than a footstep',
      by.shot_rifle.centroidHz > by.step_walk.centroidHz * 2,
      `rifle ${by.shot_rifle.centroidHz} Hz vs step ${by.step_walk.centroidHz} Hz`,
    );
  }
  if (by.shot_rifle && by.shot_pistol) {
    check(
      'rifle and pistol are not the same sound',
      Math.abs(by.shot_rifle.centroidHz - by.shot_pistol.centroidHz) > 150,
      `rifle ${by.shot_rifle.centroidHz} Hz vs pistol ${by.shot_pistol.centroidHz} Hz`,
    );
  }
  if (by.reload_mag_in && by.reload_mag_out) {
    check(
      'magazine in and out differ',
      Math.abs(by.reload_mag_in.centroidHz - by.reload_mag_out.centroidHz) > 100,
      `in ${by.reload_mag_in.centroidHz} Hz vs out ${by.reload_mag_out.centroidHz} Hz`,
    );
  }
  if (by.whizz) {
    // The defining property of a near miss is direction *of change*: the
    // apparent frequency has to fall as the round goes by. A static hiss at
    // the right volume fails this, and that is exactly how "generic" sounds
    // hide — loud enough, but with no motion in them.
    check(
      'a near miss sweeps downward',
      by.whizz.lateCentroidHz < by.whizz.centroidHz * 0.6,
      `${by.whizz.centroidHz} Hz -> ${by.whizz.lateCentroidHz} Hz`,
    );
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();

  mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, 'audio-report.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows, results }, null, 2));

  if (WANT_JSON) {
    console.log(JSON.stringify({ rows, results }, null, 2));
  } else {
    if (rows.length) {
      console.log('\n  ses                 peak      rms      uzunluk   merkez    sonra     flatness');
      for (const r of rows) {
        console.log(
          `  ${r.name.padEnd(18)} ${String(r.peakDb).padStart(6)}dB ${String(r.rmsDb).padStart(6)}dB ${String(r.lengthS).padStart(6)}s ${String(r.centroidHz).padStart(7)}Hz ${String(r.lateCentroidHz).padStart(6)}Hz ${String(r.flatness).padStart(6)}`,
        );
      }
      console.log('');
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`  ${results.length - failed}/${results.length} kontrol geçti`);
    console.log(`  rapor: ${path.relative(ROOT, jsonPath)}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
