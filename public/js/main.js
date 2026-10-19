// UPRISING client.
//
//   - Simulates YOUR cockroach locally (instant response), sends its position ~10×/s.
//   - Smoothly interpolates everyone else from the server's binary updates.
//   - Draws the lotus, hazards and effects from server state; the server decides
//     every bite, kill and power-up, the client only animates them.
//
// Message flow: net.js → onMessage() → state below → frame() draws it every animation frame.
import { Net } from './net.js';
import { Input } from './input.js';
import { hud } from './hud.js';
import { sfx } from './sfx.js';
import { openShare } from './news.js';
import { Nibbles } from './nibbles.js';
import { C, LotusArt, Pond, Particles, drawRoach, drawChappal, drawChappalWarning, drawJumla, drawCutout, drawBubble,
  drawDetentionPod, drawPin, label, partPath, fmtDur } from './render.js';
const R = window.RULES, P = window.PROTO, CONTENT = window.CONTENT;
const VERSION = document.querySelector('meta[name="uprising-version"]')?.content;

// ---------------------------------------------------------------- state
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const input = new Input(canvas);
const lotusArt = new LotusArt();
const pond = new Pond();
const fx = new Particles();
const nibbles = new Nibbles();            // a tooth mark for every bite (see nibbles.js)
hud.init(input);

let clockOffset = 0;                       // serverTime - Date.now()
const serverNow = () => Date.now() + clockOffset;
const syncClock = (now) => { if (now) clockOffset = clockOffset ? clockOffset * 0.8 + (now - Date.now()) * 0.2 : now - Date.now(); };

// The lotus as the server last described it. `frac` = damage 0..1 per part.
const world = {
  gen: 1, name: R.bloomName(1), growth: 1, frac: R.PARTS.map(() => 0), alive: R.PARTS.map(() => true), shield: R.PARTS.map(() => false),
  rally: null, rebranded: false, fallenUntil: 0, totals: { damage: 0 }, history: [], lb: [],
  roomOnline: 0, nationOnline: 0, national: null, detained: 0,
};
const hz = { chappals: new Map(), stomps: [], jumlas: new Map(), cutouts: [], decoy: null, bubbles: new Map() };
const others = new Map();                  // session id -> remote roach
const roster = new Map();                  // session id -> {name, hue, lvl}
let me = null;                             // local roach once playing
let profile = null;
let joined = false, connected = false, detained = false;
let room = { id: null, max: 50 };
let lastShare = null, lastNews = null;
const cam = { x: R.LOTUS.x, y: R.LOTUS.y, zoom: 1, shake: 0, view: {} };
let W = 0, H = 0, DPR = 1;

// Invite links look like /r/<roomId>.
const invitedRoom = (location.pathname.match(/^\/r\/([a-z0-9]{4,12})\/?$/) || [])[1] || null;

let token = null, savedName = null;
try { token = localStorage.getItem('uprising.token'); savedName = localStorage.getItem('uprising.name'); } catch { /* private mode */ }

// ---------------------------------------------------------------- derived lotus
const frac = (i) => world.frac[i];
function downCount() { let n = 0; for (let i = 0; i < R.CORE; i++) if (!world.alive[i]) n++; return n; }
function coreOpen() { return downCount() >= R.CORE_UNLOCK; }
/** Overall health, weighting each part by its share of the lotus's total HP. */
function health() {
  let hp = 0, max = 0;
  R.PARTS.forEach((p, i) => { max += p.base; if (world.alive[i]) hp += p.base * (1 - world.frac[i]); });
  return max ? hp / max : 0;
}
function applyLotus(l) {
  world.growth = l.growth; world.frac = l.frac; world.roomOnline = l.roomOnline; world.nationOnline = l.nationOnline; world.totals.damage = l.damage;
  for (let i = 0; i < R.PARTS.length; i++) { world.alive[i] = !!(l.alive >> i & 1); world.shield[i] = !!(l.shield >> i & 1); }
  nibbles.sync(world.frac, world.alive);
}
function applyFull(w) {
  if (!w) return;
  syncClock(w.now);
  world.gen = w.gen; world.name = w.name; world.rebranded = w.rebranded; world.fallenUntil = w.fallenUntil;
  world.totals = Object.assign(world.totals, w.totals); world.history = w.history || []; world.rally = w.rally; world.bornAt = w.bornAt;
}
function applyNational(n) {
  if (!n) return;
  world.national = n; world.detained = n.detained || 0;
  hud.national(n); updateLiveLine();
}

// ---------------------------------------------------------------- networking
const net = new Net(onMessage, (status) => {
  connected = status === 'open';
  if (connected) {
    if (joined) hello(); else net.send({ t: 'watch', room: invitedRoom });
  }
  if (status === 'stopped') { document.getElementById('dozed').hidden = false; return; }
  hud.conn(!connected && joined);
  updateJoinButton();
});
net.connect();
document.getElementById('wakeBtn').onclick = () => { document.getElementById('dozed').hidden = true; me = null; others.clear(); net.resume(); };

function hello() {
  net.send({ t: 'hello', token, name: document.getElementById('nameInput')?.value.trim() || savedName,
    room: room.id || invitedRoom, hidden: document.hidden });
}
// Background tabs get no position updates (saves bandwidth); tell the server when we come back.
document.addEventListener('visibilitychange', () => net.send({ t: 'vis', hidden: document.hidden }));

