'use strict';

/**
 * Computer opponents. They simulate candidate shots with the real physics,
 * keep the best, then add aiming error based on difficulty.
 */
const AI = {
  PROFILES: {
    // repeat: how much of the usual aiming error is left when repeating a shot that hit
    easy:   { angErr: 7,   powErr: 70, samples: 110, refine: 60,  repeat: 0.6 },
    normal: { angErr: 2.4, powErr: 24, samples: 200, refine: 120, repeat: 0.35 },
    hard:   { angErr: 0.6, powErr: 7,  samples: 300, refine: 180, repeat: 0.3 },
  },

  chooseTarget(game, t) {
    const enemies = game.players.filter(p => p.alive && p !== t);
    if (t.ai === 'easy') return pick(enemies);
    if (t.ai === 'hard') {
      // weakest, with a mild preference for closer targets
      const score = p => p.health + p.shield + Math.abs(p.x - t.x) * 0.05;
      return enemies.reduce((a, b) => (score(b) < score(a) ? b : a));
    }
    return enemies.reduce((a, b) => (Math.abs(b.x - t.x) < Math.abs(a.x - t.x) ? b : a));
  },

  pickWeapon(t, target) {
    const lower = target.y > t.y + 40;
    const pool = WEAPON_ORDER.filter(id => id !== 'baby' && WEAPONS[id].ai > 0 && t.ammo(id) > 0 && (id !== 'roller' || lower) &&
      Math.abs(target.x - t.x) > WEAPONS[id].radius + 30); // never pick a blast that would reach us
    if (!pool.length) return 'baby';
    if (t.ai === 'easy' && Math.random() < 0.55) return 'baby';
    if (t.ai === 'hard') {
      pool.sort((a, b) => WEAPONS[b].ai - WEAPONS[a].ai);
      // don't waste a nuke on someone who's nearly dead
      if (target.health + target.shield < 40) return pool[pool.length - 1];
      return pool[0];
    }
    if (Math.random() < 0.25) return 'baby';
    return pick(pool);
  },

  plan(game, t) {
    const prof = this.PROFILES[t.ai] || this.PROFILES.normal;
    const target = this.chooseTarget(game, t);
    let weapon = this.pickWeapon(t, target);
    const shield = (t.inventory.shield || 0) > 0 && t.shield <= 0 && (t.ai !== 'easy' || Math.random() < 0.5);
    if (weapon === 'laser') { // straight line: aim right at them, with enough power to reach
      const mx = t.x, my = t.y - 11, tx = target.x, ty = target.y - 8;
      const dist = Math.hypot(tx - mx, ty - my);
      const need = (dist + 30 - 160) / (W * 1.2) * 1000;
      if (need <= t.maxPower) {
        const ang = Math.atan2(-(ty - my), tx - mx) / DEG;
        return { angle: Math.round(clamp(ang + randn() * prof.angErr * 0.5, 0, 180) * 10) / 10, power: Math.round(clamp(need + 40, 50, t.maxPower)), weapon, shield, target };
      }
      weapon = 'baby';
    }
    const R = WEAPONS[weapon].radius;
    const tx = target.x, ty = target.y - 7;
    const maxP = t.maxPower;

    const farTarget = Math.abs(tx - t.x) > 220;
    const evalShot = (angle, power) => {
      let r = game.simulate(t, angle, power);
      if (!r) return 1e6;
      if (weapon === 'burrower' && r.ground) r = game.digPath(r.x, r.y, r.vx, r.vy, t);
      if (r.tank === target) return 0;
      let s = Math.hypot(r.x - tx, r.y - ty);
      const dSelf = Math.hypot(r.x - t.x, r.y - (t.y - 7));
      if (dSelf < R + 25) s += 2000; // don't hit yourself
      else if (farTarget && dSelf < 150) s += (150 - dSelf) * 4; // a shot into the hill at our feet is a wasted turn
      return s;
    };
    // Aiming error, but redrawn if it would turn a good shot into one that lands at our own feet.
    const wobble = (a0, p0, k) => {
      for (let i = 0; i < 8; i++) {
        const a = clamp(a0 + randn() * prof.angErr * k, 0, 180), p = clamp(p0 + randn() * prof.powErr * k, 50, maxP);
        const r = game.simulate(t, a, p);
        if (!r || Math.hypot(r.x - t.x, r.y - (t.y - 7)) > Math.max(R + 40, 110)) return { a, p };
      }
      return { a: a0, p: p0 };
    };
    const finish = (a0, p0, k) => {
      const w = wobble(a0, p0, k);
      return { angle: Math.round(w.a * 10) / 10, power: Math.round(w.p), weapon, shield, target };
    };

    // Memory of the last shot at this same target. If it hit and nothing has changed, do it again;
    // otherwise start the search from it and correct, the way a person walks shots in.
    const m = t.aiMem;
    const mem = m && m.target === target && weapon !== 'burrower' && m.weapon !== 'burrower' && m.weapon !== 'laser' &&
      Math.abs(game.wind - m.wind) <= 2 ? m : null;
    if (mem) {
      const end = t.lastTrail && t.lastTrail[t.lastTrail.length - 1];
      const hit = end && Math.hypot(end.x - mem.tx, end.y - (mem.ty - 7)) < mem.R + 20;
      const still = Math.abs(target.x - mem.tx) < 8 && Math.abs(target.y - mem.ty) < 8;
      if (hit && still) {
        const r = game.simulate(t, mem.angle, mem.power); // terrain may have changed in between
        if (r && (r.tank === target || Math.hypot(r.x - tx, r.y - ty) < R + 20)) return finish(mem.angle, mem.power, prof.repeat);
      }
    }

    const dir = tx > t.x ? 1 : -1;
    let best = { a: 90, p: 300, s: Infinity };
    if (mem) best = { a: mem.angle, p: clamp(mem.power, 50, maxP), s: evalShot(mem.angle, clamp(mem.power, 50, maxP)) };
    for (let i = 0; i < prof.samples; i++) {
      // In strong wind the best shot may be lobbed straight up or even away from the target.
      const a = Math.abs(game.wind) > 15 && Math.random() < 0.35 ? rand(5, 175) : dir > 0 ? rand(8, 88) : rand(92, 172);
      const p = rand(120, maxP);
      const s = evalShot(a, p);
      if (s < best.s) best = { a, p, s };
    }
    let sa = 8, sp = 80;
    for (let i = 0; i < prof.refine; i++) {
      if (best.s === 0 && i > 20) break;
      const a = clamp(best.a + randn() * sa, 0, 180);
      const p = clamp(best.p + randn() * sp, 50, maxP);
      const s = evalShot(a, p);
      if (s < best.s) best = { a, p, s };
      if (i % 20 === 19) { sa *= 0.6; sp *= 0.6; }
    }

    return finish(best.a, best.p, 1);
  },

  shop(t) {
    const prefs = ['missile', 'babynuke', 'shield', 'mirv', 'parachute', 'napalm', 'funky', 'laser', 'leapfrog', 'burrower', 'roller', 'nuke'];
    const budget = t.money * (t.ai === 'easy' ? 0.5 : t.ai === 'hard' ? 0.95 : 0.8);
    let spent = 0;
    for (let tries = 0; tries < 40; tries++) {
      const ok = prefs.filter(id => {
        const e = shopEntry(id);
        if (id === 'shield' && (t.inventory.shield || 0) >= 2) return false;
        if (id === 'parachute' && (t.inventory.parachute || 0) >= 4) return false;
        return e.price <= t.money && spent + e.price <= budget;
      });
      if (!ok.length) break;
      const id = ok[Math.floor(Math.pow(Math.random(), 1.6) * ok.length)];
      if (buyItem(t, id)) spent += shopEntry(id).price;
    }
  },
};
