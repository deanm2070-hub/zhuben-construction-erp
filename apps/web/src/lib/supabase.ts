import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Accepts common paste mistakes: spaces, quotes, a missing https://, or a trailing /rest/v1 path. */
export function normalizeSupabaseUrl(raw: string): string {
  let s = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return new URL(s).origin;
}

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const rawKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim().replace(/^['"]|['"]$/g, '');

let client: SupabaseClient | null = null;
let error: string | null = null;
if (rawUrl && rawKey) {
  try {
    client = createClient(normalizeSupabaseUrl(rawUrl), rawKey);
  } catch (e) {
    error = `VITE_SUPABASE_URL 無法使用（${rawUrl}）：${(e as Error).message}`;
  }
} else if (rawUrl || rawKey) {
  error = rawUrl ? '缺少 VITE_SUPABASE_ANON_KEY' : '缺少 VITE_SUPABASE_URL';
}

/** null when the app runs without a backend (local mode). */
export const supabase: SupabaseClient | null = client;
/** Set when Supabase variables are present but unusable; the app shows it instead of a blank page. */
export const supabaseConfigError: string | null = error;
