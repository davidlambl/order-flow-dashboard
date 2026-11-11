// netlify/functions/lib/supabasePublic.ts
// Server-side Supabase client using the anon key, for reads of public tables
// (flow_history) so the service role is reserved for writes.

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../types/supabase.js';

let client: SupabaseClient<Database> | null = null;

export function getSupabasePublic(): SupabaseClient<Database> | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client = createClient<Database>(url, key, { auth: { persistSession: false } });
  return client;
}
