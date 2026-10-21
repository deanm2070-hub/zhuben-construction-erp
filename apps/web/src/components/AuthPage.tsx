import { useEffect, useState } from 'react';
import { CLAIM_FLAG, isMobile, LINE_ADD, LINE_ID, lineMessage, requestTrial, requestTrialBeacon, verifyTrial } from '../lib/account';
import { checkEmail } from '../lib/emailCheck';
import { supabase } from '../lib/supabase';
import { RELEASES, VERSION } from '../lib/version';

/** the share code from a friend's link (?ref=…), kept in case the visitor comes back later without it */
function referralCode() {
  const q = new URLSearchParams(location.search).get('ref');
  try {
    if (q) localStorage.setItem('zl-ref', q);
    return q || localStorage.getItem('zl-ref') || '';
  } catch { return q || ''; }
}

export function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // accounts are opened by the administrator after a trial request on LINE; there is no self sign-up
  const [mode, setMode] = useState<'in' | 'trial'>(() => new URLSearchParams(location.search).get('ref') ? 'trial' : 'in');
  const [ref] = useState(referralCode);
  const [sent, setSent] = useState(false);
  const mobile = isMobile();
  // the applicant's address is checked as it is typed (form, typos, throw-away services, a domain that takes mail)
  const [checked, setChecked] = useState<{ email: string; ok: boolean; err?: string } | null>(null);
  const okEmail = !!checked?.ok && checked.email === email.trim().toLowerCase();
  useEffect(() => {
    if (mode !== 'trial' || !email.trim()) { setChecked(null); return; }
    let live = true;
    const t = setTimeout(() => checkEmail(email).then(c => { if (live) setChecked({ email: email.trim().toLowerCase(), ok: c.ok, err: c.ok ? undefined : c.err }); }), 500);
    return () => { live = false; clearTimeout(t); };
  }, [email, mode]);
  // the link in the confirmation e-mail
  const [verified, setVerified] = useState<string | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('verify');
    if (!token || !supabase) return;
    history.replaceState(null, '', location.pathname);
    verifyTrial(token).then(e => e ? setVerified(e) : setMsg({ err: '這個確認連結無效或已過期，請重新申請' })).catch(x => setMsg({ err: String((x as Error).message || x) }));
  }, []);
  // computers: the request goes straight to the administrator from here (LINE links only show a QR code there)
  const sendRequest = async () => {
    setBusy(true); setMsg({});
    const c = await checkEmail(email);
    if (!c.ok) { setMsg({ err: c.err }); setBusy(false); return; }
    try { await requestTrial(c.email, ref); setSent(true); } catch (x) { setMsg({ err: `送出失敗：${(x as Error).message}。也可以用手機加 LINE ${LINE_ID} 申請` }); }
    setBusy(false);
  };
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode !== 'in') return;
    setBusy(true); setMsg({});
    const auth = supabase!.auth;
    // one device per account: the device signing in now takes over; the app claims it before loading the account
    try { sessionStorage.setItem(CLAIM_FLAG, '1'); } catch { /* private mode */ }
    const { error } = await auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) try { sessionStorage.removeItem(CLAIM_FLAG); } catch { /* private mode */ }
    if (error) setMsg({ err: error.message === 'Invalid login credentials' ? '電子郵件或密碼不正確' : error.message });
  };
  const request = `我想申請築本算圖試用\n電子郵件：${email.trim() || '（請填寫）'}${ref ? `\n推薦碼：${ref}` : ''}`;

  return (
    <div className="page">
      <form className="auth" onSubmit={submit}>
        <img src="/logo.png" alt="築本算圖" width={96} height={96} style={{ display: 'block', margin: '0 auto 8px' }} />
        <h1>築本算圖</h1>
        <p className="note">登入後，專案會存在雲端，換電腦也能繼續編輯。</p>
        {verified && <p className="note" style={{ color: 'var(--accent)' }}>✓ 已確認 {verified}，試用申請已送到管理員。開通後帳號和密碼會寄到這個信箱。</p>}
        {mode === 'in' ? <>
          <input id="email" type="email" autoComplete="email" placeholder="電子郵件" value={email} onChange={e => setEmail(e.target.value)} required />
          <input id="password" type="password" autoComplete="current-password" placeholder="密碼" value={password} onChange={e => setPassword(e.target.value)} required />
          <button className="chip on" disabled={busy}>登入</button>
          <button type="button" className="chip key" onClick={() => { setMode('trial'); setMsg({}); }}>第一次使用？申請免費試用</button>
        </> : <div className="trial">
          <h3>申請免費試用</h3>
          {sent ? <>
            <p className="note">還差一步 ✉️<br />確認信已寄到 <b>{email.trim()}</b>，請打開信件按「確認電子郵件」，申請才會送到管理員（沒看到請找垃圾郵件匣）。管理員開通後，帳號和密碼也會寄到這個信箱。</p>
            <button type="button" className="chip on" onClick={() => { setMode('in'); setSent(false); setMsg({}); }}>回到登入</button>
          </> : mobile ? <>
            <ol>
              <li>填寫你的電子郵件</li>
              <li>按「用 LINE 傳送申請」，會直接打開管理員 {LINE_ID} 的 LINE 對話並帶出寫好的訊息{ref && <>（含推薦碼 <b>{ref}</b>）</>}，按傳送即可</li>
              <li>管理員開通後會回覆你的密碼，回到這頁登入就能開始試用</li>
            </ol>
            <input id="trial-email" type="email" autoComplete="email" placeholder="你的電子郵件" value={email} onChange={e => setEmail(e.target.value)} />
            {checked && !checked.ok && checked.email === email.trim().toLowerCase() && <p className="err">{checked.err}</p>}
            <a className={`chip on${okEmail ? '' : ' off'}`} href={okEmail ? lineMessage(request) : undefined} rel="noopener"
              onClick={e => { if (!okEmail) { e.preventDefault(); setMsg({ err: checked?.err || '請先填寫正確的電子郵件' }); } else requestTrialBeacon(email.trim().toLowerCase(), ref); }}>用 LINE 傳送申請</a>
            <p className="note">送出後，也請到信箱點確認信裡的「確認電子郵件」，管理員才能為你開通。</p>
          </> : <>
            <ol>
              <li>填寫你的電子郵件，按「送出申請」，申請會直接送到管理員{ref && <>（含推薦碼 <b>{ref}</b>）</>}</li>
              <li>管理員開通後，帳號和密碼會寄到你的信箱，回到這頁登入就能開始試用</li>
            </ol>
            <input id="trial-email" type="email" autoComplete="email" placeholder="你的電子郵件" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendRequest(); } }} />
            {checked && !checked.ok && checked.email === email.trim().toLowerCase() && <p className="err">{checked.err}</p>}
            <button type="button" className="chip on" disabled={busy || (!!checked && !checked.ok)} onClick={sendRequest}>{busy ? '送出中…' : '送出申請'}</button>
            <p className="note">有問題也可以用手機加 LINE <a href={LINE_ADD} target="_blank" rel="noopener">{LINE_ID}</a> 聯絡管理員。</p>
          </>}
          {!sent && <button type="button" className="chip ghost" onClick={() => { setMode('in'); setMsg({}); }}>已有帳號？登入</button>}
        </div>}
        {msg.err && <p className="err">{msg.err}</p>}
        {msg.ok && <p className="note">{msg.ok}</p>}
        <details className="release">
          <summary>版本 {VERSION}（{RELEASES[0].date} 更新）</summary>
          {RELEASES.slice(0, 3).map(r => <div key={r.v}><b>{r.v}</b> {r.date}<ul>{r.notes.map(n => <li key={n}>{n}</li>)}</ul></div>)}
        </details>
      </form>
    </div>
  );
}
