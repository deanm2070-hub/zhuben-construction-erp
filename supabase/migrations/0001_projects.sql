-- Projects: one row per 3D model, owned by the signed-in user.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '未命名專案',
  model jsonb not null default '{}'::jsonb,
  thumbnail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner_updated on public.projects (owner, updated_at desc);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();

alter table public.projects enable row level security;
create policy "owner reads" on public.projects for select using (owner = auth.uid());
create policy "owner inserts" on public.projects for insert with check (owner = auth.uid());
create policy "owner updates" on public.projects for update using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner deletes" on public.projects for delete using (owner = auth.uid());

-- Original DWG / DXF / PDF files, stored under <user id>/<project id>/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('source-files', 'source-files', false, 52428800)
on conflict (id) do nothing;
create policy "owner reads files" on storage.objects for select using (bucket_id = 'source-files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner uploads files" on storage.objects for insert with check (bucket_id = 'source-files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner deletes files" on storage.objects for delete using (bucket_id = 'source-files' and (storage.foldername(name))[1] = auth.uid()::text);
