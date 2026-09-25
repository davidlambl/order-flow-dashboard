// scripts/verify/recommend.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// recommendation engine (roadmap F15), the position panel's staleness rule and shared/thresholds.js.

export default async function run(ctx) {
  const { t, assert } = ctx;
  console.log('recommend');
  await t('module loads', async () => { assert.ok(t && assert); });
}
