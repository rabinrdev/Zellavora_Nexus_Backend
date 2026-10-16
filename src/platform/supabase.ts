import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

/**
 * Shared Supabase client, created on first use. Uses the publishable key, so it is subject to
 * row-level security; do not use it for privileged work (the database itself stays on DATABASE_URL).
 * Throws if SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is unset.
 */
export function getSupabase(source: NodeJS.ProcessEnv = process.env): SupabaseClient {
  if (client) return client;
  const url = source.SUPABASE_URL;
  const key = source.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set to use Supabase');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