function onMessage(m) {
  switch (m.t) {
    case 'bin':
      if (m.type === P.T_LOTUS) applyLotus(m.lotus);
      else onRoaches(m.type, m.rows);
      break;
    case 'watchInfo':
      checkVersion(m.v);
      enterRoom(m);
      if (m.invite) showInvite(m.invite);
      updateLiveLine();
      break;
    case 'welcome': {
      checkVersion(m.v);
      token = m.token; try { localStorage.setItem('uprising.token', token); localStorage.setItem('uprising.name', m.me.name); } catch { /* ok */ }
      enterRoom(m);
      profile = m.me;
      const first = !me;
      me = Object.assign(me || {}, {
        id: m.id, x: m.x, y: m.y, a: m.a, vx: 0, vy: 0, kx: 0, ky: 0, walk: 0, biteT: 0, name: profile.name, hue: profile.hue,
        flyUntil: 0, flyCdUntil: 0, stunUntil: 0, dashUntil: 0, dashCdUntil: 0, rallyCdUntil: 0, uturnUntil: 0, voidLeft: 0,
        lastBite: 0, lastSend: 0, lastSent: null, born: performance.now(), misses: 0,
      });
      cam.x = me.x; cam.y = me.y;
      if (detained) { detained = false; hud.queue(0); hud.banner('RELEASED', hud.esc(CONTENT.DETENTION.released), { life: 3.2 }); }
      hud.me(profile); hud.leaderboard(world.lb, profile.name);
      if (m.released) hud.toast(hud.esc(CONTENT.DETENTION.released), 'zap', 4);
      if (first) {
        if (m.isNew) hud.toast(`Welcome to the swarm, <b>${hud.esc(profile.name)}</b>. You are cockroach #${hud.fmt(profile.number)}.`, 'zap', 4.5);
        else hud.toast(`Welcome back, ${hud.esc(profile.name)}. The lotus missed you. (It did not.)`, '', 3.5);
        if (m.away) setTimeout(() => hud.away(m.away), 800);
        if (m.invite && !m.invite.got) setTimeout(() => hud.toast(`Room ${hud.esc(m.invite.id.toUpperCase())} was full, so you're in ${hud.esc(room.id.toUpperCase())}. Tap the room badge to invite friends here.`, '', 5), 1200);
      }
      break;
    }
    case 'queue':
      detained = true; applyNational(m.national);
      hud.queue(m.pos, m.queueLine);
      break;
    case 'det': world.detained = m.n; break;
    case 'nat': applyNational(m.national); break;
    case 'w': applyFull(m.w); break;
    case 'lb': world.lb = m.lb; hud.leaderboard(m.lb, profile && profile.name); break;
    case 'pj':
      if (!roster.has(m.p.id) && joined && me && m.p.id !== me.id) hud.toast(`<b>${hud.esc(m.p.name)}</b> crawled in`, '', 2.2);
      roster.set(m.p.id, m.p);
      { const o = others.get(m.p.id); if (o) Object.assign(o, { name: m.p.name, hue: m.p.hue }); }
      break;
    case 'pl': roster.delete(m.id); others.delete(m.id); break;
    case 'hit': onHit(m); break;
    case 'xp':
      if (!profile) break;
      profile.xp = m.xp;
      if (m.why && me) fx.text(me.x, me.y - 40, `+${m.add} XP · ${m.why}`, C.zap, 14);
      hud.me(profile);
      break;
    case 'ev': onEvent(m); break;
  }
}

/** A new server version was deployed while this page was open: reload to stay compatible. */
function checkVersion(v) { if (VERSION && v && v !== VERSION && VERSION !== '__V__') location.reload(); }

/** Shared by spectating and playing: load a room's world, hazards and roster. */
function enterRoom(m) {
  if (m.room && m.room.id !== room.id) { others.clear(); nibbles.clearAll(); }
  room = m.room || room;
  hud.room(room.id);
  if (joined && room.id && location.pathname !== `/r/${room.id}`) history.replaceState(null, '', `/r/${room.id}`);
  applyFull(m.world); loadHazards(m.hazards);
  roster.clear(); for (const r of m.roster || []) roster.set(r.id, r);
  world.lb = m.lb || []; hud.leaderboard(world.lb, profile && profile.name);
  applyNational(m.national);
}

function showInvite(inv) {
  const el = document.getElementById('inviteLine');
  el.hidden = false;
  el.textContent = inv.exists
    ? (inv.full ? `Room ${inv.id.toUpperCase()} is full right now. You'll join the busiest room with space.` : `You've been invited to room ${inv.id.toUpperCase()}. Join your friends.`)
    : `Room ${inv.id.toUpperCase()} has dissolved. You'll join the busiest room instead.`;
}

function loadHazards(h) {
  if (!h) return;
  hz.chappals.clear(); hz.jumlas.clear();
  const now = serverNow();
  for (const c of h.chappals || []) hz.chappals.set(c.id, { ...c, at: now + c.in, total: 1500 });
  for (const j of h.jumlas || []) hz.jumlas.set(j.id, j);
  hz.cutouts = h.cutouts || []; hz.decoy = h.decoy;
}

/** Binary position updates. Keyframes list everyone; deltas only who changed. */
function onRoaches(type, rows) {
  const t = performance.now();
  const seen = type === P.T_KEY ? new Set() : null;
  for (const r of rows) {
    if (seen) seen.add(r.id);
    if (me && joined && r.id === me.id) {
      // Server correction: only snap if we drifted far (speed clamp, teleport we missed).
      if (Math.hypot(r.x - me.x, r.y - me.y) > 260) { me.x = r.x; me.y = r.y; }
      continue;
    }
    let o = others.get(r.id);
    const info = roster.get(r.id) || { name: 'Cockroach', hue: 30 };
    if (!o) { o = { id: r.id, x: r.x, y: r.y, a: r.a, tx: r.x, ty: r.y, ta: r.a, walk: Math.random() * 6, biteT: 0, name: info.name, hue: info.hue }; others.set(r.id, o); }
    o.tx = r.x; o.ty = r.y; o.ta = r.a; o.lvl = r.lvl; o.seen = t;
    o.flying = !!(r.flags & P.F_FLY); o.stunned = !!(r.flags & P.F_STUN); o.sleeping = !!(r.flags & P.F_SLEEP);
    if (r.flags & P.F_BITE && o.biteT <= 0) o.biteT = 0.001;
  }
  if (seen) for (const id of others.keys()) if (!seen.has(id)) others.delete(id);
}

function onHit(m) {
  if (!me) return;
  const mx = me.x + Math.cos(me.a) * 18 * size(), my = me.y + Math.sin(me.a) * 18 * size();
  if (m.void) {
    fx.text(mx, my - 18, m.left ? `OLD NOTE · ${m.left} left` : 'LAST OLD NOTE', '#c8e6a0', 13);
    me.voidLeft = m.left; return;
  }
  if (m.shield) {
    fx.text(mx, my - 18, 'BLOCKED', C.sky, 13); sfx.shielded();
    for (let k = 0; k < 6; k++) fx.add({ type: 'spark', x: mx, y: my, vx: (Math.random() - 0.5) * 260, vy: (Math.random() - 0.5) * 260, life: 0.35, age: 0, r: 3 });
  } else {
    nibbles.add(m.part, mx, my, me.a, world.growth, performance.now());
    hud.pulsePip(m.part);
    fx.text(mx + (Math.random() - 0.5) * 20, my - 16, `-${Math.round(m.dmg)}`, m.buddies ? C.zap : '#fff', m.buddies ? 18 : 15);
  }
  me.swarm = R.swarmMult(m.buddies); me.swarmAt = performance.now();
  profile.bites++;
  if (m.killed) cam.shake = Math.max(cam.shake, 12);
}

