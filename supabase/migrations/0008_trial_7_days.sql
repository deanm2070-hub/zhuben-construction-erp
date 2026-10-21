-- Trials last 7 days; the referral extension is given to each account only once; a trial's renewal reminder goes
-- out 2 days before it ends (other plans 14 days). Safe to run again.

alter table public.profiles alter column expires_at set default now() + interval '7 days';

-- a referral still counts as a successful share, but only the first one extends the referrer
create or replace function public.check_referral(u uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.profiles; start date;
begin
  select * into p from public.profiles where id = u;
  if p.referred_by is null or p.referral_rewarded_at is not null then return false; end if;
  start := (p.created_at at time zone 'Asia/Taipei')::date;
  if (select count(*) from public.usage_days where user_id = u and minutes >= 60 and day >= start and day < start + 7) < 3 then return false; end if;
  if not exists (select 1 from public.profiles where referred_by = p.referred_by and referral_rewarded_at is not null) then
    -- no end date stays no end date; an expired referrer gets 7 days from now
    update public.profiles set expires_at = greatest(expires_at, now()) + interval '7 days' where id = p.referred_by and expires_at is not null;
  end if;
  update public.profiles set referral_rewarded_at = now() where id = u;
  return true;
end $$;
revoke execute on function public.check_referral(uuid) from public, anon, authenticated;

create or replace function public.send_renewal_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare r record; m jsonb; n int := 0;
begin
  for r in
    select * from public.profiles
    where not disabled and email is not null and expires_at > now()
      and expires_at <= now() + case when plan = 'trial' then interval '2 days' else interval '14 days' end
      and reminded_for is distinct from expires_at
  loop
    m := public.renewal_email(r.email, r.plan, r.expires_at);
    perform public.send_mail(r.email, m ->> 'subject', m ->> 'html');
    update public.profiles set reminded_at = now(), reminded_for = r.expires_at where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.send_renewal_reminders() from public, anon, authenticated;

-- administrator: e-mail a newly opened account its sign-in details
create or replace function public.send_welcome(p_email text, p_password text) returns void
language plpgsql security definer set search_path = public as $$
declare p public.profiles; site text := coalesce(public.setting('site_url'), '');
begin
  if not public.is_admin() then raise exception '只有管理員可以寄開通信'; end if;
  select * into p from public.profiles where lower(email) = lower(p_email);
  perform public.send_mail(p_email, '【築本算圖】您的試用帳號已開通', public.mail_frame(
    format('<p style="margin:0 0 12px;font-size:16px;color:#111827">%s 您好：</p>', public.esc_html(p_email))
    || '<p style="margin:0 0 16px">感謝您申請築本算圖，您的帳號已開通，用下面的帳號密碼登入即可開始使用。</p>'
    || '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:0 0 16px;font-size:14px">'
    || format('<tr><td style="padding:6px 0;color:#6b7280;width:96px">帳號</td><td style="padding:6px 0;color:#111827;font-weight:600">%s</td></tr>', public.esc_html(p_email))
    || format('<tr><td style="padding:6px 0;color:#6b7280;width:96px">密碼</td><td style="padding:6px 0;color:#111827;font-weight:600;font-family:monospace;font-size:16px">%s</td></tr>', public.esc_html(p_password))
    || case when p.expires_at is null then '' else format('<tr><td style="padding:6px 0;color:#6b7280;width:96px">使用期限</td><td style="padding:6px 0;color:#111827;font-weight:600">%s</td></tr>', to_char(p.expires_at at time zone 'Asia/Taipei', 'YYYY-MM-DD')) end
    || '</table>'
    || format('<p style="margin:0 0 8px"><a href="%s" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">登入築本算圖</a></p>', site)
    || '<p style="margin:12px 0 0;font-size:13px;color:#6b7280">每個帳號同一時間只能在一台裝置使用。登入後在「我的專案」→「個人資訊」可取得分享連結，朋友用你的連結試用達標，你的帳號可延長 7 天（限一次）。</p>'));
end $$;
