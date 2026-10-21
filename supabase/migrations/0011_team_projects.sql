-- Team work on projects: project information for the project list (category, status, client …) and project
-- members who can view or edit a project they do not own. Applied by the "Database migrations" workflow,
-- or run once in the Supabase SQL Editor after 0007. Safe to run again.

alter table public.projects add column if not exists meta jsonb not null default '{}'::jsonb;

create table if not exists public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user on public.project_members (user_id);
alter table public.project_members enable row level security;

-- security definer so the projects policies can ask without recursing through the members policies
create or replace function public.project_role(p uuid) returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.projects where id = p and owner = auth.uid()) then 'owner'
    else (select role from public.project_members where project_id = p and user_id = auth.uid())
  end
$$;

drop policy if exists "member reads" on public.projects;
create policy "member reads" on public.projects for select
  using (public.is_active() and exists (select 1 from public.project_members m where m.project_id = id and m.user_id = auth.uid()));
drop policy if exists "editor updates" on public.projects;
create policy "editor updates" on public.projects for update
  using (public.is_active() and exists (select 1 from public.project_members m where m.project_id = id and m.user_id = auth.uid() and m.role = 'editor'))
  with check (public.is_active() and exists (select 1 from public.project_members m where m.project_id = id and m.user_id = auth.uid() and m.role = 'editor'));

-- only the owner may hand a project to someone else
create or replace function public.keep_owner() returns trigger language plpgsql as $$
begin
  if new.owner <> old.owner and old.owner <> auth.uid() then raise exception '只有專案擁有者可以變更擁有者'; end if;
  return new;
end $$;
drop trigger if exists projects_keep_owner on public.projects;
create trigger projects_keep_owner before update on public.projects for each row execute function public.keep_owner();

drop policy if exists "owner or self reads members" on public.project_members;
create policy "owner or self reads members" on public.project_members for select
  using (user_id = auth.uid() or public.project_role(project_id) in ('owner', 'editor'));
drop policy if exists "owner or self removes members" on public.project_members;
create policy "owner or self removes members" on public.project_members for delete
  using (user_id = auth.uid() or public.project_role(project_id) = 'owner');
grant select, delete on public.project_members to authenticated;

-- owner: add (or change the role of) a member by e-mail; the person needs an account. Returns the member's e-mail.
create or replace function public.share_project(p_project uuid, p_email text, p_role text default 'viewer') returns text
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email)); u uuid; pname text; site text;
begin
  if not public.is_active() then raise exception '帳號未啟用'; end if;
  select name into pname from public.projects where id = p_project and owner = auth.uid();
  if pname is null then raise exception '只有專案擁有者可以加入成員'; end if;
  if p_role not in ('viewer', 'editor') then raise exception '權限只能是檢視或編輯'; end if;
  select id into u from auth.users where lower(email) = e;
  if u is null then raise exception '% 還沒有築本算圖帳號，請對方先申請試用或由管理員開通', e; end if;
  if u = auth.uid() then raise exception '這是你自己的帳號'; end if;
  insert into public.project_members (project_id, user_id, email, role) values (p_project, u, e, p_role)
  on conflict (project_id, user_id) do update set role = excluded.role;
  -- let the member know; sharing still works if the mail cannot go out
  begin
    site := coalesce(public.setting('site_url'), '');
    perform public.send_mail(e, '【築本算圖】' || pname || ' 已和你共用', public.mail_frame(
      format('<p style="margin:0 0 12px">%s 把專案 <b>%s</b> 和你共用（%s）。</p>', public.esc_html((select email from auth.users where id = auth.uid())), public.esc_html(pname),
        case when p_role = 'editor' then '可以編輯' else '可以檢視' end)
      || format('<p style="margin:0"><a href="%s/#/p/%s" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">開啟專案</a></p>', site, p_project)));
  exception when others then null;
  end;
  return e;
end $$;
grant execute on function public.share_project(uuid, text, text) to authenticated;
grant execute on function public.project_role(uuid) to authenticated;

-- members can read the original drawings kept under the owner's folder <owner>/<project>/…
drop policy if exists "member reads files" on storage.objects;
create policy "member reads files" on storage.objects for select using (
  bucket_id = 'source-files' and public.is_active()
  and exists (select 1 from public.project_members m where m.project_id::text = (storage.foldername(name))[2] and m.user_id = auth.uid())
);