function onEvent(m) {
  const now = serverNow();
  switch (m.k) {
    case 'petalDown': {
      const z = R.zone(m.part, world.growth), p = R.PARTS[m.part];
      fx.shards(z.x, z.y, p.ang, 34, world.rebranded ? '#ffc94d' : '#ff6f9f');
      fx.crumbs(z.x, z.y, 40, ['#ff4f8b', '#ffc2d6', '#fff']);
      fx.ring(z.x, z.y, 260, '#fff', 0.8, 8);
      cam.shake = Math.max(cam.shake, nearMe(z.x, z.y, 900) ? 16 : 6);
      sfx.petalDown();
      world.alive[m.part] = false;
      const who = m.rallyName ? `Rally called by ${hud.esc(m.rallyName)}. ` : '';
      hud.banner('PETAL DOWN!', `${who}${m.count} cockroach${m.count === 1 ? '' : 'es'} chewed it to the stem.`, { life: 3.2 });
      if (m.coreOpen && downCount() === R.CORE_UNLOCK) setTimeout(() => hud.toast('<b>THE CORE IS EXPOSED.</b> Z+ security has left the building. Bite the seed pod!', 'pink', 5), 1500);
      break;
    }
    case 'contributed': {
      lastShare = m;
      if (m.what === 'petal') profile.petals++; else profile.blooms++;
      const extra = `<div class="actions"><button data-share>Share your part</button></div>`;
      if (m.what === 'petal') setTimeout(() => hud.banner('PETAL DOWN!', 'You were in on it.', { extra, onShare: () => share(m), life: 4.5 }), 50);
      break;
    }
    case 'coreDown': {
      for (let i = 0; i < R.PARTS.length; i++) { const z = R.zone(i, world.growth); fx.shards(z.x, z.y, R.PARTS[i].ang, 14, '#ff6f9f'); }
      fx.sparkle(R.LOTUS.x, R.LOTUS.y, 80); cam.shake = 26; sfx.bloomDown();
      const podium = (m.top || []).map((r, i) => `<div>${['🥇', '🥈', '🥉'][i]} ${hud.esc(r.name)} · ${hud.fmt(r.dmg)}</div>`).join('');
      const extra = (podium ? `<div class="podium">${podium}</div>` : '') + `<div class="actions"><button data-share>Share the victory</button></div>`;
      const nat = m.national ? ` Lotus #${hud.fmt(m.national)} to fall across India.` : '';
      hud.banner('THE BLOOM HAS FALLEN', `${hud.esc(m.name)} toppled after ${fmtDur(m.lived)} by ${hud.fmt(m.count)} cockroaches.${nat}`,
        { extra, gold: true, life: 9, onShare: () => share(lastShare && lastShare.what === 'bloom' ? lastShare : { what: 'bloom', bloom: m.name }) });
      break;
    }
    case 'newGen':
      nibbles.clearAll();
      fx.sparkle(R.LOTUS.x, R.LOTUS.y, 60); sfx.levelUp();
      hud.banner('NEW LOTUS, WHO DIS?', `Introducing <b>${hud.esc(m.name)}</b>. Bigger. Shinier. Same old petals.`, { life: 4.5 });
      break;
    case 'regrow': nibbles.clear(m.part); hud.toast('🌸 Eternal Bloom: a fallen petal grew back. Chew faster.', '', 3); break;
    case 'rebrand':
      world.rebranded = true; fx.sparkle(R.LOTUS.x, R.LOTUS.y, 70); sfx.levelUp();
      hud.banner('THE GREAT REBRAND', `${hud.esc(m.name)} announces a glorious new beginning. Petals +20%. Same lotus.`, { gold: true, life: 4.5 });
      break;
    case 'rally': {
      world.rally = { part: m.part, until: m.until, name: m.name };
      sfx.rally();
      const mine = me && m.id === me.id;
      if (mine) me.rallyCdUntil = performance.now() + 20000;
      hud.toast(mine ? 'Rally called. Your swarm bites +25% on the flag.' : `⚑ <b>${hud.esc(m.name)}</b> called a rally! +25% damage on the flagged petal.`, 'zap', 3.5);
      break;
    }
    case 'rallyEnd': world.rally = null; break;
    case 'shield':
      for (const i of m.parts) world.shield[i] = true;
      hud.toast('🛡 LOTUS SHIELD: some petals are <b>under review</b>. Bite elsewhere.', '', 3);
      break;
    case 'chappal':
      hz.chappals.set(m.id, { ...m, at: now + m.in, total: m.in });
      if (me && nearMe(m.x, m.y, m.r + 60)) sfx.warn();
      break;
    case 'stomp': {
      hz.chappals.delete(m.id);
      hz.stomps.push({ x: m.x, y: m.y, r: m.r, t0: performance.now() });
      fx.ring(m.x, m.y, m.r * 1.6, '#fff', 0.5, 6);
      fx.crumbs(m.x, m.y, 14, ['#e7d8b8', '#fff']);
      if (me && nearMe(m.x, m.y, 600)) { cam.shake = Math.max(cam.shake, 10); sfx.stomp(); }
      if (me && m.hit.includes(me.id)) {
        me.stunUntil = performance.now() + (R.has(profile.level, 'shell') ? 1100 : 2200);
        fx.text(me.x, me.y - 30, 'SQUASHED', C.danger, 20);
        if (!profile.stunTipShown) { profile.stunTipShown = true; hud.toast('Flattened by the chappal. Dash out of the dashed circle next time.', '', 3.5); }
      }
      if (me && m.dodged.includes(me.id)) { profile.stomps++; fx.text(me.x, me.y - 56, 'DODGED!', '#fff', 20); }
      break;
    }
    case 'jumla': hz.jumlas.set(m.id, m); break;
    case 'jumlaGone': hz.jumlas.delete(m.id); break;
    case 'jumlaHit': onJumlaHit(m); break;
    case 'news': {
      sfx.news();
      lastNews = m.text;
      hud.ticker(m.text, 13000, () => openShare(m.text, { online: world.nationOnline, blooms: world.national ? world.national.blooms : 0 }));
      if (m.decoy !== null && m.decoy !== undefined) hz.decoy = { part: m.decoy, until: m.until };
      break;
    }
    case 'flying': if (me) { me.flyUntil = performance.now() + (m.until - now); me.flyCdUntil = performance.now() + (m.cdUntil - now); sfx.fly(); } break;
    case 'levelUp': {
      profile = Object.assign(profile, m.me);
      hud.me(profile); sfx.levelUp();
      if (me) { fx.sparkle(me.x, me.y, 24); fx.ring(me.x, me.y, 80, C.zap, 0.6, 6); }
      const unl = (m.unlocked || []).map(u => `<b>${hud.esc(u.name)}</b>${u.key === 'rally' ? ' (R)' : u.key === 'wings' ? ' (F)' : ''}`).join(', ');
      hud.toast(`LEVEL ${m.level} · ${hud.esc(m.title)}${unl ? `<small>Unlocked: ${unl}</small>` : ''}`, 'zap', 4.5);
      break;
    }
    case 'ach': profile.ach.push(m.key); hud.achievement(m); sfx.ding(); break;
    case 'toast': hud.toast(hud.esc(m.text), '', 2.5); break;
  }
}

