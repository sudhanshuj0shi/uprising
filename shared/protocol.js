// UPRISING — binary wire format for the high-frequency messages.
//
// Everything that is sent many times a second (cockroach positions, lotus state)
// travels as compact binary instead of JSON. Rare messages (events, welcome,
// leaderboards) stay JSON because they are small and easier to read/debug.
//
// Loaded by the Node server (require) and the browser (window.PROTO).
//
// ┌──────────── ROACHES (type 1 = delta, type 2 = keyframe) ────────────┐
// │ u8 type │ u16 count │ count × ROW                                   │
// │ ROW = u16 id │ u16 x*16 │ u16 y*16 │ u8 angle │ u8 flags │ u8 level │ = 9 bytes
// └─────────────────────────────────────────────────────────────────────┘
//   delta    : only roaches that changed since the previous tick
//   keyframe : every roach in the room; the client drops anyone missing from it
//
// ┌──────────── LOTUS (type 3) ─────────────────────────────────────────┐
// │ u8 type │ u16 growth*10000 │ u16 alive bits │ u16 shield bits        │
// │ u16 roomOnline │ u16 nationOnline │ u32 roomDamage │ PARTS × u16 dmgFraction*65535 │
// └─────────────────────────────────────────────────────────────────────┘
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PROTO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const T_DELTA = 1, T_KEY = 2, T_LOTUS = 3;
  const ROW = 9;

  // Roach flags (one bit each).
  const F_FLY = 1, F_STUN = 2, F_BITE = 4, F_SLEEP = 8, F_DASH = 16, F_JUMLA = 32;

  const POS_SCALE = 16;                    // 1/16 px precision; 3200 px world fits in u16
  const angleToByte = (a) => ((Math.round(a / (Math.PI * 2) * 256) % 256) + 256) % 256;
  const byteToAngle = (b) => b / 256 * Math.PI * 2;

  /** rows: array of {id, x, y, a, flags, lvl}. Returns a Uint8Array. */
  function encodeRoaches(type, rows) {
    const buf = new ArrayBuffer(3 + rows.length * ROW);
    const v = new DataView(buf);
    v.setUint8(0, type); v.setUint16(1, rows.length, true);
    let o = 3;
    for (const r of rows) {
      v.setUint16(o, r.id & 0xffff, true);
      v.setUint16(o + 2, clamp16(r.x * POS_SCALE), true);
      v.setUint16(o + 4, clamp16(r.y * POS_SCALE), true);
      v.setUint8(o + 6, angleToByte(r.a));
      v.setUint8(o + 7, r.flags & 0xff);
      v.setUint8(o + 8, Math.min(255, r.lvl | 0));
      o += ROW;
    }
    return new Uint8Array(buf);
  }

  function encodeLotus(L) {
    const n = L.frac.length;
    const buf = new ArrayBuffer(15 + n * 2);
    const v = new DataView(buf);
    v.setUint8(0, T_LOTUS);
    v.setUint16(1, clamp16(L.growth * 10000), true);
    v.setUint16(3, L.alive & 0xffff, true);
    v.setUint16(5, L.shield & 0xffff, true);
    v.setUint16(7, clamp16(L.roomOnline), true);
    v.setUint16(9, clamp16(L.nationOnline), true);
    v.setUint32(11, Math.max(0, Math.min(0xffffffff, Math.round(L.damage))), true);
    for (let i = 0; i < n; i++) v.setUint16(15 + i * 2, clamp16(L.frac[i] * 65535), true);
    return new Uint8Array(buf);
  }

  /** Decodes any binary message. Returns {type, rows} or {type, lotus}, or null if malformed. */
  function decode(arrayBuffer, partCount) {
    const v = new DataView(arrayBuffer);
    if (v.byteLength < 1) return null;
    const type = v.getUint8(0);
    if (type === T_DELTA || type === T_KEY) {
      if (v.byteLength < 3) return null;
      const count = v.getUint16(1, true);
      if (v.byteLength < 3 + count * ROW) return null;
      const rows = new Array(count);
      for (let i = 0, o = 3; i < count; i++, o += ROW) {
        rows[i] = { id: v.getUint16(o, true), x: v.getUint16(o + 2, true) / POS_SCALE, y: v.getUint16(o + 4, true) / POS_SCALE,
          a: byteToAngle(v.getUint8(o + 6)), flags: v.getUint8(o + 7), lvl: v.getUint8(o + 8) };
      }
      return { type, rows };
    }
    if (type === T_LOTUS) {
      if (v.byteLength < 15 + partCount * 2) return null;
      const frac = [];
      for (let i = 0; i < partCount; i++) frac.push(v.getUint16(15 + i * 2, true) / 65535);
      return { type, lotus: { growth: v.getUint16(1, true) / 10000, alive: v.getUint16(3, true), shield: v.getUint16(5, true),
        roomOnline: v.getUint16(7, true), nationOnline: v.getUint16(9, true), damage: v.getUint32(11, true), frac } };
    }
    return null;
  }

  function clamp16(n) { return Math.max(0, Math.min(65535, Math.round(n))); }

  return { T_DELTA, T_KEY, T_LOTUS, F_FLY, F_STUN, F_BITE, F_SLEEP, F_DASH, F_JUMLA, POS_SCALE, angleToByte,
    encodeRoaches, encodeLotus, decode };
});
