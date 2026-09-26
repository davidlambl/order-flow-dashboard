// netlify/functions/__tests__/getModels.test.js — the model list: the server key only for access-token holders,
// and a BYOK Gemini key sent in the x-goog-api-key header, never in the URL.
import { describe, it } from 'vitest';
import getModels from '../getModels.js';
import { installFunctionHarness } from '../../../test/helpers/functions.js';

const { calls, setFetch, req, json, assert, SECRET } = installFunctionHarness();

describe('getModels', () => {
  it('server key without token → 401; BYOK gemini uses header', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
    const r = await json(await getModels(req('getModels?provider=anthropic'))); assert.equal(r.status, 401); assert.equal(calls.length, 0);
    setFetch(async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.0-flash', displayName: 'F', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 }));
    const r2 = await json(await getModels(req('getModels?provider=gemini', { headers: { 'x-api-key': 'AIzaK' } })));
    assert.equal(r2.status, 200); assert.equal(r2.body.models[0].id, 'gemini-2.0-flash'); assert.ok(!calls[0].url.includes('AIzaK')); assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaK');
  });
});
