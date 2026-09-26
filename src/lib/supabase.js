// src/lib/supabase.js
// Browser-side Supabase client (anon key, access controlled via RLS).
// `import.meta.env` exists only under Vite; under Node (the verify harness) it is
// undefined, so this module and everything that imports it load without a bundler
// and the default client is null. Vite still replaces `import.meta.env` statically.
import { createClient } from '@supabase/supabase-js';

const env = import.meta.env ?? {};

/** A client for `url` + `key`, or null when either is missing. */
export function createSupabaseClient(url, key) {
  return url && key ? createClient(url, key) : null;
}

export const supabase = createSupabaseClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
