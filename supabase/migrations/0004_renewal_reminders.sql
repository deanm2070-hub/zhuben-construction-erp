-- Renewal reminders: every day at 09:00 (Taiwan) the database e-mails each account whose subscription ends within
-- 14 days, once per expiry date, through Resend (resend.com). Run once in the Supabase SQL Editor after 0002.
-- Safe to run again.
--
-- Before it can send, store the Resend API key in the Vault (run this line on its own, with your key, once;
-- the key then lives encrypted in Supabase and never in this file or the website):
--   select vault.create_secret('re_xxxxxxxxxxxxxxxx', 'resend_api_key');
-- To replace it later:
--   select vault.update_secret((select id from vault.secrets where name = 'resend_api_key'), 're_new_key');

create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.profiles add column if not exists reminded_at timestamptz;
-- the expiry date the last reminder was for: extending the subscription makes the account due again next time
alter table public.profiles add column if not exists reminded_for timestamptz;

create table if not exists public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;
drop policy if exists "admin manages settings" on public.app_settings;
create policy "admin manages settings" on public.app_settings for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update on public.app_settings to authenticated;
insert into public.app_settings (key, value) values
  ('mail_from', '築量雲 <onboarding@resend.dev>'),
  ('site_url', 'https://zhuben-construction-erp.deanm2070.workers.dev'),
  ('renew_how', '請直接回覆這封信，或與我們聯絡，確認付款後我們會為您延長使用期限。'),
  ('reply_to', '')
on conflict (key) do nothing;

create or replace function public.setting(k text) returns text language sql stable security definer set search_path = public as $$
  select value from public.app_settings where key = k
$$;

-- the same letter the admin page previews
create or replace function public.renewal_email(p_email text, p_plan text, p_expires timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  site text := coalesce(public.setting('site_url'), '');
  how text := coalesce(public.setting('renew_how'), '');
  d text := to_char(p_expires at time zone 'Asia/Taipei', 'YYYY-MM-DD');
  left_days int := greatest(1, ceil(extract(epoch from (p_expires - now())) / 86400)::int);
  plan text := case p_plan when 'trial' then '試用' when 'monthly' then '月訂' when 'yearly' then '年訂' when 'unlimited' then '不限期' else p_plan end;
  e text := replace(replace(replace(p_email, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  subject text := format('【築量雲】您的訂閱將於 %s 到期，請續訂以繼續使用', d);
  row_t text := '<tr><td style="padding:6px 0;color:#6b7280;width:96px">%s</td><td style="padding:6px 0;color:#111827;font-weight:600">%s</td></tr>';
  html text;
begin
  html := '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    || '<body style="margin:0;background:#f3f4f6;font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',sans-serif">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">'
    || format('<tr><td style="background:#0f766e;padding:20px 24px;color:#ffffff"><img src="%s/logo.png" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px;background:#fff;margin-right:10px"><span style="font-size:20px;font-weight:800;vertical-align:middle">築量雲</span></td></tr>', site)
    || '<tr><td style="padding:24px">'
    || format('<p style="margin:0 0 12px;font-size:16px;color:#111827">%s 您好：</p>', e)
    || format('<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151">感謝您使用築量雲。您的訂閱即將到期，還剩 <b style="color:#b45309">%s 天</b>。</p>', left_days)
    || '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:0 0 16px;font-size:14px">'
    || format(row_t, '帳號', e) || format(row_t, '方案', plan) || format(row_t, '到期日', d)
    || '</table>'
    || '<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#374151">到期後將無法開啟及儲存專案；您的專案資料會完整保留，續訂後即可繼續使用。</p>'
    || format('<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151"><b>續訂方式：</b>%s</p>', replace(replace(how, '<', '&lt;'), E'\n', '<br>'))
    || format('<p style="margin:0 0 8px"><a href="%s" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">登入築量雲</a></p>', site)
    || '</td></tr><tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">築量雲 敬上・這是系統自動寄出的提醒信</td></tr>'
    || '</table></td></tr></table></body></html>';
  return jsonb_build_object('subject', subject, 'html', html);
end $$;

-- one e-mail through Resend; returns the pg_net request id
create or replace function public.send_mail(p_to text, p_subject text, p_html text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  key text := (select decrypted_secret from vault.decrypted_secrets where name = 'resend_api_key' limit 1);
  body jsonb;
begin
  if key is null then raise exception '尚未設定 Resend API 金鑰（vault 的 resend_api_key）'; end if;
  body := jsonb_build_object('from', public.setting('mail_from'), 'to', jsonb_build_array(p_to), 'subject', p_subject, 'html', p_html);
  if coalesce(public.setting('reply_to'), '') <> '' then body := body || jsonb_build_object('reply_to', public.setting('reply_to')); end if;
  return net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || key, 'Content-Type', 'application/json'),
    body := body
  );
end $$;

-- the daily run: accounts ending within 14 days that have not had a reminder for this expiry date
create or replace function public.send_renewal_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare r record; m jsonb; n int := 0;
begin
  for r in
    select * from public.profiles
    where not disabled and email is not null and expires_at > now() and expires_at <= now() + interval '14 days'
      and reminded_for is distinct from expires_at
  loop
    m := public.renewal_email(r.email, r.plan, r.expires_at);
    perform public.send_mail(r.email, m ->> 'subject', m ->> 'html');
    update public.profiles set reminded_at = now(), reminded_for = r.expires_at where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- admin page: send the reminder of one account to the administrator's own address, to see it in a real mailbox
create or replace function public.send_test_reminder(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r public.profiles; me text := (select email from auth.users where id = auth.uid()); m jsonb;
begin
  if not public.is_admin() then raise exception '只有管理員可以寄測試信'; end if;
  select * into r from public.profiles where id = p_id;
  m := public.renewal_email(r.email, r.plan, coalesce(r.expires_at, now() + interval '14 days'));
  perform public.send_mail(me, '（測試）' || (m ->> 'subject'), m ->> 'html');
  return me;
end $$;

-- admin page: the daily run, now
create or replace function public.run_renewal_reminders() returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '只有管理員可以執行'; end if;
  return public.send_renewal_reminders();
end $$;

revoke execute on function public.send_mail(text, text, text) from public, anon, authenticated;
revoke execute on function public.send_renewal_reminders() from public, anon, authenticated;

-- every day 01:00 UTC = 09:00 Taiwan
select cron.unschedule(jobid) from cron.job where jobname = 'renewal-reminders';
select cron.schedule('renewal-reminders', '0 1 * * *', 'select public.send_renewal_reminders()');
