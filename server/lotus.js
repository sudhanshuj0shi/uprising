// The Lotus: authoritative boss state. Single-threaded Node means every bite and
// every regen tick is applied in order, so concurrent damage never races.
const R = require('../shared/rules');

const REGEN_DELAY_MS = 5000;      // petal heals only if nobody bit it for 5s
const REGEN_PER_SEC = 0.008;      // fraction of max hp per second
const REGROW_MS = 15 * 60 * 1000; // a fallen petal re-sprouts after 15 minutes
const FALLEN_MS = 25 * 1000;      // celebration interlude after the core falls
const GROWTH_MAX = 1.5;

class Lotus {
  constructor(saved, emit) {
    this.emit = emit;
    const s = saved || {};
    this.gen = s.gen || 1;
    this.growth = s.growth || 0.6;
    this.bornAt = s.bornAt || Date.now();
    this.rebranded = !!s.rebranded;
    this.fallenUntil = s.fallenUntil || 0;
    this.peak = s.peak || 1;          // most cockroaches online at once during this bloom
    this.parts = R.PARTS.map((_, i) => {
      const p = (s.parts && s.parts[i]) || {};
      return { dmg: p.dmg || 0, alive: p.alive !== false, regrowAt: p.regrowAt || 0, lastHit: 0, shieldUntil: 0, contrib: new Map() };
    });
    this.totals = Object.assign({ damage: 0, bites: 0, petalsDown: 0, bloomsFallen: 0 }, s.totals);
    this.history = s.history || [];
    this.rally = null;      // {part, until, by, name, fake}
    this.shieldKind = 'sealed';   // which shield the current shield event uses (see shared/content.js)
  }

  serialize() {
    return { gen: this.gen, growth: this.growth, bornAt: this.bornAt, rebranded: this.rebranded, fallenUntil: this.fallenUntil, peak: this.peak,
      parts: this.parts.map(p => ({ dmg: Math.round(p.dmg), alive: p.alive, regrowAt: p.regrowAt })),
      totals: this.totals, history: this.history.slice(-20) };
  }

  max(i) { return R.maxHp(i, this.gen, this.growth, this.peak); }

  /**
   * The lotus toughens to match the crowd it faces: the biggest crowd seen in the
   * last 10 minutes. Using a window (not the live count) means players leaving can't
   * make it suddenly fragile, and a room that empties at night isn't stuck with a
   * lotus built for 50. Damage is rescaled so each petal keeps its % health.
   */
  setCrowd(online, now = Date.now()) {
    const bucket = Math.floor(now / 60000);
    if (!this.crowd || this.crowd.bucket !== bucket) {
      this.crowdHist = (this.crowdHist || []).filter(b => b.bucket > bucket - 10);
      this.crowd = { bucket, max: 0 };
      this.crowdHist.push(this.crowd);
    }
    this.crowd.max = Math.max(this.crowd.max, online);
    const target = Math.max(1, ...this.crowdHist.map(b => b.max));
    if (target !== this.peak) {
      const k = R.crowdMult(target) / R.crowdMult(this.peak);
      for (const p of this.parts) p.dmg *= k;
      this.peak = target;
    }
  }

  /** Damage fraction 0..1 per part (what clients draw). */
  fractions() { return this.parts.map((p, i) => p.alive ? Math.min(1, p.dmg / this.max(i)) : 1); }
  isAlive(i) { return this.parts[i].alive; }
  downCount() { let n = 0; for (let i = 0; i < R.CORE; i++) if (!this.parts[i].alive) n++; return n; }
  coreOpen() { return this.downCount() >= R.CORE_UNLOCK; }
  isFallen(now = Date.now()) { return this.fallenUntil > now; }

  health() {
    let hp = 0, max = 0;
    for (let i = 0; i < this.parts.length; i++) {
      const m = this.max(i); max += m;
      if (this.parts[i].alive) hp += Math.max(0, m - this.parts[i].dmg);
    }
    return max ? hp / max : 0;
  }

