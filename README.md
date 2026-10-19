# UPRISING

> You can't stomp all of us.

A satirical, real-time multiplayer browser game. Every room has a giant lotus that keeps
growing. Every player is one cockroach. One cockroach can't stop it. Fifty can.

## Run it locally

Requires **Node.js 22.13+** (the game uses Node's built-in SQLite).

```bash
npm install
npm start            # → http://localhost:8080
npm test             # unit tests
```

Open a few tabs to see the swarm. Phones on the same Wi-Fi can join at `http://<your-computer-ip>:8080`.

## How to play

| Action        | Desktop                         | Mobile               |
|---------------|---------------------------------|----------------------|
| Move          | Mouse (roach follows) or WASD   | Drag on left side    |
| Bite          | Hold **Space** or click         | Hold **BITE**        |
| Dash          | **Shift** / right-click         | **»**                |
| Rally (Lv 2)  | **R** next to a petal           | **⚑**                |
| Wings (Lv 3)  | **F**                           | **≋**                |
| Invite friends| Click the **ROOM** badge        | Tap the **ROOM** badge |

- **Rooms of 50.** You join the fullest room that still has space. Each room has its own lotus.
  The **ROOM** badge copies an invite link (`/r/<roomId>`) so friends land in your room.
- **National scoreboard.** Every lotus toppled in any room counts toward "lotuses toppled across India".
- **Swarm bonus.** Each cockroach near you adds +20% to your bites (up to ×2.6).
- **The lotus fights back:** the Chappal stomps crowds; shields rotate between Sealed Cover, Internet Shutdown (no rallies) and Section 144 (only groups of 3 or fewer can bite);
  the Godi Media Megaphone runs Breaking News with a decoy rally point; the Great Rebrand heals it once.
- **Jumla power-ups** look like rewards and backfire: Free Power-Up (launches you), Bullet Train
  (eternal delays), Free Wi-Fi (OTP loop), Note Exchange (your next 10 bites are void), Smart City
  (teleports you to a cardboard lotus), Free Gas Cylinder (floats you away), Achhe Din (reverses your controls).
- **Breaking News is shareable.** Tap **Share** on any headline for a 1200×630 news card.
- **Detention pod.** When the server is at capacity, newcomers are "preventively detained" in a
  police pod on the pond and released automatically, in order, as slots open.
- **Toppling a lotus:** 8 outer petals + 5 inner petals (need wings) + a seed core with "Z+ security"
  until 7 petals fall. Each toppled lotus leaves a permanent monument in the pond and a tougher one sprouts.

## Configuration

All settings are environment variables. The defaults suit a single small server.

| Variable          | Default               | What it does |
|-------------------|-----------------------|--------------|
| `PORT`            | `8080`                | HTTP + WebSocket port (Railway sets this) |
| `UPRISING_DB`     | `data/uprising.db`    | SQLite file. On Railway point it at the volume: `/data/uprising.db` |
| `ROOM_SIZE`       | `50`                  | Max cockroaches per room |
| `MAX_PLAYERS`     | `800`                 | Max playing at once across all rooms. Extra players wait in the detention pod. **This is your bandwidth/cost cap.** |
| `MAX_CONNECTIONS` | `MAX_PLAYERS×2+200`   | Hard cap on open sockets (players + spectators + detained) |
| `MAX_CONN_PER_IP` | `8`                   | Open sockets allowed per IP address |
| `TRUST_PROXY`     | off                   | Set to `1` behind a reverse proxy (Railway, Cloudflare) so per-IP limits see the real client IP |
| `ALLOWED_ORIGINS` | same host             | Comma-separated list of origins allowed to open a game socket, e.g. `https://uprising.lol` |

## Architecture

```
shared/                 Code used by BOTH the server and the browser
  rules.js              Lotus geometry, damage, levels, unlocks, names
  protocol.js           Binary wire format for positions and lotus state
  content.js            Headlines, Jumla power-ups, detention copy (edit jokes here)
server/
  index.js              HTTP (static files from memory), WebSocket gateway, matchmaking,
                        detention queue, main loop, persistence schedule
  room.js               One room: players, its lotus + hazards, bite validation, update stream
  lotus.js              The lotus: damage, growth, regeneration, regrowth, phases
  hazards.js            Chappal, Jumlas, Lotus Shield, Godi Media Megaphone
  progression.js        XP, levels, achievements (profiles cached while online)
  store.js              SQLite: profiles, rooms, national scoreboard
  sanitize.js           Name and id validation
public/
  index.html, style.css
  js/main.js            Client loop: local prediction, interpolation, events
  js/render.js          Canvas drawing: pond, lotus, roaches, hazards, detention pod
  js/hud.js             HUD: petals, leaderboard, abilities, toasts, banners
  js/news.js            Shareable Breaking News cards
  js/input.js, net.js, sfx.js
test/core.test.js       Unit tests (npm test)
```

**Authority.** The server owns everything that matters. Clients send *intent* (position, "bite",
"fly", "rally"); the server clamps movement to what's physically possible, picks the bite target,
checks cooldowns, wings, shields and the core lock, computes the swarm bonus from who is actually
nearby, and applies damage. Node is single-threaded, so concurrent bites and regeneration are applied
strictly in order.

**Bandwidth (= hosting cost).** Measured at about **3 KB/s per player in a full room of 50**.
- Positions and lotus state are binary: 9 bytes per cockroach, ~40 bytes per lotus update.
- Only cockroaches that moved or changed state are sent each tick, with a full keyframe every 2 s.
- Each update is encoded once per room and the same bytes go to every player in it.
- Background tabs get nothing; idle players (3 min) get 1 update/s; spectators and detainees 2/s.
  Players idle for 10 minutes are disconnected to free their slot.
- Larger JSON messages are compressed; static files are gzipped and cached with a per-deploy version.
- `MAX_PLAYERS` caps the total, so the worst case is known in advance.

**Persistence.** SQLite in WAL mode. Only changed rows are written, in one transaction every 5 s and
on shutdown. Empty rooms keep their lotus (it fast-forwards growth on the next visit) and are deleted
after 14 days unused; casual profiles (<50 XP) are pruned after 45 days.

## Deploying on Railway

1. Create a service from this GitHub repo. Railway detects Node and runs `npm start`.
2. Add a **volume** mounted at `/data`.
3. Set variables: `UPRISING_DB=/data/uprising.db`, `TRUST_PROXY=1`, and optionally `MAX_PLAYERS`.
4. Generate a domain (or attach your own). Health check path: `/health`.
5. In workspace billing, set a **hard usage limit** so the bill can never surprise you.

Keep it to **one replica**: the game state lives in that process (see "Scaling" below).

## Scaling later

One process comfortably runs a few hundred concurrent players. Because rooms are independent, scaling
out is straightforward: run several processes, route each room id to one process (e.g. a small router
or consistent hashing on the id), and move the national scoreboard and profiles to a shared database
(Postgres) instead of the local SQLite file.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and what is in place.

## Satire note

The lotus is a party symbol; the cockroaches are everyone who has been told they don't count. No real
people are depicted. The headlines in `shared/content.js` punch at power and spin, never at players.
