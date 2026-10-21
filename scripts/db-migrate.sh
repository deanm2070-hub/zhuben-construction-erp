#!/usr/bin/env bash
# Applies the SQL files in supabase/migrations that the database has not run yet, in name order, each in one
# transaction, and records them in public._migrations. Used by .github/workflows/db-migrate.yml with the
# SUPABASE_DB_URL secret (Supabase → Connect → Session pooler URI).
set -euo pipefail
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
psql() { command psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

# 0001–0007 were run by hand in the SQL Editor before this existed
psql <<'SQL'
create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now());
alter table public._migrations enable row level security;
insert into public._migrations (name) values
  ('0001_projects.sql'), ('0002_subscriptions.sql'), ('0003_single_device.sql'), ('0004_renewal_reminders.sql'),
  ('0005_trial_referrals.sql'), ('0006_rename.sql'), ('0007_trial_requests.sql')
on conflict (name) do nothing;
SQL

applied=$(psql -A -t -c 'select name from public._migrations')
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f")
  if grep -qxF "$n" <<<"$applied"; then continue; fi
  echo "applying $n"
  psql -1 -f "$f" -c "insert into public._migrations (name) values ('$n')"
done
echo "database is up to date"
