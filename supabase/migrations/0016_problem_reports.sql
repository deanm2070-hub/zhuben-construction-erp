-- 回報問題: a user sends the model, its sanity-check list, the original drawings and a note to the administrators in one
-- press. Administrators see the list on the 管理員後台, can open the snapshot as their own project and download the
-- drawings. Run once in the Supabase SQL Editor after 0015. Safe to run again.

create table if not exists public.problem_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid,
  email text,
  project_id uuid,
  project_name text,
  text text,
  issues jsonb,
  model jsonb,
  sources jsonb,
  version text,
  status text not null default 'new'
);
alter table public.problem_reports enable row level security;
drop policy if exists "admin reads reports" on public.problem_reports;
create policy "admin reads reports" on public.problem_reports for select using (public.is_admin());
drop policy if exists "admin updates reports" on public.problem_reports;
create policy "admin updates reports" on public.problem_reports for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin deletes reports" on public.problem_reports;
create policy "admin deletes reports" on public.problem_reports for delete using (public.is_admin());
grant select, update, delete on public.problem_reports to authenticated;

-- administrators may download any user's original drawings (to look at a reported problem)
drop policy if exists "admin reads files" on storage.objects;
create policy "admin reads files" on storage.objects for select using (bucket_id = 'source-files' and public.is_admin());

-- called by the signed-in owner (or member) of a project
create or replace function public.report_problem(p_project uuid, p_text text, p_issues jsonb default null, p_version text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p record; files jsonb; rid uuid; mail text; a record; site text := coalesce(public.setting('site_url'), '');
  nwarn int := 0; nfix int := 0; body text;
begin
  if me is null then raise exception '請先登入'; end if;
  select pr.id, pr.owner, pr.name, pr.model into p from public.projects pr
    where pr.id = p_project and (pr.owner = me or exists (select 1 from public.project_members m where m.project_id = pr.id and m.user_id = me));
  if p.id is null then raise exception '找不到這個專案'; end if;
  if (select count(*) from public.problem_reports r where r.user_id = me and r.created_at > now() - interval '1 hour') >= 20 then raise exception '回報太頻繁，請稍後再試'; end if;
  select u.email into mail from auth.users u where u.id = me;
  select coalesce(jsonb_agg(jsonb_build_object('path', o.name, 'name', regexp_replace(split_part(o.name, '/', 3), '^\d+-', ''), 'size', coalesce((o.metadata->>'size')::bigint, 0)) order by o.created_at desc), '[]'::jsonb)
    into files from storage.objects o where o.bucket_id = 'source-files' and (storage.foldername(o.name))[1] = p.owner::text and (storage.foldername(o.name))[2] = p.id::text;
  insert into public.problem_reports (user_id, email, project_id, project_name, text, issues, model, sources, version)
    values (me, mail, p.id, p.name, left(coalesce(p_text, ''), 4000), p_issues, p.model, files, left(coalesce(p_version, ''), 40)) returning id into rid;
  -- tell the administrators; the report is kept even if the e-mail cannot go out
  begin
    if p_issues is not null and jsonb_typeof(p_issues) = 'array' then
      select count(*) filter (where i->>'sev' = 'warn'), count(*) filter (where i->>'sev' = 'fixed') into nwarn, nfix from jsonb_array_elements(p_issues) i;
    end if;
    body := format('<p style="margin:0 0 12px"><b>%s</b> 回報了專案「%s」的問題：</p>', public.esc_html(mail), public.esc_html(p.name))
      || format('<p style="margin:0 0 12px;white-space:pre-wrap;background:#f9fafb;border-radius:10px;padding:12px">%s</p>', public.esc_html(nullif(trim(p_text), '')))
      || format('<p style="margin:0 0 12px;font-size:14px;color:#6b7280">自檢：%s 項要看、%s 項自動補・圖面 %s 個檔・版本 %s</p>', nwarn, nfix, jsonb_array_length(files), public.esc_html(p_version))
      || format('<p style="margin:0"><a href="%s/#/admin" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">到管理員後台查看</a></p>', site);
    for a in select u.email from public.admins ad join auth.users u on u.id = ad.user_id where u.email is not null loop
      perform public.send_mail(a.email, '【築本3D工程估算】問題回報：' || coalesce(p.name, '') || '（' || coalesce(mail, '') || '）', public.mail_frame(body));
    end loop;
  exception when others then null;
  end;
  return rid;
end $$;
grant execute on function public.report_problem(uuid, text, jsonb, text) to authenticated;

-- administrator: copy the reported model into a project of their own and open it
create or replace function public.adopt_report(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare r record; pid uuid;
begin
  if not public.is_admin() then raise exception '只有管理員可以開啟回報'; end if;
  select * into r from public.problem_reports where id = p_id;
  if r.id is null then raise exception '找不到這筆回報'; end if;
  insert into public.projects (owner, name, model) values (auth.uid(), '回報：' || coalesce(r.project_name, '未命名') || '（' || coalesce(r.email, '') || '）', coalesce(r.model, '{}'::jsonb)) returning id into pid;
  update public.problem_reports set status = 'opened' where id = p_id and status = 'new';
  return pid;
end $$;
grant execute on function public.adopt_report(uuid) to authenticated;
