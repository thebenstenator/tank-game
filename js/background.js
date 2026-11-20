'use strict';

/** Pre-renders sky, stars, sun/moon/planet and parallax mountains at 2x. */
function renderBackground(theme) {
  // Render at roughly screen resolution (capped at 2x) to stay sharp without wasting memory.
  const S = clamp(Math.ceil(window.innerWidth * (window.devicePixelRatio || 1) / W * 4) / 4, 1, 2);
  const c = document.createElement('canvas');
  c.width = W * S;
  c.height = H * S;
  const g = c.getContext('2d');
  g.scale(S, S);

  const sky = g.createLinearGradient(0, 0, 0, H);
  for (const [o, col] of theme.sky) sky.addColorStop(o, col);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  if (theme.stars) {
    const n = Math.round(320 * theme.stars);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * W;
      const y = Math.pow(Math.random(), 1.5) * H * 0.75;
      const a = (0.25 + Math.random() * 0.75) * Math.max(0, 1 - y / (H * 0.8));
      const r = Math.random() < 0.06 ? rand(1.1, 1.6) : rand(0.3, 0.9);
      g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
  }

  const b = theme.body;
  if (b) {
    const bx = b.x * W, by = b.y * H;
    const glow = g.createRadialGradient(bx, by, b.r * 0.6, bx, by, b.r * 6);
    glow.addColorStop(0, b.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);

    if (b.type === 'planet') {
      const pg = g.createRadialGradient(bx - b.r * 0.4, by - b.r * 0.4, b.r * 0.1, bx, by, b.r);
      pg.addColorStop(0, '#ffe3ff');
      pg.addColorStop(0.5, b.color);
      pg.addColorStop(1, '#2a0e40');
      g.fillStyle = pg;
      g.beginPath(); g.arc(bx, by, b.r, 0, TAU); g.fill();
      g.save();
      g.beginPath(); g.arc(bx, by, b.r, 0, TAU); g.clip();
      for (let i = 0; i < 7; i++) {
        g.fillStyle = `rgba(255,255,255,${rand(0.03, 0.1).toFixed(3)})`;
        g.fillRect(bx - b.r, by - b.r + i * b.r / 3.5 + rand(-4, 4), b.r * 2, rand(3, 11));
      }
      g.restore();
      g.save();
      g.translate(bx, by); g.rotate(-0.35); g.scale(1, 0.26);
      g.strokeStyle = 'rgba(240,200,255,0.5)'; g.lineWidth = 7;
      g.beginPath(); g.arc(0, 0, b.r * 1.7, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(240,200,255,0.25)'; g.lineWidth = 3;
      g.beginPath(); g.arc(0, 0, b.r * 1.95, 0, TAU); g.stroke();
      g.restore();
    } else {
      g.fillStyle = b.color;
      g.beginPath(); g.arc(bx, by, b.r, 0, TAU); g.fill();
      if (b.type === 'moon') {
        for (let i = 0; i < 8; i++) {
          const a = rand(TAU), d = rand(0, 0.65) * b.r;
          g.fillStyle = 'rgba(110,125,160,0.2)';
          g.beginPath(); g.arc(bx + Math.cos(a) * d, by + Math.sin(a) * d, rand(0.08, 0.22) * b.r, 0, TAU); g.fill();
        }
      }
    }
  }

  // Parallax mountain silhouettes with atmospheric haze
  theme.mountains.forEach((col, i) => {
    const base = H * (0.44 + i * 0.12);
    const amp = 1 - i * 0.3;
    const n = fractalNoise1D(W + 2, [[rand(260, 380), 80 * amp], [rand(90, 140), 36 * amp], [rand(30, 45), 9 * amp], [12, 2.5]]);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 2) g.lineTo(x, base + n[x]);
    g.lineTo(W, H);
    g.closePath();
    g.fill();
    const hz = g.createLinearGradient(0, base - 100, 0, H);
    hz.addColorStop(0, 'rgba(0,0,0,0)');
    hz.addColorStop(1, theme.haze);
    g.fillStyle = hz;
    g.fillRect(0, base - 100, W, H);
  });

  return c;
}
