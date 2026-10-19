// One room = up to ROOM_SIZE cockroaches, their own lotus, hazards and leaderboard.
//
// The server holds many rooms. Each room:
//   - simulates its lotus + hazards (only while someone is in it or watching);
//   - validates its players' movement and bites (the server is the authority);
//   - streams positions as compact binary (shared/protocol.js), sending only what
//     changed since the last update, with a full "keyframe" every 2 seconds;
//   - slows down or stops updates for spectators, idle players and background tabs.
//
// Sessions (one per open browser tab) are created in index.js and handed to a room
// with add(). A room never touches sockets directly except through send helpers.
const R = require('../shared/rules');
const C = require('../shared/content');
const P = require('../shared/protocol');
const { Lotus } = require('./lotus');
const { Hazards } = require('./hazards');

const ROOM_SIZE = +process.env.ROOM_SIZE || 50;
const SNAP_EVERY_TICKS = 2;        // 20 Hz simulation → 10 Hz position updates
const KEY_EVERY = 20;              // keyframe for active players every 20 updates (2 s)
const SLOW_EVERY = 5;              // spectators / waiting room: 2 updates a second
const SLEEP_EVERY = 10;            // idle players: 1 update a second
const LOTUS_EVERY = 2;             // lotus state at most 5 times a second, only when it changed
const IDLE_MS = 3 * 60 * 1000;     // no input for 3 min → asleep (zzz, slow updates, no swarm bonus)
const KICK_MS = 10 * 60 * 1000;    // no input for 10 min → disconnected to free the slot
const NEWS_COOLDOWN_MS = 20000;    // at most one reactive headline every 20 s
const MAX_BUFFERED = 256 * 1024;   // skip a client whose connection is backed up (it gets a keyframe later)

class Room {
  /**
   * @param id     short public id used in invite links (/r/<id>)
   * @param saved  persisted state from the store, or null for a brand-new room
   * @param world  shared services from index.js: { prog, national, onDirty }
   */
  constructor(id, saved, world) {
    this.id = id;
    this.world = world;
    this.prog = world.prog;
    this.sessions = new Map();     // session id -> session (players)
    this.watchers = new Set();     // title-screen spectators and the waiting room
    this.lb = new Map((saved && saved.lb) || []);   // token -> {name, hue, dmg, lvl} for the current bloom
    this.lastActive = (saved && saved.lastActive) || Date.now();
    this.lastTick = Date.now();
    this.lotus = new Lotus(saved && saved.lotus, (ev) => this.onLotusEvent(ev));
    this.hazards = new Hazards(this);
    this.snapN = 0;
    this.lastSent = new Map();     // session id -> last quantised row we broadcast (for deltas)
    this.lastLotus = null;         // last lotus bytes sent (to skip unchanged ones)
    this.lastLb = '';
    this.newsReadyAt = 0;
    this.recentNews = [];
    this.dirty = true;
    // Catch up on everything that happened while nobody was here: growth, regen, regrowth.
    if (saved && saved.lastActive) this.lotus.tick(Math.min((Date.now() - saved.lastActive) / 1000, 7 * 86400), Date.now());
  }

  get size() { return this.sessions.size; }
  get full() { return this.sessions.size >= ROOM_SIZE; }
  get busy() { return this.sessions.size > 0 || this.watchers.size > 0; }
  levelOf(s) { return this.prog.level(s.token); }

  // ---------------------------------------------------------------- messaging
  /** JSON to every player (and spectators unless `playersOnly`). Serialised once. */
  broadcast(msg, playersOnly = false) {
    const str = JSON.stringify(msg);
    for (const s of this.sessions.values()) send(s, str);   // JSON is rare and small: background tabs get it too
    if (!playersOnly) for (const s of this.watchers) send(s, str);
  }
  sendTo(s, msg) { send(s, JSON.stringify(msg)); }
  sendToken(token, msg) { const str = JSON.stringify(msg); for (const s of this.sessions.values()) if (s.token === token) send(s, str); }