/** A Jumla backfired on someone. The server already applied the effect; we animate it. */
function onJumlaHit(m) {
  const def = CONTENT.JUMLAS[m.kind]; if (!def) return;
  const nowP = performance.now();
  if (def.bubble) hz.bubbles.set(m.id, { lines: def.bubble, t0: nowP, ms: m.ms });
  if (m.kind === 'smart') hz.cutouts.push({ x: m.cx, y: m.cy, until: m.until });
  const mine = me && joined && m.id === me.id;
  if (!mine) {
    const o = others.get(m.id);
    if (o && inView(o.x, o.y)) { fx.text(o.x, o.y - 34, '*Terms & conditions apply', '#fff', 13); sfx.jumla(0.35); }
    return;
  }
  sfx.jumla(1);
  hud.toast(hud.esc(def.caught), '', 4.2);
  cam.shake = Math.max(cam.shake, 8);
  switch (def.effect) {
    case 'launch': case 'float':
      me.kx = m.vx; me.ky = m.vy;
      if (def.effect === 'float') me.stunUntil = nowP + m.ms;
      break;
    case 'freeze': me.stunUntil = nowP + m.ms; break;
    case 'void': me.voidLeft = def.bites; break;
    case 'uturn': me.uturnUntil = nowP + m.ms; break;
    case 'teleport': me.x = m.x; me.y = m.y; me.vx = me.vy = 0; cam.x = me.x; cam.y = me.y; fx.sparkle(me.x, me.y, 20); break;
  }
  fx.text(me.x, me.y - 44, '*Terms & conditions apply', C.zap, 16);
}

function nearMe(x, y, d) { return me && Math.hypot(me.x - x, me.y - y) < d; }
const size = () => R.sizeFor(profile ? profile.level : 1);

// ---------------------------------------------------------------- sharing
function share(ctxInfo) {
  const p = profile; if (!p) return;
  const swarm = hud.fmt((world.national && world.national.total) || 1);
  let tail;
  if (ctxInfo && ctxInfo.what === 'bloom') tail = `and helped topple ${ctxInfo.bloom}`;
  else if (ctxInfo && ctxInfo.what === 'petal') tail = `and helped bring down a petal of ${ctxInfo.bloom}`;
  else tail = `and I'm still chewing on ${world.name}`;
  const text = `I joined ${swarm} cockroaches, delivered ${hud.fmt(p.bites)} bites, survived ${hud.fmt(p.stomps)} chappal${p.stomps === 1 ? '' : 's'}, ${tail}. They called us cockroaches. We took it personally. #UPRISING`;
  const url = room.id ? `${location.origin}/r/${room.id}` : location.origin;
  if (navigator.share) navigator.share({ title: 'UPRISING', text, url }).catch(() => {});
  else copy(`${text} ${url}`, 'Copied to clipboard. Go spread the infestation.');
}
function copy(text, ok) {
  navigator.clipboard.writeText(text).then(() => hud.toast(hud.esc(ok), 'zap', 2.5), () => hud.toast(hud.esc(text), '', 8));
}
document.getElementById('shareBtn').onclick = () => share(null);
document.getElementById('inviteBtn').onclick = () => {
  if (!room.id) return;
  const url = `${location.origin}/r/${room.id}`;
  const text = `Join my swarm in UPRISING. They called us cockroaches. We took it personally.`;
  if (navigator.share && input.touch) navigator.share({ title: 'UPRISING', text, url }).catch(() => {});
  else copy(url, `Invite link copied. Room ${room.id.toUpperCase()} has ${room.max - world.roomOnline} free spots.`);
};

// ---------------------------------------------------------------- title screen
const nameInput = document.getElementById('nameInput');
nameInput.value = savedName || R.randomName();
document.getElementById('reroll').onclick = () => { nameInput.value = R.randomName(); };
function updateJoinButton() {
  const b = document.getElementById('joinBtn'); if (!b) return;
  b.disabled = !connected; b.textContent = connected ? (token ? 'Rejoin the swarm' : 'Join the swarm') : 'Connecting…';
}
function updateLiveLine() {
  if (joined) return;
  const el = document.getElementById('liveLine'); if (!el) return;
  const n = world.national;
  if (!n) return;
  el.innerHTML = n.online > 0
    ? `<b>${hud.fmt(n.online)}</b> cockroach${n.online === 1 ? ' is' : 'es are'} chewing across India · ${hud.fmt(n.blooms)} lotus${n.blooms === 1 ? '' : 'es'} toppled`
    : `The lotus is unguarded. ${n.total ? `${hud.fmt(n.total)} cockroaches have come before you.` : 'Be the first cockroach.'}`;
}
document.getElementById('joinForm').onsubmit = (e) => {
  e.preventDefault(); if (!connected) return;
  sfx.unlock();
  const n = nameInput.value.trim() || R.randomName(); nameInput.value = n;
  try { localStorage.setItem('uprising.name', n); } catch { /* ok */ }
  joined = true; input.enabled = true;
  hello();
  document.getElementById('intro').classList.add('leaving');
  setTimeout(() => document.getElementById('intro').remove(), 450);
  document.getElementById('hud').hidden = false;
  renderMute();
};
function renderMute() {
  document.getElementById('muteBtn').innerHTML = sfx.muted
    ? '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
}
document.getElementById('muteBtn').onclick = () => { sfx.toggle(); renderMute(); };

