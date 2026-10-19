// Rendering: pond, lotus (cached per petal, re-drawn only when damage changes),
// cockroaches, hazards, particles. Pure canvas 2D, no dependencies.
const R = window.RULES;

export const C = {
  ink: '#1b1611', paper: '#fbf3e4',
  pond: '#3d8f88', pondDeep: '#2f7973', ripple: 'rgba(255,255,255,0.13)', shore: '#ead9ab', shoreDark: '#cdb77f',
  pad: '#7aa846', padDark: '#557a2c', roach: '#7a4322', roachDark: '#4a2512', roachHi: '#b0713f',
  zap: '#ffd23f', danger: '#ff6b35', sky: '#aee6ff',
};
const PALETTES = {
  normal: { base: '#fff0f4', tip: '#ff4f8b', tipInner: '#ff7aa7', rim: '#c9356e', vein: 'rgba(201,53,110,0.35)', core: '#d5df6d', coreDark: '#9aa83b' },
  gold:   { base: '#fff7dc', tip: '#ffb320', tipInner: '#ffc94d', rim: '#c27d00', vein: 'rgba(194,125,0,0.35)', core: '#ffe27a', coreDark: '#c9a227' },
};

// ---------------------------------------------------------------- seeded random
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- petal geometry
export function petalPath(ctx, L, W) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(L * 0.28, -W * 1.05, L * 0.78, -W * 0.85, L, 0);
  ctx.bezierCurveTo(L * 0.78, W * 0.85, L * 0.28, W * 1.05, 0, 0);
  ctx.closePath();
}
function bez(p0, p1, p2, p3, t) { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; }
function outlinePoint(L, W, t, side) { // t: 0 base -> 1 tip
  return { x: bez(0, L * 0.28, L * 0.78, L, t), y: side * bez(0, -W * 1.05, -W * 0.85, 0, t) };
}

const LC = 1.6; // lotus cache resolution multiplier (keeps it crisp when it grows)
const MARKS = 48;   // damage steps per petal drawing (finer = changes sooner)

// Precomputed bite marks per part, ordered so damage eats tip-first, then inward.
const biteMarks = R.PARTS.map((p, i) => {
  const rnd = mulberry(1000 + i * 77);
  const marks = [];
  for (let k = 0; k < MARKS; k++) {
    if (p.kind === 'c') {
      const a = rnd() * Math.PI * 2; marks.push({ a, d: 1 - rnd() * 0.15, r: 0.22 + rnd() * 0.2, o: rnd() });
    } else {
      const t = 0.3 + rnd() * 0.72;
      marks.push({ t: Math.min(1, t), side: rnd() < 0.5 ? -1 : 1, inset: rnd() * 0.25, r: 0.2 + rnd() * 0.22, o: t + rnd() * 0.35 });
    }
  }
  marks.sort((a, b) => b.o - a.o);
  return marks;
});

// ---------------------------------------------------------------- lotus cache
export class LotusArt {
  constructor() {
    this.R0 = R.LOTUS.baseR * LC;
    this.S = Math.ceil(this.R0 * 2.3);
    this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = this.S;
    this.parts = R.PARTS.map(() => ({ canvas: document.createElement('canvas'), key: '' }));
    this.dirty = true; this.palette = 'normal';
  }

  // frac: damage fraction per part, alive flags. Only re-renders parts whose bucket changed.
  update(frac, alive, palette) {
    if (palette !== this.palette) { this.palette = palette; this.parts.forEach(p => p.key = ''); }
    for (let i = 0; i < R.PARTS.length; i++) {
      const bucket = alive[i] ? Math.min(MARKS, Math.floor(frac[i] * MARKS + 0.0001)) : -1;
      const key = bucket + palette;
      if (key !== this.parts[i].key) { this.parts[i].key = key; this.renderPart(i, bucket); this.dirty = true; }
    }
    if (this.dirty) this.compose();
  }

