// Player progression: XP, levels, lifetime stats and achievements.
//
// Profiles live in SQLite (see store.js). While a player is online their profile is
// kept in memory; changes are marked dirty and flushed in batches. Players are
// identified by a random 128-bit token stored in their browser — there are no
// passwords or emails, so there is nothing sensitive to leak.
const R = require('../shared/rules');

class Progression {
  /**
   * @param store  Store instance (or null for tests)
   * @param send   (token, msg) => void — delivers a message to that player if online
   * @param counts { total } — running count of every cockroach ever, for "you are #N"
   */
  constructor(store, send, counts) {
    this.store = store;
    this.send = send;
    this.counts = counts;
    this.cache = new Map();      // token -> profile (online players + recently left)
    this.dirty = new Set();      // tokens with unsaved changes
    this.released = new Set();   // tokens whose owner went offline; evicted after the next flush
  }

  /** Loads (or creates) a profile. Returns {profile, isNew}. */
  open(token, name) {
    let p = this.cache.get(token) || (this.store && this.store.getProfile(token));
    let isNew = false;
    if (!p) {
      isNew = true;
      this.counts.total++;
      p = { name: name || R.randomName(), hue: Math.random() * 360 | 0, xp: 0, bites: 0, dmg: 0, stomps: 0, jumlas: 0,
        petals: 0, blooms: 0, ach: [], firstSeen: Date.now(), lastSeen: Date.now(), lastRoom: null, seen: null, number: this.counts.total };
      if (p.number <= 100) p.ach.push('founder');
    }
    this.cache.set(token, p);
    this.released.delete(token);
    this.dirty.add(token);
    return { profile: p, isNew };
  }

  /** Call when the player's last connection closes. */
  release(token) { const p = this.cache.get(token); if (!p) return; p.lastSeen = Date.now(); this.dirty.add(token); this.released.add(token); }

  get(token) { return this.cache.get(token); }
  level(token) { const p = this.cache.get(token); return p ? R.levelFor(p.xp) : 1; }
  touch(token) { this.dirty.add(token); }

  addXp(token, amount, why) {
    const p = this.cache.get(token); if (!p) return;
    const before = R.levelFor(p.xp);
    p.xp += amount;
    this.dirty.add(token);
    const after = R.levelFor(p.xp);
    this.send(token, { t: 'xp', xp: p.xp, add: amount, why: why || null });
    if (after > before) {
      const unlocked = R.UNLOCKS.filter(u => u.lvl > before && u.lvl <= after);
      this.send(token, { t: 'ev', k: 'levelUp', level: after, title: R.titleFor(after), unlocked, me: this.publicProfile(p) });
    }
  }

  /** Grants an achievement once. Returns true if it was new. */
  grant(token, key) {
    const p = this.cache.get(token); if (!p || p.ach.includes(key) || !R.ACHIEVEMENTS[key]) return false;
    p.ach.push(key);
    this.dirty.add(token);
    this.send(token, { t: 'ev', k: 'ach', key, ...R.ACHIEVEMENTS[key] });
    return true;
  }

  /** Called for every bite the server accepted. */
  onBite(token, dealt, buddies) {
    const p = this.cache.get(token); if (!p) return;
    p.bites++; p.dmg += dealt;
    // 1 XP per bite, 2 when biting with the swarm: collective play levels faster.
    this.addXp(token, buddies >= 2 ? 2 : 1);
    if (p.bites >= 100) this.grant(token, 'bites100');
    if (p.bites >= 1000) this.grant(token, 'bites1000');
    if (buddies >= 5) this.grant(token, 'swarm');
  }

  publicProfile(p) {
    const level = R.levelFor(p.xp);
    return { name: p.name, hue: p.hue, xp: p.xp, level, title: R.titleFor(level), next: R.nextLevelXp(level), prev: R.LEVELS[level - 1],
      bites: p.bites, dmg: Math.round(p.dmg), stomps: p.stomps, jumlas: p.jumlas, petals: p.petals, blooms: p.blooms, ach: p.ach, number: p.number };
  }

  /** Hands unsaved profiles to the store and forgets players who went offline. */
  takeDirty() {
    const out = [];
    for (const t of this.dirty) { const p = this.cache.get(t); if (p) out.push([t, p]); }
    this.dirty.clear();
    for (const t of this.released) this.cache.delete(t);
    this.released.clear();
    return out;
  }
}

module.exports = { Progression };