  // ---------------------------------------------------------------- joining and leaving
  /** Adds a player and returns the welcome payload for them. */
  add(s, now = Date.now()) {
    this.wake(now);
    this.watchers.delete(s);
    s.room = this; s.mode = 'play';
    // Spawn on a ring around the lotus, facing it.
    const ang = Math.random() * Math.PI * 2, d = 650 + Math.random() * 200;
    Object.assign(s, { x: R.LOTUS.x + Math.cos(ang) * d, y: R.LOTUS.y + Math.sin(ang) * d, a: ang + Math.PI,
      lastPosAt: now, lastInput: now, lastBite: 0, flyUntil: 0, flyCdUntil: 0, stunUntil: 0, knockUntil: 0, biteUntil: 0,
      jumlaUntil: 0, posLockUntil: 0, voidBites: 0, lastRally: 0, sleeping: false, needsKey: true, needsLotus: true });
    this.sessions.set(s.id, s);
    this.dirty = true;
    this.broadcast({ t: 'pj', p: this.rosterEntry(s) });
    return { room: this.info(), x: s.x, y: s.y, a: s.a, world: this.worldState(now), hazards: this.hazards.snapshot(now),
      roster: [...this.sessions.values()].filter(o => o !== s).map(o => this.rosterEntry(o)), lb: this.top() };
  }

  remove(s) {
    if (this.sessions.delete(s.id)) { this.lastSent.delete(s.id); this.broadcast({ t: 'pl', id: s.id }); this.lastActive = Date.now(); this.dirty = true; }
    this.watchers.delete(s);
  }

  /** Spectators (title screen, waiting room) see the room at a low update rate. */
  watch(s, now = Date.now()) {
    this.wake(now);
    s.room = this; s.needsKey = true; s.needsLotus = true;
    this.watchers.add(s);
    return { room: this.info(), world: this.worldState(now), hazards: this.hazards.snapshot(now),
      roster: [...this.sessions.values()].map(o => this.rosterEntry(o)), lb: this.top() };
  }

  /** A dormant room fast-forwards the time it spent empty before anyone sees it. */
  wake(now) {
    if (this.busy) return;
    this.lotus.tick(Math.min((now - this.lastTick) / 1000, 7 * 86400), now);
    this.lastTick = now;
  }

  rosterEntry(s) { const p = this.prog.get(s.token); return { id: s.id, name: p ? p.name : 'Cockroach', hue: p ? p.hue : 30, lvl: this.levelOf(s) }; }
  info() { return { id: this.id, online: this.sessions.size, max: ROOM_SIZE }; }

  worldState(now) {
    const L = this.lotus;
    return { gen: L.gen, name: R.bloomName(L.gen), rebranded: L.rebranded, fallenUntil: L.fallenUntil, bornAt: L.bornAt, now,
      totals: { damage: Math.round(L.totals.damage), petalsDown: L.totals.petalsDown, bloomsFallen: L.totals.bloomsFallen },
      history: L.history.slice(-8).map(h => ({ name: h.name, lived: h.lived })),
      rally: L.rally && { part: L.rally.part, until: L.rally.until, name: L.rally.name }, shieldKind: L.shieldKind };
  }

  top(n = 5) {
    const gen = this.lotus.gen;
    return [...this.lb.values()].filter(r => r.gen === gen).sort((a, b) => b.dmg - a.dmg).slice(0, n)
      .map(r => ({ name: r.name, hue: r.hue, dmg: Math.round(r.dmg), lvl: r.lvl }));
  }

  // ---------------------------------------------------------------- player intents
  /** Movement is predicted by the client; the server clamps it to what's physically possible. */
  onPos(s, m, now) {
    const x = +m.x, y = +m.y, a = +m.a;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dt = Math.max(0.016, Math.min(0.5, (now - s.lastPosAt) / 1000));
    s.lastPosAt = now;
    if (s.stunUntil > now || s.posLockUntil > now) return;   // flattened, frozen, or just teleported by the server
    const max = (s.knockUntil > now ? 1700 : R.MOVE.dashSpeed * 1.15) * dt + 30;
    let dx = x - s.x, dy = y - s.y; const d = Math.hypot(dx, dy);
    if (d > max) { dx *= max / d; dy *= max / d; }
    if (d > 0.5 || (Number.isFinite(a) && Math.abs(a - s.a) > 0.05)) this.input(s, now);
    s.x = Math.max(0, Math.min(R.WORLD.w, s.x + dx));
    s.y = Math.max(0, Math.min(R.WORLD.h, s.y + dy));
    if (Number.isFinite(a)) s.a = a;
  }

