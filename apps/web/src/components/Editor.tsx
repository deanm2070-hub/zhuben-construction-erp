import { loadMaterials } from '../lib/materials';
import { computeBuildingTakeoff, computeTakeoff, DEFAULT_SETTINGS, learnRoles, materialRates, materialsOf, memberOf, MEMBERS, priceBudget, ROLE_NAME, trackFixes, withPricing, type CalcVersion, type DrawingStyle, type Fix, type FinishChoice, type ModelObject, type Pricing, type ProjectInfo, type TakeoffSettings } from '@cloud-modeler/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DRAW_KINDS, FACADE_SCHEMES, TOOL_HINT, Viewer, type DrawKind, type FixKind, type RenderMode, type SceneKey, type Tool } from '../engine/Viewer';
import { download, PROJECT_EXT, projectFile } from '../lib/files';
import { store, type Role } from '../lib/store';
import { isStaleChunk } from '../lib/update';
import { allStyles, mergeStyle, putStyle } from '../lib/styles';
import { BudgetPane } from './BudgetPane';
import { CadImport } from './CadImport';
import { Dock } from './Dock';
import { ImportPane } from './ImportPane';
import { ProjectPane } from './ProjectPane';
import { PropsPanel } from './PropsPanel';
import { ReportPane } from './ReportPane';
import { Stick } from './Stick';
import { Takeoff } from './Takeoff';
import { TrialLock } from './TrialLock';

/** The six parts of a project, in working order. */
export const MODULES = [
  ['import', '圖面匯入', 'DWG／DXF／SKP'],
  ['3d', '3D 模型', '檢視與校正'],
  ['qty', '工程數量', '混凝土、模板、鋼筋…'],
  ['budget', '預算報價', '單價、複價、總價'],
  ['project', '專案管理', '版本、圖檔、成員'],
  ['report', '報表匯出', 'Excel、PDF'],
] as const;
type Module = typeof MODULES[number][0];

