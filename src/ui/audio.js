// Procedural audio: every sound in the game is synthesized here, sample by
// sample, with WebAudio. There are no audio files in the repository and none
// are downloaded at runtime — adding a sound means writing code.
//
// The design is deliberately *layered* rather than "a noise burst plus a beep",
// because that is what made the first pass sound generic: one filtered noise
// hit per weapon means every gun is the same gun at a different volume. A real
// gunshot is at least four things at once:
//
//   1. crack    - the supersonic snap, broadband, ~20 ms
//   2. body     - the chest thump, low band, ~60 ms
//   3. action   - the mechanical cycle of the weapon, inharmonic, ~10 ms
//   4. tail     - the room answering back, 200-400 ms, mostly reverberant
//
// Each of those is built from primitives below (noiseThrough, ping, metal,
// thump) and every one of them is randomized a little per trigger, so a burst
// of automatic fire is never the same sample twice. Unity through structure,
// variety through jitter: that is the whole trick.

/**
 * Where a world-space sound sits relative to the listener.
 *
 * `yaw` is the camera's yaw in the game's convention: 0 looks down -z, and
 * positive yaw turns to the right (see `anglesTo` in combat.js). Returns:
 *   pan       -1 (hard left) .. +1 (hard right)
 *   distance  metres, for the volume falloff
 *   behind    true when the source is more than 90 degrees off the crosshair,
 *             so callers can muffle it instead of localising it
 *
 * Deliberately a pure function of geometry: no audio context, no DOM. The
 * spatialisation is the part most likely to be subtly wrong (an inverted sign
 * puts every enemy on the wrong side), so it is the part that gets tested.
 */
export function soundPlacement(listener, source, yaw) {
  const dx = source.x - listener.x;
  const dz = source.z - listener.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) return { pan: 0, distance: 0, behind: false };
  // Angle of the source in the listener's frame. The camera looks along
  // (sin yaw, -cos yaw); the right-hand vector is (cos yaw, sin yaw).
  const rel = Math.atan2(dx, -dz) - yaw;
  // +pi/2 is dead right, -pi/2 dead left, +-pi is directly behind.
  const pan = Math.sin(rel);
  const behind = Math.abs(rel) > Math.PI / 2;
  return { pan: Math.max(-1, Math.min(1, pan)), distance, behind };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Multiplicative jitter, the cheapest way to stop a sound sounding looped. */
const jit = (v, amount) => v * (1 + (Math.random() * 2 - 1) * amount);