  onBite(s, now) {
    this.input(s, now);
    if (now - s.lastBite < R.BITE.cooldownMs - 40 || s.stunUntil > now) return;
    const lotus = this.lotus;
    if (lotus.isFallen(now)) return;
    s.lastBite = now; s.biteUntil = now + 220;
    const lvl = this.levelOf(s), size = R.sizeFor(lvl), flying = s.flyUntil > now;
    // The mouth is ahead of the body.
    const hx = s.x + Math.cos(s.a) * 14 * size, hy = s.y + Math.sin(s.a) * 14 * size;
    const part = R.biteTarget(hx, hy, lotus.growth, i => lotus.isAlive(i), flying, lotus.coreOpen(), R.BITE.reach * size + 6);
    if (part < 0) return;
    if (s.voidBites > 0) {   // Note Exchange: these bites are "old currency"
      s.voidBites--;
      return this.sendTo(s, { t: 'hit', part, dmg: 0, void: true, left: s.voidBites });
    }
    let buddies = 0;
    for (const o of this.sessions.values()) {
      if (o !== s && !o.sleeping && o.stunUntil <= now && Math.hypot(o.x - s.x, o.y - s.y) < R.BITE.swarmRadius) buddies++;
    }
    const mult = R.swarmMult(buddies) * (R.has(lvl, 'mandibles') ? 1.15 : 1);
    // Shields: Section 144 lets small groups through at full strength and blocks crowds.
    const shielded = lotus.parts[part].shieldUntil > now, kind = shielded ? lotus.shieldKind : null;
    let opts = {}, blocked = shielded;
    if (kind === 'sec144') {
      const crowd = R.crowdOnPart([...this.sessions.values()].filter(o => !o.sleeping && o.stunUntil <= now), part, lotus.growth);
      blocked = crowd > R.SEC144_MAX;
      opts = { shieldMult: blocked ? 0 : 1 };
    }
    const r = lotus.bite(part, R.BITE.dmg * mult, s.token, now, opts);
    if (!r) return;
    this.sendTo(s, { t: 'hit', part, dmg: Math.round(r.dealt * 10) / 10, buddies, shield: blocked, kind, killed: r.killed });
    this.prog.onBite(s.token, r.dealt, buddies);
    const p = this.prog.get(s.token);
    const e = this.lb.get(s.token) || { name: p.name, hue: p.hue, dmg: 0, lvl, gen: lotus.gen };
    if (e.gen !== lotus.gen) { e.dmg = 0; e.gen = lotus.gen; }
    e.dmg += r.dealt; e.name = p.name; e.lvl = lvl;
    this.lb.set(s.token, e);
    this.world.national.damage += r.dealt;
  }

  onFly(s, now) {
    this.input(s, now);
    if (!R.has(this.levelOf(s), 'wings') || now < s.flyCdUntil) return;
    s.flyUntil = now + R.MOVE.flyMs; s.flyCdUntil = now + R.MOVE.flyMs + R.MOVE.flyCdMs;
    this.sendTo(s, { t: 'ev', k: 'flying', until: s.flyUntil, cdUntil: s.flyCdUntil });
  }

  onRally(s, now) {
    this.input(s, now);
    if (!R.has(this.levelOf(s), 'rally') || now - s.lastRally < 20000) return;
    const lotus = this.lotus;
    const part = R.biteTarget(s.x, s.y, lotus.growth, i => lotus.isAlive(i), true, lotus.coreOpen(), 280);
    if (part < 0) return this.sendTo(s, { t: 'ev', k: 'toast', text: 'Get closer to a petal to call a rally.' });
    if (lotus.parts[part].shieldUntil > now && lotus.shieldKind === 'shutdown')
      return this.sendTo(s, { t: 'ev', k: 'toast', text: 'No network on this petal. Your rally could not be sent.' });
    s.lastRally = now;
    const name = this.prog.get(s.token).name;
    lotus.rally = { part, until: now + 25000, by: s.token, name, fake: false };
    this.broadcast({ t: 'ev', k: 'rally', part, until: lotus.rally.until, name, id: s.id });
    this.news('rally', { name });
  }

  /** The tab went to the background (or came back). Background tabs get no position updates. */
  onVisibility(s, hidden) { s.hidden = !!hidden; if (!s.hidden) { s.needsKey = true; s.needsLotus = true; } }

  input(s, now) {
    s.lastInput = now;
    if (s.sleeping) { s.sleeping = false; s.needsKey = true; }
  }

