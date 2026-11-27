'use strict';

/**
 * Menu music: "Iron Rain", a slow, heavy 8-bit piece in A minor. It uses
 * NES-style voices: a triangle bass chugging under low pulse-wave power chords,
 * noise-channel drums with a half-time snare, and a long soaring pulse lead.
 * Notes are scheduled a little ahead of time on the shared WebAudio context.
 * It only plays on the setup screen and fades out when a game starts.
 */
const Music = {
  bpm: 88,
  level: 0.3,      // overall music level, under the master volume
  bus: null,
  playing: false,
  timer: null,
  step: 0,         // 16th-note index into the tune
  next: 0,         // context time of the next step
  loop: 0,
  waves: null,     // NES pulse waves (12.5% and 25% duty)

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
    this.bus.connect(Sound.musicOut);
    const send = c.createGain();
    send.gain.value = 0.2;
    this.bus.connect(send);
    send.connect(Sound.musicVerbIn);
    if (c.createPeriodicWave) {
      const pw = duty => {
        const n = 64, re = new Float32Array(n), im = new Float32Array(n);
        for (let k = 1; k < n; k++) im[k] = 2 / (k * Math.PI) * Math.sin(k * Math.PI * duty);
        return c.createPeriodicWave(re, im);
      };
      this.waves = { p12: pw(0.125), p25: pw(0.25) };
    }
  },

  start() {
    this.ensureBus();
    const c = Sound.ctx, now = c.currentTime;
    this.playing = true;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setTargetAtTime(this.level, now, 0.6);
    if (this.timer) return; // was still fading out: just bring it back up
    this.step = 0;
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
      if (++this.step >= MELODY.length) { this.step = 0; this.loop++; }
    }
  },

  // ------------------------------------------------------------ the score

  playStep(s, t) {
    const sd = this.stepDur, bar = s >> 4, st = s & 15, r = ROOTS[bar];

    // chug: palm-muted triangle bass doubled by quiet low pulse power chords
    if (CHUG[st]) {
      this.note(t, r, sd * 0.55, 0.34, 'triangle');
      this.note(t, r + 12, sd * 0.5, 0.02, 'p12');
      this.note(t, r + 19, sd * 0.5, 0.016, 'p12');
    }

    // drums: kick on the chug accents, one big half-time snare, a crash every 4 bars
    if (st === 0 || st === 3 || st === 10) this.kick(t, 0.6);
    if (st === 8) this.hiss(t, 0.2, 0.28, 1100);
    if (st === 0 && bar % 4 === 0) this.hiss(t, 1.2, 0.08, 5000);
    if (st % 4 === 0) this.hiss(t, 0.025, 0.03, 8000);

    // lead, doubled an octave down every other time through
    const m = MELODY[s];
    if (m > 0) {
      let g = 1;
      while (g < 16 && MELODY[(s + g) % MELODY.length] === 0) g++;
      const d = sd * g * 0.9;
      this.note(t, m, d, 0.08, 'p25', true);
      if (this.loop % 2 === 1) this.note(t, m - 12, d, 0.03, 'p12', true);
    }
  },

  // ------------------------------------------------------------ instruments

  /** One held note. voice: 'triangle', or a pulse wave 'p12' / 'p25'. */
  note(t, m, dur, v, voice, vib = false) {
    const c = Sound.ctx, f = midiHz(m);
    const o = c.createOscillator();
    const w = this.waves && this.waves[voice];
    if (w) o.setPeriodicWave(w); else o.type = voice === 'triangle' ? 'triangle' : 'square';
    o.frequency.setValueAtTime(f, t);
    if (vib) { // gentle vibrato fading in on held notes
      const l = c.createOscillator(), lg = c.createGain();
      l.frequency.value = 5;
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(f * 0.012, t + 0.25);
      l.connect(lg); lg.connect(o.frequency);
      l.start(t); l.stop(t + dur + 0.1);
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.005);
    g.gain.setValueAtTime(v, t + dur);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.02);
    o.connect(g); g.connect(this.bus);
    o.start(t); o.stop(t + dur + 0.05);
  },

  /** NES-style kick: a triangle diving in pitch. */
  kick(t, v) {
    const c = Sound.ctx;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.09);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(g); g.connect(this.bus);
    o.start(t); o.stop(t + 0.14);
  },

  /** Noise-channel hit: snare, crash or hi-hat depending on length and filter. */
  hiss(t, dur, v, hp) {
    const c = Sound.ctx;
    const s = c.createBufferSource();
    s.buffer = Sound.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = c.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.bus);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  },
};

function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** Parse a tune written as note names: '.' holds the previous note, '-' is a rest. */
function parseTune(str) {
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return str.trim().split(/\s+/).map(tk => {
    if (tk === '.') return 0;
    if (tk === '-') return -1;
    const m = /^([A-G])(#|b)?(\d)$/.exec(tk);
    return 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  });
}

// Bass root per bar (A minor: Am Am F G Am Am C Dm).
const ROOTS = [45, 45, 41, 43, 45, 45, 48, 38];
// Which 16ths the bass chugs on.
const CHUG = [1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1];
// The lead, 8 bars of 16ths.
const MELODY = parseTune(`
  E5 . . . . . . . D5 . . . C5 . . .   B4 . . . . . . . . . . . - . . .
  A4 . . . C5 . . . F5 . . . E5 . . .   D5 . . . . . . . - . . . B4 . D5 .
  E5 . . . . . A5 . . . . . G5 . E5 .   G5 . . . . . . . - . . . E5 . G5 .
  A5 . . . . . G5 . . . . . E5 . . .   F5 . . . . . . . E5 . . . . . . .
`);
