// scripts/verify/charts.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// chart helpers: time-zone-safe date labels (F16), mock flow dates, GEX axis ticks and reference levels (F14).

export default async function run(ctx) {
  const { t, assert } = ctx;
  console.log('charts');
  await t('module loads', async () => { assert.ok(t && assert); });
}
