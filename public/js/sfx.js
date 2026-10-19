// Tiny synthesized sound effects. No audio files.
let ac = null, master = null, muted = false;
try { muted = localStorage.getItem('uprising.muted') === '1'; } catch {}

function ctx() {
  if (!ac) {
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return null;
    ac = new A(); master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
let noiseBuf = null;
function noise(a) {
  if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const s = a.createBufferSource(); s.buffer = noiseBuf; return s;
}
function env(a, g, t, attack, peak, decay) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay); }
function tone(type, f0, f1, dur, vol, delay = 0) {
  const a = ctx(); if (!a || muted) return; const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  env(a, g, t, 0.005, vol, dur); o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
}
function crunch(vol, freq, dur, delay = 0) {
  const a = ctx(); if (!a || muted) return; const t = a.currentTime + delay;
  const n = noise(a), f = a.createBiquadFilter(), g = a.createGain();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
  env(a, g, t, 0.003, vol, dur); n.connect(f).connect(g).connect(master); n.start(t, Math.random() * 0.3); n.stop(t + dur + 0.05);
}

// Optional custom Jumla sound: drop a short clip at public/sfx/jumla.mp3 and it replaces
// the built-in sad trombone. Loaded once, after the player's first tap (browsers
// only allow audio after a user gesture). If the file is missing, nothing breaks.
let jumlaClip = null, jumlaTried = false;
async function loadJumlaClip() {
  if (jumlaTried) return; jumlaTried = true;
  try {
    const res = await fetch('/sfx/jumla.mp3');
    if (!res.ok) return;
    const a = ctx(); if (!a) return;
    jumlaClip = await a.decodeAudioData(await res.arrayBuffer());
  } catch { jumlaClip = null; }
}

export const sfx = {
  unlock() { ctx(); loadJumlaClip(); },
  /** A Jumla backfired. volume: 1 for you, quieter for someone nearby. */
  jumla(volume = 1) {
    const a = ctx(); if (!a || muted) return;
    if (jumlaClip) {
      const src = a.createBufferSource(), g = a.createGain();
      src.buffer = jumlaClip; g.gain.value = volume;
      src.connect(g).connect(master); src.start();
      return;
    }
    // Built-in: a sad trombone, "wah wah wah waaaah".
    const notes = [[311, 0.0, 0.28], [294, 0.3, 0.28], [277, 0.6, 0.28], [262, 0.9, 0.9]];
    for (const [f, at, dur] of notes) {
      const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain(), lp = a.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f, t);
      if (dur > 0.5) {                                   // wobble on the last, long note
        const lfo = a.createOscillator(), lg = a.createGain();
        lfo.frequency.value = 6; lg.gain.value = 9; lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + dur);
      }
      lp.type = 'lowpass'; lp.frequency.value = 1100;
      env(a, g, t, 0.03, 0.16 * volume, dur);
      o.connect(lp).connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
    }
  },
  get muted() { return muted; },
  toggle() { muted = !muted; try { localStorage.setItem('uprising.muted', muted ? '1' : '0'); } catch {} return muted; },
  bite(power = 1) { const p = 0.85 + Math.random() * 0.3; crunch(0.5, 1800 * p, 0.07); crunch(0.35, 3200 * p, 0.04, 0.03); tone('square', 180 * p, 70, 0.06, 0.12 * power); },
  shielded() { tone('sine', 900, 1200, 0.08, 0.15); tone('sine', 1300, 1500, 0.08, 0.1, 0.05); },
  petalDown() { crunch(0.8, 900, 0.35); tone('sawtooth', 300, 60, 0.5, 0.18); [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.18, 0.18, 0.12 + i * 0.07)); },
  bloomDown() { crunch(1, 500, 0.8); [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone('triangle', f, f * 1.01, 0.3, 0.2, i * 0.11)); },
  levelUp() { [440, 554, 659, 880].forEach((f, i) => tone('square', f, f, 0.1, 0.08, i * 0.07)); },
  stomp() { tone('sine', 120, 35, 0.35, 0.6); crunch(0.6, 300, 0.2); },
  warn() { tone('square', 660, 640, 0.07, 0.06); tone('square', 660, 640, 0.07, 0.06, 0.14); },
  boing() { tone('sine', 200, 900, 0.35, 0.25); tone('sine', 900, 150, 0.3, 0.2, 0.3); },
  dash() { crunch(0.25, 4000, 0.12); },
  fly() { tone('sawtooth', 90, 140, 0.4, 0.06); },
  rally() { [784, 988, 784, 1175].forEach((f, i) => tone('square', f, f, 0.07, 0.07, i * 0.08)); },
  ding() { tone('triangle', 1046, 1046, 0.15, 0.12); tone('triangle', 1568, 1568, 0.2, 0.1, 0.08); },
  news() { tone('sawtooth', 220, 220, 0.12, 0.06); tone('sawtooth', 165, 165, 0.2, 0.06, 0.12); },
};
