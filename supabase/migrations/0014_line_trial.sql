-- Trials are opened by the administrator again: the applicant presses 申請免費試用, the request (e-mail) goes to
-- the administrator (admin page list + e-mail) and to the LINE official account, and the administrator opens the
-- account, which e-mails a random password. Each e-mail address and each LINE account may apply only once.
-- Safe to run again.

-- the LINE account an application came from (its LINE name or ID, entered by the administrator when opening it)
alter table public.trial_requests add column if not exists line_name text;
alter table public.profiles add column if not exists line_name text;
create unique index if not exists trial_requests_line_once on public.trial_requests (lower(line_name)) where line_name is not null;
create unique index if not exists profiles_line_once on public.profiles (lower(line_name)) where line_name is not null;

-- the application from the sign-in page; returns {status: ok | exists | invalid | busy}
create or replace function public.apply_trial(p_email text, p_ref text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); r text := nullif(trim(coalesce(p_ref, '')), ''); a record; site text := coalesce(public.setting('site_url'), '');
begin
  if length(e) > 200 or not public.email_ok(e) or length(coalesce(r, '')) > 20 then return jsonb_build_object('status', 'invalid'); end if;
  -- one application per address, ever (an account, or an earlier application, even a skipped one)
  if exists (select 1 from auth.users where lower(email) = e) or exists (select 1 from public.trial_requests where lower(email) = e) then
    return jsonb_build_object('status', 'exists');
  end if;
  if (select count(*) from public.trial_requests where created_at > now() - interval '1 hour') >= 30 then return jsonb_build_object('status', 'busy'); end if;
  insert into public.trial_requests (email, ref_code, verified_at) values (e, r, now());
  begin
    for a in select u.email from public.admins ad join auth.users u on u.id = ad.user_id where u.email is not null loop
      perform public.send_mail(a.email, '【築本算圖】新的試用申請：' || e, public.mail_frame(
        format('<p style="margin:0 0 12px">有新的試用申請：</p><p style="margin:0 0 12px;font-size:17px"><b>%s</b>%s</p>', public.esc_html(e),
          case when r is null then '' else format('<br><span style="font-size:14px;color:#6b7280">推薦碼 %s</span>', public.esc_html(r)) end)
        || '<p style="margin:0 0 12px;color:#6b7280;font-size:14px">申請者也會從手機用 LINE 傳訊息到官方帳號。開通時請填入對方的 LINE 名稱，同一個 LINE 帳號不能重複開通。</p>'
        || format('<p style="margin:0"><a href="%s/#/admin" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">到管理員後台開通</a></p>', site)));
    end loop;
  exception when others then null;
  end;
  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function public.apply_trial(text, text) from public;
grant execute on function public.apply_trial(text, text) to anon, authenticated;

-- no more self-opened accounts or the e-mail confirmation step: every trial goes through the administrator
do $$ begin
  revoke execute on function public.start_trial(text, text) from anon, authenticated, public;
exception when undefined_function then null; end $$;
do $$ begin
  revoke execute on function public.request_trial(text, text) from anon, authenticated, public;
exception when undefined_function then null; end $$;

-- administrator: the account or application that already used this LINE name (null when it is free)
create or replace function public.line_used(p_line text, p_email text default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare l text := lower(trim(coalesce(p_line, ''))); e text := lower(trim(coalesce(p_email, ''))); hit text;
begin
  if not public.is_admin() then raise exception '只有管理員可以查詢'; end if;
  if l = '' then return null; end if;
  select email into hit from public.profiles where lower(line_name) = l and lower(coalesce(email, '')) <> e limit 1;
  if hit is null then select email into hit from public.trial_requests where lower(line_name) = l and lower(email) <> e limit 1; end if;
  return hit;
end $$;
revoke execute on function public.line_used(text, text) from public;
grant execute on function public.line_used(text, text) to authenticated;

-- administrator: a deleted trial account keeps its application on record, so the address cannot apply again
create or replace function public.delete_trial_account(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  if not public.is_admin() then raise exception '只有管理員可以刪除帳號'; end if;
  if p_id = auth.uid() then raise exception '不能刪除自己的帳號'; end if;
  if exists (select 1 from public.admins where user_id = p_id) then raise exception '不能刪除管理員帳號'; end if;
  select * into p from public.profiles where id = p_id;
  if not found then raise exception '找不到這個帳號'; end if;
  if p.plan <> 'trial' then raise exception '只能刪除試用帳號（請先把方案改成試用）'; end if;
  begin
    delete from storage.objects where bucket_id = 'source-files' and (storage.foldername(name))[1] = p_id::text;
  exception when others then null;
  end;
  -- the LINE name moves to the application record, so that LINE account stays used too
  if p.email is not null then
    insert into public.trial_requests (email, verified_at, handled_at) select lower(p.email), now(), now()
    where not exists (select 1 from public.trial_requests where lower(email) = lower(p.email));
    if p.line_name is not null then
      update public.trial_requests set line_name = coalesce(line_name, p.line_name) where lower(email) = lower(p.email)
        and not exists (select 1 from public.trial_requests t where lower(t.line_name) = lower(p.line_name));
    end if;
  end if;
  delete from auth.users where id = p_id;
  return p.email;
end $$;
