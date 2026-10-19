// Input hygiene for anything a player can type. Kept tiny and separate so it is easy to test.

// Characters never allowed in a name:
//   C0/C1 control characters, zero-width and directional marks (U+200B–U+200F),
//   bidi embedding/override (U+202A–U+202E), invisible operators and isolates
//   (U+2060–U+206F), byte-order mark, and HTML-significant punctuation.
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>&"'`]/g;

/**
 * Player names: printable text only, max 24 characters. Names are ALSO escaped wherever
 * they are shown (HTML) or drawn as plain text (canvas), so this is defence in depth.
 */
function cleanName(n) {
  return String(n || '').normalize('NFKC')
    .replace(/\s+/g, ' ')          // newlines/tabs become spaces first…
    .replace(FORBIDDEN, '')        // …then everything invisible or markup-ish goes
    .trim().slice(0, 24);
}

const TOKEN_RE = /^[a-f0-9]{32}$/;       // player tokens: 128 random bits as hex
const ROOM_RE = /^[a-z0-9]{4,12}$/;      // room ids in invite links

module.exports = { cleanName, TOKEN_RE, ROOM_RE };
