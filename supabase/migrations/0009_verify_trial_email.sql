-- Trial requests must come from a real mailbox: the applicant gets a confirmation link, and only confirmed requests
-- reach the administrator (e-mail notice and the 管理員後台 list). Malformed and throw-away addresses are refused.
-- Safe to run again.

alter table public.trial_requests add column if not exists verify_token text unique;
alter table public.trial_requests add column if not exists verified_at timestamptz;
-- requests from before this change were already looked at by hand
update public.trial_requests set verified_at = created_at where verified_at is null and verify_token is null;

-- a sensible address on a domain that is not a known throw-away mailbox service
create or replace function public.email_ok(e text) returns boolean language sql immutable as $$
  select e ~ '^[a-z0-9][a-z0-9._%+-]{0,63}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'
    and e !~ '\.\.'
    and split_part(e, '@', 2) not in (
      'example.com', 'example.org', 'example.net', 'test.com', 'test.tw', 'abc.com', 'xxx.com', 'aaa.com', 'email.com',
      'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com', 'grr.la', '10minutemail.com',
      'tempmail.com', 'temp-mail.org', 'tempmail.net', 'tempail.com', 'yopmail.com', 'yopmail.net', 'trashmail.com',
      'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com',
      'mintemail.com', 'emailondeck.com', 'mohmal.com', 'mailnesia.com', 'mytemp.email', 'tempr.email', 'discard.email',
      'spamgourmet.com', 'moakt.com', 'burnermail.io', 'inboxkitten.com', '1secmail.com', 'linshiyouxiang.net')
$$;

create or replace function public.request_trial(p_email text, p_ref text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); r text := nullif(trim(coalesce(p_ref, '')), ''); t text; site text := coalesce(public.setting('site_url'), '');
begin
  if length(e) > 200 or not public.email_ok(e) or length(coalesce(r, '')) > 20 then return false; end if;
  -- the same address again within 10 minutes, or a flood, is ignored
  if exists (select 1 from public.trial_requests where email = e and created_at > now() - interval '10 minutes') then return true; end if;
  if (select count(*) from public.trial_requests where created_at > now() - interval '1 hour') >= 30 then return false; end if;
  t := md5(gen_random_uuid()::text || clock_timestamp()::text);
  insert into public.trial_requests (email, ref_code, verify_token) values (e, r, t);
  perform public.send_mail(e, '【築本算圖】請確認您的電子郵件以完成試用申請', public.mail_frame(
    format('<p style="margin:0 0 12px;font-size:16px;color:#111827">%s 您好：</p>', public.esc_html(e))
    || '<p style="margin:0 0 16px">我們收到您的築本算圖試用申請。請按下面的按鈕確認這是您的電子郵件，申請才會送出給管理員；開通後帳號密碼會寄到這個信箱。</p>'
    || format('<p style="margin:0 0 16px"><a href="%s/?verify=%s" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">確認電子郵件</a></p>', site, t)
    || '<p style="margin:0;font-size:13px;color:#6b7280">如果您沒有申請，請忽略這封信。</p>'));
  return true;
end $$;
grant execute on function public.request_trial(text, text) to anon, authenticated;

-- the link in the confirmation e-mail; returns the confirmed address, or null for an unknown link
create or replace function public.verify_trial(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare q public.trial_requests; a record; site text := coalesce(public.setting('site_url'), '');
begin
  select * into q from public.trial_requests where verify_token = p_token;
  if q.id is null then return null; end if;
  if q.verified_at is not null then return q.email; end if;
  update public.trial_requests set verified_at = now() where id = q.id;
  begin
    for a in select u.email from public.admins ad join auth.users u on u.id = ad.user_id where u.email is not null loop
      perform public.send_mail(a.email, '【築本算圖】新的試用申請：' || q.email, public.mail_frame(
        format('<p style="margin:0 0 12px">有新的試用申請（申請者已確認電子郵件）：</p><p style="margin:0 0 12px;font-size:17px"><b>%s</b>%s</p>', public.esc_html(q.email),
          case when q.ref_code is null then '' else format('<br><span style="font-size:14px;color:#6b7280">推薦碼 %s</span>', public.esc_html(q.ref_code)) end)
        || format('<p style="margin:0"><a href="%s/#/admin" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">到管理員後台開通</a></p>', site)));
    end loop;
  exception when others then null;
  end;
  return q.email;
end $$;
grant execute on function public.verify_trial(text) to anon, authenticated;
