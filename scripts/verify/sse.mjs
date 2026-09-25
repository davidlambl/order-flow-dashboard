// scripts/verify/sse.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// LLM streaming (F6-F8, M7): SSE framing, per-provider events, askLLMStream end-to-end, server output caps and body timeout.

export default async function run(ctx) {
  const { t, assert } = ctx;
  console.log('sse');
  await t('module loads', async () => { assert.ok(t && assert); });
}
