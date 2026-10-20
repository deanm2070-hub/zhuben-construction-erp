import {
  analyzeBuilding, buildBuilding, buildFromDxf, decodeDxf, mergeDrawings, DWG_VERSIONS, dwgSignature, guessLayerKind, guessUnits, parseDxf, sampleDxf,
  UNIT_NAME, UNIT_SCALE, WALL_H, type BuildingAnalysis, type BuildOptions, type CadData, type DxfDrawing, type LayerKind, type ModelObject,
} from '@cloud-modeler/core';
import { useMemo, useState } from 'react';
import { readDwg } from '../lib/dwg';
import { Modal } from './Modal';

/** How to tick several files in the phone's own file picker (the page cannot change that screen). */
const MULTI_HINT = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'iPhone：點「選擇檔案」，再點右上角「選取」，就能一次勾多個檔，最後按「打開」。'
  : /Android/.test(navigator.userAgent)
    ? 'Android：在檔案上長按，就能一次勾多個檔，最後按「選取」。'
    : '按住 Ctrl（Mac 按 ⌘）可以一次點選多個檔。'

type Stage =
  | { s: 'pick'; files: File[] }
  | { s: 'reading'; name: string; ver: string }
  | { s: 'building'; name: string; dxf: DxfDrawing; a: BuildingAnalysis }
  | { s: 'layers'; name: string; dxf: DxfDrawing; map: Record<string, LayerKind>; unit: number; wallH: number }
  | { s: 'error'; msg: string };

