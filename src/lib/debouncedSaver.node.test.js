// src/lib/debouncedSaver.node.test.js — the debounced saver behind useAutoSave (src/lib/debouncedSaver.js):
// baseline compare instead of a skip flag, one save per edit burst, flush and cancel. Timers are injected from the
// shared fake clock (test/helpers/globals.js), so nothing waits.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSaver } from './debouncedSaver.js';
import { fakeClock } from '../../test/helpers/globals.js';

const SAVER_URL = new URL('./debouncedSaver.js', import.meta.url);
const DELAY = 600;
// Browser and host globals the saver must not touch (globalThis is allowed: it backs the default timers).
const HOST_GLOBALS = /\b(?:window|document|navigator|localStorage|sessionStorage|console|process|require)\b/g;

/** A saver on a fake clock, with a recording save function and an onSaved counter. */
async function setup(options = {}) {
  const clock = fakeClock();
  const writes = [];
  const counts = { onSaved: 0 };
  const saver = createSaver({
    delay: DELAY,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onSaved: () => { counts.onSaved++; },
    ...options,
  });
  return { saver, clock, writes, counts, save: (value) => { writes.push(value); } };
}

describe('saver', () => {
  it('schedule() of the primed value writes nothing and returns false (a reopened modal saves nothing)', async () => {
    const { saver, clock, writes, counts, save } = await setup();
    saver.prime('sk-loaded');
    assert.equal(saver.schedule('sk-loaded', save), false);
    assert.equal(saver.isPending(), false);
    assert.equal(clock.queued, 0, 'no timer is started for an unchanged value');
    clock.advance(10 * DELAY);
    assert.deepEqual(writes, []);
    assert.equal(counts.onSaved, 0);
    assert.equal(saver.flush(), false, 'nothing to flush');
  });

  it('the first edit after prime() is saved, once, after the delay (D7: a key pasted in one go into an empty field)', async () => {
    const { saver, clock, writes, counts, save } = await setup();
    saver.prime('');
    assert.equal(saver.schedule('sk-pasted', save), true);
    clock.advance(DELAY - 1);
    assert.deepEqual(writes, [], 'nothing is written inside the delay');
    assert.equal(saver.isPending(), true);
    clock.advance(1);
    assert.deepEqual(writes, ['sk-pasted']);
    assert.equal(counts.onSaved, 1);
    assert.equal(saver.isPending(), false);
    clock.advance(10 * DELAY);
    assert.deepEqual(writes, ['sk-pasted'], 'exactly one save');
    assert.equal(counts.onSaved, 1);
  });

  it('edits inside the delay coalesce into one save of the last value, timed from the last edit', async () => {
    const { saver, clock, writes, counts, save } = await setup();
    saver.prime('');
    saver.schedule('s', save);
    clock.advance(DELAY - 100);
    saver.schedule('sk', save);
    clock.advance(DELAY - 100);
    assert.deepEqual(writes, [], 'the second edit restarted the delay');
    assert.equal(clock.queued, 1, 'the first timer was cleared, not left to fire');
    clock.advance(100);
    assert.deepEqual(writes, ['sk']);
    assert.equal(counts.onSaved, 1);
  });

  it('flush() saves the pending value at once, returns true and fires onSaved; a second flush() returns false', async () => {
    const { saver, clock, writes, counts, save } = await setup();
    saver.prime('');
    saver.schedule('sk-closed-early', save);
    assert.equal(saver.flush(), true);
    assert.deepEqual(writes, ['sk-closed-early']);
    assert.equal(counts.onSaved, 1, 'onSaved fires for a flush too');
    assert.equal(clock.queued, 0, 'the flushed timer is cleared');
    assert.equal(saver.flush(), false);
    clock.advance(10 * DELAY);
    assert.deepEqual(writes, ['sk-closed-early'], 'the value is not saved a second time');
    assert.equal(counts.onSaved, 1);
    assert.equal(saver.schedule('sk-closed-early', save), false, 'the written value is the new baseline');
  });

  it('cancel() drops the pending save and its timer; prime() does too (Reset all settings)', async () => {
    const { saver, clock, writes, counts, save } = await setup();
    saver.prime('');
    saver.schedule('sk-typed', save);
    saver.cancel();
    assert.equal(saver.isPending(), false);
    assert.equal(clock.queued, 0);
    clock.advance(10 * DELAY);
    assert.equal(saver.flush(), false);
    saver.schedule('sk-typed-again', save);
    saver.prime('');
    assert.equal(saver.isPending(), false);
    assert.equal(clock.queued, 0);
    clock.advance(10 * DELAY);
    assert.deepEqual(writes, [], 'neither dropped edit was written');
    assert.equal(counts.onSaved, 0);
  });

  it('editing back to the primed value cancels the pending save (type a character, delete it: nothing written)', async () => {
    const { saver, clock, writes, counts, save } = await setup();
    saver.prime('sk-a');
    assert.equal(saver.schedule('sk-ab', save), true);
    assert.equal(saver.schedule('sk-a', save), false);
    assert.equal(saver.isPending(), false);
    assert.equal(clock.queued, 0);
    clock.advance(10 * DELAY);
    assert.deepEqual(writes, []);
    assert.equal(counts.onSaved, 0);
  });

  it('a pending save runs with the function it was scheduled with (provider switch: the key lands under the old provider)', async () => {
    const { saver, clock } = await setup();
    const stored = {};
    const calls = [];
    const saveFor = (provider) => (value) => { calls.push([provider, value]); stored[`ai_key_${provider}`] = value; };
    // AppSettings: edit, flush before switching provider, prime with the new provider's key, edit again.
    saver.prime('');
    saver.schedule('sk-ant-1', saveFor('anthropic'));
    assert.equal(saver.flush(), true);
    saver.prime('');
    saver.schedule('sk-oai-2', saveFor('openai'));
    clock.advance(DELAY);
    assert.deepEqual(stored, { ai_key_anthropic: 'sk-ant-1', ai_key_openai: 'sk-oai-2' });
    assert.deepEqual(calls, [['anthropic', 'sk-ant-1'], ['openai', 'sk-oai-2']], 'each value was saved only by its own function');
    // A value and its save function travel together: a later schedule replaces both, never just one.
    calls.length = 0;
    saver.schedule('k3', saveFor('anthropic'));
    saver.schedule('k4', saveFor('gemini'));
    clock.advance(DELAY);
    assert.deepEqual(calls, [['gemini', 'k4']]);
  });

  it('the isEqual option decides what is unchanged (a field-wise compare; the default is Object.is)', async () => {
    const sameFields = (a, b) => a?.costBasis === b?.costBasis && a?.shares === b?.shares;
    const { saver, clock, writes, save } = await setup({ isEqual: sameFields });
    saver.prime({ costBasis: 100, shares: 10 });
    assert.equal(saver.schedule({ costBasis: 100, shares: 10 }, save), false, 'a fresh object with the same fields is unchanged');
    assert.equal(saver.schedule({ costBasis: 101, shares: 10 }, save), true);
    clock.advance(DELAY);
    assert.deepEqual(writes, [{ costBasis: 101, shares: 10 }]);
    assert.equal(saver.schedule({ shares: 10, costBasis: 101 }, save), false, 'compared with the written value, the new baseline');
    const plain = await setup();
    plain.saver.prime({ costBasis: 100, shares: 10 });
    assert.equal(plain.saver.schedule({ costBasis: 100, shares: 10 }, plain.save), true, 'Object.is: a fresh object is a change');
  });

  it('debouncedSaver.js is import-free and touches no browser or host globals', async () => {
    // Strip comments (keeping string literals, so a '//' inside a string is not taken for one).
    const src = await readFile(SAVER_URL, 'utf8');
    const code = src.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? '');
    assert.doesNotMatch(code, /^\s*import\b|\bimport\s*\(/m, 'debouncedSaver.js must stay import-free');
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'debouncedSaver.js must stay pure');
  });
});
