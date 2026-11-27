'use strict';

/**
 * Synthesized sound via WebAudio — no asset files needed.
 *
 * One-shots (booms, shots, clanks…) are fire-and-forget node graphs.
 * Continuous sounds (shell air rush, wind, turret servo, settling dirt) are
 * persistent nodes driven every frame from Sound.update(game, dt).
 * Everything is panned by world x and can send to a shared reverb.
 */
const Sound = {
  ctx: null,
  master: null,
  verbIn: null,
  noise: null,
  muted: false,
  volume: 0.55,   // full-scale output; the sliders scale around this

  // Player audio settings (0–100 sliders, 80 = the stock mix), saved between visits.
  settings: { master: 80, music: 80, sfx: 80, musicOn: true },

  voices: [],     // active projectile air-rush voices
  amb: null,      // wind ambience
  servo: null,    // turret / power adjust whir
  rumble: null,   // dirt settling
  last: {},
  lastPebbles: 0,

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    // main (master volume / mute) -> compressor -> speakers. Sound effects go
    // through `master` (the effects bus); the menu music has its own bus.
    this.main = c.createGain();
    const comp = c.createDynamicsCompressor();
    this.main.connect(comp);
    comp.connect(c.destination);
    this.master = c.createGain();
    this.master.connect(this.main);
    this.musicOut = c.createGain();
    this.musicOut.connect(this.main);
    this.applyGain(true);

    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Shared reverb: a big outdoor-ish tail so explosions echo off the hills.
    const verb = c.createConvolver();
    verb.buffer = this.impulse(3, 2.4);
    this.verbIn = c.createGain();
    this.verbIn.gain.value = 0.9;
    this.verbIn.connect(verb);
    verb.connect(this.master);

    // The music gets its own copy of the reverb so the effects slider doesn't touch its tail.
    const mverb = c.createConvolver();
    mverb.buffer = verb.buffer;
    this.musicVerbIn = c.createGain();
    this.musicVerbIn.connect(mverb);
    mverb.connect(this.musicOut);

    // Low-end bus for explosion weight: soft-clipped so the sub-bass feels big and
    // still comes through on laptop speakers, with a little reverb on the tail.
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = i / (curve.length - 1) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.lowBus = c.createGain();
    this.lowBus.gain.value = 0.9;
    const lowOut = c.createBiquadFilter(); // keep the grit out of the highs
    lowOut.type = 'lowpass';
    lowOut.frequency.value = 900;
    this.lowBus.connect(shaper); shaper.connect(lowOut); lowOut.connect(this.master);
    const lowVerb = c.createGain();
    lowVerb.gain.value = 0.3;
    lowOut.connect(lowVerb); lowVerb.connect(this.verbIn);

    // Don't leave shells or the wind droning while the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend(); else this.ctx.resume();
    });
  },

  impulse(dur, decay) {
    const c = this.ctx, n = (c.sampleRate * dur) | 0;
    const b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  },

  toggle() {
    this.muted = !this.muted;
    this.applyGain();
    this.saveSettings();
    return this.muted;
  },

  /** Load saved audio settings. Safe to call before init. */
  loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem('hh.audio') || 'null');
      if (raw) {
        for (const k of ['master', 'music', 'sfx']) if (isFinite(raw[k])) this.settings[k] = clamp(+raw[k], 0, 100);
        if (typeof raw.musicOn === 'boolean') this.settings.musicOn = raw.musicOn;
        if (typeof raw.muted === 'boolean') this.muted = raw.muted;
      }
    } catch (e) { /* ignore */ }
    this.applyGain();
  },

  saveSettings() {
    try { localStorage.setItem('hh.audio', JSON.stringify({ ...this.settings, muted: this.muted })); } catch (e) { /* ignore */ }
  },

  /** Change one setting (master / music / sfx 0–100, or musicOn), apply it and save. */
  setSetting(k, v) {
    this.settings[k] = v;
    this.applyGain();
    this.saveSettings();
  },

  /** Silence everything (used while fast-forwarding a CPU-only round). */
  setSilent(on) {
    this.silent = on;
    this.applyGain();
  },

  /** Slider (0–100, 80 = the stock mix) -> gain. Squared so the slider feels even to the ear. */
  level(v) { return Math.pow(clamp(v, 0, 100) / 80, 2); },

  applyGain(instant) {
    if (!this.ctx) return;
    const s = this.settings, now = this.ctx.currentTime;
    const set = (node, v) => { if (instant) node.gain.value = v; else node.gain.setTargetAtTime(v, now, 0.03); };
    set(this.main, this.muted || this.silent ? 0 : this.volume * this.level(s.master));
    set(this.master, this.level(s.sfx));
    set(this.musicOut, this.level(s.music));
  },

  ok() { return this.ctx && !this.muted && !this.silent; },

  /** World x → stereo pan. */
  panX(x) { return x == null ? 0 : clamp((x / W) * 2 - 1, -1, 1) * 0.75; },

  /** Connect a node to the speakers (panned) plus an optional reverb send. Returns the panner, if any. */
  out(node, pan = 0, wet = 0.15) {
    const c = this.ctx;
    let p = node, panner = null;
    if (c.createStereoPanner) {
      panner = c.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      node.connect(panner);
      p = panner;
    }
    p.connect(this.master);
    if (wet > 0) {
      const g = c.createGain();
      g.gain.value = wet;
      p.connect(g);
      g.connect(this.verbIn);
    }
    return panner;
  },

  ramp(param, v, T = 0.04) { param.setTargetAtTime(v, this.ctx.currentTime, T); },

  noiseBurst({ dur, filter = 'lowpass', f0, f1, q = 0.7, vol, delay = 0, pan = 0, wet = 0.12, bus = null }) {
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g);
    if (bus) g.connect(bus); else this.out(g, pan, wet);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  },

  tone({ type = 'sine', f0, f1 = f0, dur, vol, delay = 0, pan = 0, wet = 0.1, bus = null }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    if (bus) g.connect(bus); else this.out(g, pan, wet);
    o.start(t);
    o.stop(t + dur + 0.05);
  },

  loopNoise(type, freq, q) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.value = 0;
    s.connect(f); f.connect(g);
    s.start(0, Math.random() * 1.5);
    return { s, f, g };
  },

  // ---------------------------------------------------------------- one-shots

  boom(size, x) {
    if (!this.ok()) return;
    // s sets loudness/brightness (capped); L sets length and keeps growing for the really big ones.
    const s = clamp(size, 0, 1), L = clamp(size, 0, 2), pan = this.panX(x), wet = 0.25 + s * 0.45;
    this.noiseBurst({ dur: 0.5 + L * 1.8, f0: 900 + s * 1800, f1: 40, vol: 0.5 + s * 0.5, pan, wet });
    this.tone({ f0: 120, f1: 26, dur: 0.4 + L * 1.1, vol: 0.5 + s * 0.6, pan, wet: wet * 0.5 });
    this.noiseBurst({ dur: 0.07, filter: 'highpass', f0: 3200, f1: 1600, vol: 0.2 + s * 0.2, pan, wet }); // crack
    this.weight(s, 0, L);
    if (s > 0.5) { // long rolling thunder for the big ones
      this.noiseBurst({ dur: 2.2 + L * 2.4, f0: 320, f1: 28, vol: 0.3 * s + 0.1 * Math.max(0, L - 1), delay: 0.12, pan: pan * 0.5, wet: 0.7 });
    }
    // Dirt and pebbles raining back down (rate-limited so chains don't spam).
    const now = this.ctx.currentTime;
    if (s > 0.15 && now - this.lastPebbles > 0.2) {
      this.lastPebbles = now;
      for (let i = 0, n = Math.round(4 + s * 14); i < n; i++) {
        this.noiseBurst({
          dur: rand(0.025, 0.06), filter: 'bandpass', f0: rand(1800, 4200), f1: rand(700, 1400), q: 3,
          vol: rand(0.02, 0.06) * (0.6 + s), delay: rand(0.35, 1.1 + s * 1.2),
          pan: clamp(pan + rand(-0.25, 0.25), -1, 1), wet: 0.08,
        });
      }
    }
  },

  /** The deep layers under every explosion: kick punch, sub drop, rumble, and a pressure swell on big ones. */
  weight(s, delay = 0, L = s) {
    const bus = this.lowBus;
    this.tone({ type: 'triangle', f0: 170, f1: 45, dur: 0.16 + s * 0.14, vol: 0.45 + s * 0.3, delay, bus });  // punch
    this.tone({ f0: 75 + s * 15, f1: 24, dur: 0.55 + L * 1.9, vol: 0.5 + s * 0.45, delay, bus });            // sub drop
    this.noiseBurst({ dur: 0.9 + L * 2.8, f0: 280 + s * 220, f1: 30, q: 1.1, vol: 0.4 + s * 0.5, delay, bus }); // rumble
    if (s > 0.35) this.tone({ f0: 46, f1: 20, dur: 1.4 + L * 2.4, vol: 0.4 * s, delay: delay + 0.09, bus }); // pressure swell
  },

  fire(size = 0.2, x, delay = 0) {
    if (!this.ok()) return;
    const s = clamp(size, 0, 1), pan = this.panX(x);
    this.noiseBurst({ dur: 0.35 + s * 0.4, filter: 'bandpass', f0: 1800, f1: 300 - s * 150, q: 1, vol: 0.35 + s * 0.2, delay, pan, wet: 0.3 });
    this.tone({ type: 'triangle', f0: 220 - s * 110, f1: 50, dur: 0.25 + s * 0.35, vol: 0.3 + s * 0.25, delay, pan, wet: 0.2 });
    this.noiseBurst({ dur: 0.05, filter: 'highpass', f0: 2600, f1: 2000, vol: 0.2, delay, pan, wet: 0.25 });
    this.tone({ type: 'triangle', f0: 140, f1: 40, dur: 0.18 + s * 0.2, vol: 0.3 + s * 0.3, delay, bus: this.lowBus }); // recoil thump
  },

  /** Dirt fountain: a deep gulp and a gushing spray of earth. */
  fountain(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.9, filter: 'bandpass', f0: 250, f1: 1400, q: 0.9, vol: 0.4, pan, wet: 0.3 });
    this.noiseBurst({ dur: 1.3, f0: 900, f1: 80, vol: 0.3, delay: 0.1, pan, wet: 0.3 });
    this.weight(0.18);
  },

  pop(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.tone({ f0: 700, f1: 220, dur: 0.12, vol: 0.2, pan });
    this.noiseBurst({ dur: 0.1, filter: 'bandpass', f0: 2500, f1: 900, q: 1.5, vol: 0.15, pan });
  },

  thud(x) {
    if (!this.ok()) return;
    this.noiseBurst({ dur: 0.35, f0: 500, f1: 70, vol: 0.5, pan: this.panX(x), wet: 0.2 });
    this.noiseBurst({ dur: 0.6, f0: 180, f1: 35, vol: 0.4, bus: this.lowBus });
  },

  click() { if (this.ok()) this.tone({ type: 'square', f0: 900, dur: 0.03, vol: 0.04, wet: 0 }); },

  buy() {
    if (!this.ok()) return;
    this.tone({ f0: 660, dur: 0.09, vol: 0.15 });
    this.tone({ f0: 990, dur: 0.12, vol: 0.15, delay: 0.07 });
  },

  charge(dur, x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.tone({ type: 'sawtooth', f0: 90, f1: 1400, dur, vol: 0.12, pan });
    this.noiseBurst({ dur, filter: 'bandpass', f0: 300, f1: 4000, q: 2, vol: 0.15, pan });
  },

  shield(x) { if (this.ok()) this.tone({ f0: 300, f1: 900, dur: 0.3, vol: 0.15, pan: this.panX(x), wet: 0.3 }); },

  /** Energy crackle when a shield soaks a hit. */
  shieldHit(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.tone({ type: 'sawtooth', f0: 1400, f1: 300, dur: 0.22, vol: 0.06, pan, wet: 0.3 });
    this.noiseBurst({ dur: 0.18, filter: 'bandpass', f0: 5000, f1: 1500, q: 4, vol: 0.1, pan, wet: 0.3 });
  },

  /** Glassy shatter when a shield gives out. */
  shieldBreak(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.5, filter: 'highpass', f0: 6000, f1: 2500, vol: 0.18, pan, wet: 0.4 });
    for (let i = 0; i < 7; i++) {
      this.tone({ f0: rand(1800, 4200), f1: rand(900, 1600), dur: rand(0.15, 0.4), vol: 0.05, delay: rand(0, 0.12), pan: clamp(pan + rand(-0.2, 0.2), -1, 1), wet: 0.4 });
    }
  },

  /** Metallic clang when a tank takes damage. k ≈ how hard (0..1). */
  clank(x, k = 0.5) {
    if (!this.ok()) return;
    const pan = this.panX(x), v = 0.5 + clamp(k, 0, 1);
    const base = rand(260, 340);
    [1, 2.76, 5.4, 8.9].forEach((m, i) =>
      this.tone({ type: i ? 'sine' : 'triangle', f0: base * m, f1: base * m * 0.94, dur: 0.35 - i * 0.06, vol: (0.1 - i * 0.02) * v, pan, wet: 0.25 }));
  },

  /** Parachute snapping open. */
  chute(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.3, filter: 'bandpass', f0: 250, f1: 1100, q: 1.2, vol: 0.22, pan });
    this.noiseBurst({ dur: 0.12, filter: 'bandpass', f0: 900, f1: 600, q: 2, vol: 0.12, delay: 0.22, pan });
  },

  /** Tank hitting the ground after a fall. */
  land(x, k = 0.5) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.3 + k * 0.3, f0: 400, f1: 50, vol: 0.25 + k * 0.35, pan, wet: 0.2 });
    if (k > 0.2) this.clank(x, k * 0.6);
  },

  /** A sad sputtering death. */
  fizzle(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.tone({ type: 'sawtooth', f0: 420, f1: 70, dur: 0.9, vol: 0.06, pan, wet: 0.2 });
    for (let i = 0; i < 12; i++) {
      this.noiseBurst({ dur: rand(0.03, 0.08), filter: 'bandpass', f0: rand(800, 2500), f1: 400, q: 2, vol: 0.12 * (1 - i / 14), delay: i * rand(0.05, 0.09), pan });
    }
  },

  /** Laser: a sharp crack, a descending zap, a heavy buzzing beam and rock sizzling where it cut. */
  laser(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.09, filter: 'highpass', f0: 4500, f1: 2000, vol: 0.32, pan, wet: 0.4 });       // crack
    this.tone({ type: 'sawtooth', f0: 2800, f1: 260, dur: 0.6, vol: 0.13, pan, wet: 0.35 });                  // zap
    this.tone({ type: 'square', f0: 1300, f1: 700, dur: 0.45, vol: 0.06, pan, wet: 0.35 });
    this.tone({ type: 'sawtooth', f0: 160, f1: 70, dur: 0.85, vol: 0.16, pan, wet: 0.25 });                   // beam hum
    this.tone({ type: 'square', f0: 82, f1: 55, dur: 0.7, vol: 0.07, pan, wet: 0.2 });
    this.noiseBurst({ dur: 0.6, filter: 'highpass', f0: 7000, f1: 2500, vol: 0.16, pan, wet: 0.35 });        // hiss
    this.noiseBurst({ dur: 1.1, filter: 'bandpass', f0: 3200, f1: 1400, q: 1.5, vol: 0.1, delay: 0.08, pan, wet: 0.3 }); // sizzle
    this.weight(0.3);
  },

  /**
   * Nuke: on top of the regular (already huge) boom, a slow sub "booommm" that swells
   * and sinks, a delayed shockwave sweeping out across the stereo field, echoes off
   * the hills, and a rumble that rolls on for several seconds. k scales it.
   */
  nuke(x, k = 1) {
    if (!this.ok()) return;
    const c = this.ctx, now = c.currentTime, pan = this.panX(x), bus = this.lowBus;
    const swell = (delay, dur, f0, f1, vol, type = 'sine') => {
      const o = c.createOscillator(), g = c.createGain(), t = now + delay;
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.25);
      g.gain.setTargetAtTime(0.0001, t + 0.6, dur / 4);
      o.connect(g); g.connect(bus);
      o.start(t); o.stop(t + dur + 0.1);
    };
    swell(0.05, 4.5 * k + 1, 58, 22, 0.7 * k);
    swell(0.1, 3.5 * k + 1, 36, 18, 0.5 * k, 'triangle');
    // rumble that rolls on and on
    const s = c.createBufferSource();
    s.buffer = this.noise; s.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(500, now);
    lp.frequency.exponentialRampToValueAtTime(40, now + 6 * k + 1);
    const rg = c.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.exponentialRampToValueAtTime(0.55 * k, now + 0.6);
    rg.gain.setTargetAtTime(0.0001, now + 1.2, 1.6 * k + 0.3);
    s.connect(lp); lp.connect(rg); this.out(rg, pan * 0.4, 0.6);
    s.start(now, Math.random()); s.stop(now + 8 * k + 2);
    // the shockwave arrives a beat later: a hard thump and a blast of air sweeping outwards
    const sw = 0.55 + 0.25 * k;
    this.tone({ type: 'triangle', f0: 140, f1: 30, dur: 0.6, vol: 0.8 * k, delay: sw, bus });
    this.noiseBurst({ dur: 0.08, filter: 'highpass', f0: 3000, f1: 1200, vol: 0.35 * k, delay: sw, pan, wet: 0.5 });
    for (const side of [-1, 1]) {
      const p = clamp(pan + side * 0.3, -1, 1), p2 = side * 0.95, t = now + sw;
      const n = c.createBufferSource();
      n.buffer = this.noise; n.loop = true;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(1600, t);
      bp.frequency.exponentialRampToValueAtTime(140, t + 1.6);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4 * k, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      n.connect(bp); bp.connect(g);
      const panner = this.out(g, p, 0.5);
      if (panner) { panner.pan.setValueAtTime(p, t); panner.pan.linearRampToValueAtTime(p2, t + 1.4); }
      n.start(t, Math.random()); n.stop(t + 1.9);
    }
    // echoes off distant hills
    [[1.7, -0.7, 0.45], [2.6, 0.75, 0.3], [3.7, -0.4, 0.18]].forEach(([d, p, v]) => {
      const dd = d * (0.7 + 0.3 * k);
      this.noiseBurst({ dur: 1.4, f0: 700, f1: 60, vol: v * k, delay: dd, pan: p, wet: 0.8 });
      this.tone({ f0: 70, f1: 30, dur: 1.2, vol: v * 0.8 * k, delay: dd, bus });
    });
  },

  /** Napalm igniting: a big whoosh with a low roar. */
  napalm(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.8, filter: 'bandpass', f0: 350, f1: 2400, q: 0.8, vol: 0.32, pan, wet: 0.3 });
    this.noiseBurst({ dur: 1.4, f0: 320, f1: 70, vol: 0.25, pan, wet: 0.3 });
  },

  /** A tank dissolving into light. */
  vaporize(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    for (let i = 0; i < 8; i++) this.tone({ f0: rand(1500, 3800), f1: rand(3000, 6000), dur: rand(0.2, 0.5), vol: 0.035, delay: i * 0.05, pan, wet: 0.5 });
    this.noiseBurst({ dur: 0.9, filter: 'highpass', f0: 3000, f1: 9000, vol: 0.1, pan, wet: 0.5 });
  },

  /** Excavator: dirt blown away with a deep thump. */
  excavate(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.noiseBurst({ dur: 0.9, f0: 1100, f1: 60, vol: 0.5, pan, wet: 0.3 });
    this.weight(0.25);
  },

  /** Turn start: a soft two-note chime for humans, a lower blip for CPUs. */
  turn(human) {
    if (!this.ok()) return;
    if (human) {
      this.tone({ type: 'triangle', f0: 587, dur: 0.12, vol: 0.07, wet: 0.3 });
      this.tone({ type: 'triangle', f0: 880, dur: 0.2, vol: 0.07, delay: 0.09, wet: 0.3 });
    } else {
      this.tone({ type: 'triangle', f0: 392, dur: 0.12, vol: 0.04, wet: 0.2 });
    }
  },

  win() {
    if (!this.ok()) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.25, vol: 0.14, delay: i * 0.11, wet: 0.3 }));
  },

  // ---------------------------------------------------------------- continuous

  update(game, dt) {
    if (!this.ctx || this.ctx.state !== 'running' || dt <= 0) return;
    if (this.silent) { // drop shell voices; nothing else needs driving while silent
      const now = this.ctx.currentTime;
      this.voices.forEach(v => this.releaseVoice(v, now));
      this.voices = [];
      return;
    }
    this.updateWind(game, dt);
    this.updateFlight(game);
    this.updateServo(game, dt);
    this.updateRumble(game);
    this.updateFire(game, dt);
  },

  /** Crackling while napalm burns. */
  updateFire(game, dt) {
    const n = game.fires ? game.fires.length : 0;
    if (!n || Math.random() > dt * Math.min(30, n * 1.5)) return;
    const f = game.fires[(Math.random() * n) | 0];
    this.noiseBurst({ dur: rand(0.03, 0.09), filter: 'bandpass', f0: rand(1200, 4500), f1: rand(500, 1200), q: 2, vol: rand(0.03, 0.08), pan: this.panX(f.x), wet: 0.1 });
  },

  /** Gusting wind bed, louder and higher with stronger wind; a howl layer in gales. */
  updateWind(game, dt) {
    if (!this.amb) {
      const c = this.ctx;
      const low = this.loopNoise('bandpass', 400, 0.6);
      const howl = this.loopNoise('bandpass', 1100, 9);
      const mix = c.createGain();
      low.g.connect(mix); howl.g.connect(mix);
      const pan = this.out(mix, 0, 0.1);
      this.amb = { low, howl, pan, gust: 0.5, target: 0.5, tNext: 0 };
    }
    const a = this.amb;
    const k = game.state === 'setup' ? 0.15 : Math.min(1, Math.abs(game.wind) / 60);
    a.tNext -= dt;
    if (a.tNext <= 0) { a.target = Math.random(); a.tNext = rand(0.7, 3); }
    a.gust += (a.target - a.gust) * Math.min(1, dt * 1.3);
    const g = a.gust;
    // Duck the wind a little while shells are flying so you can hear them travel.
    const duck = this.voices.length ? 0.55 : 1;
    this.ramp(a.low.g.gain, (0.012 + k * 0.2) * (0.45 + 0.8 * g) * duck, 0.15);
    this.ramp(a.low.f.frequency, 220 + k * 500 + g * 500, 0.2);
    const gale = Math.max(0, k - 0.3) / 0.7;
    this.ramp(a.howl.g.gain, gale * 0.06 * (0.15 + g) * duck, 0.25);
    this.ramp(a.howl.f.frequency, 650 + g * 800 + k * 300, 0.3);
    if (a.pan) this.ramp(a.pan.pan, Math.sign(game.wind) * 0.35, 0.5);
  },

  /**
   * Each shell in the air gets a soft rush of air: filtered noise that brightens
   * with speed (so it darkens at the top of the arc) with a faint tumbling flutter.
   * No pitched tone, so it stays in the background.
   */
  updateFlight(game) {
    const live = game.projectiles;
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter(v => {
      if (live.includes(v.p)) return true;
      this.releaseVoice(v, now);
      return false;
    });
    for (const p of live) {
      if (this.voices.length >= 3) break;
      if (!this.voices.some(v => v.p === p)) this.voices.push(this.makeVoice(p));
    }
    const share = 1 / Math.sqrt(this.voices.length || 1);
    for (const v of this.voices) this.driveVoice(v, share);
  },

  makeVoice(p) {
    const c = this.ctx;
    const air = this.loopNoise('lowpass', 400, 0.5);
    // Flutter: gently wobble the level, like a shell tumbling through the air.
    const flutter = c.createGain();
    flutter.gain.value = 1;
    const lfo = c.createOscillator();
    lfo.frequency.value = rand(9, 14);
    const depth = c.createGain();
    depth.gain.value = 0.18;
    lfo.connect(depth); depth.connect(flutter.gain);
    air.g.connect(flutter);
    const pan = this.out(flutter, this.panX(p.x), 0.1);
    lfo.start();
    // Heavier warheads sound darker; bomblets and shrapnel lighter and quieter.
    let m = clamp(1.25 - p.radius / 120, 0.4, 1.1);
    if (p.kind === 'bomblet') m *= 1.3;
    return { p, air, lfo, depth, pan, m, vol: p.kind === 'bomblet' ? 0.5 : 1 };
  },

  driveVoice(v, share) {
    const p = v.p, T = 0.05;
    if (p.kind === 'roll' || p.kind === 'dig') { // grinding rumble along (or through) the ground
      this.ramp(v.depth.gain, 0.05, T);
      this.ramp(v.air.f.frequency, 110 + (p.rollSpeed || 80) * 1.3, T);
      this.ramp(v.air.g.gain, 0.22 * share, T);
    } else {
      const k = clamp(Math.hypot(p.vx, p.vy) / 800, 0, 1);
      this.ramp(v.depth.gain, 0.18, T);
      this.ramp(v.air.f.frequency, (220 + k * 1300) * v.m, T);
      this.ramp(v.air.g.gain, (0.05 + 0.12 * k) * v.vol * share, T);
    }
    if (v.pan) this.ramp(v.pan.pan, this.panX(p.x), T);
  },

  releaseVoice(v, now) {
    v.air.g.gain.setTargetAtTime(0, now, 0.03);
    v.air.s.stop(now + 0.3);
    v.lfo.stop(now + 0.3);
  },

  /** Whir while the turret swings, plus a rising tone while power changes. */
  updateServo(game, dt) {
    if (!this.servo) {
      const c = this.ctx;
      const mk = (type, freq, lp) => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lp;
        const g = c.createGain();
        g.gain.value = 0;
        o.connect(f); f.connect(g);
        o.start();
        return { o, g };
      };
      const turret = mk('sawtooth', 80, 650);
      const power = mk('triangle', 300, 2000);
      const mix = c.createGain();
      turret.g.connect(mix); power.g.connect(mix);
      this.servo = { turret, power, pan: this.out(mix, 0, 0) };
    }
    const s = this.servo, L = this.last;
    const t = game.state === 'aim' ? game.current : null;
    let av = 0, pv = 0;
    if (t && L.t === t) {
      av = Math.abs(t.angle - L.angle) / dt;
      pv = Math.abs(t.power - L.power) / dt;
    }
    L.t = t;
    if (t) { L.angle = t.angle; L.power = t.power; }
    this.ramp(s.turret.g.gain, av > 0.5 ? 0.05 : 0, 0.025);
    this.ramp(s.turret.o.frequency, 65 + Math.min(av, 80) * 0.9, 0.05);
    this.ramp(s.power.g.gain, pv > 0.5 ? 0.025 : 0, 0.025);
    if (t) {
      this.ramp(s.power.o.frequency, 160 + t.power * 0.7, 0.03);
      if (s.pan) this.ramp(s.pan.pan, this.panX(t.x), 0.1);
    }
  },

  /** Low rumble while loose dirt is sliding down. */
  updateRumble(game) {
    if (!this.rumble) {
      this.rumble = this.loopNoise('lowpass', 140, 0.8);
      this.out(this.rumble.g, 0, 0.2);
    }
    this.ramp(this.rumble.g.gain, game.settling ? 0.2 : 0, game.settling ? 0.05 : 0.25);
  },
};
