// src/lib/ticker.node.test.js — the client's ticker rule (src/lib/ticker.ts) held to the server's
// (netlify/functions/lib/ticker.ts). The header refuses what every function would refuse with INVALID_TICKER, and the
// client repeats the server's pattern rather than importing it: src/ never imports netlify/. A test in src/ that imports
// the server module is the allowed direction, so this one does, by the module's real path, and compares the two
// modules themselves, never a copy of the pattern written here: a change on either side fails it until the other
// follows. Both modules are pure and import nothing, so this runs under Node with no DOM.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TICKER_RE, parseTicker } from './ticker.js';
import { TICKER_RE as SERVER_TICKER_RE, parseTicker as serverParseTicker } from '../../netlify/functions/lib/ticker.ts';

/** [input, what both parseTickers answer]: the expected column documents the rule; the pin is the agreement. */
const CASES = [
  ['AVGO', 'AVGO'], // valid as typed
  ['brk.b', 'BRK.B'], // lower case, with a dot after the first character
  ['RDS-A', 'RDS-A'], // a dash after the first character
  ['  nvda  ', 'NVDA'], // padded with spaces
  ['\tMSFT\n', 'MSFT'], // padded with other white space
  ['A', 'A'], // the shortest
  ['ABCDEFGHIJ', 'ABCDEFGHIJ'], // the longest: ten characters
  ['ABCDEFGHIJK', null], // eleven: too long
  ['TOOLONGTICKER', null], // too long
  ['../../x', null], // a path
  ['../x', null],
  ['.A', null], // a dot first
  ['-A', null], // a dash first
  ['A B', null], // a space inside
  ['A/B', null],
  ['ÄPFEL', null], // a letter outside A–Z
  ['', null], // empty
  ['   ', null], // blank
  [42, null], // a number
  [null, null],
  [undefined, null],
  [['AVGO'], null], // an array holding a valid ticker
  [{ toString: () => 'AVGO' }, null], // an object that stringifies to one
];

describe('ticker: the client mirrors the server', () => {
  it("Pin: TICKER_RE has the server's source and flags", () => {
    assert.equal(TICKER_RE.source, SERVER_TICKER_RE.source);
    assert.equal(TICKER_RE.flags, SERVER_TICKER_RE.flags);
  });

  it("Pin: parseTicker answers as the server's does on every case", () => {
    for (const [raw, expected] of CASES) {
      const label = JSON.stringify(raw) ?? String(raw);
      assert.equal(parseTicker(raw), serverParseTicker(raw), `the two parseTickers disagree on ${label}`);
      assert.equal(parseTicker(raw), expected, `parseTicker(${label})`);
    }
  });
});
