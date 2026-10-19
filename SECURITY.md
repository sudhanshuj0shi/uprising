# Security notes

UPRISING has no accounts, passwords, payments or personal data. A player is a random 128-bit token
kept in their browser's localStorage. The main risks are cheating, abuse of shared text (names),
denial of service and a large hosting bill. This file lists what is in place and what is not.

## In place

**Server authority (anti-cheat)**
- Clients only send intent. Movement is speed-clamped server-side; teleports, knockbacks and stuns
  are decided by the server. Bites, damage, cooldowns, wings, the core lock and the swarm bonus are
  all computed server-side. XP and achievements are granted only by the server.

**Input validation**
- Every WebSocket message is size-capped (1 KB) and parsed defensively; unknown or malformed
  messages are ignored, and a handler error can never crash the process.
- Names: Unicode-normalised, control / zero-width / bidi-override characters and HTML punctuation
  stripped, max 24 characters (`server/sanitize.js`). Names are also HTML-escaped in the HUD and
  drawn as plain text on canvases.
- Tokens and room ids must match strict patterns before they are used.
- SQLite access uses prepared statements only (no string-built SQL).

**Abuse and denial of service**
- Per-connection rate limit (40 messages/s; sustained floods are disconnected with code 1008).
- Per-IP connection limit (`MAX_CONN_PER_IP`) and a global connection cap (`MAX_CONNECTIONS`).
- Player cap (`MAX_PLAYERS`) with a queue, which also bounds bandwidth cost.
- Backpressure: slow clients are skipped rather than buffering unbounded data in memory.
- Dead connections are detected with ping/pong and closed; idle players are disconnected.
- Room creation only happens through matchmaking, and in-memory rooms are capped.

**Web hardening**
- Static files are loaded into memory at boot and looked up by exact path, so no filesystem path
  is ever built from a URL (no path traversal). Only GET/HEAD are allowed.
- Headers: strict Content-Security-Policy (scripts only from this origin, no inline scripts, no
  framing), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, `X-Frame-Options: DENY`, and HSTS when served over HTTPS.
- WebSocket upgrades from other websites' origins are rejected (configurable via `ALLOWED_ORIGINS`).
- Behind a proxy, set `TRUST_PROXY=1`; only the right-most `X-Forwarded-For` entry (the one the
  proxy appended) is trusted.
- Dependencies: one runtime package (`ws`). `npm audit` reports 0 vulnerabilities at the time of writing.

## Known limitations

- **Tokens are bearer secrets.** Anyone who copies a player's localStorage token can play as them.
  There's nothing of value to steal, so this is accepted.
- **Names are not moderated.** Offensive names are possible. Add a word filter in `cleanName` if needed.
- **Volumetric DDoS** (huge numbers of IPs) must be handled upstream, e.g. by putting Cloudflare
  in front of the domain. Rate limits here only protect against single abusive clients.
- **Bots.** A scripted client can play like a human (and only like a human, given the server checks).
  The swarm bonus and leaderboard could be farmed by many bot connections from many IPs.
- `style-src` allows `'unsafe-inline'` for a few computed inline styles; scripts remain strictly
  same-origin.

## Reporting

Please report security issues privately to the repository owner rather than opening a public issue.
