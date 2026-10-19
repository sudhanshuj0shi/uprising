// Lotus defences for ONE room. Each runs on its own timer, only while someone is playing.
//
//  - The Chappal: a giant slipper stomps where cockroaches gather. Dash out or fly over.
//  - Jumla power-ups: shiny "rewards" that backfire (see shared/content.js for the list).
//  - Lotus Shield: random petals go "UNDER REVIEW" and take almost no damage.
//  - Godi Media Megaphone: a Breaking News headline plus a decoy "official" rally point.
//
// The room passes itself in as `room`; we only use its sessions, lotus, progression
// and messaging helpers, so this file has no networking code of its own.
const R = require('../shared/rules');
const C = require('../shared/content');

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.random() * arr.length | 0];

class Hazards {
  constructor(room) {
    this.room = room;
    const now = Date.now();
    this.nextChappal = now + 8000;
    this.nextJumla = now + 10000;
    this.nextShield = now + 25000;
    this.nextMega = now + 40000;
    this.chappals = [];   // {id, x, y, r, at, warned:Set<sessionId>}
    this.jumlas = [];     // {id, kind, x, y, until}
    this.cutouts = [];    // Smart City cardboard lotuses: {x, y, until}
    this.decoy = null;    // {part, until}
    this.seq = 1;
  }

  players() { return [...this.room.sessions.values()].filter(s => !s.sleeping); }
  /** Newcomers get 10 s of grace: no chappal aims at them or flattens them. */
  fair(now) { return this.players().filter(s => now - (s.joinedAt || 0) > 10000); }

  tick(now) {
    const lotus = this.room.lotus, players = this.players();
    if (!players.length || lotus.isFallen(now)) return;
    this.tickChappal(now, players);
    this.tickJumla(now, players);
    this.tickShield(now, lotus);
    this.tickMegaphone(now, lotus);
    this.cutouts = this.cutouts.filter(c => c.until > now);
    if (this.decoy && this.decoy.until < now) this.decoy = null;
  }

  // ---------------------------------------------------------------- The Chappal
  tickChappal(now, players) {
    if (now >= this.nextChappal) {
      const near = this.fair(now).filter(s => Math.hypot(s.x - R.LOTUS.x, s.y - R.LOTUS.y) < 1100);
      const count = Math.min(4, 1 + Math.floor(near.length / 8));
      for (let k = 0; k < count && near.length; k++) {
        const t = pick(near);
        const c = { id: this.seq++, x: t.x + rand(-40, 40), y: t.y + rand(-40, 40), r: 95, at: now + 1500 };
        c.warned = new Set(players.filter(s => Math.hypot(s.x - c.x, s.y - c.y) < c.r).map(s => s.id));
        this.chappals.push(c);
        this.room.broadcast({ t: 'ev', k: 'chappal', id: c.id, x: c.x | 0, y: c.y | 0, r: c.r, in: 1500 });
      }
      this.nextChappal = now + rand(9000, 16000) / Math.min(2, 1 + near.length / 20);
    }
    let dodgedTotal = 0;
    for (const c of this.chappals) {
      if (now < c.at) continue;
      const hit = [], dodged = [];
      for (const s of players) {
        const inside = Math.hypot(s.x - c.x, s.y - c.y) < c.r;
        if (inside && s.flyUntil <= now && now - (s.joinedAt || 0) > 10000) {
          s.stunUntil = now + (R.has(this.room.levelOf(s), 'shell') ? 1100 : 2200);
          hit.push(s.id);
        } else if (c.warned.has(s.id)) {
          dodged.push(s.id);
          const p = this.room.prog.get(s.token);
          if (p) { p.stomps++; this.room.prog.addXp(s.token, 8, 'Chappal dodged'); if (p.stomps >= 5) this.room.prog.grant(s.token, 'stomps5'); }
        }
      }
      dodgedTotal += dodged.length;
      this.room.broadcast({ t: 'ev', k: 'stomp', id: c.id, x: c.x | 0, y: c.y | 0, r: c.r, hit, dodged });
      c.done = true;
    }
    this.chappals = this.chappals.filter(c => !c.done);
    if (dodgedTotal >= 4) this.room.news('stompMany', { count: dodgedTotal });
  }

  // ---------------------------------------------------------------- Jumla power-ups
  tickJumla(now, players) {
    // Bigger rooms get more simultaneous Jumlas (1 per ~15 players, max 3).
    const want = Math.min(3, 1 + Math.floor(players.length / 15));
    if (this.jumlas.length < want && now >= this.nextJumla) {
      const kind = pick(C.JUMLA_KINDS);
      const ang = Math.random() * Math.PI * 2, d = R.radius(this.room.lotus.growth) * rand(1.3, 2.1);
      const j = { id: this.seq++, kind, x: R.LOTUS.x + Math.cos(ang) * d, y: R.LOTUS.y + Math.sin(ang) * d, until: now + 25000 };
      this.jumlas.push(j);
      this.room.broadcast({ t: 'ev', k: 'jumla', id: j.id, kind, x: j.x | 0, y: j.y | 0, until: j.until });
      this.nextJumla = now + rand(9000, 18000);
      if (Math.random() < 0.3) this.room.news('jumla', {});
    }
    for (const j of this.jumlas) {
      const victim = players.find(s => s.stunUntil < now && s.flyUntil < now && s.jumlaUntil < now && Math.hypot(s.x - j.x, s.y - j.y) < 36);
      if (!victim && now <= j.until) continue;
      j.done = true;
      if (victim) this.trigger(j, victim, now);
      this.room.broadcast({ t: 'ev', k: 'jumlaGone', id: j.id, x: j.x | 0, y: j.y | 0, kind: j.kind, victim: victim ? victim.id : null });
    }
    if (this.jumlas.some(j => j.done)) { this.jumlas = this.jumlas.filter(j => !j.done); this.nextJumla = Math.max(this.nextJumla, now + 6000); }
  }

