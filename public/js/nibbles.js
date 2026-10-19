// Bite feedback: every bite (yours and everyone else's) visibly eats the petal.
//
// The lotus drawing only changes shape when a petal loses a sizeable chunk of health,
// which on a crowd-scaled petal can take a dozen bites. So each bite ALSO punches a
// small ragged hole into the petal right in front of the cockroach's mouth (carved into
// the petal artwork by LotusArt, not drawn on top). Repeated bites in one spot merge into
// an eaten-through patch. Holes close up as the petal regenerates and disappear with it.
// Purely cosmetic and local: no network cost.
const R = window.RULES;

export class Nibbles {
  /** @param art the LotusArt instance that owns the petal canvases */
  constructor(art) {
    this.art = art;
    this.lastFrac = R.PARTS.map(() => 0);
    this.flash = R.PARTS.map(() => -1e9);   // time of the last hit, for a brief white flash
  }

  /** A bite landed on `part` from a cockroach at mouth position (x, y) facing angle `a`. */
  add(part, x, y, a, growth, nowP) {
    this.flash[part] = nowP;
    // Just ahead of the mandibles, with a little wobble so holes grow ragged, not round.
    const ahead = 4 + Math.random() * 5, side = (Math.random() - 0.5) * 8;
    x += Math.cos(a) * ahead - Math.sin(a) * side;
    y += Math.sin(a) * ahead + Math.cos(a) * side;
    this.art.addHole(part, x, y, growth);
  }

  clear(part) { this.art.clearHoles(part); }
  clearAll() { R.PARTS.forEach((_, i) => this.art.clearHoles(i)); }

  /** Keep holes in step with server health: regeneration heals the oldest holes. */
  sync(fracs, alive) {
    for (let i = 0; i < fracs.length; i++) {
      const f = alive[i] ? fracs[i] : 0, last = this.lastFrac[i];
      if (!alive[i]) this.art.clearHoles(i);
      else if (f < last - 0.004 && last > 0) this.art.healHoles(i, Math.ceil(this.art.holeCount(i) * (1 - f / last)));
      this.lastFrac[i] = f;
    }
  }

  /** A quick white flash over the petal that was just bitten. */
  drawFlash(ctx, partPath, growth, nowP) {
    for (let i = 0; i < this.flash.length; i++) {
      const age = (nowP - this.flash[i]) / 1000;
      if (age > 0.12) continue;
      ctx.save(); partPath(ctx, i, growth);
      ctx.fillStyle = `rgba(255,255,255,${0.22 * (1 - age / 0.12)})`; ctx.fill(); ctx.restore();
    }
  }
}
