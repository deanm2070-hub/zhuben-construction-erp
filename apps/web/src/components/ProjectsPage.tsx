import { Modal } from './Modal';
import { InstallButton } from './InstallButton';
import { PROJECT_STATUS, sampleObjects } from '@cloud-modeler/core';
import { useEffect, useState } from 'react';
import { emptyModel, store, type ProjectMeta } from '../lib/store';
import { signOutHere, supabase } from '../lib/supabase';
import { readProjectFile } from '../lib/files';
import { VERSION } from '../lib/version';
import { claimAdmin, isTrial, PLANS, TRIAL_LOCK, type Account } from '../lib/account';
import { TrialLock } from './TrialLock';
import { ProfileInfo } from './ProfileInfo';
import { CATEGORIES } from './ProjectPane';

type View = 'home' | 'mine' | 'shared';
const FEATURES: [string, string][] = [
  ['建築圖與結構圖匯入', 'DWG、DXF、SketchUp；自動辨識圖層、尺寸、軸線、樓層與構件，可人工校正'],
  ['2D 平面圖轉 3D 模型', '柱、梁、板、牆、門窗、樓梯依樓層建模，旋轉、縮放、分層與分構件顯示'],
  ['AI 工程數量計算', '混凝土、模板、牆面、樓地板面積、鋼筋（依配筋圖）等，每筆附計算式'],
  ['工程預算與報價', '材料、工資、機具單價與複價、損耗、管理費、利潤、稅金，產生預算報價單'],
  ['雲端專案管理', '分類與狀態、計算版本比較、原始圖檔備份、團隊成員與權限'],
  ['數量明細與報表匯出', '依工項、樓層、構件、施工區域整理，匯出 Excel 與 PDF'],
];