  renderPart(i, bucket) {
    const p = R.PARTS[i], cv = this.parts[i].canvas, pal = PALETTES[this.palette];
    if (p.kind === 'c') {
      const r = this.R0 * p.zr; const s = Math.ceil(r * 2 + 16);
      cv.width = cv.height = s; const ctx = cv.getContext('2d');
      if (bucket < 0) return;
      ctx.translate(s / 2, s / 2);
      // stamens
      ctx.strokeStyle = '#f7c948'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (let k = 0; k < 36; k++) { const a = k / 36 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85); ctx.lineTo(Math.cos(a) * (r + 6), Math.sin(a) * (r + 6)); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r); g.addColorStop(0, '#f4f8b8'); g.addColorStop(1, pal.core);
      ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.stroke();
      ctx.fillStyle = pal.coreDark;
      const holes = [[0, 0], ...Array.from({ length: 6 }, (_, k) => [Math.cos(k / 6 * Math.PI * 2) * r * 0.5, Math.sin(k / 6 * Math.PI * 2) * r * 0.5])];
      for (const [hx, hy] of holes) { ctx.beginPath(); ctx.arc(hx, hy, r * 0.11, 0, Math.PI * 2); ctx.fill(); }
      this.chew(ctx, i, bucket, (m) => ({ x: Math.cos(m.a) * r * 0.88 * m.d, y: Math.sin(m.a) * r * 0.88 * m.d, rr: r * m.r }), pal);
      return;
    }
    const L = this.R0 * p.len, W = this.R0 * p.wid;
    const pad = 8; cv.width = Math.ceil(L + pad * 2); cv.height = Math.ceil(W * 2 + pad * 2);
    const ctx = cv.getContext('2d');
    ctx.translate(pad, cv.height / 2);
    if (bucket < 0) { // fallen: a sad chewed stub
      ctx.fillStyle = '#9b6b4f'; ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
      petalPath(ctx, L * 0.2, W * 0.35); ctx.fill(); ctx.stroke();
      return;
    }
    const frac = bucket / MARKS;
    const g = ctx.createLinearGradient(0, 0, L, 0);
    g.addColorStop(0, pal.base); g.addColorStop(0.55, mix(pal.base, p.kind === 'i' ? pal.tipInner : pal.tip, 0.5)); g.addColorStop(1, p.kind === 'i' ? pal.tipInner : pal.tip);
    petalPath(ctx, L, W); ctx.fillStyle = g; ctx.fill();
    if (frac > 0.3) { ctx.fillStyle = `rgba(150,80,60,${(frac - 0.3) * 0.35})`; ctx.fill(); } // bruising
    ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.strokeStyle = pal.vein; ctx.lineWidth = 2;
    for (const v of [-0.35, 0, 0.35]) { ctx.beginPath(); ctx.moveTo(L * 0.08, 0); ctx.quadraticCurveTo(L * 0.5, W * v * 1.1, L * 0.9, W * v * 0.25); ctx.stroke(); }
    this.chew(ctx, i, bucket, (m) => { const q = outlinePoint(L, W, m.t, m.side); return { x: q.x - m.inset * W * 0.3, y: q.y * (1 - m.inset), rr: W * m.r }; }, pal);
  }

  chew(ctx, i, bucket, place, pal) {
    for (let k = 0; k < bucket; k++) {
      const m = biteMarks[i][k], q = place(m);
      // a scalloped bite: three overlapping circles, with a darker chewed rim
      const circles = [[0, 0, 1], [q.rr * 0.55, q.rr * 0.25, 0.7], [-q.rr * 0.5, -q.rr * 0.3, 0.65]];
      ctx.globalCompositeOperation = 'source-atop';
      ctx.strokeStyle = pal.rim; ctx.lineWidth = 5;
      for (const [dx, dy, s] of circles) { ctx.beginPath(); ctx.arc(q.x + dx, q.y + dy, q.rr * s + 2.5, 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalCompositeOperation = 'destination-out';
      for (const [dx, dy, s] of circles) { ctx.beginPath(); ctx.arc(q.x + dx, q.y + dy, q.rr * s, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  compose() {
    const ctx = this.canvas.getContext('2d'), S = this.S, c = S / 2;
    ctx.clearRect(0, 0, S, S);
    // soft shadow on the water
    ctx.fillStyle = 'rgba(20,60,55,0.25)'; ctx.beginPath(); ctx.ellipse(c + 14, c + 22, this.R0 * 1.02, this.R0 * 0.98, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < R.PARTS.length; i++) {
      const p = R.PARTS[i], cv = this.parts[i].canvas;
      ctx.save(); ctx.translate(c, c);
      if (p.kind === 'c') ctx.drawImage(cv, -cv.width / 2, -cv.height / 2);
      else { ctx.rotate(p.ang); ctx.drawImage(cv, -8, -cv.height / 2); }
      ctx.restore();
    }
    this.dirty = false;
  }

  draw(ctx, growth, t) {
    const k = growth / LC * (1 + Math.sin(t * 1.3) * 0.006);
    const S = this.S * k;
    ctx.drawImage(this.canvas, R.LOTUS.x - S / 2, R.LOTUS.y - S / 2, S, S);
  }
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t), g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t), bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}

// Outline of a part in world coords (for highlights, shields).
export function partPath(ctx, i, growth) {
  const p = R.PARTS[i], Rw = R.radius(growth);
  ctx.save(); ctx.translate(R.LOTUS.x, R.LOTUS.y);
  if (p.kind === 'c') { ctx.beginPath(); ctx.arc(0, 0, Rw * p.zr * 0.95, 0, Math.PI * 2); }
  else { ctx.rotate(p.ang); petalPath(ctx, Rw * p.len, Rw * p.wid); }
  ctx.restore();
}

// ---------------------------------------------------------------- pond
export class Pond {
  constructor() {
    const rnd = mulberry(42);
    this.pads = [];
    while (this.pads.length < 80) {
      const x = 80 + rnd() * (R.WORLD.w - 160), y = 80 + rnd() * (R.WORLD.h - 160);
      if (Math.hypot(x - R.LOTUS.x, y - R.LOTUS.y) < 620) continue;
      this.pads.push({ x, y, r: 26 + rnd() * 42, a: rnd() * 6.28, ph: rnd() * 6.28, flower: rnd() < 0.08 });
    }
    // water texture tile
    const tile = document.createElement('canvas'); tile.width = tile.height = 240;
    const t = tile.getContext('2d'); t.fillStyle = C.pond; t.fillRect(0, 0, 240, 240);
    t.strokeStyle = C.ripple; t.lineWidth = 2; t.lineCap = 'round';
    for (let k = 0; k < 9; k++) {
      const x = rnd() * 240, y = rnd() * 240, w = 18 + rnd() * 26;
      t.beginPath(); t.moveTo(x, y); t.quadraticCurveTo(x + w / 2, y - 5, x + w, y); t.stroke();
    }
    this.tile = tile; this.pattern = null;
  }

  draw(ctx, cam, t) {
    if (!this.pattern) this.pattern = ctx.createPattern(this.tile, 'repeat');
    const { x0, y0, x1, y1 } = cam.view;
    ctx.fillStyle = C.shore; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.save();
    ctx.beginPath(); ctx.roundRect(0, 0, R.WORLD.w, R.WORLD.h, 160);
    ctx.fillStyle = this.pattern;
    ctx.translate(Math.sin(t * 0.2) * 20, t * 6 % 240); ctx.fill();
    ctx.restore();
    ctx.lineWidth = 10; ctx.strokeStyle = C.shoreDark; ctx.beginPath(); ctx.roundRect(-5, -5, R.WORLD.w + 10, R.WORLD.h + 10, 165); ctx.stroke();
    // a darker halo of deep water around the lotus
    const g = ctx.createRadialGradient(R.LOTUS.x, R.LOTUS.y, 200, R.LOTUS.x, R.LOTUS.y, 900);
    g.addColorStop(0, 'rgba(30,100,95,0.35)'); g.addColorStop(1, 'rgba(30,100,95,0)');
    ctx.fillStyle = g; ctx.fillRect(R.LOTUS.x - 900, R.LOTUS.y - 900, 1800, 1800);

    for (const p of this.pads) {
      if (p.x + p.r < x0 || p.x - p.r > x1 || p.y + p.r < y0 || p.y - p.r > y1) continue;
      const a = p.a + Math.sin(t * 0.4 + p.ph) * 0.08;
      ctx.fillStyle = 'rgba(20,70,60,0.22)'; ctx.beginPath(); ctx.arc(p.x + 5, p.y + 7, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.arc(p.x, p.y, p.r, a + 0.35, a + Math.PI * 2 - 0.1); ctx.closePath();
      ctx.fillStyle = C.pad; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.padDark; ctx.stroke();
      ctx.strokeStyle = 'rgba(40,80,20,0.35)'; ctx.lineWidth = 1.5;
      for (let k = 1; k < 6; k++) { const b = a + 0.35 + k * (Math.PI * 2 - 0.45) / 6; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(b) * p.r * 0.85, p.y + Math.sin(b) * p.r * 0.85); ctx.stroke(); }
      if (p.flower) { ctx.fillStyle = '#fff6d8'; ctx.beginPath(); ctx.arc(p.x + p.r * 0.2, p.y - p.r * 0.1, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.zap; ctx.beginPath(); ctx.arc(p.x + p.r * 0.2, p.y - p.r * 0.1, 3, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  // A wilted husk + signpost for every bloom the swarm has toppled. Lasting scars.
  drawMonuments(ctx, history) {
    history.forEach((h, k) => {
      const a = -Math.PI / 2 + k * 0.62 + 0.3, d = 1180;
      const x = R.LOTUS.x + Math.cos(a) * d, y = R.LOTUS.y + Math.sin(a) * d;
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = 'rgba(20,60,55,0.25)'; ctx.beginPath(); ctx.ellipse(6, 8, 70, 62, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 7; i++) { ctx.save(); ctx.rotate(i / 7 * Math.PI * 2 + k); ctx.fillStyle = i % 2 ? '#8d6a5c' : '#a07b69'; ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5; petalPath(ctx, 56 - (i % 3) * 8, 18); ctx.fill(); ctx.stroke(); ctx.restore(); }
      ctx.fillStyle = '#7d7a3e'; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // sign
      ctx.translate(0, 64);
      ctx.fillStyle = '#c99a5b'; ctx.fillRect(-3, -18, 6, 22);
      ctx.fillStyle = C.paper; ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.roundRect(-78, -2, 156, 34, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.font = '800 11px "Bricolage Grotesque", system-ui';
      ctx.fillText(`HERE LIES ${h.name.toUpperCase()}`.slice(0, 30), 0, 12);
      ctx.font = '600 10px "Bricolage Grotesque", system-ui';
      ctx.fillText(`toppled after ${fmtDur(h.lived)}`, 0, 25);
      ctx.restore();
    });
  }
}

export function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute'; if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m`; return `${Math.floor(h / 24)} days`;
}

// ---------------------------------------------------------------- cockroach
// Facing +x. Expressive and slightly ridiculous: googly eyes, a gamcha scarf, waving antennae.
export function drawRoach(ctx, r, t) {
  const s = r.size;
  ctx.save(); ctx.translate(r.x, r.y);
  const fly = r.flying ? 1 : 0;
  // shadow
  ctx.fillStyle = 'rgba(15,45,40,0.28)';
  ctx.beginPath(); ctx.ellipse(3 + fly * 10, 5 + fly * 16, 17 * s, 11 * s, r.a, 0, Math.PI * 2); ctx.fill();
  if (fly) ctx.translate(0, -12);
  ctx.rotate(r.a);
  if (r.stunned) ctx.scale(1.15, 1.5); // flattened
  ctx.scale(s, s);

  const walk = r.walk, lw = 2.2;
  ctx.strokeStyle = C.ink; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // legs
  if (!fly) {
    ctx.lineWidth = lw;
    for (let k = 0; k < 3; k++) {
      const bx = 6 - k * 7, swing = Math.sin(walk + k * 2.1) * 0.5 * (r.stunned ? 0 : 1);
      for (const side of [-1, 1]) {
        const sw = side * swing;
        const kx = bx + Math.cos(-0.3 + sw) * 9 * (k === 2 ? -1 : 1) * 0.6, ky = side * (8 + Math.abs(Math.sin(sw)) * 2);
        ctx.beginPath(); ctx.moveTo(bx, side * 5); ctx.lineTo(kx, ky + side * 3); ctx.lineTo(kx + (k === 2 ? -7 : 5) + sw * 6, ky + side * 9); ctx.stroke();
      }
    }
  }
  // wings (flight)
  if (fly) {
    const flap = Math.sin(t * 60) * 0.35;
    ctx.fillStyle = 'rgba(255,214,140,0.55)'; ctx.lineWidth = 1.5;
    for (const side of [-1, 1]) {
      ctx.save(); ctx.rotate(side * (0.9 + flap));
      ctx.beginPath(); ctx.ellipse(-12, side * 2, 16, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }
  // gamcha scarf tail
  const hue = r.hue;
  ctx.fillStyle = `hsl(${hue} 75% 56%)`; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(3, -2);
  ctx.quadraticCurveTo(-6, -10 + Math.sin(t * 9 + r.id) * 3, -14, -9 + Math.sin(t * 9 + r.id + 1) * 4);
  ctx.lineTo(-12, -5 + Math.sin(t * 9 + r.id + 1) * 4); ctx.quadraticCurveTo(-4, -5, 3, 2); ctx.closePath(); ctx.fill(); ctx.stroke();
  // body
  ctx.lineWidth = lw;
  const g = ctx.createLinearGradient(0, -8, 0, 8); g.addColorStop(0, C.roachHi); g.addColorStop(1, C.roach);
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(-3, 0, 13, 8.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(40,15,5,0.6)'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-15, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-6, -7); ctx.quadraticCurveTo(-9, -2, -8, 0); ctx.stroke();
  ctx.fillStyle = 'rgba(255,240,220,0.35)'; ctx.beginPath(); ctx.ellipse(-2, -4, 6, 2, -0.2, 0, Math.PI * 2); ctx.fill();
  // scarf band
  ctx.fillStyle = `hsl(${hue} 75% 56%)`; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.roundRect(5, -7.5, 4.5, 15, 2); ctx.fill(); ctx.stroke();
  // head (lunges when biting)
  const lunge = r.biteT > 0 ? Math.sin(Math.min(1, r.biteT) * Math.PI) * 5 : 0;
  ctx.save(); ctx.translate(lunge, 0);
  // antennae
  ctx.strokeStyle = C.ink; ctx.lineWidth = 1.6;
  for (const side of [-1, 1]) {
    const w = Math.sin(t * 5 + r.id + side) * 3;
    ctx.beginPath(); ctx.moveTo(15, side * 2.5); ctx.quadraticCurveTo(26, side * (6 + w), 31, side * (14 + w * 1.5)); ctx.stroke();
  }
  // mandibles
  const open = r.biteT > 0 ? Math.sin(r.biteT * Math.PI * 2) * 0.6 : 0.1;
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(17, side * 2); ctx.lineTo(21, side * (2 + open * 5)); ctx.stroke(); }
  ctx.fillStyle = C.roachDark; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.ellipse(13.5, 0, 6.5, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // googly eyes
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#fff'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(15, side * 3.6, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (r.stunned) {
      ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(13.5, side * 3.6 - 1.5); ctx.lineTo(16.5, side * 3.6 + 1.5); ctx.moveTo(16.5, side * 3.6 - 1.5); ctx.lineTo(13.5, side * 3.6 + 1.5); ctx.stroke();
    } else {
      const jig = Math.sin(t * 7 + r.id * 3 + side) * 0.7;
      ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(16.3 + jig * 0.3, side * 3.6 + jig, 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (r.crown) {
    ctx.fillStyle = C.zap; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(9, -5); ctx.lineTo(9, 5); ctx.lineTo(5, 4); ctx.lineTo(7, 1.5); ctx.lineTo(4, 0); ctx.lineTo(7, -1.5); ctx.lineTo(5, -4); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  ctx.restore();

  if (r.stunned) { // dizzy stars
    for (let k = 0; k < 3; k++) {
      const a = t * 4 + k * 2.1;
      star(ctx, r.x + Math.cos(a) * 18 * s, r.y - 10 + Math.sin(a) * 7 * s, 4, C.zap);
    }
  }
}

function star(ctx, x, y, r, fill) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.stroke();
}

// ---------------------------------------------------------------- hazards
// The Chappal: a classic blue-strapped hawai slipper. Top-down.
export function drawChappal(ctx, x, y, r, phase, alpha) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(-0.35);
  const sc = r / 95 * (1 + Math.max(0, 1 - phase) * 0.9); ctx.scale(sc, sc);
  ctx.translate(0, -(1 - Math.min(1, phase)) * 60);
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(10, 70, 60, 120, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4f1e8'; ctx.strokeStyle = C.ink; ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, -125); ctx.bezierCurveTo(60, -125, 62, -40, 50, 10); ctx.bezierCurveTo(42, 60, 58, 120, 0, 125);
  ctx.bezierCurveTo(-58, 120, -48, 60, -46, 10); ctx.bezierCurveTo(-60, -40, -60, -125, 0, -125); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#e6e0d0'; ctx.beginPath(); ctx.ellipse(0, -70, 30, 40, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#2f6fd6'; ctx.lineWidth = 16; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-44, -10); ctx.quadraticCurveTo(-10, -50, 0, -85); ctx.quadraticCurveTo(10, -50, 44, -10); ctx.stroke();
  ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = '#2f6fd6'; ctx.beginPath(); ctx.arc(0, -85, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

export function drawChappalWarning(ctx, c, now, t) {
  const left = Math.max(0, c.at - now), p = 1 - left / c.total;
  ctx.save();
  ctx.fillStyle = `rgba(30,20,10,${0.12 + p * 0.3})`; ctx.beginPath(); ctx.arc(c.x, c.y, c.r * (0.5 + p * 0.5), 0, Math.PI * 2); ctx.fill();
  ctx.setLineDash([10, 8]); ctx.lineDashOffset = -t * 40; ctx.lineWidth = 4; ctx.strokeStyle = C.danger;
  ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  label(ctx, c.x, c.y - c.r - 14, 'CHAPPAL INCOMING', C.danger, '#fff', 13);
  ctx.restore();
}

// Jumla power-ups: each kind gets its own shiny bait. Labels come from shared/content.js.
export function drawJumla(ctx, j, t) {
  const def = (window.CONTENT.JUMLAS[j.kind]) || window.CONTENT.JUMLAS.cannon;
  const bob = Math.sin(t * 3 + j.id) * 5;
  ctx.save(); ctx.translate(j.x, j.y + bob);
  const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 60); glow.addColorStop(0, 'rgba(255,230,120,0.75)'); glow.addColorStop(1, 'rgba(255,230,120,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(Math.sin(t * 2 + j.id) * 0.12);
  ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineJoin = 'round';
  switch (j.kind) {
    case 'bullet': { // a sleek train nose
      ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.moveTo(-26, -12); ctx.lineTo(14, -12); ctx.quadraticCurveTo(34, -10, 34, 6); ctx.lineTo(-26, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2f6fd6'; ctx.fillRect(-24, -2, 50, 4);
      ctx.fillStyle = '#9fd8ff'; ctx.beginPath(); ctx.moveTo(14, -9); ctx.quadraticCurveTo(26, -8, 28, -1); ctx.lineTo(14, -1); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.ink; for (const x of [-16, 4]) { ctx.beginPath(); ctx.arc(x, 9, 4, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'wifi': {
      ctx.lineCap = 'round';
      for (const r of [8, 17, 26]) { ctx.lineWidth = 9; ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.arc(0, 12, r, -Math.PI * 0.78, -Math.PI * 0.22); ctx.stroke(); ctx.lineWidth = 5; ctx.strokeStyle = '#3ccf6e'; ctx.stroke(); }
      ctx.fillStyle = '#3ccf6e'; ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 12, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      break;
    }
    case 'notes': { // a fat stack of cash
      for (let k = 2; k >= 0; k--) { ctx.fillStyle = k ? '#c8e6a0' : '#a8d77a'; ctx.beginPath(); ctx.roundRect(-26 + k * 3, -14 - k * 4, 52, 28, 4); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = C.ink; ctx.font = '800 18px "Bricolage Grotesque", system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('₹', 0, 0);
      break;
    }
    case 'smart': { // a gleaming skyline
      ctx.fillStyle = '#d7f0ff';
      for (const [x, w, h] of [[-26, 12, 24], [-13, 14, 38], [2, 10, 30], [13, 14, 44]]) { ctx.beginPath(); ctx.rect(x, 14 - h, w, h); ctx.fill(); ctx.stroke(); }
      star(ctx, 20, -36, 7, C.zap);
      break;
    }
    case 'cylinder': {
      ctx.fillStyle = '#e3262f'; ctx.beginPath(); ctx.roundRect(-14, -18, 28, 38, 12); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#aaa'; ctx.beginPath(); ctx.roundRect(-6, -26, 12, 9, 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillRect(-14, -2, 28, 5);
      break;
    }
    case 'achhe': { // a loading bar that will never finish
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(-30, -10, 60, 20, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ff9933'; ctx.beginPath(); ctx.roundRect(-27, -7, 54 * (0.85 + Math.sin(t * 2) * 0.13), 14, 7); ctx.fill();
      break;
    }
    default: star(ctx, 0, 0, 22, C.zap);
  }
  ctx.restore();
  label(ctx, j.x, j.y - 46 + bob, def.label, C.zap, C.ink, 12);
  ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(27,22,17,0.8)'; ctx.lineWidth = 3; ctx.font = '700 11px "Bricolage Grotesque", system-ui'; ctx.textAlign = 'center';
  ctx.strokeText(def.sub, j.x, j.y + 44 + bob); ctx.fillText(def.sub, j.x, j.y + 44 + bob); ctx.restore();
}

// Smart City: a cardboard lotus on a stick. Looks great from far away.
export function drawCutout(ctx, c, t) {
  ctx.save(); ctx.translate(c.x, c.y);
  ctx.fillStyle = 'rgba(20,60,55,0.25)'; ctx.beginPath(); ctx.ellipse(10, 14, 90, 70, 0, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(Math.sin(t * 1.5) * 0.03);
  ctx.fillStyle = '#c9a36b'; ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
  for (let i = 0; i < 8; i++) { ctx.save(); ctx.rotate(i / 8 * Math.PI * 2); petalPath(ctx, 80, 28); ctx.fill(); ctx.stroke(); ctx.restore(); }
  ctx.fillStyle = '#ff7aa7'; for (let i = 0; i < 8; i++) { ctx.save(); ctx.rotate(i / 8 * Math.PI * 2 + 0.2); petalPath(ctx, 46, 14); ctx.fill(); ctx.restore(); }
  ctx.fillStyle = '#b48a52'; ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
  label(ctx, c.x, c.y + 92, 'SMART CITY · PHASE 1 (CARDBOARD)', C.paper, C.ink, 11);
}

// Speech bubble over a cockroach that fell for a Jumla (Wi-Fi OTP, Bullet Train board…).
export function drawBubble(ctx, x, y, text) {
  label(ctx, x, y, text, '#fff', C.ink, 11);
}

export function drawPin(ctx, x, y, t, text, sub, decoy) {
  const bob = Math.sin(t * 4) * 4;
  ctx.save();
  ctx.strokeStyle = decoy ? '#e8e2d2' : C.zap; ctx.lineWidth = 4; ctx.globalAlpha = 0.6 + Math.sin(t * 6) * 0.3;
  ctx.beginPath(); ctx.arc(x, y, 34 + (t * 40 % 30), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.translate(x, y - 30 + bob);
  ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 30); ctx.lineTo(0, -22); ctx.stroke();
  ctx.fillStyle = decoy ? '#f2efe6' : C.zap; ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(30, -14 + Math.sin(t * 8) * 2); ctx.lineTo(0, -4); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  label(ctx, x, y - 68 + bob, text, decoy ? '#f2efe6' : C.zap, C.ink, 12);
  if (sub) { ctx.save(); ctx.font = '600 10px "Bricolage Grotesque", system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(sub, x, y - 86 + bob); ctx.restore(); }
}

export function label(ctx, x, y, text, bg, fg, size = 12) {
  ctx.save(); ctx.font = `800 ${size}px "Bricolage Grotesque", system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 14, h = size + 9;
  ctx.fillStyle = bg; ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = fg; ctx.fillText(text, x, y + 1); ctx.restore();
}

// ---------------------------------------------------------------- particles
export class Particles {
  constructor() { this.list = []; }
  add(p) { if (this.list.length > 700) this.list.shift(); this.list.push(p); }
  crumbs(x, y, n, colors) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 180;
      this.add({ type: 'crumb', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.4, age: 0, r: 2 + Math.random() * 3.5, c: colors[k % colors.length], rot: Math.random() * 6 });
    }
  }
  shards(x, y, ang, n, color) {
    for (let k = 0; k < n; k++) {
      const a = ang + (Math.random() - 0.5) * 1.8, v = 120 + Math.random() * 420;
      this.add({ type: 'shard', x: x + (Math.random() - 0.5) * 60, y: y + (Math.random() - 0.5) * 60, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.2 + Math.random() * 0.9, age: 0, r: 8 + Math.random() * 16, c: color, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10 });
    }
  }
  ring(x, y, r, c, life = 0.6, w = 4) { this.add({ type: 'ring', x, y, r, c, life, age: 0, w }); }
  ripple(x, y) { this.add({ type: 'ripple', x, y, r: 6, life: 1.1, age: 0 }); }
  text(x, y, s, c, size = 16) { this.add({ type: 'text', x, y, vy: -60, s, c, size, life: 0.9, age: 0 }); }
  sparkle(x, y, n) {
    for (let k = 0; k < n; k++) { const a = Math.random() * 6.28, v = 40 + Math.random() * 300; this.add({ type: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 + Math.random(), age: 0, r: 3 + Math.random() * 4 }); }
  }

  update(dt) {
    for (const p of this.list) {
      p.age += dt;
      if (p.vx !== undefined) { p.x += p.vx * dt; p.y += (p.vy || 0) * dt; const drag = p.type === 'shard' ? 1.6 : 4; p.vx *= Math.exp(-drag * dt); if (p.type !== 'text') p.vy *= Math.exp(-drag * dt); }
      else if (p.vy) p.y += p.vy * dt;
      if (p.vr) p.rot += p.vr * dt;
    }
    this.list = this.list.filter(p => p.age < p.life);
  }

  draw(ctx, layer) {
    for (const p of this.list) {
      const k = p.age / p.life;
      if (layer === 'water' ? p.type !== 'ripple' : p.type === 'ripple') continue;
      ctx.globalAlpha = Math.max(0, 1 - k);
      if (p.type === 'crumb') { ctx.fillStyle = p.c; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.r, -p.r * 0.6, p.r * 2, p.r * 1.2); ctx.restore(); }
      else if (p.type === 'shard') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
        petalPath(ctx, p.r * 2, p.r * 0.7); ctx.fill(); ctx.stroke(); ctx.restore();
      }
      else if (p.type === 'ring') { ctx.strokeStyle = p.c; ctx.lineWidth = p.w * (1 - k); ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.3 + k), 0, Math.PI * 2); ctx.stroke(); }
      else if (p.type === 'ripple') { ctx.globalAlpha = 0.35 * (1 - k); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r + k * 22, (p.r + k * 22) * 0.7, 0, 0, Math.PI * 2); ctx.stroke(); }
      else if (p.type === 'spark') star(ctx, p.x, p.y, p.r * (1 - k * 0.5), C.zap);
      else if (p.type === 'text') {
        ctx.font = `800 ${p.size}px "Bricolage Grotesque", system-ui`; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = C.ink;
        ctx.strokeText(p.s, p.x, p.y); ctx.fillStyle = p.c; ctx.fillText(p.s, p.x, p.y);
      }
    }
    ctx.globalAlpha = 1;
  }
}

// The detention pod: a police van and bamboo barricades on the shore. Cockroaches who
// arrive while the server is full are "preventively detained" here until a slot opens.
// `n` is how many are held; `self` is the local player's roach when they are inside.
export function drawDetentionPod(ctx, pod, n, t, self) {
  const { x, y, r } = pod;
  ctx.save(); ctx.translate(x, y);
  // compound ground
  ctx.fillStyle = '#d9c48f'; ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.72, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // police van
  ctx.save(); ctx.translate(-r * 0.15, -r * 0.42);
  ctx.fillStyle = '#e6e2d6'; ctx.beginPath(); ctx.roundRect(-70, -26, 140, 52, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#2f5aa8'; ctx.fillRect(-70, -4, 140, 9);
  ctx.fillStyle = '#9fd8ff'; ctx.beginPath(); ctx.roundRect(40, -20, 24, 16, 3); ctx.fill(); ctx.stroke();
  const blink = Math.sin(t * 8) > 0;
  ctx.fillStyle = blink ? '#e3262f' : '#2f6fd6'; ctx.beginPath(); ctx.roundRect(-14, -36, 12, 10, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = blink ? '#2f6fd6' : '#e3262f'; ctx.beginPath(); ctx.roundRect(2, -36, 12, 10, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.font = '800 11px "Bricolage Grotesque", system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('POLICE', -12, -14);
  for (const wx of [-44, 44]) { ctx.beginPath(); ctx.arc(wx, 27, 9, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  // detained cockroaches milling about (drawn, not simulated: they cost no bandwidth)
  const shown = Math.min(n, 28);
  for (let i = 0; i < shown; i++) {
    const ph = i * 2.399, rr = (0.18 + (i % 7) / 9) * r * 0.75;
    const px = Math.cos(ph + t * 0.25 * (i % 2 ? 1 : -1)) * rr, py = Math.sin(ph + t * 0.25 * (i % 2 ? 1 : -1)) * rr * 0.55 + r * 0.12;
    drawRoach(ctx, { id: i, x: px, y: py, a: ph + t * 0.25 + Math.PI / 2, size: 0.62, walk: t * 8 + i, biteT: 0, hue: (i * 47) % 360, flying: false, stunned: false }, t);
  }
  if (self) drawRoach(ctx, { ...self, x: self.x - x, y: self.y - y }, t);
  // bamboo barricade ring
  ctx.strokeStyle = '#a07b3f'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  for (let k = 0; k < 22; k++) {
    const a = k / 22 * Math.PI * 2, bx = Math.cos(a) * r, by = Math.sin(a) * r * 0.72;
    ctx.beginPath(); ctx.moveTo(bx, by + 8); ctx.lineTo(bx, by - 18); ctx.stroke();
  }
  ctx.lineWidth = 4; ctx.strokeStyle = '#c99a5b';
  ctx.beginPath(); ctx.ellipse(0, -6, r, r * 0.72, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#e3262f'; ctx.setLineDash([10, 10]); ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(0, -12, r, r * 0.72, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  label(ctx, x, y + r * 0.72 + 26, `${window.CONTENT.DETENTION.sign} · ${n.toLocaleString('en-IN')} held`, '#2f5aa8', '#fff', 13);
}
