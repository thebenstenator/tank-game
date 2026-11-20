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
  volume: 0.55,

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
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = c.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(c.destination);

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
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  },

  ok() { return this.ctx && !this.muted; },

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

  noiseBurst({ dur, filter = 'lowpass', f0, f1, q = 0.7, vol, delay = 0, pan = 0, wet = 0.12 }) {
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
    this.out(g, pan, wet);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  },

  tone({ type = 'sine', f0, f1 = f0, dur, vol, delay = 0, pan = 0, wet = 0.1 }) {
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
    this.out(g, pan, wet);
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
    const s = clamp(size, 0, 1), pan = this.panX(x), wet = 0.25 + s * 0.45;
    this.noiseBurst({ dur: 0.5 + s * 1.6, f0: 900 + s * 1800, f1: 45, vol: 0.5 + s * 0.5, pan, wet });
    this.tone({ f0: 120, f1: 28, dur: 0.4 + s * 0.9, vol: 0.5 + s * 0.6, pan, wet: wet * 0.5 });
    this.noiseBurst({ dur: 0.07, filter: 'highpass', f0: 3200, f1: 1600, vol: 0.2 + s * 0.2, pan, wet }); // crack
    if (s > 0.5) { // long rolling thunder for the big ones
      this.noiseBurst({ dur: 2.4 + s * 2.2, f0: 320, f1: 30, vol: 0.3 * s, delay: 0.12, pan: pan * 0.5, wet: 0.7 });
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

  fire(size = 0.2, x) {
    if (!this.ok()) return;
    const s = clamp(size, 0, 1), pan = this.panX(x);
    this.noiseBurst({ dur: 0.35 + s * 0.4, filter: 'bandpass', f0: 1800, f1: 300 - s * 150, q: 1, vol: 0.35 + s * 0.2, pan, wet: 0.3 });
    this.tone({ type: 'triangle', f0: 220 - s * 110, f1: 50, dur: 0.25 + s * 0.35, vol: 0.3 + s * 0.25, pan, wet: 0.2 });
    this.noiseBurst({ dur: 0.05, filter: 'highpass', f0: 2600, f1: 2000, vol: 0.2, pan, wet: 0.25 });
  },

  pop(x) {
    if (!this.ok()) return;
    const pan = this.panX(x);
    this.tone({ f0: 700, f1: 220, dur: 0.12, vol: 0.2, pan });
    this.noiseBurst({ dur: 0.1, filter: 'bandpass', f0: 2500, f1: 900, q: 1.5, vol: 0.15, pan });
  },

  thud(x) { if (this.ok()) this.noiseBurst({ dur: 0.35, f0: 500, f1: 70, vol: 0.5, pan: this.panX(x), wet: 0.2 }); },

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
    this.updateWind(game, dt);
    this.updateFlight(game);
    this.updateServo(game, dt);
    this.updateRumble(game);
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
    this.ramp(a.low.g.gain, (0.012 + k * 0.2) * (0.45 + 0.8 * g), 0.15);
    this.ramp(a.low.f.frequency, 220 + k * 500 + g * 500, 0.2);
    const gale = Math.max(0, k - 0.3) / 0.7;
    this.ramp(a.howl.g.gain, gale * 0.06 * (0.15 + g), 0.25);
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
    if (p.kind === 'roll') { // grinding rumble along the ground
      this.ramp(v.depth.gain, 0.05, T);
      this.ramp(v.air.f.frequency, 110 + (p.rollSpeed || 80) * 1.3, T);
      this.ramp(v.air.g.gain, 0.22 * share, T);
    } else {
      const k = clamp(Math.hypot(p.vx, p.vy) / 800, 0, 1);
      this.ramp(v.depth.gain, 0.18, T);
      this.ramp(v.air.f.frequency, (220 + k * 1300) * v.m, T);
      this.ramp(v.air.g.gain, (0.025 + 0.06 * k) * v.vol * share, T);
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
