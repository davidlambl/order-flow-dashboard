// netlify/functions/lib/supabasePublic.js
// Server-side Supabase client using the anon key, for reads of public tables
// (flow_history) so the service role is reserved for writes.

import { createClient } from '@supabase/supabase-js';

let client = null;

export function getSupabasePublic() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
