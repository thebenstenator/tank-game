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
    this.owner = def.owner || null; // online: which player's computer controls this tank
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
    this.lastShot = null;
    this.lastHitBy = null;
    this.aiMem = null; // CPU: the last shot it fired and at whom
    this.burn = 0;
    this.weapon = 'baby';
    this.angle = 60;
    this.power = 500;
    this.x = 0;
    this.y = 0;
    this.smokeT = 0;
  }

  // Damage still costs power, but gently enough that a wounded tank can fight back.
  get maxPower() { return Math.round(500 + Math.max(0, this.health) * 5); }
  ammo(id) { return id === 'baby' || this.infinite ? Infinity : (this.inventory[id] || 0); }

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
    this.fires = [];   // burning napalm blobs (part of the simulation)
    this.beams = [];   // laser beams (visual only)
    this.clouds = [];  // mushroom clouds (visual only)
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
    const ah = Math.max(200, ch - HUD_RESERVE); // battlefield sits above the HUD strip
    const s = Math.min(cw / W, ah / H);
    this.view = { dpr, scale: s, ox: (cw - W * s) / 2, oy: (ah - H * s) / 2 };
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

  /** net (online guests): { W, H, runs, style } from the host instead of generating locally. */
  setTheme(theme, terrainStyle, net) {
    if (net) setWorldSize(net.W, net.H); else fitWorldToWindow();
    this.resize();
    this.theme = theme;
    this.terrain = new Terrain(theme);
    if (net) {
      this.terrain.fromRuns(net.runs);
      this.terrain.markRange(0, W - 1, false);
      this.terrainStyle = net.style;
    } else {
      this.terrainStyle = this.terrain.generate(terrainStyle);
    }
    this.bg = renderBackground(theme);
    this.initDust();
  }

  /** Drop any shots still in flight (used when an online guest catches up to the host). */
  clearShots() {
    this.projectiles = [];
    this.timers = [];
    this.fires = [];
  }

  clearEffects() {
    this.fires = [];
    this.beams = [];
    this.clouds = [];
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

  /** dev: the weapon test range — player 0 has infinite everything, the rest are targets that never take a turn. */
  startMatch(defs, settings, dev = false) {
    this.settings = settings;
    this.dev = dev;
    this.players = defs.map((d, i) => new Tank(d, i, settings.money));
    if (dev) this.players[0].infinite = true;
    this.round = 0;
    this.startRound();
  }

  startRound() {
    this.round++;
    let theme = pick(THEMES);
    while (THEMES.length > 1 && theme === this.theme) theme = pick(THEMES);
    this.clearEffects();
    this.setTheme(theme, this.settings.terrain);
    this.players.forEach(p => {
      p.resetForRound();
      // a Gun Sight is used up at the start of a round and lasts all of it
      p.sight = (p.inventory.sight || 0) > 0;
      if (p.sight) p.inventory.sight--;
    });
    this.placeTanks();
    this.order = this.dev ? [this.players[0]] : shuffle(this.players.slice());
    this.turnPos = -1;
    this.turnCount = 0;
    const lvl = WIND_LEVELS[this.settings.wind] || WIND_LEVELS.none;
    this.windMax = lvl.max;
    this.windShift = lvl.shift;
    this.wind = this.windMax ? randInt(-this.windMax, this.windMax) : 0;
    if (this.dev) { this.windMax = 0; this.wind = 0; } // the test range is always calm
    this.nextTurn();
    const styleName = { gentle: 'Gentle', hilly: 'Hilly', mountains: 'Mountainous', wild: 'Wild' }[this.terrainStyle];
    if (this.dev) UI.toast('Weapon test range', 'Infinite ammo · targets respawn · N for new terrain', 2600);
    else UI.toast(`Round ${this.round} of ${this.settings.rounds}`, `${theme.name} · ${styleName} terrain`, 2200);
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
    this.beginTurn(t);
    if (Net.isHost) Net.broadcast(Net.snapshot(this));
  }

  beginTurn(t) {
    this.current = t;
    this.state = 'aim';
    this.keys = {};
    this.firePending = false;
    this.ai = t.ai && !Net.isClient ? { timer: 0, plan: null, wait: 0 } : null;
    if (t.ammo(t.weapon) <= 0) t.weapon = 'baby';
    t.power = Math.min(t.power, t.maxPower);
    const mine = this.isLocal(t);
    Sound.turn(mine);
    UI.banner(mine && Net.active ? 'Your turn' : `${t.name}'s turn${t.ai ? ' · CPU' : ''}`, t.color);
  }

  endTurn() {
    // Online guests don't decide what happens next: wait for the host's word.
    if (Net.isClient) { this.state = 'netwait'; return; }
    if (this.dev) { this.devRespawn(); this.nextTurn(); return; }
    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1) { this.finishRound(alive[0] || null); return; }
    this.nextTurn();
  }

  /** Test range: bring destroyed tanks back and top the shooter up. */
  devRespawn() {
    for (const p of this.players) {
      if (p.alive && p.health > 0 && p.y <= H) continue;
      p.alive = true;
      p.health = 100;
      p.burn = 0;
      p.falling = false; p.vy = 0; p.fallDist = 0; p.parachuting = false;
      const sy = this.terrain.surfaceY(p.x);
      p.y = sy >= H - 24 ? this.terrain.flatten(p.x, 16) : sy;
    }
    const me = this.players[0];
    me.health = 100;
    me.inventory.shield = 99;
    me.inventory.parachute = 99;
    me.inventory.sight = 99;
    me.sight = true;
  }

  /** Test range: fresh terrain and theme, same tanks. */
  devNewMap() {
    if (!this.dev || this.state !== 'aim') return;
    const keep = this.players[0].weapon;
    this.startRound();
    this.players[0].weapon = keep;
    this.devRespawn();
  }

  /** stats (online guests): the host's money/wins/kills for every tank. */
  finishRound(winner, stats) {
    this.state = 'roundEnding';
    this.endTimer = 2.0;
    this.roundWinner = winner;
    if (stats) {
      stats.forEach((s, i) => Object.assign(this.players[i], s));
    } else {
      this.players.forEach(p => { p.money += 1000; });
      if (winner) { winner.wins++; winner.money += 7000; }
    }
    if (Net.isHost) Net.roundEnded(this);
    UI.toast(winner ? `${winner.name} wins the round` : 'Total annihilation',
      winner ? '+$7,000 victory bonus' : 'No survivors', 2000);
    Sound.win();
  }

  /** True when every human is out of the round (or there are none) and it's still being fought. */
  get canSkip() {
    return !Net.active && !this.skipping && (this.state === 'aim' || this.state === 'resolve') &&
      this.players.length > 0 && !this.players.some(p => !p.ai && p.alive);
  }

  skipRound() {
    if (!this.canSkip) return;
    this.skipping = true;
    this.skipFrames = 0;
    Sound.setSilent(true);
  }

  /** Runs the simulation as fast as the frame budget allows until the round is decided. */
  fastForward() {
    const t0 = performance.now();
    while (this.skipping && performance.now() - t0 < 25) {
      this.update(1 / 60);
      if (++this.skipFrames > 60 * 60 * 10 && this.state === 'aim') {
        // Ten simulated minutes without a result: the healthiest tank takes it.
        const alive = this.players.filter(p => p.alive);
        this.finishRound(alive.reduce((a, b) => (b.health > a.health ? b : a), alive[0]) || null);
      }
      if (this.state !== 'aim' && this.state !== 'resolve') this.endSkip();
    }
  }

  endSkip() {
    this.skipping = false;
    this.particles = [];
    this.explosions = [];
    this.clouds = [];
    this.floaters = [];
    this.shake = 0;
    this.flash = 0;
    Sound.setSilent(false);
  }

  /** Is this tank controlled from this computer's keyboard? */
  isLocal(t) { return !!t && !t.ai && (!Net.active || t.owner === Net.myId); }

  get humanTurn() { return this.state === 'aim' && this.isLocal(this.current) && !this.firePending; }

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

  activateShield(t, fromNet) {
    if (this.state !== 'aim' || t !== this.current) return;
    if ((t.inventory.shield || 0) <= 0 || t.shield > 0) return;
    if (Net.isClient && !fromNet) { Net.send({ type: 'shield' }); return; }
    if (Net.isHost) Net.broadcast({ type: 'shield', i: t.index });
    t.inventory.shield--;
    t.shield = 100;
    Sound.shield(t.x);
    for (let i = 0; i < 24; i++) {
      const a = rand(TAU);
      this.spawn({ type: 'glow', x: t.x + Math.cos(a) * 26, y: t.y - 8 + Math.sin(a) * 26, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20, life: 0.6, size: 2.5, rgb: [140, 235, 255] });
    }
  }

  fire(fromNet) {
    if (this.state !== 'aim') return;
    const t = this.current;
    if (Net.isClient && !fromNet) { // ask the host; the shot plays when it echoes back
      if (!this.isLocal(t) || this.firePending) return;
      this.firePending = true;
      Net.send({ type: 'fire', angle: t.angle, power: t.power, weapon: t.weapon });
      return;
    }
    if (Net.isHost) {
      const seed = randInt(1, 2147483646);
      seedSim(seed);
      Net.broadcast({ type: 'shot', i: t.index, angle: t.angle, power: t.power, weapon: t.weapon, seed });
    }
    let wid = t.weapon;
    // A guest always fires what the host says, even if its copy of the inventory disagrees.
    if (!WEAPONS[wid] || (t.ammo(wid) <= 0 && !fromNet)) wid = 'baby';
    if (wid !== 'baby') t.inventory[wid] = Math.max(0, (t.inventory[wid] || 0) - 1);
    const w = WEAPONS[wid];
    const m = t.muzzle();
    if (w.behavior === 'laser') {
      t.lastShot = { angle: Math.round(t.angle), power: Math.round(t.power) };
      this.fireLaser(t, w, m);
      this.state = 'resolve';
      this.resolveTimer = 0;
      this.ai = null;
      this.keys = {};
      if (t.ammo(wid) <= 0) t.weapon = 'baby';
      return;
    }
    const sp = muzzleSpeed(t.power);
    const a = t.angle * DEG;
    const p = this.makeProjectile(m.x, m.y, Math.cos(a) * sp, -Math.sin(a) * sp, w, t, 'shell');
    t.lastTrail = [{ x: m.x, y: m.y }];
    t.lastShot = { angle: Math.round(t.angle), power: Math.round(t.power) };
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

  /** Straight beam from the muzzle, all the way across the screen. Cuts a thin channel and hits every tank on the line. */
  fireLaser(t, w, m) {
    const a = t.angle * DEG, dx = Math.cos(a), dy = -Math.sin(a);
    const len = Math.hypot(W, H) + 40; // always reaches the edge of the world
    let x = m.x, y = m.y, d = 0, n = 0;
    const hit = new Set();
    while (d < len) {
      x += dx * 2; y += dy * 2; d += 2;
      if (x < -20 || x > W + 20 || y < -600 || y > H + 20) break;
      for (const p of this.players) {
        if (p !== t && p.alive && !hit.has(p) && p.hitTest(x, y)) {
          hit.add(p);
          this.damageTank(p, w.damage, t, w.id);
          for (let i = 0; i < 18; i++) {
            const aa = rand(TAU), s = rand(60, 220);
            this.spawn({ type: 'spark', x, y, vx: Math.cos(aa) * s, vy: Math.sin(aa) * s, life: rand(0.2, 0.5), size: 1.6, drag: 2, rgb: [255, 120, 160] });
          }
        }
      }
    }
    this.terrain.carveBand(m.x, m.y, x, y, w.radius);
    t.lastTrail = [{ x: m.x, y: m.y }, { x, y }];
    this.beams.push({ x0: m.x, y0: m.y, x1: x, y1: y, t: 0, dur: 0.8, rgb: hexToRgb(w.color), w: w.radius / 4 });
    for (let i = 0; i < 30; i++) { // embers along the cut
      const f = Math.random();
      this.spawn({ type: 'glow', x: m.x + (x - m.x) * f, y: m.y + (y - m.y) * f, vx: rand(-20, 20), vy: rand(-40, 0), life: rand(0.4, 1), size: rand(1.2, 2.2), rgb: [255, 90, 140] });
    }
    this.shake = Math.max(this.shake, 4);
    Sound.laser(m.x);
  }

  makeProjectile(x, y, vx, vy, w, owner, kind) {
    return {
      x, y, vx, vy, w, owner, kind,
      age: 0, trail: [], dead: false, cleared: false,
      radius: w.radius, damage: w.damage, core: w.core || 0, bounces: w.bounces || 0,
      ignoreTank: null, ignoreT: 0, hue: null, smokeT: 0, rec: 0,
    };
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    this.time += dt;
    if (!this.terrain) return;
    this.settling = false;
    if (this.terrain.changed) { // fresh damage: hold everything in place for a beat
      this.terrain.changed = false;
      this.settleHold = SETTLE_DELAY;
      this.dirtV = DIRT_FALL.v0;
    }
    if (this.settleHold > 0) this.settleHold -= dt;

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
    } else if (this.state === 'roundOver' || this.state === 'netwait') this.settle(dt);

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
    if (t.ai) { if (this.ai) this.updateAI(dt); return; }
    if (!this.isLocal(t)) return;
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
    t.angle = clampAngle(t.angle);
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
      if (ai.wait > 0.35) {
        const tg = p.target;
        if (tg) t.aiMem = { target: tg, angle: t.angle, power: t.power, wind: this.wind, tx: tg.x, ty: tg.y, R: WEAPONS[t.weapon].radius, weapon: t.weapon };
        this.fire();
      }
    }
  }

  // ---------------------------------------------------------------- physics

  physicsTick(dt) {
    const list = this.projectiles.slice();
    for (const p of list) if (!p.dead) this.stepProjectile(p, dt);
    this.projectiles = this.projectiles.filter(p => !p.dead);
    this.updateFires(dt);
  }

  stepProjectile(p, dt) {
    p.age += dt;
    if (p.age > 20) { p.dead = true; return; }
    if (p.kind === 'roll') { this.stepRoller(p, dt); return; }
    if (p.kind === 'dig') { this.stepDig(p, dt); return; }

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
      if (hit) { hit.vx = vx; hit.vy = vy; return hit; }
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
    for (let i = 0; i < n; i++) Sound.fire(p.w.radius / 110, p.x, i * 0.075); // each warhead launches
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
    if (b === 'burrow' && hit.ground) { this.startDig(p, hit); return; }
    p.dead = true;

    if (b === 'dirt') { this.dirtBlast(hit.x, hit.y, p.radius); return; }
    if (b === 'fountain') {
      // Blow a small pocket out first and erupt straight up from it. A clod that starts inside dirt
      // lands on the spot (24 of those look like one dirt ball), and from an open pocket an upward
      // spray clears any slope that isn't close to a sheer wall.
      if (hit.ground) this.terrain.carve(hit.x, hit.y, FOUNTAIN_POCKET); // not on a tank: don't drop it into a hole
      let o = { x: hit.x, y: hit.y - 4 };
      // Under a roof or overhang the pocket has no sky: erupt instead from the nearest point back along
      // the shell's path (open air) that does.
      const skyBlocked = (x, y) => { // checks the whole width of the spray, not just straight up
        for (const a of [-0.42, -0.21, 0, 0.21, 0.42]) {
          const dx = Math.sin(a), dy = -Math.cos(a);
          for (let d = 2; d <= 40; d += 2) if (this.terrain.isSolid(x + dx * d, y + dy * d)) return true;
        }
        return false;
      };
      if (skyBlocked(o.x, o.y)) {
        for (let i = p.trail.length - 1; i >= 0; i--) {
          const q = p.trail[i];
          if (!this.terrain.isSolid(q.x, q.y) && !skyBlocked(q.x, q.y)) { o = { x: q.x, y: q.y }; break; }
        }
      }
      const base = -Math.PI / 2;
      Sound.fountain(o.x);
      const T = this.theme;
      for (let i = 0; i < 50; i++) {
        const src = Math.random() < 0.4 ? T.top : T.mid, k = rand(0.7, 1.15);
        const a = base + rand(-0.4, 0.4), s = rand(200, 560);
        this.spawn({ type: 'debris', x: o.x + rand(-3, 3), y: o.y + rand(-3, 3), vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(1.2, 2.2), size: rand(1.5, 3.5), g: 520, rgb: [src[0] * k, src[1] * k, src[2] * k] });
      }
      for (let i = 0; i < w.count; i++) {
        const a = base + srand(-0.4, 0.4), s = srand(270, 490);
        const q = this.makeProjectile(o.x, o.y, Math.cos(a) * s, Math.sin(a) * s, CLOD, p.owner, 'shell');
        q.radius = 28;
        q.cleared = true;
        q.ignoreTank = hit.tank || null; q.ignoreT = hit.tank ? 0.25 : 0;
        this.projectiles.push(q);
      }
      return;
    }
    if (b === 'excavate') { this.excavate(hit.x, hit.y, p.radius); return; }

    this.explode(hit.x, hit.y, p.radius, p.damage, p.owner, { core: p.core, weapon: w.id });
    if (w.id === 'nuke') { this.nukeCloud(hit.x, hit.y, 72); Sound.nuke(hit.x); }

    if (b === 'napalm') {
      this.spawnFires(hit.x, hit.y, w.count, p.owner, 1);
      Sound.napalm(hit.x);
    }

    if (b === 'funky') {
      Sound.pop(hit.x);
      for (let i = 0; i < w.count; i++) {
        const q = this.makeProjectile(hit.x, hit.y - 4, srand(-260, 260), srand(-480, -220), w, p.owner, 'bomblet');
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

  // ---------------------------------------------------------------- burrower

  startDig(p, hit) {
    const dx = p.vx, dy = p.vy * 0.45, l = Math.hypot(dx, dy) || 1; // flattened: it tunnels more than it dives
    p.kind = 'dig';
    p.dx = dx / l; p.dy = dy / l;
    p.dist = p.w.dig;
    p.x = hit.x; p.y = hit.y;
    p.vx = 0; p.vy = 0;
  }

  stepDig(p, dt) {
    const step = 190 * dt;
    const nx = p.x + p.dx * step, ny = p.y + p.dy * step;
    for (const t of this.players) {
      if (t.hitTest(nx, ny) && (p.cleared || t !== p.owner)) { p.x = nx; p.y = ny; this.burrowBoom(p); return; }
      if (this.underEnemy(t, nx, ny, p.owner)) { p.x = nx; p.y = ny; this.burrowBoom(p); return; }
    }
    p.x = nx; p.y = ny;
    p.dist -= step;
    this.terrain.carve(nx, ny, 7);
    this.recordTrail(p);
    if (p.dist <= 0 || nx < 0 || nx >= W || ny < 0 || ny >= H - 2) this.burrowBoom(p);
  }

  /** The burrower goes off as soon as it's directly beneath an enemy tank, at any depth. */
  underEnemy(t, x, y, owner) {
    return t !== owner && t.alive && Math.abs(t.x - x) < 14 && y > t.y;
  }

  burrowBoom(p) {
    p.dead = true;
    this.explode(p.x, p.y, p.radius, p.damage, p.owner, { weapon: p.w.id });
  }

  /** Where a burrower that lands at (x, y) moving (vx, vy) would end up. Used by the CPUs. */
  digPath(x, y, vx, vy, owner) {
    let dx = vx, dy = vy * 0.45;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    for (let d = 0; d < WEAPONS.burrower.dig; d += 3) {
      x += dx * 3; y += dy * 3;
      if (x < 0 || x >= W || y < 0 || y >= H - 2) break;
      for (const t of this.players) if (t !== owner && (t.hitTest(x, y) || this.underEnemy(t, x, y, owner))) return { x, y, tank: t };
    }
    return { x, y, ground: true };
  }

  // ---------------------------------------------------------------- napalm

  spawnFires(x, y, n, owner, spread) {
    for (let i = 0; i < n; i++) {
      this.fires.push({ x, y: y - 3, vx: srand(-125, 125) * spread, vy: srand(-240, -60) * spread, air: true, life: srand(4.5, 6.5), owner, gen: 0, spreadT: srand(0.2, 0.5), seed: Math.random() * 100 });
    }
  }

  /**
   * Fixed-step: burning blobs splash out and stick where they land, then the fire
   * creeps outward along the ground from there and burns tanks it touches.
   */
  updateFires(dt) {
    if (!this.fires.length) return;
    const T = this.terrain;
    const born = [];
    for (const f of this.fires) {
      f.life -= dt;
      if (f.air) {
        f.vy += GRAVITY * dt;
        const nx = f.x + f.vx * dt, ny = f.y + f.vy * dt;
        if (nx < 0 || nx >= W || ny >= H) { f.life = 0; continue; }
        if (T.isSolid(nx, ny)) {
          f.air = false;
          f.x = Math.round(f.x);
          f.y = T.surfaceY(f.x);
        } else { f.x = nx; f.y = ny; }
        continue;
      }
      f.y = T.surfaceY(f.x); // stays put; rides the ground down if it collapses
      if (f.y >= H) { f.life = 0; continue; }
      // creep outward to a neighbouring patch of ground that isn't burning yet
      if (f.gen < 2 && f.life > 2.6) {
        f.spreadT -= dt;
        if (f.spreadT <= 0) {
          f.spreadT = srand(0.45, 0.85);
          const nx = Math.round(clamp(f.x + (simRandom() < 0.5 ? -1 : 1) * srand(5, 9), 0, W - 1));
          const ny = T.surfaceY(nx);
          const ok = ny < H && ny - f.y > -9 && // won't climb a cliff
            this.fires.length + born.length < 80 &&
            !this.fires.some(o => !o.air && Math.abs(o.x - nx) < 4) && !born.some(o => Math.abs(o.x - nx) < 4);
          if (ok) born.push({ x: nx, y: ny, vx: 0, vy: 0, air: false, life: f.life * srand(0.5, 0.7), owner: f.owner, gen: f.gen + 1, spreadT: srand(0.3, 0.6), seed: Math.random() * 100 });
        }
      }
    }
    if (born.length) this.fires.push(...born);
    for (const t of this.players) {
      if (!t.alive) continue;
      let n = 0, by = null;
      for (const f of this.fires) {
        if (!f.air && f.life > 0 && Math.abs(f.x - t.x) < 16 && f.y > t.y - 24 && f.y < t.y + 10) { n++; by = f.owner; }
      }
      if (n) { t.burn += Math.min(22, 4 * n) * dt; t.burnBy = by; }
      if (t.burn >= 4 || (t.burn > 0.5 && !n)) { this.damageTank(t, t.burn, t.burnBy, 'napalm', true); t.burn = 0; }
    }
    this.fires = this.fires.filter(f => f.life > 0);
  }

  // ---------------------------------------------------------------- excavator

  excavate(x, y, r) {
    this.terrain.carve(x, y, r);
    const T = this.theme;
    for (let i = 0; i < 40; i++) {
      const a = rand(TAU), d = rand(r);
      this.spawn({ type: 'debris', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * rand(80, 260), vy: Math.sin(a) * rand(80, 260) - 120, life: rand(1, 2), size: rand(1.5, 3.5), g: 500, rgb: pick([T.top, T.mid]) });
    }
    for (let i = 0; i < 12; i++) {
      this.spawn({ type: 'smoke', x: x + rand(-r, r) * 0.7, y: y + rand(-r, r) * 0.5, vx: rand(-30, 30), vy: -rand(10, 40), life: rand(1.2, 2.2), size: r * 0.35, grow: 1, rgb: T.mid, alpha: 0.35, windF: 0.5 });
    }
    this.shake = Math.min(20, this.shake + 7);
    Sound.excavate(x);
  }

  startRoll(p, hit) {
    const x = Math.round(hit.x);
    const sy = this.terrain.surfaceY(x);
    if (sy < hit.y - 10) return false; // hit a cliff face — just explode
    const l = this.terrain.surfaceY(x - 5), r = this.terrain.surfaceY(x + 5);
    // Downhill; on (near) flat ground it keeps going the way it was flying.
    p.dir = Math.abs(l - r) <= 1 ? (Math.sign(p.vx) || 1) : l > r ? -1 : 1;
    // A first landing keeps a little of the shell's speed; coming down off a ledge keeps all of it.
    p.rollSpeed = clamp(Math.abs(p.vx) * (p.rolled ? 1 : 0.4), 60, 260);
    if (!p.rolled) p.rollT = 0; // the time limit covers the whole roll, ledges included
    p.rolled = true;
    p.kind = 'roll';
    p.x = hit.x;
    p.y = sy - 3;
    p.vx = 0; p.vy = 0;
    return true;
  }

  stepRoller(p, dt) {
    p.rollT += dt;
    const T = this.terrain;
    const boom = () => { p.dead = true; this.explode(p.x, p.y, p.radius, p.damage, p.owner, { core: p.core }); };
    const nx = p.x + p.dir * p.rollSpeed * dt;
    if (nx < 0 || nx >= W) { boom(); return; } // the edge of the world stops it like a wall
    const ground = p.y + 3;
    const sy = T.surfaceY(Math.round(nx));

    for (const t of this.players) {
      if (t.hitTest(nx, p.y - 2) && (p.cleared || t !== p.owner)) { p.x = nx; boom(); return; }
    }
    if (Math.hypot(nx - p.owner.x, p.y - p.owner.y) > 34) p.cleared = true;

    if (sy > ground + 6) { // rolled off a ledge — fall again
      p.x = nx;
      p.kind = 'shell';
      p.vx = p.dir * p.rollSpeed;
      p.vy = 0;
      return;
    }
    // Look a few pixels ahead (not one tick ahead, which at low speed is a fraction of a pixel and
    // never sees the slope): once the ground in front rises, it has reached the bottom of a valley or a wall.
    const ahead = T.surfaceY(Math.round(nx + p.dir * 5));
    // Also catches gentle far slopes: a few pixels of climb above the lowest point it reached and it goes off.
    p.low = Math.max(p.low || 0, ground);
    if (ahead < sy - 2 || sy < ground - 3 || sy < p.low - 4 || p.rollT > 6) { boom(); return; }
    // Speeds up going down, slows on the flat, and stops (and goes off) if it runs out of speed.
    const slope = clamp((ahead - sy) / 5, -1.5, 1.5); // + = downhill
    p.rollSpeed = Math.min(260, p.rollSpeed + (slope * 520 - 45) * dt);
    if (p.rollSpeed < 20) { boom(); return; }
    p.x = nx;
    p.y = sy - 3;
    this.recordTrail(p);
  }

  explode(x, y, radius, damage, owner, opts = {}) {
    this.terrain.carve(x, y, radius);

    for (const t of this.players) {
      if (!t.alive) continue;
      let d = Math.hypot(t.x - x, (t.y - 7) - y);
      // A shell stops on the shield bubble, which sits further out than the hull. Measure from the
      // bubble as if it were the hull, so a hit on a shield does the same damage as one on the tank.
      if (t.shield > 0) d = Math.max(0, d - SHIELD_PAD);
      const reach = radius + 14;
      if (d >= reach) continue;
      const core = opts.core || 0;
      const f = core
        ? (d <= core ? 1 : clamp(1 - (d - core) / (reach - core), 0, 1))
        : clamp(1 - Math.max(0, d - 8) / reach, 0, 1);
      this.damageTank(t, damage * f, owner, opts.weapon || null);
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

  /** weapon: id of what dealt it. quiet: no clank (napalm burns tick often). */
  damageTank(t, amount, by, weapon = null, quiet = false) {
    if (!t.alive || amount <= 0) return;
    if (t.shield > 0) {
      const ab = Math.min(t.shield, amount);
      t.shield -= ab;
      amount -= ab;
      if (ab >= 0.5) this.floaters.push({ x: t.x + rand(-6, 6), y: t.y - 46, text: `-${Math.round(ab)}`, rgb: [130, 225, 255], t: 0, dur: 1.2, size: 15 });
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
    if (!quiet) Sound.clank(t.x, dealt / 60);
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
    if (k && k !== t) { k.kills++; k.money += 3000; }
    // Collateral damage from the death blast is credited to whoever caused it.
    const by = k || t;
    const x = t.x, y = t.y - 6;
    const fx = weightedPick(DEATH_EFFECTS, simRandom);
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
        for (let i = 0, n = srandInt(7, 10); i < n; i++) {
          const a = -Math.PI / 2 + srand(-1.25, 1.25), s = srand(110, 440);
          const q = this.makeProjectile(x, y - 6, Math.cos(a) * s, Math.sin(a) * s, SHRAPNEL, by, 'bomblet');
          q.cleared = true;
          this.projectiles.push(q);
        }
        break;

      case 'cookoff': { // stored ammo goes off in a rapid chain, then one last big blast
        this.explode(x, y, 14, 10, by);
        let tt = 0;
        for (let i = 0, n = srandInt(4, 6); i < n; i++) {
          tt += srand(0.13, 0.24);
          const bx = x + srand(-30, 30), byy = y + srand(-16, 6), br = srand(16, 28), bd = srand(18, 28);
          this.schedule(tt, () => this.explode(bx, byy, br, bd, by));
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
          this.nukeCloud(x, y, 44);
          Sound.nuke(x, 0.6);
          this.tankSparks(t, 90);
          this.flash = 1;
        });
        break;
      }

      case 'funky': { // the wreck pops into a spray of rainbow bomblets
        this.explode(x, y, 24, 22, by);
        const w = WEAPONS.funky;
        for (let i = 0; i < 6; i++) {
          const q = this.makeProjectile(x, y - 6, srand(-240, 240), srand(-460, -220), w, by, 'bomblet');
          q.radius = 22; q.damage = 26; q.cleared = true;
          q.hue = i * 60;
          this.projectiles.push(q);
        }
        Sound.pop(x);
        break;
      }

      case 'runaway': { // the turret breaks loose and rolls downhill as a bomb
        this.explode(x, y, 18, 14, by);
        const l = this.terrain.surfaceY(Math.round(t.x - 12)), r = this.terrain.surfaceY(Math.round(t.x + 12));
        const dir = l > r ? -1 : r > l ? 1 : (simRandom() < 0.5 ? -1 : 1);
        const wreck = { id: 'wreck', name: 'Loose turret', radius: 40, damage: 50, color: t.color, behavior: 'roller' };
        const q = this.makeProjectile(t.x, t.y - 12, dir * 70, -90, wreck, by, 'shell');
        q.cleared = true;
        this.projectiles.push(q);
        break;
      }

      case 'inferno': // bursts into flames and spills burning fuel
        this.explode(x, y, 30, 28, by);
        this.spawnFires(x, y, 16, by, 0.7);
        Sound.napalm(x);
        break;

      case 'vaporize': // dissolves into light; barely any blast
        this.explode(x, y, 12, 8, by);
        for (let i = 0; i < 70; i++) {
          this.spawn({ type: 'glow', x: t.x + rand(-14, 14), y: t.y - rand(0, 18), vx: rand(-30, 30), vy: -rand(20, 90), drag: 0.6, life: rand(0.8, 1.8), size: rand(1.2, 2.6), rgb: Math.random() < 0.4 ? [255, 255, 255] : t.rgb });
        }
        this.flash = Math.max(this.flash, 0.5);
        Sound.vaporize(x);
        break;

      case 'sinkhole': // the ground underneath caves in; neighbours may slide in after it
        this.terrain.carve(x, t.y + 34, 50);
        this.explode(x, y, 20, 16, by);
        this.shake = Math.min(26, this.shake + 10);
        Sound.boom(0.55, x);
        break;
    }
    this.flash = Math.max(this.flash, 0.4);
  }

  tankSparks(t, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(TAU), s = rand(100, 320) * (0.6 + n / 80);
      this.spawn({ type: 'glow', x: t.x, y: t.y - 8, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: rand(0.8, 1.5), size: rand(2, 3.5), g: 260, drag: 1, rgb: t.rgb });
    }
  }

  /** An animated mushroom cloud: a rising fireball that rolls into a cap on a stem, with a dust surge along the ground. R = cap size in px. */
  nukeCloud(x, y, R) {
    const puffs = [], stem = [], base = [];
    for (let i = 0; i < 30; i++) puffs.push({ a: i / 30 * TAU + rand(-0.1, 0.1), r: rand(0.34, 0.52), d: rand(0.7, 1.05), sh: rand(0.8, 1.1) });
    for (let i = 0; i < 16; i++) stem.push({ f: i / 15, r: rand(0.8, 1.25), ph: rand(TAU) });
    for (let i = 0; i < 20; i++) base.push({ dir: i % 2 ? 1 : -1, v: rand(0.35, 1), r: rand(0.6, 1.15), h: rand(0, 1) });
    this.clouds.push({ x, y, R, t: 0, dur: 9, drift: 0, puffs, stem, base });
    this.shake = Math.min(34, this.shake + R / 3);
    this.flash = 1;
  }

  updateClouds(dt) {
    for (const c of this.clouds) {
      c.t += dt;
      c.drift += this.wind * WIND_SCALE * dt * 0.05 * Math.min(1, c.t / 2);
    }
    this.clouds = this.clouds.filter(c => c.t < c.dur);
  }

  cloudShape(c) {
    const p = c.t;
    const rise = 1 - Math.exp(-p / 1.5);
    const grow = 1 - Math.exp(-p / 1.1);
    const capR = c.R * (0.4 + 0.8 * grow);
    return {
      p, rise,
      cx: c.x + c.drift, top: c.y - c.R * 3.4 * rise - c.R * 0.3,
      rx: capR * (1 + 0.65 * rise), ry: capR * (0.8 - 0.2 * rise), capR,
      heat: Math.max(0, 1 - p / 2.8),
      fade: Math.min(1, (c.dur - p) / 3, p / 0.15),
    };
  }

  /** A soft round puff of smoke. */
  puff(ctx, x, y, r, rgb, a) {
    if (a <= 0.005 || r <= 0.5) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const s = `${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}`;
    g.addColorStop(0, `rgba(${s},${a.toFixed(3)})`);
    g.addColorStop(0.55, `rgba(${s},${(a * 0.8).toFixed(3)})`);
    g.addColorStop(1, `rgba(${s},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }

  drawClouds(ctx) {
    const HOT = [255, 150, 60], SMOKE = [96, 74, 64], DUST = [118, 100, 86];
    const col = (heat, shade) => [0, 1, 2].map(i => (SMOKE[i] + (HOT[i] - SMOKE[i]) * heat) * shade);
    for (const c of this.clouds) {
      const s = this.cloudShape(c), { p, cx, top, rx, ry, heat, fade } = s;
      const hk = Math.pow(heat, 1.4);
      // dust surge rolling out along the ground
      const spread = 1 - Math.exp(-p / 1.6);
      for (const b of c.base) {
        const bx = c.x + c.drift * 0.3 + b.dir * c.R * (0.3 + 2.6 * spread) * b.v;
        this.puff(ctx, bx, c.y - c.R * 0.18 * b.h * (0.5 + spread), c.R * 0.4 * b.r * (0.5 + spread), DUST, 0.5 * fade * (1 - spread * 0.4));
      }
      // stem, from the ground up into the cap
      for (const st of c.stem) {
        const f = st.f;
        const sx = c.x + c.drift * 0.25 + (cx - c.x - c.drift * 0.25) * f + Math.sin(p * 1.4 + st.ph) * c.R * 0.04;
        const sy = c.y + (top + ry * 0.4 - c.y) * f;
        const w = c.R * (0.2 + 0.16 * (1 - f) + 0.1 * f * f) * st.r;
        this.puff(ctx, sx, sy, w, col(hk * (0.4 + 0.6 * f), 0.8 + 0.15 * f), 0.75 * fade * Math.min(1, s.rise * 2.5));
      }
      // cap: puffs rolling round a flattened torus, back ones first
      const roll = p * 0.7;
      const pts = c.puffs.map(q => {
        const ang = q.a + roll, sn = Math.sin(ang);
        return { x: cx + Math.cos(ang) * rx * q.d, y: top + sn * ry * 0.5 * q.d, r: s.capR * q.r * (0.9 + 0.2 * (sn + 1) / 2), sn, sh: q.sh };
      }).sort((m, n) => m.sn - n.sn);
      this.puff(ctx, cx, top - ry * 0.25, s.capR * 0.95, col(hk, 0.85), 0.85 * fade); // dome
      for (const q of pts) this.puff(ctx, q.x, q.y, q.r, col(hk * (0.6 + 0.4 * (q.sn + 1) / 2), q.sh * (0.72 + 0.28 * (q.sn + 1) / 2)), 0.85 * fade);
    }
  }

  /** Hot glow inside the cloud while it's young (drawn in the additive pass). */
  drawCloudGlow(ctx) {
    for (const c of this.clouds) {
      const s = this.cloudShape(c);
      if (s.heat <= 0) continue;
      const h = s.heat * s.heat;
      const g = ctx.createRadialGradient(s.cx, s.top, 0, s.cx, s.top, s.rx * 1.2);
      g.addColorStop(0, `rgba(255,220,150,${(0.7 * h).toFixed(3)})`);
      g.addColorStop(0.5, `rgba(255,120,40,${(0.35 * h).toFixed(3)})`);
      g.addColorStop(1, 'rgba(200,40,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(s.cx, s.top, s.rx * 1.2, s.ry * 1.3, 0, 0, TAU); ctx.fill();
      // glowing column
      const sg = ctx.createLinearGradient(0, c.y, 0, s.top);
      sg.addColorStop(0, `rgba(255,160,70,${(0.35 * h).toFixed(3)})`);
      sg.addColorStop(1, `rgba(255,200,120,${(0.15 * h).toFixed(3)})`);
      ctx.fillStyle = sg;
      const w = c.R * 0.18;
      ctx.beginPath();
      ctx.moveTo(c.x + c.drift * 0.25 - w * 1.4, c.y); ctx.lineTo(s.cx - w, s.top); ctx.lineTo(s.cx + w, s.top); ctx.lineTo(c.x + c.drift * 0.25 + w * 1.4, c.y);
      ctx.fill();
    }
  }

  isSupported(t) {
    const y = Math.round(t.y);
    if (y >= H) return true; // bedrock: with every bit of dirt gone, you sit on the floor
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
      // health, not just alive: a tank that's taken a killing blow stays "alive" until the dirt settles and it blows up
      if (t.alive && t.health > 0 && !t.parachuting && t.fallDist > 14 && (t.inventory.parachute || 0) > 0) {
        t.inventory.parachute--;
        t.parachuting = true;
        Sound.chute(t.x);
      }
      t.vy = t.parachuting ? 55 : Math.min(t.vy + GRAVITY * 0.9 * dt, 380);
      let move = t.vy * dt;
      while (move > 0) {
        const step = Math.min(1, move);
        t.y += step;
        t.fallDist += step;
        move -= step;
        if (t.y > H) t.y = H;
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
      this.damageTank(t, Math.min(60, (t.fallDist - 18) * 0.6), t.lastHitBy, 'fall');
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
    if (this.settleHold > 0) return this.terrain.anyUnsettled || this.players.some(t => t.y <= H + 30 && !this.isSupported(t));
    this.dirtV = Math.min(DIRT_FALL.max, (this.dirtV || DIRT_FALL.v0) + DIRT_FALL.acc * dt);
    this.dirtAcc = (this.dirtAcc || 0) + this.dirtV * dt;
    const passes = Math.min(10, Math.floor(this.dirtAcc));
    this.dirtAcc -= passes;
    const moved = passes > 0 ? this.terrain.settleStep(passes) : this.terrain.anyUnsettled;
    if (!this.terrain.anyUnsettled) { this.dirtV = DIRT_FALL.v0; this.dirtAcc = 0; }
    if (moved) this.settling = true;
    const falling = this.updateTankFalls(dt);
    return moved || falling;
  }

  updateResolve(dt) {
    if (this.projectiles.length || this.timers.length || this.fires.length) { this.resolveTimer = 0; return; }
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
    this.updateClouds(dt);
    for (const b of this.beams) b.t += dt;
    this.beams = this.beams.filter(b => b.t < b.dur);
    for (const f of this.fires) { // flames throw off embers and smoke
      if (f.air || Math.random() > dt * 5) continue;
      this.spawn({ type: Math.random() < 0.6 ? 'glow' : 'smoke', x: f.x + rand(-4, 4), y: f.y - 4, vx: rand(-10, 10), vy: -rand(30, 70), life: rand(0.5, 1.2), size: rand(1.2, 3), grow: 1.5, rgb: Math.random() < 0.6 ? [255, rand(110, 190), 40] : [40, 34, 34], alpha: 0.6, windF: 0.5 });
    }
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
    // Bedrock under the battlefield, behind the HUD strip
    const yb = Math.floor((v.oy + H * v.scale) * v.dpr);
    if (yb < ch) {
      const gr = ctx.createLinearGradient(0, yb, 0, ch);
      gr.addColorStop(0, rgbStr(this.theme.deep, 1));
      gr.addColorStop(1, rgbStr(this.theme.deep, 0.35));
      ctx.fillStyle = gr;
      ctx.fillRect(0, yb - 1, cw, ch - yb + 1);
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
    this.drawClouds(ctx);
    this.drawProjectiles(ctx);
    ctx.globalCompositeOperation = 'lighter';
    this.drawExplosions(ctx);
    this.drawCloudGlow(ctx);
    this.drawFires(ctx);
    this.drawBeams(ctx);
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
      // Previous shot: a dashed line in the tank's colour over a dark outline, so it reads
      // against any sky or dirt, plus a marker where it landed with the angle/power used.
      const tr = t.lastTrail, px = 1 / this.view.scale; // one screen pixel in world units
      const path = () => { ctx.beginPath(); ctx.moveTo(tr[0].x, tr[0].y); for (const p of tr) ctx.lineTo(p.x, p.y); };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([5 * px, 6 * px]);
      path();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 3.2 * px;
      ctx.stroke();
      path();
      ctx.strokeStyle = rgbStr(t.rgb, 1.1, 0.62);
      ctx.lineWidth = 1.8 * px;
      ctx.stroke();
      ctx.setLineDash([]);
      // Where it landed, or, if it flew off the side, where the trail left the screen.
      const end = tr[tr.length - 1];
      const off = end.x < 0 ? -1 : end.x > W ? 1 : 0;
      let ex = end.x, ey = end.y;
      if (off) {
        const edge = off < 0 ? 0 : W;
        for (let i = tr.length - 1; i > 0; i--) {
          const a = tr[i - 1], b = tr[i];
          if ((a.x - edge) * (b.x - edge) <= 0 && a.x !== b.x) { ey = a.y + (b.y - a.y) * (edge - a.x) / (b.x - a.x); break; }
        }
        ex = edge;
      }
      ex = clamp(ex, 10 * px, W - 10 * px);
      ey = clamp(ey, 24 * px, H - 10 * px);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.fillStyle = rgbStr(t.rgb, 1.2, 1);
      if (off) { // an arrow on the screen edge pointing the way it went
        const s = 8 * px;
        ctx.beginPath();
        ctx.moveTo(ex + off * s, ey);
        ctx.lineTo(ex - off * s * 0.6, ey - s);
        ctx.lineTo(ex - off * s * 0.6, ey + s);
        ctx.closePath();
        ctx.lineWidth = 3 * px;
        ctx.stroke();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(ex, ey, 7 * px, 0, TAU);
        ctx.lineWidth = 4 * px;
        ctx.stroke();
        ctx.strokeStyle = rgbStr(t.rgb, 1.2, 1);
        ctx.lineWidth = 2 * px;
        ctx.stroke();
      }
      if (t.lastShot) {
        const label = `${fmtAngle(t.lastShot.angle)} · ${t.lastShot.power}`;
        const lx = off ? ex - off * 12 * px : ex, ly = ey - 13 * px;
        ctx.font = `600 ${12 * px}px 'Chakra Petch', sans-serif`;
        ctx.textAlign = off > 0 || ex > W - 80 ? 'right' : off < 0 || ex < 80 ? 'left' : 'center';
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = rgbStr(t.rgb, 1.25, 1);
        ctx.fillText(label, lx, ly);
      }
      ctx.restore();
    }
    const a = t.angle * DEG, px = 1 / this.view.scale;
    let pts;
    const laser = WEAPONS[t.weapon] && WEAPONS[t.weapon].behavior === 'laser';
    if (t.sight && !laser) pts = this.sightPath(t);
    else {
      // The laser flies dead straight and power doesn't matter, so its line is a longer fixed-length
      // straight line (longer still with the Gun Sight). Shells get a short stub that grows with power.
      const len = laser ? (t.sight ? LASER_SIGHT_LEN : LASER_AIM_LEN) : 26 + (t.power / 1000) * 60;
      pts = [{ x: t.x + Math.cos(a) * 22, y: t.y - 11 - Math.sin(a) * 22 }, { x: t.x + Math.cos(a) * len, y: t.y - 11 - Math.sin(a) * len }];
    }
    const path = () => { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const p of pts) ctx.lineTo(p.x, p.y); };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([3 * px, 5 * px]);
    path();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 4 * px;
    ctx.stroke();
    path();
    ctx.strokeStyle = laser ? 'rgba(255,120,150,0.95)' : t.sight ? 'rgba(170,240,255,0.95)' : 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    ctx.restore();
  }

  /** Gun Sight: the first stretch of the shell's real flight (wind included), stopping at dirt. */
  sightPath(t) {
    const a = t.angle * DEG, m = t.muzzle();
    const sp = muzzleSpeed(t.power), wind = this.wind * WIND_SCALE, dt = PHYS_DT;
    let x = m.x, y = m.y, vx = Math.cos(a) * sp, vy = -Math.sin(a) * sp;
    const pts = [{ x, y }];
    for (let i = 1; i <= SIGHT_TIME / dt; i++) {
      vx += wind * dt;
      vy += GRAVITY * dt;
      x += vx * dt; y += vy * dt;
      if (x < 0 || x >= W || y >= H || (y >= 0 && this.terrain.isSolid(x, y))) break;
      if (i % 4 === 0) pts.push({ x, y });
    }
    pts.push({ x, y });
    return pts;
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

  /** Napalm as flickering flame tongues (drawn in the additive pass). */
  drawFires(ctx) {
    const t = this.time, lean = clamp(this.wind * 0.06, -5, 5);
    for (const f of this.fires) {
      const k = Math.min(1, f.life / 1.2, (f.age = (f.age || 0) + 1 / 60) * 4);
      if (f.air) { // a falling gob of burning fuel with a short tail
        const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 6);
        g.addColorStop(0, 'rgba(255,240,180,0.95)');
        g.addColorStop(0.5, 'rgba(255,140,30,0.6)');
        g.addColorStop(1, 'rgba(255,60,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(f.x, f.y, 6, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,120,30,0.45)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x - f.vx * 0.03, f.y - f.vy * 0.03); ctx.stroke();
        continue;
      }
      const s = f.seed;
      const hgt = (11 + 6 * Math.sin(t * 9 + s) + 3 * Math.sin(t * 23 + s * 2)) * (0.45 + 0.55 * k);
      const wid = 4.5 * (0.6 + 0.4 * k);
      const sway = Math.sin(t * 6 + s * 1.3) * 2.5 + lean;
      this.flame(ctx, f.x, f.y + 1, wid * 1.35, hgt * 1.25, sway * 1.2, [255, 70, 10], 0.55 * k);   // outer
      this.flame(ctx, f.x, f.y + 1, wid * 0.8, hgt * 0.75, sway * 0.8, [255, 190, 60], 0.75 * k);  // middle
      this.flame(ctx, f.x, f.y + 1, wid * 0.4, hgt * 0.4, sway * 0.5, [255, 250, 210], 0.8 * k);    // core
    }
  }

  /** One teardrop-shaped flame, base at (x, y), tip swaying sideways. */
  flame(ctx, x, y, w, h, sway, rgb, a) {
    if (a <= 0.01 || h < 1) return;
    const [r, gg, b] = rgb;
    const g = ctx.createLinearGradient(0, y, 0, y - h);
    g.addColorStop(0, `rgba(${r},${gg},${b},${a.toFixed(3)})`);
    g.addColorStop(0.6, `rgba(${r},${gg},${b},${(a * 0.6).toFixed(3)})`);
    g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w, y);
    ctx.bezierCurveTo(x - w, y - h * 0.45, x + sway * 0.5 - w * 0.4, y - h * 0.7, x + sway, y - h);
    ctx.bezierCurveTo(x + sway * 0.5 + w * 0.4, y - h * 0.7, x + w, y - h * 0.45, x + w, y);
    ctx.closePath();
    ctx.fill();
  }

  drawBeams(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const b of this.beams) {
      const k = 1 - b.t / b.dur;
      const [r, g, bl] = b.rgb;
      const line = (w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke(); };
      const bw = b.w || 1;
      line((14 * k + 2) * bw, `rgba(${r},${g},${bl},${(0.25 * k).toFixed(3)})`);
      line((6 * k + 1) * bw, `rgba(${r},${g},${bl},${(0.7 * k).toFixed(3)})`);
      line((2 * k + 0.5) * bw, `rgba(255,255,255,${(0.95 * k).toFixed(3)})`);
    }
    ctx.restore();
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
