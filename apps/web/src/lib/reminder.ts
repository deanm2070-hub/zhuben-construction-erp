import { PLANS, type Profile } from './account';

/** how many days before the expiry date the renewal reminder goes out */
export const REMIND_DAYS = 14;
/** a trial lasts only 7 days, so its reminder goes out 2 days before the end */
export const TRIAL_REMIND_DAYS = 2;
export const remindDays = (p: Profile) => (p.plan === 'trial' ? TRIAL_REMIND_DAYS : REMIND_DAYS);

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const daysLeft = (p: Profile, now = new Date()) => p.expires_at ? Math.ceil((new Date(p.expires_at).getTime() - now.getTime()) / 864e5) : Infinity;

/** accounts whose expiry falls within the reminder window (and has not passed), soonest first */
export function dueForReminder(list: Profile[], now = new Date()) {
  return list.filter(p => !p.disabled && p.expires_at && daysLeft(p, now) > 0 && daysLeft(p, now) <= remindDays(p))
    .sort((a, b) => daysLeft(a, now) - daysLeft(b, now));
}

/**
 * The renewal reminder sent to an account 14 days before it expires. Plain table layout and inline styles so it
 * shows the same in Gmail, Outlook and phone mail apps.
 */
export const RENEW_HOW = '請直接回覆這封信，或與我們聯絡，確認付款後我們會為您延長使用期限。';

export function reminderEmail(p: Profile, site = location.origin, now = new Date(), how = RENEW_HOW) {
  const date = (p.expires_at || '').slice(0, 10), left = daysLeft(p, now), plan = PLANS[p.plan] || p.plan;
  const subject = `【築本3D工程估算】您的訂閱將於 ${date} 到期，請續訂以繼續使用`;
  const text = [
    `${p.email} 您好：`, '',
    `感謝您使用築本3D工程估算。您的帳號（${plan}方案）將於 ${date} 到期，剩下 ${left} 天。`,
    '到期後將無法開啟及儲存專案；您的專案資料會完整保留，續訂後即可繼續使用。', '',
    `續訂方式：${how}`, '',
    `登入築本3D工程估算：${site}`, '', '築本3D工程估算 敬上', '（這是系統自動寄出的提醒信）',
  ].join('\n');
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#6b7280;width:96px">${k}</td><td style="padding:6px 0;color:#111827;font-weight:600">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:#0f766e;padding:20px 24px;color:#ffffff"><img src="${esc(site)}/logo.png" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px;background:#fff;margin-right:10px"><span style="font-size:20px;font-weight:800;vertical-align:middle">築本3D工程估算</span></td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px;font-size:16px;color:#111827">${esc(p.email || '')} 您好：</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151">感謝您使用築本3D工程估算。您的訂閱即將到期，還剩 <b style="color:#b45309">${left} 天</b>。</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:0 0 16px;font-size:14px">
${row('帳號', p.email || '')}${row('方案', plan)}${row('到期日', date)}
</table>
<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#374151">到期後將無法開啟及儲存專案；您的專案資料會完整保留，續訂後即可繼續使用。</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151"><b>續訂方式：</b>${esc(how).replace(/\n/g, '<br>')}</p>
<p style="margin:0 0 8px"><a href="${esc(site)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px">登入築本3D工程估算</a></p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">築本3D工程估算 敬上・這是系統自動寄出的提醒信</td></tr>
</table></td></tr></table></body></html>`;
  return { to: p.email || '', subject, text, html };
}
