-- 1) prefilled sign-in link in the account e-mails  2) administrator can delete trial accounts
-- The 登入築本算圖 button in the account e-mail (admin-opened accounts and self-service trials) opens the sign-in
-- page with the e-mail address and the password already filled in: <site>/#/login?email=…&pw=…
-- The values ride in the # part of the address, which the browser never sends to the server, and the page takes them
-- off the address bar as soon as it has read them. Safe to run again.

-- percent-encoding for a value in a link (letters, digits and - . _ ~ stay as they are)
create or replace function public.url_enc(s text) returns text language plpgsql immutable as $$
declare b bytea := convert_to(coalesce(s, ''), 'UTF8'); r text := ''; c int;
begin
  for i in 0..length(b) - 1 loop
    c := get_byte(b, i);
    if c between 48 and 57 or c between 65 and 90 or c between 97 and 122 or c in (45, 46, 95, 126) then r := r || chr(c);
    else r := r || '%' || upper(lpad(to_hex(c), 2, '0')); end if;
  end loop;
  return r;
end $$;

create or replace function public.login_link(p_email text, p_password text) returns text language sql stable security definer set search_path = public as $$
  select rtrim(coalesce(public.setting('site_url'), ''), '/') || '/#/login?email=' || public.url_enc(lower(trim(p_email))) || '&pw=' || public.url_enc(p_password)
$$;
revoke execute on function public.login_link(text, text) from public;

create or replace function public.login_button(p_email text, p_password text) returns text language sql stable security definer set search_path = public as $$
  select format('<p style="margin:0 0 8px"><a href="%s" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">登入築本算圖</a></p>', public.esc_html(public.login_link(p_email, p_password)))
    || '<p style="margin:0 0 8px;font-size:13px;color:#6b7280">按下按鈕會打開登入頁，並自動帶入上面的帳號和密碼。</p>'
$$;
revoke execute on function public.login_button(text, text) from public;

-- administrator: e-mail a newly opened account its sign-in details (as in 0007, with the prefilled link)
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
    || public.login_button(p_email, p_password)
    || '<p style="margin:12px 0 0;font-size:13px;color:#6b7280">每個帳號同一時間只能在一台裝置使用。登入後在「我的專案」→「個人資訊」可取得分享連結，朋友用你的連結試用達標，你的帳號可延長 7 天（限一次）。</p>'));
end $$;

-- self-service trial (as in 0010, with the prefilled link)
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

  -- the sign-up trigger has made the profile; it is a 7-day trial, linked to the friend who shared the link
  select id into referrer from public.profiles where ref_code = r and id <> uid;
  update public.profiles set plan = 'trial', expires_at = now() + interval '7 days', referred_by = referrer where id = uid;
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

-- administrator: delete a trial account for good (sign-in, profile, projects, usage, uploaded drawings, trial requests).
-- Only accounts on the trial plan; never an administrator or yourself. Returns the deleted e-mail address.
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
  exception when others then null;  -- newer storage versions only allow deleting files through the API; they stay as orphans
  end;
  if p.email is not null then delete from public.trial_requests where lower(email) = lower(p.email); end if;
  delete from auth.users where id = p_id;  -- profile, projects, usage and logins go with it (on delete cascade)
  return p.email;
end $$;
revoke execute on function public.delete_trial_account(uuid) from public;
grant execute on function public.delete_trial_account(uuid) to authenticated;
