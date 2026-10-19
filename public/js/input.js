// Input: mouse steering (roach follows the cursor), WASD/arrows, touch joystick,
// on-screen ability buttons. Produces a move vector and ability intents.
export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, active: false, down: false, lastMove: 0 };
    this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.held = { bite: false };
    this.pressed = new Set();   // one-shot intents: dash, fly, rally
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.enabled = false;

    addEventListener('keydown', (e) => {
      if (!this.enabled || e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      if (k === ' ') this.held.bite = true;
      if (k === 'shift' || k === 'e') this.pressed.add('dash');
      if (k === 'f') this.pressed.add('fly');
      if (k === 'r') this.pressed.add('rally');
    });
    addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); this.keys.delete(k); if (k === ' ') this.held.bite = false; });
    addEventListener('blur', () => { this.keys.clear(); this.held.bite = false; this.mouse.down = false; });

    addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.active = true; this.mouse.lastMove = performance.now(); });
    document.addEventListener('mouseleave', () => { this.mouse.active = false; this.mouse.down = false; });
    canvas.addEventListener('mousedown', (e) => { if (!this.enabled) return; if (e.button === 0) this.mouse.down = true; if (e.button === 2) this.pressed.add('dash'); });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.down = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch joystick: anywhere on the left 60% of the screen.
    canvas.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        if (this.joy.id === null && t.clientX < innerWidth * 0.6) { this.joy = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 }; }
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.joy.id) {
        let dx = t.clientX - this.joy.ox, dy = t.clientY - this.joy.oy; const d = Math.hypot(dx, dy), max = 60;
        if (d > max) { this.joy.ox += dx * (1 - max / d); this.joy.oy += dy * (1 - max / d); dx *= max / d; dy *= max / d; }
        this.joy.x = dx / max; this.joy.y = dy / max;
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e) => { for (const t of e.changedTouches) if (t.identifier === this.joy.id) this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 }; };
    canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);
  }

  // Bind an on-screen button. Bite is held, others are taps.
  bindButton(el, action) {
    const down = (e) => { e.preventDefault(); if (action === 'bite') this.held.bite = true; else this.pressed.add(action); el.classList.add('down'); };
    const up = () => { if (action === 'bite') this.held.bite = false; el.classList.remove('down'); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointerup', up); el.addEventListener('pointerleave', up); el.addEventListener('pointercancel', up);
  }

  take(action) { const had = this.pressed.has(action); this.pressed.delete(action); return had; }
  get biting() { return this.held.bite || this.mouse.down; }

  // Returns {mode:'dir', x, y} (unit-ish vector) or {mode:'point', sx, sy} or null.
  move() {
    let x = 0, y = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) y -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y += 1;
    if (x || y) { const d = Math.hypot(x, y); return { mode: 'dir', x: x / d, y: y / d }; }
    if (this.joy.id !== null && Math.hypot(this.joy.x, this.joy.y) > 0.15) return { mode: 'dir', x: this.joy.x, y: this.joy.y };
    if (!this.touch && this.mouse.active) return { mode: 'point', sx: this.mouse.x, sy: this.mouse.y };
    return null;
  }
}
