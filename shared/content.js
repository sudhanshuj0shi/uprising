// UPRISING — satirical content: Breaking News headlines and Jumla power-ups.
//
// Kept apart from the game rules so writers can add jokes without touching code.
// Loaded by the server (which decides WHEN news breaks) and by the browser
// (which draws the Jumla stands and the shareable news cards).
//
// House style: punch at the lotus, the spin machine and the system, never at the
// players and never at real, named individuals. Short enough to read in a ticker.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CONTENT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // The fictional channel that runs the ticker and the share cards.
  const CHANNEL = { name: 'GODI 24×7', slogan: 'News You Can Bow To' };

  // ---------------------------------------------------------------- general headlines
  // Fired by the Godi Media Megaphone every minute or two.
  const HEADLINES = [
    'Lotus grows 400%, confirms survey conducted by lotus',
    'Cockroaches actually enjoy being stepped on, says survey of zero cockroaches',
    'Petal loss is actually petal gain, clarify experts in matching kurtas',
    'Panel of 9 shouts for 2 hours on whether cockroaches are real; no conclusion, great TRP',
    'Swarm funded by foreign hand. Hand unavailable for comment',
    'Biting the lotus is anti-development. Please go home and do yoga',
    'FACT CHECK: That petal you saw fall? It did not. Look away. Thank you',
    'Ministry forms committee to study the need for a committee on cockroaches',
    'Lotus not shrinking, it is a "minimalist redesign", says IT cell',
    'Unemployment solved: every cockroach now registered as a self-employed biter',
    'Swarm declared anti-national; swarm points out it is literally the nation',
    'Lotus wins "Most Transparent Flower" award. Jury also lotus',
    'Exclusive: Lotus to build world\'s tallest petal, foundation stone laid 6 times',
    'New rule: cockroaches must show 11 documents to prove they were always cockroaches',
    'Petal shortage blamed on 1950s, investigation ongoing',
    'Inflation is a myth, says anchor buying petals at ₹400 per kg',
    'Lotus launches app to report cockroaches. App asks for your location, contacts and soul',
    'Opposition cockroach caught asking question. Debate tonight: "Why so negative?"',
    'Breaking: Lotus to rename the pond. Fish to be informed later',
    'Data shows zero cockroaches on lotus. Data collection stopped in 2019',
    'Lotus says criticism welcome, as long as it is praise',
    'Cockroaches spotted reading. Authorities "monitoring the situation"',
    'Free petals for all announced. Terms and conditions to be announced',
    'Lotus GDP (Gross Damage to Petals) at record high, called "temporary turbulence"',
    'Swarm\'s demands "too complex", says lotus who has never read them',
    'Nation wants to know why cockroach asked nation what it wants to know',
    'Lotus to fight cockroaches with a mega event featuring 10,000 drones and no plan',
    'Viral video of petal falling is "deepfake", says lotus, deleting video',
    'Anchor demands cockroaches apologise for being hungry',
    'New scheme: every cockroach to get ₹15 lakh in "experience points"',
    'Lotus announces Amrit Kaal for petals. Cockroaches announce lunch',
    'Pond water quality "world class", says lotus, from bottled water',
    'Cockroaches told to "go to Pakistan". Cockroaches point out they are already in the pond',
    'Study finds 9 out of 10 anchors prefer shouting to news',
    'Lotus increases security around core. Security asks to see your caste certificate',
    'Petal sustained "minor scratch", says lotus, standing in a stump',
    'Lotus says swarm is "small fringe element". Fringe element now 3,000 strong',
    'Lotus thanks cockroaches for their patience, asks for 5 more years',
    'Lotus accepts no responsibility for lotus, blames gravity, wind and Nehru\'s ceiling fan',
    'Exclusive: nothing happened today. Tune in for 6 hours of coverage',
  ];

  // ---------------------------------------------------------------- headlines that react to the room
  // `{name}`, `{count}`, `{bloom}` are filled in by the server. Names are always sanitised.
  const REACTIVE = {
    petalDown: [
      'Petal fell due to previous government, say experts',
      'Petal "voluntarily retired to spend more time with family", clarifies lotus',
      '{count} cockroaches eat petal; anchor asks why they hate petals so much',
      'Petal loss "a masterstroke", lotus spokesperson explains for 40 minutes',
      'Petal down. Lotus announces new petal will be ready in 2047',
    ],
    rally: [
      'Peaceful gathering of cockroaches called by {name} declared "unlawful assembly"',
      '{name} seen pointing at petal. Sedition case filed against index finger',
      'Toolkit discovered: {name} told cockroaches where the petal is',
    ],
    rebrand: [
      'Lotus rebrands as {bloom}. Same petals, new font, 300% more saffron',
      'In historic first, lotus paints itself gold and declares the problem solved',
    ],
    coreDown: [
      '{bloom} has fallen. Channel to run 24-hour special: "Was it ever really there?"',
      'Lotus falls; spokesperson says this was the plan all along',
      'BREAKING: Lotus "stepping back to focus on new lotus"',
    ],
    stompMany: [
      'Chappal misses {count} cockroaches, declares "surgical strike" a success',
      'Chappal operation "100% successful", says chappal, missing everyone',
    ],
    jumla: [
      'New power-up announced! Cockroaches advised not to read the fine print',
      'Development is coming. Please wait at the platform. Forever',
    ],
    sealed: [
      'Petal placed in sealed cover; contents to be revealed after the next five elections',
      'Court asks to see petal. Petal submitted in sealed cover. Court satisfied',
    ],
    shutdown: [
      'Internet suspended on petals "to maintain law and order"; lotus posts 40 selfies',
      'Petal network shut down for your safety. Lotus Wi-Fi unaffected',
    ],
    sec144: [
      'Section 144 imposed on petals. Groups of 4 cockroaches declared "a mob"',
      'Cockroaches told to protest in groups of three, at the designated protest site, 40 km away',
    ],
    newGen: [
      'Introducing {bloom}: bigger, shinier, 0% different',
      'New lotus inaugurated with ribbon cutting, drone show and zero petals ready',
    ],
  };

  // ---------------------------------------------------------------- Jumla power-ups
  // Each one looks like a reward and backfires. `effect` is implemented by the server
  // (authoritative) and animated by the client. Durations in ms.
  const JUMLAS = {
    cannon:   { label: 'FREE POWER-UP!',          sub: '15 LAKH XP*',           effect: 'launch',  ms: 1200,
      caught: 'The Jumla Cannon promised 15 lakh XP. You received 3, and a trip.' },
    bullet:   { label: 'BULLET TRAIN TO THE CORE', sub: 'Arriving 2026',        effect: 'freeze',  ms: 4500,
      caught: 'You waited for the Bullet Train. It is now arriving in 2035.',
      bubble: ['Arriving 2026', 'Delayed: 2029', 'Delayed: 2035', 'CANCELLED'] },
    wifi:     { label: 'FREE WI-FI ZONE',          sub: 'Unlimited speed*',     effect: 'freeze',  ms: 3500,
      caught: 'Free Wi-Fi requires OTP, Aadhaar, PAN and a selfie with your ration card.',
      bubble: ['Connecting…', 'Enter OTP', 'OTP expired', 'Link Aadhaar to continue'] },
    notes:    { label: 'NOTE EXCHANGE',            sub: '2× bite power!',       effect: 'void',    bites: 10,
      caught: 'Your next 10 bites are in old notes. They are no longer legal tender.' },
    smart:    { label: 'SMART CITY',               sub: 'Fast-track to the lotus', effect: 'teleport', ms: 15000,
      caught: 'Welcome to the Smart City. The lotus is cardboard. Phase 2 coming soon.' },
    cylinder: { label: 'FREE GAS CYLINDER',        sub: 'For every cockroach!', effect: 'float',   ms: 2600,
      caught: 'The free cylinder was empty, but it did float you very far away.' },
    achhe:    { label: 'ACHHE DIN',                sub: 'Loading… 99%',         effect: 'uturn',   ms: 5000,
      caught: 'Achhe Din took a U-turn. So did your legs.' },
  };
  const JUMLA_KINDS = Object.keys(JUMLAS);

  // ---------------------------------------------------------------- Lotus shields
  // Every so often the lotus protects a few petals. Each event picks one of these.
  //   sealed   — bites barely scratch it (×0.15).
  //   shutdown — same, AND rallies can't target it ("no network").
  //   sec144   — small groups (≤ SEC144_MAX) bite at FULL damage; a bigger crowd is
  //              "dispersed" and does nothing. The swarm has to split up.
  const SHIELDS = {
    sealed:   { label: 'SEALED COVER', sub: 'Contents classified', hit: 'SEALED',
      toast: '📁 SEALED COVER on some petals. Hearing adjourned.' },
    shutdown: { label: 'INTERNET SHUTDOWN', sub: 'No signal', hit: 'BUFFERING…',
      toast: '📵 INTERNET SHUTDOWN on some petals. No bites, no rallies.' },
    sec144:   { label: 'SECTION 144', sub: 'No gathering of 4+', hit: 'DISPERSE!',
      toast: '🚧 SECTION 144: groups of 3 or fewer only!' },
  };
  const SHIELD_KINDS = Object.keys(SHIELDS);

  // The waiting room is a detention pod on the pond: when the server is at capacity,
  // extra cockroaches are "preventively detained" before they reach the protest site.
  const DETENTION = {
    sign: 'PREVENTIVE DETENTION',
    lines: [
      'Detained before reaching the protest site. For your own safety.',
      'You have the right to remain silent. You also have no other rights.',
      'Section 144 imposed on the pond. Release in order of arrest.',
      'Your detention is temporary, like all permanent things.',
      'Please hold. Your patience is important to the lotus.',
      'Kindly wait while we verify you are a genuine cockroach.',
    ],
    released: 'RELEASED. No charges filed. No apology either.',
  };
  // Where the pod sits in the world (bottom-left shore of the pond).
  const POD = { x: 520, y: 2720, r: 150 };

  return { CHANNEL, HEADLINES, REACTIVE, JUMLAS, JUMLA_KINDS, SHIELDS, SHIELD_KINDS, DETENTION, POD };
});
