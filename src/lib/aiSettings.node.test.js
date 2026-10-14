// src/lib/aiSettings.node.test.js — the AI providers and the readers of the AI preferences (src/lib/aiSettings.ts):
// it loads with no DOM; the picker's providers and their lookups; what getAISettings and readAiModelName read from an
// empty store, from the user's settings and from a value outside the string contract. Each read runs on a storage of
// its own; store.js reads localStorage when called, never at import, so one module instance serves every test.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AI_PROVIDERS, KEY_PREF, getAISettings, isLlmProvider, providerMeta, readAiModelName } from './aiSettings.js';
import { memoryStorage, withGlobals } from '../../test/helpers/globals.js';

/** Runs fn with a localStorage holding each value JSON-encoded under its key, as the store writes a preference. */
function withStored(values, fn) {
  const storage = memoryStorage();
  for (const [key, value] of Object.entries(values)) storage.setItem(key, JSON.stringify(value));
  return withGlobals({ localStorage: storage }, fn);
}

describe('aiSettings', () => {
  it('Node-loadable: aiSettings.js imports with no DOM (no window, document or localStorage)', async () => {
    await withGlobals({ window: undefined, document: undefined, localStorage: undefined }, async () => {
      vi.resetModules();
      const fresh = await import('./aiSettings.js'); // fresh instance, loaded without the globals
      assert.equal(fresh.providerMeta('gemini')?.label, 'Gemini');
      assert.equal(fresh.isLlmProvider('openai'), true);
      for (const name of ['getAISettings', 'readAiModelName']) assert.equal(typeof fresh[name], 'function', name);
    });
  });

  it("AI_PROVIDERS: the picker's providers in its order; Anthropic alone has a server key and the star", () => {
    assert.deepEqual(AI_PROVIDERS, [
      { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-...', needsKey: false, recommended: true },
      { id: 'gemini', label: 'Gemini', hint: 'AIza...', needsKey: true },
      { id: 'openai', label: 'OpenAI', hint: 'sk-...', needsKey: true },
    ]);
  });

  it('providerMeta: the entry for each of the three ids; undefined for an unknown id', () => {
    assert.equal(providerMeta('anthropic'), AI_PROVIDERS[0]);
    assert.equal(providerMeta('gemini'), AI_PROVIDERS[1]);
    assert.equal(providerMeta('openai'), AI_PROVIDERS[2]);
    for (const id of ['mistral', '', 'Anthropic', 'constructor']) assert.equal(providerMeta(id), undefined, `'${id}'`);
  });

  it("KEY_PREF and isLlmProvider: each provider's key preference, and only a provider's id indexes it", () => {
    assert.deepEqual(KEY_PREF, { anthropic: 'ai_key_anthropic', openai: 'ai_key_openai', gemini: 'ai_key_gemini' });
    for (const id of ['anthropic', 'openai', 'gemini']) assert.equal(isLlmProvider(id), true, id);
    for (const id of ['mistral', '', 'Gemini', 'constructor', 'toString', '__proto__', null, undefined, 1, {}]) {
      assert.equal(isLlmProvider(id), false, String(id));
    }
  });

  it("getAISettings with an empty store: Anthropic, the server's default model, the name 'Default', no key", async () => {
    await withStored({}, async () => {
      assert.deepEqual(getAISettings(), { provider: 'anthropic', model: '', modelName: 'Default', apiKey: '' });
    });
  });

  it("getAISettings reads back the stored provider, model, name and that provider's key, at each call", async () => {
    const stored = {
      ai_provider: 'gemini', ai_model: 'gemini-2.5-pro', ai_model_name: 'Gemini 2.5 Pro',
      ai_key_gemini: 'AIza-mine', ai_key_anthropic: 'sk-ant-other', ai_key_openai: 'sk-other',
    };
    await withStored(stored, async () => {
      assert.deepEqual(getAISettings(), {
        provider: 'gemini', model: 'gemini-2.5-pro', modelName: 'Gemini 2.5 Pro', apiKey: 'AIza-mine',
      });
      localStorage.setItem('ai_model', JSON.stringify('gemini-2.5-flash'));
      assert.equal(getAISettings().model, 'gemini-2.5-flash', 'read at the call, never cached');
    });
    await withStored({ ...stored, ai_provider: 'openai' }, async () => {
      assert.equal(getAISettings().apiKey, 'sk-other');
    });
    await withStored({ ai_key_anthropic: 'sk-ant-mine' }, async () => {
      assert.equal(getAISettings().apiKey, 'sk-ant-mine', "no stored provider: Anthropic's key");
    });
  });

  it("getAISettings: a stored key that is not a string reads as no key ('')", async () => {
    for (const value of [12345, true, { key: 'sk-ant-x' }, ['sk-ant-x']]) {
      await withStored({ ai_key_anthropic: value }, async () => {
        assert.equal(getAISettings().apiKey, '', JSON.stringify(value));
      });
    }
  });

  it("readAiModelName: the stored name, else 'Default' (none, '' or not a string), as getAISettings reads it", async () => {
    await withStored({ ai_model_name: 'Claude X' }, async () => {
      assert.equal(readAiModelName(), 'Claude X');
      assert.equal(getAISettings().modelName, 'Claude X');
    });
    for (const value of ['', { a: 1 }, 42, true, ['Claude X']]) {
      await withStored({ ai_model_name: value }, async () => {
        assert.equal(readAiModelName(), 'Default', JSON.stringify(value));
        assert.equal(getAISettings().modelName, 'Default', `getAISettings, ${JSON.stringify(value)}`);
      });
    }
    await withStored({}, async () => {
      assert.equal(readAiModelName(), 'Default', 'none stored');
    });
  });
});