const ACI: Record<number, string> = { 1: '紅色', 2: '黃色', 3: '綠色', 4: '青色', 5: '藍色', 6: '洋紅色', 7: '白色', 8: '灰色' };
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
  const [st, setSt] = useState<Stage>({ s: 'pick', files: [] });
  const [picked, setPicked] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);

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
  if (st.s === 'pick') {
    // files add up over several picks (handy on phones); the input is cleared so the same file can be picked again
    const add = (list: FileList | null) => {
      const fs = [...(list || [])];
      if (!fs.length) return;
      const files = [...st.files];
      for (const f of fs) if (!files.some(o => o.name === f.name && o.size === f.size)) files.push(f);
      setSt({ s: 'pick', files });
    };
    const start = () => { setPicked(st.files); onFiles(st.files); };
    return (
      <Modal title="匯入 AutoCAD 圖面" desc="支援 DWG 與 DXF，直接在瀏覽器讀取。" onClose={onClose} actions={<>
        {close}
        <button className="chip" onClick={() => fromText(sampleDxf(), '範例 2房2廳.dxf')}>用範例 DXF 試試</button>
        <button className="chip on" disabled={!st.files.length} onClick={start}>{st.files.length > 1 ? `開始讀取 ${st.files.length} 個檔` : '開始讀取'}</button>
      </>}>
        <label className={`drop ${drag ? 'over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
          <b>{st.files.length ? '＋ 再加入檔案' : '點這裡選擇檔案'}</b>
          <span>DWG 或 DXF，可以一次選多個，也可以分次加入（建築圖、結構圖）</span>
          <small className="how">{MULTI_HINT}</small>
          <input id="cad-file" className="tap-input" type="file" multiple onChange={e => { add(e.target.files); e.target.value = ''; }} />
        </label>
        {st.files.length > 0 && <ul className="files">
          {st.files.map((f, i) => <li key={f.name + f.size}>
            <span>{f.name}</span><small>{(f.size / 1048576).toFixed(1)} MB</small>
            <button className="chip ghost" aria-label={`移除 ${f.name}`} onClick={() => setSt({ s: 'pick', files: st.files.filter((_, j) => j !== i) })}>移除</button>
          </li>)}
        </ul>}
        <p>整套執照圖（各層平面、立面或剖面、門窗表）會自動分出樓層，依高程算樓高，門窗依門窗表的尺寸與窗台高開口，蓋出整棟 3D。</p>
        <p>只有一張平面圖時，牆圖層會擠出成有厚度的 3D 牆（雙線牆自動配對），門弧算門、窗線算窗，房間名稱用來自動分區算面積。</p>
      </Modal>
    );
  }
  if (st.s === 'reading') return <Modal title="讀取 DWG 中" desc={`${st.name}｜${st.ver}`} onClose={() => {}} actions={null}><p>第一次開 DWG 會先下載讀取元件（約 10 MB），之後就很快。大型圖面需要幾秒鐘。</p></Modal>;
  if (st.s === 'building') return <BuildingStep st={st} firstId={firstId} onBuilt={onBuilt} onClose={onClose}
    onLayers={() => toLayers(st.dxf, st.name)} />;
  if (st.s === 'error') return <Modal title="無法匯入" onClose={onClose} actions={<><button className="chip" onClick={() => setSt({ s: 'pick', files: picked })}>重新選擇</button>{close}</>}><p className="err">{st.msg}</p></Modal>;

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
  // what is being typed, so a half-typed number is not snapped back while editing
  const [draft, setDraft] = useState<Record<string, string>>({});
  const storeys = a.storeys.map((s, i) => ({ ...s, h: hs[i], base: a.storeys[0].base + hs.slice(0, i).reduce((x, y) => x + y, 0) }));
  const views = a.views.filter(v => v.kind !== 'plan').map(v => v.title);
  // what you confirm here is remembered for this drawing set
  const key = `cad-rules:${name}`;
  const [opts, setOpts] = useState<BuildOptions>(() => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } });
  const change = (o: BuildOptions) => { setOpts(o); try { localStorage.setItem(key, JSON.stringify(o)); } catch { /* private window */ } };
  const preview = useMemo(() => { try { return buildBuilding(dxf, { ...a, storeys }, name, firstId, opts); } catch { return null; } }, [dxf, a, hs, opts]); // eslint-disable-line react-hooks/exhaustive-deps
  const rep = preview?.report;
  const projTexts = dxf.texts.filter(t => /投影線/.test(t.s)).length;
  const [err, setErr] = useState('');
  const build = () => {
    setErr('');
    let r: ReturnType<typeof buildBuilding>;
    try { r = buildBuilding(dxf, { ...a, storeys }, name, firstId, opts); } catch (e) { setErr(`建模失敗：${(e as Error).message}。可改用「圖層對應」，或把這段訊息回報給我。`); return; }
    try {
      const s = r.stats;
      const rc = r.cad.rc;
      onBuilt({ objects: r.objects, cad: r.cad, summary: `已建立 ${s.floors} 層：${s.walls} 道牆、${s.doors} 樘門、${s.windows} 樘窗` + (s.railings ? `、${s.railings} 段欄杆` : '')
        + (rc ? `；讀到${rc.spec.sheets.join('、')}，鋼筋依配筋圖計算` : '')
        + (s.extColor !== undefined ? `；外牆線顏色為${ACI[s.extColor] || `色號 ${s.extColor}`}，同色內牆算 RC 牆，其他顏色算輕隔間牆` : '') });
    } catch (e) { setErr(`3D 顯示失敗：${(e as Error).message}。請把這段訊息回報給我。`); }
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
      {err && <p className="warn" role="alert">{err}</p>}
      {!Object.keys(a.levels).length && <p className="warn">沒有在立面或剖面圖找到樓層高程（1F、2F…），樓高先用預設值，可在下表修改。</p>}
      <div className="tbl"><table>
        <thead><tr><th>樓層</th><th>平面圖</th><th className="num">樓板高程</th><th className="num">樓高 cm</th></tr></thead>
        <tbody>{storeys.map((s, i) => (
          <tr key={s.key}><td>{s.key}</td><td>{s.title}</td><td className="num">{s.base}</td><td className="num">
            <input id={`storey-h-${s.key}`} type="number" inputMode="numeric" min={0} max={2000} step={5} value={draft[i] ?? s.h} style={{ width: 72 }}
              onChange={e => { const t = e.target.value; setDraft(d => ({ ...d, [i]: t })); if (+t > 0) setHs(h => h.map((v, j) => j === i ? +t : v)); }}
              onBlur={() => setDraft(d => { const n = { ...d }; delete n[i]; return n; })} />
            {s.key === 'RF' && ' 女兒牆'}
          </td></tr>
        ))}</tbody>
      </table></div>
      {a.schedule.length > 0 && <div className="tbl"><table>
        <thead><tr><th>門窗編號</th><th>名稱</th><th className="num">寬 × 高</th><th className="num">窗台高 cm（可改）</th></tr></thead>
        <tbody>{a.schedule.map(i => (
          <tr key={i.code}><td>{i.code}</td><td>{i.name}</td><td className="num">{i.legs ? `${i.legs.join(' + ')}（轉角）` : i.w} × {i.h}</td><td className="num">
            {i.kind === 'door' ? i.sill : <input id={`sill-${i.code}`} type="number" min={0} max={300} step={5} value={draft[i.code] ?? opts.sills?.[i.code] ?? i.sill} style={{ width: 64 }}
              onChange={e => { const t = e.target.value; setDraft(d => ({ ...d, [i.code]: t })); if (t !== '' && +t >= 0) change({ ...opts, sills: { ...opts.sills, [i.code]: +t } }); }}
              onBlur={() => setDraft(d => { const n = { ...d }; delete n[i.code]; return n; })} />}
          </td></tr>
        ))}</tbody>
      </table></div>}
      {rep && <>
        <h4 style={{ margin: '12px 0 4px' }}>辨識確認（我猜的，不對請在這裡改）</h4>
        <div className="tbl"><table><tbody>
          {rep.wallColours.length >= 2 && <tr><td>外牆線顏色</td><td>
            <select id="rule-ext" value={opts.extColor ?? ''} onChange={e => change({ ...opts, extColor: e.target.value === '' ? undefined : +e.target.value })}>
              <option value="">自動判斷{preview!.stats.extColor !== undefined ? `（${ACI[preview!.stats.extColor] || `色號 ${preview!.stats.extColor}`}）` : ''}</option>
              {rep.wallColours.map(c => <option key={c.color} value={c.color}>{ACI[c.color] || `色號 ${c.color}`}（牆線 {Math.round(c.length / 100)} m）</option>)}
              <option value={-1}>不依顏色分，全依牆厚</option>
            </select><div className="note">同色內牆算 RC 牆，不同色算輕隔間牆；外輪廓上的牆一律算外牆。</div></td></tr>}
          {projTexts > 0 && <tr><td>陽台投影線</td><td><label><input id="rule-proj" type="checkbox" checked={!opts.noProjection} onChange={e => change({ ...opts, noProjection: !e.target.checked })} /> 圖上標「投影線」的線是上層外挑的投影，不建牆（找到 {projTexts} 處標示）</label></td></tr>}
          {(rep.slantWalls > 0 || opts.noSlants) && <tr><td>斜牆</td><td><label><input id="rule-slant" type="checkbox" checked={!opts.noSlants} onChange={e => change({ ...opts, noSlants: !e.target.checked })} /> 保留 3 公尺以上的斜牆（目前 {rep.slantWalls} 道）</label></td></tr>}
          <tr><td>樓梯</td><td>{rep.stairs.length ? rep.stairs.map(t => `${t.from}→${t.to || '屋頂'}，${t.risers} 階`).join('；') : '沒有辨識到樓梯'}</td></tr>
          {rep.unmatchedTags.length > 0 && <tr><td>可能沒開洞的門窗</td><td className="warn">{[...new Set(rep.unmatchedTags.map(t => `${t.floor} ${t.code}`))].join('、')}（平面圖上有編號，找不到對應開口，請建好後檢查）</td></tr>}
        </tbody></table></div>
        <div className="tbl"><table>
          <thead><tr><th>樓層</th><th className="num">牆</th><th className="num">門</th><th className="num">窗</th><th className="num">樓板</th></tr></thead>
          <tbody>{rep.perFloor.map(f => <tr key={f.key}><td>{f.key}</td><td className="num">{f.walls}</td><td className="num">{f.doors}</td><td className="num">{f.windows}</td><td className="num">{f.slabs}</td></tr>)}</tbody>
        </table></div>
        <h4 style={{ margin: '12px 0 4px' }}>圖面拆解（每張圖我認成什麼）</h4>
        <div className="tbl"><table>
          <thead><tr><th>圖名</th><th>種類</th><th>用在</th></tr></thead>
          <tbody>{a.views.map((v, i) => { const [kind, use] = ({ plan: ['平面圖', '各層牆、柱、門窗、樓板'], structure: ['結構平面圖', '梁、柱、板編號與配筋'], elevation: ['立面圖', '樓層高程、樓高'], section: ['剖面圖', '樓層高程、樓梯、女兒牆'], schedule: ['門窗表／詳圖', '門窗尺寸、窗台高、數量'] } as Record<string, string[]>)[v.kind]; return <tr key={i}><td>{v.title}</td><td>{kind}</td><td>{v.floors.length ? v.floors.join('、') + ' ' : ''}{use}</td></tr>; })}</tbody>
        </table></div>
        {rep.areaChecks.length > 0 && <>
          <h4 style={{ margin: '12px 0 4px' }}>樓地板面積對帳（圖上法規檢討寫的面積 vs 3D 建出的樓板）</h4>
          <div className="tbl"><table>
            <thead><tr><th>樓層</th><th className="num">圖上面積 ㎡</th><th className="num">3D 樓板 ㎡</th><th>結果</th></tr></thead>
            <tbody>{rep.areaChecks.map(c => { const p = (c.built / c.stated - 1) * 100; return <tr key={c.floor}><td>{c.floor}</td><td className="num">{c.stated}</td><td className="num">{c.built}</td>
              <td className={Math.abs(p) > 8 ? 'warn' : ''}>{Math.abs(p) <= 8 ? `相差 ${p.toFixed(1)}%（法規面積算到牆中心，3D 算到牆外緣，屬正常）` : `相差 ${p.toFixed(1)}%，樓板範圍可能有漏或多`}</td></tr>; })}</tbody>
          </table></div>
        </>}
        {rep.tally.length > 0 && <>
          <h4 style={{ margin: '12px 0 4px' }}>門窗數量對帳（門窗表的數量 vs 3D 建出的數量）</h4>
          <div className="tbl"><table>
            <thead><tr><th>編號</th><th>名稱</th><th className="num">門窗表</th><th className="num">圖上標示</th><th className="num">建出</th><th>結果</th></tr></thead>
            <tbody>{rep.tally.map(t => <tr key={t.code}><td>{t.code}</td><td>{t.name}</td><td className="num">{t.qty ?? '—'}</td><td className="num">{t.tagged ?? 0}</td><td className="num">{t.built}{t.guessed ? `（${t.guessed} 處依寬度推定）` : ''}</td>
              <td className={t.qty !== undefined && t.qty !== t.built ? 'warn' : ''}>{t.qty === undefined ? '表上沒寫數量' : t.qty === t.built ? '相符' : t.built < t.qty ? `少 ${t.qty - t.built}，可能沒開洞` : `多 ${t.built - t.qty}，可能重複或表上漏算`}</td></tr>)}</tbody>
          </table></div>
        </>}
      </>}
      <p className="note">牆依各層平面圖的牆、柱圖層建立，各層用軸線對齊。門窗開口依平面上的編號套用門窗表的高度與窗台高，沒有編號的開口用預設尺寸（門 210、窗台 90＋窗高 150）。</p>
    </Modal>
  );
}