export function ProjectsPage({ email, account, onAccount, onOpen }: { email: string | null; account: Account; onAccount: () => void; onOpen: (id: string, importNow?: boolean) => void }) {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [info, setInfo] = useState(false);
  const [naming, setNaming] = useState<{ kind: 'blank' | 'cad'; name: string } | null>(null);
  const [view, setView] = useState<View>('home');
  const trial = isTrial(account);
  const [lock, setLock] = useState(false);
  const [q, setQ] = useState(''), [cat, setCat] = useState(''), [status, setStatus] = useState('');

  // project lock: kept in the project's meta and, in case the meta column is missing, on this device too
  const [locks, setLocks] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('zb-locks') || '{}'); } catch { return {}; } });
  const locked = (p: ProjectMeta) => locks[p.id] ?? !!p.meta?.locked;
  const toggleLock = async (p: ProjectMeta) => {
    const on = !locked(p), next = { ...locks, [p.id]: on };
    setLocks(next); setConfirmId(null);
    try { localStorage.setItem('zb-locks', JSON.stringify(next)); } catch { /* private window */ }
    await store.save(p.id, { meta: { ...(p.meta || {}), locked: on } }).catch(() => {});
    refresh();
  };
  const refresh = () => store.list().then(setList).catch(e => setErr(String(e.message || e)));
  useEffect(() => { refresh(); store.me().then(setMe); }, []);

  const create = async (kind: 'sample' | 'blank' | 'cad', typed?: string) => {
    if (trial && kind !== 'sample') { setLock(true); return; }
    if (kind !== 'sample' && typed === undefined) { setNaming({ kind, name: '' }); return; }
    try {
      const model = emptyModel();
      if (kind === 'sample') model.objects = sampleObjects();
      else model.cad = { name: '空白平面', W: 1000, D: 800, segs: [], texts: [], doors: [] };
      const name = kind === 'sample' ? '範例平面' : typed?.trim() || (kind === 'cad' ? '匯入圖面' : '未命名專案');
      const id = await store.create(name, model);
      onOpen(id, kind === 'cad');
    } catch (e) { setErr(String((e as Error).message || e)); }
  };

  const mine = (list || []).filter(p => !p.owner || !me || p.owner === me), shared = (list || []).filter(p => me && p.owner && p.owner !== me);
  const shown = (view === 'shared' ? shared : view === 'mine' ? mine : list || []).filter(p =>
    (!q || `${p.name} ${p.meta?.client || ''} ${p.meta?.site || ''}`.toLowerCase().includes(q.toLowerCase()))
    && (!cat || (p.meta?.category || '') === cat) && (!status || (p.meta?.status || PROJECT_STATUS[0]) === status));
  const month = new Date().toISOString().slice(0, 7);
  const byStatus = (s: string) => (list || []).filter(p => (p.meta?.status || PROJECT_STATUS[0]) === s).length;

  const card = (p: ProjectMeta) => (
    <div className="card" key={p.id}>
      {p.thumbnail && <img src={p.thumbnail} alt="" style={{ borderRadius: 8, aspectRatio: '16/10', objectFit: 'cover', cursor: 'pointer' }} onClick={() => onOpen(p.id)} />}
      {renaming?.id === p.id ? (
        <form className="kv" onSubmit={async e => { e.preventDefault(); await store.save(p.id, { name: renaming.name || p.name }); setRenaming(null); refresh(); }}>
          <input id={`name-${p.id}`} type="text" value={renaming.name} onChange={e => setRenaming({ id: p.id, name: e.target.value })} autoFocus />
          <button className="chip on">儲存</button>
        </form>
      ) : <h3 title={p.name}>{p.name}</h3>}
      <div className="kv tight">
        <span className={`badge st-${PROJECT_STATUS.indexOf((p.meta?.status || PROJECT_STATUS[0]) as typeof PROJECT_STATUS[number])}`}>{p.meta?.status || PROJECT_STATUS[0]}</span>
        {p.meta?.category && <span className="badge">{p.meta.category}</span>}
        {me && p.owner && p.owner !== me && <span className="badge">共用給我</span>}
      </div>
      {(p.meta?.client || p.meta?.site) && <span className="meta">{[p.meta?.client, p.meta?.site].filter(Boolean).join('・')}</span>}
      <span className="meta">更新於 {new Date(p.updated_at).toLocaleString()}</span>
      <div className="acts">
        <button className="chip on" onClick={() => onOpen(p.id)}>開啟</button>
        {(!me || !p.owner || p.owner === me) && <>
          <button className="chip" onClick={() => setRenaming({ id: p.id, name: p.name })}>改名</button>
          <button className={`chip${locked(p) ? ' on' : ''}`} title={locked(p) ? '已鎖定：不能刪除，按一下解除鎖定' : '鎖定後不能刪除，避免誤按'} onClick={() => toggleLock(p)}>{locked(p) ? '🔒 已鎖定' : '🔓 鎖定'}</button>
          {locked(p) ? null : confirmId === p.id
            ? <><button className="chip danger" onClick={async () => { await store.remove(p.id); setConfirmId(null); refresh(); }}>確定刪除</button><button className="chip ghost" onClick={() => setConfirmId(null)}>取消</button></>
            : <button className="chip ghost danger" onClick={() => setConfirmId(p.id)}>刪除</button>}
        </>}
      </div>
    </div>
  );

  return (
    <div className="shell">
      {naming && <Modal title="專案名稱" onClose={() => setNaming(null)}
        desc="報表（PDF／Excel）的檔名也會用這個名稱。可以留空，之後在專案頁改名。"
        actions={<><button type="button" className="chip" onClick={() => setNaming(null)}>取消</button><button type="submit" form="naming-form" className="chip key">{naming.kind === 'cad' ? '建立並匯入圖面' : '建立'}</button></>}>
        <form id="naming-form" onSubmit={e => { e.preventDefault(); const n = naming; setNaming(null); create(n.kind, n.name.trim() || ''); }}>
          <input type="text" style={{ width: '100%', boxSizing: 'border-box' }} value={naming.name} placeholder="例如：五股芳洲段" maxLength={40} autoFocus onChange={e => setNaming({ ...naming, name: e.target.value })} />
        </form>
      </Modal>}
      <aside className="side">
        <div className="logo"><img src="/logo.png" alt="" width={30} height={30} /><b>築本3D工程估算</b><small className="ver">{VERSION}</small></div>
        <nav>
          <button className={view === 'home' ? 'on' : ''} onClick={() => setView('home')}>總覽</button>
          <button className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>我的專案 <small>{mine.length}</small></button>
          {store.cloud && <button className={view === 'shared' ? 'on' : ''} onClick={() => setView('shared')}>共用給我的 <small>{shared.length}</small></button>}
          {account.admin && <button onClick={() => { location.hash = '#/admin'; }}>管理員後台</button>}
        </nav>
        <div className="sideActs">
          <span className="lbl">新增專案</span>
          {trial ? <>
            <button className="chip key" onClick={() => create('sample')}>＋ 範例平面（試用）</button>
            <button className="chip off" onClick={() => setLock(true)}>🔒 匯入圖面開始</button>
            <button className="chip off" onClick={() => setLock(true)}>🔒 空白專案</button>
            <button className="chip off" onClick={() => setLock(true)}>🔒 開啟專案檔</button>
            <span className="note">{TRIAL_LOCK}</span>
          </> : <>
          <button className="chip key" onClick={() => create('cad')}>＋ 匯入圖面開始</button>
          <button className="chip" onClick={() => create('blank')}>空白專案</button>
          <button className="chip" onClick={() => create('sample')}>範例平面</button>
          <label className="chip tap">開啟專案檔<input id="project-file" className="tap-input" type="file" accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const { name, model } = await readProjectFile(f); onOpen(await store.create(name, model)); } catch (x) { setErr(String((x as Error).message || x)); } }} /></label>
          </>}
        </div>
        <div className="sideFoot">
          {email && <span className="note">{email}{account.ready && !account.admin && account.profile && `・${PLANS[account.profile.plan] || account.profile.plan}${account.profile.expires_at ? ` 到期 ${account.profile.expires_at.slice(0, 10)}` : ''}`}</span>}
          <div className="kv tight">
            {email && account.ready && <button className="chip" onClick={() => setInfo(true)}>個人資訊</button>}
            <InstallButton />
            {supabase && <button className="chip ghost" onClick={signOutHere}>登出</button>}
          </div>
        </div>
      </aside>

      <main className="main">
        {account.ready && !account.adminExists && <div className="banner">還沒有管理員。<button className="chip on" onClick={async () => { try { if (await claimAdmin()) onAccount(); } catch (e) { setErr(String((e as Error).message || e)); } }}>把這個帳號設為管理員</button>（只有第一個按的帳號會成為管理員）</div>}
        {!store.cloud && <div className="banner">目前是本機模式：專案存在這個瀏覽器裡。設定 Supabase 後即可登入並存到雲端（見 README）。</div>}
        {err && <p className="err">{err}</p>}

        {trial && <div className="banner">試用帳號可以用「範例平面」體驗 3D、算量、報價與報表；匯入自己的圖檔：<b>{TRIAL_LOCK}</b>。<button className="chip key sm" onClick={() => setLock(true)}>如何開通</button></div>}
        {view === 'home' && <>
          <h1>總覽</h1>
          <div className="stats big">
            <div><span>專案總數</span><b>{list?.length ?? '–'}</b></div>
            <div><span>本月更新</span><b>{(list || []).filter(p => p.updated_at.startsWith(month)).length}</b></div>
            {PROJECT_STATUS.slice(0, 4).map(s => <div key={s}><span>{s}</span><b>{byStatus(s)}</b></div>)}
            {store.cloud && <div><span>共用給我的</span><b>{shared.length}</b></div>}
          </div>
          <div className="headRow"><h2>最近的專案</h2><button className="chip ghost" onClick={() => setView('mine')}>全部專案 →</button></div>
          {list === null ? <p className="note">載入中…</p> : list.length === 0
            ? <p className="note">{trial ? '還沒有專案。按左邊「＋ 範例平面（試用）」開始體驗。' : '還沒有專案。按左邊「＋ 匯入圖面開始」，選 DWG／DXF／SketchUp 檔，或先開「範例平面」看看。'}</p>
            : <div className="grid">{list.slice(0, 6).map(card)}</div>}
          <h2>工作流程</h2>
          <div className="flow">{FEATURES.map(([t, d], i) => <div key={t}><i>{i + 1}</i><b>{t}</b><span>{d}</span></div>)}</div>
        </>}

        {view !== 'home' && <>
          <h1>{view === 'shared' ? '共用給我的專案' : '我的專案'}</h1>
          <div className="kv">
            <input id="project-search" type="text" placeholder="搜尋專案名稱、業主、地點" value={q} onChange={e => setQ(e.target.value)} style={{ flex: '1 1 220px' }} />
            <select id="project-cat" value={cat} onChange={e => setCat(e.target.value)}><option value="">全部分類</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
            <select id="project-status" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部狀態</option>{PROJECT_STATUS.map(c => <option key={c}>{c}</option>)}</select>
          </div>
          {list === null ? <p className="note">載入中…</p> : shown.length === 0
            ? <p className="note">{view === 'shared' ? '目前沒有別人共用給你的專案。專案擁有者可在專案的「專案管理」加入你的電子郵件。' : (list.length ? '沒有符合條件的專案。' : '還沒有專案。')}</p>
            : <div className="grid">{shown.map(card)}</div>}
        </>}
      </main>
      {lock && <TrialLock onClose={() => setLock(false)} />}
      {info && email && <ProfileInfo email={email} account={account} onClose={() => setInfo(false)} />}
    </div>
  );
}
