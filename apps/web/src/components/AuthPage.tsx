import { useState } from 'react';
import { CLAIM_FLAG, LINE_ADD, LINE_ID, lineMessage } from '../lib/account';
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
  const request = `我想申請築量雲試用\n電子郵件：${email.trim() || '（請填寫）'}${ref ? `\n推薦碼：${ref}` : ''}`;

  return (
    <div className="page">
      <form className="auth" onSubmit={submit}>
        <img src="/logo.png" alt="築量雲" width={96} height={96} style={{ display: 'block', margin: '0 auto 8px' }} />
        <h1>築量雲</h1>
        <p className="note">登入後，專案會存在雲端，換電腦也能繼續編輯。</p>
        {mode === 'in' ? <>
          <input id="email" type="email" autoComplete="email" placeholder="電子郵件" value={email} onChange={e => setEmail(e.target.value)} required />
          <input id="password" type="password" autoComplete="current-password" placeholder="密碼" value={password} onChange={e => setPassword(e.target.value)} required />
          <button className="chip on" disabled={busy}>登入</button>
          <button type="button" className="chip key" onClick={() => { setMode('trial'); setMsg({}); }}>第一次使用？申請免費試用</button>
        </> : <div className="trial">
          <h3>申請免費試用</h3>
          <ol>
            <li>加入管理員 LINE 好友 <a href={LINE_ADD} target="_blank" rel="noopener">{LINE_ID}</a></li>
            <li>填寫你的電子郵件，按「傳送申請」，LINE 會帶出已寫好的訊息{ref && <>（含推薦碼 <b>{ref}</b>）</>}，送出即可</li>
            <li>管理員開通後會在 LINE 回覆你的密碼，回到這頁登入就能開始試用</li>
          </ol>
          <a className="chip key" href={LINE_ADD} target="_blank" rel="noopener">① 加入 LINE {LINE_ID}</a>
          <input id="trial-email" type="email" autoComplete="email" placeholder="你的電子郵件" value={email} onChange={e => setEmail(e.target.value)} />
          <a className={`chip on${email.includes('@') ? '' : ' off'}`} href={email.includes('@') ? lineMessage(request) : undefined} target="_blank" rel="noopener" onClick={e => { if (!email.includes('@')) { e.preventDefault(); setMsg({ err: '請先填寫電子郵件' }); } }}>② 傳送申請</a>
          <button type="button" className="chip ghost" onClick={() => { setMode('in'); setMsg({}); }}>已有帳號？登入</button>
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
