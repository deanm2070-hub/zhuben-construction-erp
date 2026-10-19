import {
  buildFromDxf, decodeDxf, DWG_VERSIONS, dwgSignature, guessLayerKind, guessUnits, parseDxf, sampleDxf,
  UNIT_NAME, UNIT_SCALE, WALL_H, type CadBuildResult, type DxfDrawing, type LayerKind,
} from '@cloud-modeler/core';
import { useState } from 'react';
import { convertDwg, dwgConverterReady } from '../lib/dwg';
import { Modal } from './Modal';

type Stage =
  | { s: 'pick' }
  | { s: 'converting'; name: string; ver: string }
  | { s: 'dwg-help'; name: string; ver: string }
  | { s: 'layers'; name: string; dxf: DxfDrawing; map: Record<string, LayerKind>; unit: number; wallH: number }
  | { s: 'error'; msg: string };

const KINDS: [LayerKind, string][] = [['wall', '牆體（擠出成 3D 牆）'], ['furn', '家具／櫃（擠出）'], ['line', '只顯示線條'], ['off', '不匯入']];

/** File → (DWG conversion) → layer mapping → 3D objects. */
export function CadImport({ firstId, onBuilt, onSource, onClose }: {
  firstId: number;
  onBuilt: (r: CadBuildResult) => void;
  /** original file, kept in cloud storage */
  onSource: (f: File) => void;
  onClose: () => void;
}) {
  const [st, setSt] = useState<Stage>({ s: 'pick' });

  const toLayers = (text: string, name: string) => {
    let dxf: DxfDrawing;
    try { dxf = parseDxf(text); } catch { return setSt({ s: 'error', msg: '檔案解析失敗，請確認是 ASCII 格式的 DXF。' }); }
    if (!dxf.segs.length) return setSt({ s: 'error', msg: '讀不到任何線條。請確認是 ASCII 格式的 DXF，且圖面在模型空間。' });
    const map: Record<string, LayerKind> = {};
    for (const l of dxf.layers.keys()) map[l] = guessLayerKind(l);
    setSt({ s: 'layers', name, dxf, map, unit: guessUnits(dxf), wallH: WALL_H });
  };

  const onFile = async (f: File) => {
    const buf = new Uint8Array(await f.arrayBuffer());
    const sig = dwgSignature(buf);
    if (sig) {
      const ver = DWG_VERSIONS[sig] ? `AutoCAD ${DWG_VERSIONS[sig]}（${sig}）` : sig;
      if (!dwgConverterReady) return setSt({ s: 'dwg-help', name: f.name, ver });
      setSt({ s: 'converting', name: f.name, ver });
      try {
        const dxf = await convertDwg(f);
        onSource(f);
        toLayers(decodeDxf(dxf), f.name);
      } catch (e) { setSt({ s: 'error', msg: `DWG 轉檔失敗：${(e as Error).message}` }); }
      return;
    }
    if (new TextDecoder('latin1').decode(buf.slice(0, 18)) === 'AutoCAD Binary DXF') return setSt({ s: 'error', msg: '這是二進位 DXF，請在 AutoCAD 另存為 ASCII DXF 再匯入。' });
    onSource(f);
    toLayers(decodeDxf(buf), f.name);
  };

  const close = <button className="chip" onClick={onClose}>取消</button>;
  if (st.s === 'pick') return (
    <Modal title="匯入 AutoCAD 圖面" desc="支援 DXF；DWG 會先送到雲端轉檔服務轉成 DXF。" onClose={onClose} actions={<>
      {close}
      <button className="chip" onClick={() => toLayers(sampleDxf(), '範例 2房2廳.dxf')}>用範例 DXF 試試</button>
      <label className="chip on">選擇檔案<input id="cad-file" type="file" accept=".dwg,.dxf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} /></label>
    </>}>
      <p>牆圖層會擠出成有厚度的 3D 牆（雙線牆自動配對），門弧算門、窗線算窗，房間名稱用來自動分區算面積。</p>
    </Modal>
  );
  if (st.s === 'converting') return <Modal title="DWG 轉檔中" desc={`${st.name}｜${st.ver}`} onClose={() => {}} actions={null}><p>正在雲端把 DWG 轉成 DXF，大型圖面可能需要一點時間。</p></Modal>;
  if (st.s === 'dwg-help') return (
    <Modal title="這個環境還沒有 DWG 轉檔服務" desc={`${st.name}｜${st.ver}`} onClose={onClose} actions={close}>
      <p>請在 AutoCAD 用「另存新檔 → AutoCAD DXF」存成 DXF 後再匯入。部署 services/dwg-converter 並設定 VITE_DWG_CONVERTER_URL 後，就能直接匯入 DWG。</p>
    </Modal>
  );
  if (st.s === 'error') return <Modal title="無法匯入" onClose={onClose} actions={<><button className="chip" onClick={() => setSt({ s: 'pick' })}>重新選擇</button>{close}</>}><p className="err">{st.msg}</p></Modal>;

  const { dxf, map, unit, wallH, name } = st;
  const layers = [...dxf.layers.entries()].sort((a, b) => b[1] - a[1]);
  const hasWall = Object.values(map).includes('wall');
  const build = () => {
    const r = buildFromDxf(dxf, map, UNIT_SCALE[unit], wallH, name, firstId);
    if (!r) return setSt({ s: 'error', msg: '選取的圖層裡沒有線條，請至少保留一個圖層。' });
    onBuilt(r);
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
