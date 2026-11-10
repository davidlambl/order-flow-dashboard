// netlify/functions/lib/quota.ts
// Per-token daily request quota and usage logging for calls made with the
// server's own LLM key. Both are backed by the usage_log table (migration 004).
// When Supabase is not configured the quota cannot be enforced; that is logged
// once so the operator knows.

import type { Tier } from './auth.js';
import type { LlmProvider } from '../../../types/market.js';

const DEFAULT_QUOTA = { trial: 50, pro: 500 };
let warnedNoSupabase = false;

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function dailyQuotaFor(tier: Tier): number {
  const envKey = tier === 'pro' ? 'DAILY_REQUEST_QUOTA_PRO' : 'DAILY_REQUEST_QUOTA_TRIAL';
  const n = Number(process.env[envKey]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTA[tier] ?? DEFAULT_QUOTA.trial;
}

function utcMidnightIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * A token's quota for today. Without Supabase it is not enforced and always ok. `error` is set, and `ok` false, when
 * the count could not be read: the lookup fails closed.
 */
export interface QuotaCheck {
  ok: boolean;
  used: number;
  limit: number;
  enforced: boolean;
  error?: string;
}

export async function checkDailyQuota({ sub, tier }: { sub: string; tier: Tier }): Promise<QuotaCheck> {
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
    // Everything these try blocks throw is an Error (the import, the client, here the query error rethrown), so the
    // binding is asserted, not narrowed: `error` stays the message as read, empty or not, which askLLM branches on.
    // The same in logUsage.
    console.error('quota lookup failed:', (err as Error).message);
    return { ok: false, used: 0, limit, enforced: true, error: (err as Error).message };
  }
}

/** What askLLM records for each call it makes with the server's key. */
export interface UsageRecord {
  sub: string;
  tier: Tier;
  provider: LlmProvider;
  model: string;
  stream: boolean;
  keySource: 'server';
  requestId: string;
}

/** Fire-and-forget usage record. Never throws. */
export async function logUsage({ sub, tier, provider, model, stream, keySource, requestId }: UsageRecord): Promise<void> {
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
    console.warn('usage_log insert failed:', (err as Error).message);
  }
}
