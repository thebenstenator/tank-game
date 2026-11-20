'use strict';

const TAU = Math.PI * 2;

function rand(a = 1, b) { return b === undefined ? Math.random() * a : a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
/** Approximate standard normal (mean 0, sd ~1). */
function randn() { return (Math.random() + Math.random() + Math.random() - 1.5) * 2; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function weightedPick(items) {
  let r = Math.random() * items.reduce((s, it) => s + it.weight, 0);
  for (const it of items) { r -= it.weight; if (r <= 0) return it; }
  return items[items.length - 1];
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbStr(rgb, k = 1, a = 1) {
  return `rgba(${Math.min(255, Math.round(rgb[0] * k))},${Math.min(255, Math.round(rgb[1] * k))},${Math.min(255, Math.round(rgb[2] * k))},${a})`;
}
function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

/** Smooth 1D fractal value noise. octaves: [[cellSize, amplitude], ...] */
function fractalNoise1D(width, octaves) {
  const out = new Float32Array(width);
  for (const [cell, amp] of octaves) {
    const n = Math.ceil(width / cell) + 2;
    const pts = new Float32Array(n);
    for (let i = 0; i < n; i++) pts[i] = Math.random() * 2 - 1;
    for (let x = 0; x < width; x++) {
      const u = x / cell, i = Math.floor(u), f = u - i;
      const s = (1 - Math.cos(f * Math.PI)) / 2;
      out[x] += (pts[i] * (1 - s) + pts[i + 1] * s) * amp;
    }
  }
  return out;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
