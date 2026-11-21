'use strict';

/**
 * Menu music: a light field-drum march over a soft pad and a low drone, in D minor.
 * Snare cadence, tenor drums, timpani, fills and rolls, scheduled a little ahead
 * of time on the shared WebAudio context. It only plays on the setup screen and
 * fades out when a game starts.
 */
const Music = {
  bpm: 104,
  level: 0.38,     // overall music level, under the master volume
  bus: null,
  playing: false,
  timer: null,
  step: 0,         // 16th-note index; negative = the two-bar drum intro
  next: 0,         // context time of the next step
  loop: 0,

  get stepDur() { return 60 / this.bpm / 4; },

  /** Call every frame with whether the menu is showing. */
  update(wanted) {
    if (!Sound.ctx) return;
    if (wanted && !this.playing) this.start();
    else if (!wanted && this.playing) this.stop();
  },

  ensureBus() {
    if (this.bus) return;
    const c = Sound.ctx;
    this.bus = c.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(Sound.master);
    const send = c.createGain();
    send.gain.value = 0.3;
    this.bus.connect(send);
    send.connect(Sound.verbIn);
  },

  start() {
    this.ensureBus();
    const c = Sound.ctx, now = c.currentTime;
    this.playing = true;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setTargetAtTime(this.level, now, 0.6);
    if (this.timer) return; // was still fading out: just bring it back up
    this.step = -32;
    this.loop = 0;
    this.next = now + 0.1;
    this.timer = setInterval(() => this.tick(), 50);
  },

  stop() {
    const c = Sound.ctx, now = c.currentTime;
    this.playing = false;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setTargetAtTime(0, now, 0.35);
    setTimeout(() => {
      if (!this.playing && this.timer) { clearInterval(this.timer); this.timer = null; }
    }, 1800);
  },

  tick() {
    const c = Sound.ctx;
    if (c.state !== 'running') return;
    if (this.next < c.currentTime) this.next = c.currentTime + 0.05; // resumed after a pause
    while (this.next < c.currentTime + 0.3) {
      this.playStep(this.step, this.next);
      this.next += this.stepDur;
      if (++this.step >= 256) { this.step = 0; this.loop++; }
    }
  },

  // ------------------------------------------------------------ the score

  playStep(s, t) {
    const sd = this.stepDur;
    if (s < 0) { // intro: snare and timpani alone, the drone fading in under the second bar
      const i = s + 32, bar = i >> 4, st = i & 15;
      if (bar === 1 && st >= 8) this.roll(t, st);
      else if (SNARE_A[st]) this.snare(t, SNARE_A[st] * 0.8);
      if (st === 0) this.timp(t, 38, 0.5);
      if (st === 8) this.timp(t, 38, 0.3);
      if (bar === 1 && st === 0) this.drone(t, 38, sd * 16, 0.9);
      return;
    }
    const bar = s >> 4, st = s & 15;
    const [root, chord] = PROG[bar];
    const second = bar >= 8;          // second half of the tune: busier cadence
    const odd = this.loop % 2 === 1;  // every other time through, the tenor drums join in

    // snare: cadence, rolls into each 8-bar phrase, flams on some accents
    if (bar % 8 === 7 && st >= 8) this.roll(t, st);
    else {
      const v = (second ? SNARE_B : SNARE_A)[st];
      if (v) {
        if (v >= 0.9 && (bar & 1)) this.snare(t - 0.022, 0.25); // flam grace note
        this.snare(t, v);
      }
    }

    // tenor drums: a low answering pattern, plus a fill at the end of bars 4 and 12
    if (bar % 8 === 3 && st >= 10) {
      if (st % 2 === 0 || st === 15) this.tom(t, [196, 165, 147, 131, 120, 110][st - 10] || 110, 0.75);
    } else if (odd || second) {
      const v = TENOR[st];
      if (v) this.tom(t, st < 8 ? 147 : 131, v * (odd ? 1 : 0.6));
    }

    // timpani on the root, beats 1 and 3, with pickups before each phrase
    if (st === 0) this.timp(t, root, 0.55);
    if (st === 8) this.timp(t, root, 0.32);
    if (bar % 8 === 7 && (st === 12 || st === 14)) this.timp(t, 33, 0.3 + st * 0.01);

    // underlay: pad chord and drone on the root
    if (st === 0) {
      this.pad(t, chord, sd * 16);
      this.drone(t, root, sd * 16, 1);
    }
  },

  roll(t, st) { // 32nd-note roll swelling into the downbeat
    const v = 0.25 + (st - 8) / 8 * 0.6;
    this.snare(t, v);
    this.snare(t + this.stepDur / 2, v + 0.04);
  },

  // ------------------------------------------------------------ instruments

  snare(t, v) {
    const c = Sound.ctx;
    const s = c.createBufferSource();
    s.buffer = Sound.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    f.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * v + 0.001, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07 + v * 0.06);
    s.connect(f); f.connect(g); this.pan(g, -0.12);
    s.start(t, Math.random() * 1.5);
    s.stop(t + 0.2);
    // drum body
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    const og = c.createGain();
    og.gain.setValueAtTime(0.08 * v + 0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(og); this.pan(og, -0.12);
    o.start(t); o.stop(t + 0.08);
  },

  /** Tenor / field tom: a pitched, slightly papery thump. */
  tom(t, hz, v) {
    const c = Sound.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(hz, t + 0.04);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g); this.pan(g, 0.18);
    o.start(t); o.stop(t + 0.3);
    const s = c.createBufferSource();
    s.buffer = Sound.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    const sg = c.createGain();
    sg.gain.setValueAtTime(0.05 * v, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    s.connect(f); f.connect(sg); this.pan(sg, 0.18);
    s.start(t, Math.random()); s.stop(t + 0.08);
  },

  timp(t, m, v) {
    const c = Sound.ctx, f = midiHz(m);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.25, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g); g.connect(this.bus);
    o.start(t); o.stop(t + 1);
    // skin slap
    const s = c.createBufferSource();
    s.buffer = Sound.noise;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const sg = c.createGain();
    sg.gain.setValueAtTime(0.12 * v, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    s.connect(lp); lp.connect(sg); sg.connect(this.bus);
    s.start(t, Math.random()); s.stop(t + 0.1);
  },

  pad(t, chord, dur) {
    const c = Sound.ctx;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 750;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.024, t + 0.35);
    g.gain.setValueAtTime(0.024, t + dur - 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    f.connect(g); g.connect(this.bus);
    for (const m of chord) {
      for (const cents of [-8, 8]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(m) * Math.pow(2, cents / 1200);
        o.connect(f);
        o.start(t); o.stop(t + dur + 0.35);
      }
    }
  },

  /** Low sustained root (plus its octave below), crossfading bar to bar. */
  drone(t, m, dur, v) {
    const c = Sound.ctx;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07 * v, t + 0.3);
    g.gain.setValueAtTime(0.07 * v, t + dur - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
    f.connect(g); g.connect(this.bus);
    const parts = [[m, 'sawtooth', 0.5], [m - 12, 'sine', 1]];
    for (const [n, type, k] of parts) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = midiHz(n);
      const og = c.createGain();
      og.gain.value = k;
      o.connect(og); og.connect(f);
      o.start(t); o.stop(t + dur + 0.45);
    }
  },

  pan(node, p) {
    const c = Sound.ctx;
    if (c.createStereoPanner) {
      const pn = c.createStereoPanner();
      pn.pan.value = p;
      node.connect(pn); pn.connect(this.bus);
    } else node.connect(this.bus);
  },
};

function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// Snare cadences (16ths): accents on the beats, ghost notes between.
const SNARE_A = [0.8, 0, 0.25, 0.35, 0.9, 0, 0.35, 0, 0.8, 0, 0.25, 0.35, 0.9, 0.25, 0.5, 0.25];
const SNARE_B = [0.85, 0.2, 0.3, 0.45, 0.95, 0, 0.4, 0.3, 0.8, 0.2, 0.3, 0.45, 0.95, 0.3, 0.55, 0.35];
// Tenor drums answer in the gaps.
const TENOR = [0, 0, 0, 0, 0, 0.6, 0, 0.4, 0, 0, 0, 0, 0, 0.5, 0, 0];

// [drone root, pad chord] per bar.
const DM = [50, 53, 57], BB = [50, 53, 58], GM = [50, 55, 58], AM = [49, 52, 57], CM = [48, 52, 55];
const PROG = [
  [38, DM], [34, BB], [43, GM], [45, AM], [38, DM], [34, BB], [36, CM], [45, AM],
  [34, BB], [36, CM], [38, DM], [38, DM], [43, GM], [34, BB], [45, AM], [45, AM],
];