  // ---------------------------------------------------------------- Breaking News
  /** Sends a headline. `general` ones come from the Megaphone; others react to events. */
  news(kind, vars = {}, extra = {}) {
    const now = Date.now();
    let text;
    if (kind === 'general') {
      const pool = C.HEADLINES.filter(h => !this.recentNews.includes(h));
      text = pool[Math.random() * pool.length | 0];
    } else {
      if (kind !== 'coreDown' && now < this.newsReadyAt) return;
      const pool = C.REACTIVE[kind]; if (!pool) return;
      text = pool[Math.random() * pool.length | 0].replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? String(vars[k]) : '');
    }
    this.recentNews.push(text); if (this.recentNews.length > 12) this.recentNews.shift();
    this.newsReadyAt = now + NEWS_COOLDOWN_MS;
    if (extra.decoy !== undefined) this.hazards.decoy = extra.decoy === null ? null : { part: extra.decoy, until: extra.until };
    this.broadcast({ t: 'ev', k: 'news', text, kind, decoy: extra.decoy ?? null, until: extra.until ?? null });
  }

  // ---------------------------------------------------------------- lotus events
  onLotusEvent(ev) {
    const now = Date.now(), national = this.world.national;
    this.dirty = true;
    if (ev.k === 'petalDown') {
      const contributors = ev.contributors; delete ev.contributors;
      ev.count = contributors.length;
      national.petals++;
      for (const tok of contributors) {
        const p = this.prog.get(tok); if (!p) continue;
        p.petals++;
        this.prog.addXp(tok, 40, 'Petal destroyed');
        this.prog.grant(tok, 'petal');
        this.sendToken(tok, { t: 'ev', k: 'contributed', what: 'petal', bloom: R.bloomName(this.lotus.gen), swarm: national.total, room: this.id });
      }
      if (ev.rallyBy) { this.prog.grant(ev.rallyBy, 'rally'); ev.rallyName = this.prog.get(ev.rallyBy)?.name; }
      delete ev.rallyBy;
      setTimeout(() => this.news('petalDown', { count: ev.count }), 1800);
    }
    if (ev.k === 'coreDown') {
      const contributors = new Set(ev.contributors); delete ev.contributors;
      const ranked = [...this.lb.entries()].filter(([, r]) => r.gen === ev.gen).sort((a, b) => b[1].dmg - a[1].dmg);
      if (ranked[0] && ranked[0][1].dmg >= 1000) this.prog.grant(ranked[0][0], 'chief');
      ev.top = this.top(3);
      for (const s of this.sessions.values()) contributors.add(s.token);   // everyone present toppled it together
      ev.count = contributors.size;
      national.blooms++;
      ev.national = national.blooms;
      for (const tok of contributors) {
        const p = this.prog.get(tok); if (!p) continue;
        p.blooms++;
        this.prog.addXp(tok, 150, 'The Bloom has fallen');
        this.prog.grant(tok, 'regime');
        this.sendToken(tok, { t: 'ev', k: 'contributed', what: 'bloom', bloom: ev.name, swarm: national.total, room: this.id });
      }
      setTimeout(() => this.news('coreDown', { bloom: ev.name }), 2500);
    }
    if (ev.k === 'rebrand') { ev.name = R.bloomName(this.lotus.gen); this.news('rebrand', { bloom: ev.name }); }
    if (ev.k === 'newGen') { this.lb.clear(); setTimeout(() => this.news('newGen', { bloom: ev.name }), 1500); }
    this.broadcast({ t: 'ev', ...ev, at: now });
    if (['petalDown', 'newGen', 'regrow', 'rebrand', 'coreDown'].includes(ev.k)) this.broadcast({ t: 'w', w: this.worldState(now) });
  }

  // ---------------------------------------------------------------- simulation
  tick(now, tickN) {
    const dt = Math.min(1, (now - this.lastTick) / 1000); this.lastTick = now;
    // Idle detection: sleeping players don't count toward the crowd or the swarm bonus.
    let awake = 0;
    for (const s of this.sessions.values()) {
      const idle = now - s.lastInput;
      if (idle > KICK_MS) { s.ws.close(4001, 'idle'); continue; }
      if (!s.sleeping && idle > IDLE_MS) s.sleeping = true;
      if (!s.sleeping) awake++;
    }
    this.lotus.setCrowd(awake, now);
    this.lotus.tick(dt, now);
    this.hazards.tick(now);
    if (this.sessions.size) { this.lastActive = now; }
    if (tickN % SNAP_EVERY_TICKS === 0) this.sendUpdates(now);
    if (tickN % 100 === 0) {                 // every 5 s: leaderboard, only if it changed
      const lb = JSON.stringify(this.top());
      if (lb !== this.lastLb) { this.lastLb = lb; this.broadcast({ t: 'lb', lb: this.top() }); }
    }
  }

  /**
   * Position + lotus updates. Each message is built ONCE per room and the same bytes go
   * to every recipient, so the server's work doesn't grow with (players × players).
   */
  sendUpdates(now) {
    const n = ++this.snapN;
    const rows = [], delta = [];
    for (const s of this.sessions.values()) {
      const flags = (s.flyUntil > now ? P.F_FLY : 0) | (s.stunUntil > now ? P.F_STUN : 0) | (s.biteUntil > now ? P.F_BITE : 0)
        | (s.sleeping ? P.F_SLEEP : 0) | (s.jumlaUntil > now ? P.F_JUMLA : 0);
      const row = { id: s.id, x: s.x, y: s.y, a: s.a, flags, lvl: this.levelOf(s) };
      rows.push(row);
      // Delta: only roaches that moved at least 1 px, turned, or changed state.
      const q = { x: Math.round(s.x), y: Math.round(s.y), ab: P.angleToByte(s.a), flags, lvl: row.lvl };
      const prev = this.lastSent.get(s.id);
      if (!prev || prev.x !== q.x || prev.y !== q.y || prev.ab !== q.ab || prev.flags !== q.flags || prev.lvl !== q.lvl) {
        delta.push(row); this.lastSent.set(s.id, q);
      }
    }
    let keyBuf = null;
    const key = () => keyBuf || (keyBuf = P.encodeRoaches(P.T_KEY, rows));
    const deltaBuf = delta.length ? P.encodeRoaches(P.T_DELTA, delta) : null;

    // Lotus: re-encode at most 5×/s; send only if the bytes changed (or someone needs it).
    let lotusBuf = null, lotusChanged = false;
    if (n % LOTUS_EVERY === 0) {
      const L = this.lotus;
      let alive = 0, shield = 0;
      L.parts.forEach((p, i) => { if (p.alive && !L.isFallen(now)) alive |= 1 << i; if (p.shieldUntil > now) shield |= 1 << i; });
      lotusBuf = P.encodeLotus({ growth: L.growth, alive, shield, roomOnline: this.sessions.size, nationOnline: this.world.national.online,
        damage: L.totals.damage, frac: L.fractions() });
      lotusChanged = !this.lastLotus || !Buffer.from(lotusBuf).equals(Buffer.from(this.lastLotus));
      if (lotusChanged) this.lastLotus = lotusBuf;
    }
    const sendLotus = (s, force) => {
      if (!(force || s.needsLotus)) return;
      const buf = lotusBuf || this.lastLotus;
      if (buf) { send(s, buf); s.needsLotus = false; }
    };

    for (const s of this.sessions.values()) {
      if (s.hidden) continue;                                     // background tab: nothing
      if (s.sleeping) {                                           // idle: 1 keyframe a second
        if (n % SLEEP_EVERY === 0) { send(s, key()); sendLotus(s, true); }
        continue;
      }
      if (s.needsKey || n % KEY_EVERY === 0) { if (send(s, key())) s.needsKey = false; }
      else if (deltaBuf && !send(s, deltaBuf)) s.needsKey = true; // dropped a delta → resync with a keyframe
      if (lotusBuf) sendLotus(s, lotusChanged);
      else sendLotus(s, false);
    }
    for (const s of this.watchers) {
      if (s.hidden) continue;
      if (s.needsKey || n % SLOW_EVERY === 0) { send(s, key()); s.needsKey = false; sendLotus(s, true); }
    }
  }

  serialize() {
    const gen = this.lotus.gen;
    const lb = [...this.lb.entries()].filter(([, r]) => r.gen === gen).sort((a, b) => b[1].dmg - a[1].dmg).slice(0, 100);
    return { lotus: this.lotus.serialize(), lb, lastActive: this.lastActive };
  }
}

/** Sends a string or bytes if the socket is open and not backed up. Returns false if skipped. */
function send(s, data) {
  const ws = s.ws;
  if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) return false;
  ws.send(data);
  return true;
}

module.exports = { Room, ROOM_SIZE };
