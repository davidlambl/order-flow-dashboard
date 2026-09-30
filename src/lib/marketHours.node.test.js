// src/lib/marketHours.node.test.js — the market-data hook's pure clocks (Phase 5 (b)): which sessions are open at an
// instant (Eastern Time via shared/marketCalendar.js, holidays and early closes included), the refresh cadence per
// provider and its backoff after failures. marketHours.ts takes the time as an argument, so every instant here is
// fixed and nothing is stubbed; a source scan keeps it free of host globals and clock reads.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getBackoffMs, getRefreshMs, readMarketState } from './marketHours.js';

// The node project does not rewrite import.meta.url, so this is the file on disk.
const MARKET_HOURS_URL = new URL('./marketHours.ts', import.meta.url);

const HOST_GLOBALS = /\b(?:console|process|window|document|navigator|globalThis|fetch|require|localStorage|sessionStorage|Buffer|setTimeout|setInterval)\b/g;
// Reading the clock, as opposed to parsing a given instant: the module takes `now` as an argument.
const CLOCK_READS = /\bDate\.now\b|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\b/g;

/** Source without comments and with quoted strings blanked; template literals are kept (their ${} is code). */
const codeOnly = (src) => src.replace(
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (_, quoted, template) => (quoted ? "''" : template ?? ''),
);

const OPEN = { marketOpen: true, optionsMarketOpen: true, session: 'regular' };
const OPTIONS_ONLY = { marketOpen: false, optionsMarketOpen: true, session: 'post' };
const AFTER_HOURS = { marketOpen: false, optionsMarketOpen: false, session: 'post' };
const CLOSED = { marketOpen: false, optionsMarketOpen: false, session: 'closed' };

/** Assert readMarketState at each [label, ISO instant, expected] row. */
function assertStates(rows) {
  for (const [label, iso, expected] of rows) {
    assert.deepEqual(readMarketState(new Date(iso)), expected, `${label} (${iso})`);
  }
}

describe('marketHours', () => {
  describe('readMarketState', () => {
    it('a regular Friday: pre-market, open, equities closed with options open until 16:15 ET, then after hours', () => {
      // Friday 2026-09-25 is in EDT (UTC-4).
      assertStates([
        ['08:00 ET', '2026-09-25T12:00:00Z', { marketOpen: false, optionsMarketOpen: false, session: 'pre' }],
        ['09:30 ET', '2026-09-25T13:30:00Z', OPEN],
        ['11:00 ET', '2026-09-25T15:00:00Z', OPEN],
        ['16:00 ET', '2026-09-25T20:00:00Z', OPTIONS_ONLY],
        ['16:14 ET', '2026-09-25T20:14:00Z', OPTIONS_ONLY],
        ['16:14:30 ET', '2026-09-25T20:14:30Z', OPTIONS_ONLY],
        ['16:15 ET', '2026-09-25T20:15:00Z', AFTER_HOURS],
        ['20:00 ET', '2026-09-26T00:00:00Z', CLOSED],
      ]);
    });

    it('a Saturday and Thanksgiving are closed all day', () => {
      assertStates([
        ['Saturday 2026-09-26 11:00 ET', '2026-09-26T15:00:00Z', CLOSED],
        // Thanksgiving 2026-11-26 is in EST (UTC-5).
        ['Thanksgiving 09:30 ET', '2026-11-26T14:30:00Z', CLOSED],
        ['Thanksgiving 11:00 ET', '2026-11-26T16:00:00Z', CLOSED],
        ['Thanksgiving 16:10 ET', '2026-11-26T21:10:00Z', CLOSED],
      ]);
    });

    it('the early close on Friday 2026-11-27: equities stop at 13:00 ET, options at 13:15 ET', () => {
      assertStates([
        ['12:59 ET', '2026-11-27T17:59:00Z', OPEN],
        ['13:00 ET', '2026-11-27T18:00:00Z', OPTIONS_ONLY],
        ['13:14 ET', '2026-11-27T18:14:00Z', OPTIONS_ONLY],
        ['13:15 ET', '2026-11-27T18:15:00Z', AFTER_HOURS],
        ['16:10 ET, when a normal day would still trade options', '2026-11-27T21:10:00Z', AFTER_HOURS],
      ]);
    });

    it('returns a fresh object with only the three fields', () => {
      const now = new Date('2026-09-25T15:00:00Z');
      const a = readMarketState(now);
      assert.deepEqual(Object.keys(a).sort(), ['marketOpen', 'optionsMarketOpen', 'session']);
      assert.notEqual(readMarketState(now), a);
    });
  });

  describe('cadence', () => {
    it('getRefreshMs: 30 s for real-time Tradier, 60 s for the sandbox, CBOE, demo data and an unknown provider', () => {
      const table = [['tradier', 30_000], ['tradier-sandbox', 60_000], ['cboe', 60_000], ['mock', 60_000], [undefined, 60_000], [null, 60_000]];
      for (const [provider, ms] of table) assert.equal(getRefreshMs(provider), ms, `provider ${String(provider)}`);
    });

    it('getBackoffMs: the refresh interval doubles per consecutive failure, capped at 300 s', () => {
      const series = (provider) => [0, 1, 2, 3, 1e6].map((n) => getBackoffMs(provider, n));
      assert.deepEqual(series('cboe'), [60_000, 120_000, 240_000, 300_000, 300_000]);
      assert.deepEqual(series('tradier'), [30_000, 60_000, 120_000, 240_000, 300_000]);
      assert.equal(getBackoffMs(undefined, 1), 120_000, 'before the first payload the 60 s base applies');
    });
  });

  it('purity: marketHours.ts reads no host globals and never reads the clock', async () => {
    const code = codeOnly(await readFile(MARKET_HOURS_URL, 'utf8'));
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'src/lib/marketHours.ts must stay pure');
    assert.deepEqual(code.match(CLOCK_READS), null, 'src/lib/marketHours.ts must take the time as an argument, not read the clock');
  });
});
