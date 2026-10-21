import { computeBuildingTakeoff, computeTakeoff, DEFAULT_SETTINGS, type FinishChoice, type TakeoffSettings } from '@cloud-modeler/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DRAW_KINDS, TOOL_HINT, Viewer, type DrawKind, type RenderMode, type SceneKey, type Tool } from '../engine/Viewer';
import { download, loadImage, pdfFirstPage, PROJECT_EXT, projectFile } from '../lib/files';
import { store } from '../lib/store';
import { CadImport } from './CadImport';
import { Dock } from './Dock';
import { Takeoff } from './Takeoff';

const MODES: [RenderMode, string][] = [['mat', '材質＋邊線'], ['layer', '圖層分色'], ['white', '純白白模'], ['xray', 'X光透視'], ['wire', '線框']];
const SCENES: [SceneKey, string][] = [['sw', '西南等角全覽'], ['top', '正交平面俯視（2D/3D）'], ['hall', '走道與門向特寫'], ['ne', '東北等角']];
const PALETTE = [0xeeebe5, 0xc98a4b, 0x6b4f3a, 0x2f6fd6, 0x41557a, 0x6f7d93, 0x16a34a, 0xdc2626, 0xf5b83d, 0x1d2533];
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export function Editor({ projectId, importNow, onExit }: { projectId: string; importNow: boolean; onExit: () => void }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [name, setName] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [mode, setMode] = useState<RenderMode>('mat');
  const [tool, setTool] = useState<Tool>('orbit');
  const [scene, setScene] = useState<SceneKey>('sw');
  const [magnet, setMagnet] = useState(true);
  const [labels, setLabels] = useState(true);
  const [section, setSection] = useState({ on: false, h: 140 });
  const [drawKind, setDrawKind] = useState<DrawKind>('wall');
  const [drawThick, setDrawThick] = useState(''), [drawH, setDrawH] = useState('');
  const [paint, setPaint] = useState(0x2f6fd6);
  const [info, setInfo] = useState(TOOL_HINT.orbit);
  const [delta, setDelta] = useState('ΔX 0 · ΔZ 0 cm');
  const [toast, setToast] = useState({ text: '', show: false });
  const [dialog, setDialog] = useState<'none' | 'cad' | 'takeoff'>(importNow ? 'cad' : 'none');
  // the import dialog is for a new project only: a reload (or the 更新 button) must not bring it back over the model
  useEffect(() => { if (importNow) history.replaceState(null, '', `#/p/${projectId}`); }, []);
  const [underlay, setUnderlay] = useState(false);
  const [floor, setFloor] = useState<string | null>(null);
  const [finishes, setFinishes] = useState<Record<string, Partial<FinishChoice>>>({});
  const [settings, setSettings] = useState<TakeoffSettings>(DEFAULT_SETTINGS);
  const [save, setSave] = useState<SaveState>('saved');
  const [, bump] = useState(0);
  const toastTimer = useRef<number>();
  const saveTimer = useRef<number>();
  const loaded = useRef(false);
  const meta = useRef({ finishes, settings });
  meta.current = { finishes, settings };

  const exportSkp = async () => {
    showToast('正在產生 SketchUp 檔…');
    try {
      const { buildSkp } = await import('../lib/skpExport');
      download(`${name || 'model'}.skp`, await buildSkp(v().exportParts()), 'application/vnd.sketchup.skp');
      showToast('已匯出 .skp：每層、每類構件各一個標記（Tag），可在 SketchUp 分開顯示');
    } catch (e) {
      showToast(`匯出 .skp 失敗：${(e as Error).message}`);
    }
  };
  const showToast = useCallback((text: string) => {
    setToast({ text, show: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(t => ({ ...t, show: false })), 2400);
  }, []);

  const persist = useCallback(async (withThumb = false) => {
    const v = viewer.current;
    if (!v) return;
    setSave('saving');
    try {
      await store.save(projectId, {
        model: { objects: v.objects, cad: v.cad, ...meta.current },
        ...(withThumb ? { thumbnail: v.thumbnail() } : {}),
      });
      setSave('saved');
    } catch { setSave('error'); }
  }, [projectId]);
  const scheduleSave = useCallback(() => {
    setSave('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(true), 1500);
  }, [persist]);

  useEffect(() => {
    const v = new Viewer(viewRef.current!, labelRef.current!, {
      info: setInfo,
      toast: showToast,
      delta: (dx, dz) => setDelta(`ΔX ${Math.round(dx)} · ΔZ ${Math.round(dz)} cm`),
      change: () => { scheduleSave(); bump(n => n + 1); },
    });
    viewer.current = v;
    let alive = true;
    store.load(projectId).then(p => {
      if (!alive) return;
      setName(p.name);
      setFinishes(p.model.finishes || {});
      setSettings({ ...DEFAULT_SETTINGS, ...(p.model.settings || {}) });
      v.load(p.model.objects || [], p.model.cad || null);
      setFloor(null);
      setTimeout(() => { loaded.current = true; }, 0);
    }).catch(e => setLoadErr(String(e.message || e)));
    return () => { alive = false; v.dispose(); viewer.current = null; };
  }, [projectId, showToast, scheduleSave]);

  // save on leave
  // Ctrl+S saves now; closing the page with unsaved changes asks first
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); persist(true).then(() => showToast(store.cloud ? '已存到雲端' : '已存在這個瀏覽器')); } };
    const b = (e: BeforeUnloadEvent) => { if (save !== 'saved') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', k); window.addEventListener('beforeunload', b);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('beforeunload', b); };
  }, [persist, save, showToast]);
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); persist(true); } }, [persist]);
  useEffect(() => { if (loaded.current) scheduleSave(); }, [finishes, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = () => viewer.current!;
  const chooseTool = (t: Tool) => { v().setTool(t); setTool(t); };
  const toggleTheme = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    v().themeChanged();
    bump(n => n + 1);
  };

  const onUnderlayFile = async (f: File) => {
    try {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        const { canvas, pages } = await pdfFirstPage(f);
        v().setUnderlay(canvas);
        showToast(`PDF 第 1 頁已鋪在地面${pages > 1 ? `（共 ${pages} 頁）` : ''}，可用「畫牆/櫃」描圖`);
      } else {
        v().setUnderlay(await loadImage(f));
        showToast('底圖已鋪在地面，可用「畫牆/櫃」描圖');
      }
      store.uploadSource(projectId, f).catch(() => {});
      setUnderlay(true);
      v().goScene('top'); setScene('top');
      chooseTool('draw');
    } catch { showToast('檔案讀取失敗，請確認 PDF 沒有加密'); }
  };

  const takeoff = () => {
    const vw = v();
    if (vw.cad?.floors?.length) return computeBuildingTakeoff(vw.objects, vw.cad, finishes, settings);
    return computeTakeoff({
      objects: vw.objects, bounds: vw.planBounds, labels: vw.roomLabels(), rects: vw.roomRects,
      cadDoors: vw.cad?.doors, finishes, settings,
    });
  };

  const darkNow = typeof window !== 'undefined' && getComputedStyle(document.documentElement).colorScheme.includes('dark');
  const saveLabel = { saved: store.cloud ? '已存到雲端' : '已存在本機', dirty: '尚未儲存', saving: '儲存中…', error: '儲存失敗，稍後重試' }[save];

  return (
    <div className="app">
      <div className="bars">
        <div className="row">
          <button className="chip ghost" onClick={async () => { if (save !== 'saved') await persist(true); onExit(); }}>← 專案</button>
          <span className="brand title" title={name}>{name}</span>
          <span className="save" role="status">{saveLabel}</span>
          <button className="chip key" onClick={async () => { await persist(true); showToast(store.cloud ? '已存到雲端' : '已存在這個瀏覽器'); }}>儲存</button>
          <button className="chip" onClick={() => { const v = viewer.current; if (!v) return; download(`${name || '專案'}${PROJECT_EXT}`, projectFile(name || '未命名專案', { objects: v.objects, cad: v.cad, ...meta.current }), 'application/json'); showToast('已存成檔案，可在「我的專案」用「開啟專案檔」讀回'); }}>存成檔案</button>
        </div>
        <div className="row wrap">
          {MODES.map(([k, l]) => <button key={k} className={`chip ${mode === k ? 'on' : ''}`} onClick={() => { v().setMode(k); setMode(k); }}>{l}</button>)}
          <span className="sep" />
          <button className={`chip ${magnet ? 'on' : ''}`} onClick={() => { v().setMagnet(!magnet); setMagnet(!magnet); showToast(magnet ? '磁吸貼合：關' : '磁吸貼合：開'); }}>磁吸貼合</button>
          <button className="chip" onClick={() => { v().setShowLabels(!labels); setLabels(!labels); }}>{labels ? '隱藏標籤' : '顯示標籤'}</button>
          <span className="sep" />
          <button className="chip key" onClick={() => setDialog('cad')}>匯入 AutoCAD／SketchUp</button>
          {underlay
            ? <button className="chip" onClick={() => { v().setUnderlay(null); setUnderlay(false); }}>移除底圖</button>
            : <label className="chip tap">匯入 PDF／圖片底圖<input id="underlay-file" className="tap-input" type="file" accept="image/*,application/pdf,.pdf" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onUnderlayFile(f); }} /></label>}
          <button className="chip key" onClick={() => setDialog('takeoff')}>工程數量</button>
          <button className="chip" onClick={exportSkp}>匯出 .SKP（SketchUp）</button>
          <button className="chip" onClick={() => download(`${name || 'model'}.obj`, v().exportOBJ(name), 'text/plain')}>匯出 .OBJ</button>
          <button className="chip ghost" onClick={toggleTheme}>{darkNow ? '切換白底介面' : '切換黑底介面'}</button>
        </div>
        <div className="row wrap">
          <span className="lbl">SCENES</span>
          {SCENES.map(([k, l]) => <button key={k} className={`chip ${scene === k ? 'on' : ''}`} onClick={() => { v().goScene(k); setScene(k); if (tool === 'walk') setTool('orbit'); }}>{l}</button>)}
          {viewer.current && viewer.current.floors.length > 0 && <>
            <span className="sep" />
            <span className="lbl">樓層</span>
            {[null, ...viewer.current.floors.map(f => f.key)].map(k => (
              <button key={k || 'all'} className={`chip ${floor === k ? 'on' : ''}`} onClick={() => { v().setFloor(k); setFloor(k); v().goScene(scene === 'hall' ? 'hall' : scene); }}>{k || '整棟'}</button>
            ))}
          </>}
        </div>
      </div>

      <div className="view" ref={viewRef}>
        <div className="labels" ref={labelRef} />
        <Dock tool={tool} section={section.on}
          onTool={chooseTool}
          onUndo={() => v().undo()}
          onSection={() => { const on = !section.on; v().setSection(on, section.h); setSection({ ...section, on }); showToast(on ? `剖面開啟：切在 ${section.h} cm` : '剖面關閉'); }}
          onHome={() => { chooseTool('orbit'); v().goScene('sw'); setScene('sw'); }} />
        {(tool === 'draw' || tool === 'paint' || tool === 'measure' || section.on) && (
          <div className="sub"><div className="subInner">
            {tool === 'draw' && <><span className="t">畫什麼</span>{(Object.keys(DRAW_KINDS) as DrawKind[]).map(k =>
              <button key={k} className={`chip ${drawKind === k ? 'on' : ''}`} onClick={() => { v().drawKind = k; v().drawThick = 0; v().drawH = 0; setDrawKind(k); setDrawThick(''); setDrawH(''); }}>{DRAW_KINDS[k].label}</button>)}
              {DRAW_KINDS[drawKind].thick > 0 && <label className="t">厚度 <input id="draw-thick" type="number" inputMode="numeric" min={3} max={100} placeholder={String(DRAW_KINDS[drawKind].thick)} value={drawThick} style={{ width: 56 }}
                onChange={e => { setDrawThick(e.target.value); v().drawThick = +e.target.value > 0 ? +e.target.value : 0; }} /> cm</label>}
              {drawKind !== 'slab' && <label className="t">高度 <input id="draw-h" type="number" inputMode="numeric" min={10} max={1000} placeholder={String(DRAW_KINDS[drawKind].h)} value={drawH} style={{ width: 60 }}
                onChange={e => { setDrawH(e.target.value); v().drawH = +e.target.value > 0 ? +e.target.value : 0; }} /> cm</label>}</>}
            {tool === 'paint' && <><span className="t">顏色</span>{PALETTE.map(c =>
              <button key={c} className={`sw ${paint === c ? 'on' : ''}`} style={{ background: hex(c) }} aria-label={`顏色 ${hex(c)}`} onClick={() => { v().paintColor = c; setPaint(c); }} />)}</>}
            {tool === 'measure' && <><span className="t">捲尺</span><button className="chip" onClick={() => { v().clearMeasure(); setInfo('量測已清除'); }}>清除量測</button></>}
            {section.on && <><span className="t">剖面高度</span>
              <input id="section-h" type="range" min={20} max={280} step={5} value={section.h} onChange={e => { const h = +e.target.value; v().setSection(true, h); setSection({ on: true, h }); }} />
              <b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{section.h} cm</b></>}
          </div></div>
        )}
        {tool === 'walk' && (
          <div className="pad">
            {['', 'f', '', 'l', 'b', 'r'].map((k, i) => k
              ? <button key={i} className="dbtn" aria-label={{ f: '前進', b: '後退', l: '左移', r: '右移' }[k]}
                  onPointerDown={e => { e.preventDefault(); v().walkKey(k, true); }} onPointerUp={() => v().walkKey(k, false)} onPointerCancel={() => v().walkKey(k, false)} onPointerLeave={() => v().walkKey(k, false)}>
                  {{ f: '▲', b: '▼', l: '◀', r: '▶' }[k]}</button>
              : <span key={i} />)}
          </div>
        )}
        <div className={`toast ${toast.show ? 'show' : ''}`}>{toast.text}</div>
      </div>

      <div className="status">
        <span className="eng">Web 3D Engine</span>
        <span className="info">{loadErr ? `無法開啟專案：${loadErr}` : info}</span>
        <span className="delta">{delta}</span>
      </div>

      {dialog === 'cad' && viewer.current && (
        <CadImport firstId={viewer.current.nextId()} onClose={() => setDialog('none')}
          onSource={f => { store.uploadSource(projectId, f).catch(() => showToast('原始檔上傳失敗，模型仍會儲存')); }}
          onBuilt={r => {
            v().replace(r.objects, r.cad);
            if (!name || name === '匯入圖面') { const n = r.cad.name.replace(/\.(dxf|dwg|skp|dae|obj|glb|gltf|fbx|stl)$/i, ''); setName(n); store.save(projectId, { name: n }).catch(() => {}); }
            setDialog('none');
            setScene('sw');
            setFloor(null);
            showToast(r.summary);
            setInfo(`匯入完成：${r.cad.name}｜範圍 ${Math.round(r.cad.W)} × ${Math.round(r.cad.D)} cm`);
          }} />
      )}
      {dialog === 'takeoff' && viewer.current && (
        <Takeoff takeoff={takeoff()} project={name || '未命名專案'} settings={settings}
          subtitle={`${name}｜${viewer.current.floors.length ? `${viewer.current.floors.length} 層｜` : ''}總面寬 ${Math.round(viewer.current.planBounds.W)} cm × 總進深 ${Math.round(viewer.current.planBounds.D)} cm`}
          onSettings={setSettings}
          onFinish={(room, patch) => setFinishes(f => ({ ...f, [room]: { ...(f[room] || {}), ...patch } }))}
          onClose={() => setDialog('none')} toast={showToast} />
      )}
    </div>
  );
}

