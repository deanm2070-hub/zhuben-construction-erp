/**
 * Is this an address someone can actually receive mail at? Checks the form, refuses throw-away mailbox services,
 * catches common typos of big providers, and asks DNS whether the domain accepts mail. The database checks the form
 * and the throw-away list again, and the confirmation e-mail proves the mailbox is real.
 */
const FORM = /^[a-z0-9][a-z0-9._%+-]{0,63}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const THROWAWAY = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'test.tw', 'abc.com', 'xxx.com', 'aaa.com', 'email.com',
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com', 'grr.la', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'tempmail.net', 'tempail.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc',
  'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'emailondeck.com', 'mohmal.com', 'mailnesia.com', 'mytemp.email', 'tempr.email',
  'discard.email', 'spamgourmet.com', 'moakt.com', 'burnermail.io', 'inboxkitten.com', '1secmail.com', 'linshiyouxiang.net']);
const TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com',
  'gmaill.com': 'gmail.com', 'gmail.com.tw': 'gmail.com', 'gnail.com': 'gmail.com', 'yahoo.con': 'yahoo.com', 'yaho.com': 'yahoo.com',
  'yahoo.com.t': 'yahoo.com.tw', 'yahoo.tw': 'yahoo.com.tw', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com', 'msa.hinet.net.tw': 'msa.hinet.net',
};

export type EmailCheck = { ok: true; email: string } | { ok: false; err: string };

async function acceptsMail(domain: string): Promise<boolean | null> {
  const ask = async (type: string) => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`, { signal: ctl.signal });
      return await r.json() as { Status: number; Answer?: { type: number }[] };
    } finally { clearTimeout(t); }
  };
  try {
    const mx = await ask('MX');
    if (mx.Status === 3) return false;                              // the domain does not exist
    if (mx.Answer?.some(a => a.type === 15)) return true;
    const a = await ask('A');                                        // no MX: mail goes to the domain's own address
    return !!a.Answer?.some(x => x.type === 1);
  } catch { return null; }                                           // DNS not reachable: leave it to the confirmation e-mail
}

export async function checkEmail(raw: string): Promise<EmailCheck> {
  const email = raw.trim().toLowerCase();
  if (!FORM.test(email) || email.includes('..')) return { ok: false, err: '電子郵件格式不正確，請重新輸入' };
  const domain = email.split('@')[1];
  if (TYPOS[domain]) return { ok: false, err: `是不是打錯了？應該是 ${email.split('@')[0]}@${TYPOS[domain]}` };
  if (THROWAWAY.has(domain)) return { ok: false, err: '請使用您平常收信的電子郵件，不接受臨時或測試信箱' };
  if (await acceptsMail(domain) === false) return { ok: false, err: `「${domain}」這個網域無法收信，請確認電子郵件是否正確` };
  return { ok: true, email };
}
