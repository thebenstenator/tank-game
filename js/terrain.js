'use strict';

/**
 * Pixel-mask terrain. mask[y*W+x] = 1 means solid dirt.
 * Rendering goes to an offscreen canvas; only "dirty" columns are recolored.
 * Floating dirt falls ("settles") a few pixels per frame, like the classic.
 */
class Terrain {
  constructor(theme) {
    this.theme = theme;
    this.mask = new Uint8Array(W * H);
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.pix = new Uint32Array(this.img.data.buffer);
    this.unsettled = new Uint8Array(W);
    this.dirty = new Uint8Array(W);
    this.anyDirty = false;
    this.anyUnsettled = false;

    // Static texture grain (chunky 3px blocks + fine noise)
    this.grain = new Int8Array(W * H);
    const bw = Math.ceil(W / 3) + 1;
    const bh = Math.ceil(H / 3) + 1;
    const coarse = new Int8Array(bw * bh);
    for (let i = 0; i < coarse.length; i++) coarse[i] = (Math.random() * 18 - 9) | 0;
    for (let y = 0; y < H; y++) {
      const row = ((y / 3) | 0) * bw;
      for (let x = 0; x < W; x++) {
        this.grain[y * W + x] = coarse[row + ((x / 3) | 0)] + ((Math.random() * 8 - 4) | 0);
      }
    }

    // Geological strata bands
    this.strata = new Float32Array(H);
    const ph = Math.random() * 10;
    for (let y = 0; y < H; y++) {
      this.strata[y] = Math.sin(y * 0.085 + Math.sin(y * 0.019 + ph) * 3) * 0.6 + Math.sin(y * 0.29 + ph) * 0.25;
    }
  }

  /** Builds the landscape. Returns the style actually used (resolves 'random'). */
  generate(style = 'wild') {
    if (style === 'random') style = pick(['gentle', 'hilly', 'mountains', 'wild', 'wild']);
    const hts = Terrain.heightmap(style);
    for (let x = 0; x < W; x++) {
      const top = Math.round(clamp(hts[x], H * 0.15, H * 0.95));
      for (let y = top; y < H; y++) this.mask[y * W + x] = 1;
    }
    for (let x = 0; x < W; x++) this.recolorColumn(x);
    this.ctx.putImageData(this.img, 0, 0);
    return style;
  }

