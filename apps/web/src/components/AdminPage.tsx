import { useEffect, useState } from 'react';
import { createAccount, extend, listProfiles, loadSettings, PLANS, runReminders, saveSetting, sendTestReminder, updateProfile, type Profile } from '../lib/account';
import { daysLeft, dueForReminder, REMIND_DAYS, reminderEmail, RENEW_HOW } from '../lib/reminder';
import { Modal } from './Modal';

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const status = (p: Profile) => p.disabled ? { t: '已停用', c: 'err' } : p.expires_at && new Date(p.expires_at) <= new Date() ? { t: '已到期', c: 'err' } : { t: '使用中', c: 'ok' };

/** 管理員後台: every account with its plan and expiry; add accounts, extend, disable. */
export function AdminPage({ selfId, onBack }: { selfId: string; onBack: () => void }) {
  const [list, setList] = useState<Profile[] | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ email: '', password: '', plan: 'monthly', expires: day(extend(null, 1)) });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Profile | null>(null);
  // null: the reminder migration (0004) has not been run, so mail is only simulated
  const [settings, setSettings] = useState<Record<string, string> | null>(null);

  const refresh = () => listProfiles().then(setList).catch(e => setErr(String(e.message || e)));
  useEffect(() => { refresh(); loadSettings().then(setSettings); }, []);

  const act = async (f: () => Promise<string>) => {
    setErr(''); setMsg(''); setBusy(true);
    try { setMsg(await f()); refresh(); } catch (e) { setErr(String((e as Error).message || e)); }
    setBusy(false);
  };
  const setting = (key: string, value: string) => {
    if (!settings || settings[key] === value) return;
    setSettings({ ...settings, [key]: value });
    act(async () => { await saveSetting(key, value); return '寄信設定已存'; });
  };

  const patch = async (p: Profile, change: Parameters<typeof updateProfile>[1], done: string) => {
    setErr(''); setMsg('');
    try { await updateProfile(p.id, change); setMsg(`${p.email}：${done}`); refresh(); } catch (e) { setErr(String((e as Error).message || e)); }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await createAccount(form.email.trim(), form.password, form.plan, form.plan === 'unlimited' || !form.expires ? null : new Date(`${form.expires}T23:59:59`).toISOString());
      setMsg(`已建立 ${form.email}${r.confirm ? '，對方需先到信箱點啟用連結才能登入' : ''}`);
      setForm({ ...form, email: '', password: '' });
      refresh();
    } catch (x) { setErr(String((x as Error).message || x)); }
    setBusy(false);
  };

  const shown = (list || []).filter(p => !q || (p.email || '').includes(q) || (p.note || '').includes(q));
  const active = (list || []).filter(p => status(p).c === 'ok').length;
  const due = dueForReminder(list || []);
  const mail = preview && reminderEmail(preview, settings?.site_url || location.origin, new Date(), settings?.renew_how || RENEW_HOW);

  return (
    <div className="page">
      <div className="wrap">
        <div className="head">
          <h1>管理員後台</h1>
          <button className="chip ghost" onClick={onBack}>← 我的專案</button>
        </div>
        <p className="note">共 {list?.length ?? '…'} 個帳號，使用中 {active} 個。到期或停用的帳號登入後只會看到續約提示，打不開專案（資料仍保留，延長後就恢復）。新註冊的帳號自動有 14 天試用。</p>

        <div className="card">
          <h3>{REMIND_DAYS} 天內到期（續訂提醒信）</h3>
          {settings ? <>
            <p className="note">每天早上 9 點，系統自動寄續訂提醒信給 {REMIND_DAYS} 天內到期的帳號（同一個到期日只寄一次；延長後下次到期前會再寄）。對方付款後在這裡延長即可。</p>
            <div className="kv">
              <label className="note">寄件人 <input id="mail-from" type="text" defaultValue={settings.mail_from || ''} onBlur={e => setting('mail_from', e.target.value.trim())} /></label>
              <label className="note">回覆信箱 <input id="reply-to" type="email" placeholder="客戶回信寄到這裡" defaultValue={settings.reply_to || ''} onBlur={e => setting('reply_to', e.target.value.trim())} /></label>
            </div>
            <label className="note">續訂方式（信中顯示，可寫匯款帳號、電話、LINE）<textarea id="renew-how" rows={3} style={{ width: '100%' }} defaultValue={settings.renew_how || RENEW_HOW} onBlur={e => setting('renew_how', e.target.value.trim())} /></label>
            <div className="acts"><button className="chip" disabled={busy} onClick={() => act(async () => `已寄出 ${await runReminders()} 封提醒信`)}>立即執行提醒</button></div>
          </> : <p className="note">到期前 {REMIND_DAYS} 天，系統會寄續訂提醒信到該帳號的電子郵件。目前為模擬：按「預覽通知信」看信件內容，還不會真的寄出（在 Supabase 執行 0004_renewal_reminders.sql 後就會自動寄）。對方付款後在這裡延長即可。</p>}
          {due.length === 0 ? <p className="note">目前沒有 {REMIND_DAYS} 天內到期的帳號。{list?.some(p => p.expires_at) ? '' : '（可先到下方任一帳號按「預覽通知信」看看信件）'}</p> : due.map(p => (
            <div className="kv" key={p.id}>
              <span><b>{p.email}</b>・剩 {daysLeft(p)} 天（{p.expires_at!.slice(0, 10)}）{settings && (p.reminded_at ? `・已寄提醒 ${day(p.reminded_at)}` : '・尚未寄提醒')}</span>
              <button className="chip" onClick={() => setPreview(p)}>預覽通知信</button>
              <button className="chip" onClick={() => patch(p, { expires_at: extend(p.expires_at, 1), disabled: false }, '延長 1 個月')}>+1 個月</button>
              <button className="chip" onClick={() => patch(p, { expires_at: extend(p.expires_at, 12), disabled: false }, '延長 1 年')}>+1 年</button>
            </div>
          ))}
        </div>

        <form className="card" onSubmit={add}>
          <h3>新增帳號</h3>
          <div className="kv">
            <input id="new-email" type="email" placeholder="電子郵件" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
            <input id="new-password" type="text" placeholder="初始密碼（至少 6 碼）" minLength={6} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
            <select id="new-plan" value={form.plan} onChange={e => { const plan = e.target.value; setForm({ ...form, plan, expires: plan === 'yearly' ? day(extend(null, 12)) : plan === 'monthly' ? day(extend(null, 1)) : plan === 'trial' ? day(new Date(Date.now() + 14 * 864e5).toISOString()) : '' }); }}>
              {Object.entries(PLANS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {form.plan !== 'unlimited' && <label className="note">到期日 <input id="new-expires" type="date" value={form.expires} onChange={e => setForm({ ...form, expires: e.target.value })} required /></label>}
            <button className="chip on" disabled={busy}>{busy ? '建立中…' : '建立帳號'}</button>
          </div>
        </form>

        {err && <p className="err">{err}</p>}
        {msg && <p className="note">{msg}</p>}
        <input id="admin-search" type="search" placeholder="搜尋電子郵件或備註" value={q} onChange={e => setQ(e.target.value)} />

        {list === null ? <p className="note">載入中…</p> : (
          <div className="grid">
            {shown.map(p => {
              const s = status(p), self = p.id === selfId;
              return (
                <div className="card" key={p.id}>
                  <h3 title={p.email || ''}>{p.email}{self && '（你）'}</h3>
                  <span className={s.c === 'err' ? 'err' : 'meta'}>{s.t}・{PLANS[p.plan] || p.plan}・{p.expires_at ? `到期 ${day(p.expires_at)}` : '不限期'}</span>
                  <span className="meta">建立於 {day(p.created_at)}</span>
                  <div className="kv">
                    <select id={`plan-${p.id}`} value={p.plan} onChange={e => patch(p, { plan: e.target.value, ...(e.target.value === 'unlimited' ? { expires_at: null } : {}) }, `方案改為${PLANS[e.target.value]}`)}>
                      {Object.entries(PLANS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <input id={`exp-${p.id}`} type="date" value={day(p.expires_at)} onChange={e => patch(p, { expires_at: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null }, `到期日改為 ${e.target.value || '不限期'}`)} />
                  </div>
                  <div className="acts">
                    <button className="chip" onClick={() => patch(p, { expires_at: extend(p.expires_at, 1), disabled: false }, '延長 1 個月')}>+1 個月</button>
                    <button className="chip" onClick={() => patch(p, { expires_at: extend(p.expires_at, 12), disabled: false }, '延長 1 年')}>+1 年</button>
                    <button className="chip ghost" onClick={() => setPreview(p.expires_at ? p : { ...p, expires_at: new Date(Date.now() + REMIND_DAYS * 864e5).toISOString() })}>預覽通知信</button>
                    {!self && <button className={`chip ${p.disabled ? 'on' : 'ghost'}`} onClick={() => patch(p, { disabled: !p.disabled }, p.disabled ? '已恢復' : '已停用')}>{p.disabled ? '恢復' : '停用'}</button>}
                  </div>
                  <input id={`note-${p.id}`} type="text" placeholder="備註（公司、聯絡人、付款紀錄）" defaultValue={p.note || ''} onBlur={e => { if (e.target.value !== (p.note || '')) patch(p, { note: e.target.value || null }, '備註已存'); }} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {mail && (
        <Modal title={settings ? '續訂提醒信預覽' : '續訂提醒信（模擬，未寄出）'} desc={<>收件人：{mail.to}<br />主旨：{mail.subject}</>} onClose={() => setPreview(null)}
          actions={<>
            {settings && <button className="chip" disabled={busy} onClick={() => { const p = preview!; setPreview(null); act(async () => `測試信已寄到 ${await sendTestReminder(p.id)}，請到信箱查看（沒看到請找垃圾郵件）`); }}>寄測試信給我</button>}
            <button className="chip on" onClick={() => setPreview(null)}>關閉</button>
          </>}>
          <iframe title="信件預覽" srcDoc={mail.html} style={{ width: '100%', height: 520, border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} />
        </Modal>
      )}
    </div>
  );
}