// ---------------------------------------------------------------- local player sim
function updateMe(dt, t) {
  if (!me || !profile || detained) return;
  const nowP = performance.now();
  const lvl = profile.level, sz = size();
  const stunned = me.stunUntil > nowP, flying = me.flyUntil > nowP;
  me.flying = flying; me.stunned = stunned; me.size = sz; me.hue = profile.hue; me.crown = R.has(lvl, 'crown');

  // abilities
  if (input.take('dash') && !stunned && nowP > me.dashCdUntil) { me.dashUntil = nowP + R.MOVE.dashMs; me.dashCdUntil = nowP + R.MOVE.dashCdMs; sfx.dash(); fx.ring(me.x, me.y, 40, '#fff', 0.35, 3); }
  if (input.take('fly')) {
    if (!R.has(lvl, 'wings')) hud.toast('Wings unlock at level 3. Keep chewing.', '', 2);
    else if (nowP > me.flyCdUntil) net.send({ t: 'fly' });
  }
  if (input.take('rally')) {
    if (!R.has(lvl, 'rally')) hud.toast('Rally Signal unlocks at level 2.', '', 2);
    else if (nowP > me.rallyCdUntil) net.send({ t: 'rally' });
    else hud.toast(`Rally recharging (${Math.ceil((me.rallyCdUntil - nowP) / 1000)}s).`, '', 1.5);
  }

  // movement
  let dx = 0, dy = 0, throttle = 1;
  const mv = input.move();
  if (mv && mv.mode === 'dir') { dx = mv.x; dy = mv.y; throttle = Math.min(1, Math.hypot(mv.x, mv.y) * 1.2); }
  else if (mv && mv.mode === 'point') {
    const wx = (mv.sx - W / 2) / cam.zoom + cam.x, wy = (mv.sy - H / 2) / cam.zoom + cam.y;
    const ddx = wx - me.x, ddy = wy - me.y, d = Math.hypot(ddx, ddy);
    if (d > 16 * sz) { dx = ddx / d; dy = ddy / d; throttle = Math.min(1, (d - 16 * sz) / 70); }
  }
  let speed = R.MOVE.speed * (R.has(lvl, 'legs') ? 1.1 : 1) * (flying ? 1.2 : 1);
  if (me.dashUntil > nowP) { speed = R.MOVE.dashSpeed; if (!dx && !dy) { dx = Math.cos(me.a); dy = Math.sin(me.a); throttle = 1; } }
  if (me.uturnUntil > nowP) { dx = -dx; dy = -dy; }   // Achhe Din took a U-turn
  if (stunned) { dx = dy = 0; }
  const tvx = dx * speed * throttle, tvy = dy * speed * throttle;
  const k = Math.min(1, dt * (me.dashUntil > nowP ? 30 : 12));
  me.vx += (tvx - me.vx) * k; me.vy += (tvy - me.vy) * k;
  me.x += (me.vx + me.kx) * dt; me.y += (me.vy + me.ky) * dt;
  me.kx *= Math.exp(-3.2 * dt); me.ky *= Math.exp(-3.2 * dt);
  me.x = Math.max(10, Math.min(R.WORLD.w - 10, me.x)); me.y = Math.max(10, Math.min(R.WORLD.h - 10, me.y));
  const sp = Math.hypot(me.vx, me.vy);
  if (sp > 12) me.a = turn(me.a, Math.atan2(me.vy, me.vx), dt * 14);
  me.walk += sp * dt * 0.09;

  // biting
  const targ = biteTargetFor(me.x, me.y, me.a, sz, flying);
  if (input.biting && !stunned && targ < 0 && sp < 40) {
    // auto-face the nearest bitable part if we're touching it
    const near = nearestZone(me.x, me.y, flying, 40 * sz);
    if (near) me.a = turn(me.a, Math.atan2(near.y - me.y, near.x - me.x), dt * 18);
  }
  me.biteT = me.biteT > 0 ? me.biteT + dt * 4 : 0; if (me.biteT > 1) me.biteT = 0;
  if (input.biting && !stunned && nowP - me.lastBite >= R.BITE.cooldownMs && !world.fallenUntil) {
    me.lastBite = nowP; me.biteT = 0.001;
    const t2 = biteTargetFor(me.x, me.y, me.a, sz, flying);
    if (t2 >= 0) {
      net.send({ t: 'bite' });
      const mx = me.x + Math.cos(me.a) * 20 * sz, my = me.y + Math.sin(me.a) * 20 * sz;
      fx.crumbs(mx, my, 7, world.rebranded ? ['#ffb320', '#fff1c9', '#fff'] : ['#ff4f8b', '#ffc2d6', '#fff', '#ff86ae']);
      sfx.bite(1); cam.shake = Math.max(cam.shake, 2.5);
      me.misses = 0;
    } else me.misses++;
  }
  // network: position 10×/s, and only when it actually changed
  if (nowP - me.lastSend > 100) {
    const pos = { t: 'pos', x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, a: Math.round(me.a * 100) / 100 };
    const key = `${pos.x},${pos.y},${pos.a}`;
    if (key !== me.lastSent || nowP - me.lastSend > 2000) { me.lastSend = nowP; me.lastSent = key; net.send(pos); }
  }
  if (sp > 30 && Math.random() < dt * 5) fx.ripple(me.x - Math.cos(me.a) * 12, me.y - Math.sin(me.a) * 12);

  // HUD bits
  const swarmMult = me.swarmAt && nowP - me.swarmAt < 1500 ? me.swarm : (countBuddies() ? R.swarmMult(countBuddies()) : 1);
  hud.swarm(swarmMult);
  hud.abilities({
    dashCd: (me.dashCdUntil - nowP) / R.MOVE.dashCdMs, dashing: me.dashUntil > nowP,
    wings: R.has(lvl, 'wings'), flyCd: flying ? 0 : (me.flyCdUntil - nowP) / R.MOVE.flyCdMs, flying,
    rally: R.has(lvl, 'rally'), rallyCd: (me.rallyCdUntil - nowP) / 20000,
    biteReady: targ >= 0,
  });
  onboarding(targ, flying);
}

