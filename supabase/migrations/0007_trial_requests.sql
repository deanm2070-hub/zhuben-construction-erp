-- Trial requests sent from the sign-in page: saved for the 管理員後台, the administrator is e-mailed at once, and the
-- new account's e-mail and password can be e-mailed to the applicant. Run once in the Supabase SQL Editor after 0006.
-- Safe to run again.

create table if not exists public.trial_requests (
  id bigserial primary key,
  email text not null,
  ref_code text,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
alter table public.trial_requests enable row level security;
drop policy if exists "admin manages trial requests" on public.trial_requests;
create policy "admin manages trial requests" on public.trial_requests for all using (public.is_admin()) with check (public.is_admin());
grant select, update, delete on public.trial_requests to authenticated;

create or replace function public.esc_html(s text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(s, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

-- the shared letter frame (same look as the renewal reminder)
create or replace function public.mail_frame(p_body text) returns text language sql stable security definer set search_path = public as $$
  select '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    || '<body style="margin:0;background:#f3f4f6;font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',sans-serif">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">'
    || format('<tr><td style="background:#0f766e;padding:20px 24px;color:#ffffff"><img src="%s/logo.png" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px;background:#fff;margin-right:10px"><span style="font-size:20px;font-weight:800;vertical-align:middle">築本算圖</span></td></tr>', coalesce(public.setting('site_url'), ''))
    || '<tr><td style="padding:24px;font-size:15px;line-height:1.7;color:#374151">' || p_body || '</td></tr>'
    || '<tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">築本算圖 敬上・這是系統自動寄出的信</td></tr>'
    || '</table></td></tr></table></body></html>'
$$;

-- called by anyone on the sign-in page (no account yet); returns true when the request was taken
create or replace function public.request_trial(p_email text, p_ref text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); r text := nullif(trim(coalesce(p_ref, '')), ''); a record;
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 200 or length(coalesce(r, '')) > 20 then return false; end if;
  -- the same address again within 10 minutes, or a flood, is ignored
  if exists (select 1 from public.trial_requests where email = e and created_at > now() - interval '10 minutes') then return true; end if;
  if (select count(*) from public.trial_requests where created_at > now() - interval '1 hour') >= 30 then return false; end if;
  insert into public.trial_requests (email, ref_code) values (e, r);
  -- tell the administrators; the request is kept even if the e-mail cannot go out
  begin
    for a in select u.email from public.admins ad join auth.users u on u.id = ad.user_id where u.email is not null loop
      perform public.send_mail(a.email, '【築本算圖】新的試用申請：' || e, public.mail_frame(
        format('<p style="margin:0 0 12px">有新的試用申請：</p><p style="margin:0 0 12px;font-size:17px"><b>%s</b>%s</p>', public.esc_html(e),
          case when r is null then '' else format('<br><span style="font-size:14px;color:#6b7280">推薦碼 %s</span>', public.esc_html(r)) end)
        || format('<p style="margin:0"><a href="%s/#/admin" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">到管理員後台開通</a></p>', coalesce(public.setting('site_url'), ''))));
    end loop;
  exception when others then null;
  end;
  return true;
end $$;
grant execute on function public.request_trial(text, text) to anon, authenticated;

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
    || '<p style="margin:12px 0 0;font-size:13px;color:#6b7280">每個帳號同一時間只能在一台裝置使用。登入後在「我的專案」→「個人資訊」可取得分享連結，朋友用你的連結試用達標，你的帳號可延長 7 天。</p>'));
end $$;
