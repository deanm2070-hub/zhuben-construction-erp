-- Product renamed 築量雲 → 築本算圖: the reminder e-mail and the stored sender name use the new name.
-- Run once in the Supabase SQL Editor after 0004 (and 0005). Safe to run again.

update public.app_settings set value = replace(value, '築量雲', '築本算圖') where value like '%築量雲%';

-- the same letter the admin page previews
create or replace function public.renewal_email(p_email text, p_plan text, p_expires timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  site text := coalesce(public.setting('site_url'), '');
  how text := coalesce(public.setting('renew_how'), '');
  d text := to_char(p_expires at time zone 'Asia/Taipei', 'YYYY-MM-DD');
  left_days int := greatest(1, ceil(extract(epoch from (p_expires - now())) / 86400)::int);
  plan text := case p_plan when 'trial' then '試用' when 'monthly' then '月訂' when 'yearly' then '年訂' when 'unlimited' then '不限期' else p_plan end;
  e text := replace(replace(replace(p_email, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  subject text := format('【築本算圖】您的訂閱將於 %s 到期，請續訂以繼續使用', d);
  row_t text := '<tr><td style="padding:6px 0;color:#6b7280;width:96px">%s</td><td style="padding:6px 0;color:#111827;font-weight:600">%s</td></tr>';
  html text;
begin
  html := '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    || '<body style="margin:0;background:#f3f4f6;font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',sans-serif">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">'
    || format('<tr><td style="background:#0f766e;padding:20px 24px;color:#ffffff"><img src="%s/logo.png" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px;background:#fff;margin-right:10px"><span style="font-size:20px;font-weight:800;vertical-align:middle">築本算圖</span></td></tr>', site)
    || '<tr><td style="padding:24px">'
    || format('<p style="margin:0 0 12px;font-size:16px;color:#111827">%s 您好：</p>', e)
    || format('<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151">感謝您使用築本算圖。您的訂閱即將到期，還剩 <b style="color:#b45309">%s 天</b>。</p>', left_days)
    || '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:0 0 16px;font-size:14px">'
    || format(row_t, '帳號', e) || format(row_t, '方案', plan) || format(row_t, '到期日', d)
    || '</table>'
    || '<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#374151">到期後將無法開啟及儲存專案；您的專案資料會完整保留，續訂後即可繼續使用。</p>'
    || format('<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151"><b>續訂方式：</b>%s</p>', replace(replace(how, '<', '&lt;'), E'\n', '<br>'))
    || format('<p style="margin:0 0 8px"><a href="%s" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">登入築本算圖</a></p>', site)
    || '</td></tr><tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">築本算圖 敬上・這是系統自動寄出的提醒信</td></tr>'
    || '</table></td></tr></table></body></html>';
  return jsonb_build_object('subject', subject, 'html', html);
end $$;