function biteTargetFor(x, y, a, sz, flying) {
  const hx = x + Math.cos(a) * 14 * sz, hy = y + Math.sin(a) * 14 * sz;
  return R.biteTarget(hx, hy, world.growth, i => world.alive[i], flying, coreOpen(), R.BITE.reach * sz + 2);
}
function nearestZone(x, y, flying, reach) {
  const i = R.biteTarget(x, y, world.growth, j => world.alive[j], flying, coreOpen(), reach);
  return i >= 0 ? R.zone(i, world.growth) : null;
}
function countBuddies() {
  let n = 0; for (const o of others.values()) if (!o.stunned && !o.sleeping && Math.hypot(o.x - me.x, o.y - me.y) < R.BITE.swarmRadius) n++; return n;
}
function turn(a, b, k) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * Math.min(1, k); }

function onboarding(targ, flying) {
  const touch = input.touch;
  const dl = Math.hypot(me.x - R.LOTUS.x, me.y - R.LOTUS.y), Rw = R.radius(world.growth);
  if (world.fallenUntil > serverNow()) return hud.hint(`A new lotus is sprouting in ${Math.ceil((world.fallenUntil - serverNow()) / 1000)}s…`);
  if (profile.bites < 6) {
    if (dl > Rw * 1.15) return hud.hint(touch ? 'Drag on the left to crawl to the lotus' : 'Move your mouse (or WASD) to crawl to the lotus');
    if (targ >= 0) return hud.hint(touch ? 'Hold <b>BITE</b>. Eat it.' : 'Hold <kbd>Space</kbd> or click. Eat it.');
    return hud.hint('Crawl onto a pink petal');
  }
  // situational tips
  if (input.biting && targ < 0 && me.misses > 4) {
    const inner = R.biteTarget(me.x, me.y, world.growth, i => world.alive[i], true, true, 10);
    if (inner === R.CORE && !coreOpen()) return hud.hint(`The core has Z+ security · bring down ${R.CORE_UNLOCK - downCount()} more petal${R.CORE_UNLOCK - downCount() === 1 ? '' : 's'}`);
    if (inner >= 0 && R.PARTS[inner].fly && !flying) return hud.hint(R.has(profile.level, 'wings') ? 'Inner petals are up high · press <kbd>F</kbd> to fly' : 'Inner petals are up high · Wings unlock at level 3');
  }
  if (profile.level >= 2 && profile.level < 4 && !profile.rallyTipDone && targ >= 0 && profile.bites > 40) {
    profile.rallyTipDone = true; hud.toast('Tip: press <b>R</b> (⚑) beside a petal to call a rally. The swarm gets +25%.', '', 4);
  }
  hud.hint(null);
}

// ---------------------------------------------------------------- remote roach smoothing
function updateOthers(dt) {
  const k = 1 - Math.exp(-dt * 11);
  for (const o of others.values()) {
    const px = o.x, py = o.y;
    o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k; o.a = turn(o.a, o.ta, k * 1.4);
    const sp = Math.hypot(o.x - px, o.y - py) / Math.max(dt, 1e-3);
    o.walk += sp * dt * 0.09; o.size = R.sizeFor(o.lvl || 1); o.crown = R.has(o.lvl || 1, 'crown');
    if (o.biteT > 0) {
      const was = o.biteT; o.biteT += dt * 4;
      if (was < 0.05 && o.biteT >= 0.05) {
        const mx = o.x + Math.cos(o.a) * 18 * o.size, my = o.y + Math.sin(o.a) * 18 * o.size;
        const part = R.biteTarget(mx, my, world.growth, i => world.alive[i], o.flying, coreOpen(), R.BITE.reach * o.size + 8);
        if (part >= 0 && !world.shield[part]) nibbles.add(part, mx, my, o.a, world.growth, performance.now());
        if (inView(o.x, o.y)) fx.crumbs(mx, my, 4, ['#ff4f8b', '#ffc2d6', '#fff']);
      }
      if (o.biteT > 1) o.biteT = 0;
    }
    if (sp > 30 && Math.random() < dt * 3 && inView(o.x, o.y)) fx.ripple(o.x, o.y);
  }
}
function inView(x, y, pad = 80) { const v = cam.view; return x > v.x0 - pad && x < v.x1 + pad && y > v.y0 - pad && y < v.y1 + pad; }

// ---------------------------------------------------------------- render
function resize() {
  DPR = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight;
  canvas.width = W * DPR | 0; canvas.height = H * DPR | 0;
}
addEventListener('resize', resize); resize();