  // Advance time. Safe for huge dt (used to catch up on time the server was off).
  tick(dt, now) {
    if (this.fallenUntil) {
      if (now >= this.fallenUntil) this.newGeneration(now);
      else return;
    }
    // Eternal Bloom: the lotus keeps growing, fast as a sprout, slowly after.
    const rate = this.growth < 1 ? 0.5 / 60 : 0.02 / 60;
    this.growth = Math.min(GROWTH_MAX, this.growth + rate * dt);

    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.alive) {
        if (p.regrowAt && now >= p.regrowAt && i !== R.CORE) {
          p.alive = true; p.dmg = this.max(i) * 0.7; p.regrowAt = 0; p.contrib.clear();
          this.emit({ k: 'regrow', part: i });
        }
        continue;
      }
      if (now - p.lastHit > REGEN_DELAY_MS && p.dmg > 0) p.dmg = Math.max(0, p.dmg - this.max(i) * REGEN_PER_SEC * dt);
    }
    if (this.rally && this.rally.until < now) { this.rally = null; this.emit({ k: 'rallyEnd' }); }

    // The Great Rebrand: once per bloom, at 45% health, it heals and announces a new beginning.
    if (!this.rebranded && this.health() < 0.45) {
      this.rebranded = true;
      for (let i = 0; i < this.parts.length; i++) if (this.parts[i].alive) this.parts[i].dmg = Math.max(0, this.parts[i].dmg - this.max(i) * 0.2);
      this.emit({ k: 'rebrand' });
    }
  }

  // Returns {dealt, killed} or null if the bite was not allowed.
  /** opts.shieldMult overrides the shield's damage multiplier (Section 144 decides per bite). */
  bite(i, amount, playerId, now, opts = {}) {
    if (this.isFallen(now)) return null;
    const p = this.parts[i];
    if (!p || !p.alive) return null;
    if (i === R.CORE && !this.coreOpen()) return null;
    if (p.shieldUntil > now) amount *= opts.shieldMult ?? R.BITE.shieldMult;
    if (this.rally && this.rally.part === i && !this.rally.fake) amount *= R.BITE.rallyMult;
    const m = this.max(i);
    const dealt = Math.min(amount, m - p.dmg);
    p.dmg += dealt; p.lastHit = now;
    p.contrib.set(playerId, (p.contrib.get(playerId) || 0) + dealt);
    this.totals.damage += dealt; this.totals.bites++;
    let killed = false;
    if (p.dmg >= m - 0.01) { killed = true; this.destroy(i, now); }
    return { dealt, killed };
  }

  destroy(i, now) {
    const p = this.parts[i];
    p.alive = false; p.dmg = this.max(i); p.shieldUntil = 0;
    const contributors = [...p.contrib.keys()];
    const rallyBy = this.rally && this.rally.part === i && !this.rally.fake ? this.rally.by : null;
    if (this.rally && this.rally.part === i) this.rally = null;
    if (i === R.CORE) {
      this.totals.bloomsFallen++;
      this.history.push({ gen: this.gen, name: R.bloomName(this.gen), fellAt: now, lived: now - this.bornAt });
      this.fallenUntil = now + FALLEN_MS;
      for (const q of this.parts) { q.alive = false; q.regrowAt = 0; }
      this.emit({ k: 'coreDown', gen: this.gen, name: R.bloomName(this.gen), contributors, lived: now - this.bornAt });
    } else {
      this.totals.petalsDown++;
      p.regrowAt = now + REGROW_MS;
      this.emit({ k: 'petalDown', part: i, contributors, rallyBy, coreOpen: this.coreOpen() });
    }
    p.contrib.clear();
  }

  newGeneration(now) {
    this.gen++; this.growth = 0.6; this.bornAt = now; this.peak = 1; this.rebranded = false; this.fallenUntil = 0; this.rally = null;
    for (const p of this.parts) { p.alive = true; p.dmg = 0; p.regrowAt = 0; p.shieldUntil = 0; p.contrib.clear(); }
    this.emit({ k: 'newGen', gen: this.gen, name: R.bloomName(this.gen) });
  }

  // Compact state for snapshots (sent ~10x/second).
  compact(now) {
    let alive = 0, shield = 0;
    this.parts.forEach((p, i) => { if (p.alive) alive |= 1 << i; if (p.shieldUntil > now) shield |= 1 << i; });
    return { g: +this.growth.toFixed(4), c: this.peak, d: this.parts.map(p => Math.round(p.dmg)), a: alive, s: shield };
  }

  full(now) {
    return { gen: this.gen, name: R.bloomName(this.gen), rebranded: this.rebranded, fallenUntil: this.fallenUntil,
      bornAt: this.bornAt, regrowAt: this.parts.map(p => p.regrowAt), totals: this.totals, history: this.history.slice(-8),
      rally: this.rally, ...this.compact(now) };
  }
}

module.exports = { Lotus };