export function createAudio() {
  let ctx = null;
  let master = null;
  let dry = null;
  let wet = null;
  let reverb = null;
  let noiseCache = null;
  let muted = false;
  let volume = 0.55;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = volume;
    // Slight compression keeps automatic fire from clipping on laptop
    // speakers, and makes distant sounds audible without raising the mix.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 14;
    comp.ratio.value = 7;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    master.connect(comp).connect(ctx.destination);

    // Two parallel buses: dry (direct) and wet (through the room). Every world
    // sound feeds both, in a proportion that grows with distance. That single
    // mechanic is what makes an enemy 20 m away sound *far* instead of merely
    // quiet, which volume alone never achieves.
    dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);

    wet = ctx.createGain();
    wet.gain.value = 0.9;
    reverb = ctx.createConvolver();
    reverb.buffer = buildImpulse(1.15, 2.8);
    wet.connect(reverb).connect(master);

    return ctx;
  }

  /**
   * A small concrete room, generated rather than recorded.
   *
   * A convolver with decaying noise gives a believable tail; the one-pole
   * filter inside the loop makes the tail darken as it dies, which is what real
   * rooms do (high frequencies are absorbed first). The handful of discrete
   * taps are early reflections off the nearby walls — without them the tail
   * sounds like a synth pad instead of a space.
   */
  function buildImpulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    const taps = [[7, 0.55], [13, 0.38], [23, 0.3], [37, 0.22], [53, 0.16], [71, 0.1]];
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = Math.random() * 2 - 1;
        lp = lp * 0.62 + n * 0.38;
        data[i] = lp * Math.pow(1 - t, decay) * 0.6;
      }
      for (const [ms, g] of taps) {
        const i = Math.floor((rate * ms) / 1000) + (ch ? 3 : 0);
        if (i < len) data[i] += (ch ? -1 : 1) * g * 0.5;
      }
    }
    return buf;
  }

  /**
   * One shared two-second noise buffer, read from a random offset each time.
   * Allocating a fresh buffer per shot would garbage-collect mid-firefight and
   * audible-dropout exactly when it matters; this never allocates again.
   */
  function noiseBuffer() {
    if (noiseCache) return noiseCache;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // A touch of spectral tilt: pure white noise reads as "hiss", while a
      // gently low-passed source reads as "air moving".
      lp = lp * 0.4 + white * 0.6;
      data[i] = white * 0.65 + lp * 0.35;
    }
    noiseCache = buf;
    return buf;
  }

  // Cap how many voices one 50 ms window may spawn. A 5v5 firefight can push a
  // dozen sounds into a single frame; without this the graph collapses and
  // everything stutters instead of sounding busy.
  let budgetWindow = 0;
  let budgetCount = 0;
  function allow() {
    const now = ctx.currentTime;
    if (now - budgetWindow > 0.05) {
      budgetWindow = now;
      budgetCount = 0;
    }
    budgetCount += 1;
    return budgetCount <= 10;
  }

  /**
   * The output chain for one voice: optional stereo placement, air absorption
   * as a low-pass whose cutoff falls with distance, then a dry/wet split.
   */
  function bus(pan, distance) {
    const node = ctx.createGain();
    node.gain.value = 1;
    let tail = node;
    if (typeof pan === 'number') {
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) {
        p.pan.value = clamp(pan, -1, 1);
        tail.connect(p);
        tail = p;
      }
    }
    if (distance > 0) {
      // Air eats the highs long before it eats the lows — this is why distant
      // gunfire is a thud and close gunfire is a crack, at the same volume.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 / (1 + distance / 5.5), 700, 16000);
      lp.Q.value = 0.4;
      tail.connect(lp);
      tail = lp;
    }
    tail.connect(dry);
    const send = ctx.createGain();
    send.gain.value = clamp(0.06 + distance / 60, 0.06, 0.85);
    tail.connect(send).connect(wet);
    return node;
  }

  /** Filtered noise burst, the workhorse for every impact and every footstep. */
  function noiseThrough(out, { duration, gain, freq, to = null, type = 'bandpass', q = 1, delay = 0, attack = 0.002, deg = 0.9 }) {
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    src.loop = true;
    // Random start offset so repeated triggers are not bit-identical.
    src.start(t0, Math.random() * 1.9);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t0);
    if (to) filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + duration * deg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(g).connect(out);
    src.stop(t0 + duration + 0.02);
  }

  /** A pitched body: the "thump" under a gunshot, or the weight of a boot. */
  function thump(out, { freq, to, duration, gain, delay = 0, type = 'sine', attack = 0.003 }) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /**
   * Inharmonic partials = struck metal.
   *
   * The partials are deliberately *not* integer multiples of the base: a bell
   * or a steel plate has inharmonic modes, and using 1, 2, 3 would give a
   * musical chord instead of a clack. This is the single biggest reason the
   * mechanical sounds read as "gun" rather than "beep".
   */
  function metal(out, { base, gain, duration, delay = 0, ratios = [1, 2.32, 3.71, 5.13] }) {
    const t0 = ctx.currentTime + delay;
    ratios.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = base * ratio;
      const decay = duration / (1 + i * 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(Math.max(0.0002, gain / (1 + i * 0.8)), t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + decay + 0.02);
    });
  }

  /**
   * A rifle round leaving the barrel.
   * Registered as four layers (crack, body, action, tail) so it can be rebuilt
   * at a distance by dropping the top layers — see `play` for `tail`.
   */
  function rifle(out, { gain, near }) {
    const v = jit(1, 0.12);
    noiseThrough(out, { duration: 0.05, gain: 0.32 * gain * v, freq: jit(2600, 0.15), type: 'highpass', q: 0.5, attack: 0.001 });
    noiseThrough(out, { duration: 0.11, gain: 0.46 * gain, freq: jit(760, 0.12), to: 170, type: 'bandpass', q: 0.9 });
    thump(out, { freq: jit(132, 0.1), to: 42, duration: 0.15, gain: 0.44 * gain, type: 'triangle' });
    metal(out, { base: jit(2100, 0.1), gain: 0.08 * gain, duration: 0.05, delay: 0.012 });
    if (near) noiseThrough(out, { duration: 0.42, gain: 0.13 * gain, freq: 420, to: 120, type: 'lowpass', q: 0.5, deg: 0.5 });
  }

  function pistol(out, { gain, near }) {
    const v = jit(1, 0.12);
    noiseThrough(out, { duration: 0.03, gain: 0.46 * gain * v, freq: jit(7800, 0.15), type: 'highpass', q: 0.5, attack: 0.001 });
    noiseThrough(out, { duration: 0.05, gain: 0.26 * gain, freq: jit(2200, 0.14), to: 620, type: 'bandpass', q: 1.2 });
    thump(out, { freq: jit(280, 0.1), to: 120, duration: 0.07, gain: 0.15 * gain, type: 'triangle' });
    metal(out, { base: jit(3000, 0.1), gain: 0.05 * gain, duration: 0.04, delay: 0.01 });
    if (near) noiseThrough(out, { duration: 0.26, gain: 0.08 * gain, freq: 620, to: 200, type: 'lowpass', deg: 0.5 });
  }

  /**
   * A round passing close by: the Doppler shape of a miss.
   *
   * As a bullet passes, the frequency you hear from it falls — the band-pass
   * sweeping down is that, and it is what tells the ear "that went past me"
   * instead of "that happened somewhere". The tiny broadband tick at the start
   * is the supersonic crack arriving ahead of the rest.
   */
  function whizz(out, { gain }) {
    // A narrow band swept over two octaves and a bit: 4.2 kHz arriving, 260 Hz
    // leaving. The high Q is what makes the pitch audible at all instead of
    // hiss, and the sweep must stay *continuous* over the whole event — the
    // late-window measurement in tools/audio-check.mjs fails if it flattens.
    noiseThrough(out, { duration: 0.22, gain: 0.34 * gain, freq: 4200, to: 260, type: 'bandpass', q: 9, attack: 0.008, deg: 1 });
    noiseThrough(out, { duration: 0.02, gain: 0.13 * gain, freq: 5600, type: 'highpass', q: 0.6, attack: 0.001 });
  }

  /** One footstep, built from weight, scuff and the occasional gear rattle. */
  function footstep(out, { gain, weight, scuff, rattle }) {
    // `gain` is the overall gait loudness, `weight` is the low thump inside it;
    // keeping them separate lets a crouch step stay audible to the player while
    // being nearly inaudible to everyone else.
    const w = jit(weight, 0.2) * gain;
    const s = jit(scuff, 0.25) * gain;
    thump(out, { freq: jit(105, 0.18), to: 55, duration: 0.075, gain: w, type: 'sine' });
    noiseThrough(out, { duration: 0.05, gain: 0.55 * w, freq: jit(260, 0.2), type: 'lowpass', q: 0.6 });
    if (scuff > 0) {
      // Boot sole on concrete: mostly high, short, and slightly delayed so it
      // reads as the sole settling after the weight arrives.
      noiseThrough(out, { duration: 0.06, gain: s, freq: jit(1700, 0.25), to: 700, type: 'bandpass', q: 1.4, delay: 0.012 });
    }
    if (rattle > 0 && Math.random() < 0.45) {
      metal(out, { base: jit(2400, 0.2), gain: rattle * gain, duration: 0.06, delay: 0.02, ratios: [1, 3.1] });
    }
  }

  /** The mechanical clack of a magazine: a spring, a latch and a hollow body. */
  function magClack(out, { gain, pitch }) {
    noiseThrough(out, { duration: 0.045, gain: 0.5 * gain, freq: jit(pitch, 0.1), type: 'bandpass', q: 2.2, attack: 0.001 });
    metal(out, { base: jit(pitch * 0.75, 0.08), gain: 0.3 * gain, duration: 0.09, ratios: [1, 2.71, 4.9] });
    thump(out, { freq: 140, to: 80, duration: 0.05, gain: 0.14 * gain, type: 'sine' });
  }

  const api = {
    get available() {
      return Boolean(ctx);
    },
    /** Must be called from a user gesture (click) to satisfy autoplay rules. */
    resume() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume();
    },
    setVolume(v) {
      volume = clamp(v, 0, 1);
      if (master) master.gain.value = muted ? 0 : volume;
    },
    setMuted(m) {
      muted = m;
      if (master) master.gain.value = muted ? 0 : volume;
    },
    /**
     * Fire one sound.
     *
     * `opts.distance` (metres) drives both the volume falloff and the air
     * absorption; `opts.pan` (-1..+1, from `soundPlacement`) places it in the
     * stereo field. Anything without them is a 2D interface sound.
     */
    play(name, opts = {}) {
      if (!ensure() || muted) return;
      if (!allow()) return;
      const distance = Math.max(0, opts.distance || 0);
      // Inverse-ish falloff, gently floored: at 40 m a shot is quiet, but it
      // never disappears, because in a real corridor it does not.
      const atten = clamp(1 / (1 + distance / 14), 0.1, 1);
      const out = bus(typeof opts.pan === 'number' ? opts.pan : null, distance);

      switch (name) {
        case 'shot_rifle':
        case 'shot_pistol':
          // Close enough to be a threat: play the whole stack. Further away the
          // crack and the action are gone, and `tail` takes over.
          if (distance > 6) {
            noiseThrough(out, { duration: 0.3, gain: 0.3 * atten, freq: 700, to: 140, type: 'lowpass', q: 0.6, deg: 0.6 });
            thump(out, { freq: 110, to: 45, duration: 0.22, gain: 0.18 * atten, type: 'sine' });
          } else if (name === 'shot_rifle') {
            rifle(out, { gain: atten, near: true });
          } else {
            pistol(out, { gain: atten, near: true });
          }
          break;
        case 'tail': // distant enemy fire, called explicitly by the mixer
          noiseThrough(out, { duration: 0.32, gain: 0.26 * atten, freq: 640, to: 150, type: 'lowpass', q: 0.6, deg: 0.6 });
          thump(out, { freq: 98, to: 42, duration: 0.24, gain: 0.16 * atten, type: 'sine' });
          break;

        // --- hit confirmation: interface sounds, always dead centre ---------
        case 'hit':
          noiseThrough(out, { duration: 0.03, gain: 0.18, freq: 2600, type: 'bandpass', q: 3, attack: 0.001 });
          thump(out, { freq: 900, to: 700, duration: 0.05, gain: 0.1, type: 'triangle' });
          break;
        case 'headshot':
          // Two partials a fifth apart, bright and short: reads as "precise".
          metal(out, { base: 2100, gain: 0.2, duration: 0.14, ratios: [1, 1.5] });
          noiseThrough(out, { duration: 0.02, gain: 0.14, freq: 5200, type: 'highpass', attack: 0.001 });
          break;
        case 'kill':
          thump(out, { freq: 700, to: 1100, duration: 0.09, gain: 0.14, type: 'triangle' });
          thump(out, { freq: 1050, duration: 0.14, gain: 0.08, type: 'sine', delay: 0.06 });
          break;
        case 'hurt':
          noiseThrough(out, { duration: 0.26, gain: 0.34, freq: 520, to: 180, type: 'lowpass', q: 0.7 });
          thump(out, { freq: 90, to: 50, duration: 0.3, gain: 0.24, type: 'sine' });
          break;

        // --- reload: three distinct mechanical events, not one -----------------
        case 'reload_start':
          // Hand on the magazine, release catch. Quiet, it is the setup.
          noiseThrough(out, { duration: 0.07, gain: 0.14, freq: 1500, to: 800, type: 'bandpass', q: 1.6 });
          metal(out, { base: 1800, gain: 0.09, duration: 0.05 });
          break;
        case 'reload_mag_out':
          // The magazine drops: spring slides down, body rings out.
          noiseThrough(out, { duration: 0.13, gain: 0.2, freq: 1200, to: 380, type: 'bandpass', q: 2.4, deg: 1 });
          metal(out, { base: 1400, gain: 0.12, duration: 0.12, delay: 0.01 });
          break;
        case 'reload_mag_in':
          // Fresh magazine seats: hard clack, then the latch snaps.
          magClack(out, { gain: 0.5, pitch: 2100 });
          magClack(out, { gain: 0.28, pitch: 1500 });
          break;
        case 'reload_end':
          // Bolt release: sharper and higher than the magazine, ends the action.
          metal(out, { base: 2800, gain: 0.22, duration: 0.1, ratios: [1, 2.4, 4.1] });
          noiseThrough(out, { duration: 0.045, gain: 0.16, freq: 3400, type: 'bandpass', q: 2, delay: 0.02 });
          break;
        case 'enemy_reload':
          // Same events, heard through a wall and a corridor: filtered, quiet,
          // and panned, so a reload is a *clue about direction*.
          noiseThrough(out, { duration: 0.1, gain: 0.12 * atten, freq: 900, to: 400, type: 'bandpass', q: 1.8 });
          metal(out, { base: 1300, gain: 0.05 * atten, duration: 0.1, delay: 0.03, ratios: [1, 2.7] });
          break;

        case 'empty':
          metal(out, { base: 3200, gain: 0.12, duration: 0.045, ratios: [1, 3.3] });
          break;
        case 'switch':
          noiseThrough(out, { duration: 0.07, gain: 0.12, freq: 1300, to: 700, type: 'bandpass', q: 1.5 });
          metal(out, { base: 2200, gain: 0.08, duration: 0.05, delay: 0.03, ratios: [1, 2.9] });
          break;

        // --- footsteps: weight + scuff, with the gait in the mix --------------
        case 'step_walk':
          footstep(out, { gain: 0.22, weight: 0.16, scuff: 0.05, rattle: 0.03 });
          break;
        case 'step_sprint':
          // Heavier weight, longer scuff, and gear that actually rattles.
          footstep(out, { gain: 0.3, weight: 0.26, scuff: 0.1, rattle: 0.06 });
          break;
        case 'step_crouch':
          // Quiet, not silent. -48 dBFS (the first attempt) was measurably
          // inaudible — see tools/audio-check.mjs — which reads as broken
          // rather than stealthy. This sits ~8 dB under a walk: present for
          // the player, useless for locating anyone.
          // Cloth and a knee pad rather than a boot heel: a soft brush with a
          // little body under it. Loud enough to feel, not to locate.
          noiseThrough(out, { duration: 0.1, gain: 0.013, freq: 1500, to: 600, type: 'bandpass', q: 0.9 });
          thump(out, { freq: 120, to: 70, duration: 0.07, gain: 0.004, type: 'sine' });
          break;
        case 'step': // kept for callers that do not know the gait
          footstep(out, { gain: 0.22, weight: 0.16, scuff: 0.05, rattle: 0.03 });
          break;

        case 'whizz':
          whizz(out, { gain: atten });
          break;

        case 'go':
          metal(out, { base: 620, gain: 0.14, duration: 0.4, ratios: [1, 2.02] });
          break;
        case 'round_win':
          thump(out, { freq: 480, to: 720, duration: 0.3, gain: 0.14, type: 'triangle' });
          thump(out, { freq: 720, to: 960, duration: 0.34, gain: 0.07, type: 'sine', delay: 0.09 });
          break;
        case 'round_loss':
          thump(out, { freq: 440, to: 250, duration: 0.42, gain: 0.14, type: 'triangle' });
          thump(out, { freq: 330, to: 200, duration: 0.46, gain: 0.06, type: 'sine', delay: 0.1 });
          break;
        case 'match_win':
          [0, 0.14, 0.28].forEach((d, i) => {
            thump(out, { freq: 440 * Math.pow(2, i / 3), to: 520 * Math.pow(2, i / 3), duration: 0.5, gain: 0.13, type: 'triangle', delay: d });
          });
          break;
        case 'match_loss':
          [0, 0.16, 0.32].forEach((d, i) => {
            thump(out, { freq: 380 / Math.pow(2, i / 3), to: 220 / Math.pow(2, i / 3), duration: 0.5, gain: 0.13, type: 'triangle', delay: d });
          });
          break;
        case 'ui':
          noiseThrough(out, { duration: 0.04, gain: 0.16, freq: 2200, type: 'bandpass', q: 3, attack: 0.001 });
          break;
        case 'death':
          // Everything drops away: a body hitting the floor, in a room.
          noiseThrough(out, { duration: 0.5, gain: 0.22, freq: 380, to: 90, type: 'lowpass', q: 0.6, deg: 0.7 });
          thump(out, { freq: 70, to: 38, duration: 0.55, gain: 0.26, type: 'sine' });
          break;
        default:
          break;
      }
    },
  };

  api.setVolume(volume);
  return api;
}