let last = performance.now(), t = 0;
function frame(nowP) {
  const dt = Math.min(0.05, (nowP - last) / 1000); last = nowP; t += dt;
  updateMe(dt, t);
  updateOthers(dt);
  fx.update(dt);

  // camera
  const baseZoom = Math.max(0.68, Math.min(1.15, Math.sqrt(W * H) / 820));
  if (detained) {                     // held in the detention pod: the camera watches the pod
    cam.x += (CONTENT.POD.x + 120 - cam.x) * Math.min(1, dt * 3); cam.y += (CONTENT.POD.y - 160 - cam.y) * Math.min(1, dt * 3); cam.zoom = baseZoom;
  } else if (me && joined) {
    const lead = 0.25;
    cam.x += (me.x + me.vx * lead - cam.x) * Math.min(1, dt * 5); cam.y += (me.y + me.vy * lead - cam.y) * Math.min(1, dt * 5);
    cam.zoom += ((me.flying ? baseZoom * 0.85 : baseZoom) - cam.zoom) * Math.min(1, dt * 3);
  } else { // attract mode: drift around the lotus
    cam.x = R.LOTUS.x + Math.cos(t * 0.08) * 260; cam.y = R.LOTUS.y + Math.sin(t * 0.08) * 160 + 60; cam.zoom = baseZoom * 0.82;
  }
  cam.shake *= Math.exp(-dt * 9);
  const sx = (Math.random() - 0.5) * cam.shake, sy = (Math.random() - 0.5) * cam.shake;
  cam.view = { x0: cam.x - W / 2 / cam.zoom, y0: cam.y - H / 2 / cam.zoom, x1: cam.x + W / 2 / cam.zoom, y1: cam.y + H / 2 / cam.zoom };

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + sx, H / 2 + sy); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);

  pond.draw(ctx, cam, t);
  pond.drawMonuments(ctx, world.history);
  fx.draw(ctx, 'water');

  const now = serverNow();
  for (const c of hz.chappals.values()) drawChappalWarning(ctx, c, now, t);

  // lotus
  const fracs = R.PARTS.map((_, i) => frac(i));
  const fallen = world.fallenUntil > now;
  lotusArt.update(fracs, fallen ? world.alive.map(() => false) : world.alive, world.rebranded ? 'gold' : 'normal');
  if (fallen) drawRoots(t, world.fallenUntil - now);
  else {
    lotusArt.draw(ctx, world.growth, t);
    nibbles.draw(ctx, partPath, world.growth, nowP, world.rebranded);
    nibbles.drawFlash(ctx, partPath, world.growth, nowP);
  }
  drawLotusOverlays(now);

  hz.cutouts = hz.cutouts.filter(c => c.until > now);
  for (const c of hz.cutouts) if (inView(c.x, c.y, 120)) drawCutout(ctx, c, t);
  for (const j of hz.jumlas.values()) if (inView(j.x, j.y, 80)) drawJumla(ctx, j, t);
  if (world.detained > 0 || detained) {
    const self = detained ? { id: 999, x: CONTENT.POD.x + Math.cos(t * 0.7) * 60, y: CONTENT.POD.y + 20 + Math.sin(t * 1.1) * 25, a: t * 0.7 + Math.PI / 2,
      size: 0.8, walk: t * 9, biteT: 0, hue: profile ? profile.hue : 48, flying: false, stunned: false } : null;
    if (inView(CONTENT.POD.x, CONTENT.POD.y, 200)) {
      drawDetentionPod(ctx, CONTENT.POD, Math.max(world.detained, detained ? 1 : 0), t, self);
      if (self) label(ctx, self.x, self.y - 28, 'YOU', C.zap, C.ink, 11);
    }
  }

  // roaches: grounded first, then fliers (they're above everything)
  const list = [...others.values()]; if (me && joined) list.push(me);
  for (const r of list) if (!r.flying && inView(r.x, r.y)) drawRoach(ctx, r, t);
  ctx.save(); ctx.font = '800 13px "Bricolage Grotesque", system-ui'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  for (const o of others.values()) if (o.sleeping && inView(o.x, o.y)) ctx.fillText('z z z', o.x + 14, o.y - 22 - Math.sin(t * 2) * 3);
  ctx.restore();
  // Jumla speech bubbles: the Wi-Fi OTP loop, the Bullet Train departure board…
  for (const [id, b] of hz.bubbles) {
    const age = nowP - b.t0; if (age > b.ms) { hz.bubbles.delete(id); continue; }
    const who = me && joined && id === me.id ? me : others.get(id);
    if (who && inView(who.x, who.y)) drawBubble(ctx, who.x, who.y - 46, b.lines[Math.min(b.lines.length - 1, Math.floor(age / b.ms * b.lines.length))]);
  }
  fx.draw(ctx, 'air');
  for (const r of list) if (r.flying && inView(r.x, r.y)) drawRoach(ctx, r, t);
  if (me && joined) drawMeMarker(t);
  drawNames();

  // chappal stomps
  hz.stomps = hz.stomps.filter(s => nowP - s.t0 < 1100);
  for (const s of hz.stomps) {
    const age = (nowP - s.t0) / 1000;
    drawChappal(ctx, s.x, s.y, s.r, Math.min(1, age / 0.12), age < 0.7 ? 1 : Math.max(0, 1 - (age - 0.7) / 0.4));
  }
  for (const c of hz.chappals.values()) { const left = c.at - now; if (left < 350) drawChappal(ctx, c.x, c.y, c.r, 1 - left / 350 * 0.99, 0.9); }

  drawPins(now);
  ctx.restore();

  drawOffscreenArrows(now);
  drawJoystick();
  hudTick(now);
  requestAnimationFrame(frame);
}

function drawLotusOverlays(now) {
  if (world.fallenUntil > now) return;
  const g = world.growth;
  // shields: glassy "under review" coating
  for (let i = 0; i < R.PARTS.length; i++) {
    if (!world.shield[i] || !world.alive[i]) continue;
    ctx.save(); partPath(ctx, i, g);
    ctx.fillStyle = `rgba(170,230,255,${0.35 + Math.sin(t * 6) * 0.1})`; ctx.fill();
    ctx.strokeStyle = '#6fd0ff'; ctx.lineWidth = 5; ctx.stroke(); ctx.restore();
    const z = R.zone(i, g);
    ctx.save(); ctx.translate(z.x, z.y); ctx.rotate(-0.25);
    ctx.font = '800 13px "Bricolage Grotesque", system-ui'; ctx.textAlign = 'center';
    ctx.strokeStyle = '#1f7fb0'; ctx.lineWidth = 2.5; const w = ctx.measureText('UNDER REVIEW').width + 12;
    ctx.strokeRect(-w / 2, -11, w, 22); ctx.fillStyle = '#1f7fb0'; ctx.fillText('UNDER REVIEW', 0, 5); ctx.restore();
  }
  // the petal you're about to bite glows
  if (me && joined && profile) {
    const targ = biteTargetFor(me.x, me.y, me.a, size(), me.flying);
    if (targ >= 0) { ctx.save(); partPath(ctx, targ, g); ctx.strokeStyle = `rgba(255,210,63,${0.7 + Math.sin(t * 10) * 0.3})`; ctx.lineWidth = 5; ctx.stroke(); ctx.restore(); }
  }
  // core lock: Z+ security ring
  if (world.alive[R.CORE] && !coreOpen()) {
    const r = R.radius(g) * R.PARTS[R.CORE].zr + 16;
    ctx.save(); ctx.translate(R.LOTUS.x, R.LOTUS.y); ctx.rotate(t * 0.6);
    ctx.setLineDash([14, 10]); ctx.strokeStyle = C.ink; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C.zap; ctx.lineWidth = 2.5; ctx.stroke(); ctx.restore();
    label(ctx, R.LOTUS.x, R.LOTUS.y, `Z+ SECURITY · ${downCount()}/${R.CORE_UNLOCK}`, C.paper, C.ink, 11);
  }
}

