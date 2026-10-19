// Shareable "Breaking News" cards.
//
// Every headline the Godi Media Megaphone fires can be turned into a 1200×630 image
// (the size social networks preview best) and shared through the phone's share sheet,
// downloaded, or copied as text. Cards are drawn locally on a canvas — no server work,
// no extra bandwidth.
import { C, drawRoach, petalPath } from './render.js';
import { hud } from './hud.js';
const CONTENT = window.CONTENT;

const W = 1200, H = 630;
const FONT = '"Bricolage Grotesque", system-ui, sans-serif';

/** Draws the card and resolves a PNG Blob. */
export async function renderCard(headline, stats) {
  try { await document.fonts.ready; } catch { /* fonts optional */ }
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // studio backdrop
  g.fillStyle = '#16233f'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 14; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.06)'; g.fillRect(i * 90 - 40, 0, 50, H); }

  // channel bug
  g.fillStyle = '#e3262f'; g.strokeStyle = C.ink; g.lineWidth = 5;
  roundRect(g, 40, 34, 300, 74, 10); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.font = `800 44px ${FONT}`; g.textBaseline = 'middle'; g.fillText(CONTENT.CHANNEL.name, 58, 73);
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = `600 20px ${FONT}`; g.fillText(CONTENT.CHANNEL.slogan, 360, 73);

  // LIVE pill
  g.fillStyle = '#fff'; roundRect(g, W - 168, 46, 128, 50, 25); g.fill();
  g.fillStyle = '#e3262f'; g.beginPath(); g.arc(W - 136, 71, 10, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.ink; g.font = `800 26px ${FONT}`; g.fillText('LIVE', W - 116, 72);

  // BREAKING NEWS slab
  g.save(); g.translate(40, 150); g.rotate(-0.025);
  g.fillStyle = C.zap; g.strokeStyle = C.ink; g.lineWidth = 5;
  roundRect(g, 0, 0, 520, 78, 8); g.fill(); g.stroke();
  g.fillStyle = C.ink; g.font = `800 52px ${FONT}`; g.fillText('BREAKING NEWS', 22, 42);
  g.restore();

  // headline panel
  g.fillStyle = '#fbf3e4'; g.strokeStyle = C.ink; g.lineWidth = 5;
  roundRect(g, 40, 252, 790, 266, 14); g.fill(); g.stroke();
  fitText(g, headline, 70, 282, 730, 206, 64, 30);

  // illustration: a cockroach chewing a petal
  g.save(); g.translate(1000, 390);
  g.rotate(-0.5);
  const grad = g.createLinearGradient(-30, 0, 200, 0); grad.addColorStop(0, '#fff0f4'); grad.addColorStop(1, '#ff4f8b');
  g.fillStyle = grad; g.strokeStyle = C.ink; g.lineWidth = 5; petalPath(g, 230, 90); g.fill(); g.stroke();
  // a bite out of the tip
  g.globalCompositeOperation = 'destination-out';
  g.beginPath(); g.arc(214, -16, 30, 0, Math.PI * 2); g.arc(228, 18, 24, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.restore();
  g.save(); g.translate(1110, 300); g.scale(3.2, 3.2);
  drawRoach(g, { id: 7, x: 0, y: 0, a: 2.4, size: 1, walk: 1, biteT: 0.3, hue: 48, flying: false, stunned: false }, 0.4);
  g.restore();

  // bottom ticker
  g.fillStyle = C.zap; g.fillRect(0, H - 86, W, 86);
  g.fillStyle = '#e3262f'; g.fillRect(0, H - 86, 210, 86);
  g.fillStyle = '#fff'; g.font = `800 30px ${FONT}`; g.fillText('UPRISING', 26, H - 43);
  g.fillStyle = C.ink; g.font = `700 24px ${FONT}`;
  const tick = [`${stats.online ? `${stats.online.toLocaleString('en-IN')} cockroaches chewing now` : 'Cockroaches chewing now'}`,
    stats.blooms ? `${stats.blooms.toLocaleString('en-IN')} lotuses toppled` : 'Lotus "fine", says lotus', 'A work of satire'].join('   •   ');
  g.fillText(tick, 236, H - 52, W - 260);
  g.font = `600 20px ${FONT}`; g.fillText(location.host, 236, H - 22);

  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

/** Opens the share sheet for a headline: preview + Share / Save / Copy. */
export async function openShare(headline, stats) {
  const text = `BREAKING: ${headline} — via UPRISING, the game where cockroaches eat the lotus. ${location.origin}`;
  const blob = await renderCard(headline, stats);
  const url = URL.createObjectURL(blob);
  const file = new File([blob], 'uprising-breaking-news.png', { type: 'image/png' });

  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="modal-card card" role="dialog" aria-modal="true" aria-label="Share this headline">
      <img alt="" class="news-preview">
      <div class="modal-actions">
        <button class="btn-primary" data-act="share">Share image</button>
        <a class="btn" data-act="save" download="uprising-breaking-news.png">Save</a>
        <button class="btn" data-act="copy">Copy text</button>
        <button class="btn btn-ghost" data-act="close" aria-label="Close">Close</button>
      </div></div>`;
  box.querySelector('img').src = url;
  box.querySelector('[data-act=save]').href = url;
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  if (!canShareFile && !navigator.share) box.querySelector('[data-act=share]').hidden = true;
  const close = () => { box.remove(); URL.revokeObjectURL(url); };
  box.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (e.target === box || act === 'close') return close();
    if (act === 'share') {
      try {
        if (canShareFile) await navigator.share({ files: [file], text });
        else await navigator.share({ title: 'UPRISING', text });
      } catch { /* the player cancelled */ }
    }
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(text); hud.toast('Headline copied. Spread the news.', 'zap', 2.2); }
      catch { hud.toast(hud.esc(text), '', 8); }
    }
  });
  document.body.appendChild(box);
}

// ---------------------------------------------------------------- canvas helpers
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

/** Wraps text into a box, shrinking the font until it fits. */
function fitText(g, text, x, y, w, h, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 2) {
    g.font = `800 ${size}px ${FONT}`;
    const lines = wrap(g, text, w), lh = size * 1.12;
    if (lines.length * lh <= h || size === minSize) {
      g.fillStyle = C.ink; g.textBaseline = 'top';
      const top = y + Math.max(0, (h - lines.length * lh) / 2);
      lines.forEach((l, i) => g.fillText(l, x, top + i * lh));
      g.textBaseline = 'middle';
      return;
    }
  }
}
function wrap(g, text, w) {
  const words = text.split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    const t = line ? `${line} ${word}` : word;
    if (g.measureText(t).width > w && line) { lines.push(line); line = word; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
