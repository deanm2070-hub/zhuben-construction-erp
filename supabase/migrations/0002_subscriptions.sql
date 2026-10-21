-- Subscriptions: every account has a profile with its plan and expiry; administrators manage them from the
-- 管理員後台 page. Run once in the Supabase SQL Editor after 0001_projects.sql. Safe to run again.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'trial',          -- trial 試用 / monthly 月訂 / yearly 年訂 / unlimited 不限期
  expires_at timestamptz default now() + interval '14 days',   -- null = no end date
  disabled boolean not null default false,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- every new sign-up (self-registered or created from the admin page) gets a 14-day trial
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- accounts that existed before subscriptions keep working with no end date
insert into public.profiles (id, email, plan, expires_at)
select id, email, 'unlimited', null from auth.users
on conflict (id) do nothing;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- signed in, not disabled and not past the expiry date (administrators always)
create or replace function public.is_active() returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and not p.disabled and (p.expires_at is null or p.expires_at > now())
  )
$$;

-- the first account to call this becomes the administrator; afterwards it does nothing
create or replace function public.claim_admin() returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or exists (select 1 from public.admins) then return false; end if;
  insert into public.admins (user_id) values (auth.uid());
  return true;
end $$;

create or replace function public.admin_exists() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins)
$$;

alter table public.profiles enable row level security;
alter table public.admins enable row level security;
drop policy if exists "own profile or admin" on public.profiles;
create policy "own profile or admin" on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists "admin updates profiles" on public.profiles;
create policy "admin updates profiles" on public.profiles for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin reads admins" on public.admins;
create policy "admin reads admins" on public.admins for select using (public.is_admin() or user_id = auth.uid());

-- projects and source files only for active accounts
drop policy if exists "owner reads" on public.projects;
drop policy if exists "owner inserts" on public.projects;
drop policy if exists "owner updates" on public.projects;
drop policy if exists "owner deletes" on public.projects;
create policy "owner reads" on public.projects for select using (owner = auth.uid() and public.is_active());
create policy "owner inserts" on public.projects for insert with check (owner = auth.uid() and public.is_active());
create policy "owner updates" on public.projects for update using (owner = auth.uid() and public.is_active()) with check (owner = auth.uid() and public.is_active());
create policy "owner deletes" on public.projects for delete using (owner = auth.uid() and public.is_active());

drop policy if exists "owner reads files" on storage.objects;
drop policy if exists "owner uploads files" on storage.objects;
drop policy if exists "owner deletes files" on storage.objects;
create policy "owner reads files" on storage.objects for select using (bucket_id = 'source-files' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());
create policy "owner uploads files" on storage.objects for insert with check (bucket_id = 'source-files' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());
create policy "owner deletes files" on storage.objects for delete using (bucket_id = 'source-files' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());