const MODES: [RenderMode, string][] = [['mat', '自動渲染'], ['layer', '圖層分色'], ['white', '純白'], ['wire', '線框']];
const SCENES: [SceneKey, string][] = [['front', '正立面'], ['bird', '鳥瞰圖'], ['side', '側向立面']];
const PALETTE = [0xeeebe5, 0xc98a4b, 0x6b4f3a, 0x2f6fd6, 0x41557a, 0x6f7d93, 0x16a34a, 0xdc2626, 0xf5b83d, 0x1d2533];
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
/** sun study dates: the 21st of each month, day of the year */
const SUN_DAYS = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, day: Math.round(i * 30.42 + 21), tag: ({ 3: '春分', 6: '夏至', 9: '秋分', 12: '冬至' } as Record<number, string>)[i + 1] || '' }));
const clock = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export function Editor({ projectId, importNow, trial = false, onExit }: { projectId: string; importNow: boolean; trial?: boolean; onExit: () => void }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [name, setName] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [mode, setMode] = useState<RenderMode>('mat');
  const [tool, setTool] = useState<Tool>('orbit');
  const [scene, setScene] = useState<SceneKey>('bird');
  const [labels, setLabels] = useState(true);
  // section cut: horizontal at a height (0 … top of the building) or vertical at a plan X / Y position, cm
  const [section, setSection] = useState({ on: false, kind: 'h' as 'h' | 'x' | 'z', v: { h: 140, x: 0, z: 0 }, flip: false, ext: { W: 1000, D: 800, top: 300 } });
  const cutSection = (next: Partial<typeof section>) => {
    const s = { ...section, ...next, v: { ...section.v, ...next.v } };
    if (s.on && !next.ext) s.ext = v().sectionExtent();
    v().setSection(s.on, s.v[s.kind], s.kind, s.flip);
    setSection(s);
  };
  const [drawKind, setDrawKind] = useState<DrawKind>('wall');
  const [drawThick, setDrawThick] = useState(''), [drawH, setDrawH] = useState('');
  const [paint, setPaint] = useState(0x2f6fd6);
  const [fixKind, setFixKind] = useState<FixKind>('wall');
  const [finishMat, setFinishMat] = useState('外牆1:3水泥砂漿打底+抿石子');
  const [finishScope, setFinishScope] = useState<'one' | 'plane' | 'all'>('all');
  const [explode, setExplode] = useState(0);
  const [xray, setXray] = useState(false);
  // a phone on its side: the panels above the 3D fold away so the model gets the screen
  const [opts, setOpts] = useState(false);
  // exterior tiles of the rendered look, kept in this browser: auto, a scheme number, or none
  const [facade, setFacade] = useState<string>(() => { try { return localStorage.getItem('zb-facade') || 'auto'; } catch { return 'auto'; } });
  // sun study: date (day of the year), solar hour, plan north turned clockwise (degrees), playing through the day
  const [sun, setSun] = useState({ on: false, day: 172, hour: 10, north: 0, play: false, alt: 0, az: 0 });
  const sunTo = (next: Partial<typeof sun>) => setSun(s => {
    const n = { ...s, ...next };
    const r = v().setSunStudy(n.on ? { day: n.day, hour: n.hour, northDeg: n.north } : null);
    if (r) { n.alt = r.alt; n.az = r.az; }
    return n;
  });
  useEffect(() => {
    if (!sun.play) return;
    const t = window.setInterval(() => sunTo({ hour: sun.hour >= 18.5 ? 5.5 : Math.round((sun.hour + 0.25) * 4) / 4 }), 180);
    return () => clearInterval(t);
  }, [sun.play, sun.hour]); // eslint-disable-line react-hooks/exhaustive-deps
  const [info, setInfo] = useState(TOOL_HINT.orbit);
  const [delta, setDelta] = useState('ΔX 0 · ΔZ 0 cm');
  const [toast, setToast] = useState({ text: '', show: false });
  const [dialog, setDialog] = useState<'none' | 'cad'>(importNow ? 'cad' : 'none');
  const [module, setModule] = useState<Module>(importNow ? 'import' : '3d');
  const [pricing, setPricing] = useState<Pricing>(withPricing());
  const [versions, setVersions] = useState<CalcVersion[]>([]);
  const [pinfo, setPinfo] = useState<ProjectInfo>({});
  const [role, setRole] = useState<Role>('owner');
  const [owner, setOwner] = useState<string | undefined>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<ModelObject | null>(null);
  const readOnly = role === 'viewer';
  const [lock, setLock] = useState(false);
  // the import dialog is for a new project only: a reload (or the 更新 button) must not bring it back over the model
  useEffect(() => { if (importNow) history.replaceState(null, '', `#/p/${projectId}`); }, []);
  const [floor, setFloor] = useState<string | null>(null);
  const [finishes, setFinishes] = useState<Record<string, Partial<FinishChoice>>>({});
  const [settings, setSettings] = useState<TakeoffSettings>(DEFAULT_SETTINGS);
  const [save, setSave] = useState<SaveState>('saved');
  const [rev, bump] = useState(0);
  const toastTimer = useRef<number>();
  const saveTimer = useRef<number>();
  const loaded = useRef(false);
  const meta = useRef({ finishes, settings, pricing, versions, info: pinfo });
  meta.current = { finishes, settings, pricing, versions, info: pinfo };
  const nameRef = useRef(name);
  nameRef.current = name;
  const roRef = useRef(readOnly);
  roRef.current = readOnly;
  // hand corrections of the imported model and the drawing style they teach
  const fixes = useRef<Record<string, Fix>>({});
  const base = useRef(new Map<number, ModelObject>());
  const style = useRef<DrawingStyle | null>(null);
  const snap = (objs: ModelObject[]) => new Map(objs.map(o => [o.id, { ...o } as ModelObject]));
  const learn = useCallback(() => {
    const vw = viewer.current;
    if (!vw || roRef.current) return;
    fixes.current = trackFixes(fixes.current, base.current, vw.objects, vw.cad);
    base.current = snap(vw.objects);
    const st = style.current;
    if (!st) return;
    const { roles, why } = learnRoles(Object.values(fixes.current), vw.objects);
    const before = st.learnt[projectId]?.roles || {};
    const fresh = Object.entries(roles).filter(([l, r]) => before[l] !== r);
    if (!fresh.length && Object.keys(before).length === Object.keys(roles).length) return;
    const next = { ...st, learnt: { ...st.learnt, [projectId]: { roles, why, project: nameRef.current } }, updated: Date.now() };
    style.current = next;
    putStyle(next);
    if (fresh.length) showToast(`已學到：${fresh.map(([l, r]) => `圖層 ${l} 是${ROLE_NAME[r]}`).join('、')}。下次匯入「${next.name}」的圖會自動套用`);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportSkp = async () => {
    try {
      const parts = v().exportParts();
      // the save dialog opens first, then the file is made
      if (await download(`${name || 'model'}.skp`, async () => (await import('../lib/skpExport')).buildSkp(parts), 'application/vnd.sketchup.skp'))
        showToast('已匯出 .skp：每層、每類構件各一個標記（Tag），可在 SketchUp 分開顯示');
    } catch (e) {
      showToast(isStaleChunk(e) ? '網站剛更新到新版本，請按上方「立即更新」（或重新整理）後再匯出' : `匯出 .skp 失敗：${(e as Error).message}`);
    }
  };
  const exportIfc = async () => {
    try {
      const vw = v();
      if (await download(`${name || 'model'}.ifc`, async () => (await import('../lib/ifcExport')).buildIfc(vw.objects, vw.cad, name || '未命名專案'), 'application/x-step'))
        showToast('已匯出 IFC4：每層一個樓層，柱、梁、牆、樓板、門窗各自分類，可在 Revit、ArchiCAD、BIM 檢視器開啟');
    } catch (e) {
      showToast(isStaleChunk(e) ? '網站剛更新到新版本，請按上方「立即更新」（或重新整理）後再匯出' : `匯出 IFC 失敗：${(e as Error).message}`);
    }
  };
  const showToast = useCallback((text: string) => {
    setToast({ text, show: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(t => ({ ...t, show: false })), 2400);
  }, []);

  const persist = useCallback(async (withThumb = false) => {
    const v = viewer.current;
    if (!v || roRef.current) return;
    setSave('saving');
    try {
      await store.save(projectId, {
        ...(nameRef.current ? { name: nameRef.current } : {}),
        model: { objects: v.objects, cad: v.cad, sketch: v.sketch, fixes: fixes.current, ...(style.current ? { style: style.current } : {}), ...meta.current },
        meta: meta.current.info,
        ...(withThumb ? { thumbnail: v.thumbnail() } : {}),
      });
      setSave('saved');
    } catch { setSave('error'); }
  }, [projectId]);
  const scheduleSave = useCallback(() => {
    if (roRef.current) return;
    setSave('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(true), 1500);
  }, [persist]);

  useEffect(() => {
    const v = new Viewer(viewRef.current!, labelRef.current!, {
      info: setInfo,
      toast: showToast,
      delta: (dx, dz) => setDelta(`ΔX ${Math.round(dx)} · ΔZ ${Math.round(dz)} cm`),
      change: () => { learn(); scheduleSave(); bump(n => n + 1); },
      sketch: () => scheduleSave(),
      select: o => setSel(o ? { ...o } : null),
    });
    viewer.current = v;
    v.facade = facade === 'auto' || facade === 'none' ? facade : +facade;
    let alive = true;
    store.load(projectId).then(p => {
      if (!alive) return;
      setName(p.name);
      setFinishes(p.model.finishes || {});
      setSettings({ ...DEFAULT_SETTINGS, ...(p.model.settings || {}), materials: p.model.settings?.materials ?? loadMaterials() });
      setPricing(withPricing(p.model.pricing));
      setVersions(p.model.versions || []);
      setPinfo({ ...(p.model.info || {}), ...(p.meta || {}) });
      setOwner(p.owner);
      store.role(p).then(r => { if (alive) setRole(r); }).catch(() => {});
      fixes.current = p.model.fixes || {};
      base.current = snap(p.model.objects || []);
      if (p.model.style) { mergeStyle(p.model.style); style.current = allStyles().find(x => x.id === p.model.style!.id) || p.model.style; }
      v.load(p.model.objects || [], p.model.cad || null);
      v.setSketch(p.model.sketch || []);
      setFloor(null);
      bump(n => n + 1);
      setTimeout(() => { loaded.current = true; }, 0);
    }).catch(e => setLoadErr(String(e.message || e)));
    return () => { alive = false; v.dispose(); viewer.current = null; };
  }, [projectId, showToast, scheduleSave, learn]);

  // save on leave
  // Ctrl+S saves now; closing the page with unsaved changes asks first
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); persist(true).then(() => showToast(store.cloud ? '已存到雲端' : '已存在這個瀏覽器')); } };
    const b = (e: BeforeUnloadEvent) => { if (save !== 'saved') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', k); window.addEventListener('beforeunload', b);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('beforeunload', b); };
  }, [persist, save, showToast]);
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); persist(true); } }, [persist]);
  useEffect(() => { if (loaded.current) scheduleSave(); }, [finishes, settings, pricing, versions, pinfo, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = () => viewer.current!;
  const chooseTool = (t: Tool) => { v().setTool(t); setTool(t); };
  const toggleTheme = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    v().themeChanged();
    bump(n => n + 1);
  };

  const takeoffNow = () => {
    const vw = v();
    if (vw.cad?.floors?.length) return computeBuildingTakeoff(vw.objects, vw.cad, finishes, settings);
    return computeTakeoff({
      objects: vw.objects, bounds: vw.planBounds, labels: vw.roomLabels(), rects: vw.roomRects,
      cadDoors: vw.cad?.doors, finishes, settings,
    });
  };

  // quantities and prices are worked out only for the panes that show them, again after every model change
  const needQty = module !== '3d' && module !== 'import' && !!viewer.current;
  const t = useMemo(() => needQty ? takeoffNow() : null, [needQty, rev, finishes, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const mats = useMemo(() => materialsOf(settings.materials), [settings.materials]);
  const pb = useMemo(() => t ? priceBudget(t.budget, pricing, materialRates(mats)) : null, [t, pricing, mats]);
  useEffect(() => { const vw = viewer.current; if (vw) vw.setMaterials(mats); }, [mats]);
  const present = useMemo(() => new Set((viewer.current?.objects || []).map(memberOf)), [rev, module]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (module !== '3d') viewer.current?.selectId(null); }, [module]);
  const toggleKind = (k: string) => { const n = new Set(hidden); if (n.has(k)) n.delete(k); else n.add(k); setHidden(n); v().setHidden(n); };
  const subtitle = viewer.current ? `${name}｜${viewer.current.floors.length ? `${viewer.current.floors.length} 層｜` : ''}總面寬 ${Math.round(viewer.current.planBounds.W)} cm × 總進深 ${Math.round(viewer.current.planBounds.D)} cm` : '';

  const darkNow = typeof window !== 'undefined' && getComputedStyle(document.documentElement).colorScheme.includes('dark');
  const saveLabel = readOnly ? '只能檢視（不會存檔）' : { saved: store.cloud ? '已存到雲端' : '已存在本機', dirty: '尚未儲存', saving: '儲存中…', error: '儲存失敗，稍後重試' }[save];

  return (
    <div className="app">
      <div className={`bars ${opts ? 'open' : ''}`}>
        <div className="row">
          <button className="chip ghost" onClick={async () => { if (save !== 'saved') await persist(true); onExit(); }}>← 專案</button>
          <span className="brand title" title={name}>{name}</span>
          <span className="save" role="status">{saveLabel}</span>
          <button className="chip optT" aria-expanded={opts} onClick={() => setOpts(!opts)}>{opts ? '收合 ▴' : '選項 ▾'}</button>
          {!readOnly && <button className="chip key" onClick={async () => { await persist(true); showToast(store.cloud ? '已存到雲端' : '已存在這個瀏覽器'); }}>儲存</button>}
          <button className="chip hideSm" onClick={() => { const v = viewer.current; if (!v) return; download(`${name || '專案'}${PROJECT_EXT}`, projectFile(name || '未命名專案', { objects: v.objects, cad: v.cad, sketch: v.sketch, ...meta.current }), 'application/json'); showToast('已存成檔案，可在「我的專案」用「開啟專案檔」讀回'); }}>存成檔案</button>
          <button className="chip ghost hideSm" onClick={toggleTheme}>{darkNow ? '白底' : '黑底'}</button>
        </div>
        <nav className="modules" aria-label="功能">
          {MODULES.map(([k, l, d], i) => (
            <button key={k} className={`mod ${module === k ? 'on' : ''}`} aria-current={module === k ? 'page' : undefined} onClick={e => { setModule(k); e.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }}>
              <i>{i + 1}</i><span><b>{l}</b><small>{d}</small></span>
            </button>
          ))}
        </nav>
        {module === '3d' && <div className="ctl">
          <div className="ctlRow">
            <span className="lbl">顯示</span>
            <div className="seg" role="group" aria-label="顯示方式">
              {MODES.map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} aria-pressed={mode === k} onClick={() => { v().setMode(k); setMode(k); }}>{l}</button>)}
            </div>
            {mode === 'mat' && <select className="chip sm" aria-label="外牆二丁掛配色" title="自動渲染時外牆貼二丁掛的顏色" value={facade}
              onChange={e => { const f = e.target.value; setFacade(f); try { localStorage.setItem('zb-facade', f); } catch { /* private window */ } v().setFacade(f === 'auto' || f === 'none' ? f : +f); }}>
              <option value="auto">外牆二丁掛：自動配色</option>
              {FACADE_SCHEMES.map((x, i) => <option key={i} value={i}>外牆二丁掛：{x.name}</option>)}
              <option value="none">外牆不貼磚</option>
            </select>}
          </div>
          <div className="ctlRow">
            <span className="lbl">視角</span>
            <div className="seg" role="group" aria-label="視角">
              {SCENES.map(([k, l]) => <button key={k} className={scene === k ? 'on' : ''} aria-pressed={scene === k} onClick={() => { v().goScene(k); setScene(k); if (tool === 'walk') setTool('orbit'); }}>{l}</button>)}
            </div>
          </div>
          {viewer.current && viewer.current.floors.length > 0 && <div className="ctlRow">
            <span className="lbl">樓層</span>
            <div className="seg" role="group" aria-label="樓層">
              {[null, ...viewer.current.floors.map(f => f.key)].map(k => (
                <button key={k || 'all'} className={floor === k ? 'on' : ''} aria-pressed={floor === k} onClick={() => { v().setFloor(k); setFloor(k); if (tool !== 'walk') v().goScene(scene); }}>{k || '整棟'}</button>
              ))}
            </div>
            {!floor && viewer.current.floors.length > 1 && <>
              <button className={`chip sm ${explode ? 'on' : ''}`} aria-pressed={!!explode} title="各樓層上下拉開，看每層的構件"
                onClick={() => { const g = explode ? 0 : 300; v().setExplode(g); setExplode(g); if (g) { v().goScene('bird'); setScene('bird'); } }}>分層展開</button>
              {explode > 0 && <input id="explode-gap" type="range" min={50} max={1000} step={10} value={explode} aria-label="樓層間距" style={{ width: 110 }}
                onChange={e => { v().setExplode(+e.target.value); setExplode(+e.target.value); }} />}
            </>}
          </div>}
          <div className="ctlRow">
            {present.size > 1 && <><span className="lbl">構件</span>
            <div className="pills">
              {MEMBERS.filter(k => present.has(k)).map(k => <button key={k} className={hidden.has(k) ? '' : 'on'} aria-pressed={!hidden.has(k)} onClick={() => toggleKind(k)}>{hidden.has(k) ? '' : '✓ '}{k}</button>)}
              {hidden.size > 0 && <button className="all" onClick={() => { setHidden(new Set()); v().setHidden([]); }}>全部顯示</button>}
            </div></>}
            <span className="grow" />
            <button className={`chip sm ${xray ? 'on' : ''}`} aria-pressed={xray} title="柱、梁、基礎實體上色，其他構件半透明"
              onClick={() => { v().setXray(!xray); setXray(!xray); showToast(xray ? '結構透視關閉' : '結構透視：柱（藍）梁（橘）基礎（棕），其他半透明'); }}>結構透視</button>
            <button className={`chip sm ${sun.on ? 'on' : ''}`} aria-pressed={sun.on} title="依日期與時間模擬日照與陰影"
              onClick={() => { const on = !sun.on; if (on && mode !== 'mat') { v().setMode('mat'); setMode('mat'); } sunTo({ on, play: false }); }}>日照</button>
            <button className={`chip sm ${labels ? 'on' : ''}`} aria-pressed={labels} onClick={() => { v().setShowLabels(!labels); setLabels(!labels); }}>標籤</button>
            <details className="menu">
              <summary className="chip sm">匯出 ▾</summary>
              <div className="menuPop" onClick={e => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
                <button onClick={exportSkp}>SketchUp 檔（.skp）</button>
                <button onClick={exportIfc}>BIM 檔（IFC4 .ifc）</button>
                <button onClick={() => download(`${name || 'model'}.obj`, v().exportOBJ(name), 'text/plain')}>OBJ 檔（.obj）</button>
              </div>
            </details>
          </div>
        </div>}
      </div>

      <div className="view" ref={viewRef}>
        <div className="labels" ref={labelRef} />
        {module === '3d' && !readOnly && <Dock tool={tool} section={section.on}
          onTool={chooseTool}
          onUndo={() => v().undo()}
          onSection={() => {
            const on = !section.on, ext = v().sectionExtent();
            // a fresh cut: 1.4 m above the storey shown, through the middle of the plan
            const fresh = { h: Math.min(ext.top, (v().floors.find(f => f.key === floor)?.y || 0) + 140), x: Math.round(ext.W / 2), z: Math.round(ext.D / 2) };
            cutSection({ on, ext, v: on ? fresh : section.v });
            showToast(on ? '剖面開啟：可選水平或垂直剖面，拖曳滑桿移動切面' : '剖面關閉');
          }}
          onHome={() => { chooseTool('orbit'); v().goScene('bird'); setScene('bird'); }} />}
        {module === '3d' && (tool === 'draw' || tool === 'paint' || tool === 'finish' || tool === 'measure' || tool === 'fix' || section.on || sun.on) && (
          <div className="sub"><div className="subInner">
            {tool === 'draw' && <><span className="t">畫什麼</span>{(Object.keys(DRAW_KINDS) as DrawKind[]).map(k =>
              <button key={k} className={`chip ${drawKind === k ? 'on' : ''}`} onClick={() => { v().drawKind = k; v().drawThick = 0; v().drawH = 0; setDrawKind(k); setDrawThick(''); setDrawH(''); }}>{DRAW_KINDS[k].label}</button>)}
              {DRAW_KINDS[drawKind].thick > 0 && <label className="t">厚度 <input id="draw-thick" type="number" inputMode="numeric" min={3} max={100} placeholder={String(DRAW_KINDS[drawKind].thick)} value={drawThick} style={{ width: 56 }}
                onChange={e => { setDrawThick(e.target.value); v().drawThick = +e.target.value > 0 ? +e.target.value : 0; }} /> cm</label>}
              {drawKind !== 'slab' && <label className="t">高度 <input id="draw-h" type="number" inputMode="numeric" min={10} max={1000} placeholder={String(DRAW_KINDS[drawKind].h)} value={drawH} style={{ width: 60 }}
                onChange={e => { setDrawH(e.target.value); v().drawH = +e.target.value > 0 ? +e.target.value : 0; }} /> cm</label>}</>}
            {tool === 'paint' && <><span className="t">顏色</span>{PALETTE.map(c =>
              <button key={c} className={`sw ${paint === c ? 'on' : ''}`} style={{ background: hex(c) }} aria-label={`顏色 ${hex(c)}`} onClick={() => { v().paintColor = c; setPaint(c); }} />)}</>}
            {tool === 'finish' && <><span className="t">材質</span>
              <select id="finish-mat" aria-label="材質" value={finishMat} onChange={e => { v().finishMat = e.target.value; setFinishMat(e.target.value); }}>
                {mats.filter(m => (m.use === 'ext' || m.use === 'wall') && !m.hidden).map(m => <option key={m.name} value={m.name}>{m.name.replace(/^外牆1:3水泥砂漿打底\+/, '外牆 ')}</option>)}
                <option value="">清除指定（回到預設）</option>
              </select>
              <span className="t">套用到</span>
              {([['one', '單一構件'], ['plane', '同一平面（本層）'], ['all', '同一平面（全部樓層）']] as const).map(([k, l]) =>
                <button key={k} className={`chip ${finishScope === k ? 'on' : ''}`} onClick={() => { v().finishScope = k; setFinishScope(k); }}>{l}</button>)}
              <span className="t">點牆的一個面</span></>}
            {tool === 'fix' && <><span className="t">補什麼</span>
              {([['wall', '柱間補牆'], ['slab', '點房間補樓板']] as const).map(([k, l]) =>
                <button key={k} className={`chip ${fixKind === k ? 'on' : ''}`} onClick={() => { v().fixKind = k; v().setTool('fix'); setFixKind(k); }}>{l}</button>)}
              <span className="t">{fixKind === 'wall' ? '依序點兩根柱（或牆端）' : floor ? `點 ${floor} 的房間地面` : '先在「樓層」選一層'}</span></>}
            {sun.on && <><span className="t">日照</span>
              <select id="sun-day" aria-label="日期" value={sun.day} onChange={e => sunTo({ day: +e.target.value })}>
                {SUN_DAYS.map(d => <option key={d.m} value={d.day}>{d.m}月21日{d.tag && ` ${d.tag}`}</option>)}
              </select>
              <input id="sun-hour" type="range" min={5} max={19} step={0.25} value={sun.hour} aria-label="時間" style={{ width: 130 }} onChange={e => sunTo({ hour: +e.target.value, play: false })} />
              <b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{clock(sun.hour)}</b>
              <button className={`chip ${sun.play ? 'on' : ''}`} onClick={() => sunTo({ play: !sun.play })}>{sun.play ? '❚❚ 暫停' : '▶ 播放一天'}</button>
              <label className="t">北方 <input id="sun-north" type="number" inputMode="numeric" min={-180} max={180} step={5} value={sun.north} style={{ width: 52 }} onChange={e => sunTo({ north: +e.target.value || 0 })} />°</label>
              <span className="t">{sun.alt > 0 ? `太陽高度 ${sun.alt.toFixed(0)}°｜方位 ${sun.az.toFixed(0)}°` : '太陽在地平線下'}</span></>}
            {tool === 'measure' && <><span className="t">捲尺</span><button className="chip" onClick={() => { v().clearMeasure(); setInfo('量測已清除'); }}>清除量測</button></>}
            {section.on && <><span className="t">剖面</span>
              {([['h', '水平'], ['x', '垂直 X'], ['z', '垂直 Y']] as const).map(([k, l]) =>
                <button key={k} className={`chip ${section.kind === k ? 'on' : ''}`} onClick={() => cutSection({ kind: k })}>{l}</button>)}
              {(() => {
                const max = section.kind === 'h' ? section.ext.top : section.kind === 'x' ? section.ext.W : section.ext.D, val = section.v[section.kind];
                return <><input id="section-v" type="range" min={0} max={Math.max(1, Math.round(max))} step={5} value={Math.min(val, max)} aria-label={section.kind === 'h' ? '剖面高度' : '剖面位置'}
                    onChange={e => cutSection({ v: { [section.kind]: +e.target.value } as typeof section.v })} />
                  <b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{section.kind === 'h' ? '高' : section.kind === 'x' ? 'X' : 'Y'} {(val / 100).toFixed(2)} / {(max / 100).toFixed(2)} m</b>
                  {section.kind !== 'h' && <button className={`chip ${section.flip ? 'on' : ''}`} onClick={() => cutSection({ flip: !section.flip })}>看另一側</button>}</>;
              })()}</>}
          </div></div>
        )}
        {module === '3d' && tool === 'walk' && <Stick onMove={(x, y) => v().walkStick(x, y)} />}
        {module === '3d' && sel && viewer.current && (
          <PropsPanel o={sel} floors={viewer.current.floors} readOnly={readOnly}
            onApply={patch => { const renamed = patch.name && patch.name !== sel.name; v().updateObject(sel.id, patch); showToast(renamed ? `已套用，名稱改為「${patch.name}」` : '已套用，數量會依新尺寸重算'); }}
            onDelete={() => { v().deleteSelected(); }}
            onClose={() => v().selectId(null)} />
        )}
        {module !== '3d' && viewer.current && <div className="paneWrap">
          {module === 'import' && <ImportPane cad={viewer.current.cad} objects={viewer.current.objects} readOnly={readOnly}
            trial={trial} onLocked={() => setLock(true)}
            onImport={() => trial ? setLock(true) : setDialog('cad')} onTo3d={() => setModule('3d')} />}
          {module === 'qty' && t && pb && <Takeoff takeoff={t} pb={pb} pricing={pricing} project={name || '未命名專案'} settings={settings} readOnly={readOnly}
            subtitle={subtitle}
            onSettings={setSettings}
            onPricing={setPricing}
            onFinish={(room, patch) => setFinishes(f => ({ ...f, [room]: { ...(f[room] || {}), ...patch } }))}
            toast={showToast} />}
          {module === 'budget' && t && pb && <BudgetPane t={t} pb={pb} pricing={pricing} project={name || '未命名專案'} projectId={projectId} readOnly={readOnly} onPricing={setPricing} toast={showToast} />}
          {module === 'project' && t && pb && <ProjectPane projectId={projectId} owner={owner} name={name} role={role} info={pinfo} versions={versions} pb={pb} floorArea={t.floorArea}
            learning={{ fixes: { del: Object.values(fixes.current).filter(f => f.kind === 'del').length, type: Object.values(fixes.current).filter(f => f.kind === 'type').length, add: Object.values(fixes.current).filter(f => f.kind === 'add').length },
              style: style.current?.name, rules: Object.entries(style.current?.learnt[projectId]?.roles || {}).map(([l, r]) => `圖層 ${l} → ${ROLE_NAME[r]}（${style.current!.learnt[projectId].why[l]}）`) }}
            onName={setName} onInfo={setPinfo} onVersions={setVersions} toast={showToast} />}
          {module === 'report' && t && pb && <ReportPane ctx={{ project: name || '未命名專案', t, pb, pricing, info: pinfo }} toast={showToast} />}
        </div>}
        <div className={`toast ${toast.show ? 'show' : ''}`}>{toast.text}</div>
      </div>

      <div className="status">
        <span className="eng">Web 3D Engine</span>
        <span className="info">{loadErr ? `無法開啟專案：${loadErr}` : info}</span>
        <span className="delta">{delta}</span>
      </div>

      {lock && <TrialLock onClose={() => setLock(false)} />}
      {dialog === 'cad' && !trial && viewer.current && (
        <CadImport firstId={viewer.current.nextId()} onClose={() => setDialog('none')}
          onSource={f => { store.uploadSource(projectId, f).catch(() => showToast('原始檔上傳失敗，模型仍會儲存')); }}
          onBuilt={r => {
            fixes.current = {}; base.current = snap(r.objects); style.current = r.style || null;
            v().replace(r.objects, r.cad);
            if (!name || name === '匯入圖面') { const n = r.cad.name.replace(/\.(dxf|dwg|skp|dae|obj|glb|gltf|fbx|stl)$/i, ''); setName(n); store.save(projectId, { name: n }).catch(() => {}); }
            setDialog('none');
            setModule('3d');
            setScene('bird');
            setFloor(null);
            showToast(r.summary);
            setInfo(`匯入完成：${r.cad.name}｜範圍 ${Math.round(r.cad.W)} × ${Math.round(r.cad.D)} cm`);
          }} />
      )}
    </div>
  );
}