  /** Surface y for every column. Larger y = lower ground. */
  static heightmap(style) {
    const hts = new Float32Array(W);
    if (style === 'gentle') {
      const n = fractalNoise1D(W, [[rand(500, 750), rand(50, 80)], [rand(200, 300), rand(18, 30)], [70, 6], [20, 1.5]]);
      const base = H * rand(0.6, 0.68);
      for (let x = 0; x < W; x++) hts[x] = base + n[x];
    } else if (style === 'hilly') {
      const rough = rand(0.7, 1.35);
      const n = fractalNoise1D(W, [[rand(420, 680), rand(110, 170)], [rand(170, 260), rand(40, 80) * rough], [rand(60, 90), 18 * rough], [24, 6 * rough], [9, 1.6]]);
      const base = H * rand(0.52, 0.62);
      for (let x = 0; x < W; x++) hts[x] = base + n[x];
    } else if (style === 'mountains') {
      // Ridged noise: sharp peaks where the noise crosses zero
      const n = fractalNoise1D(W, [[rand(280, 460), 1], [rand(110, 180), 0.45], [rand(40, 60), 0.15], [14, 0.04]]);
      let m = 0;
      for (let x = 0; x < W; x++) m = Math.max(m, Math.abs(n[x]));
      const amp = H * rand(0.6, 0.75);
      for (let x = 0; x < W; x++) {
        const v = 1 - Math.abs(n[x]) / m;
        hts[x] = H * 0.92 - Math.pow(v, 1.6) * amp;
      }
    } else {
      // Wild: midpoint displacement — jagged, unpredictable, stretched to fill the screen
      const N = 2048;
      const pts = new Float32Array(N + 1);
      pts[0] = rand(-1, 1);
      pts[N] = rand(-1, 1);
      const roughness = rand(0.52, 0.68);
      let disp = 1;
      for (let step = N; step > 1; step >>= 1) {
        const half = step >> 1;
        for (let i = half; i < N; i += step) pts[i] = (pts[i - half] + pts[i + half]) / 2 + rand(-disp, disp);
        disp *= roughness;
      }
      // Light smoothing so single-pixel spikes don't look like noise
      const sm = new Float32Array(N + 1);
      for (let i = 0; i <= N; i++) sm[i] = (pts[Math.max(0, i - 2)] + pts[Math.max(0, i - 1)] + pts[i] + pts[Math.min(N, i + 1)] + pts[Math.min(N, i + 2)]) / 5;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i <= N; i++) { lo = Math.min(lo, sm[i]); hi = Math.max(hi, sm[i]); }
      const yTop = H * rand(0.15, 0.3), yBot = H * rand(0.84, 0.95);
      for (let x = 0; x < W; x++) {
        const u = x * N / (W - 1), i = Math.min(N - 1, Math.floor(u)), f = u - i;
        const v = (sm[i] * (1 - f) + sm[i + 1] * f - lo) / (hi - lo || 1);
        hts[x] = yBot - v * (yBot - yTop);
      }
    }
    return hts;
  }

  isSolid(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return this.mask[(y | 0) * W + (x | 0)] === 1;
  }

  surfaceY(x) {
    x = Math.round(x);
    if (x < 0 || x >= W) return H;
    for (let y = 0, i = x; y < H; y++, i += W) if (this.mask[i]) return y;
    return H;
  }

  markRange(x0, x1, unsettle) {
    x0 = Math.max(0, x0); x1 = Math.min(W - 1, x1);
    for (let x = x0; x <= x1; x++) {
      this.dirty[x] = 1;
      if (unsettle) this.unsettled[x] = 1;
    }
    if (x1 >= x0) {
      this.anyDirty = true;
      if (unsettle) this.anyUnsettled = true;
    }
  }

  carve(cx, cy, r) { this._circle(cx, cy, r, 0); }
  addDirt(cx, cy, r) { this._circle(cx, cy, r, 1); }

  _circle(cx, cy, r, val) {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      for (let y = y0; y <= y1; y++) {
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.mask[y * W + x] = val;
      }
    }
    this.markRange(x0, x1, true);
  }

  /** Level a pad for a tank to sit on. Returns the pad's surface y. */
  flatten(x, hw) {
    const ty = Math.min(H - 24, this.surfaceY(x));
    const x0 = Math.max(0, x - hw), x1 = Math.min(W - 1, x + hw);
    for (let cx = x0; cx <= x1; cx++) {
      for (let y = 0; y < H; y++) this.mask[y * W + cx] = y >= ty ? 1 : 0;
    }
    this.markRange(x0, x1, false);
    return ty;
  }

  /** Let floating dirt fall. Returns true if anything moved. */
  settleStep(passes) {
    if (!this.anyUnsettled) return false;
    const m = this.mask;
    let movedAny = false;
    for (let x = 0; x < W; x++) {
      if (!this.unsettled[x]) continue;
      let moved = false;
      for (let p = 0; p < passes; p++) {
        let any = false;
        // bottom-up: each floating chunk drops exactly 1px per pass
        for (let i = (H - 2) * W + x; i >= 0; i -= W) {
          if (m[i] && !m[i + W]) { m[i] = 0; m[i + W] = 1; any = true; }
        }
        if (!any) break;
        moved = true;
      }
      if (moved) { movedAny = true; this.dirty[x] = 1; this.anyDirty = true; }
      else this.unsettled[x] = 0;
    }
    this.anyUnsettled = movedAny;
    return movedAny;
  }

  recolorColumn(x) {
    const { mask, pix, grain, strata } = this;
    const top = this.theme.top, mid = this.theme.mid, deep = this.theme.deep;
    let depth = 0;
    for (let y = 0, i = x; y < H; y++, i += W) {
      if (!mask[i]) { pix[i] = 0; depth = 0; continue; }
      let r, g, b;
      if (depth < 4) {
        const k = depth === 0 ? 1.15 : 1;
        r = top[0] * k; g = top[1] * k; b = top[2] * k;
      } else if (depth < 12) {
        const f = (depth - 4) / 8;
        r = top[0] + (mid[0] - top[0]) * f;
        g = top[1] + (mid[1] - top[1]) * f;
        b = top[2] + (mid[2] - top[2]) * f;
      } else {
        const f = Math.min(1, (depth - 12) / 260);
        const s = 1 + strata[y] * 0.11;
        r = (mid[0] + (deep[0] - mid[0]) * f) * s;
        g = (mid[1] + (deep[1] - mid[1]) * f) * s;
        b = (mid[2] + (deep[2] - mid[2]) * f) * s;
      }
      const n = grain[i];
      r += n; g += n; b += n;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      pix[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      depth++;
    }
  }

  /** Push changed columns to the canvas. */
  flush() {
    if (!this.anyDirty) return;
    let x0 = W, x1 = -1;
    for (let x = 0; x < W; x++) {
      if (!this.dirty[x]) continue;
      this.dirty[x] = 0;
      this.recolorColumn(x);
      if (x < x0) x0 = x;
      x1 = x;
    }
    this.anyDirty = false;
    if (x1 >= x0) this.ctx.putImageData(this.img, 0, 0, x0, 0, x1 - x0 + 1, H);
  }
}
