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
      const top = Math.round(clamp(hts[x], H * 0.12, H * 0.96));
      for (let y = top; y < H; y++) this.mask[y * W + x] = 1;
    }
    for (let x = 0; x < W; x++) this.recolorColumn(x);
    this.ctx.putImageData(this.img, 0, 0);
    return style;
  }

  /**
   * Surface y for every column. Larger y = lower ground.
   * Styles favour a few big features with smooth ground between them,
   * rather than lots of small bumps.
   */
  static heightmap(style) {
    const hts = new Float32Array(W);
    if (style === 'gentle') {
      const n = fractalNoise1D(W, [[rand(550, 800), rand(70, 110)], [rand(220, 320), rand(16, 28)], [90, 2.5]]);
      const base = H * rand(0.58, 0.66);
      for (let x = 0; x < W; x++) hts[x] = base + n[x];
    } else if (style === 'hilly') {
      const n = fractalNoise1D(W, [[rand(450, 700), rand(160, 230)], [rand(180, 260), rand(45, 80)], [rand(85, 110), 6]]);
      const base = H * rand(0.5, 0.6);
      for (let x = 0; x < W; x++) hts[x] = base + n[x];
    } else if (style === 'mountains') {
      // Ridged noise: sharp peaks where the noise crosses zero, smooth slopes between
      const n = fractalNoise1D(W, [[rand(300, 480), 1], [rand(120, 190), 0.3], [rand(55, 75), 0.04]]);
      let m = 0;
      for (let x = 0; x < W; x++) m = Math.max(m, Math.abs(n[x]));
      const amp = H * rand(0.7, 0.82);
      for (let x = 0; x < W; x++) {
        const v = 1 - Math.abs(n[x]) / m;
        hts[x] = H * 0.94 - Math.pow(v, 1.7) * amp;
      }
    } else {
      // Wild: midpoint displacement for an unpredictable skyline, stopped at coarse
      // detail and joined with smooth curves, then stretched so peaks reach near the
      // ceiling and valleys near the floor.
      const N = 32;
      const pts = new Float32Array(N + 1);
      pts[0] = rand(-1, 1);
      pts[N] = rand(-1, 1);
      const roughness = rand(0.55, 0.68);
      let disp = 1;
      for (let step = N; step > 1; step >>= 1) {
        const half = step >> 1;
        for (let i = half; i < N; i += step) pts[i] = (pts[i - half] + pts[i + half]) / 2 + rand(-disp, disp);
        disp *= roughness;
      }
      let lo = Infinity, hi = -Infinity;
      for (const v of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      // Normalise to 0..1, then push values away from the middle: taller peaks, deeper pits.
      for (let i = 0; i <= N; i++) {
        const v = (pts[i] - lo) / (hi - lo || 1) * 2 - 1;
        pts[i] = (Math.sign(v) * Math.pow(Math.abs(v), 0.75) + 1) / 2;
      }
      const yTop = H * rand(0.12, 0.2), yBot = H * rand(0.88, 0.95);
      const P = i => pts[clamp(i, 0, N)];
      for (let x = 0; x < W; x++) { // Catmull-Rom spline through the control points
        const u = x * N / (W - 1), i = Math.min(N - 1, Math.floor(u)), t = u - i;
        const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
        const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        hts[x] = yBot - clamp(v, -0.05, 1.05) * (yBot - yTop);
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
      if (unsettle) { this.anyUnsettled = true; this.changed = true; }
    }
  }

  carve(cx, cy, r) { this._circle(cx, cy, r, 0); }

  /**
   * Cut a straight channel of half-width r (the laser). Every column loses exactly the
   * same number of pixels, so the dirt that drops into it keeps a smooth top instead
   * of the 1px zig-zag a row of stamped circles would leave.
   */
  carveBand(x0, y0, x1, y1, r) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    if (Math.abs(dx / len) < 0.35) { // steep: columns are few, stamped circles are fine
      for (let d = 0; d <= len; d += 3) this._circle(x0 + dx * d / len, y0 + dy * d / len, r, 0);
      return;
    }
    const slope = dy / dx, h = r * len / Math.abs(dx); // vertical half-thickness of the band
    const n = Math.max(1, Math.round(2 * h));
    const xa = Math.max(0, Math.ceil(Math.min(x0, x1))), xb = Math.min(W - 1, Math.floor(Math.max(x0, x1)));
    for (let x = xa; x <= xb; x++) {
      const ys = Math.round(y0 + (x - x0) * slope - h);
      for (let y = Math.max(0, ys), ye = Math.min(H, ys + n); y < ye; y++) this.mask[y * W + x] = 0;
    }
    if (xb >= xa) this.markRange(xa, xb, true);
    this._circle(x1, y1, r, 0); // rounded tip where the beam ends
  }
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

  /**
   * Compact column-by-column encoding of the solid dirt: for each column, the number of
   * solid runs followed by [start, end) pairs. Used to send the battlefield online.
   */
  toRuns() {
    const out = [];
    for (let x = 0; x < W; x++) {
      const at = out.length;
      out.push(0);
      let inRun = false;
      for (let y = 0, i = x; y < H; y++, i += W) {
        if (this.mask[i] && !inRun) { out.push(y); inRun = true; }
        else if (!this.mask[i] && inRun) { out.push(y); inRun = false; out[at]++; }
      }
      if (inRun) { out.push(H); out[at]++; }
    }
    return out;
  }

  /** Replace the dirt with a toRuns() encoding. Only columns that differ are touched. Returns how many changed. */
  fromRuns(runs) {
    let k = 0, changed = 0;
    for (let x = 0; x < W; x++) {
      const n = runs[k++];
      let y = 0, diff = false;
      for (let r = 0; r < n; r++) {
        const y0 = runs[k++], y1 = runs[k++];
        for (; y < y0; y++) { const i = y * W + x; if (this.mask[i]) { this.mask[i] = 0; diff = true; } }
        for (; y < y1; y++) { const i = y * W + x; if (!this.mask[i]) { this.mask[i] = 1; diff = true; } }
      }
      for (; y < H; y++) { const i = y * W + x; if (this.mask[i]) { this.mask[i] = 0; diff = true; } }
      this.unsettled[x] = 0;
      if (diff) { this.dirty[x] = 1; changed++; }
    }
    this.anyUnsettled = false;
    if (changed) this.anyDirty = true;
    return changed;
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
