// Unit tests for the parts that must never break: the wire format, input sanitising,
// the lotus lifecycle, matchmaking capacity and persistence. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../shared/rules');
const P = require('../shared/protocol');
const { cleanName, TOKEN_RE, ROOM_RE } = require('../server/sanitize');
const { Lotus } = require('../server/lotus');
const { Store } = require('../server/store');

test('protocol: roach rows survive a round trip', () => {
  const rows = [{ id: 7, x: 1600.5, y: 3199.9, a: Math.PI / 2, flags: P.F_FLY | P.F_BITE, lvl: 9 }, { id: 65535, x: 0, y: 0, a: -1, flags: 0, lvl: 1 }];
  const out = P.decode(P.encodeRoaches(P.T_KEY, rows).buffer, R.PARTS.length);
  assert.equal(out.type, P.T_KEY);
  assert.equal(out.rows.length, 2);
  assert.ok(Math.abs(out.rows[0].x - 1600.5) < 0.1 && Math.abs(out.rows[0].y - 3199.9) < 0.1);
  assert.equal(out.rows[0].flags, P.F_FLY | P.F_BITE);
  assert.equal(out.rows[1].id, 65535);
});

test('protocol: lotus state survives a round trip; malformed input is rejected', () => {
  const frac = R.PARTS.map((_, i) => i / R.PARTS.length);
  const buf = P.encodeLotus({ growth: 1.234, alive: 0b1010, shield: 0b1, roomOnline: 42, nationOnline: 900, damage: 123456, frac });
  const out = P.decode(buf.buffer, R.PARTS.length).lotus;
  assert.equal(out.roomOnline, 42); assert.equal(out.nationOnline, 900); assert.equal(out.damage, 123456);
  assert.ok(Math.abs(out.growth - 1.234) < 0.001);
  assert.ok(Math.abs(out.frac[5] - frac[5]) < 0.0001);
  assert.equal(P.decode(new Uint8Array([P.T_LOTUS, 1]).buffer, R.PARTS.length), null);
  assert.equal(P.decode(new Uint8Array([P.T_KEY, 9, 0]).buffer, R.PARTS.length), null);
  assert.equal(P.decode(new Uint8Array([99]).buffer, R.PARTS.length), null);
});

test('sanitize: names are stripped of markup, control and bidi characters', () => {
  assert.ok(!/[<>]/.test(cleanName('<img src=x onerror=alert(1)>')));
  assert.equal(cleanName('evil‮gnp.exe'), 'evilgnp.exe');
  assert.equal(cleanName('  a\u0000b\nc  '), 'ab c');
  assert.equal(cleanName('x'.repeat(100)).length, 24);
  assert.equal(cleanName(null), '');
  assert.ok(TOKEN_RE.test('0123456789abcdef0123456789abcdef'));
  assert.ok(!TOKEN_RE.test('../../etc/passwd'));
  assert.ok(ROOM_RE.test('k7mpx3') && !ROOM_RE.test('<script>') && !ROOM_RE.test('a/../b'));
});

test('lotus: core is locked until 7 petals fall, then the bloom falls and is reborn', () => {
  const events = [];
  const L = new Lotus(null, (e) => events.push(e.k));
  let now = Date.now();
  L.tick(120, now);
  assert.equal(L.bite(R.CORE, 100, 'p', now), null, 'core locked');
  for (let i = 0; i < 7; i++) while (L.isAlive(i)) L.bite(i, 500, 'p', now += 10);
  assert.ok(L.coreOpen());
  while (L.isAlive(R.CORE)) L.bite(R.CORE, 500, 'p', now += 10);
  assert.ok(L.isFallen(now));
  L.tick(30, now + 26000);
  assert.equal(L.gen, 2);
  assert.ok(L.parts.every(p => p.alive));
  assert.ok(events.includes('coreDown') && events.includes('newGen'));
});

test('lotus: crowd scaling keeps each petal\'s % health when the crowd changes', () => {
  const L = new Lotus(null, () => {});
  const now = Date.now();
  L.tick(120, now);
  L.bite(0, L.max(0) / 2, 'p', now);
  const before = L.parts[0].dmg / L.max(0);
  L.setCrowd(30, now);
  assert.ok(Math.abs(L.parts[0].dmg / L.max(0) - before) < 1e-9);
  assert.equal(L.peak, 30);
  L.setCrowd(1, now + 11 * 60000);   // 11 minutes later, the crowd has gone
  assert.equal(L.peak, 1);
  assert.ok(Math.abs(L.parts[0].dmg / L.max(0) - before) < 1e-9);
});

test('store: profiles and rooms persist, idle data is pruned', () => {
  const s = new Store(':memory:');
  s.flush({ profiles: [['t1', { name: 'A', xp: 10, lastSeen: 1 }], ['t2', { name: 'B', xp: 500, lastSeen: 1 }]],
    rooms: [['abcd', { lotus: { gen: 3 } }, Date.now()]], meta: { national: { blooms: 4 } } });
  assert.equal(s.getProfile('t1').name, 'A');
  assert.equal(s.loadRooms()[0].data.lotus.gen, 3);
  assert.equal(s.getMeta('national').blooms, 4);
  const pruned = s.prune(Date.now());
  assert.equal(pruned.profiles, 1, 'low-XP idle profile pruned, veteran kept');
  assert.equal(s.getProfile('t2').name, 'B');
  s.close();
});