// After a bloom falls: the roots are exposed and a new sprout pushes up.
function drawRoots(t, left) {
  ctx.save(); ctx.translate(R.LOTUS.x, R.LOTUS.y);
  ctx.strokeStyle = '#8a6a4a'; ctx.lineCap = 'round';
  for (let k = 0; k < 9; k++) {
    const a = k / 9 * Math.PI * 2 + 0.2; ctx.lineWidth = 10 - (k % 3) * 2;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(Math.cos(a) * 120, Math.sin(a) * 120 + 30, Math.cos(a + 0.4) * 220, Math.sin(a + 0.4) * 220, Math.cos(a + 0.2) * 320, Math.sin(a + 0.2) * 300);
    ctx.stroke();
  }
  ctx.fillStyle = '#c4a57e'; ctx.strokeStyle = C.ink; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  const sprout = Math.max(0, 1 - left / 25000);
  ctx.fillStyle = '#7aa846'; ctx.beginPath(); ctx.ellipse(0, -10 * sprout, 10 + 18 * sprout, 6 + 10 * sprout, 0.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
  label(ctx, R.LOTUS.x, R.LOTUS.y + 90, `ROOTS EXPOSED · new lotus in ${Math.ceil(left / 1000)}s`, C.zap, C.ink, 14);
}

function drawPins(now) {
  const g = world.growth;
  if (world.rally && world.rally.until > now && world.alive[world.rally.part]) {
    const z = R.zone(world.rally.part, g);
    drawPin(ctx, z.x, z.y, t, 'RALLY HERE · +25%', `called by ${world.rally.name}`, false);
  }
  if (hz.decoy && hz.decoy.until > now && world.alive[hz.decoy.part]) {
    const z = R.zone(hz.decoy.part, g);
    const close = me && joined && Math.hypot(me.x - z.x, me.y - z.y) < 160;
    drawPin(ctx, z.x + 30, z.y + 20, t, close ? 'FAKE NEWS. NOTHING HERE.' : 'OFFICIAL RALLY POINT', close ? null : '(sponsored content)', true);
  }
}

function drawMeMarker(t) {
  const s = size();
  ctx.save(); ctx.strokeStyle = C.zap; ctx.lineWidth = 3; ctx.setLineDash([6, 5]); ctx.lineDashOffset = -t * 20;
  ctx.beginPath(); ctx.ellipse(me.x, me.y + (me.flying ? 4 : 2), 24 * s, 17 * s, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  if (performance.now() - me.born < 7000) label(ctx, me.x, me.y - 40 * s - (me.flying ? 12 : 0), 'YOU', C.zap, C.ink, 12);
}

function drawNames() {
  if (!me || !joined) return;
  const many = others.size > 30;
  ctx.save(); ctx.font = '700 11px "Bricolage Grotesque", system-ui'; ctx.textAlign = 'center';
  for (const o of others.values()) {
    if (!inView(o.x, o.y)) continue;
    const d = Math.hypot(o.x - me.x, o.y - me.y);
    if (many && d > 160) continue;
    if (d > 420) continue;
    const y = o.y - 30 * (o.size || 1) - (o.flying ? 12 : 0);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(27,22,17,0.85)'; ctx.strokeText(o.name, o.x, y);
    ctx.fillStyle = '#fff'; ctx.fillText(o.name, o.x, y);
  }
  ctx.restore();
}

function drawOffscreenArrows(now) {
  if (!me || !joined) return;
  const pts = [];
  if (!inView(R.LOTUS.x, R.LOTUS.y, -100)) pts.push({ x: R.LOTUS.x, y: R.LOTUS.y, c: '#ff4f8b', txt: 'LOTUS' });
  if (world.rally && world.rally.until > now && world.alive[world.rally.part]) {
    const z = R.zone(world.rally.part, world.growth); if (!inView(z.x, z.y, -60)) pts.push({ x: z.x, y: z.y, c: C.zap, txt: 'RALLY' });
  }
  for (const p of pts) {
    const dx = (p.x - cam.x) * cam.zoom, dy = (p.y - cam.y) * cam.zoom, a = Math.atan2(dy, dx);
    const m = 46, hw = W / 2 - m, hh = H / 2 - m, k = Math.min(hw / Math.abs(Math.cos(a) || 1e-6), hh / Math.abs(Math.sin(a) || 1e-6));
    const x = W / 2 + Math.cos(a) * k, y = H / 2 + Math.sin(a) * k;
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = p.c; ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-10, -13); ctx.lineTo(-4, 0); ctx.lineTo(-10, 13); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    label(ctx, x - Math.cos(a) * 30, y - Math.sin(a) * 30, p.txt, p.c, p.c === C.zap ? C.ink : '#fff', 10);
  }
}

function drawJoystick() {
  const j = input.joy; if (j.id === null) return;
  ctx.save(); ctx.globalAlpha = 0.6; ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.fillStyle = 'rgba(251,243,228,0.35)';
  ctx.beginPath(); ctx.arc(j.ox, j.oy, 60, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 0.9; ctx.fillStyle = C.paper; ctx.beginPath(); ctx.arc(j.ox + j.x * 60, j.oy + j.y * 60, 24, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

let hudAcc = 0;
function hudTick(now) {
  if (!joined) return;
  if (++hudAcc % 6) return; // ~10 Hz DOM updates
  const shield = world.shield.slice();
  hud.lotus({ frac: R.PARTS.map((_, i) => frac(i)), alive: world.alive, shield, rally: world.rally && world.rally.until > now ? world.rally.part : -1,
    coreOpen: coreOpen(), health: world.fallenUntil > now ? 0 : health(), gen: world.gen, name: world.name, gold: world.rebranded }, now);
  hud.stats(world.roomOnline, room.max, world.nationOnline);
}

requestAnimationFrame(frame);

// Debug handle for tests / curious players in the console.
window.__uprising = { get me() { return me; }, world, cam, others, net, nibbles, get room() { return room; }, get detained() { return detained; }, get profile() { return profile; } };
