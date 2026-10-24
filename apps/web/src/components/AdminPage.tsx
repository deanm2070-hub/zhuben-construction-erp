import { useEffect, useState } from 'react';
import { adoptReport, createAccount, listReports, setReportStatus, type ProblemReport, deleteTrialAccount, lineUsed, extend, handleTrialRequest, listProfiles, listTrialRequests, listUsage, newPassword, sendWelcome, type TrialRequest, loadSettings, PLANS, REFERRAL, TRIAL_DAYS, runReminders, saveSetting, sendTestReminder, updateProfile, type Login, type Profile, type UsageDay } from '../lib/account';
import { daysLeft, dueForReminder, REMIND_DAYS, reminderEmail, RENEW_HOW, TRIAL_REMIND_DAYS } from '../lib/reminder';
import { Modal } from './Modal';
import { store } from '../lib/store';

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
const when = (iso: string) => `${new Date(iso).toLocaleDateString('zh-TW')} ${time(iso)}`;
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`);
const taipeiDay = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const status = (p: Profile) => p.disabled ? { t: '已停用', c: 'err' } : p.expires_at && new Date(p.expires_at) <= new Date() ? { t: '已到期', c: 'err' } : { t: '使用中', c: 'ok' };

/** 管理員後台: every account with its plan and expiry; add accounts, extend, disable. */
export function AdminPage({ selfId, onBack }: { selfId: string; onBack: () => void }) {
  const [list, setList] = useState<Profile[] | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ email: '', password: '', plan: 'monthly', expires: day(extend(null, 1)), ref: '', mail: true, request: 0, line: '' });
  // null: the trial-request migration (0007) has not been run
  const [requests, setRequests] = useState<TrialRequest[] | null>(null);
  // null: the problem-report migration (0016) has not been run
  const [reports, setReports] = useState<ProblemReport[] | null>(null);
  const [openRep, setOpenRep] = useState<string | null>(null);
  // null: the usage migration (0005) has not been run
  const [usage, setUsage] = useState<{ usage: UsageDay[]; logins: Login[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Profile | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // null: the reminder migration (0004) has not been run, so mail is only simulated
  const [settings, setSettings] = useState<Record<string, string> | null>(null);

  const refresh = () => listProfiles().then(setList).catch(e => setErr(String(e.message || e)));
  useEffect(() => { refresh(); loadSettings().then(setSettings); listUsage().then(setUsage); listTrialRequests().then(setRequests); listReports().then(setReports); }, []);

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
      // the referrer, by share code or e-mail
      const key = form.ref.trim().toLowerCase();
      const referrer = key ? (list || []).find(p => p.ref_code === key || (p.email || '').toLowerCase() === key) : null;
      if (key && !referrer) throw new Error(`找不到推薦碼或帳號「${form.ref.trim()}」`);
      // one trial per LINE account: the LINE name the application came from must not have been used before
      const line = form.line.trim();
      if (form.request && !line) throw new Error('請填對方的 LINE 名稱（同一個 LINE 帳號只能開通一次）');
      if (line) { const used = await lineUsed(line, form.email.trim()); if (used) throw new Error(`這個 LINE 帳號「${line}」已經申請過（${used}），不能重複開通`); }
      const r = await createAccount(form.email.trim(), form.password, form.plan, form.plan === 'unlimited' || !form.expires ? null : new Date(`${form.expires}T23:59:59`).toISOString(), referrer?.id ?? null, line || null);
      let mailed = '';
      if (form.mail && requests !== null) {
        try { await sendWelcome(form.email.trim(), form.password); mailed = '，帳號密碼已寄到對方信箱'; } catch (x) { mailed = `，但開通信沒寄出（${(x as Error).message}）`; }
      }
      if (form.request) { await handleTrialRequest(form.request, line).catch(() => {}); listTrialRequests().then(setRequests); }
      setMsg(`已建立 ${form.email}${referrer ? `（推薦人 ${referrer.email}）` : ''}${mailed}${r.confirm ? '；對方需先到信箱點啟用連結才能登入' : ''}`);
      setForm({ ...form, email: '', password: '', ref: '', request: 0, line: '' });
      refresh();
    } catch (x) { setErr(String((x as Error).message || x)); }
    setBusy(false);
  };

  const shown = (list || []).filter(p => !q || (p.email || '').includes(q) || (p.note || '').includes(q) || (p.line_name || '').includes(q));
  const active = (list || []).filter(p => status(p).c === 'ok').length;
  const due = dueForReminder(list || []);
  const mail = preview && reminderEmail(preview, settings?.site_url || location.origin, new Date(), settings?.renew_how || RENEW_HOW);

  const byId = new Map((list || []).map(p => [p.id, p]));
  /** who referred this account and whether the reward has been given; the referrer can be set or changed here */
  const referral = (p: Profile) => {
    if (!usage && !p.ref_code) return null;
    const ok = usage ? usage.usage.filter(u => u.user_id === p.id && u.minutes >= REFERRAL.minutes && u.day >= taipeiDay(new Date(p.created_at)) && u.day < taipeiDay(new Date(new Date(p.created_at).getTime() + REFERRAL.within * 864e5))).length : 0;
    const shares = (list || []).filter(x => x.referred_by === p.id && x.referral_rewarded_at).length;
    return (
      <div className="kv note">
        <label>推薦人 <select id={`ref-${p.id}`} value={p.referred_by || ''} onChange={e => patch(p, { referred_by: e.target.value || null }, e.target.value ? `推薦人改為 ${byId.get(e.target.value)?.email}` : '已移除推薦人')}>
          <option value="">（無）</option>
          {(list || []).filter(x => x.id !== p.id).map(x => <option key={x.id} value={x.id}>{x.email}</option>)}
        </select></label>
        {p.referred_by && <span>{p.referral_rewarded_at ? `已達成（${day(p.referral_rewarded_at)}）` : `進度 ${Math.min(ok, REFERRAL.days)}/${REFERRAL.days} 天`}</span>}
        {shares > 0 && <span>成功分享 {shares} 次</span>}
      </div>
    );
  };
  /** sign-ins and minutes online per day */
  const online = (p: Profile) => {
    const days = usage!.usage.filter(u => u.user_id === p.id), logins = usage!.logins.filter(l => l.user_id === p.id);
    const today = days.find(u => u.day === taipeiDay())?.minutes ?? 0;
    const week = days.filter(u => u.day > taipeiDay(new Date(Date.now() - 7 * 864e5))).reduce((s, u) => s + u.minutes, 0);
    return (
      <details className="usage">
        <summary>今天上線 {hm(today)}・近 7 天 {hm(week)}{logins[0] ? `・最近登入 ${when(logins[0].at)}` : days[0] ? `・最近上線 ${when(days[0].last_seen)}` : '・30 天內沒有上線'}</summary>
        {days.length > 0 && <table><thead><tr><th>日期</th><th>上線時段</th><th>累計</th></tr></thead><tbody>
          {days.map(u => <tr key={u.day}><td>{u.day.slice(5).replace('-', '/')}</td><td>{time(u.first_seen)}–{time(u.last_seen)}</td><td>{hm(u.minutes)}</td></tr>)}
        </tbody></table>}
        {logins.length > 0 && <p className="note">登入時間：{logins.slice(0, 20).map(l => when(l.at)).join('、')}{logins.length > 20 ? ' …' : ''}</p>}
      </details>
    );
  };

  return (
    <div className="page">
      <div className="wrap">
        <div className="head">
          <h1>管理員後台</h1>
          <button className="chip ghost" onClick={onBack}>← 我的專案</button>
        </div>
        <p className="note">共 {list?.length ?? '…'} 個帳號，使用中 {active} 個。到期或停用的帳號登入後只會看到續約提示，打不開專案（資料仍保留，延長後就恢復）。新開通的帳號自動有 {TRIAL_DAYS} 天試用。</p>

        <div className="card">
          <h3>即將到期（續訂提醒信）</h3>
          {settings ? <>
            <p className="note">每天早上 9 點，系統自動寄續訂提醒信給 {REMIND_DAYS} 天內到期的帳號（試用帳號為到期前 {TRIAL_REMIND_DAYS} 天）（同一個到期日只寄一次；延長後下次到期前會再寄）。對方付款後在這裡延長即可。</p>
            <div className="kv">
              <label className="note">寄件人 <input id="mail-from" type="text" defaultValue={settings.mail_from || ''} onBlur={e => setting('mail_from', e.target.value.trim())} /></label>
              <label className="note">回覆信箱 <input id="reply-to" type="email" placeholder="客戶回信寄到這裡" defaultValue={settings.reply_to || ''} onBlur={e => setting('reply_to', e.target.value.trim())} /></label>
            </div>
            <label className="note">續訂方式（信中顯示，可寫匯款帳號、電話、LINE）<textarea id="renew-how" rows={3} style={{ width: '100%' }} defaultValue={settings.renew_how || RENEW_HOW} onBlur={e => setting('renew_how', e.target.value.trim())} /></label>
            <div className="acts"><button className="chip" disabled={busy} onClick={() => act(async () => `已寄出 ${await runReminders()} 封提醒信`)}>立即執行提醒</button></div>
          </> : <p className="note">到期前 {REMIND_DAYS} 天，系統會寄續訂提醒信到該帳號的電子郵件。目前為模擬：按「預覽通知信」看信件內容，還不會真的寄出（在 Supabase 執行 0004_renewal_reminders.sql 後就會自動寄）。對方付款後在這裡延長即可。</p>}
          {due.length === 0 ? <p className="note">目前沒有即將到期的帳號。{list?.some(p => p.expires_at) ? '' : '（可先到下方任一帳號按「預覽通知信」看看信件）'}</p> : due.map(p => (
            <div className="kv" key={p.id}>
              <span><b>{p.email}</b>・剩 {daysLeft(p)} 天（{p.expires_at!.slice(0, 10)}）{settings && (p.reminded_at ? `・已寄提醒 ${day(p.reminded_at)}` : '・尚未寄提醒')}</span>
              <button className="chip" onClick={() => setPreview(p)}>預覽通知信</button>
              <button className="chip" onClick={() => patch(p, { expires_at: extend(p.expires_at, 1), disabled: false }, '延長 1 個月')}>+1 個月</button>
              <button className="chip" onClick={() => patch(p, { expires_at: extend(p.expires_at, 12), disabled: false }, '延長 1 年')}>+1 年</button>
            </div>
          ))}
        </div>

        {requests && requests.length > 0 && <div className="card">
          <h3>試用申請（{requests.length}）</h3>
          <p className="note">從登入頁送出的申請（同時會從對方手機傳 LINE 到官方帳號）。按「開通」會把資料填到下方的新增帳號（試用 {TRIAL_DAYS} 天、自動產生密碼），填上對方在 LINE 的名稱後按「建立帳號」，帳號密碼會寄到對方信箱。同一個 email、同一個 LINE 帳號只能開通一次。</p>
          {requests.map(q => (
            <div className="kv" key={q.id}>
              <span><b>{q.email}</b>{q.ref_code && `・推薦碼 ${q.ref_code}`}・{new Date(q.created_at).toLocaleString('zh-TW')}{list?.some(p => (p.email || '').toLowerCase() === q.email) && '・已有帳號'}</span>
              <button className="chip on" onClick={() => { setForm({ ...form, email: q.email, password: newPassword(), plan: 'trial', expires: day(new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString()), ref: q.ref_code || '', request: q.id, line: '' }); setTimeout(() => document.getElementById('new-line')?.focus(), 400); document.getElementById('new-email')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>開通</button>
              <button className="chip ghost" onClick={() => handleTrialRequest(q.id).then(() => listTrialRequests().then(setRequests)).catch(e => setErr(String(e.message || e)))}>略過</button>
            </div>
          ))}
        </div>}

        {reports && reports.length > 0 && <div className="card">
          <h3>問題回報（{reports.length}）</h3>
          <p className="note">使用者在 3D 模型頁按「回報問題」送來的：當時存在雲端的模型、自檢清單、原始圖面和說明。「開啟模型」會複製一份成你自己的專案（不動對方的）；圖面檔可直接下載。</p>
          {reports.map(r => {
            const warn = (r.issues || []).filter(i => i.sev === 'warn');
            const fixed = (r.issues || []).filter(i => i.sev === 'fixed').length;
            return <div className="kv" key={r.id} style={{ flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 100%' }}><b>{r.email}</b>・{r.project_name}・{new Date(r.created_at).toLocaleString('zh-TW')}・v{r.version}{r.status === 'opened' && '・已開啟'}</span>
              <span style={{ flex: '1 1 100%', whiteSpace: 'pre-wrap' }}>{r.text}</span>
              <span style={{ flex: '1 1 100%' }} className="note">自檢 {warn.length} 項要看、{fixed} 項自動補・圖面 {(r.sources || []).length} 個檔
                {warn.length > 0 && <> <button className="chip sm ghost" onClick={() => setOpenRep(openRep === r.id ? null : r.id)}>{openRep === r.id ? '收起' : '看清單'}</button></>}</span>
              {openRep === r.id && <ul style={{ flex: '1 1 100%', margin: 0, paddingLeft: 18 }}>{warn.map((i, k) => <li key={k}>{i.floor && <b>{i.floor} </b>}{i.text}</li>)}</ul>}
              <button className="chip on" disabled={busy} onClick={() => act(async () => { const id = await adoptReport(r.id); location.hash = `#/p/${id}`; return '已複製成你的專案'; })}>開啟模型</button>
              {(r.sources || []).map(f => <button className="chip" key={f.path} onClick={() => store.sourceUrl(f.path).then(u => { location.href = u; }).catch(e => setErr(String(e.message || e)))}>⬇ {f.name}</button>)}
              <button className="chip ghost" onClick={() => setReportStatus(r.id, 'done').then(() => listReports().then(setReports)).catch(e => setErr(String(e.message || e)))}>已處理</button>
            </div>;
          })}
        </div>}

        <form className="card" onSubmit={add}>
          <h3>新增帳號</h3>
          <div className="kv">
            <input id="new-email" type="email" placeholder="電子郵件" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
            <input id="new-password" type="text" placeholder="初始密碼（至少 6 碼）" minLength={6} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
            <select id="new-plan" value={form.plan} onChange={e => { const plan = e.target.value; setForm({ ...form, plan, expires: plan === 'yearly' ? day(extend(null, 12)) : plan === 'monthly' ? day(extend(null, 1)) : plan === 'trial' ? day(new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString()) : '' }); }}>
              {Object.entries(PLANS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input id="new-ref" type="text" placeholder="推薦碼或推薦人 email（選填）" value={form.ref} onChange={e => setForm({ ...form, ref: e.target.value })} />
            <input id="new-line" type="text" placeholder={form.request ? '對方的 LINE 名稱（必填）' : '對方的 LINE 名稱（選填）'} value={form.line} required={!!form.request} onChange={e => setForm({ ...form, line: e.target.value })} />
            {form.plan !== 'unlimited' && <label className="note">到期日 <input id="new-expires" type="date" value={form.expires} onChange={e => setForm({ ...form, expires: e.target.value })} required /></label>}
            {requests !== null && <label className="note"><input id="new-mail" type="checkbox" checked={form.mail} onChange={e => setForm({ ...form, mail: e.target.checked })} /> 寄帳號密碼到對方信箱</label>}
            <button className="chip on" disabled={busy}>{busy ? '建立中…' : '建立帳號'}</button>
          </div>
        </form>

        {err && <p className="err">{err}</p>}
        {msg && <p className="note">{msg}</p>}
        <input id="admin-search" type="search" placeholder="搜尋電子郵件、LINE 名稱或備註" value={q} onChange={e => setQ(e.target.value)} />

        {list === null ? <p className="note">載入中…</p> : (
          <div className="grid">
            {shown.map(p => {
              const s = status(p), self = p.id === selfId;
              return (
                <div className="card" key={p.id}>
                  <h3 title={p.email || ''}>{p.email}{self && '（你）'}</h3>
                  {p.line_name && <span className="meta">LINE：{p.line_name}</span>}
                  <span className={s.c === 'err' ? 'err' : 'meta'}>{s.t}・{PLANS[p.plan] || p.plan}・{p.expires_at ? `到期 ${day(p.expires_at)}` : '不限期'}</span>
                  <span className="meta">建立於 {day(p.created_at)}{p.ref_code && `・推薦碼 ${p.ref_code}`}</span>
                  {referral(p)}
                  {usage && online(p)}
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
                    {!self && p.plan === 'trial' && (confirmDel === p.id
                      ? <><button className="chip danger" disabled={busy} onClick={() => { setConfirmDel(null); act(async () => `已刪除試用帳號 ${await deleteTrialAccount(p.id)}（含專案與上線紀錄）`); }}>確定刪除帳號</button><button className="chip ghost" onClick={() => setConfirmDel(null)}>取消</button></>
                      : <button className="chip ghost danger" onClick={() => setConfirmDel(p.id)}>刪除帳號</button>)}
                  </div>
                  {confirmDel === p.id && <span className="err">刪除後帳號、專案、上線紀錄都會永久移除，無法復原；對方之後可以用同一個電子郵件重新申請試用。</span>}
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
