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
  /** when the last renewal reminder e-mail went out (0004_renewal_reminders.sql) */
  reminded_at?: string | null;
  /** share code in the account's share link, the account that referred it, and when that referral was rewarded (0005) */
  ref_code?: string | null;
  referred_by?: string | null;
  referral_rewarded_at?: string | null;
}

/** The administrator's LINE official account: trials are requested there. */
export const LINE_ID = '@870ufuor';
export const LINE_ADD = `https://line.me/R/ti/p/${LINE_ID}`;
/** opens a chat with the administrator with the message already typed */
export const lineMessage = (text: string) => `https://line.me/R/oaMessage/${LINE_ID}/?${encodeURIComponent(text)}`;
/** a referral counts once the new account has 3 days of at least 60 minutes online within its first 7 days */
export const REFERRAL = { days: 3, minutes: 60, within: 7, reward: 7 };
export const shareLink = (code: string) => `${location.origin}/?ref=${code}`;
/** phones and tablets, where LINE links open the LINE app with the message typed; on computers they only show a QR code */
export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

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

export async function updateProfile(id: string, patch: Partial<Pick<Profile, 'plan' | 'expires_at' | 'disabled' | 'note' | 'referred_by'>>) {
  const { error } = await supabase!.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

/**
 * New account made by the administrator. Uses a second, session-less client so the administrator stays signed in;
 * the database trigger creates its profile, which is then given the chosen plan. If e-mail confirmation is on in
 * Supabase, the new user still has to click the link in the e-mail before signing in.
 */
export async function createAccount(email: string, password: string, plan: string, expiresAt: string | null, referredBy: string | null = null) {
  const url = import.meta.env.VITE_SUPABASE_URL as string, key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string).trim().replace(/^['"]|['"]$/g, '');
  const side = createClient(normalizeSupabaseUrl(url), key, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'zl-admin-create' } });
  const { data, error } = await side.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
  if (error) throw error;
  const id = data.user?.id;
  // an address that already has an account comes back without identities and no new user
  if (!id || (data.user?.identities && data.user.identities.length === 0)) throw new Error('這個電子郵件已經有帳號');
  await updateProfile(id, { plan, expires_at: expiresAt, ...(referredBy ? { referred_by: referredBy } : {}) });
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

/** Mail settings for the renewal reminders (table public.app_settings); null before 0004 has been run. */
export async function loadSettings(): Promise<Record<string, string> | null> {
  const { data, error } = await supabase!.from('app_settings').select('*');
  if (error) return null;
  return Object.fromEntries((data as { key: string; value: string }[]).map(r => [r.key, r.value]));
}

export async function saveSetting(key: string, value: string) {
  const { error } = await supabase!.from('app_settings').upsert({ key, value });
  if (error) throw error;
}

/** the reminder of one account, sent to the administrator's own mailbox; returns that address */
export async function sendTestReminder(id: string) {
  const { data, error } = await supabase!.rpc('send_test_reminder', { p_id: id });
  if (error) throw error;
  return data as string;
}

/** the daily reminder run, now; returns how many e-mails went out */
export async function runReminders() {
  const { data, error } = await supabase!.rpc('run_renewal_reminders');
  if (error) throw error;
  return data as number;
}

/** one minute of use, sent once a minute while the app is open, in front and in use (0005; ignored before it is run) */
export async function heartbeat() {
  if (supabase) await supabase.rpc('heartbeat');
}

/** how many of the accounts this one referred have earned the reward, and how many are still within their 7 days */
export async function myReferrals(): Promise<{ rewarded: number; pending: number } | null> {
  const { data, error } = await supabase!.rpc('my_referrals');
  return error ? null : data;
}

export interface UsageDay { user_id: string; day: string; minutes: number; first_seen: string; last_seen: string }
export interface Login { user_id: string; at: string }

/** the administrator's view: minutes online per account and day, and sign-in times, for the last `days` days */
export async function listUsage(days = 30): Promise<{ usage: UsageDay[]; logins: Login[] } | null> {
  const since = new Date(Date.now() - days * 864e5);
  const [u, l] = await Promise.all([
    supabase!.from('usage_days').select('*').gte('day', since.toISOString().slice(0, 10)).order('day', { ascending: false }),
    supabase!.from('logins').select('user_id, at').gte('at', since.toISOString()).order('at', { ascending: false }).limit(2000),
  ]);
  if (u.error || l.error) return null;
  return { usage: u.data as UsageDay[], logins: l.data as Login[] };
}

/** a trial request from the sign-in page: saved for the admin page and e-mailed to the administrator (0007) */
export async function requestTrial(email: string, ref: string) {
  const { data, error } = await supabase!.rpc('request_trial', { p_email: email, p_ref: ref || null });
  if (error) throw error;
  if (!data) throw new Error('請確認電子郵件是否正確');
}
/** the same, while the page is leaving for LINE: the request still goes out */
export function requestTrialBeacon(email: string, ref: string) {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined, key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim().replace(/^['"]|['"]$/g, '');
  if (!url || !key) return;
  fetch(`${normalizeSupabaseUrl(url)}/rest/v1/rpc/request_trial`, {
    method: 'POST', keepalive: true,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_email: email, p_ref: ref || null }),
  }).catch(() => {});
}

export interface TrialRequest { id: number; email: string; ref_code: string | null; created_at: string; handled_at: string | null }
export async function listTrialRequests(): Promise<TrialRequest[] | null> {
  const { data, error } = await supabase!.from('trial_requests').select('*').is('handled_at', null).order('created_at', { ascending: false });
  return error ? null : data as TrialRequest[];
}
export async function handleTrialRequest(id: number) {
  const { error } = await supabase!.from('trial_requests').update({ handled_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
/** e-mails a new account its sign-in details */
export async function sendWelcome(email: string, password: string) {
  const { error } = await supabase!.rpc('send_welcome', { p_email: email, p_password: password });
  if (error) throw error;
}
/** an easy-to-type password: no 0/O, 1/l/I */
export function newPassword() {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => c[b % c.length]).join('');
}
