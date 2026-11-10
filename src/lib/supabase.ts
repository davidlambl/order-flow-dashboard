// src/lib/supabase.ts
// Browser-side Supabase client (anon key, access controlled via RLS).
// It is typed with the generated schema (types/supabase.ts), so a query written in
// TypeScript is checked against the schema's tables and columns and returns typed rows.
// `import.meta.env` exists under Vite and Vitest (vitest.config.js `test.env` blanks
// VITE_SUPABASE_*, so tests get no default client); under plain Node it is undefined,
// so this module still loads there, by its own .ts name (Node strips the types), and the
// default client is null. Its importers do not load there: only Vite and Vitest resolve
// their './supabase.js' to this file. Vite still replaces `import.meta.env` statically.
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/supabase.js';

const env = import.meta.env ?? {};

/** A client for `url` + `key`, or null when either is missing. */
export function createSupabaseClient(url: string | undefined, key: string | undefined): SupabaseClient<Database> | null {
  return url && key ? createClient<Database>(url, key) : null;
}

export const supabase = createSupabaseClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
