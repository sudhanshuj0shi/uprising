// DOM HUD: lotus health, petal pips, leaderboard, player card, abilities, toasts, banners.
const R = window.RULES;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('en-IN');

export const hud = {
  init(input) {
    const petals = $('petals');
    // Order the pips like the lotus reads: outer petals, inner petals, core.
    R.PARTS.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'pip' + (p.kind === 'i' ? ' inner' : p.kind === 'c' ? ' core' : '');
      el.title = p.kind === 'c' ? 'Seed core' : p.kind === 'i' ? `Inner petal ${p.idx + 1} (needs wings)` : `Petal ${p.idx + 1}`;
      el.innerHTML = '<i></i>'; el.dataset.part = i;
      petals.appendChild(el);
    });
    this.pips = [...petals.children];
    for (const el of document.querySelectorAll('#abilities .ab')) input.bindButton(el, el.dataset.ab);
    const board = $('board');
    try { if (localStorage.getItem('uprising.board') === 'closed') board.classList.add('collapsed'); } catch {}
    $('boardToggle').onclick = () => {
      if (matchMedia('(max-width: 720px)').matches) board.classList.toggle('open');
      else { board.classList.toggle('collapsed'); try { localStorage.setItem('uprising.board', board.classList.contains('collapsed') ? 'closed' : 'open'); } catch {} }
    };
  },

  lotus(state, now) {
    const { frac, alive, shield, rally, coreOpen, health, gen, name, gold } = state;
    $('bloomGen').textContent = `BLOOM #${gen}`;
    $('bloomName').textContent = name;
    $('hpFill').style.width = (health * 100).toFixed(1) + '%';
    document.querySelector('#hud .bloom').classList.toggle('gold', gold);
    this.pips.forEach((el, i) => {
      el.firstChild.style.height = alive[i] ? ((1 - frac[i]) * 100).toFixed(0) + '%' : '0%';
      el.classList.toggle('down', !alive[i]);
      el.classList.toggle('shield', !!shield[i]);
      el.classList.toggle('rally', rally === i);
      if (i === R.CORE) el.classList.toggle('locked', !coreOpen && alive[i]);
    });
  },
  /** Live counts: this room and the whole country. */
  stats(roomOnline, roomMax, nationOnline) {
    $('online').textContent = fmt(roomOnline); $('roomMax').textContent = roomMax; $('nationOnline').textContent = fmt(Math.max(nationOnline, roomOnline));
  },
  room(id) { $('roomId').textContent = String(id).toUpperCase(); },
  /** National scoreboard line under the room leaderboard. */
  national(n) {
    if (!n) return;
    $('nationLine').textContent = `Across India: ${fmt(n.blooms)} lotus${n.blooms === 1 ? '' : 'es'} toppled · ${fmt(n.total)} cockroaches joined`;
  },
  queue(pos, line) { $('queue').hidden = !pos; document.body.classList.toggle('is-detained', !!pos); if (pos) { $('queuePos').textContent = '#' + fmt(pos); if (line) $('queueLine').textContent = line; } },

  leaderboard(rows, myName) {
    const ol = $('lb');
    if (!rows || !rows.length) { ol.innerHTML = '<li class="empty">Nobody has bitten this bloom yet.</li>'; return; }
    ol.innerHTML = rows.map(r => `<li class="${r.name === myName ? 'me' : ''}"><span class="sw" style="background:hsl(${Number(r.hue) | 0} 75% 56%)"></span><span class="nm">${esc(r.name)}</span><span class="dm">${fmt(r.dmg)}</span></li>`).join('');
  },

  me(p) {
    $('lvl').textContent = p.level;
    $('meName').textContent = p.name;
    $('meTitle').textContent = p.title;
    const span = p.next ? p.next - p.prev : 1, into = p.next ? p.xp - p.prev : 1;
    $('xpFill').style.width = Math.min(100, into / span * 100).toFixed(1) + '%';
    $('me').title = `${fmt(p.xp)} XP` + (p.next ? ` · ${fmt(p.next - p.xp)} to level ${p.level + 1}` : '');
  },

  abilities(s) {
    const set = (id, locked, cd, active) => {
      const el = $(id); el.classList.toggle('locked', locked); el.classList.toggle('active', !!active);
      el.querySelector('.cd') && el.querySelector('.cd').style.setProperty('--cd', Math.max(0, Math.min(1, cd)).toFixed(3));
    };
    set('abDash', false, s.dashCd, s.dashing);
    set('abFly', !s.wings, s.flyCd, s.flying);
    set('abRally', !s.rally, s.rallyCd, false);
    $('abBite').classList.toggle('ready', s.biteReady);
  },

  swarm(mult) {
    const el = $('swarm');
    if (mult <= 1.01) { el.hidden = true; return; }
    el.hidden = false; $('swarmMult').textContent = '×' + mult.toFixed(1);
  },

  toast(html, cls = '', life = 3.2) {
    const box = $('toasts');
    const el = document.createElement('div'); el.className = 'toast ' + cls; el.innerHTML = html; el.style.setProperty('--life', life + 's');
    box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => el.remove(), (life + 0.5) * 1000);
  },
  achievement(a) { this.toast(`<span class="medal">★</span><span>${esc(a.name)}<small>${esc(a.desc)}</small></span>`, 'ach', 4.5); },

  banner(big, sub, opts = {}) {
    const el = $('banner'); clearTimeout(this._bt);
    el.innerHTML = `<div class="big ${opts.gold ? 'gold' : ''}">${big}</div>` + (sub ? `<br><div class="sub">${sub}</div>` : '') + (opts.extra || '');
    el.hidden = false;
    if (opts.onShare) { const b = el.querySelector('[data-share]'); if (b) b.onclick = opts.onShare; }
    this._bt = setTimeout(() => el.hidden = true, (opts.life || 3.6) * 1000);
  },

  ticker(text, ms, onShare) {
    const el = $('ticker'); $('tickerText').textContent = text; el.hidden = false;
    $('tickerShare').onclick = onShare || null; $('tickerShare').hidden = !onShare;
    clearTimeout(this._tt); this._tt = setTimeout(() => el.hidden = true, ms);
  },

  hint(html) {
    const el = $('hint');
    if (!html) { el.hidden = true; this._hint = null; return; }
    if (this._hint !== html) { el.innerHTML = html; this._hint = html; }
    el.hidden = false;
  },

  away(a) {
    const items = [];
    if (a.blooms > 0) items.push(`${fmt(a.blooms)} lotus${a.blooms > 1 ? 'es' : ''} toppled across India`);
    if (a.petals > 0) items.push(`${fmt(a.petals)} petal${a.petals > 1 ? 's' : ''} chewed off`);
    if (a.newPlayers > 0) items.push(`${fmt(a.newPlayers)} new cockroach${a.newPlayers > 1 ? 'es' : ''} joined`);
    if (!items.length) items.push('The lotus grew. Quietly. Smugly.');
    const el = document.createElement('div'); el.className = 'away card';
    el.innerHTML = `<h4>While you were away · ${esc(awayStr(a.ms))}</h4><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
    $('hud').appendChild(el);
    setTimeout(() => el.remove(), 9000);
  },

  conn(down) { $('conn').hidden = !down; },
  esc, fmt,
};

function awayStr(ms) {
  const m = Math.round(ms / 60000); if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60); if (h < 48) return `${h} hours`; return `${Math.round(h / 24)} days`;
}
