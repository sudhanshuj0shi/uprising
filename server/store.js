// Persistence: one SQLite file (Node's built-in `node:sqlite`, no extra packages).
//
//   profiles  — one row per player: XP, stats, achievements. Keyed by a random
//               secret token the browser keeps in localStorage.
//   rooms     — one row per room: its lotus, leaderboard and history.
//   meta      — small global values (the national scoreboard).
//
// Only changed rows are written, in one transaction, every few seconds, so saving
// stays cheap even with tens of thousands of players. Old idle data is pruned.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const FILE = process.env.UPRISING_DB || path.join(__dirname, '..', 'data', 'uprising.db');

const DAY = 86400000;
const PRUNE_PROFILE_DAYS = 45;   // casual players (< 50 XP) unseen this long are forgotten
const PRUNE_ROOM_DAYS = 14;      // rooms nobody has opened for this long are deleted

class Store {
  constructor(file = FILE) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;          -- readers never block the writer
      PRAGMA synchronous = NORMAL;        -- safe with WAL, much faster
      CREATE TABLE IF NOT EXISTS profiles (token TEXT PRIMARY KEY, data TEXT NOT NULL, xp INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms    (id TEXT PRIMARY KEY, data TEXT NOT NULL, last_active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Prepared statements: parameters are bound, never concatenated (no SQL injection).
    this.q = {
      getProfile: this.db.prepare('SELECT data FROM profiles WHERE token = ?'),
      putProfile: this.db.prepare('INSERT INTO profiles (token, data, xp, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET data = excluded.data, xp = excluded.xp, last_seen = excluded.last_seen'),
      countProfiles: this.db.prepare('SELECT COUNT(*) AS n FROM profiles'),
      allRooms: this.db.prepare('SELECT id, data FROM rooms'),
      putRoom: this.db.prepare('INSERT INTO rooms (id, data, last_active) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_active = excluded.last_active'),
      delRoom: this.db.prepare('DELETE FROM rooms WHERE id = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      putMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      pruneProfiles: this.db.prepare('DELETE FROM profiles WHERE xp < 50 AND last_seen < ?'),
      pruneRooms: this.db.prepare('DELETE FROM rooms WHERE last_active < ?'),
    };
  }

  getProfile(token) { const row = this.q.getProfile.get(token); return row ? JSON.parse(row.data) : null; }
  profileCount() { return this.q.countProfiles.get().n; }
  loadRooms() { return this.q.allRooms.all().map(r => ({ id: r.id, data: JSON.parse(r.data) })); }
  getMeta(key) { const row = this.q.getMeta.get(key); return row ? JSON.parse(row.value) : null; }

  /** Writes everything that changed in one transaction. */
  flush({ profiles = [], rooms = [], deletedRooms = [], meta = {} }) {
    if (!profiles.length && !rooms.length && !deletedRooms.length && !Object.keys(meta).length) return;
    this.db.exec('BEGIN');
    try {
      for (const [token, p] of profiles) this.q.putProfile.run(token, JSON.stringify(p), p.xp | 0, p.lastSeen || Date.now());
      for (const [id, data, lastActive] of rooms) this.q.putRoom.run(id, JSON.stringify(data), lastActive);
      for (const id of deletedRooms) this.q.delRoom.run(id);
      for (const [k, v] of Object.entries(meta)) this.q.putMeta.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  prune(now = Date.now()) {
    const p = this.q.pruneProfiles.run(now - PRUNE_PROFILE_DAYS * DAY).changes;
    const r = this.q.pruneRooms.run(now - PRUNE_ROOM_DAYS * DAY).changes;
    return { profiles: p, rooms: r };
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { Store, FILE };
