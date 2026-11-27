'use strict';

const PLAYER_TYPES = [
  ['human', 'Human'],
  ['easy', 'CPU · Easy'],
  ['normal', 'CPU · Normal'],
  ['hard', 'CPU · Hard'],
];
const CPU_TYPES = PLAYER_TYPES.slice(1);

function loadPref(k, d) { try { return localStorage.getItem('hh.' + k) || d; } catch (e) { return d; } }
function savePref(k, v) { try { localStorage.setItem('hh.' + k, v); } catch (e) { /* ignore */ } }

const UI = {
  cache: {},
  els: {},
  mode: 'local',    // 'local' | 'host' | 'join'

  $(id) { return this.els[id] || (this.els[id] = document.getElementById(id)); },

  init(game) {
    this.game = game;
    this.localDefs = [
      { name: DEFAULT_NAMES[0], type: 'human' },
      { name: DEFAULT_NAMES[1], type: 'normal' },
    ];
    this.defs = this.localDefs;
    this.renderRows();

    this.$('add-player').onclick = () => {
      if (this.defs.length >= MAX_PLAYERS) return;
      const i = this.defs.length;
      this.defs.push({ name: this.mode === 'host' ? `CPU ${DEFAULT_NAMES[i]}` : DEFAULT_NAMES[i], type: 'normal' });
      this.renderRows();
    };
    this.$('start-btn').onclick = () => this.startGame();
    this.$('dev-btn').onclick = () => this.startDev();
    this.$('ro-next').onclick = () => this.onRoundNext && this.onRoundNext();
    this.$('shop-done').onclick = () => this.onShopDone && this.onShopDone();
    this.$('shop-prev').onclick = () => this.shopPage(-1);
    this.$('shop-next').onclick = () => this.shopPage(1);
    window.addEventListener('resize', () => { if (this.shopRender && !this.$('shop').classList.contains('hidden')) this.shopRender(); });
    this.bindHud();
    this.bindEdit('hud-angle', 'angle');
    this.bindEdit('hud-power', 'power');
    this.bindOnline();
    this.bindAudio();
    this.$('setup-fs').onclick = () => this.toggleFullscreen();
    const onFs = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      this.$('setup-fs').textContent = on ? '⛶ Exit full screen' : '⛶ Full screen';
      this.$('hud-fs').title = on ? 'Exit full screen (F)' : 'Full screen (F)';
      // On the menu, rebuild the backdrop so it fills the new screen shape. Mid-round the
      // battlefield keeps its size (letterboxed) and refits at the start of the next round.
      if (this.game.state === 'setup') setTimeout(() => this.game.preview(), 50);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
  },

  toggleFullscreen() {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!req) { this.toast('Full screen unavailable', 'This browser does not support it', 2000); return; }
      const p = req.call(el);
      if (p && p.catch) p.catch(() => this.toast('Full screen was blocked', 'Try the button again', 2000));
    }
  },

  // ------------------------------------------------------------ setup

  renderRows() {
    const wrap = this.$('player-rows');
    wrap.innerHTML = '';
    const online = this.mode === 'host';
    const minRows = online ? 1 : 2;
    this.defs.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'prow';
      const fixed = d.type === 'host' || d.type === 'remote';
      const types = online ? CPU_TYPES : PLAYER_TYPES;
      row.innerHTML =
        `<span class="pcolor" style="--c:${PLAYER_COLORS[i]}"></span>` +
        `<input class="pname" maxlength="12" spellcheck="false">` +
        (fixed
          ? `<span class="ptag ${d.type}">${d.type === 'host' ? 'You · Host' : 'Online'}</span>`
          : `<select class="ptype">${types.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`) +
        `<button class="premove" title="${d.type === 'remote' ? 'Remove from room' : 'Remove'}">✕</button>`;
      const inp = row.querySelector('input');
      inp.value = d.name;
      inp.readOnly = d.type === 'remote';
      inp.oninput = () => {
        d.name = inp.value;
        if (d.type === 'host') savePref('name', inp.value.trim());
        if (online) this.broadcastLobby();
      };
      const sel = row.querySelector('select');
      if (sel) {
        sel.value = d.type;
        sel.onchange = () => { d.type = sel.value; if (online) this.broadcastLobby(); };
      }
      const rm = row.querySelector('button');
      rm.disabled = d.type === 'host' || this.defs.length <= minRows;
      rm.onclick = () => {
        if (d.type === 'remote') { Net.kick(d.peer); return; }
        this.defs.splice(i, 1);
        this.renderRows();
      };
      wrap.appendChild(row);
    });
    this.$('add-player').disabled = this.defs.length >= MAX_PLAYERS;
    this.$('add-player').textContent = online ? '+ Add CPU' : '+ Add tank';
    if (online) {
      this.$('start-btn').disabled = this.defs.length < 2 || !Net.code;
      this.broadcastLobby();
    } else {
      this.$('start-btn').disabled = false;
    }
  },

  readSettings() {
    return {
      rounds: +this.$('opt-rounds').value,
      money: +this.$('opt-money').value,
      wind: this.$('opt-wind').value,
      terrain: this.$('opt-terrain').value,
      windChange: this.$('opt-windchange').checked,
    };
  },

  rulesSummary() {
    const s = this.readSettings();
    const label = id => { const el = this.$(id); const o = el.options && el.options[el.selectedIndex]; return o ? o.textContent : el.value; };
    return `${s.rounds} round${s.rounds === 1 ? '' : 's'} · ${fmtMoney(s.money)} to start · ${label('opt-terrain')} terrain · ${label('opt-wind')} wind`;
  },

  startGame() {
    Sound.init();
    const settings = this.readSettings();
    const defs = this.defs.map((d, i) => ({
      name: d.name.trim() || DEFAULT_NAMES[i],
      color: PLAYER_COLORS[i],
      ai: d.type === 'human' || d.type === 'host' || d.type === 'remote' ? null : d.type,
      owner: d.type === 'host' ? 'host' : d.type === 'remote' ? d.peer : null,
    }));
    if (this.mode === 'host') {
      if (defs.length < 2) return;
      Net.startMatch();
    }
    this.$('setup').classList.add('hidden');
    if (document.activeElement) document.activeElement.blur();
    this.cache = {};
    this.game.startMatch(defs, settings);
  },

  /** Weapon test range: you plus five targets that never shoot back. */
  startDev() {
    Sound.init();
    const me = this.defs.find(d => d.type === 'human');
    const defs = [{ name: (me && me.name.trim()) || 'You', color: PLAYER_COLORS[0], ai: null, owner: null }];
    for (let i = 1; i < MAX_PLAYERS; i++) defs.push({ name: 'Target ' + i, color: PLAYER_COLORS[i], ai: 'dummy', owner: null });
    this.$('setup').classList.add('hidden');
    if (document.activeElement) document.activeElement.blur();
    this.cache = {};
    this.game.startMatch(defs, { ...this.readSettings(), rounds: 1 }, true);
    this.game.devRespawn();
  },

  backToMenu() {
    ['shop', 'roundover', 'netwait'].forEach(id => this.$(id).classList.add('hidden'));
    this.$('setup').classList.remove('hidden');
    this.game.preview();
    if (Net.isHost) { Net.backToLobby(); this.renderRows(); }
    if (Net.isClient) this.showJoinLobby(this.lastLobby);
  },

  // ------------------------------------------------------------ online

  bindOnline() {
    this.$('mode-tabs').querySelectorAll('button').forEach(b => {
      b.onclick = () => this.setMode(b.dataset.mode);
    });
    this.$('join-btn').onclick = () => this.joinRoom();
    this.$('join-code').oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
    this.$('join-code').onkeydown = e => { if (e.key === 'Enter') this.joinRoom(); };
    this.$('join-name').value = loadPref('name', '');
    this.$('leave-btn').onclick = () => { Net.leave(); this.showJoinForm(''); };
    this.$('copy-code').onclick = () => this.copyInvite();
    ['opt-rounds', 'opt-money', 'opt-wind', 'opt-terrain', 'opt-windchange'].forEach(id => {
      this.$(id).addEventListener('change', () => { if (this.mode === 'host') this.broadcastLobby(); });
    });

    Net.init(this.game, {
      hostReady: code => {
        this.$('room-code').textContent = code;
        this.$('host-status').textContent = 'Share the code. Friends join from the “Join online” tab.';
        this.renderRows();
      },
      error: msg => {
        if (this.mode === 'join') this.showJoinForm(msg);
        else if (this.mode === 'host') this.$('host-status').textContent = msg;
      },
      canJoin: () => this.defs.length < MAX_PLAYERS,
      guestJoined: (peer, name) => {
        this.defs.push({ name, type: 'remote', peer });
        this.renderRows();
        Sound.init(); Sound.buy();
      },
      guestLeft: peer => {
        const i = this.defs.findIndex(d => d.peer === peer);
        if (i >= 0) { this.defs.splice(i, 1); if (!Net.inMatch) this.renderRows(); }
      },
      note: m => this.toast(m.title, m.sub || '', 2600),
      waiting: text => this.netWaiting(text),
      joined: code => {
        this.$('join-status').textContent = '';
        this.showJoinLobby({ players: [], rules: '' }, code);
      },
      lobby: m => this.showJoinLobby(m),
      roundStarting: g => {
        ['setup', 'shop', 'roundover', 'netwait'].forEach(id => this.$(id).classList.add('hidden'));
        if (document.activeElement) document.activeElement.blur();
        this.cache = {};
        const styleName = { gentle: 'Gentle', hilly: 'Hilly', mountains: 'Mountainous', wild: 'Wild' }[g.terrainStyle] || '';
        this.toast(`Round ${g.round} of ${g.settings.rounds}`, `${g.theme.name} · ${styleName} terrain`, 2200);
      },
      toLobby: () => {
        if (this.$('roundover').classList.contains('hidden') || this.game.state !== 'roundOver') {
          ['shop', 'roundover', 'netwait'].forEach(id => this.$(id).classList.add('hidden'));
          this.$('setup').classList.remove('hidden');
          this.game.preview();
          this.showJoinLobby(this.lastLobby);
        }
      },
      hostLost: msg => {
        ['shop', 'roundover', 'netwait'].forEach(id => this.$(id).classList.add('hidden'));
        this.$('setup').classList.remove('hidden');
        this.game.preview();
        this.showJoinForm(msg);
      },
    });

    // Invite links: ?join=CODE opens straight to the join tab with the code filled in.
    const m = /[?&]join=([A-Za-z0-9]{5})/.exec(location.search || '');
    if (m) { this.setMode('join'); this.$('join-code').value = m[1].toUpperCase(); }
  },

  setMode(mode) {
    if (mode === this.mode) return;
    if ((mode === 'host' || mode === 'join') && !Net.available()) {
      this.toast('Online play unavailable', 'Could not load the networking library — are you offline?', 3200);
      return;
    }
    if (Net.isHost && Net.conns.size && !confirm('Close the room? Everyone in it will be disconnected.')) return;
    Net.leave();
    this.mode = mode;
    this.$('mode-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    this.$('setup-cols').classList.toggle('hidden', mode === 'join');
    this.$('start-btn').classList.toggle('hidden', mode === 'join');
    this.$('dev-btn').classList.toggle('hidden', mode !== 'local');
    this.$('host-bar').classList.toggle('hidden', mode !== 'host');
    this.$('join-panel').classList.toggle('hidden', mode !== 'join');
    if (mode === 'local') {
      this.defs = this.localDefs;
    } else if (mode === 'host') {
      this.defs = [{ name: loadPref('name', '') || 'Host', type: 'host' }];
      this.$('room-code').textContent = '·····';
      this.$('host-status').textContent = 'Opening a room…';
      Net.host();
    } else {
      this.showJoinForm('');
    }
    this.renderRows();
  },

  broadcastLobby() {
    if (!Net.isHost) return;
    Net.broadcast({
      type: 'lobby',
      players: this.defs.map((d, i) => ({
        name: d.name.trim() || DEFAULT_NAMES[i],
        color: PLAYER_COLORS[i],
        kind: d.type === 'host' ? 'Host' : d.type === 'remote' ? 'Online' : (CPU_TYPES.find(c => c[0] === d.type) || [0, 'CPU'])[1],
        peer: d.peer || null,
      })),
      rules: this.rulesSummary(),
    });
  },

  copyInvite() {
    const code = Net.code;
    if (!code) return;
    const web = /^https?:/.test(location.protocol);
    const text = web ? `${location.origin}${location.pathname}?join=${code}` : code;
    const done = () => this.toast(web ? 'Invite link copied' : 'Room code copied', text, 2200);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  },

  joinRoom() {
    const name = this.$('join-name').value.trim() || 'Guest';
    const code = this.$('join-code').value.trim().toUpperCase();
    if (code.length !== 5) { this.$('join-status').textContent = 'Room codes are 5 characters.'; return; }
    savePref('name', name);
    Sound.init();
    this.$('join-status').textContent = 'Connecting…';
    this.$('join-btn').disabled = true;
    Net.join(code, name);
  },

  showJoinForm(msg) {
    this.$('join-form').classList.remove('hidden');
    this.$('join-lobby').classList.add('hidden');
    this.$('join-btn').disabled = false;
    this.$('join-status').textContent = msg || '';
  },

  showJoinLobby(m, code) {
    if (!Net.isClient) return;
    m = m || { players: [], rules: '' };
    this.lastLobby = m;
    this.$('join-form').classList.add('hidden');
    this.$('join-lobby').classList.remove('hidden');
    this.$('join-btn').disabled = false;
    this.$('join-room').textContent = code || Net.code || '';
    this.$('join-players').innerHTML = m.players.map(p =>
      `<div class="prow lobby-row"><span class="pcolor" style="--c:${p.color}"></span>` +
      `<span class="lobby-name">${escapeHtml(p.name)}${p.peer === Net.myId ? ' <em>(you)</em>' : ''}</span>` +
      `<span class="ptag">${escapeHtml(p.kind)}</span></div>`).join('') ||
      '<p class="join-wait">Joining…</p>';
    this.$('join-rules').textContent = m.rules || '';
  },

  netWaiting(text) {
    const el = this.$('netwait');
    if (!text) { el.classList.add('hidden'); return; }
    this.$('netwait-text').textContent = text;
    el.classList.remove('hidden');
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
          case 'audio': this.openAudio(); break;
          case 'fullscreen': this.toggleFullscreen(); break;
          case 'skip': g.skipRound(); break;
          case 'menu': this.quitPrompt(); break;
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
      const txt = input.value.toLowerCase();
      const v = parseFloat(txt.replace(/[^0-9.]/g, ''));
      if (t && this.game.humanTurn && isFinite(v)) {
        if (prop === 'angle') {
          // degrees off vertical; L/R (or < >) picks the side, otherwise keep the current one
          const left = /[l<]/.test(txt) ? true : /[r>]/.test(txt) ? false : t.angle > 90 || (t.angle === 90 && t.x > W / 2);
          const d = clamp(Math.round(v), 0, 90 + ANGLE_DIP);
          t.angle = left ? 90 + d : 90 - d;
        } else t[prop] = clamp(Math.round(v), 0, t.maxPower);
        Sound.click();
      }
      close();
    };
    span.addEventListener('click', () => {
      const t = this.game.current;
      if (!this.game.humanTurn || !t) return;
      this.commitEdits();
      this.editing = prop;
      input.value = prop === 'angle' ? String(Math.round(Math.abs(90 - t.angle))) : String(Math.round(t[prop]));
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

  quitPrompt() {
    if (Net.isClient) {
      if (!confirm('Leave this online match?')) return;
      Net.leave();
      ['shop', 'roundover', 'netwait'].forEach(id => this.$(id).classList.add('hidden'));
      this.$('setup').classList.remove('hidden');
      this.game.preview();
      this.showJoinForm('You left the match.');
      return;
    }
    if (this.game.dev) { this.backToMenu(); return; }
    const msg = Net.isHost ? 'End this match for everyone and go back to the lobby?' : 'Quit to the main menu? This match will be lost.';
    if (confirm(msg)) this.backToMenu();
  },

  toggleMute() {
    Sound.init();
    Sound.toggle();
    this.syncAudio();
  },

  // ------------------------------------------------------------ audio settings

  bindAudio() {
    Sound.loadSettings();
    for (const k of ['master', 'sfx', 'music']) {
      const input = this.$('aud-' + k);
      input.addEventListener('input', () => {
        Sound.init();
        Sound.setSetting(k, +input.value);
        this.syncAudio();
      });
      // A sample click when you let go of the effects slider, so you can hear the new level.
      if (k !== 'music') input.addEventListener('change', () => Sound.click());
    }
    this.$('aud-mute').onchange = () => this.toggleMute();
    this.$('aud-musicon').onchange = e => this.setMusicOn(e.target.checked);
    this.$('setup-music').onclick = () => this.setMusicOn(!Sound.settings.musicOn);
    this.$('setup-audio').onclick = () => this.openAudio();
    this.$('aud-done').onclick = () => this.closeAudio();
    this.$('aud-reset').onclick = () => {
      Sound.init();
      Object.assign(Sound.settings, { master: 80, music: 80, sfx: 80, musicOn: true });
      if (Sound.muted) Sound.toggle();
      Sound.applyGain();
      Sound.saveSettings();
      this.syncAudio();
    };
    // Click the dimmed backdrop to close.
    this.$('audio-menu').addEventListener('pointerdown', e => { if (e.target.id === 'audio-menu') this.closeAudio(); });
    this.syncAudio();
  },

  setMusicOn(on) {
    Sound.init();
    Sound.setSetting('musicOn', on);
    this.syncAudio();
  },

  get audioOpen() { return !this.$('audio-menu').classList.contains('hidden'); },

  openAudio() {
    Sound.init();
    this.commitEdits();
    this.game.keys = {};
    this.syncAudio();
    this.$('audio-note').classList.toggle('hidden', this.game.state === 'setup');
    this.$('audio-menu').classList.remove('hidden');
    this.$('aud-done').focus();
  },

  closeAudio() {
    this.$('audio-menu').classList.add('hidden');
    if (document.activeElement) document.activeElement.blur();
  },

  /** Bring every audio control (panel, title-screen buttons, HUD icon) in line with the settings. */
  syncAudio() {
    const s = Sound.settings, m = Sound.muted;
    for (const k of ['master', 'sfx', 'music']) {
      this.$('aud-' + k).value = s[k];
      this.$('aud-' + k + '-val').textContent = s[k];
    }
    this.$('aud-mute').checked = m;
    this.$('aud-musicon').checked = s.musicOn;
    this.$('audio-menu').querySelector('.audio-panel').classList.toggle('muted', m);
    const mb = this.$('setup-music');
    mb.textContent = s.musicOn ? '🎵 Music on' : '🎵 Music off';
    mb.classList.toggle('off', !s.musicOn);
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
    this.set('hud-angle', 'text', fmtAngle(t.angle));
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

    this.set('hud-skip', 'class', game.skipping ? 'skip-btn busy' : game.canSkip ? 'skip-btn' : 'skip-btn hidden');
    this.set('hud-skip', 'text', game.skipping ? 'Skipping…' : 'Skip to end ⏭');
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
    const humans = Net.active || game.players.some(p => !p.ai);
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
    this.$('ro-next').textContent = Net.active ? 'Back to the lobby' : 'New game';
    this.$('roundover').classList.remove('hidden');
    Sound.win();
    this.onRoundNext = () => this.backToMenu();
  },

  runShop(game, done) {
    if (Net.active) { // online: everyone shops on their own screen at once
      if (Net.isHost) game.players.filter(p => p.ai).forEach(p => AI.shop(p));
      const me = game.players.find(p => p.owner === Net.myId && !p.ai);
      const finish = () => { this.$('shop').classList.add('hidden'); Net.shopDone(me); };
      if (me) this.showShopFor(me, game, finish); else finish();
      return;
    }
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
    this.shopPageIdx = 0;
    const render = () => {
      this.$('shop-money').textContent = fmtMoney(t.money);
      const grid = this.$('shop-grid');
      grid.innerHTML = '';
      grid.style.gridAutoRows = '';
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
      this.paginateShop();
    };
    this.shopRender = render;
    render();
    this.onShopDone = next;
  },

  // Split the armory into pages that fit the window instead of scrolling.
  paginateShop() {
    const grid = this.$('shop-grid');
    const panel = grid.closest('.panel');
    const cards = [...grid.children];
    const pager = this.$('shop-pager');
    pager.classList.remove('hidden');
    grid.style.minHeight = '';
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const cardH = Math.max(1, ...cards.map(c => c.offsetHeight));
    const avail = window.innerHeight - 48 - (panel.offsetHeight - grid.offsetHeight);
    const rows = Math.max(1, Math.floor((avail + gap) / (cardH + gap)));
    const per = cols * rows;
    const pages = Math.max(1, Math.ceil(cards.length / per));
    this.shopPages = pages;
    this.shopPageIdx = clamp(this.shopPageIdx || 0, 0, pages - 1);
    const p = this.shopPageIdx;
    grid.style.gridAutoRows = cardH + 'px';
    cards.forEach((c, i) => { c.style.display = (i >= p * per && i < (p + 1) * per) ? '' : 'none'; });
    if (pages <= 1) { pager.classList.add('hidden'); return; }
    // keep the panel the same height on a short last page
    grid.style.minHeight = (Math.min(rows, Math.ceil(cards.length / cols)) * (cardH + gap) - gap) + 'px';
    const dots = this.$('shop-dots');
    dots.innerHTML = '';
    for (let i = 0; i < pages; i++) {
      const d = document.createElement('i');
      if (i === p) d.className = 'on';
      d.onclick = () => { this.shopPageIdx = i; this.paginateShop(); };
      dots.appendChild(d);
    }
    const label = document.createElement('span');
    label.className = 'pager-label';
    label.textContent = `${p + 1} / ${pages}`;
    dots.appendChild(label);
    this.$('shop-prev').disabled = p === 0;
    this.$('shop-next').disabled = p === pages - 1;
  },

  shopPage(delta) {
    if (!this.shopPages || this.shopPages <= 1) return;
    const n = clamp((this.shopPageIdx || 0) + delta, 0, this.shopPages - 1);
    if (n === this.shopPageIdx) return;
    this.shopPageIdx = n;
    this.paginateShop();
  },
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
