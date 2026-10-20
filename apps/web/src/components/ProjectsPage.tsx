import { InstallButton } from './InstallButton';
import { sampleObjects } from '@cloud-modeler/core';
import { useEffect, useState } from 'react';
import { emptyModel, store, type ProjectMeta } from '../lib/store';
import { supabase } from '../lib/supabase';
import { readProjectFile } from '../lib/files';
import { VERSION } from '../lib/version';

export function ProjectsPage({ email, onOpen }: { email: string | null; onOpen: (id: string, importNow?: boolean) => void }) {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [err, setErr] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const refresh = () => store.list().then(setList).catch(e => setErr(String(e.message || e)));
  useEffect(() => { refresh(); }, []);

  const create = async (kind: 'sample' | 'blank' | 'cad') => {
    try {
      const model = emptyModel();
      if (kind === 'sample') model.objects = sampleObjects();
      else model.cad = { name: '空白平面', W: 1000, D: 800, segs: [], texts: [], doors: [] };
      const name = kind === 'sample' ? '範例平面' : kind === 'cad' ? '匯入圖面' : '未命名專案';
      const id = await store.create(name, model);
      onOpen(id, kind === 'cad');
    } catch (e) { setErr(String((e as Error).message || e)); }
  };

  return (
    <div className="page">
      <div className="wrap">
        <div className="head">
          <h1><img src="/logo.png" alt="" width={32} height={32} style={{ verticalAlign: 'middle', marginRight: 8 }} />我的專案 <small className="ver">{VERSION}</small></h1>
          <div className="kv">
            <InstallButton />
            {email && <span className="note">{email}</span>}
            {supabase && <button className="chip ghost" onClick={() => supabase!.auth.signOut()}>登出</button>}
          </div>
        </div>
        {!store.cloud && <div className="banner">目前是本機模式：專案存在這個瀏覽器裡。設定 Supabase 後即可登入並存到雲端（見 README）。</div>}
        <div className="kv">
          <button className="chip key" onClick={() => create('cad')}>從 AutoCAD／PDF 開始</button>
          <button className="chip" onClick={() => create('sample')}>開啟範例平面</button>
          <button className="chip" onClick={() => create('blank')}>空白專案</button>
          <label className="chip tap">開啟專案檔<input id="project-file" className="tap-input" type="file" accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const { name, model } = await readProjectFile(f); onOpen(await store.create(name, model)); } catch (x) { setErr(String((x as Error).message || x)); } }} /></label>
        </div>
        {err && <p className="err">{err}</p>}
        {list === null ? <p className="note">載入中…</p> : list.length === 0 ? <p className="note">還沒有專案。先開一個範例平面看看，或直接匯入 AutoCAD 圖面。</p> : (
          <div className="grid">
            {list.map(p => (
              <div className="card" key={p.id}>
                {p.thumbnail && <img src={p.thumbnail} alt="" style={{ borderRadius: 8, aspectRatio: '16/10', objectFit: 'cover' }} />}
                {renaming?.id === p.id ? (
                  <form className="kv" onSubmit={async e => { e.preventDefault(); await store.save(p.id, { name: renaming.name || p.name }); setRenaming(null); refresh(); }}>
                    <input id={`name-${p.id}`} type="text" value={renaming.name} onChange={e => setRenaming({ id: p.id, name: e.target.value })} autoFocus />
                    <button className="chip on">儲存</button>
                  </form>
                ) : <h3 title={p.name}>{p.name}</h3>}
                <span className="meta">更新於 {new Date(p.updated_at).toLocaleString()}</span>
                <div className="acts">
                  <button className="chip on" onClick={() => onOpen(p.id)}>開啟</button>
                  <button className="chip" onClick={() => setRenaming({ id: p.id, name: p.name })}>改名</button>
                  {confirmId === p.id
                    ? <><button className="chip danger" onClick={async () => { await store.remove(p.id); setConfirmId(null); refresh(); }}>確定刪除</button><button className="chip ghost" onClick={() => setConfirmId(null)}>取消</button></>
                    : <button className="chip ghost danger" onClick={() => setConfirmId(p.id)}>刪除</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
