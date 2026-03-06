// netlify/functions/lib/supabaseAdmin.js
// Server-side Supabase client with service role (full access, bypasses RLS).
import { createClient } from '@supabase/supabase-js';

let client = null;

export function getSupabaseAdmin() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
  });
  return client;
}
