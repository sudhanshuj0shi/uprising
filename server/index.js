// UPRISING server — entry point.
//
//   HTTP       Serves the game's static files from memory (gzip, cache-busting,
//              security headers) plus /health for the host's health checks.
//   WebSocket  One endpoint, /ws. Each browser tab = one "session".
//   Rooms      Up to ROOM_SIZE players per room, each with its own lotus (room.js).
//              New players fill the fullest room that still has space; invite links
//              (/r/<id>) put friends in the same room.
//   Capacity   MAX_PLAYERS caps how many play at once (and so the hosting bill).
//              Everyone beyond it waits in a queue while watching the game.
//   Storage    SQLite via store.js: profiles, rooms, national scoreboard.
//
// Configuration (environment variables) is documented in README.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const R = require('../shared/rules');
const C = require('../shared/content');
const { Store, FILE } = require('./store');
const { Progression } = require('./progression');
const { Room, ROOM_SIZE } = require('./room');
const { cleanName, TOKEN_RE, ROOM_RE } = require('./sanitize');

// ---------------------------------------------------------------- configuration
const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 800;            // total playing at once, across all rooms
const MAX_CONNECTIONS = +process.env.MAX_CONNECTIONS || MAX_PLAYERS * 2 + 200;  // incl. spectators + queue
const MAX_CONN_PER_IP = +process.env.MAX_CONN_PER_IP || 8;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';            // set on Railway / behind a reverse proxy
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TICK_MS = 50;                                              // 20 Hz simulation
const SAVE_MS = 5000;
const MAX_ROOMS_IN_MEMORY = 400;
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- static files (served from memory)
// Loading every public file once at boot means request URLs are only ever used as
// map keys — there is no filesystem path built from user input, so no path traversal.
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
const STATIC = new Map();
const VERSION = buildStatic();

function buildStatic() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name.startsWith('.')) continue;
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full, `${prefix}${f.name}/`);
      else if (MIME[path.extname(f.name)]) files.push([`${prefix}${f.name}`, full]);
    }
  };
  walk(path.join(ROOT, 'public'), '/');
  for (const f of ['rules.js', 'protocol.js', 'content.js']) files.push([`/shared/${f}`, path.join(ROOT, 'shared', f)]);
  // The version is a hash of every file: it busts browser caches on each deploy and
  // lets an already-open page notice a new server and reload itself.
  const hash = crypto.createHash('sha1');
  const bufs = files.map(([url, full]) => { const b = fs.readFileSync(full); hash.update(url).update(b); return [url, b]; });
  const version = hash.digest('hex').slice(0, 10);
  for (let [url, buf] of bufs) {
    const ext = path.extname(url);
    if (ext === '.html') buf = Buffer.from(buf.toString('utf8').replaceAll('__V__', version));
    const compressible = ['.html', '.js', '.css', '.svg', '.json', '.txt'].includes(ext);
    STATIC.set(url, { buf, gz: compressible ? zlib.gzipSync(buf, { level: 9 }) : null, type: MIME[ext],
      etag: `"${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}"`, html: ext === '.html' });
  }
  return version;
}

// Content-Security-Policy: scripts only from this server; fonts from Google Fonts; no framing.
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');

const server = http.createServer((req, res) => {
  try { handleHttp(req, res); }
  catch (e) { console.error('http error', e); if (!res.headersSent) res.writeHead(500); res.end(); }
});

