// scripts/verify/store.mjs — Phase 3 checks; loaded by scripts/verify-functions.mjs with its helpers.
// store.js persistence rules: the key sets that decide what syncs, exports or clears, clearAll
// options, cross-tab notifications and import. deepEqual (used by hydrate) lives here too.
import { withGlobals } from './helpers.mjs';

const STORE_URL = new URL('../../src/lib/store.js', import.meta.url);
const DEEP_EQUAL_URL = new URL('../../src/lib/deepEqual.js', import.meta.url);

export default async function run(ctx) {
  console.log('store');
  const { t, assert } = ctx;

  await t('key sets: DEVICE_KEYS is the five secrets plus auth_skipped; LAYOUT_KEYS are the four layout prefs', async () => {
    await withGlobals({ localStorage: undefined, window: undefined }, async () => {
      const { SECRET_KEYS, DEVICE_KEYS, LAYOUT_KEYS } = await import(STORE_URL);
      assert.deepEqual([...SECRET_KEYS].sort(), ['ai_key_anthropic', 'ai_key_gemini', 'ai_key_openai', 'data_finnhub_key', 'data_tradier_key']);
      for (const key of SECRET_KEYS) assert.ok(DEVICE_KEYS.has(key), `${key} must be a device key`);
      assert.ok(DEVICE_KEYS.has('auth_skipped'), 'auth_skipped never leaves the device');
      assert.equal(DEVICE_KEYS.size, SECRET_KEYS.size + 1);
      assert.deepEqual([...LAYOUT_KEYS].sort(), ['section_charts', 'section_position', 'section_research', 'sidebarWidth']);
      for (const key of LAYOUT_KEYS) assert.ok(!DEVICE_KEYS.has(key), `${key} is synced, not device-only`);
    });
  });

  await t('deepEqual: key order ignored, arrays by index, nested values, primitives and null/undefined', async () => {
    const { deepEqual } = await import(DEEP_EQUAL_URL);
    assert.equal(deepEqual({ role: 'user', content: 'x' }, { content: 'x', role: 'user' }), true, 'JSONB reorders keys');
    assert.equal(deepEqual([{ a: 1, b: [1, 2] }], [{ b: [1, 2], a: 1 }]), true);
    assert.equal(deepEqual([1, 2], [2, 1]), false, 'array order matters');
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false, 'an extra key differs');
    assert.equal(deepEqual({ a: null }, { a: undefined }), false);
    assert.equal(deepEqual(null, null), true);
    assert.equal(deepEqual(null, {}), false);
    assert.equal(deepEqual([], {}), false, 'array vs object');
    assert.equal(deepEqual(101.5, 101.5), true);
    assert.equal(deepEqual('1', 1), false, 'no coercion');
    assert.equal(deepEqual(NaN, NaN), true);
  });
}
