import { memberOf, MEMBERS, type CadData, type ModelObject } from '@cloud-modeler/core';
import { TRIAL_LOCK } from '../lib/account';

/** 圖面匯入: the ways in, what was recognised from the drawings, and the correction tools. */
export function ImportPane({ cad, objects, readOnly, trial, onImport, onLocked, onTo3d }: {
  cad: CadData | null; objects: ModelObject[]; readOnly: boolean; trial: boolean;
  onImport: () => void; onLocked: () => void; onTo3d: () => void;
}) {
  const pick = <i className={`chip ${trial ? '' : 'key'}`}>{trial ? `🔒 ${TRIAL_LOCK}` : '選擇檔案'}</i>;
  const count = new Map<string, number>();
  for (const o of objects) { const k = memberOf(o); count.set(k, (count.get(k) || 0) + 1); }
  const floors = cad?.floors || [];
  return (
    <div className="pane">
      <div className="paneHead"><div><h2>圖面匯入</h2><p className="note">建築圖與結構圖一起匯入，軟體自己辨識圖層、尺寸、軸線、樓層與構件，建出 3D 模型並計算數量。</p></div></div>
      {trial && <div className="banner">試用帳號只能使用「範例平面」。匯入自己的圖檔：<b>{TRIAL_LOCK}</b>。<button className="chip key sm" onClick={onLocked}>如何開通</button></div>}
      <div className="cols2">
        <button className="card pickCard" disabled={readOnly} onClick={onImport}>
          <b>AutoCAD 圖面</b><span>DWG、DXF（可一次選多個檔：各層平面圖、結構平面圖、配筋圖、立面、剖面、門窗表）</span>
          {pick}
        </button>
        <button className="card pickCard" disabled={readOnly} onClick={onImport}>
          <b>SketchUp／3D 模型</b><span>.skp（2013 以後）、.dae、.obj、.glb、.fbx：認出樓層、牆、門窗、柱、梁、板、樓梯</span>
          {pick}
        </button>
      </div>

      <section className="card">
        <h3>辨識結果</h3>
        {!cad && !objects.length ? <p className="note">還沒有匯入圖面。</p> : <>
          <div className="kv">
            {cad && <span className="badge">{cad.name}</span>}
            {cad && <span className="note">範圍 {Math.round(cad.W / 100 * 10) / 10} × {Math.round(cad.D / 100 * 10) / 10} m</span>}
            {cad?.rc && <span className="badge">已讀到結構配筋圖（{cad.rc.spec.sheets.length} 張）</span>}
          </div>
          {floors.length > 0 && <div className="tbl"><table>
            <thead><tr><th>樓層</th><th>圖名</th><th className="num">樓板高程 cm</th><th className="num">樓高 cm</th><th className="num">構件數</th></tr></thead>
            <tbody>{floors.map(f => <tr key={f.key}><td>{f.key}</td><td>{f.title}</td><td className="num">{f.y}</td><td className="num">{f.h}</td><td className="num">{objects.filter(o => o.floor === f.key).length}</td></tr>)}</tbody>
          </table></div>}
          <div className="stats">{MEMBERS.filter(m => count.get(m)).map(m => <div key={m}><span>{m}</span><b>{count.get(m)}</b></div>)}</div>
        </>}
      </section>

      <section className="card">
        <h3>人工校正工具</h3>
        <ul className="howto">
          <li><b>匯入時「辨識確認」</b>：建模前列出外牆線顏色、樓層與樓高、窗台高、門窗表與對帳，可直接改。</li>
          <li><b>選取構件改屬性</b>：在 3D 模型點一下構件，右側面板可改名稱、類別（RC 牆／隔間牆／柱）、寬深高、離地高與樓層，數量立即重算。</li>
          <li><b>繪圖補構件</b>：隔間牆、RC 牆、欄杆、柱、樓板、櫃，拖曳畫出。</li>
          <li><b>推拉、移動、刪除、復原</b>：修正高度、位置，刪掉多出來的線條構件。</li>
          <li><b>構件分類顯示</b>：只看柱、梁、樓板或牆，逐類檢查有沒有漏建、多建。</li>
        </ul>
        <button className="chip on" style={{ alignSelf: 'flex-start' }} onClick={onTo3d}>到 3D 模型校正</button>
      </section>
      <p className="note">支援格式：DWG（瀏覽器直接讀取，不需轉檔）、DXF、SketchUp .skp（2013 以後）、DAE、OBJ、GLB／GLTF、FBX。原始檔會自動備份到雲端（見「專案管理」）。</p>
    </div>
  );
}
