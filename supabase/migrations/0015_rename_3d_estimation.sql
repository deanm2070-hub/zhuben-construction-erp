-- Product renamed 築本算圖 → 築本3D工程估算 (Zhuben 3D Engineering Estimation): every e-mail the database sends
-- (renewal reminders, trial and welcome letters) and the stored sender name use the new name.
-- Run once in the Supabase SQL Editor. Safe to run again.

update public.app_settings set value = replace(value, '築本算圖', '築本3D工程估算') where value like '%築本算圖%';

-- each function whose body still carries the old name is re-created with the new one, as it is now in the database
do $$
declare
  f record;
  def text;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosrc like '%築本算圖%'
  loop
    def := replace(pg_get_functiondef(f.oid), '築本算圖', '築本3D工程估算');
    execute def;
  end loop;
end $$;
