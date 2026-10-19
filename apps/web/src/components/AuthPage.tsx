import { useState } from 'react';
import { supabase } from '../lib/supabase';

export function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg({});
    const auth = supabase!.auth;
    const { error } = mode === 'in'
      ? await auth.signInWithPassword({ email, password })
      : await auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
    setBusy(false);
    if (error) setMsg({ err: error.message === 'Invalid login credentials' ? '電子郵件或密碼不正確' : error.message });
    else if (mode === 'up') setMsg({ ok: '註冊信已寄出，請到信箱點連結啟用帳號後再登入。' });
  };

  return (
    <div className="page">
      <form className="auth" onSubmit={submit}>
        <h1>雲端室內建模</h1>
        <p className="note">登入後，專案會存在雲端，換電腦也能繼續編輯。</p>
        <input id="email" type="email" autoComplete="email" placeholder="電子郵件" value={email} onChange={e => setEmail(e.target.value)} required />
        <input id="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} placeholder="密碼（至少 6 碼）" minLength={6} value={password} onChange={e => setPassword(e.target.value)} required />
        <button className="chip on" disabled={busy}>{mode === 'in' ? '登入' : '註冊'}</button>
        <button type="button" className="chip ghost" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg({}); }}>
          {mode === 'in' ? '還沒有帳號？註冊' : '已有帳號？登入'}
        </button>
        {msg.err && <p className="err">{msg.err}</p>}
        {msg.ok && <p className="note">{msg.ok}</p>}
      </form>
    </div>
  );
}
