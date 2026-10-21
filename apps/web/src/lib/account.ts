import { createClient } from '@supabase/supabase-js';
import { normalizeSupabaseUrl, supabase } from './supabase';

/** Subscription of one account (table public.profiles, see supabase/migrations/0002_subscriptions.sql). */
export interface Profile {
  id: string;
  email: string | null;
  plan: string;
  expires_at: string | null;
  disabled: boolean;
  note: string | null;
  created_at: string;
}

export const PLANS: Record<string, string> = { trial: '試用', monthly: '月訂', yearly: '年訂', unlimited: '不限期' };

export interface Account {
  /** false while the subscriptions migration has not been run: everyone keeps working as before */
  ready: boolean;
  admin: boolean;
  /** no administrator yet: the signed-in account may claim the role */
  adminExists: boolean;
  profile: Profile | null;
  active: boolean;
  /** the account has since been signed in on another device */
  elsewhere: boolean;
}

export const OPEN_ACCOUNT: Account = { ready: false, admin: false, adminExists: true, profile: null, active: true, elsewhere: false };

export async function loadAccount(userId: string): Promise<Account> {
  if (!supabase) return OPEN_ACCOUNT;
  const [admin, exists, prof, device] = await Promise.all([
    supabase.rpc('is_admin'), supabase.rpc('admin_exists'),
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
    supabase.rpc('device_ok'),
  ]);
  if (admin.error || exists.error || prof.error) return OPEN_ACCOUNT;
  // without the one-device migration (0003) every device keeps working
  const elsewhere = !device.error && device.data === false;
  const p = prof.data as Profile | null, isAdmin = !!admin.data;
  const active = isAdmin || (!!p && !p.disabled && (!p.expires_at || new Date(p.expires_at) > new Date()));
  return { ready: true, admin: isAdmin, adminExists: !!exists.data, profile: p, active: active && !elsewhere, elsewhere };
}

export async function claimAdmin() {
  const { data, error } = await supabase!.rpc('claim_admin');
  if (error) throw error;
  return !!data;
}

export async function listProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase!.from('profiles').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data as Profile[];
}

export async function updateProfile(id: string, patch: Partial<Pick<Profile, 'plan' | 'expires_at' | 'disabled' | 'note'>>) {
  const { error } = await supabase!.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

/**
 * New account made by the administrator. Uses a second, session-less client so the administrator stays signed in;
 * the database trigger creates its profile, which is then given the chosen plan. If e-mail confirmation is on in
 * Supabase, the new user still has to click the link in the e-mail before signing in.
 */
export async function createAccount(email: string, password: string, plan: string, expiresAt: string | null) {
  const url = import.meta.env.VITE_SUPABASE_URL as string, key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string).trim().replace(/^['"]|['"]$/g, '');
  const side = createClient(normalizeSupabaseUrl(url), key, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'zl-admin-create' } });
  const { data, error } = await side.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
  if (error) throw error;
  const id = data.user?.id;
  // an address that already has an account comes back without identities and no new user
  if (!id || (data.user?.identities && data.user.identities.length === 0)) throw new Error('這個電子郵件已經有帳號');
  await updateProfile(id, { plan, expires_at: expiresAt });
  return { id, confirm: !data.session };
}

/** the date `months` after today (or after the current expiry when that is still ahead), as an ISO string */
export function extend(current: string | null, months: number) {
  const now = new Date(), from = current && new Date(current) > now ? new Date(current) : now;
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

export const CLAIM_FLAG = 'zl-claim-device';
/** Right after a password sign-in: this device becomes the one the account is used on (any other is signed out). */
export async function claimDevice() {
  if (supabase) await supabase.rpc('claim_device');
}
