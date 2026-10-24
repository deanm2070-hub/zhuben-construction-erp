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
  /** LINE name or ID the trial was applied from (0014): one trial per LINE account */
  line_name?: string | null;
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
/** a referral counts once the new account has 3 days of at least 60 minutes online within its first 7 days; each account is extended for this only once */
export const REFERRAL = { days: 3, minutes: 60, within: 7, reward: 7 };
/** length of a new trial, in days */
export const TRIAL_DAYS = 7;
export const shareLink = (code: string) => `${location.origin}/?ref=${code}`;

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

/** Trial accounts try the software on the sample plan only; importing drawings needs a paid plan. */
export const isTrial = (a: Account) => !a.admin && a.profile?.plan === 'trial';
export const TRIAL_LOCK = '正式訂閱開通功能';

export const OPEN_ACCOUNT: Account = { ready: false, admin: false, adminExists: true, profile: null, active: true, elsewhere: false };

export async function loadAccount(userId: string): Promise<Account> {
  if (!supabase) return OPEN_ACCOUNT;
  const [admin, exists, prof, device] = await Promise.all([
    supabase.rpc('is_admin'), supabase.rpc('admin_exists'),
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
    supabase.rpc('device_ok'),
  ]);
  if (admin.error || exists.error || prof.error) return OPEN_ACCOUNT;
  // an account made without its profile (plan and expiry) gets its 7-day trial now (0013); re-read it once
  if (!prof.data && !admin.data) {
    // a session kept from an account that has since been deleted: its user is gone, so sign in again
    const me = await supabase.auth.getUser();
    if (me.error || !me.data.user) { await supabase.auth.signOut({ scope: 'local' }).catch(() => {}); return { ...OPEN_ACCOUNT, active: false }; }
    const fix = await supabase.rpc('ensure_profile');
    if (!fix.error) {
      const again = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (!again.error) prof.data = again.data;
    }
  }
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

export async function updateProfile(id: string, patch: Partial<Pick<Profile, 'plan' | 'expires_at' | 'disabled' | 'note' | 'referred_by' | 'line_name'>>) {
  const { error } = await supabase!.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

/**
 * New account made by the administrator. Uses a second, session-less client so the administrator stays signed in;
 * the database trigger creates its profile, which is then given the chosen plan. If e-mail confirmation is on in
 * Supabase, the new user still has to click the link in the e-mail before signing in.
 */
export async function createAccount(email: string, password: string, plan: string, expiresAt: string | null, referredBy: string | null = null, lineName: string | null = null) {
  const url = import.meta.env.VITE_SUPABASE_URL as string, key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string).trim().replace(/^['"]|['"]$/g, '');
  const side = createClient(normalizeSupabaseUrl(url), key, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'zl-admin-create' } });
  const { data, error } = await side.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
  if (error) throw error;
  const id = data.user?.id;
  // an address that already has an account comes back without identities and no new user
  if (!id || (data.user?.identities && data.user.identities.length === 0)) throw new Error('這個電子郵件已經有帳號');
  await updateProfile(id, { plan, expires_at: expiresAt, ...(referredBy ? { referred_by: referredBy } : {}), ...(lineName ? { line_name: lineName } : {}) });
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
/** the trial application from the sign-in page (0014): saved for the admin page and e-mailed to the administrator; one per address */
export async function applyTrial(email: string, ref: string): Promise<'ok' | 'exists' | 'invalid' | 'busy'> {
  const { data, error } = await supabase!.rpc('apply_trial', { p_email: email, p_ref: ref || null });
  if (error) throw error;
  return (data as { status: 'ok' | 'exists' | 'invalid' | 'busy' }).status;
}
/** the LINE official account chat with the application typed in (opens LINE on phones) */
export const lineApply = (email: string) => `https://line.me/R/oaMessage/${LINE_ID}/?${encodeURIComponent(`申請築本3D工程估算免費試用\nEmail：${email}`)}`;
/** administrator: the e-mail of the account or application that already used this LINE name, or null (0014) */
export async function lineUsed(line: string, email: string): Promise<string | null> {
  const { data, error } = await supabase!.rpc('line_used', { p_line: line, p_email: email });
  if (error) throw new Error(error.code === 'PGRST202' ? '需要先在 Supabase SQL Editor 執行 0014_試用改由管理員開通.sql' : error.message);
  return data as string | null;
}
/** opens a 7-day trial account for this address and e-mails it a random password (0010) */
export async function startTrial(email: string, ref: string): Promise<'created' | 'exists' | 'invalid' | 'busy'> {
  const { data, error } = await supabase!.rpc('start_trial', { p_email: email, p_ref: ref || null });
  if (error) throw error;
  return (data as { status: 'created' | 'exists' | 'invalid' | 'busy' }).status;
}
/** the link in the confirmation e-mail: returns the confirmed address, or null when the link is unknown */
export async function verifyTrial(token: string) {
  const { data, error } = await supabase!.rpc('verify_trial', { p_token: token });
  if (error) throw error;
  return data as string | null;
}

export interface TrialRequest { id: number; email: string; ref_code: string | null; created_at: string; handled_at: string | null; line_name?: string | null }
export async function listTrialRequests(): Promise<TrialRequest[] | null> {
  // only requests whose e-mail has been confirmed (0009); before that migration, all of them
  const q = () => supabase!.from('trial_requests').select('*').is('handled_at', null).order('created_at', { ascending: false });
  let r = await q().not('verified_at', 'is', null);
  if (r.error) r = await q();
  return r.error ? null : r.data as TrialRequest[];
}
export async function handleTrialRequest(id: number, lineName?: string) {
  const { error } = await supabase!.from('trial_requests').update({ handled_at: new Date().toISOString(), ...(lineName ? { line_name: lineName } : {}) }).eq('id', id);
  if (error) throw error;
}
/** e-mails a new account its sign-in details */
export async function sendWelcome(email: string, password: string) {
  const { error } = await supabase!.rpc('send_welcome', { p_email: email, p_password: password });
  if (error) throw error;
}
/** administrator: delete a trial account and everything in it (0012); returns its e-mail */
export async function deleteTrialAccount(id: string) {
  const { data, error } = await supabase!.rpc('delete_trial_account', { p_id: id });
  if (error) throw new Error(error.code === 'PGRST202' ? '刪除帳號需要先更新資料庫：在 Supabase 的 SQL Editor 執行 supabase/migrations/0012_login_link_delete_trial.sql 一次' : error.message);
  return data as string;
}
/** an easy-to-type password: no 0/O, 1/l/I */
export function newPassword() {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => c[b % c.length]).join('');
}

/** 回報問題 (0016): sends the project's model, its sanity-check list and the list of original drawings to the administrators */
export async function reportProblem(projectId: string, text: string, issues: unknown[], version: string) {
  const { data, error } = await supabase!.rpc('report_problem', { p_project: projectId, p_text: text, p_issues: issues, p_version: version });
  if (error) throw new Error(error.code === 'PGRST202' ? '回報功能需要先更新資料庫：請管理員在 Supabase 的 SQL Editor 執行 supabase/migrations/0016_problem_reports.sql 一次' : error.message);
  return data as string;
}
export interface ProblemReport {
  id: string; created_at: string; user_id: string | null; email: string | null; project_id: string | null; project_name: string | null;
  text: string | null; issues: { sev: string; floor?: string; text: string }[] | null; sources: { path: string; name: string; size: number }[] | null;
  version: string | null; status: string;
}
/** administrator: open reports, newest first (null when 0016 has not been run) */
export async function listReports(): Promise<ProblemReport[] | null> {
  const { data, error } = await supabase!.from('problem_reports').select('id,created_at,user_id,email,project_id,project_name,text,issues,sources,version,status').neq('status', 'done').order('created_at', { ascending: false }).limit(100);
  return error ? null : data as ProblemReport[];
}
/** administrator: copy the reported model into a project of their own; returns the new project id */
export async function adoptReport(id: string) {
  const { data, error } = await supabase!.rpc('adopt_report', { p_id: id });
  if (error) throw error;
  return data as string;
}
export async function setReportStatus(id: string, status: 'new' | 'opened' | 'done') {
  const { error } = await supabase!.from('problem_reports').update({ status }).eq('id', id);
  if (error) throw error;
}
