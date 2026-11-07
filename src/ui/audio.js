// Procedural audio: everything is synthesized with WebAudio, so the build has
// zero audio assets and still gives feedback for shots, hits, reloads and the
// round/match stings.

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let volume = 0.55;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    // Slight compression keeps gunfire from clipping on laptop speakers.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);
    return ctx;
  }

  function noiseBuffer(duration) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function burst({ duration = 0.12, freq = 1800, gain = 0.5, type = 'lowpass', decay = 0.9, detune = 0 }) {
    if (!ensure()) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(duration);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = 0.8;
    if (detune) filter.frequency.setValueAtTime(freq, ctx.currentTime);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration * decay);
    src.connect(filter).connect(g).connect(master);
    src.start();
    src.stop(ctx.currentTime + duration);
  }

  function tone({ freq = 440, to = null, duration = 0.12, gain = 0.2, type = 'sine' }) {
    if (!ensure()) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(g).connect(master);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
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
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
    },
    setMuted(m) {
      muted = m;
      if (master) master.gain.value = muted ? 0 : volume;
    },
    play(name, opts = {}) {
      if (!ensure()) return;
      if (muted) return;
      const dist = opts.distance || 0;
      const atten = Math.max(0.12, 1 - dist / 55);
      switch (name) {
        case 'shot_rifle':
          burst({ duration: 0.16, freq: 1500, gain: 0.42 * atten, type: 'lowpass' });
          tone({ freq: 130, to: 60, duration: 0.1, gain: 0.22 * atten, type: 'square' });
          break;
        case 'shot_pistol':
          burst({ duration: 0.1, freq: 2200, gain: 0.3 * atten });
          tone({ freq: 190, to: 90, duration: 0.07, gain: 0.14 * atten, type: 'square' });
          break;
        case 'tail': // distant enemy fire
          burst({ duration: 0.22, freq: 700, gain: 0.16 * atten, type: 'lowpass', decay: 1.1 });
          break;
        case 'hit':
          tone({ freq: 1500, duration: 0.045, gain: 0.16, type: 'triangle' });
          break;
        case 'headshot':
          tone({ freq: 2100, duration: 0.06, gain: 0.2, type: 'triangle' });
          tone({ freq: 2900, duration: 0.05, gain: 0.12, type: 'square' });
          break;
        case 'kill':
          tone({ freq: 900, to: 1500, duration: 0.1, gain: 0.2, type: 'triangle' });
          break;
        case 'hurt':
          burst({ duration: 0.22, freq: 400, gain: 0.3, type: 'lowpass' });
          break;
        case 'reload_start':
          burst({ duration: 0.07, freq: 900, gain: 0.18, type: 'bandpass' });
          break;
        case 'reload_end':
          burst({ duration: 0.06, freq: 1500, gain: 0.2, type: 'bandpass' });
          tone({ freq: 320, duration: 0.05, gain: 0.1, type: 'square' });
          break;
        case 'empty':
          burst({ duration: 0.04, freq: 3200, gain: 0.12, type: 'highpass' });
          break;
        case 'switch':
          burst({ duration: 0.08, freq: 1100, gain: 0.14, type: 'bandpass' });
          break;
        case 'step':
          burst({ duration: 0.05, freq: 240, gain: 0.08 * atten, type: 'lowpass' });
          break;
        case 'go':
          tone({ freq: 520, duration: 0.16, gain: 0.16, type: 'square' });
          break;
        case 'round_win':
          tone({ freq: 480, to: 720, duration: 0.35, gain: 0.16, type: 'triangle' });
          break;
        case 'round_loss':
          tone({ freq: 420, to: 260, duration: 0.4, gain: 0.16, type: 'triangle' });
          break;
        case 'match_win':
          tone({ freq: 420, to: 840, duration: 0.7, gain: 0.18, type: 'triangle' });
          tone({ freq: 640, to: 1260, duration: 0.7, gain: 0.1, type: 'sine' });
          break;
        case 'match_loss':
          tone({ freq: 360, to: 140, duration: 0.8, gain: 0.18, type: 'triangle' });
          break;
        case 'ui':
          tone({ freq: 660, duration: 0.05, gain: 0.08, type: 'square' });
          break;
        case 'death':
          burst({ duration: 0.3, freq: 260, gain: 0.22, type: 'lowpass' });
          break;
        default:
          break;
      }
    },
  };
  api.setVolume(volume);
  return api;
}
