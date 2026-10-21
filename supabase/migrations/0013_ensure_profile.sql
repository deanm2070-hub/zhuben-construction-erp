-- Every account gets its profile (plan and expiry) even when the sign-up trigger on auth.users did not make one:
-- a self-service trial account without a profile signed in to 「帳號尚未開通」. start_trial now writes the
-- profile itself, ensure_profile() repairs an account that signs in without one, and accounts already missing
-- a profile get their 7-day trial now. Safe to run again.

-- accounts already created without a profile: a 7-day trial from when the account was made
insert into public.profiles (id, email, plan, expires_at)
select u.id, u.email, 'trial', greatest(u.created_at + interval '7 days', now() + interval '1 day')
from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- signed-in account without a profile (sign-up trigger missing or failed): give it the 7-day trial
create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
declare u auth.users;
begin
  if auth.uid() is null or exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  select * into u from auth.users where id = auth.uid();
  if not found then return; end if;
  insert into public.profiles (id, email, plan, expires_at)
  values (u.id, u.email, 'trial', greatest(u.created_at + interval '7 days', now() + interval '1 day'))
  on conflict (id) do nothing;
end $$;
revoke execute on function public.ensure_profile() from public;
grant execute on function public.ensure_profile() to authenticated;

-- the sign-up trigger, made again in case it is missing
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- self-service trial (as in 0012), writing the profile itself instead of relying on the trigger
create or replace function public.start_trial(p_email text, p_ref text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  e text := lower(trim(p_email));
  r text := nullif(trim(coalesce(p_ref, '')), '');
  uid uuid := gen_random_uuid();
  pw text := '';
  chars text := 'abcdefghjkmnpqrstuvwxyz23456789';
  referrer uuid;
  a record;
  site text := coalesce(public.setting('site_url'), '');
begin
  if length(e) > 200 or not public.email_ok(e) or length(coalesce(r, '')) > 20 then return jsonb_build_object('status', 'invalid'); end if;
  if exists (select 1 from auth.users where lower(email) = e) then return jsonb_build_object('status', 'exists'); end if;
  if (select count(*) from public.trial_requests where created_at > now() - interval '1 hour') >= 30 then return jsonb_build_object('status', 'busy'); end if;
  for i in 1..8 loop pw := pw || substr(chars, 1 + floor(random() * length(chars))::int, 1); end loop;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e, crypt(pw, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true), 'email', now(), now(), now());

  -- a 7-day trial, linked to the friend who shared the link
  select id into referrer from public.profiles where ref_code = r and id <> uid;
  insert into public.profiles (id, email, plan, expires_at, referred_by) values (uid, e, 'trial', now() + interval '7 days', referrer)
  on conflict (id) do update set email = excluded.email, plan = 'trial', expires_at = excluded.expires_at, referred_by = excluded.referred_by;
  insert into public.trial_requests (email, ref_code, verified_at, handled_at) values (e, r, now(), now());

  perform public.send_mail(e, '【築本算圖】您的試用帳號已開通', public.mail_frame(
    format('<p style="margin:0 0 12px;font-size:16px;color:#111827">%s 您好：</p>', public.esc_html(e))
    || '<p style="margin:0 0 16px">感謝您申請築本算圖，您的 7 天試用帳號已開通，用下面的帳號密碼登入即可開始使用。</p>'
    || '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:0 0 16px;font-size:14px">'
    || format('<tr><td style="padding:6px 0;color:#6b7280;width:96px">帳號</td><td style="padding:6px 0;color:#111827;font-weight:600">%s</td></tr>', public.esc_html(e))
    || format('<tr><td style="padding:6px 0;color:#6b7280;width:96px">密碼</td><td style="padding:6px 0;color:#111827;font-weight:600;font-family:monospace;font-size:16px">%s</td></tr>', pw)
    || format('<tr><td style="padding:6px 0;color:#6b7280;width:96px">試用期限</td><td style="padding:6px 0;color:#111827;font-weight:600">%s</td></tr>', to_char((now() + interval '7 days') at time zone 'Asia/Taipei', 'YYYY-MM-DD'))
    || '</table>'
    || public.login_button(e, pw)
    || '<p style="margin:12px 0 0;font-size:13px;color:#6b7280">每個帳號同一時間只能在一台裝置使用。登入後在「我的專案」→「個人資訊」可取得分享連結，朋友用你的連結試用達標，你的帳號可延長 7 天（限一次）。</p>'));

  begin
    for a in select u.email from public.admins ad join auth.users u on u.id = ad.user_id where u.email is not null loop
      perform public.send_mail(a.email, '【築本算圖】新試用帳號已自動開通：' || e, public.mail_frame(
        format('<p style="margin:0 0 12px">新的試用帳號已自動開通，密碼已寄給對方：</p><p style="margin:0 0 12px;font-size:17px"><b>%s</b>%s</p>', public.esc_html(e),
          case when referrer is null then '' else format('<br><span style="font-size:14px;color:#6b7280">推薦人 %s</span>', public.esc_html((select email from public.profiles where id = referrer))) end)
        || format('<p style="margin:0"><a href="%s/#/admin" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">到管理員後台查看</a></p>', site)));
    end loop;
  exception when others then null;
  end;
  return jsonb_build_object('status', 'created');
end $$;
revoke execute on function public.start_trial(text, text) from public;
grant execute on function public.start_trial(text, text) to anon, authenticated;