function handleHttp(req, res) {
  const headers = {
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'cross-origin-opener-policy': 'same-origin',
    'x-frame-options': 'DENY',
  };
  if (req.headers['x-forwarded-proto'] === 'https') headers['strict-transport-security'] = 'max-age=31536000';
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...headers, allow: 'GET, HEAD' }); return res.end(); }

  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, online: national.online, rooms: activeRooms() }));
  }
  // The game page answers "/" and invite links "/r/<roomId>"; the page reads the id itself.
  const key = url === '/' || /^\/r\/[a-z0-9]{4,12}\/?$/.test(url) ? '/index.html' : url;
  const f = STATIC.get(key);
  if (!f) { res.writeHead(404, { ...headers, 'content-type': 'text/plain' }); return res.end('Not found'); }

  headers['content-type'] = f.type;
  headers.etag = f.etag;
  // Files requested with ?v=<this deploy's version> never change, so browsers may keep them
  // for a day. Everything else (the page, ES-module imports) is revalidated with the ETag.
  const versioned = (req.url || '').includes(`v=${VERSION}`);
  headers['cache-control'] = versioned && !f.html ? 'public, max-age=86400, immutable' : 'no-cache';
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gz) { headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding'; }
  const body = gz ? f.gz : f.buf;
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------- world state
const store = new Store();
const national = Object.assign({ total: store.profileCount(), blooms: 0, petals: 0, damage: 0, online: 0 }, store.getMeta('national') || {});
national.online = 0;
const prog = new Progression(store, (token, msg) => sendToken(token, msg), national);
const world = { prog, national };

const rooms = new Map();          // room id -> Room (active and dormant)
const deletedRooms = [];
for (const { id, data } of store.loadRooms()) rooms.set(id, new Room(id, data, world));

const sessions = new Map();       // session id -> session
const tokenSessions = new Map();  // token -> number of open tabs (progress is saved when the last one closes)
const ipCounts = new Map();       // ip -> open connections
const queue = [];                 // sessions waiting for a free slot
let playing = 0;

function activeRooms() { let n = 0; for (const r of rooms.values()) if (r.size) n++; return n; }

// Readable, unambiguous room ids (no 0/o/1/l/i), e.g. "k7mpx3".
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRoomId() {
  for (;;) {
    let id = ''; const b = crypto.randomBytes(6);
    for (const x of b) id += ID_CHARS[x % ID_CHARS.length];
    if (!rooms.has(id)) return id;
  }
}

/**
 * Matchmaking. Order of preference:
 *   1. the room from an invite link, if it exists and has space;
 *   2. the FULLEST room that still has space (so rooms feel alive, nobody plays alone);
 *   3. the most recently active empty room (its lotus history carries on);
 *   4. a brand-new room.
 */
function pickRoom(wanted) {
  if (wanted && rooms.has(wanted) && !rooms.get(wanted).full) return rooms.get(wanted);
  let best = null;
  for (const r of rooms.values()) if (r.size > 0 && !r.full && (!best || r.size > best.size)) best = r;
  if (best) return best;
  for (const r of rooms.values()) if (r.size === 0 && (!best || r.lastActive > best.lastActive)) best = r;
  if (best) return best;
  return createRoom();
}

function createRoom() {
  // Keep memory bounded: forget the longest-idle empty rooms (they stay in the database).
  if (rooms.size >= MAX_ROOMS_IN_MEMORY) {
    const idle = [...rooms.values()].filter(r => !r.busy).sort((a, b) => a.lastActive - b.lastActive);
    for (const r of idle.slice(0, 20)) { store.flush({ rooms: [[r.id, r.serialize(), r.lastActive]] }); rooms.delete(r.id); }
  }
  const room = new Room(newRoomId(), null, world);
  rooms.set(room.id, room);
  return room;
}

// ---------------------------------------------------------------- input hygiene
function clientIp(req) {
  if (TRUST_PROXY) {
    // The proxy APPENDS the real client address, so the right-most entry is the one it vouches for.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                         // non-browser clients; they could fake it anyway
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// ---------------------------------------------------------------- WebSocket gateway
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024,                                 // every client message is tiny
  // Compression only for larger JSON (welcome, leaderboards). Binary updates are already
  // compact. No context takeover keeps memory per connection small.
  perMessageDeflate: { threshold: 512, serverNoContextTakeover: true, clientNoContextTakeover: true, serverMaxWindowBits: 11, concurrencyLimit: 4, zlibDeflateOptions: { memLevel: 5 } },
});

server.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if ((req.url || '').split('?')[0] !== '/ws') return reject(404, 'Not Found');
  if (!originAllowed(req)) return reject(403, 'Forbidden');
  if (sessions.size >= MAX_CONNECTIONS) return reject(503, 'Service Unavailable');
  const ip = clientIp(req);
  if ((ipCounts.get(ip) || 0) >= MAX_CONN_PER_IP) return reject(429, 'Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
});

let nextSessionId = 1;
function allocId() {   // ids travel as u16 in the binary protocol, so recycle within 1..65535
  for (let i = 0; i < 65535; i++) { const id = nextSessionId; nextSessionId = nextSessionId % 65535 + 1; if (!sessions.has(id)) return id; }
  throw new Error('no free session ids');
}

