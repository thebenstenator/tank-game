'use strict';

/**
 * Online play for friends, peer-to-peer over WebRTC via PeerJS.
 *
 * The host's browser runs the real game. Guests send their inputs (aim, fire, shield,
 * shopping) to the host. When anyone fires, the host broadcasts the shot plus a random
 * seed, and every screen plays it out with the same physics and seeded randomness.
 * At the start of every turn the host sends a full snapshot (terrain, tanks, wind),
 * which corrects any small drift between screens.
 *
 * PeerJS's free public server is only used to introduce the browsers to each other;
 * game traffic goes directly between them.
 */
const Net = {
  PREFIX: 'howitzer-hills-',
  CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  TIMEOUT: 15000,       // ms without hearing from someone before they count as gone
  AIM_RATE: 1 / 15,     // seconds between aim updates while someone is aiming

  mode: null,           // null | 'host' | 'client'
  peer: null,
  conns: new Map(),     // host: peerId -> connection (players who said hello)
  conn: null,           // guest: connection to the host
  myId: null,           // 'host' on the host, our peer id on a guest
  code: null,
  game: null,
  inMatch: false,
  shopPending: null,    // host: owners still shopping
  queue: [],            // guest: host messages waiting for our local animation to finish
  lastSeen: new Map(),
  lastHostMsg: 0,
  aimT: 0,
  lastAim: '',
  hooks: {},            // UI callbacks

  get active() { return this.mode !== null; },
  get isHost() { return this.mode === 'host'; },
  get isClient() { return this.mode === 'client'; },
  available() { return typeof Peer !== 'undefined'; },
  now() { return performance.now(); },

  init(game, hooks) {
    this.game = game;
    this.hooks = hooks;
    // Heartbeat on a timer (not the render loop) so a backgrounded tab keeps its seat.
    setInterval(() => this.heartbeat(), 2000);
  },

  makeCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += this.CODE_CHARS[Math.floor(Math.random() * this.CODE_CHARS.length)];
    return s;
  },

  // ------------------------------------------------------------ host

  host() {
    this.leave();
    this.mode = 'host';
    this.myId = 'host';
    const attempt = n => {
      const code = this.makeCode();
      const peer = this.peer = new Peer(this.PREFIX + code);
      peer.on('open', () => { if (this.peer === peer) { this.code = code; this.hooks.hostReady(code); } });
      peer.on('connection', conn => this.accept(conn));
      peer.on('disconnected', () => { try { if (this.peer === peer && !peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ } });
      peer.on('error', err => {
        if (this.peer !== peer) return;
        if (err.type === 'unavailable-id' && n < 5) { peer.destroy(); attempt(n + 1); return; }
        if (err.type === 'peer-unavailable') return; // a guest vanished mid-handshake
        this.hooks.error(this.describe(err));
      });
    };
    attempt(0);
  },

  accept(conn) {
    conn.on('data', m => this.fromGuest(conn, m));
    conn.on('close', () => this.drop(conn.peer));
    conn.on('error', () => this.drop(conn.peer));
  },

  fromGuest(conn, m) {
    if (!m || typeof m !== 'object') return;
    const id = conn.peer;
    this.lastSeen.set(id, this.now());
    const g = this.game;
    if (m.type === 'hello') {
      const reject = reason => { conn.send({ type: 'reject', reason }); setTimeout(() => conn.close(), 500); };
      if (this.inMatch) return reject('A match is already in progress.');
      if (!this.hooks.canJoin()) return reject('That room is full.');
      this.conns.set(id, conn);
      this.hooks.guestJoined(id, String(m.name || 'Guest').slice(0, 12));
      return;
    }
    if (!this.conns.has(id)) return;
    const t = g.current;
    const theirTurn = this.inMatch && g.state === 'aim' && t && t.owner === id;
    switch (m.type) {
      case 'aim':
        if (theirTurn) this.applyAim(t, m);
        break;
      case 'fire':
        if (theirTurn) { this.applyAim(t, m); g.fire(); }
        break;
      case 'shield':
        if (theirTurn) g.activateShield(t);
        break;
      case 'shopDone': {
        const tank = g.players.find(p => p.owner === id);
        if (tank && this.shopPending && this.shopPending.has(id)) {
          tank.money = Math.max(0, Math.min(tank.money, +m.money || 0)); // can only spend, never print money
          tank.inventory = this.cleanInventory(m.inventory);
          this.shopPending.delete(id);
          this.checkShops();
        }
        break;
      }
    }
  },

  applyAim(t, m) {
    if (isFinite(m.angle)) t.angle = clamp(+m.angle, 0, 180);
    if (isFinite(m.power)) t.power = clamp(+m.power, 0, t.maxPower);
    if (WEAPONS[m.weapon] && t.ammo(m.weapon) > 0) t.weapon = m.weapon;
  },

  cleanInventory(inv) {
    const out = {};
    for (const id of SHOP_ORDER) if (inv && isFinite(inv[id]) && inv[id] > 0) out[id] = Math.floor(inv[id]);
    return out;
  },

  /** A guest left or timed out. In a match their tank is handed to a CPU. */
  drop(id) {
    if (!this.isHost || !this.conns.has(id)) return;
    const conn = this.conns.get(id);
    this.conns.delete(id);
    this.lastSeen.delete(id);
    try { conn.close(); } catch (e) { /* ignore */ }
    const g = this.game;
    const t = this.inMatch && g.players.find(p => p.owner === id);
    if (t) {
      t.owner = null;
      t.ai = 'normal';
      if (g.current === t && g.state === 'aim') g.ai = { timer: 0, plan: null, wait: 0 };
      const note = { type: 'note', title: `${t.name} disconnected`, sub: 'A CPU takes over their tank' };
      this.broadcast(note);
      this.hooks.note(note);
      if (this.shopPending) { this.shopPending.delete(id); this.checkShops(); }
    }
    this.hooks.guestLeft(id);
  },

  kick(id) {
    const conn = this.conns.get(id);
    if (conn) conn.send({ type: 'reject', reason: 'The host removed you from the room.' });
    setTimeout(() => this.drop(id), 300);
  },

  broadcast(m) {
    if (!this.isHost) return;
    for (const c of this.conns.values()) { try { c.send(m); } catch (e) { /* ignore */ } }
  },

  /** Everything a guest needs to show the current turn exactly as the host has it. */
  snapshot(g) {
    return {
      type: 'state',
      round: g.round,
      settings: g.settings,
      theme: THEMES.indexOf(g.theme),
      style: g.terrainStyle,
      W, H,
      runs: g.terrain.toRuns(),
      wind: g.wind,
      current: g.current ? g.current.index : -1,
      turnCount: g.turnCount,
      tanks: g.players.map(p => ({
        name: p.name, color: p.color, ai: p.ai, owner: p.owner,
        x: p.x, y: p.y, health: p.health, shield: p.shield, alive: p.alive,
        angle: p.angle, power: p.power, weapon: p.weapon, inventory: p.inventory,
        money: p.money, wins: p.wins, kills: p.kills,
      })),
    };
  },

  startMatch() {
    this.inMatch = true;
    this.shopPending = null;
  },

  roundEnded(g) {
    this.broadcast({
      type: 'roundEnd',
      winner: g.roundWinner ? g.roundWinner.index : -1,
      stats: g.players.map(p => ({ money: p.money, wins: p.wins, kills: p.kills })),
    });
    // Everyone with a seat shops at the same time; the next round starts when all are done.
    this.shopPending = new Set(['host', ...g.players.filter(p => p.owner && p.owner !== 'host' && this.conns.has(p.owner)).map(p => p.owner)]);
  },

  /** Called when this computer's player finishes shopping. */
  shopDone(t) {
    if (this.isClient) {
      this.send({ type: 'shopDone', money: t ? t.money : 0, inventory: t ? t.inventory : {} });
      this.hooks.waiting('Waiting for the other players to finish shopping…');
      return;
    }
    if (this.shopPending) this.shopPending.delete('host');
    this.checkShops();
  },

  checkShops() {
    if (!this.shopPending) return;
    const g = this.game;
    const names = [...this.shopPending].map(o => (g.players.find(p => p.owner === o) || {}).name).filter(Boolean);
    if (this.shopPending.has('host')) { this.broadcast({ type: 'waiting', names }); return; }
    if (this.shopPending.size) {
      const text = `Waiting for ${names.join(', ')} to finish shopping…`;
      this.hooks.waiting(text);
      this.broadcast({ type: 'waiting', names });
      return;
    }
    this.shopPending = null;
    this.hooks.waiting(null);
    g.startRound();
  },

  backToLobby() {
    this.inMatch = false;
    this.shopPending = null;
    this.broadcast({ type: 'toLobby' });
  },

  // ------------------------------------------------------------ guest

  join(code, name) {
    this.leave();
    this.mode = 'client';
    const peer = this.peer = new Peer();
    let opened = false;
    peer.on('open', id => {
      if (this.peer !== peer) return;
      this.myId = id;
      const conn = this.conn = peer.connect(this.PREFIX + code, { reliable: true });
      setTimeout(() => { if (!opened && this.peer === peer) { this.hooks.error('Could not reach that room. Check the code and try again.'); this.leave(); } }, 12000);
      conn.on('open', () => {
        opened = true;
        this.code = code;
        this.lastHostMsg = this.now();
        conn.send({ type: 'hello', name });
        this.hooks.joined(code);
      });
      conn.on('data', m => this.fromHost(m));
      conn.on('close', () => { if (this.conn === conn) this.hostLost('The host closed the room.'); });
      conn.on('error', () => { if (this.conn === conn) this.hostLost('Lost connection to the host.'); });
    });
    peer.on('disconnected', () => { try { if (this.peer === peer && !peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ } });
    peer.on('error', err => {
      if (this.peer !== peer) return;
      this.hooks.error(err.type === 'peer-unavailable' ? 'No room with that code. Check it and try again.' : this.describe(err));
      if (!opened) this.leave();
    });
  },

  send(m) {
    if (this.isClient && this.conn && this.conn.open) { try { this.conn.send(m); } catch (e) { /* ignore */ } }
  },

  fromHost(m) {
    if (!m || typeof m !== 'object') return;
    this.lastHostMsg = this.now();
    const g = this.game;
    switch (m.type) {
      case 'lobby': this.hooks.lobby(m); break;
      case 'reject': this.hooks.error(m.reason || 'The host turned you away.'); this.leave(); break;
      case 'state':
      case 'roundEnd':
        m.at = this.now();
        this.queue.push(m);
        this.pump(false);
        break;
      case 'shot': {
        this.pump(true); // make sure we're on the same turn first
        const t = g.players[m.i];
        if (!t) break;
        this.applyAim(t, m);
        t.weapon = m.weapon;
        if (g.current !== t || g.state !== 'aim') { g.clearShots(); g.current = t; g.state = 'aim'; }
        seedSim(m.seed);
        g.firePending = false;
        g.fire(true);
        break;
      }
      case 'shield': {
        this.pump(true);
        const t = g.players[m.i];
        if (t) g.activateShield(t, true);
        break;
      }
      case 'aim': {
        const t = g.current;
        if (!this.queue.length && t && t.index === m.i && g.state === 'aim' && !g.isLocal(t)) this.applyAim(t, m);
        break;
      }
      case 'waiting':
        if (m.names && m.names.length) this.hooks.waiting(`Waiting for ${m.names.join(', ')} to finish shopping…`);
        break;
      case 'note': this.hooks.note(m); break;
      case 'toLobby': this.queue = []; this.hooks.toLobby(); break;
    }
  },

  /**
   * Apply queued host messages once our own replay of the last shot has finished
   * (or straight away if forced, or if we've fallen badly behind).
   */
  pump(force) {
    const g = this.game;
    while (this.queue.length) {
      const m = this.queue[0];
      const busy = g.state === 'resolve' && this.now() - m.at < 4000;
      if (busy && !force) return;
      this.queue.shift();
      if (m.type === 'state') this.applyState(m);
      else g.finishRound(g.players[m.winner] || null, m.stats);
    }
  },

  applyState(s) {
    const g = this.game;
    const newRound = g.state === 'setup' || g.state === 'roundOver' || g.state === 'roundEnding' ||
      s.round !== g.round || !g.players.length || g.players.length !== s.tanks.length;
    g.clearShots();
    if (newRound) {
      g.settings = s.settings;
      g.round = s.round;
      g.players = s.tanks.map((d, i) => new Tank(d, i, d.money));
      g.clearEffects();
      g.setTheme(THEMES[s.theme] || THEMES[0], s.style, { W: s.W, H: s.H, runs: s.runs, style: s.style });
      this.hooks.roundStarting(g);
    } else {
      g.terrain.fromRuns(s.runs);
    }
    s.tanks.forEach((d, i) => {
      const t = g.players[i];
      Object.assign(t, {
        ai: d.ai, owner: d.owner, x: d.x, y: d.y, health: d.health, shield: d.shield, alive: d.alive,
        angle: d.angle, power: d.power, weapon: d.weapon, inventory: Object.assign({}, d.inventory),
        money: d.money, wins: d.wins, kills: d.kills,
        falling: false, vy: 0, fallDist: 0, parachuting: false,
      });
    });
    g.wind = s.wind;
    g.turnCount = s.turnCount;
    const t = g.players[s.current];
    if (t) g.beginTurn(t);
  },

  hostLost(msg) {
    if (!this.isClient) return;
    this.leave();
    this.hooks.hostLost(msg);
  },

  // ------------------------------------------------------------ both

  /** Per-frame: stream the aim of whoever is aiming, and release queued host messages. */
  tick(dt) {
    if (!this.active) return;
    const g = this.game;
    if (this.isClient) this.pump(false);
    this.aimT += dt;
    if (this.aimT < this.AIM_RATE || g.state !== 'aim' || !g.current) return;
    this.aimT = 0;
    const t = g.current;
    const key = `${t.index}|${t.angle.toFixed(1)}|${Math.round(t.power)}|${t.weapon}`;
    if (key === this.lastAim) return;
    this.lastAim = key;
    const m = { type: 'aim', i: t.index, angle: +t.angle.toFixed(1), power: Math.round(t.power), weapon: t.weapon };
    if (this.isHost) this.broadcast(m);
    else if (g.isLocal(t) && !g.firePending) this.send(m);
  },

  heartbeat() {
    if (!this.active) return;
    const now = this.now();
    if (this.isHost) {
      this.broadcast({ type: 'ping' });
      for (const [id, seen] of this.lastSeen) if (now - seen > this.TIMEOUT) this.drop(id);
    } else if (this.conn && this.conn.open) {
      this.send({ type: 'ping' });
      if (now - this.lastHostMsg > this.TIMEOUT) this.hostLost('Lost connection to the host.');
    }
  },

  leave() {
    for (const c of this.conns.values()) { try { c.close(); } catch (e) { /* ignore */ } }
    if (this.conn) { try { this.conn.close(); } catch (e) { /* ignore */ } }
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
    this.conns = new Map();
    this.lastSeen = new Map();
    this.conn = null;
    this.peer = null;
    this.mode = null;
    this.myId = null;
    this.code = null;
    this.inMatch = false;
    this.shopPending = null;
    this.queue = [];
    this.lastAim = '';
  },

  describe(err) {
    const t = err && err.type;
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Could not reach the matchmaking server. Check your internet connection.';
    if (t === 'browser-incompatible') return 'This browser does not support online play.';
    return 'Connection problem' + (t ? ` (${t})` : '') + '.';
  },
};
