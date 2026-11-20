'use strict';

/**
 * Computer opponents. They simulate candidate shots with the real physics,
 * keep the best, then add aiming error based on difficulty.
 */
const AI = {
  PROFILES: {
    easy:   { angErr: 7,   powErr: 70, samples: 110, refine: 60 },
    normal: { angErr: 2.4, powErr: 24, samples: 200, refine: 120 },
    hard:   { angErr: 0.6, powErr: 7,  samples: 300, refine: 180 },
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
    const pool = WEAPON_ORDER.filter(id => id !== 'baby' && id !== 'dirt' && t.ammo(id) > 0 && (id !== 'roller' || lower));
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
    const weapon = this.pickWeapon(t, target);
    const R = WEAPONS[weapon].radius;
    const tx = target.x, ty = target.y - 7;
    const maxP = t.maxPower;

    const evalShot = (angle, power) => {
      const r = game.simulate(t, angle, power);
      if (!r) return 1e6;
      if (r.tank === target) return 0;
      let s = Math.hypot(r.x - tx, r.y - ty);
      if (Math.hypot(r.x - t.x, r.y - (t.y - 7)) < R + 25) s += 2000; // don't hit yourself
      return s;
    };

    const dir = tx > t.x ? 1 : -1;
    let best = { a: 90, p: 300, s: Infinity };
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

    const angle = Math.round(clamp(best.a + randn() * prof.angErr, 0, 180) * 10) / 10;
    const power = Math.round(clamp(best.p + randn() * prof.powErr, 50, maxP));
    const shield = (t.inventory.shield || 0) > 0 && t.shield <= 0 && (t.ai !== 'easy' || Math.random() < 0.5);
    return { angle, power, weapon, shield };
  },

  shop(t) {
    const prefs = ['missile', 'babynuke', 'shield', 'mirv', 'parachute', 'funky', 'leapfrog', 'roller', 'nuke'];
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
