'use strict';

function buyItem(t, id) {
  const e = shopEntry(id);
  if (!e || t.money < e.price) return false;
  t.money -= e.price;
  t.inventory[id] = (t.inventory[id] || 0) + e.bundle;
  return true;
}

class Tank {
  constructor(def, index, money) {
    this.index = index;
    this.name = def.name;
    this.color = def.color;
    this.rgb = hexToRgb(def.color);
    this.ai = def.ai || null;
    this.money = money;
    this.inventory = {};
    this.wins = 0;
    this.kills = 0;
    this.resetForRound();
  }

  resetForRound() {
    this.health = 100;
    this.alive = true;
    this.shield = 0;
    this.falling = false;
    this.vy = 0;
    this.fallDist = 0;
    this.parachuting = false;
    this.lastTrail = null;
    this.lastHitBy = null;
    this.weapon = 'baby';
    this.angle = 60;
    this.power = 500;
    this.x = 0;
    this.y = 0;
    this.smokeT = 0;
  }

  // Damage still costs power, but gently enough that a wounded tank can fight back.
  get maxPower() { return Math.round(500 + Math.max(0, this.health) * 5); }
  ammo(id) { return id === 'baby' ? Infinity : (this.inventory[id] || 0); }

  muzzle(angle = this.angle) {
    const a = angle * DEG;
    return { x: this.x + Math.cos(a) * 19, y: this.y - 11 - Math.sin(a) * 19 };
  }

  hitTest(x, y) {
    if (!this.alive) return false;
    if (this.shield > 0) {
      const dx = x - this.x, dy = y - (this.y - 8);
      return dx * dx + dy * dy < 26 * 26;
    }
    return x >= this.x - 14 && x <= this.x + 14 && y >= this.y - 17 && y <= this.y + 1;
  }

