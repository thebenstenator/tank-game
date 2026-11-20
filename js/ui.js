'use strict';

const PLAYER_TYPES = [
  ['human', 'Human'],
  ['easy', 'CPU · Easy'],
  ['normal', 'CPU · Normal'],
  ['hard', 'CPU · Hard'],
];

const UI = {
  cache: {},
  els: {},

  $(id) { return this.els[id] || (this.els[id] = document.getElementById(id)); },

  init(game) {
    this.game = game;
    this.defs = [
      { name: DEFAULT_NAMES[0], type: 'human' },
      { name: DEFAULT_NAMES[1], type: 'normal' },
    ];
    this.renderRows();

    this.$('add-player').onclick = () => {
      if (this.defs.length >= MAX_PLAYERS) return;
      const i = this.defs.length;
      this.defs.push({ name: DEFAULT_NAMES[i], type: 'normal' });
      this.renderRows();
    };
    this.$('start-btn').onclick = () => this.startGame();
    this.$('ro-next').onclick = () => this.onRoundNext && this.onRoundNext();
    this.$('shop-done').onclick = () => this.onShopDone && this.onShopDone();
    this.bindHud();
    this.bindEdit('hud-angle', 'angle');
    this.bindEdit('hud-power', 'power');
  },

  // ------------------------------------------------------------ setup

  renderRows() {
    const wrap = this.$('player-rows');
    wrap.innerHTML = '';
    this.defs.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML =
        `<span class="pcolor" style="--c:${PLAYER_COLORS[i]}"></span>` +
        `<input class="pname" maxlength="12" spellcheck="false">` +
        `<select class="ptype">${PLAYER_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>` +
        `<button class="premove" title="Remove">✕</button>`;
      const inp = row.querySelector('input');
      inp.value = d.name;
      inp.oninput = () => { d.name = inp.value; };
      const sel = row.querySelector('select');
      sel.value = d.type;
      sel.onchange = () => { d.type = sel.value; };
      const rm = row.querySelector('button');
      rm.disabled = this.defs.length <= 2;
      rm.onclick = () => { this.defs.splice(i, 1); this.renderRows(); };
      wrap.appendChild(row);
    });
    this.$('add-player').disabled = this.defs.length >= MAX_PLAYERS;
  },

  startGame() {
    Sound.init();
    const settings = {
      rounds: +this.$('opt-rounds').value,
      money: +this.$('opt-money').value,
      wind: this.$('opt-wind').value,
      terrain: this.$('opt-terrain').value,
      windChange: this.$('opt-windchange').checked,
    };
    const defs = this.defs.map((d, i) => ({
      name: d.name.trim() || DEFAULT_NAMES[i],
      color: PLAYER_COLORS[i],
      ai: d.type === 'human' ? null : d.type,
    }));
    this.$('setup').classList.add('hidden');
    if (document.activeElement) document.activeElement.blur();
    this.cache = {};
    this.game.startMatch(defs, settings);
  },

  backToMenu() {
    ['shop', 'roundover'].forEach(id => this.$(id).classList.add('hidden'));
    this.$('setup').classList.remove('hidden');
    this.game.preview();
  },

  // ------------------------------------------------------------ HUD

  bindHud() {
    const hud = this.$('hud');
    hud.querySelectorAll('button').forEach(b => {
      b.tabIndex = -1;
      b.addEventListener('mousedown', e => e.preventDefault()); // keep focus off buttons
    });
    hud.querySelectorAll('[data-hold]').forEach(b => {
      const key = b.dataset.hold;
      const up = () => { delete this.game.keys[key]; };
      b.addEventListener('pointerdown', e => {
        this.commitEdits();
        if (!this.game.humanTurn) return;
        b.setPointerCapture(e.pointerId);
        this.game.keys[key] = { t: 0, started: false };
      });
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    });
    hud.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        this.commitEdits();
        const g = this.game;
        switch (b.dataset.act) {
          case 'prev': g.cycleWeapon(-1); break;
          case 'next': g.cycleWeapon(1); break;
          case 'fire': if (g.humanTurn) g.fire(); break;
          case 'shield': if (g.humanTurn) g.activateShield(g.current); break;
          case 'mute': this.toggleMute(); break;
          case 'menu': if (confirm('Quit to the main menu? This match will be lost.')) this.backToMenu(); break;
        }
      });
    });
  },

  // ------------------------------------------------------------ typed angle / power

  /** Clicking the angle or power readout turns it into a text box. Enter or click away to apply, Esc to cancel. */
  bindEdit(id, prop) {
    const span = this.$(id), input = this.$(id + '-edit');
    const close = () => {
      if (this.editing === prop) this.editing = null; // first, so the blur from hiding doesn't commit
      input.classList.add('hidden');
      span.classList.remove('hidden');
    };
    const commit = () => {
      if (this.editing !== prop) return;
      const t = this.game.current;
      const v = parseFloat(input.value.replace(/[^0-9.-]/g, ''));
      if (t && this.game.humanTurn && isFinite(v)) {
        t[prop] = prop === 'angle' ? clamp(Math.round(v), 0, 180) : clamp(Math.round(v), 0, t.maxPower);
        Sound.click();
      }
      close();
    };
    span.addEventListener('click', () => {
      const t = this.game.current;
      if (!this.game.humanTurn || !t) return;
      this.commitEdits();
      this.editing = prop;
      input.value = String(Math.round(t[prop]));
      span.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.select();
    });
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { // hop between the two boxes
        e.preventDefault();
        commit();
        this.$(prop === 'angle' ? 'hud-power' : 'hud-angle').click();
      }
    });
    input.addEventListener('blur', commit);
    this.editCommit = this.editCommit || {};
    this.editCommit[prop] = commit;
    this.editClose = this.editClose || {};
    this.editClose[prop] = close;
  },

  commitEdits() {
    if (this.editing && this.editCommit) this.editCommit[this.editing]();
  },

  toggleMute() {
    Sound.init();
    const m = Sound.toggle();
    this.$('hud-mute').textContent = m ? '🔇' : '🔊';
  },

  set(id, prop, val) {
    const key = id + '|' + prop;
    if (this.cache[key] === val) return;
    this.cache[key] = val;
    const el = this.$(id);
    if (prop === 'text') el.textContent = val;
    else if (prop === 'class') el.className = val;
    else if (prop.startsWith('--')) el.style.setProperty(prop, val);
    else if (prop === 'disabled') el.disabled = val;
    else el.style[prop] = val;
  },

  updateHUD(game) {
    const inMatch = game.state !== 'setup' && game.players.length > 0;
    const t = game.current;
    const locked = !game.humanTurn;
    this.set('hud', 'class', !inMatch || !t ? 'hidden' : locked ? 'locked' : '');
    if (locked && this.editing) this.editClose[this.editing]();
    if (!inMatch || !t) return;

    this.set('hud-name', 'text', t.name);
    this.set('hud-swatch', '--c', t.color);
    this.set('hud-health', 'text', String(Math.ceil(t.health)));
    this.set('hud-money', 'text', fmtMoney(t.money));
    this.set('hud-angle', 'text', Math.round(t.angle) + '°');
    this.set('hud-power', 'text', String(Math.round(t.power)));
    this.set('hud-maxpow', 'text', t.maxPower < 1000 ? `· max ${t.maxPower}` : '');
    this.set('hud-powerfill', 'width', (t.power / 10).toFixed(1) + '%');
    this.set('hud-powermax', 'width', (100 - t.maxPower / 10).toFixed(1) + '%');

    const w = WEAPONS[t.weapon];
    const n = t.ammo(t.weapon);
    this.set('hud-weapon', 'text', w.name);
    this.set('hud-wcount', 'text', n === Infinity ? '∞' : '×' + n);
    this.set('hud-wdot', '--c', w.color);

    const wind = game.wind;
    this.set('hud-wind', 'class', wind === 0 ? 'wind calm' : 'wind');
    this.set('hud-windval', 'text', wind === 0 ? 'Calm' : String(Math.abs(wind)));
    this.set('hud-windarrow', 'transform', wind < 0 ? 'scaleX(-1)' : 'none');

    const sc = t.inventory.shield || 0;
    this.set('hud-shieldcount', 'text', t.shield > 0 ? Math.ceil(t.shield) + '%' : String(sc));
    this.set('hud-shield', 'class', 'hbtn shield-btn' + (t.shield > 0 ? ' active' : ''));
    this.set('hud-shield', 'disabled', sc <= 0 || t.shield > 0);

    this.set('hud-round', 'text', `Round ${game.round}/${game.settings.rounds}`);
  },

  // ------------------------------------------------------------ messages

  toast(title, sub = '', ms = 1800) {
    this.$('toast-title').textContent = title;
    this.$('toast-sub').textContent = sub;
    const el = this.$('toast');
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  },

  banner(text, color) {
    const el = this.$('banner');
    el.textContent = text;
    el.style.setProperty('--c', color);
    el.classList.remove('show');
    void el.offsetWidth; // restart animation
    el.classList.add('show');
  },

  // ------------------------------------------------------------ round over / shop

  standingsHTML(players) {
    const sorted = players.slice().sort((a, b) => b.wins - a.wins || b.kills - a.kills || b.money - a.money);
    return '<tr><th>#</th><th>Tank</th><th>Wins</th><th>Kills</th><th>Cash</th></tr>' +
      sorted.map((p, i) =>
        `<tr class="${p.alive ? '' : 'dead'}"><td>${i + 1}</td>` +
        `<td><span class="pn" style="--c:${p.color}"><i></i>${escapeHtml(p.name)}</span></td>` +
        `<td>${p.wins}</td><td>${p.kills}</td><td>${fmtMoney(p.money)}</td></tr>`).join('');
  },

  showRoundOver(game) {
    const last = game.round >= game.settings.rounds;
    const w = game.roundWinner;
    this.$('ro-eyebrow').textContent = `Round ${game.round} of ${game.settings.rounds} complete`;
    this.$('ro-title').textContent = w ? `${w.name} takes the round` : 'Nobody survived';
    this.$('ro-title').style.color = w ? w.color : '';
    this.$('ro-table').innerHTML = this.standingsHTML(game.players);
    const humans = game.players.some(p => !p.ai);
    this.$('ro-next').textContent = last ? 'See final results' : humans ? 'Visit the armory' : 'Next round';
    this.$('roundover').classList.remove('hidden');
    this.onRoundNext = () => {
      this.$('roundover').classList.add('hidden');
      if (last) this.showGameOver(game);
      else this.runShop(game, () => game.startRound());
    };
  },

  showGameOver(game) {
    const sorted = game.players.slice().sort((a, b) => b.wins - a.wins || b.kills - a.kills || b.money - a.money);
    const top = sorted[0];
    const tie = sorted.length > 1 && sorted[1].wins === top.wins && sorted[1].kills === top.kills;
    game.players.forEach(p => { p.alive = true; });
    this.$('ro-eyebrow').textContent = 'Final results';
    this.$('ro-title').textContent = tie ? "It's a draw!" : `${top.name} wins the war!`;
    this.$('ro-title').style.color = tie ? '' : top.color;
    this.$('ro-table').innerHTML = this.standingsHTML(game.players);
    this.$('ro-next').textContent = 'New game';
    this.$('roundover').classList.remove('hidden');
    Sound.win();
    this.onRoundNext = () => this.backToMenu();
  },

  runShop(game, done) {
    game.players.filter(p => p.ai).forEach(p => AI.shop(p));
    const humans = game.players.filter(p => !p.ai);
    let i = 0;
    const next = () => {
      if (i >= humans.length) {
        this.$('shop').classList.add('hidden');
        done();
        return;
      }
      this.showShopFor(humans[i++], game, next);
    };
    next();
  },

  showShopFor(t, game, next) {
    this.$('shop').classList.remove('hidden');
    this.$('shop-eyebrow').textContent = `Armory · before round ${game.round + 1}`;
    this.$('shop-name').textContent = t.name;
    this.$('shop-name').style.setProperty('--c', t.color);
    const render = () => {
      this.$('shop-money').textContent = fmtMoney(t.money);
      const grid = this.$('shop-grid');
      grid.innerHTML = '';
      for (const id of SHOP_ORDER) {
        const e = shopEntry(id);
        const card = document.createElement('div');
        card.className = 'card' + (t.money < e.price ? ' unaffordable' : '');
        card.innerHTML =
          `<div class="card-top"><span class="wdot" style="--c:${e.color}"></span><span class="card-name">${e.name}</span>` +
          `<span class="owned">Owned <b>${t.inventory[id] || 0}</b></span></div>` +
          `<p>${e.desc}</p>` +
          `<div class="card-foot"><span class="price">${fmtMoney(e.price)} <small>for ${e.bundle}</small></span>` +
          `<button class="btn small">Buy</button></div>`;
        const btn = card.querySelector('button');
        btn.disabled = t.money < e.price;
        btn.onclick = () => { if (buyItem(t, id)) { Sound.buy(); render(); } };
        grid.appendChild(card);
      }
    };
    render();
    this.onShopDone = next;
  },
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
