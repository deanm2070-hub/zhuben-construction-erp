-- One device per account: signing in on a new device makes it the account's device, and the earlier device can no
-- longer read or save projects (it is told to sign in again). Administrators are not limited.
-- Run once in the Supabase SQL Editor after 0002_subscriptions.sql. Safe to run again.

alter table public.profiles add column if not exists active_session text;

-- the sign-in session of the calling device (Supabase puts it in the access token)
create or replace function public.current_session() returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'session_id', '')
$$;

-- called by the app right after a password sign-in: this device becomes the account's device
create or replace function public.claim_device() returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set active_session = public.current_session() where id = auth.uid();
end $$;

-- false when the account has since been signed in on another device
create or replace function public.device_ok() returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active_session is not null and p.active_session <> public.current_session()
  )
$$;

create or replace function public.is_active() returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and not p.disabled and (p.expires_at is null or p.expires_at > now())
      and (p.active_session is null or p.active_session = public.current_session())
  )
$$;
