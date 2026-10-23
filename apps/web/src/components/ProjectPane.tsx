import { diffVersion, PROJECT_STATUS, snapshotVersion, type CalcVersion, type PricedBudget, type ProjectInfo } from '@cloud-modeler/core';
import { useEffect, useState } from 'react';
import { money } from '../lib/report';
import { store, type Member, type Role, type SourceFile } from '../lib/store';

export const CATEGORIES = ['住宅', '透天', '集合住宅', '辦公', '商業空間', '廠房', '公共工程', '室內裝修', '其他'];
const ROLE: Record<Role, string> = { owner: '擁有者', editor: '可編輯', viewer: '只能檢視' };
const size = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

export function ProjectPane({ projectId, owner, name, role, info, versions, pb, floorArea, learning, onName, onInfo, onVersions, toast }: {
  projectId: string; owner?: string; name: string; role: Role; info: ProjectInfo; versions: CalcVersion[]; pb: PricedBudget; floorArea: number;
  /** hand corrections of this project and what the drawing style learnt from them */
  learning?: { fixes: { del: number; type: number; add: number }; style?: string; rules: string[] };
  onName: (n: string) => void; onInfo: (i: ProjectInfo) => void; onVersions: (v: CalcVersion[]) => void; toast: (s: string) => void;
}) {
  const ro = role === 'viewer';
  const [files, setFiles] = useState<SourceFile[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [memberErr, setMemberErr] = useState('');
  const [email, setEmail] = useState(''), [newRole, setNewRole] = useState<'viewer' | 'editor'>('viewer');
  const [label, setLabel] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    store.sources(projectId, owner).then(setFiles).catch(() => setFiles([]));
    if (store.cloud) store.members(projectId).then(setMembers).catch(e => { setMembers([]); setMemberErr((e as Error).message); });
  }, [projectId, owner]);
  const set = (k: keyof ProjectInfo, v: string) => onInfo({ ...info, [k]: v });
  const share = async () => {
    try { await store.share(projectId, email, newRole); setEmail(''); setMembers(await store.members(projectId)); toast('已加入成員，對方會收到通知信'); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="pane">
      <div className="paneHead"><div><h2>專案管理</h2><p className="note">專案資料、計算版本、原始圖檔與團隊成員。所有資料存在雲端，換電腦、手機登入都看得到。</p></div>
        <span className="badge">{ROLE[role]}</span></div>

      <div className="cols">
        <section className="card">
          <h3>專案資料</h3>
          <div className="formGrid">
            <label>專案名稱<input id="pj-name" type="text" value={name} disabled={ro} onChange={e => onName(e.target.value)} /></label>
            <label>分類<select id="pj-cat" value={info.category || ''} disabled={ro} onChange={e => set('category', e.target.value)}>
              <option value="">未分類</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
            <label>狀態<select id="pj-status" value={info.status || PROJECT_STATUS[0]} disabled={ro} onChange={e => set('status', e.target.value)}>
              {PROJECT_STATUS.map(c => <option key={c}>{c}</option>)}</select></label>
            <label>業主<input id="pj-client" type="text" value={info.client || ''} disabled={ro} onChange={e => set('client', e.target.value)} /></label>
            <label className="wide">工程地點<input id="pj-site" type="text" value={info.site || ''} disabled={ro} onChange={e => set('site', e.target.value)} /></label>
            <label className="wide">備註<textarea id="pj-note" rows={2} value={info.note || ''} disabled={ro} onChange={e => set('note', e.target.value)} /></label>
          </div>
        </section>

        {learning && <section className="card">
          <h3>修正紀錄與自動學習</h3>
          <p className="note">你在 3D 裡的修正會被記住：刪除 {learning.fixes.del} 個、改類別 {learning.fixes.type} 個、手動補牆 {learning.fixes.add} 道。{learning.style ? `同一圖層被修正多次時，規則存進「${learning.style}」的圖面樣式，下次匯入這家事務所的圖自動套用。` : '這個專案不是用整棟建模匯入的，修正不會學成規則。'}</p>
          {learning.rules.length > 0 ? <ul className="note" style={{ margin: '4px 0 0 18px' }}>{learning.rules.map(r => <li key={r}>{r}</li>)}</ul> : learning.style && <p className="note">目前還沒有學到規則（同一圖層要有 2 次以上相同修正，刪除要 3 個以上）。</p>}
        </section>}

        <section className="card">
          <h3>團隊成員與權限</h3>
          {!store.cloud ? <p className="note">本機模式不能共用。登入雲端帳號後，可以把專案共用給公司同事。</p> : <>
            <ul className="files">
              <li><span>擁有者{role === 'owner' ? '（你）' : ''}</span><small>{ROLE.owner}</small></li>
              {(members || []).map(m => <li key={m.user_id}><span>{m.email}</span><small>{ROLE[m.role]}</small>
                {role === 'owner' && <button className="chip ghost danger sm" onClick={async () => { await store.unshare(projectId, m.user_id); setMembers(await store.members(projectId)); }}>移除</button>}</li>)}
            </ul>
            {memberErr && <p className="warn">{memberErr}</p>}
            {role === 'owner' && !memberErr && <form className="kv" onSubmit={e => { e.preventDefault(); if (email) share(); }}>
              <input id="share-email" type="email" placeholder="同事的電子郵件（需有築本3D工程估算帳號）" value={email} onChange={e => setEmail(e.target.value)} style={{ flex: '1 1 200px' }} />
              <select id="share-role" value={newRole} onChange={e => setNewRole(e.target.value as 'viewer' | 'editor')}><option value="viewer">只能檢視</option><option value="editor">可編輯</option></select>
              <button className="chip on" disabled={!email}>加入</button>
            </form>}
            <p className="note">可編輯：能改模型、數量設定與單價；只能檢視：看模型、數量、報價與下載報表，不能存檔。只有擁有者能加入或移除成員、刪除專案。</p>
          </>}
        </section>
      </div>

      <section className="card">
        <h3>計算版本</h3>
        <p className="note">把目前的工程數量與報價存成一個版本（例如「初估」「第一次報價」「變更設計後」），之後可以比較數量與金額差多少。</p>
        {!ro && <form className="kv" onSubmit={e => { e.preventDefault(); onVersions([snapshotVersion(label || `版本 ${versions.length + 1}`, floorArea, pb), ...versions]); setLabel(''); toast('已存成計算版本'); }}>
          <input id="ver-label" type="text" placeholder={`版本名稱（例如：版本 ${versions.length + 1}）`} value={label} onChange={e => setLabel(e.target.value)} style={{ flex: '1 1 200px' }} />
          <button className="chip on">存成新版本</button>
        </form>}
        <div className="tbl"><table>
          <thead><tr><th>版本</th><th>時間</th><th className="num">樓地板面積 ㎡</th><th className="num">直接工程費</th><th className="num">總計</th><th className="num">與目前差異</th><th></th></tr></thead>
          <tbody>
            <tr className="total"><td>目前</td><td>—</td><td className="num">{floorArea.toFixed(2)}</td><td className="num">{money(pb.direct)}</td><td className="num">{money(pb.grand)}</td><td /><td /></tr>
            {versions.map(v => {
              const d = pb.grand - v.grand;
              return [
                <tr key={v.id}><td>{v.label}</td><td>{new Date(v.at).toLocaleString('zh-TW')}</td><td className="num">{v.floorArea.toFixed(2)}</td><td className="num">{money(v.direct)}</td><td className="num">{money(v.grand)}</td>
                  <td className={`num ${d > 0 ? 'warn' : ''}`}>{d === 0 ? '相同' : `${d > 0 ? '+' : '−'}${money(Math.abs(d)).replace('NT$ ', '')}`}</td>
                  <td><button className="chip ghost sm" onClick={() => setOpen(open === v.id ? null : v.id)}>{open === v.id ? '收起' : '比較'}</button>
                    {!ro && <button className="chip ghost danger sm" onClick={() => onVersions(versions.filter(x => x.id !== v.id))}>刪除</button>}</td></tr>,
                open === v.id && <tr key={v.id + 'd'}><td colSpan={7}>{(() => {
                  const diff = diffVersion(v, pb);
                  return diff.length ? <table><thead><tr><th>工項</th><th className="num">當時數量</th><th className="num">目前數量</th><th>單位</th><th className="num">當時複價</th><th className="num">目前複價</th></tr></thead>
                    <tbody>{diff.map((x, i) => <tr key={i}><td>{x.name}</td><td className="num">{x.was}</td><td className="num">{x.now}</td><td>{x.unit}</td><td className="num">{x.wasT.toLocaleString()}</td><td className="num">{x.nowT.toLocaleString()}</td></tr>)}</tbody></table>
                    : <span className="note">數量與金額都和目前相同。</span>;
                })()}</td></tr>,
              ];
            })}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h3>原始圖檔</h3>
        {files === null ? <p className="note">載入中…</p> : !files.length ? <p className="note">{store.cloud ? '還沒有上傳的圖檔。在「圖面匯入」匯入的 DWG、DXF、SketchUp 檔會自動備份在這裡。' : '本機模式不保存原始圖檔。'}</p> :
          <ul className="files">{files.map(f => <li key={f.path}><span title={f.name}>{f.name}</span><small>{size(f.size)}・{f.at ? new Date(f.at).toLocaleDateString('zh-TW') : ''}</small>
            <button className="chip ghost sm" onClick={async () => { try { const a = document.createElement('a'); a.href = await store.sourceUrl(f.path); a.rel = 'noopener'; a.click(); } catch (e) { toast((e as Error).message); } }}>下載</button></li>)}</ul>}
      </section>
    </div>
  );
}
