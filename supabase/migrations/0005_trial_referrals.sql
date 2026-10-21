-- Trials through the administrator, referrals and usage time. Run once in the Supabase SQL Editor after 0004.
-- Safe to run again.
--
-- * Every account gets a share code; a new account the administrator opens can be linked to the account that
--   referred it. When the new account, within 7 days of being opened, has been online at least 60 minutes on each of
--   3 different days (Taiwan time), the referrer's expiry date moves 7 days later (once per new account).
-- * The app reports one minute of use every minute while it is open, in front and in use; the administrator sees
--   each account's sign-ins and minutes per day.

alter table public.profiles add column if not exists ref_code text unique default substr(md5(gen_random_uuid()::text), 1, 8);
update public.profiles set ref_code = substr(md5(gen_random_uuid()::text), 1, 8) where ref_code is null;
alter table public.profiles add column if not exists referred_by uuid references public.profiles (id) on delete set null;
alter table public.profiles add column if not exists referral_rewarded_at timestamptz;

create table if not exists public.usage_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,                 -- Taiwan date
  minutes int not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, day)
);
create table if not exists public.logins (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists logins_user_at on public.logins (user_id, at desc);
alter table public.usage_days enable row level security;
alter table public.logins enable row level security;
drop policy if exists "own usage or admin" on public.usage_days;
create policy "own usage or admin" on public.usage_days for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "own logins or admin" on public.logins;
create policy "own logins or admin" on public.logins for select using (user_id = auth.uid() or public.is_admin());
grant select on public.usage_days, public.logins to authenticated;

-- the referral reward of one account, given once its 3 qualifying days are reached
create or replace function public.check_referral(u uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.profiles; start date;
begin
  select * into p from public.profiles where id = u;
  if p.referred_by is null or p.referral_rewarded_at is not null then return false; end if;
  start := (p.created_at at time zone 'Asia/Taipei')::date;
  if (select count(*) from public.usage_days where user_id = u and minutes >= 60 and day >= start and day < start + 7) < 3 then return false; end if;
  update public.profiles set referral_rewarded_at = now() where id = u;
  -- no end date stays no end date; an expired referrer gets 7 days from now
  update public.profiles set expires_at = greatest(expires_at, now()) + interval '7 days' where id = p.referred_by and expires_at is not null;
  return true;
end $$;
revoke execute on function public.check_referral(uuid) from public, anon, authenticated;

-- called by the app once a minute while it is open and in use; counts at most one minute per 50 seconds
create or replace function public.heartbeat() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); d date := (now() at time zone 'Asia/Taipei')::date;
begin
  if u is null or not public.is_active() then return; end if;
  insert into public.usage_days as x (user_id, day, minutes) values (u, d, 1)
  on conflict (user_id, day) do update set
    minutes = x.minutes + case when now() - x.last_seen >= interval '50 seconds' then 1 else 0 end,
    last_seen = case when now() - x.last_seen >= interval '50 seconds' then now() else x.last_seen end;
  perform public.check_referral(u);
end $$;

-- signing in also records the time (replaces the 0003 version)
create or replace function public.claim_device() returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set active_session = public.current_session() where id = auth.uid();
  if auth.uid() is not null then insert into public.logins (user_id) values (auth.uid()); end if;
end $$;

-- the signed-in account's referrals: rewarded ones and ones still within their 7 days
create or replace function public.my_referrals() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rewarded', count(*) filter (where referral_rewarded_at is not null),
    'pending', count(*) filter (where referral_rewarded_at is null and created_at > now() - interval '7 days')
  ) from public.profiles where referred_by = auth.uid()
$$;
