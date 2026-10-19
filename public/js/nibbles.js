// Nibbles: a visible tooth mark for EVERY bite, yours and everyone else's.
//
// The lotus drawing (render.js → LotusArt) only changes when a petal loses a sizeable
// chunk of health, which on a crowd-scaled petal can take a dozen bites. Nibbles fill
// that gap: each bite stamps a small crescent of teeth marks exactly where the mouth
// was, so even one cockroach can watch its petal get chewed. Purely cosmetic and local:
// no network cost. Marks fade away as the petal regenerates and vanish when it falls.
import { C } from './render.js';
const R = window.RULES;

const CAP = 70;              // max marks kept per petal (oldest go first)

export class Nibbles {
  constructor() {
    this.parts = R.PARTS.map(() => []);     // per part: [{nx, ny, a, s, born, shade}]
    this.lastFrac = R.PARTS.map(() => 0);
    this.flash = R.PARTS.map(() => -1e9);   // time of the last hit, for the white flash
  }

  /** Stamp a mark at world position (x, y), from a cockroach facing angle `a`. */
  add(part, x, y, a, growth, nowP) {
    this.flash[part] = nowP;
    const Rw = R.radius(growth);
    const list = this.parts[part];
    // Spread marks in a fan ahead of the mouth so a cockroach chewing in place
    // doesn't hide its own work under its head.
    const fan = (Math.random() - 0.5) * 1.6, reach = 10 + Math.random() * 16;
    x += Math.cos(a + fan) * reach; y += Math.sin(a + fan) * reach;
    if (R.biteTarget(x, y, growth, (i) => i === part, true, true, 2) !== part) return;   // keep marks on the petal
    list.push({ nx: (x - R.LOTUS.x) / Rw, ny: (y - R.LOTUS.y) / Rw, a: a + fan * 0.5 + (Math.random() - 0.5) * 0.5,
      s: 0.85 + Math.random() * 0.35, born: nowP, shade: Math.random() });
    if (list.length > CAP) list.shift();
  }

  clear(part) { this.parts[part].length = 0; }
  clearAll() { this.parts.forEach(l => (l.length = 0)); }

  /**
   * Keeps marks in step with the server's health: when a petal regenerates, the
   * oldest marks heal over in proportion; when it dies or regrows, they all go.
   */
  sync(fracs, alive) {
    for (let i = 0; i < fracs.length; i++) {
      const f = alive[i] ? fracs[i] : 0, last = this.lastFrac[i];
      if (!alive[i]) this.parts[i].length = 0;
      else if (f < last - 0.004 && last > 0) {
        const heal = Math.ceil(this.parts[i].length * (1 - f / last));
        this.parts[i].splice(0, heal);
      }
      this.lastFrac[i] = f;
    }
  }

  /** `partPath(ctx, i, growth)` traces a petal's outline; marks are clipped to it. */
  draw(ctx, partPath, growth, nowP, gold) {
    const Rw = R.radius(growth), k = growth / 1.0;
    // Exposed petal flesh is pale cream with a dark bruised rim, so marks read clearly on pink.
    const rim = gold ? '#8a5200' : '#8e1d4a', flesh = gold ? '#fff4cf' : '#fff3e2', pit = gold ? '#e8b64a' : '#f3a9bf';
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < this.parts.length; i++) {
      const list = this.parts[i];
      if (!list.length) continue;
      ctx.save(); partPath(ctx, i, growth); ctx.clip();     // bites can't hang off the petal
      for (const n of list) {
        const age = (nowP - n.born) / 1000;
        const pop = age < 0.14 ? 1 + (1 - age / 0.14) * 0.6 : 1;      // marks punch in, then settle
        const x = R.LOTUS.x + n.nx * Rw, y = R.LOTUS.y + n.ny * Rw;
        const sz = 9.5 * n.s * k * pop;
        ctx.save(); ctx.translate(x, y); ctx.rotate(n.a);
        // a crescent of four teeth facing the biter, like a bite out of a cracker
        ctx.fillStyle = flesh;
        ctx.beginPath(); ctx.ellipse(0, 0, sz * 0.9, sz * 1.25, 0, -Math.PI / 2, Math.PI / 2); ctx.fill();
        ctx.fillStyle = pit;
        for (let t = 0; t < 4; t++) {
          const ang = -0.95 + t * 0.63;
          ctx.beginPath(); ctx.arc(Math.cos(ang) * sz * 0.72, Math.sin(ang) * sz * 1.02, sz * 0.26, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = rim; ctx.lineWidth = Math.max(1.5, sz * 0.24);
        ctx.beginPath(); ctx.ellipse(0, 0, sz * 0.9, sz * 1.25, 0, -Math.PI / 2, Math.PI / 2); ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** A quick white flash over the petal that was just bitten. */
  drawFlash(ctx, partPath, growth, nowP) {
    for (let i = 0; i < this.flash.length; i++) {
      const age = (nowP - this.flash[i]) / 1000;
      if (age > 0.16) continue;
      ctx.save(); partPath(ctx, i, growth);
      ctx.fillStyle = `rgba(255,255,255,${0.32 * (1 - age / 0.16)})`; ctx.fill(); ctx.restore();
    }
  }
}

export { C };