function onConnection(ws, ip) {
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  const s = { id: allocId(), ws, ip, token: null, room: null, mode: 'new', hidden: false, alive: true, msgs: 0, msgWindow: Date.now(), strikes: 0 };
  sessions.set(s.id, s);
  ws.on('pong', () => { s.alive = true; });
  ws.on('error', () => {});    // a broken socket must never crash the server
  ws.on('message', (raw, isBinary) => {
    try { onMessage(s, raw, isBinary); }
    catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => onClose(s));
}

function onMessage(s, raw, isBinary) {
  const now = Date.now();
  // Rate limit: ~15 position updates + a few bites per second is normal play.
  if (now - s.msgWindow > 1000) { s.msgWindow = now; s.msgs = 0; }
  if (++s.msgs > 40) { if (s.msgs > 120 || ++s.strikes > 20) s.ws.close(1008, 'rate limit'); return; }
  if (isBinary) return;
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

  switch (m.t) {
    case 'watch': return onWatch(s, m, now);
    case 'hello': return onHello(s, m, now);
    case 'vis': if (s.room) s.room.onVisibility(s, m.hidden === true); else s.hidden = m.hidden === true; return;
  }
  if (s.mode !== 'play') return;
  switch (m.t) {
    case 'pos': return s.room.onPos(s, m, now);
    case 'bite': return s.room.onBite(s, now);
    case 'fly': return s.room.onFly(s, now);
    case 'rally': return s.room.onRally(s, now);
  }
}

function commonInfo() {
  return { v: VERSION, national: nationalInfo(), queueLine: C.DETENTION.lines[Math.random() * C.DETENTION.lines.length | 0] };
}
function nationalInfo() {
  return { online: national.online, rooms: activeRooms(), blooms: national.blooms, petals: national.petals, total: national.total, damage: Math.round(national.damage), detained: queue.length };
}

/** Title screen: watch the room you would join, without taking a slot. */
function onWatch(s, m, now) {
  if (s.mode !== 'new') return;
  const wanted = typeof m.room === 'string' && ROOM_RE.test(m.room) ? m.room : null;
  const room = wanted && rooms.has(wanted) ? rooms.get(wanted) : pickRoom(null);
  s.mode = 'watch';
  const info = room.watch(s, now);
  room.sendTo(s, { t: 'watchInfo', now, ...info, ...commonInfo(), invite: wanted ? { id: wanted, exists: rooms.has(wanted), full: rooms.has(wanted) && rooms.get(wanted).full } : null });
}

function onHello(s, m, now) {
  if (s.mode === 'play' || s.mode === 'queue') return;
  s.token = typeof m.token === 'string' && TOKEN_RE.test(m.token) ? m.token : crypto.randomBytes(16).toString('hex');
  s.name = cleanName(m.name);
  s.wantedRoom = typeof m.room === 'string' && ROOM_RE.test(m.room) ? m.room : null;
  s.hidden = m.hidden === true;
  if (playing >= MAX_PLAYERS) {
    // Full: wait in line, still watching the game.
    if (s.room) s.room.watchers.delete(s);
    s.mode = 'queue'; queue.push(s);
    pickRoom(null).watch(s, now);
    return sendQueue(s);
  }
  admit(s, now);
}

function admit(s, now) {
  if (s.room) s.room.watchers.delete(s);
  const { profile: p, isNew } = prog.open(s.token, s.name);
  if (s.name && !isNew) p.name = s.name;
  tokenSessions.set(s.token, (tokenSessions.get(s.token) || 0) + 1);

  // Returning players go back to their last room if it has space (unless they followed an invite).
  const room = pickRoom(s.wantedRoom || p.lastRoom);
  p.lastRoom = room.id;
  const info = room.add(s, now);
  playing++; national.online = playing;

  // "While you were away": what the whole uprising did since their last visit.
  let away = null;
  if (!isNew && p.seen && p.lastSeen) {
    away = { ms: now - p.lastSeen, blooms: national.blooms - p.seen.blooms, petals: national.petals - p.seen.petals, newPlayers: national.total - p.seen.total };
  }
  const invite = s.wantedRoom ? { id: s.wantedRoom, got: room.id === s.wantedRoom } : null;
  room.sendTo(s, { t: 'welcome', now, id: s.id, token: s.token, me: prog.publicProfile(p), isNew, away, invite, released: !!s.released, ...info, ...commonInfo() });
}

function sendQueue(s) {
  const pos = queue.indexOf(s) + 1;
  if (pos > 0) s.ws.readyState === 1 && s.ws.send(JSON.stringify({ t: 'queue', pos, total: queue.length, ...commonInfo() }));
}

function onClose(s) {
  sessions.delete(s.id);
  const n = (ipCounts.get(s.ip) || 1) - 1; if (n > 0) ipCounts.set(s.ip, n); else ipCounts.delete(s.ip);
  const qi = queue.indexOf(s); if (qi >= 0) queue.splice(qi, 1);
  if (s.room) s.room.remove(s);
  if (s.mode === 'play') {
    playing--; national.online = playing;
    const left = (tokenSessions.get(s.token) || 1) - 1;
    if (left > 0) tokenSessions.set(s.token, left);
    else {
      tokenSessions.delete(s.token);
      const p = prog.get(s.token);
      if (p) p.seen = { blooms: national.blooms, petals: national.petals, total: national.total };
      prog.release(s.token);
    }
  }
}

function sendToken(token, msg) {
  const str = JSON.stringify(msg);
  for (const s of sessions.values()) if (s.token === token && s.mode === 'play' && s.ws.readyState === 1) s.ws.send(str);
}

// ---------------------------------------------------------------- main loop
let tickN = 0, lastDetained = 0;
setInterval(() => {
  const now = Date.now();
  tickN++;
  for (const r of rooms.values()) if (r.busy) r.tick(now, tickN);

  if (tickN % 20 === 0) {                                   // every second: let people in from the queue
    while (queue.length && playing < MAX_PLAYERS) { const s = queue.shift(); if (s.ws.readyState === 1) { s.released = true; admit(s, now); } }
    if (tickN % 40 === 0) for (const s of queue) sendQueue(s);
    if (queue.length !== lastDetained) {                 // everyone sees the detention pod fill and empty
      lastDetained = queue.length;
      const msg = JSON.stringify({ t: 'det', n: queue.length });
      for (const s of sessions.values()) if (s.mode !== 'new' && s.ws.readyState === 1) s.ws.send(msg);
    }
  }
  if (tickN % 200 === 0) {                                  // every 10 s: national scoreboard to everyone
    const msg = JSON.stringify({ t: 'nat', national: nationalInfo() });
    for (const s of sessions.values()) if (s.mode !== 'new' && s.ws.readyState === 1) s.ws.send(msg);
  }
  if (tickN % 600 === 0) {                                  // every 30 s: drop dead connections
    for (const s of sessions.values()) { if (!s.alive) { s.ws.terminate(); continue; } s.alive = false; s.ws.ping(); }
  }
}, TICK_MS);

setInterval(persist, SAVE_MS);
setInterval(() => { try { const p = store.prune(); if (p.profiles || p.rooms) console.log('pruned', p); } catch (e) { console.error(e); } }, 6 * 3600 * 1000);

function persist() {
  try {
    const dirtyRooms = [];
    for (const r of rooms.values()) if (r.dirty || r.size) { dirtyRooms.push([r.id, r.serialize(), r.lastActive]); r.dirty = false; }
    store.flush({ profiles: prog.takeDirty(), rooms: dirtyRooms, deletedRooms: deletedRooms.splice(0), meta: { national: { ...national, online: 0 } } });
  } catch (e) { console.error('save failed', e); }
}

// Railway (and most hosts) stop the old copy with SIGTERM when a new version goes live.
// Save everything and exit with code 0 so the host records a clean stop, not a crash.
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  console.log('shutting down, saving…');
  for (const s of sessions.values()) if (s.mode === 'play') { const p = prog.get(s.token); if (p) { p.lastSeen = Date.now(); p.seen = { blooms: national.blooms, petals: national.petals, total: national.total }; prog.touch(s.token); } }
  persist(); store.close(); process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`UPRISING ${VERSION} on http://localhost:${PORT}  rooms of ${ROOM_SIZE}, cap ${MAX_PLAYERS} players  (db: ${process.env.UPRISING_DB || FILE})`));