  // Applies one Jumla's backfire. The server sets the authoritative state (stun,
  // void bites, teleport); the client animates it from the 'jumlaHit' event.
  trigger(j, s, now) {
    const def = C.JUMLAS[j.kind];
    const away = Math.atan2(s.y - R.LOTUS.y, s.x - R.LOTUS.x) + rand(-0.4, 0.4);
    const ev = { t: 'ev', k: 'jumlaHit', kind: j.kind, id: s.id };
    switch (def.effect) {
      case 'launch':   s.knockUntil = now + def.ms; ev.vx = Math.cos(away) * 1500; ev.vy = Math.sin(away) * 1500; break;
      case 'float':    s.knockUntil = now + def.ms; s.stunUntil = now + def.ms; ev.vx = Math.cos(away) * 520; ev.vy = Math.sin(away) * 520; break;
      case 'freeze':   s.stunUntil = now + def.ms; break;
      case 'void':     s.voidBites = def.bites; break;
      case 'uturn':    break; // purely client-side: reversed controls
      case 'teleport': {
        // Drop them at a cardboard lotus on the far side of the pond.
        const a = Math.atan2(R.LOTUS.y - s.y, R.LOTUS.x - s.x) + rand(-0.6, 0.6), d = rand(1050, 1250);
        const cx = clampW(R.LOTUS.x + Math.cos(a) * d), cy = clampW(R.LOTUS.y + Math.sin(a) * d);
        this.cutouts.push({ x: cx, y: cy, until: now + def.ms });
        s.x = cx + 60; s.y = cy + 40; s.posLockUntil = now + 700; // ignore stale client positions until it hears about the teleport
        ev.x = s.x | 0; ev.y = s.y | 0; ev.cx = cx | 0; ev.cy = cy | 0; ev.until = now + def.ms;
        break;
      }
    }
    s.jumlaUntil = now + (def.ms || 3000);
    ev.ms = def.ms || 0;
    this.room.broadcast(ev);
    const p = this.room.prog.get(s.token);
    if (p) {
      p.jumlas++;
      this.room.prog.addXp(s.token, 3, 'Consolation for believing');
      if (p.jumlas >= 3) this.room.prog.grant(s.token, 'jumla3');
    }
  }

  // ---------------------------------------------------------------- Lotus Shield
  tickShield(now, lotus) {
    if (now < this.nextShield) return;
    const alive = lotus.parts.map((p, i) => i).filter(i => lotus.parts[i].alive && i !== R.CORE);
    const picks = alive.sort(() => Math.random() - 0.5).slice(0, 3);
    // Rotate through the shield kinds so consecutive shields always differ.
    this.shieldIdx = ((this.shieldIdx ?? Math.random() * C.SHIELD_KINDS.length | 0) + 1) % C.SHIELD_KINDS.length;
    const kind = C.SHIELD_KINDS[this.shieldIdx];
    lotus.shieldKind = kind;
    const ms = kind === 'sec144' ? 12000 : 8000;      // Section 144 lasts longer: it's a puzzle, not a wall
    for (const i of picks) lotus.parts[i].shieldUntil = now + ms;
    if (picks.length) { this.room.broadcast({ t: 'ev', k: 'shield', parts: picks, until: now + ms, kind }); this.room.news(kind, {}); }
    this.nextShield = now + rand(32000, 50000);
  }

  // ---------------------------------------------------------------- Godi Media Megaphone
  tickMegaphone(now, lotus) {
    if (now < this.nextMega) return;
    const alive = lotus.parts.map((p, i) => i).filter(i => lotus.parts[i].alive && i !== R.CORE);
    const shielded = alive.filter(i => lotus.parts[i].shieldUntil > now);
    const pool = shielded.length ? shielded : alive;   // the decoy points at the worst petal to bite
    const part = pool.length ? pick(pool) : null;
    this.decoy = part === null ? null : { part, until: now + 12000 };
    this.room.news('general', {}, { decoy: part, until: now + 12000 });
    this.nextMega = now + rand(60000, 100000);
  }

  /** State a newcomer needs to see immediately. */
  snapshot(now) {
    return { jumlas: this.jumlas.map(j => ({ id: j.id, kind: j.kind, x: j.x | 0, y: j.y | 0, until: j.until })),
      chappals: this.chappals.map(c => ({ id: c.id, x: c.x | 0, y: c.y | 0, r: c.r, in: Math.max(0, c.at - now) })),
      cutouts: this.cutouts.map(c => ({ x: c.x | 0, y: c.y | 0, until: c.until })), decoy: this.decoy };
  }
}

const clampW = (v) => Math.max(120, Math.min(R.WORLD.w - 120, v));

module.exports = { Hazards };
