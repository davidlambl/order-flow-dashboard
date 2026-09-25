// netlify/functions/lib/quota.js
// Per-token daily request quota and usage logging for calls made with the
// server's own LLM key. Both are backed by the usage_log table (migration 004).
// When Supabase is not configured the quota cannot be enforced; that is logged
// once so the operator knows.

const DEFAULT_QUOTA = { trial: 50, pro: 500 };
let warnedNoSupabase = false;

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function dailyQuotaFor(tier) {
  const envKey = tier === 'pro' ? 'DAILY_REQUEST_QUOTA_PRO' : 'DAILY_REQUEST_QUOTA_TRIAL';
  const n = Number(process.env[envKey]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTA[tier] ?? DEFAULT_QUOTA.trial;
}

function utcMidnightIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * @returns {Promise<{ok:boolean, used:number, limit:number, enforced:boolean}>}
 */
export async function checkDailyQuota({ sub, tier }) {
  const limit = dailyQuotaFor(tier);
  if (!supabaseConfigured()) {
    if (!warnedNoSupabase) {
      console.warn('usage quota not enforced: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
      warnedNoSupabase = true;
    }
    return { ok: true, used: 0, limit, enforced: false };
  }
  try {
    const { getSupabaseAdmin } = await import('./supabaseAdmin.js');
    const { count, error } = await getSupabaseAdmin()
      .from('usage_log')
      .select('id', { count: 'exact', head: true })
      .eq('sub', sub)
      .eq('key_source', 'server')
      .gte('created_at', utcMidnightIso());
    if (error) throw new Error(error.message);
    const used = count ?? 0;
    return { ok: used < limit, used, limit, enforced: true };
  } catch (err) {
    // Fail closed on quota lookup errors: a broken quota table must not become
    // an unlimited-spend path.
    console.error('quota lookup failed:', err.message);
    return { ok: false, used: 0, limit, enforced: true, error: err.message };
  }
}

/** Fire-and-forget usage record. Never throws. */
export async function logUsage({ sub, tier, provider, model, stream, keySource, requestId }) {
  if (!supabaseConfigured()) return;
  try {
    const { getSupabaseAdmin } = await import('./supabaseAdmin.js');
    const { error } = await getSupabaseAdmin().from('usage_log').insert({
      sub: sub || null,
      tier: tier || null,
      provider,
      model: model || null,
      stream: Boolean(stream),
      key_source: keySource,
      request_id: requestId || null,
    });
    if (error) console.warn('usage_log insert failed:', error.message);
  } catch (err) {
    console.warn('usage_log insert failed:', err.message);
  }
}
