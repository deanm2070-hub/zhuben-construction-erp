import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { AdminPage } from './components/AdminPage';
import { AuthPage, LOGIN_LINK } from './components/AuthPage';
import { Editor } from './components/Editor';
import { ProjectsPage } from './components/ProjectsPage';
import { CLAIM_FLAG, claimDevice, heartbeat, LINE_ADD, LINE_ID, isTrial, loadAccount, OPEN_ACCOUNT, type Account } from './lib/account';
import { supabase, supabaseConfigError } from './lib/supabase';
import { watchUpdates } from './lib/update';

const readRoute = () => {
  if (location.hash === '#/admin') return { admin: true as const };
  const m = location.hash.match(/^#\/p\/([\w-]+)(\/import)?$/);
  return m ? { id: m[1], importNow: !!m[2] } : null;
};

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  const [route, setRoute] = useState(readRoute);
  const [update, setUpdate] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(supabase ? null : OPEN_ACCOUNT);
  const uid = session?.user.id;
  const reloadAccount = async () => {
    if (!uid) return;
    // a password sign-in just happened on this device: it becomes the account's device first
    let claim = false;
    try { claim = sessionStorage.getItem(CLAIM_FLAG) === '1'; sessionStorage.removeItem(CLAIM_FLAG); } catch { /* private mode */ }
    if (claim) await claimDevice().catch(() => {});
    loadAccount(uid).then(setAccount).catch(() => setAccount(OPEN_ACCOUNT));
  };
  useEffect(() => { setAccount(supabase ? null : OPEN_ACCOUNT); reloadAccount(); }, [uid]);
  // another device may sign in on this account at any time: check every minute and whenever the app comes back to the front
  useEffect(() => {
    if (!uid) return;
    const check = () => { if (document.visibilityState === 'visible') loadAccount(uid).then(a => { if (a.elsewhere || !a.active) setAccount(a); }).catch(() => {}); };
    const t = setInterval(check, 60000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, [uid]);

  // minutes online: one per minute while the app is in front and has been used in the last 10 minutes
  const using = !!uid && !!account?.ready && account.active;
  useEffect(() => {
    if (!using) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach(e => addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - last < 10 * 60000) heartbeat().catch(() => {});
    }, 60000);
    return () => { clearInterval(t); evs.forEach(e => removeEventListener(e, touch)); };
  }, [using]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      // the e-mail's sign-in link is for another account than the one signed in on this device: show the sign-in page for it
      if (data.session && LOGIN_LINK?.email && data.session.user.email?.toLowerCase() !== LOGIN_LINK.email.toLowerCase()) { supabase!.auth.signOut({ scope: 'local' }).finally(() => setSession(null)); return; }
      setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  useEffect(() => watchUpdates(v => setUpdate(v)), []);

  const page = view();
  return update !== null ? <>{page}<div className="update-bar">
    <span>有新版本{update && ` ${update}`} 可以更新</span>
    <button className="chip on" onClick={() => location.reload()}>更新</button>
    <button className="chip ghost" onClick={() => setUpdate(null)}>稍後</button>
  </div></> : page;

  function view() {
    if (supabaseConfigError) {
      return (
        <div className="page"><div className="wrap">
          <h1>網站設定有誤</h1>
          <p className="note">{supabaseConfigError}</p>
          <p className="note">請到 Cloudflare 的 Build variables 檢查這兩個值，修正後重新部署。</p>
        </div></div>
      );
    }
    if (supabase && session === undefined) return <div className="page"><div className="wrap"><p className="note">載入中…</p></div></div>;
    if (supabase && !session) return <AuthPage />;
    if (!account) return <div className="page"><div className="wrap"><p className="note">載入中…</p></div></div>;
    if (account.elsewhere) return <Elsewhere email={session?.user.email ?? ''} />;
    if (!account.active) return <Expired email={session?.user.email ?? ''} profile={account.profile} />;
    if (route && 'admin' in route) return account.admin ? <AdminPage selfId={uid!} onBack={() => { location.hash = ''; }} /> : <ProjectsPage email={session?.user.email ?? null} account={account} onAccount={reloadAccount} onOpen={(id, importNow) => { location.hash = `#/p/${id}${importNow ? '/import' : ''}`; }} />;
    if (route) return <Editor key={route.id} projectId={route.id} importNow={route.importNow && !isTrial(account)} trial={isTrial(account)} onExit={() => { location.hash = ''; }} />;
    return <ProjectsPage email={session?.user.email ?? null} account={account} onAccount={reloadAccount} onOpen={(id, importNow) => { location.hash = `#/p/${id}${importNow ? '/import' : ''}`; }} />;
  }
}

/** Signed in, but the subscription has ended or the account is disabled. */
function Expired({ email, profile }: { email: string; profile: Account['profile'] }) {
  return (
    <div className="page"><div className="wrap" style={{ maxWidth: 520 }}>
      <img src="/logo.png" alt="築本算圖" width={72} height={72} />
      <h1>{profile?.disabled ? '帳號已停用' : profile ? '訂閱已到期' : '帳號尚未開通'}</h1>
      <p className="note">{email}{profile?.expires_at && !profile.disabled ? `，到期日 ${profile.expires_at.slice(0, 10)}` : ''}。請聯絡管理員續約或開通，完成後重新整理此頁即可繼續使用；你的專案都還保留著。</p>
      <div className="kv">
        <a className="chip key" href={LINE_ADD} target="_blank" rel="noopener" style={{ textDecoration: 'none' }}>LINE 聯絡管理員 {LINE_ID}</a>
        <button className="chip on" onClick={() => location.reload()}>重新整理</button>
        <button className="chip ghost" onClick={() => supabase!.auth.signOut()}>登出</button>
      </div>
    </div></div>
  );
}

/** This account has been signed in on another device since; only one device can use it at a time. */
function Elsewhere({ email }: { email: string }) {
  return (
    <div className="page"><div className="wrap" style={{ maxWidth: 520 }}>
      <img src="/logo.png" alt="築本算圖" width={72} height={72} />
      <h1>帳號已在其他裝置登入</h1>
      <p className="note">{email} 剛剛在另一台裝置登入，每個帳號同一時間只能在一台裝置使用，所以這台已登出。要改在這台使用，請重新登入（另一台就會被登出）。尚未儲存的修改無法再存到雲端。</p>
      <div className="kv">
        <button className="chip on" onClick={() => supabase!.auth.signOut({ scope: 'local' })}>在這台重新登入</button>
      </div>
    </div></div>
  );
}
