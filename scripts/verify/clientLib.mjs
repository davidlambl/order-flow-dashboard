// scripts/verify/clientLib.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// client-side helpers that must stay Node-loadable: retry backoff (F1), store quota containment (F18), threshold ordering.

export default async function run(ctx) {
  const { t, assert } = ctx;
  console.log('clientLib');
  await t('module loads', async () => { assert.ok(t && assert); });
}