  cycleWeapon(dir) {
    const list = WEAPON_ORDER.filter(id => this.ammo(id) > 0);
    let i = list.indexOf(this.weapon);
    if (i < 0) i = 0;
    this.weapon = list[(i + dir + list.length) % list.length];
  }
}

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'setup';
    this.players = [];
    this.projectiles = [];
    this.explosions = [];
    this.particles = [];
    this.floaters = [];
    this.timers = [];
    this.dust = [];
    this.keys = {};
    this.fine = false;
    this.shake = 0;
    this.flash = 0;
    this.time = 0;
    this.acc = 0;
    this.wind = 0;
    this.windMax = 0;
    this.current = null;
    this.ai = null;
    this.view = { dpr: 1, scale: 1, ox: 0, oy: 0 };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth, ch = window.innerHeight;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    const s = Math.min(cw / W, ch / H);
    this.view = { dpr, scale: s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2 };
  }

  // ---------------------------------------------------------------- setup

  /** Ambient scene behind the main menu. */
  preview() {
    this.state = 'setup';
    this.players = [];
    this.current = null;
    this.clearEffects();
    this.setTheme(pick(THEMES), 'random');
    this.wind = randInt(-15, 15);
  }

  setTheme(theme, terrainStyle) {
    fitWorldToWindow();
    this.resize();
    this.theme = theme;
    this.terrain = new Terrain(theme);
    this.terrainStyle = this.terrain.generate(terrainStyle);
    this.bg = renderBackground(theme);
    this.initDust();
  }

  clearEffects() {
    this.projectiles = [];
    this.explosions = [];
    this.particles = [];
    this.floaters = [];
    this.timers = [];
    this.shake = 0;
    this.flash = 0;
  }

  /** Run fn after `delay` seconds of game time. The turn won't end while timers are pending. */
  schedule(delay, fn) { this.timers.push({ t: delay, fn }); }

  updateTimers(dt) {
    if (!this.timers.length) return;
    const due = [];
    for (const tm of this.timers) { tm.t -= dt; if (tm.t <= 0) due.push(tm); }
    if (due.length) {
      this.timers = this.timers.filter(tm => tm.t > 0);
      due.forEach(tm => tm.fn());
    }
  }

  startMatch(defs, settings) {
    this.settings = settings;
    this.players = defs.map((d, i) => new Tank(d, i, settings.money));
    this.round = 0;
    this.startRound();
  }

  startRound() {
    this.round++;
    let theme = pick(THEMES);
    while (THEMES.length > 1 && theme === this.theme) theme = pick(THEMES);
    this.clearEffects();
    this.setTheme(theme, this.settings.terrain);
    this.players.forEach(p => p.resetForRound());
    this.placeTanks();
    this.order = shuffle(this.players.slice());
    this.turnPos = -1;
    this.turnCount = 0;
    const lvl = WIND_LEVELS[this.settings.wind] || WIND_LEVELS.none;
    this.windMax = lvl.max;
    this.windShift = lvl.shift;
    this.wind = this.windMax ? randInt(-this.windMax, this.windMax) : 0;
    this.nextTurn();
    const styleName = { gentle: 'Gentle', hilly: 'Hilly', mountains: 'Mountainous', wild: 'Wild' }[this.terrainStyle];
    UI.toast(`Round ${this.round} of ${this.settings.rounds}`, `${theme.name} · ${styleName} terrain`, 2200);
  }

  placeTanks() {
    const n = this.players.length;
    const slots = shuffle([...Array(n).keys()]);
    const slotW = (W - 80) / n;
    this.players.forEach((p, i) => {
      const s = slots[i];
      p.x = Math.round(clamp(40 + slotW * (s + 0.5) + rand(-slotW * 0.22, slotW * 0.22), 24, W - 24));
      p.y = this.terrain.flatten(p.x, 16);
      p.angle = p.x < W / 2 ? 60 : 120;
      p.power = 500;
    });
  }

  // ---------------------------------------------------------------- turns

  nextTurn() {
    const n = this.order.length;
    for (let k = 0; k < n; k++) {
      this.turnPos = (this.turnPos + 1) % n;
      if (this.order[this.turnPos].alive) break;
    }
    const t = this.current = this.order[this.turnPos];
    if (this.windMax && this.settings.windChange && this.turnCount > 0) {
      this.wind = clamp(this.wind + randInt(-this.windShift, this.windShift), -this.windMax, this.windMax);
    }
    this.turnCount++;
    this.state = 'aim';
    this.keys = {};
    this.ai = t.ai ? { timer: 0, plan: null, wait: 0 } : null;
    if (t.ammo(t.weapon) <= 0) t.weapon = 'baby';
    t.power = Math.min(t.power, t.maxPower);
    Sound.turn(!t.ai);
    UI.banner(`${t.name}'s turn${t.ai ? ' · CPU' : ''}`, t.color);
  }

  endTurn() {
    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1) { this.finishRound(alive[0] || null); return; }
    this.nextTurn();
  }

  finishRound(winner) {
    this.state = 'roundEnding';
    this.endTimer = 2.0;
    this.roundWinner = winner;
    this.players.forEach(p => { p.money += 1000; });
    if (winner) { winner.wins++; winner.money += 5000; }
    UI.toast(winner ? `${winner.name} wins the round` : 'Total annihilation',
      winner ? '+$5,000 victory bonus' : 'No survivors', 2000);
    Sound.win();
  }

  get humanTurn() { return this.state === 'aim' && this.current && !this.current.ai; }

  cycleWeapon(dir) {
    if (!this.humanTurn) return;
    this.current.cycleWeapon(dir);
    Sound.click();
  }

  nudgePower(d) {
    if (!this.humanTurn) return;
    const t = this.current;
    t.power = clamp(Math.round(t.power + d), 0, t.maxPower);
  }

  activateShield(t) {
    if (this.state !== 'aim' || t !== this.current) return;
    if ((t.inventory.shield || 0) <= 0 || t.shield > 0) return;
    t.inventory.shield--;
    t.shield = 100;
    Sound.shield(t.x);
    for (let i = 0; i < 24; i++) {
      const a = rand(TAU);
      this.spawn({ type: 'glow', x: t.x + Math.cos(a) * 26, y: t.y - 8 + Math.sin(a) * 26, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20, life: 0.6, size: 2.5, rgb: [140, 235, 255] });
    }
  }

  fire() {
    if (this.state !== 'aim') return;
    const t = this.current;
    let wid = t.weapon;
    if (t.ammo(wid) <= 0) wid = 'baby';
    if (wid !== 'baby') t.inventory[wid]--;
    const w = WEAPONS[wid];
    const m = t.muzzle();
    const sp = muzzleSpeed(t.power);
    const a = t.angle * DEG;
    const p = this.makeProjectile(m.x, m.y, Math.cos(a) * sp, -Math.sin(a) * sp, w, t, 'shell');
    t.lastTrail = [{ x: m.x, y: m.y }];
    p.trailRec = t.lastTrail;
    this.projectiles.push(p);
    this.state = 'resolve';
    this.resolveTimer = 0;
    this.ai = null;
    this.keys = {};
    if (t.ammo(wid) <= 0) t.weapon = 'baby';

    Sound.fire(w.radius / 110, m.x);
    this.shake = Math.max(this.shake, 2.5);
    for (let i = 0; i < 14; i++) {
      const aa = a + rand(-0.35, 0.35), s = rand(80, 240);
      this.spawn({ type: 'spark', x: m.x, y: m.y, vx: Math.cos(aa) * s, vy: -Math.sin(aa) * s, life: rand(0.15, 0.35), size: 1.6, drag: 3, rgb: [255, 220, 150] });
    }
    for (let i = 0; i < 6; i++) {
      this.spawn({ type: 'smoke', x: m.x, y: m.y, vx: Math.cos(a) * rand(20, 60) + rand(-15, 15), vy: -Math.sin(a) * rand(20, 60) + rand(-15, 15), life: rand(0.8, 1.4), size: 4, grow: 2.5, drag: 1.5, rgb: [190, 190, 200], alpha: 0.35, windF: 0.6 });
    }
  }

  makeProjectile(x, y, vx, vy, w, owner, kind) {
    return {
      x, y, vx, vy, w, owner, kind,
      age: 0, trail: [], dead: false, cleared: false,
      radius: w.radius, damage: w.damage, bounces: w.bounces || 0,
      ignoreTank: null, ignoreT: 0, hue: null, smokeT: 0, rec: 0,
    };
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    this.time += dt;
    if (!this.terrain) return;
    this.settling = false;

    if (this.state === 'aim') this.updateAim(dt);
    this.updateTimers(dt);

    this.acc += dt;
    let n = 0;
    while (this.acc >= PHYS_DT) {
      this.acc -= PHYS_DT;
      if (n++ < 12) this.physicsTick(PHYS_DT);
    }

    if (this.state === 'resolve') this.updateResolve(dt);
    else if (this.state === 'roundEnding') {
      this.settle(dt);
      this.endTimer -= dt;
      if (this.endTimer <= 0) { this.state = 'roundOver'; UI.showRoundOver(this); }
    } else if (this.state === 'roundOver') this.settle(dt);

    this.updateEffects(dt);
    this.terrain.flush();
    Sound.update(this, dt);
  }

  heldState(code, dt) {
    const s = this.keys[code];
    if (!s) return 0;
    if (!s.started) { s.started = true; return 'tap'; }
    s.t += dt;
    return s.t > 0.28 ? 'hold' : 0;
  }

  updateAim(dt) {
    const t = this.current;
    if (t.ai) { this.updateAI(dt); return; }
    const fine = this.fine;
    const adj = (code, tap, rate, prop, sign) => {
      const h = this.heldState(code, dt);
      if (h === 'tap') t[prop] = Math.round(t[prop]) + tap * sign;
      else if (h === 'hold') t[prop] += rate * dt * sign;
    };
    adj('ArrowLeft', 1, fine ? 8 : 50, 'angle', 1);
    adj('ArrowRight', 1, fine ? 8 : 50, 'angle', -1);
    adj('ArrowUp', fine ? 1 : 5, fine ? 40 : 350, 'power', 1);
    adj('ArrowDown', fine ? 1 : 5, fine ? 40 : 350, 'power', -1);
    t.angle = clamp(t.angle, 0, 180);
    t.power = clamp(t.power, 0, t.maxPower);
  }

  updateAI(dt) {
    const t = this.current, ai = this.ai;
    ai.timer += dt;
    if (!ai.plan) {
      if (ai.timer < 0.4) return;
      ai.plan = AI.plan(this, t);
      if (ai.plan.shield) this.activateShield(t);
      t.weapon = ai.plan.weapon;
      return;
    }
    const p = ai.plan;
    const da = p.angle - t.angle, sa = 80 * dt;
    t.angle = Math.abs(da) <= sa ? p.angle : t.angle + Math.sign(da) * sa;
    const dp = p.power - t.power, sp = 650 * dt;
    t.power = Math.abs(dp) <= sp ? p.power : t.power + Math.sign(dp) * sp;
    if (t.angle === p.angle && t.power === p.power) {
      ai.wait += dt;
      if (ai.wait > 0.35) this.fire();
    }
  }

  // ---------------------------------------------------------------- physics

  physicsTick(dt) {
    const list = this.projectiles.slice();
    for (const p of list) if (!p.dead) this.stepProjectile(p, dt);
    this.projectiles = this.projectiles.filter(p => !p.dead);
  }

  stepProjectile(p, dt) {
    p.age += dt;
    if (p.age > 20) { p.dead = true; return; }
    if (p.kind === 'roll') { this.stepRoller(p, dt); return; }

    p.vx += this.wind * WIND_SCALE * dt;
    p.vy += GRAVITY * dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;

    if (!p.cleared) {
      const dx = nx - p.owner.x, dy = ny - (p.owner.y - 8);
      if (dx * dx + dy * dy > 34 * 34) p.cleared = true;
    }
    let ignore = p.cleared ? null : p.owner;
    if (p.ignoreT > 0) { p.ignoreT -= dt; ignore = p.ignoreTank; }

    const hit = this.trace(p.x, p.y, nx, ny, ignore);
    if (hit) {
      p.x = hit.x; p.y = hit.y;
      this.recordTrail(p);
      this.impact(p, hit);
      return;
    }
    p.x = nx; p.y = ny;
    this.recordTrail(p);

    if (p.w.behavior === 'mirv' && p.kind === 'shell' && p.vy > 0 && p.age > 0.2) {
      this.splitMirv(p);
      return;
    }
    if (p.y > H + 40 || p.x < -400 || p.x > W + 400) p.dead = true;
  }

  recordTrail(p) {
    p.trail.push({ x: p.x, y: p.y });
    if (p.trail.length > 26) p.trail.shift();
    if (p.trailRec && (p.rec++ % 3 === 0)) p.trailRec.push({ x: p.x, y: p.y });
  }

  /** Walk the segment in ~1.5px steps; return the first tank or ground hit. */
  trace(x0, y0, x1, y1, ignore) {
    const dx = x1 - x0, dy = y1 - y0;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 1.5));
    for (let i = 1; i <= n; i++) {
      const x = x0 + dx * i / n, y = y0 + dy * i / n;
      for (const t of this.players) {
        if (t !== ignore && t.hitTest(x, y)) return { x, y, tank: t };
      }
      if (this.terrain.isSolid(x, y)) return { x, y, ground: true };
    }
    return null;
  }

  /** Predict where a shot lands (used by the AI). Same integrator as the real thing. */
  simulate(t, angle, power) {
    const a = angle * DEG;
    const m = t.muzzle(angle);
    let x = m.x, y = m.y;
    const sp = muzzleSpeed(power);
    let vx = Math.cos(a) * sp, vy = -Math.sin(a) * sp;
    let cleared = false;
    const wind = this.wind * WIND_SCALE, dt = PHYS_DT;
    for (let i = 0; i < 2400; i++) {
      vx += wind * dt;
      vy += GRAVITY * dt;
      const nx = x + vx * dt, ny = y + vy * dt;
      if (!cleared) {
        const dx = nx - t.x, dy = ny - (t.y - 8);
        if (dx * dx + dy * dy > 34 * 34) cleared = true;
      }
      const hit = this.trace(x, y, nx, ny, cleared ? null : t);
      if (hit) return hit;
      x = nx; y = ny;
      if (y > H + 40 || x < -400 || x > W + 400) return null;
    }
    return null;
  }

  splitMirv(p) {
    p.dead = true;
    const n = p.w.count;
    for (let i = 0; i < n; i++) {
      const off = i - (n - 1) / 2;
      const q = this.makeProjectile(p.x, p.y, p.vx + off * 42, p.vy, p.w, p.owner, 'bomblet');
      q.cleared = true;
      this.projectiles.push(q);
    }
    Sound.pop(p.x);
    for (let i = 0; i < 16; i++) {
      const a = rand(TAU), s = rand(40, 140);
      this.spawn({ type: 'spark', x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.2, 0.4), size: 1.4, drag: 2, rgb: [150, 220, 255] });
    }
  }

  impact(p, hit) {
    const w = p.w;
    const b = p.kind === 'bomblet' ? null : w.behavior;

    if (b === 'roller' && hit.ground) {
      if (this.startRoll(p, hit)) return;
    }
    p.dead = true;

    if (b === 'dirt') { this.dirtBlast(hit.x, hit.y, p.radius); return; }

    this.explode(hit.x, hit.y, p.radius, p.damage, p.owner);

    if (b === 'funky') {
      Sound.pop(hit.x);
      for (let i = 0; i < w.count; i++) {
        const q = this.makeProjectile(hit.x, hit.y - 4, rand(-260, 260), rand(-480, -220), w, p.owner, 'bomblet');
        q.radius = 26; q.damage = 32; q.cleared = true;
        q.hue = (i * 360 / w.count) | 0;
        q.ignoreTank = hit.tank || null; q.ignoreT = hit.tank ? 0.25 : 0;
        this.projectiles.push(q);
      }
    } else if (b === 'leapfrog' && p.bounces > 1) {
      const q = this.makeProjectile(hit.x, hit.y - p.radius * 0.5, p.vx * 0.65, -Math.max(180, Math.abs(p.vy) * 0.6), w, p.owner, 'shell');
      q.bounces = p.bounces - 1;
      q.radius = p.radius * 0.88;
      q.damage = p.damage * 0.9;
      q.cleared = true;
      q.ignoreTank = hit.tank || null; q.ignoreT = hit.tank ? 0.25 : 0;
      this.projectiles.push(q);
    }
  }

  startRoll(p, hit) {
    const x = Math.round(hit.x);
    const sy = this.terrain.surfaceY(x);
    if (sy < hit.y - 10) return false; // hit a cliff face — just explode
    const l = this.terrain.surfaceY(x - 5), r = this.terrain.surfaceY(x + 5);
    p.dir = l > r ? -1 : r > l ? 1 : (Math.sign(p.vx) || 1);
    p.kind = 'roll';
    p.rollSpeed = clamp(60 + Math.abs(p.vx) * 0.3, 60, 220);
    p.rollT = 0;
    p.x = hit.x;
    p.y = sy - 3;
    p.vx = 0; p.vy = 0;
    return true;
  }

  stepRoller(p, dt) {
    p.rollT += dt;
    const nx = p.x + p.dir * p.rollSpeed * dt;
    if (nx < 0 || nx >= W) { p.dead = true; return; }
    const ground = p.y + 3;
    const sy = this.terrain.surfaceY(Math.round(nx));
    const boom = () => { p.dead = true; this.explode(p.x, p.y, p.radius, p.damage, p.owner); };

    for (const t of this.players) {
      if (t.hitTest(nx, p.y - 2) && (p.cleared || t !== p.owner)) { p.x = nx; boom(); return; }
    }
    if (Math.hypot(nx - p.owner.x, p.y - p.owner.y) > 34) p.cleared = true;

    if (sy < ground - 1.5 || p.rollT > 6) { boom(); return; } // reached a valley / wall
    if (sy > ground + 6) {               // rolled off a ledge — fall again
      p.x = nx;
      p.kind = 'shell';
      p.vx = p.dir * p.rollSpeed;
      p.vy = 0;
      return;
    }
    p.rollSpeed = clamp(p.rollSpeed + (sy - ground) * 30, 40, 260);
    p.x = nx;
    p.y = sy - 3;
    this.recordTrail(p);
  }

  explode(x, y, radius, damage, owner, opts = {}) {
    this.terrain.carve(x, y, radius);

    for (const t of this.players) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - x, (t.y - 7) - y);
      const reach = radius + 14;
      if (d >= reach) continue;
      const f = clamp(1 - Math.max(0, d - 8) / reach, 0, 1);
      this.damageTank(t, damage * f, owner);
    }

    this.explosions.push({ x, y, r: radius, t: 0, dur: 0.45 + radius / 260 });
    const big = radius / 60;
    const ns = Math.round(14 + radius * 0.7);
    const fire = [[255, 245, 210], [255, 200, 100], [255, 130, 50]];
    for (let i = 0; i < ns; i++) {
      const a = rand(TAU), s = rand(80, 260) * (0.5 + big);
      this.spawn({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: rand(0.3, 0.8), size: rand(1, 2.2), g: 300, drag: 1.5, rgb: pick(fire) });
    }
    for (let i = 0; i < ns / 3; i++) {
      const a = rand(TAU), s = rand(30, 120) * (0.6 + big);
      this.spawn({ type: 'glow', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: rand(0.8, 1.6), size: rand(1.8, 3.5), g: 120, drag: 0.8, rgb: pick(fire) });
    }
    const T = this.theme;
    for (let i = 0; i < radius * 0.5; i++) {
      const src = Math.random() < 0.3 ? T.top : T.mid;
      const k = rand(0.7, 1.15);
      this.spawn({ type: 'debris', x: x + rand(-radius / 2, radius / 2), y: y + rand(-radius / 3, radius / 3), vx: rand(-1, 1) * radius * 4, vy: -rand(100, 120 + radius * 6), life: rand(1.5, 2.5), size: rand(1.5, 3.5), g: 520, rgb: [src[0] * k, src[1] * k, src[2] * k] });
    }
    for (let i = 0; i < 4 + radius / 8; i++) {
      this.spawn({ type: 'smoke', x: x + rand(-radius / 2, radius / 2), y: y + rand(-radius / 2, radius / 3), vx: rand(-20, 20), vy: -rand(10, 40), life: rand(1.2, 2.4) * (0.6 + radius / 100), size: radius * rand(0.25, 0.45), grow: 1.2, drag: 0.5, rgb: [38, 34, 38], alpha: 0.55, windF: 0.6 });
    }
    this.shake = Math.min(26, this.shake + radius / 6);
    if (radius >= 55) this.flash = Math.max(this.flash, Math.min(1, radius / 110));
    Sound.boom(radius / 110, x);
  }

  dirtBlast(x, y, r) {
    this.terrain.addDirt(x, y, r);
    const T = this.theme;
    for (let i = 0; i < 30; i++) {
      const a = rand(TAU), d = rand(r);
      this.spawn({ type: 'debris', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * rand(40, 140), vy: Math.sin(a) * rand(40, 140) - 60, life: rand(0.6, 1.2), size: rand(2, 4), g: 400, rgb: T.top });
    }
    for (let i = 0; i < 8; i++) {
      this.spawn({ type: 'smoke', x: x + rand(-r, r), y: y + rand(-r, 0), vx: rand(-20, 20), vy: -rand(10, 30), life: rand(1, 1.8), size: r * 0.4, grow: 1, rgb: T.mid, alpha: 0.4, windF: 0.5 });
    }
    this.shake = Math.min(20, this.shake + 4);
    Sound.thud(x);
  }

  damageTank(t, amount, by) {
    if (!t.alive || amount <= 0) return;
    if (t.shield > 0) {
      const ab = Math.min(t.shield, amount);
      t.shield -= ab;
      amount -= ab;
      if (t.shield <= 0.5) {
        t.shield = 0;
        Sound.shieldBreak(t.x);
        for (let i = 0; i < 30; i++) {
          const a = rand(TAU);
          this.spawn({ type: 'spark', x: t.x + Math.cos(a) * 26, y: t.y - 8 + Math.sin(a) * 26, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, life: 0.4, size: 1.5, drag: 2, rgb: [140, 235, 255] });
        }
      }
    }
    if (amount < 0.5) { if (t.shield > 0) Sound.shieldHit(t.x); return; }
    const before = t.health;
    t.health = Math.max(0, t.health - amount);
    const dealt = before - t.health;
    Sound.clank(t.x, dealt / 60);
    if (by && by !== t) by.money += Math.round(dealt * 15);
    if (by) t.lastHitBy = by;
    t.power = Math.min(t.power, t.maxPower);
    this.floaters.push({ x: t.x + rand(-6, 6), y: t.y - 30, text: `-${Math.round(dealt)}`, rgb: [255, 130, 110], t: 0, dur: 1.2, size: 15 });
  }

  killTank(t) {
    t.alive = false;
    t.health = 0;
    t.shield = 0;
    const k = t.lastHitBy;
    if (k && k !== t) { k.kills++; k.money += 2000; }
    // Collateral damage from the death blast is credited to whoever caused it.
    const by = k || t;
    const x = t.x, y = t.y - 6;
    const fx = weightedPick(DEATH_EFFECTS);
    this.floaters.push({ x, y: t.y - 44, text: fx.label, rgb: [255, 255, 255], t: 0, dur: 1.8, size: fx.id === 'meltdown' ? 18 : 14 });

    switch (fx.id) {
      case 'fizzle': // a sad pop and a lot of smoke
        this.explode(x, y, 16, 12, by);
        Sound.fizzle(x);
        for (let i = 0; i < 14; i++) {
          this.spawn({ type: 'smoke', x: x + rand(-8, 8), y, vx: rand(-15, 15), vy: -rand(20, 60), life: rand(1.5, 2.5), size: rand(5, 9), grow: 2, drag: 0.6, rgb: [45, 42, 46], alpha: 0.6, windF: 0.5 });
        }
        break;

      case 'blast':
        this.explode(x, y, 42, 45, by);
        this.tankSparks(t, 40);
        break;

      case 'bigboom':
        this.explode(x, y, 78, 75, by);
        this.tankSparks(t, 80);
        break;

      case 'shrapnel': // explodes and throws burning fragments that blow up where they land
        this.explode(x, y, 26, 30, by);
        this.tankSparks(t, 30);
        for (let i = 0, n = randInt(7, 10); i < n; i++) {
          const a = -Math.PI / 2 + rand(-1.25, 1.25), s = rand(110, 440);
          const q = this.makeProjectile(x, y - 6, Math.cos(a) * s, Math.sin(a) * s, SHRAPNEL, by, 'bomblet');
          q.cleared = true;
          this.projectiles.push(q);
        }
        break;

      case 'cookoff': { // stored ammo goes off in a rapid chain, then one last big blast
        this.explode(x, y, 14, 10, by);
        let tt = 0;
        for (let i = 0, n = randInt(4, 6); i < n; i++) {
          tt += rand(0.13, 0.24);
          this.schedule(tt, () => this.explode(x + rand(-30, 30), y + rand(-16, 6), rand(16, 28), rand(18, 28), by));
        }
        this.schedule(tt + 0.3, () => { this.explode(x, y, 50, 55, by); this.tankSparks(t, 40); });
        break;
      }

      case 'meltdown': { // reactor charge-up, then a nuke-sized blast and a mushroom cloud
        const charge = 0.85;
        this.explode(x, y, 12, 8, by);
        this.explosions.push({ x, y, r: 0, t: 0, dur: charge, charge: true });
        Sound.charge(charge, x);
        for (let i = 0; i < 30; i++) {
          const a = rand(TAU), d = rand(40, 90), life = rand(0.4, charge);
          this.spawn({ type: 'glow', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: -Math.cos(a) * d / life, vy: -Math.sin(a) * d / life, life, size: 2, rgb: [255, 250, 200] });
        }
        this.schedule(charge, () => {
          this.explode(x, y, 115, 100, by);
          this.mushroom(x, y);
          this.tankSparks(t, 90);
          this.flash = 1;
        });
        break;
      }
    }
    this.flash = Math.max(this.flash, 0.4);
  }

  tankSparks(t, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(TAU), s = rand(100, 320) * (0.6 + n / 80);
      this.spawn({ type: 'glow', x: t.x, y: t.y - 8, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: rand(0.8, 1.5), size: rand(2, 3.5), g: 260, drag: 1, rgb: t.rgb });
    }
  }

  mushroom(x, y) {
    for (let i = 0; i < 45; i++) { // stem
      this.spawn({ type: 'smoke', x: x + rand(-10, 10), y: y - rand(0, 20), vx: rand(-10, 10), vy: -rand(60, 210), drag: 1.2, life: rand(2.5, 3.6), size: rand(9, 16), grow: 1.4, rgb: [70, 50, 42], alpha: 0.6, windF: 0.25 });
    }
    for (let i = 0; i < 36; i++) { // cap
      const a = rand(TAU), d = rand(10, 55);
      this.spawn({ type: 'smoke', x: x + Math.cos(a) * d, y: y - rand(115, 160) + Math.sin(a) * d * 0.35, vx: Math.cos(a) * rand(25, 70), vy: -rand(10, 35), drag: 0.8, life: rand(2.8, 3.8), size: rand(14, 24), grow: 1.4, rgb: [92, 60, 48], alpha: 0.55, windF: 0.3 });
    }
    for (let i = 0; i < 40; i++) { // glowing embers in the cloud
      this.spawn({ type: 'glow', x: x + rand(-40, 40), y: y - rand(60, 150), vx: rand(-30, 30), vy: -rand(10, 50), drag: 0.8, life: rand(1, 2.2), size: rand(1.5, 3), rgb: [255, rand(120, 200), 60], windF: 0.3 });
    }
  }

  isSupported(t) {
    const y = Math.round(t.y);
    for (let cx = t.x - 7; cx <= t.x + 7; cx++) if (this.terrain.isSolid(cx, y)) return true;
    return false;
  }

  updateTankFalls(dt) {
    let any = false;
    for (const t of this.players) {
      if (t.y > H + 30) continue;
      if (this.isSupported(t)) {
        if (t.falling) this.land(t);
        continue;
      }
      any = true;
      if (!t.falling) { t.falling = true; t.vy = 0; t.fallDist = 0; }
      if (t.alive && !t.parachuting && t.fallDist > 14 && (t.inventory.parachute || 0) > 0) {
        t.inventory.parachute--;
        t.parachuting = true;
        Sound.chute(t.x);
      }
      t.vy = t.parachuting ? 70 : Math.min(t.vy + GRAVITY * 1.4 * dt, 600);
      let move = t.vy * dt;
      while (move > 0) {
        const step = Math.min(1, move);
        t.y += step;
        t.fallDist += step;
        move -= step;
        if (this.isSupported(t)) { this.land(t); break; }
        if (t.y > H + 30) { if (t.alive) t.health = 0; t.falling = false; break; }
      }
    }
    return any;
  }

  land(t) {
    t.falling = false;
    t.y = Math.round(t.y);
    if (t.fallDist > 6) Sound.land(t.x, t.parachuting ? 0.1 : clamp(t.fallDist / 120, 0.15, 1));
    if (t.alive && !t.parachuting && t.fallDist > 18) {
      this.damageTank(t, Math.min(60, (t.fallDist - 18) * 0.6), t.lastHitBy);
    }
    if (t.fallDist > 6) {
      for (let i = 0; i < 10; i++) {
        this.spawn({ type: 'smoke', x: t.x + rand(-14, 14), y: t.y - 2, vx: rand(-40, 40), vy: -rand(5, 25), life: rand(0.6, 1), size: 4, grow: 2, rgb: this.theme.mid, alpha: 0.4 });
      }
    }
    t.parachuting = false;
    t.vy = 0;
    t.fallDist = 0;
  }

  settle(dt) {
    const passes = clamp(Math.round(dt * 300), 1, 10);
    const moved = this.terrain.settleStep(passes);
    if (moved) this.settling = true;
    const falling = this.updateTankFalls(dt);
    return moved || falling;
  }

  updateResolve(dt) {
    if (this.projectiles.length || this.timers.length) { this.resolveTimer = 0; return; }
    if (this.settle(dt)) { this.resolveTimer = 0; return; }
    this.resolveTimer += dt;
    const dying = this.players.find(t => t.alive && t.health <= 0);
    if (dying) {
      if (this.resolveTimer > 0.35) { this.killTank(dying); this.resolveTimer = 0; }
      return;
    }
    if (this.resolveTimer > 0.55) this.endTurn();
  }

  // ---------------------------------------------------------------- effects

  spawn(o) {
    if (this.particles.length > 2000) return;
    const p = { vx: 0, vy: 0, g: 0, drag: 0, windF: 0, size: 2, grow: 0, life: 1, type: 'spark', rgb: [255, 200, 100], alpha: 1, stuck: false };
    Object.assign(p, o);
    p.max = p.life;
    this.particles.push(p);
  }

  initDust() {
    this.dust = [];
    for (let i = 0; i < 70; i++) this.dust.push({ x: rand(W), y: rand(H * 0.85), z: rand(0.3, 1) });
  }

  updateEffects(dt) {
    this.shake = Math.max(0, this.shake - dt * 30 - this.shake * dt * 3);
    this.flash = Math.max(0, this.flash - dt * 2.5);

    for (const e of this.explosions) e.t += dt;
    this.explosions = this.explosions.filter(e => e.t < e.dur);

    const windAcc = this.wind * WIND_SCALE;
    const T = this.terrain;
    for (const p of this.particles) {
      p.life -= dt;
      if (p.stuck) continue;
      p.vx += windAcc * p.windF * dt;
      p.vy += p.g * dt;
      if (p.drag) { const d = Math.max(0, 1 - p.drag * dt); p.vx *= d; p.vy *= d; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.type === 'debris' && T.isSolid(p.x, p.y)) { p.stuck = true; p.life = Math.min(p.life, 0.6); }
    }
    this.particles = this.particles.filter(p => p.life > 0);

    for (const f of this.floaters) { f.t += dt; f.y -= 26 * dt; }
    this.floaters = this.floaters.filter(f => f.t < f.dur);

    // Projectile smoke trails
    for (const p of this.projectiles) {
      p.smokeT += dt;
      while (p.smokeT > 0.022) {
        p.smokeT -= 0.022;
        this.spawn({ type: 'smoke', x: p.x, y: p.y, vx: rand(-8, 8), vy: rand(-8, 8), life: rand(0.6, 1.1), size: 2.2, grow: 2.2, rgb: [215, 215, 225], alpha: 0.22, windF: 0.8 });
      }
    }

    // Smoldering wrecks
    if (this.state !== 'setup') {
      for (const t of this.players) {
        if (t.alive) continue;
        t.smokeT += dt;
        if (t.smokeT > 0.12) {
          t.smokeT = 0;
          this.spawn({ type: 'smoke', x: t.x + rand(-4, 4), y: t.y - 8, vx: rand(-5, 5), vy: -rand(20, 40), life: rand(1.5, 2.5), size: 4, grow: 3, rgb: [30, 30, 34], alpha: 0.45, windF: 0.5 });
          if (Math.random() < 0.3) this.spawn({ type: 'glow', x: t.x + rand(-6, 6), y: t.y - 6, vx: rand(-10, 10), vy: -rand(20, 50), life: 0.8, size: 1.6, rgb: [255, 140, 60], windF: 0.4 });
        }
      }
    }

    // Theme ambience
    if (this.theme && this.theme.embers && Math.random() < dt * 14) {
      const x = rand(W);
      this.spawn({ type: 'glow', x, y: T.surfaceY(x), vx: rand(-10, 10), vy: -rand(20, 60), life: rand(2, 4), size: rand(1, 2.2), rgb: [255, rand(90, 160), 40], alpha: 0.8, windF: 0.5 });
    }

    for (const d of this.dust) {
      d.x += this.wind * 4.5 * d.z * dt;
      d.y += Math.sin(this.time * 0.7 + d.x * 0.01) * 4 * dt;
      if (d.x > W + 10) d.x = -10;
      if (d.x < -10) d.x = W + 10;
    }
  }

  // ---------------------------------------------------------------- render

  render() {
    const ctx = this.ctx, v = this.view;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, cw, ch);
    if (!this.terrain) return;

    // Letterbox: blurred-looking extension of the sky
    if (v.ox > 0.5 || v.oy > 0.5) {
      const s = Math.max(cw / W, ch / H);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(this.bg, (cw - W * s) / 2, (ch - H * s) / 2, W * s, H * s);
      ctx.globalAlpha = 1;
    }

    const k = v.dpr * v.scale;
    ctx.setTransform(k, 0, 0, k, v.dpr * v.ox, v.dpr * v.oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    ctx.drawImage(this.bg, 0, 0, W, H);
    this.drawDust(ctx);

    const sh = this.shake;
    if (sh > 0) ctx.translate(rand(-sh, sh), rand(-sh, sh));
    ctx.fillStyle = rgbStr(this.theme.deep);
    ctx.fillRect(-40, H - 1, W + 80, 60);
    ctx.drawImage(this.terrain.canvas, 0, 0);

    this.drawGuides(ctx);
    for (const t of this.players) this.drawTank(ctx, t);
    this.drawParticles(ctx, false);
    this.drawProjectiles(ctx);
    ctx.globalCompositeOperation = 'lighter';
    this.drawExplosions(ctx);
    this.drawParticles(ctx, true);
    ctx.globalCompositeOperation = 'source-over';
    this.drawLabels(ctx);
    this.drawFloaters(ctx);
    this.drawOffscreen(ctx);
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,240,220,${(this.flash * 0.35).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  drawDust(ctx) {
    const w = this.wind;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this.dust) {
      const len = Math.min(40, Math.abs(w) * 0.5) * d.z + 1;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - Math.sign(w || 1) * len, d.y);
    }
    ctx.stroke();
  }

  drawGuides(ctx) {
    if (!this.humanTurn) return;
    const t = this.current;
    if (t.lastTrail && t.lastTrail.length > 1) {
      ctx.save();
      ctx.setLineDash([3, 6]);
      ctx.strokeStyle = rgbStr(t.rgb, 1, 0.35);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(t.lastTrail[0].x, t.lastTrail[0].y);
      for (const p of t.lastTrail) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.restore();
    }
    const a = t.angle * DEG;
    const len = 26 + (t.power / 1000) * 60;
    ctx.save();
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(t.x + Math.cos(a) * 22, t.y - 11 - Math.sin(a) * 22);
    ctx.lineTo(t.x + Math.cos(a) * len, t.y - 11 - Math.sin(a) * len);
    ctx.stroke();
    ctx.restore();
  }

  drawTank(ctx, t) {
    if (t.y > H + 30) return;
    const x = Math.round(t.x), y = t.y;
    ctx.save();
    ctx.translate(x, y);

    if (!t.alive) {
      ctx.fillStyle = '#1a181b';
      roundRectPath(ctx, -14, -6, 28, 6, 3); ctx.fill();
      ctx.fillStyle = '#29252a';
      ctx.beginPath(); ctx.arc(0, -6, 6, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = '#29252a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(9, -3); ctx.stroke();
      ctx.restore();
      return;
    }

    if (t.parachuting) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-12, -10); ctx.lineTo(-20, -44);
      ctx.moveTo(12, -10); ctx.lineTo(20, -44);
      ctx.moveTo(0, -18); ctx.lineTo(0, -48);
      ctx.stroke();
      const pg = ctx.createLinearGradient(0, -62, 0, -42);
      pg.addColorStop(0, '#ffffff'); pg.addColorStop(1, rgbStr(t.rgb, 1));
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.ellipse(0, -44, 24, 16, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
    }

    // Barrel
    ctx.save();
    ctx.translate(0, -11);
    ctx.rotate(-t.angle * DEG);
    ctx.fillStyle = '#2a2f3a';
    roundRectPath(ctx, 0, -2.2, 20, 4.4, 2); ctx.fill();
    ctx.fillStyle = '#5c6577';
    ctx.fillRect(2, -2.2, 15, 1.3);
    ctx.fillStyle = '#16191f';
    ctx.fillRect(17, -2.7, 4, 5.4);
    ctx.restore();

    // Turret dome
    const dg = ctx.createLinearGradient(0, -18, 0, -8);
    dg.addColorStop(0, rgbStr(t.rgb, 1.35));
    dg.addColorStop(1, rgbStr(t.rgb, 0.75));
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.arc(0, -10, 7, Math.PI, 0); ctx.closePath(); ctx.fill();

    // Hull
    const hg = ctx.createLinearGradient(0, -12, 0, -5);
    hg.addColorStop(0, rgbStr(t.rgb, 1.2));
    hg.addColorStop(1, rgbStr(t.rgb, 0.55));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.moveTo(-15, -6); ctx.lineTo(-11, -11); ctx.lineTo(11, -11); ctx.lineTo(15, -6);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(-10, -11, 20, 1);

    // Tracks
    ctx.fillStyle = '#15171d';
    roundRectPath(ctx, -15, -6.5, 30, 6.5, 3.2); ctx.fill();
    ctx.fillStyle = '#4b5262';
    for (const wx of [-10.5, -3.5, 3.5, 10.5]) { ctx.beginPath(); ctx.arc(wx, -3.2, 2, 0, TAU); ctx.fill(); }

    // Shield bubble
    if (t.shield > 0) {
      const a = 0.15 + 0.3 * (t.shield / 100);
      const pulse = 0.85 + Math.sin(this.time * 4) * 0.15;
      const sg = ctx.createRadialGradient(0, -8, 8, 0, -8, 26);
      sg.addColorStop(0, 'rgba(110,227,255,0)');
      sg.addColorStop(0.75, `rgba(110,227,255,${(a * 0.4 * pulse).toFixed(3)})`);
      sg.addColorStop(1, `rgba(170,240,255,${(a + 0.15).toFixed(3)})`);
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(0, -8, 26, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(200,248,255,${(a + 0.3) * pulse})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawProjectiles(ctx) {
    for (const p of this.projectiles) {
      const col = p.hue != null ? `hsl(${p.hue},100%,70%)` : p.w.color;
      const tr = p.trail;
      if (tr.length > 1) {
        ctx.strokeStyle = col;
        ctx.lineCap = 'round';
        for (let i = 1; i < tr.length; i++) {
          ctx.globalAlpha = (i / tr.length) * 0.8;
          ctx.lineWidth = 0.6 + (i / tr.length) * 2.2;
          ctx.beginPath();
          ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
          ctx.lineTo(tr[i].x, tr[i].y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 11);
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.kind === 'roll' ? 3.5 : 2.2, 0, TAU); ctx.fill();
    }
  }

  drawExplosions(ctx) {
    for (const e of this.explosions) {
      const p = e.t / e.dur;
      if (e.charge) { // flickering white-hot core before a meltdown
        const r = 5 + p * p * 26 + Math.sin(this.time * 45) * 2.5;
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.35, `rgba(255,240,170,${(0.6 + p * 0.4).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(e.x, e.y, r * 2, 0, TAU); ctx.fill();
        continue;
      }
      const grow = Math.min(1, e.t / 0.12);
      const ease = 1 - Math.pow(1 - grow, 3);
      const r = e.r * (0.35 + 0.75 * ease) * 1.25;
      const a = Math.pow(1 - p, 1.4);
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      g.addColorStop(0, `rgba(255,255,240,${a.toFixed(3)})`);
      g.addColorStop(0.25, `rgba(255,220,140,${a.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(255,120,40,${(a * 0.75).toFixed(3)})`);
      g.addColorStop(1, 'rgba(160,30,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(255,230,200,${((1 - p) * 0.35).toFixed(3)})`;
      ctx.lineWidth = 2 + e.r * 0.04 * (1 - p);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.6 + p * 1.6), 0, TAU); ctx.stroke();
    }
  }

  drawParticles(ctx, additive) {
    for (const p of this.particles) {
      const add = p.type === 'spark' || p.type === 'glow';
      if (add !== additive) continue;
      const f = Math.max(0, p.life / p.max);
      if (p.type === 'spark') {
        ctx.strokeStyle = rgbStr(p.rgb, 1, (f * p.alpha).toFixed(3));
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      } else if (p.type === 'glow') {
        ctx.fillStyle = rgbStr(p.rgb, 1, (f * p.alpha).toFixed(3));
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + f * 0.5), 0, TAU); ctx.fill();
      } else if (p.type === 'smoke') {
        const r = p.size * (1 + p.grow * (1 - f));
        const a = p.alpha * f * Math.min(1, (1 - f) * 8);
        ctx.fillStyle = rgbStr(p.rgb, 1, a.toFixed(3));
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = rgbStr(p.rgb, 1, Math.min(1, f * 3).toFixed(3));
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
  }

  drawLabels(ctx) {
    if (this.state === 'setup') return;
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.max(11, 10 / this.view.scale).toFixed(1)}px Inter, sans-serif`;
    for (const t of this.players) {
      if (!t.alive || t.y > H + 30) continue;
      const ly = t.y - (t.shield > 0 ? 44 : 36) - (t.parachuting ? 30 : 0);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(t.name, t.x + 1, ly + 1);
      ctx.fillStyle = t.color;
      ctx.fillText(t.name, t.x, ly);
      const hp = clamp(t.health / 100, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      roundRectPath(ctx, t.x - 16, ly + 4, 32, 4, 2); ctx.fill();
      ctx.fillStyle = hp > 0.6 ? '#7ee06a' : hp > 0.3 ? '#ffc94a' : '#ff5d5d';
      if (hp > 0) { roundRectPath(ctx, t.x - 16, ly + 4, Math.max(4, 32 * hp), 4, 2); ctx.fill(); }

      if (t === this.current && this.state === 'aim') {
        const by = ly - 20 + Math.sin(this.time * 5) * 3;
        ctx.fillStyle = t.color;
        ctx.beginPath();
        ctx.moveTo(t.x - 6, by); ctx.lineTo(t.x + 6, by); ctx.lineTo(t.x, by + 7);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  drawFloaters(ctx) {
    ctx.textAlign = 'center';
    for (const f of this.floaters) {
      const a = 1 - f.t / f.dur;
      ctx.font = `700 ${Math.max(f.size, f.size * 0.9 / this.view.scale).toFixed(1)}px "Chakra Petch", sans-serif`;
      ctx.fillStyle = `rgba(0,0,0,${(a * 0.6).toFixed(3)})`;
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = rgbStr(f.rgb, 1, a.toFixed(3));
      ctx.fillText(f.text, f.x, f.y);
    }
  }

  drawOffscreen(ctx) {
    ctx.textAlign = 'center';
    ctx.font = '600 10px Inter, sans-serif';
    for (const p of this.projectiles) {
      if (p.y > -6) continue;
      const x = clamp(p.x, 10, W - 10);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x - 5, 13); ctx.lineTo(x + 5, 13); ctx.closePath(); ctx.fill();
      ctx.fillText(Math.round(-p.y), x, 25);
    }
  }
}
