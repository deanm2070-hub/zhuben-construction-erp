import {
  analyzeBuilding, buildBuilding, buildFromDxf, decodeDxf, mergeDrawings, DWG_VERSIONS, dwgSignature, guessLayerKind, guessUnits, parseDxf, sampleDxf,
  UNIT_NAME, UNIT_SCALE, WALL_H, type BuildingAnalysis, type CadData, type DxfDrawing, type LayerKind, type ModelObject,
} from '@cloud-modeler/core';
import { useState } from 'react';
import { readDwg } from '../lib/dwg';
import { Modal } from './Modal';

type Stage =
  | { s: 'pick' }
  | { s: 'reading'; name: string; ver: string }
  | { s: 'building'; name: string; dxf: DxfDrawing; a: BuildingAnalysis }
  | { s: 'layers'; name: string; dxf: DxfDrawing; map: Record<string, LayerKind>; unit: number; wallH: number }
  | { s: 'error'; msg: string };

export interface ImportResult { objects: ModelObject[]; cad: CadData; summary: string }

const KINDS: [LayerKind, string][] = [['wall', '牆體（擠出成 3D 牆）'], ['furn', '家具／櫃（擠出）'], ['line', '只顯示線條'], ['off', '不匯入']];

/** File → (DWG conversion) → layer mapping → 3D objects. */
export function CadImport({ firstId, onBuilt, onSource, onClose }: {
  firstId: number;
  onBuilt: (r: ImportResult) => void;
  /** original file, kept in cloud storage */
  onSource: (f: File) => void;
  onClose: () => void;
}) {
  const [st, setSt] = useState<Stage>({ s: 'pick' });

  const toLayers = (dxf: DxfDrawing, name: string) => {
    const map: Record<string, LayerKind> = {};
    for (const l of dxf.layers.keys()) map[l] = guessLayerKind(l);
    setSt({ s: 'layers', name, dxf, map, unit: guessUnits(dxf), wallH: WALL_H });
  };

  /** A drawing set with several floor plans goes to the whole-building step, a single plan to layer mapping. */
  const route = (dxf: DxfDrawing, name: string) => {
    if (!dxf.segs.length) return setSt({ s: 'error', msg: '讀不到任何線條。請確認圖面畫在模型空間。' });
    const a = analyzeBuilding(dxf);
    if (a && a.storeys.length >= 2) return setSt({ s: 'building', name, dxf, a });
    toLayers(dxf, name);
  };
  const fromText = (text: string, name: string) => {
    let dxf: DxfDrawing;
    try { dxf = parseDxf(text); } catch { return setSt({ s: 'error', msg: '檔案解析失敗，請確認是 ASCII 格式的 DXF。' }); }
    route(dxf, name);
  };

  /** One file to a drawing; null after showing the error. */
  const readOne = async (f: File, n: number, of: number): Promise<DxfDrawing | null> => {
    const raw = await f.arrayBuffer(), buf = new Uint8Array(raw);
    const sig = dwgSignature(buf);
    if (sig) {
      const ver = DWG_VERSIONS[sig] ? `AutoCAD ${DWG_VERSIONS[sig]}（${sig}）` : sig;
      setSt({ s: 'reading', name: of > 1 ? `${f.name}（第 ${n}／${of} 個檔）` : f.name, ver });
      try {
        const dxf = await readDwg(raw, sig);
        onSource(f);
        return dxf;
      } catch (e) { setSt({ s: 'error', msg: `${f.name} 讀取失敗：${(e as Error).message}。可以在 AutoCAD 另存成 DXF 再試一次。` }); return null; }
    }
    if (new TextDecoder('latin1').decode(buf.slice(0, 18)) === 'AutoCAD Binary DXF') { setSt({ s: 'error', msg: `${f.name} 是二進位 DXF，請在 AutoCAD 另存為 ASCII DXF 再匯入。` }); return null; }
    try {
      const dxf = parseDxf(decodeDxf(buf));
      onSource(f);
      return dxf;
    } catch { setSt({ s: 'error', msg: `${f.name} 解析失敗，請確認是 DWG 或 ASCII 格式的 DXF。` }); return null; }
  };
  /** Several files (architectural + structural sets) are read one by one and laid side by side. */
  const onFiles = async (files: File[]) => {
    const ds: DxfDrawing[] = [];
    for (let i = 0; i < files.length; i++) {
      const d = await readOne(files[i], i + 1, files.length);
      if (!d) return;
      ds.push(d);
    }
    route(mergeDrawings(ds), files.map(f => f.name).join('、'));
  };

  const close = <button className="chip" onClick={onClose}>取消</button>;
  if (st.s === 'pick') return (
    <Modal title="匯入 AutoCAD 圖面" desc="支援 DWG 與 DXF，直接在瀏覽器讀取，可一次選多個檔。" onClose={onClose} actions={<>
      {close}
      <button className="chip" onClick={() => fromText(sampleDxf(), '範例 2房2廳.dxf')}>用範例 DXF 試試</button>
      <label className="chip on">選擇檔案<input id="cad-file" type="file" accept=".dwg,.dxf" multiple hidden onChange={e => { const fs = [...(e.target.files || [])]; if (fs.length) onFiles(fs); }} /></label>
    </>}>
      <p>整套執照圖（各層平面、立面或剖面、門窗表）會自動分出樓層，依高程算樓高，門窗依門窗表的尺寸與窗台高開口，蓋出整棟 3D。圖分在好幾個檔（例如建築圖和結構圖）時，按住 Ctrl（Mac 按 ⌘）一次選取全部檔案。</p>
      <p>只有一張平面圖時，牆圖層會擠出成有厚度的 3D 牆（雙線牆自動配對），門弧算門、窗線算窗，房間名稱用來自動分區算面積。</p>
    </Modal>
  );
  if (st.s === 'reading') return <Modal title="讀取 DWG 中" desc={`${st.name}｜${st.ver}`} onClose={() => {}} actions={null}><p>第一次開 DWG 會先下載讀取元件（約 10 MB），之後就很快。大型圖面需要幾秒鐘。</p></Modal>;
  if (st.s === 'building') return <BuildingStep st={st} firstId={firstId} onBuilt={onBuilt} onClose={onClose}
    onLayers={() => toLayers(st.dxf, st.name)} />;
  if (st.s === 'error') return <Modal title="無法匯入" onClose={onClose} actions={<><button className="chip" onClick={() => setSt({ s: 'pick' })}>重新選擇</button>{close}</>}><p className="err">{st.msg}</p></Modal>;

  const { dxf, map, unit, wallH, name } = st;
  const layers = [...dxf.layers.entries()].sort((a, b) => b[1] - a[1]);
  const hasWall = Object.values(map).includes('wall');
  const build = () => {
    const r = buildFromDxf(dxf, map, UNIT_SCALE[unit], wallH, name, firstId);
    if (!r) return setSt({ s: 'error', msg: '選取的圖層裡沒有線條，請至少保留一個圖層。' });
    const s = r.stats;
    onBuilt({ ...r, summary: `已建立 ${s.walls} 道牆、${s.doors} 樘門、${s.windows} 樘窗、${s.furniture} 件家具／櫃` + (s.singleWalls ? `（${s.singleWalls} 條單線當作 10cm 牆）` : '') });
  };
  return (
    <Modal title="圖層對應" desc={`來源：${name}。確認每個圖層要轉成什麼。`} onClose={onClose} actions={<>{close}<button className="chip on" onClick={build}>建立 3D 模型</button></>}>
      <div className="kv">
        <span className="badge">{dxf.version ? (DWG_VERSIONS[dxf.version] ? `AutoCAD ${DWG_VERSIONS[dxf.version]}` : dxf.version) : 'DXF'}</span>
        <span className="badge">{dxf.segs.length.toLocaleString()} 段線</span>
        <span className="badge">{dxf.texts.length} 筆文字</span>
        <span className="badge">{dxf.blockCount} 個圖塊・{dxf.inserts} 次插入</span>
      </div>
      <div className="kv">
        <label>圖面單位 <select id="cad-unit" value={unit} onChange={e => setSt({ ...st, unit: +e.target.value })}>
          {[4, 5, 6, 1, 2].map(u => <option key={u} value={u}>{UNIT_NAME[u]}</option>)}
        </select></label>
        <label>牆高 <input id="cad-wallh" type="number" min={100} max={1000} step={10} value={wallH} onChange={e => setSt({ ...st, wallH: Math.max(100, +e.target.value || WALL_H) })} style={{ width: 80 }} /> cm</label>
      </div>
      {!hasWall && <p className="warn">沒有自動辨識到牆圖層，請在下表把畫牆的圖層設成「牆體」。</p>}
      <div className="tbl"><table>
        <thead><tr><th>圖層</th><th className="num">圖元</th><th>轉成</th></tr></thead>
        <tbody>{layers.map(([l, c]) => (
          <tr key={l}><td>{l}</td><td className="num">{c}</td><td>
            <select id={`layer-${l}`} value={map[l]} onChange={e => setSt({ ...st, map: { ...map, [l]: e.target.value as LayerKind } })}>
              {KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
          </td></tr>
        ))}</tbody>
      </table></div>
    </Modal>
  );
}

/** Shows what was recognised in a drawing set (storeys, heights, door & window schedule) before building it. */
function BuildingStep({ st, firstId, onBuilt, onLayers, onClose }: {
  st: { name: string; dxf: DxfDrawing; a: BuildingAnalysis };
  firstId: number;
  onBuilt: (r: ImportResult) => void;
  onLayers: () => void;
  onClose: () => void;
}) {
  const { a, dxf, name } = st;
  const [hs, setHs] = useState(a.storeys.map(s => s.h));
  const storeys = a.storeys.map((s, i) => ({ ...s, h: hs[i], base: a.storeys[0].base + hs.slice(0, i).reduce((x, y) => x + y, 0) }));
  const views = a.views.filter(v => v.kind !== 'plan').map(v => v.title);
  const build = () => {
    const r = buildBuilding(dxf, { ...a, storeys }, name, firstId);
    const s = r.stats;
    onBuilt({ objects: r.objects, cad: r.cad, summary: `已建立 ${s.floors} 層：${s.walls} 道牆、${s.doors} 樘門、${s.windows} 樘窗` + (s.railings ? `、${s.railings} 段欄杆` : '') });
  };
  return (
    <Modal title="整棟自動建模" desc={`來源：${name}。確認辨識結果後建立 3D。`} onClose={onClose} actions={<>
      <button className="chip" onClick={onClose}>取消</button>
      <button className="chip" onClick={onLayers}>改用圖層對應（單張平面）</button>
      <button className="chip on" onClick={build}>建立整棟 3D</button>
    </>}>
      <div className="kv">
        <span className="badge">{a.plans.length} 張平面圖</span>
        <span className="badge">{storeys.length} 個樓層</span>
        <span className="badge">門窗表 {a.schedule.length} 種</span>
        {views.length > 0 && <span className="badge" title={views.join('、')}>另有 {views.length} 張立面／剖面／門窗圖</span>}
      </div>
      {!Object.keys(a.levels).length && <p className="warn">沒有在立面或剖面圖找到樓層高程（1F、2F…），樓高先用預設值，可在下表修改。</p>}
      <div className="tbl"><table>
        <thead><tr><th>樓層</th><th>平面圖</th><th className="num">樓板高程</th><th className="num">樓高 cm</th></tr></thead>
        <tbody>{storeys.map((s, i) => (
          <tr key={s.key}><td>{s.key}</td><td>{s.title}</td><td className="num">{s.base}</td><td className="num">
            <input id={`storey-h-${s.key}`} type="number" min={50} max={1000} step={5} value={s.h} style={{ width: 72 }}
              onChange={e => setHs(h => h.map((v, j) => j === i ? Math.max(50, +e.target.value || v) : v))} />
            {s.key === 'RF' && ' 女兒牆'}
          </td></tr>
        ))}</tbody>
      </table></div>
      {a.schedule.length > 0 && <div className="tbl"><table>
        <thead><tr><th>門窗編號</th><th>名稱</th><th className="num">寬 × 高</th><th className="num">窗台高</th></tr></thead>
        <tbody>{a.schedule.map(i => (
          <tr key={i.code}><td>{i.code}</td><td>{i.name}</td><td className="num">{i.w} × {i.h}</td><td className="num">{i.sill}</td></tr>
        ))}</tbody>
      </table></div>}
      <p className="note">牆依各層平面圖的牆、柱圖層建立，各層用軸線對齊。門窗開口依平面上的編號套用門窗表的高度與窗台高，沒有編號的開口用預設尺寸（門 210、窗台 90＋窗高 150）。</p>
    </Modal>
  );
}
