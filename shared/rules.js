// UPRISING — shared game rules.
// Loaded by the Node server (require) and the browser (window.RULES), so both
// sides agree on geometry, damage, levels and names without duplicating numbers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RULES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WORLD = { w: 3200, h: 3200 };
  const LOTUS = { x: 1600, y: 1600, baseR: 300 };

  // ---- Lotus anatomy -------------------------------------------------------
  // 8 outer petals (reachable on foot), 5 inner petals (need wings), 1 seed core.
  const OUTER = 8, INNER = 5;
  const PARTS = [];
  for (let i = 0; i < OUTER; i++) {
    PARTS.push({ kind: 'o', idx: i, ang: (i / OUTER) * Math.PI * 2 + Math.PI / OUTER, len: 1.0, wid: 0.44, zd: 0.7, zr: 0.28, base: 2000, fly: false });
  }
  for (let i = 0; i < INNER; i++) {
    PARTS.push({ kind: 'i', idx: i, ang: -Math.PI / 2 + (i / INNER) * Math.PI * 2, len: 0.62, wid: 0.36, zd: 0.4, zr: 0.17, base: 1500, fly: true });
  }
  PARTS.push({ kind: 'c', idx: 0, ang: 0, len: 0, wid: 0, zd: 0, zr: 0.19, base: 7000, fly: false });
  const CORE = PARTS.length - 1;
  const CORE_UNLOCK = 7; // petals that must fall before the core shield drops

  // Each new bloom is tougher; the lotus also bulks up to match the biggest crowd
  // it has faced this bloom (crowd only ever rises within a bloom, so leaving never
  // makes it suddenly fragile).
  const genMult = (gen) => 1 + 0.5 * (gen - 1);
  const crowdMult = (peak) => Math.max(1, Math.min(60, peak)); // ~10 min for a full room of 50, ~25 min solo
  const maxHp = (part, gen, growth, peak = 1) => Math.round(PARTS[part].base * genMult(gen) * growth * crowdMult(peak));
  const radius = (growth) => LOTUS.baseR * growth;

  // Bite zone centre + radius for a part at the given growth.
  function zone(part, growth) {
    const p = PARTS[part], R = radius(growth);
    return { x: LOTUS.x + Math.cos(p.ang) * R * p.zd, y: LOTUS.y + Math.sin(p.ang) * R * p.zd, r: R * p.zr };
  }

  // Which part can a cockroach at (x,y) bite? Returns index or -1.
  // `alive(i)` says if a part is standing, `canFly` = currently airborne.
  function biteTarget(x, y, growth, alive, canFly, coreOpen, reach) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < PARTS.length; i++) {
      if (!alive(i)) continue;
      if (PARTS[i].fly && !canFly) continue;
      if (i === CORE && !coreOpen) continue;
      const z = zone(i, growth);
      const d = Math.hypot(x - z.x, y - z.y) - z.r;
      if (d < reach && d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- Combat --------------------------------------------------------------
  const BITE = {
    dmg: 8, cooldownMs: 280, reach: 16,
    swarmRadius: 150, swarmPer: 0.2, swarmMaxBuddies: 8, // up to x2.6
    rallyMult: 1.25, shieldMult: 0.15,
  };
  const swarmMult = (buddies) => 1 + BITE.swarmPer * Math.min(buddies, BITE.swarmMaxBuddies);

  // ---- Movement ------------------------------------------------------------
  const MOVE = { speed: 210, dashSpeed: 620, dashMs: 220, dashCdMs: 1600, flyMs: 4500, flyCdMs: 9000 };

  // ---- Progression ---------------------------------------------------------
  // Veterans get *more interesting* tools, not overwhelming power: max +15% bite,
  // +10% speed. The swarm multiplier (x2.6) always dwarfs individual upgrades.
  const LEVELS = [0, 25, 70, 150, 280, 480, 780, 1200, 1800, 2600, 3600, 5000, 7000, 10000];
  function levelFor(xp) { let l = 1; for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i]) l = i + 1; return l; }
  function nextLevelXp(level) { return LEVELS[level] ?? null; }

  const UNLOCKS = [
    { lvl: 1, key: 'bite', name: 'Bite', desc: 'Eat the lotus. Hold to chomp.' },
    { lvl: 1, key: 'dash', name: 'Dash', desc: 'Short burst. Dodge the chappal.' },
    { lvl: 2, key: 'rally', name: 'Rally Signal', desc: 'Mark a petal. Swarm gets +25%.' },
    { lvl: 3, key: 'wings', name: 'Wings', desc: 'Fly over chappals, reach inner petals.' },
    { lvl: 4, key: 'mandibles', name: 'Steel Mandibles', desc: '+15% bite damage.' },
    { lvl: 5, key: 'legs', name: 'Commuter Legs', desc: '+10% speed. Trained on local trains.' },
    { lvl: 6, key: 'shell', name: 'Pesticide-Proof Shell', desc: 'Chappal stuns last half as long.' },
    { lvl: 8, key: 'crown', name: 'Antenna Crown', desc: 'Purely cosmetic. Deeply earned.' },
  ];
  const has = (level, key) => UNLOCKS.some(u => u.key === key && level >= u.lvl);

  const TITLES = ['Nymph', 'Common Pest', 'Public Nuisance', 'Neighbourhood Menace', 'Seditious Insect (Allegedly)',
    'Professional Agitator', 'Enemy of Development', 'Chief Pest of the Republic'];
  const titleFor = (level) => TITLES[Math.min(TITLES.length - 1, Math.floor((level - 1) * 0.75))];

  const sizeFor = (level) => 1 + Math.min(0.35, (level - 1) * 0.035);

  const ACHIEVEMENTS = {
    founder: { name: 'Founding Member of the Swarm', desc: 'Among the first 100 cockroaches ever.' },
    bites100: { name: 'The Hundred-Bite Menace', desc: '100 bites delivered.' },
    bites1000: { name: 'Thousand-Bite Tsunami', desc: '1,000 bites. The lotus remembers you.' },
    petal: { name: 'Petal Breaker', desc: 'Helped bring down a petal.' },
    regime: { name: 'Bloom Toppler', desc: 'Helped bring down an entire lotus.' },
    stomps5: { name: 'Chappal Dodger', desc: 'Survived 5 chappal stomps.' },
    jumla3: { name: 'Believed It. Three Times.', desc: 'Fell for the Jumla Cannon 3 times.' },
    swarm: { name: 'Strength in Numbers', desc: 'Bit with 5+ cockroaches beside you.' },
    rally: { name: 'Chief Agitator', desc: 'Called a rally that took down a petal.' },
    chief: { name: 'Chief Pest of the Republic', desc: 'Top of this bloom’s leaderboard (1,000+ dmg).' },
  };

  // ---- Flavour -------------------------------------------------------------
  const NAME_A = ['Unpaid', 'Overqualified', 'Restless', 'Night-Shift', 'Unbothered', 'Jobless', 'Caffeinated', 'Underslept', 'Freelance', 'Unemployable', 'Chronically Online', 'Very Patient'];
  const NAME_B = ['Intern', 'Engineer', 'UPSC Aspirant', 'Chai Philosopher', 'Gig Worker', 'Meme Lord', 'PhD Scholar', 'Delivery Partner', 'Backbencher', 'Coaching Topper', 'Bus Commuter', 'Voter'];
  const randomName = () => NAME_A[Math.random() * NAME_A.length | 0] + ' ' + NAME_B[Math.random() * NAME_B.length | 0];

  const BLOOM_NAMES = ['The Great Bloom', 'Lotus 2.0 (Now With Petals)', 'The Amrit Bloom', 'The Viksit Bloom', 'Lotus Pro Max',
    'The Undefeatable Bloom (Again)', 'The New India Bloom™', 'Bloom of the Decade', 'Lotus: Director’s Cut'];
  const bloomName = (gen) => gen <= BLOOM_NAMES.length ? BLOOM_NAMES[gen - 1] : `Bloom #${gen}: The Sequel Nobody Asked For`;

  const HEADLINES = [
    'BREAKING: Cockroaches actually enjoy being stepped on, says survey of zero cockroaches',
    'EXCLUSIVE: Lotus has never been healthier, confirms lotus',
    'DEBATE: Are cockroaches even real? Panel of 9 shouts for 2 hours',
    'SOURCES: Swarm funded by foreign hand (hand unavailable for comment)',
    'GOOD NEWS: Petal losses are actually petal gains, experts clarify',
    'ALERT: Biting the lotus is anti-development. Please go home.',
    'FACT CHECK: That petal you saw fall? It is fine. Look away.',
  ];

  return { WORLD, LOTUS, PARTS, CORE, CORE_UNLOCK, OUTER, INNER, genMult, crowdMult, maxHp, radius, zone, biteTarget,
    BITE, swarmMult, MOVE, LEVELS, levelFor, nextLevelXp, UNLOCKS, has, TITLES, titleFor, sizeFor, ACHIEVEMENTS,
    randomName, bloomName, HEADLINES };
});
