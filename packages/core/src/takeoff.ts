import { computeFormwork, type FormworkReport } from './formwork';
import { BUDGET_TEMPLATE, covers, type TemplateItem } from './budgetTemplate';
import { materialFor, materialItems, materialsOf, sectionOf } from './materials';
import { computeRebar, type RebarKind, type RebarRow } from './rebar';
import { formworkPlans, masonPlans, type PlanSheet } from './reportPlan';
import { roomMap, type RoomLabel, type RoomStat } from './rooms';
import { WALL_H } from './sample';
import { isBox, isDoor, type BoxObject, type Bounds, type CadData, type CadDoor, type DoorObject, type FinishChoice, type ModelObject, type RoomRect, type TakeoffSettings } from './types';

export const PING = 3.3058;
export const FINISHES = {
  f: { F1: '地坪整體粉光+金鋼砂', F2A: '地坪1:3水泥砂漿打底+80*80cm拋光石英磚', F2B: '樓梯地坪1:3水泥砂漿打底+80*80cm拋光石英磚', F4: '地坪1:3水泥砂漿打底+30*30cm地磚', F5: '地坪1:2防水水泥砂漿打底+30*30cm止滑地磚', '-': '不施作' },
  c: { C1: '平頂明架石膏板天花', C2: '平頂PVC企口天花板', '-': '不施作' },
  w: { W1A: '內牆1:3水泥粉光+水泥漆(綠建材)', W1B: '內牆矽酸鈣板批土整平+水泥漆(綠建材)', W2: '內牆防水打底+貼30*60cm磁磚', '-': '不施作' },
} as const;
export const FINISH_SHORT: Record<string, string> = { F1: '粉光金鋼砂', F2A: '拋光石英磚', F2B: '樓梯石英磚', F4: '地磚', F5: '止滑地磚', C1: '石膏板天花', C2: 'PVC天花', W1A: '水泥粉光＋漆', W1B: '矽酸鈣板＋漆', W2: '防水＋磁磚' };
export const EXT_FINISHES = ['外牆1:3水泥砂漿打底+抿石子', '外牆1:3水泥砂漿打底+水泥漆', '外牆複合式鍍鋁鋅彩色鋼板', '外牆企口型金屬飾板', '外牆1:3水泥砂漿打底+二丁掛'];
/** an exterior finish on the budget without its base coat: 外牆1:3水泥砂漿打底+二丁掛 → 外牆二丁掛 (the base coat is its own line) */
export const extFinishName = (name: string) => name.replace(/^外牆1:3水泥砂漿打底\+/, '外牆');
/** whether a finish goes on a 1:3 mortar base coat: as set in the 建材項目 list, else read from the name (not stone or cladding) */
export function needsBase(name: string, mats: { name: string; base?: boolean }[] = []) {
  const m = mats.find(x => x.name === name);
  if (m?.base != null) return m.base;
  return /1:3水泥砂漿打底/.test(name) && !/石材|乾掛|鋼板|金屬/.test(name);
}
/** finishes that can be put on single faces in the 3D model (材質 tool) */
export const FACE_FINISHES = [...EXT_FINISHES, '內牆1:3水泥粉光+水泥漆(綠建材)', '內牆貼30*60cm磁磚', '內牆矽酸鈣板批土整平+水泥漆(綠建材)'];
export const DEFAULT_SETTINGS: TakeoffSettings = { ext: 4, floor: '1F', slab: 15, rebar: 120 };

/** Finish codes picked from the room name. */
export function defaultFinish(name: string): FinishChoice {
  if (/廁|浴|洗手|衛|茶水|廚|Kitchen/i.test(name)) return { f: 'F5', c: 'C2', w: 'W2' };
  if (/天井|雨遮|遮陽|頂蓋|水塔|透空|管道|挑空|梯井|未標示/.test(name)) return { f: '-', c: '-', w: '-' };
  if (/陽台|露台|平台|外廊|騎樓/.test(name)) return { f: 'F4', c: '-', w: '-' };
  if (/樓梯|安全梯|梯間/.test(name)) return { f: 'F2B', c: '-', w: 'W1B' };
  if (/廠房|作業|倉|儲|機房|車庫|收納/.test(name)) return { f: 'F1', c: '-', w: 'W1A' };
  return { f: 'F2A', c: 'C1', w: 'W1A' };
}

export type Facade = '北向' | '東向' | '南向' | '西向';
/** Which way an exterior wall piece faces, judged from the plan centre (north is the top). */
export function facadeOf(o: BoxObject, cx: number, cz: number): Facade {
  const r = o.rot || 0, along = o.w >= o.d;
  let nx = along ? Math.sin(r) : Math.cos(r), nz = along ? Math.cos(r) : -Math.sin(r);
  if ((o.x - cx) * nx + (o.z - cz) * nz < 0) { nx = -nx; nz = -nz; }
  return Math.abs(nz) >= Math.abs(nx) ? (nz < 0 ? '北向' : '南向') : (nx < 0 ? '西向' : '東向');
}

export interface FinishRow { fl: string; name: string; q: number }
export interface FinishGroup { title: string; unit: 'M2' | 'M'; rows: FinishRow[]; total: number }
/** tpl: a 報價單 template item the model gives no quantity for (q 0), to be filled in by hand */
export interface BudgetLine { sec?: string; i?: number; name?: string; unit?: string; q?: number | string; note?: string; tpl?: boolean }
/** One line of the quantity calculation sheet: which item, where, and how it was worked out. */
export interface CalcRow { sec: string; item: string; unit: string; fl: string; where: string; expr: string; q: number }
export interface RoomWithFinish extends RoomStat { fl: string; fin: FinishChoice }
export interface Takeoff {
  budget: BudgetLine[]; groups: FinishGroup[]; rooms: RoomWithFinish[]; calc: CalcRow[]; floorArea: number; wallH: number;
  /** area of the floor slabs (ground slab and floors, not the roof), ㎡ */
  slabArea?: number;
  /** the rooms of each storey as rows of 20 cm cells [z, x0, x1], for the plan drawings of the reports */
  roomRuns?: { fl: string; name: string; runs: number[][] }[];
  /** plan drawings that show where each line of the formwork and mason reports sits */
  plans?: { formwork: PlanSheet[]; mason: PlanSheet[] };
  /** bar list from the reinforcement drawings, and the members whose schedule was not found */
  rebar?: { rows: RebarRow[]; missing: string[]; standard?: string[] };
  /** 模板報表 by slab panel (whole-building imports) */
  formwork?: FormworkReport;
}

export interface TakeoffInput {
  objects: ModelObject[];
  bounds: Bounds;
  labels: RoomLabel[];
  /** known room rectangles (sample plan); omit for imported drawings */
  rects?: RoomRect[];
  cadDoors?: CadDoor[];
  finishes: Record<string, Partial<FinishChoice>>;
  settings: TakeoffSettings;
  /** leave the rebar out (a storey of a whole building, whose bar list is worked out for the building) */
  noRebar?: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** a length in cm written in metres for a formula, e.g. 0.2 or 4.2 */
const m = (cm: number) => String(r2(cm / 100));
/** names given to openings matched to a door / window schedule, e.g. "D1 木門 90×210" */
const SCHED = /^([A-Z]{1,3}\d{0,3}[A-Z]?) (\S+) ([\d.]+)×([\d.]+)$/;
const schedKey = (name: string) => { const m = SCHED.exec(name); return m ? `${m[1]} ${m[2]} ${m[3]}*${m[4]}` : null; };
const FACADES: Facade[] = ['北向', '東向', '南向', '西向'];

export const SEC = {
  temp: '一、假設工程', site: '二、放樣.土方及搭架工程', rc: '三、結構體工程', finish: '四、泥作.裝修工程', water: '五、防水工程',
  open: '六、門窗工程', misc: '七、雜項工程', road: '八、道路排水溝及圍牆工程', bath: '九、衛浴設備', steel: '十、鋼架工程',
  mep: '十一、水電.弱電.消防工程（依樓地板面積估算）', other: '其他（自訂工項）',
};
const SEC_ORDER = Object.values(SEC);
export const CONCRETE = '4000PSI 預拌混凝土', FORMWORK = '一般模板組立及損耗';

/** Plan pieces of a model: columns are short thick boxes, RC walls are 18 cm or thicker. */
const isColumn = (o: BoxObject) => !o.rot && Math.min(o.w, o.d) >= 30 && Math.max(o.w, o.d) <= Math.min(o.w, o.d) * 2.5 && o.y === 0 && o.h >= 200;

export function computeTakeoff(inp: TakeoffInput): Takeoff {
  const { objects, bounds, settings: S } = inp;
  const fl = S.floor;
  const cx = bounds.W / 2, cz = bounds.D / 2;
  const boxes = objects.filter(isBox);
  // a site wall (圍牆) is priced under 道路排水溝及圍牆, not with the building's walls
  const fences = boxes.filter(o => o.layer === 'wall' && o.h > 0 && /^圍牆/.test(o.name));
  const walls = boxes.filter(o => o.layer === 'wall' && o.h > 0 && !fences.includes(o));
  // concrete walls: by line colour when the plans give one (same colour as the exterior wall), else by name and thickness
  // a concrete wall is at least 12 cm thick: thinner pairs of lines in the exterior-wall colour are finishes or partitions
  const isExt = (o: BoxObject) => o.wall ? o.wall === 'rc' && Math.min(o.w, o.d) >= 12 : /外牆|窗台|窗楣|女兒牆/.test(o.name) || Math.min(o.w, o.d) >= 18;
  const len = (o: BoxObject) => Math.max(o.w, o.d) / 100;
  const sum = <T>(a: T[], f: (o: T) => number) => a.reduce((s, o) => s + f(o), 0);
  const full = walls.filter(o => o.y === 0 && o.h >= 200);
  const H = full.length ? Math.max(...full.map(o => o.h)) : WALL_H;
  // columns from the structural plans carry their mark and size; the drawn ones are guessed by shape
  const tagged = walls.filter(o => o.rc?.kind === 'column');
  const cols = tagged.length ? tagged : walls.filter(isColumn);
  const rcWalls = walls.filter(o => isExt(o) && !o.rc && (tagged.length > 0 || !isColumn(o)));
  // interior concrete walls carry no facade finish
  const ext = rcWalls.filter(o => !(o.wall === 'rc' && /^RC牆/.test(o.name))), int = full.filter(o => !isExt(o) && !o.rc);
  // a light partition over a door (and under a window in one) is part of the partition
  const intFill = walls.filter(o => !isExt(o) && !o.rc && !full.includes(o) && /^輕隔間(門楣|牆下)/.test(o.name));
  const slabs = boxes.filter(o => o.layer === 'slab' && !/梁|屋簷|PC墊層/.test(o.name)), eaves = boxes.filter(o => o.layer === 'slab' && /屋簷/.test(o.name));
  const blinding = boxes.filter(o => o.layer === 'slab' && /PC墊層/.test(o.name));
  const railings = boxes.filter(o => /欄杆/.test(o.name) && (o.layer === 'glass' || o.layer === 'rail'));
  const map = roomMap(objects, bounds, inp.labels, inp.rects);
  const rooms: RoomWithFinish[] = map.rooms.map(r => ({ ...r, fl, fin: { ...defaultFinish(r.name), ...(inp.finishes[r.name] || {}) } }));
  const floorArea = sum(rooms.filter(r => r.fin.f !== '-'), r => r.area);

  const doors = objects.filter(isDoor).map(o => ({ w: o.b - o.a, h: o.h || 210, ext: /大門|捲門/.test(o.name), name: o.name, o }))
    .concat((inp.cadDoors || []).map(d => ({ w: d.w, h: 210, name: '', ext: d.x < 30 || d.z < 30 || d.x > bounds.W - 30 || d.z > bounds.D - 30, o: null as unknown as DoorObject })));
  const wins = boxes.filter(o => o.layer === 'glass' && !/欄杆/.test(o.name) && (o.y > 0 || SCHED.test(o.name))).map(o => ({ w: Math.max(o.w, o.d), h: o.h, o }));
  const winArea = sum(wins, w => w.w * w.h / 1e4);

  const calc: CalcRow[] = [];
  const row = (sec: string, item: string, unit: string, where: string, expr: string, q: number) => { if (q > 0) calc.push({ sec, item, unit, fl, where, expr, q: r2(q) }); };

  // windows belong to the rooms on either side of them
  const winsOf = new Map<string, { a: number; n: number }>();
  for (const w of wins) {
    const along = w.o.w >= w.o.d, off = Math.min(w.o.w, w.o.d) / 2 + 20;
    for (const s of [-1, 1]) {
      const name = map.at(w.o.x + (along ? 0 : s * off), w.o.z + (along ? s * off : 0));
      if (!name) continue;
      const cur = winsOf.get(name) || { a: 0, n: 0 };
      cur.a += w.w * w.h / 1e4; cur.n++;
      winsOf.set(name, cur);
    }
  }

  const groups = new Map<string, FinishGroup>();
  const strip = (t: string) => t.replace(/^\([^)]*\)/, '');
  const add = (title: string, unit: 'M2' | 'M', name: string, q: number, expr: string, sec: string = /防水處理/.test(title) ? SEC.water : SEC.finish) => {
    if (q <= 0) return;
    if (!groups.has(title)) groups.set(title, { title, unit, rows: [], total: 0 });
    groups.get(title)!.rows.push({ fl, name, q: r2(q) });
    row(sec, strip(title), unit === 'M2' ? '㎡' : 'M', name, expr, q);
  };
  const clear = Math.max(100, H - S.slab);
  /* ceiling beams: the soffit and both sides of the part not sitting on a wall belong to the room under it;
     the deepest beam along a room's edge sets where its wall tiles stop */
  const ceilBeams = boxes.filter(o => /梁/.test(o.name) && !/^地梁/.test(o.name) && o.y > 0 && o.y + o.h >= H - 30);
  const beamOf = new Map<string, { a: number; L: number; parts: Set<string> }>(), deepOf = new Map<string, number>();
  const inBox = (o: BoxObject, x: number, z: number, e = 1) => Math.abs(x - o.x) <= o.w / 2 + e && Math.abs(z - o.z) <= o.d / 2 + e;
  for (const o of ceilBeams) {
    const along = o.w >= o.d, L = Math.max(o.w, o.d), b = Math.min(o.w, o.d), hs = Math.max(0, o.h - S.slab), n = Math.max(1, Math.ceil(L / 25));
    const under = walls.filter(w => w.y < o.y && w.y + w.h >= o.y - 5 && !w.rot);
    for (let i = 0; i < n; i++) {
      const t = -L / 2 + (i + 0.5) * L / n, x = o.rot ? o.x : o.x + (along ? t : 0), z = o.rot ? o.z : o.z + (along ? 0 : t);
      for (const s of [-1, 0, 1]) {
        const off = s * (b / 2 + 20), name = map.at(x + (along ? 0 : off), z + (along ? off : 0));
        if (name) deepOf.set(name, Math.max(deepOf.get(name) || 0, o.h));
      }
      if (under.some(w => inBox(w, x, z))) continue;
      const name = map.at(x, z);
      if (!name) continue;
      const cur = beamOf.get(name) || { a: 0, L: 0, parts: new Set<string>() };
      cur.a += L / n * (b + 2 * hs) / 1e4; cur.L += L / n / 100; cur.parts.add(`${m(b)}+2×${m(hs)}`);
      beamOf.set(name, cur);
    }
  }
  const beamRow = (r: RoomWithFinish) => {
    // rooms that share a label share one map entry: count its beams once
    const bm = beamOf.get(r.name);
    beamOf.delete(r.name);
    return bm && bm.a > 0 ? { a: bm.a, expr: `梁底＋梁側：梁長 ${r2(bm.L)} m × (底寬 + 2 側 × 梁深扣板厚) ${[...bm.parts].join('、')} m` } : null;
  };
  const wetH = S.wetH ?? 200, mats = materialsOf(S.materials);
  const extName = S.extName || EXT_FINISHES[S.ext] || EXT_FINISHES[4];
  for (const r of rooms) {
    const { f, c, w } = r.fin;
    const win = winsOf.get(r.name), wa = win?.a || 0;
    const wallA = Math.max(0, r.perim * clear / 100 - wa);
    const wallExpr = `周長 ${r2(r.perim)} m × 淨高 ${m(clear)} m${wa ? ` − 窗 ${win!.n} 樘 ${r2(wa)} ㎡` : ''}`;
    const area = `面積 ${r2(r.area)} ㎡`;
    const F = FINISHES.f as Record<string, string>, Cc = FINISHES.c as Record<string, string>, Wd = FINISHES.w as Record<string, string>;
    const bm = beamRow(r);
    // finishes of the 建材項目 list go under their own name and section
    const ownF = f !== '-' && !F[f] ? materialFor(mats, 'floor', f) : undefined, ownC = c !== '-' && !Cc[c] ? materialFor(mats, 'ceil', c) : undefined;
    const ownW = w !== '-' && !Wd[w] ? materialFor(mats, 'wall', w) : undefined;
    if (f !== '-' && F[f]) add(`(地坪)${f}-${F[f]}`, 'M2', r.name, r.area, area);
    if (ownF) add(`(地坪)${ownF.name}`, 'M2', r.name, r.area, area, sectionOf(ownF));
    if (c !== '-' && Cc[c]) add(`(平頂)${c}-${Cc[c]}`, 'M2', r.name, r.area, area);
    if (ownC) add(`(平頂)${ownC.name}`, 'M2', r.name, r.area, area, sectionOf(ownC));
    if (w === 'W1A' || w === 'W1B' || ownW) {
      if (ownW) add(`(牆面)${ownW.name}`, 'M2', r.name, wallA, wallExpr, sectionOf(ownW));
      else add(`(牆面)${w}-${Wd[w]}`, 'M2', r.name, wallA, wallExpr);
      // the beams are concrete whatever the walls are: plaster and paint
      if (bm && S.beamDry !== false) add(`(牆面)W1A-${Wd.W1A}`, 'M2', `${r.name}（梁）`, bm.a, bm.expr);
      add('(踢腳)綠建材水泥漆踢腳 H=15cm', 'M', r.name, r.perim, `周長 ${r2(r.perim)} m（門洞已扣）`);
    }
    if (w === 'W2') {
      add('(牆面)W2A-內牆1:2防水水泥砂漿打底', 'M2', r.name, wallA, wallExpr);
      if (bm && S.beamWet !== false) add('(牆面)W2A-內牆1:2防水水泥砂漿打底', 'M2', `${r.name}（梁）`, bm.a, bm.expr);
      // wall tiles stop under the deepest beam along the room (or the slab, or a set height)
      const deep = deepOf.get(r.name) || 0, to = S.tileTo || 'beam';
      const th = to === 'h' ? Math.min(clear, S.tileH || 240) : to === 'beam' && deep > 0 ? Math.max(100, H - deep) : clear;
      const how = to === 'h' ? '貼磚高' : to === 'beam' && deep > 0 ? `貼到梁底（樓高 ${m(H)} − 梁深 ${m(deep)}）` : '貼到板底';
      add('(牆面)W2C-內牆貼30*60cm磁磚', 'M2', r.name, Math.max(0, r.perim * th / 100 - wa), `周長 ${r2(r.perim)} m × ${how} ${m(th)} m${wa ? ` − 窗 ${win!.n} 樘 ${r2(wa)} ㎡` : ''}`);
    }
    if (f === 'F5') add(`(牆面)廁所.茶水間地坪.牆面防水處理(H=${m(wetH)}M)`, 'M2', r.name, r.area + r.perim * wetH / 100, `面積 ${r2(r.area)} ㎡ + 周長 ${r2(r.perim)} m × ${m(wetH)} m`);
    if (f === 'F4' && !/露台|平台|屋頂/.test(r.name)) add('(地坪)陽台地坪防水處理', 'M2', r.name, r.area, area);
    if (/露台|平台|屋頂/.test(r.name)) add('(屋頂)屋頂.露台防水處理（含保護層）', 'M2', r.name, r.area, area);
  }
  // exterior walls: the pieces next to openings are already cut, so area is length × height
  /* faces given a finish by hand in the 3D model: the outward face of an exterior wall takes that finish instead of the
     project's default (二丁掛 unless changed); other picked faces are listed on their own. The 1:3 mortar base coat is
     counted under the finishes that need it, not under dry-hung stone or cladding */
  const outFace = (o: BoxObject) => o.rot ? -1 : o.w >= o.d ? (o.z >= cz ? 4 : 5) : (o.x >= cx ? 0 : 1);
  const faceA = (o: BoxObject, f: number) => (f < 2 ? o.d * o.h : f < 4 ? o.w * o.d : o.w * o.h) / 1e4;
  const secOf = (name: string) => { const mm = mats.find(x => x.name === name); return mm ? sectionOf(mm) : SEC.finish; };
  const picked = new Map<string, { a: number; n: number }>();
  // (an exterior finish on a top or underside is a mis-tap on a slab edge, from before the tool stopped allowing it)
  const extMat = (name: string) => mats.find(x => x.name === name)?.use === 'ext' || /^外牆/.test(name);
  for (const o of boxes) for (const [f, mat] of Object.entries(o.faces || {})) {
    if (!mat || (ext.includes(o) && +f === outFace(o)) || ((+f === 2 || +f === 3) && extMat(mat))) continue;
    const cur = picked.get(mat) || { a: 0, n: 0 };
    cur.a += faceA(o, +f); cur.n++; picked.set(mat, cur);
  }
  for (const [mat, v] of picked) add(`(牆面)${mat}`, 'M2', '指定面', v.a, `3D 模型指定材質 ${v.n} 面 Σ 長×高`, secOf(mat));
  const extA = new Map<string, Partial<Record<Facade, { a: number; L: number; n: number }>>>();
  for (const o of ext) {
    const own = o.faces?.[outFace(o)], mat = own || extName, k = facadeOf(o, cx, cz);
    const byK = extA.get(mat) || extA.set(mat, {}).get(mat)!, cur = byK[k] ||= { a: 0, L: 0, n: 0 };
    cur.a += len(o) * o.h / 100; cur.L += len(o); if (own) cur.n++;
  }
  // imported single drawings have solid walls behind their windows, so take the glass off
  const winOff: Partial<Record<Facade, number>> = {};
  if (inp.cadDoors) for (const w of wins) { const k = facadeOf(w.o, cx, cz); winOff[k] = (winOff[k] || 0) + w.w * w.h / 1e4; }
  const base: Partial<Record<Facade, { a: number; skip: Set<string> }>> = {}, whole: Partial<Record<Facade, number>> = {};
  for (const [mat, byK] of extA) for (const k of FACADES) {
    const v = byK[k];
    if (!v) continue;
    const off = mat === extName ? winOff[k] || 0 : 0, q = v.a - off;
    const expr = `Σ 牆段 長×高（${r2(v.L)} m 牆段，開口已扣${v.n ? `，3D 指定 ${v.n} 面` : ''}）${off ? ` − 窗 ${r2(off)} ㎡` : ''}`;
    add(`(牆面)${extFinishName(mat)}`, 'M2', `${k}外牆`, q, expr, secOf(mat));
    whole[k] = (whole[k] || 0) + q;
    const b = base[k] ||= { a: 0, skip: new Set() };
    if (needsBase(mat, mats)) b.a += q; else b.skip.add(extFinishName(mat).replace(/^外牆/, ''));
  }
  for (const k of FACADES) {
    const b = base[k];
    if (b && b.a > 0) add('(牆面)外牆1:3水泥砂漿打底', 'M2', `${k}外牆`, b.a, `外牆面積${b.skip.size ? `，不含${[...b.skip].join('、')}（不需打底）` : ''}`);
    if (S.extWater === 'area' && whole[k]) add('(牆面)外牆防水處理', 'M2', `${k}外牆`, whole[k]!, '外牆面積');
  }
  if (S.extWater !== 'area') {
    /* exterior waterproofing is run along lines: round every opening frame in an outside wall, and along the joint
       at the foot of the storey's outside walls */
    const outSide = (x: number, z: number) => { const n = map.at(x, z); return !n || rooms.find(r => r.name === n)?.fin.w === '-'; };
    const inExt = (x: number, z: number, along: boolean, t: number) => ext.some(o => !o.rot && Math.abs(x - o.x) <= o.w / 2 + 3 && Math.abs(z - o.z) <= o.d / 2 + 3)
      || [-1, 1].some(s => outSide(x + (along ? 0 : s * (t / 2 + 20)), z + (along ? s * (t / 2 + 20) : 0)));
    const line: Partial<Record<Facade, { win: number; nw: number; door: number; nd: number; joint: number }>> = {};
    const at = (k: Facade) => (line[k] ||= { win: 0, nw: 0, door: 0, nd: 0, joint: 0 });
    // the joint runs the whole outside wall line, openings included: union of the wall pieces and openings per line
    const runs = new Map<string, { k: Facade; iv: [number, number][] }>();
    const run = (k: Facade, alongX: boolean, x: number, z: number, L: number) => {
      const key = `${alongX ? 'x' : 'z'}${Math.round((alongX ? z : x) / 40)}`, c = alongX ? x : z;
      if (!runs.has(key)) runs.set(key, { k, iv: [] });
      runs.get(key)!.iv.push([c - L / 2, c + L / 2]);
    };
    for (const w of wins) {
      const along = w.o.w >= w.o.d;
      if (!inExt(w.o.x, w.o.z, along, Math.min(w.o.w, w.o.d))) continue;
      const k = facadeOf(w.o, cx, cz), v = at(k); v.win += 2 * (w.w + w.h) / 100; v.nw++;
      if (!w.o.rot) run(k, along, w.o.x, w.o.z, w.w);
    }
    for (const d of doors) {
      let k: Facade;
      if (d.o) {
        const along = d.o.axis === 'x', x = along ? (d.o.a + d.o.b) / 2 : d.o.at, z = along ? d.o.at : (d.o.a + d.o.b) / 2;
        if (!d.ext && !inExt(x, z, along, 20)) continue;
        k = facadeOf({ x, z, w: along ? d.w : 20, d: along ? 20 : d.w } as BoxObject, cx, cz);
      } else if (d.ext) k = '南向'; else continue;
      const v = at(k); v.door += (d.w + 2 * d.h) / 100; v.nd++;
      if (d.o) { const along = d.o.axis === 'x'; run(k, along, along ? (d.o.a + d.o.b) / 2 : d.o.at, along ? d.o.at : (d.o.a + d.o.b) / 2, d.w); } else v.joint += d.w / 100;
    }
    for (const o of ext) if (o.rot) { if (o.y <= 1) at(facadeOf(o, cx, cz)).joint += len(o); } else run(facadeOf(o, cx, cz), o.w >= o.d, o.x, o.z, Math.max(o.w, o.d));
    for (const { k, iv } of runs.values()) {
      iv.sort((a, b) => a[0] - b[0]);
      let L = 0, [a0, a1] = iv[0];
      for (const [a, b] of iv.slice(1)) { if (a > a1 + 2) { L += a1 - a0; a0 = a; a1 = b; } else a1 = Math.max(a1, b); }
      L += Math.max(0, a1 - a0);
      at(k).joint += L / 100;
    }
    for (const k of FACADES) {
      const v = line[k];
      if (!v) continue;
      const parts = [v.nw ? `窗框 ${v.nw} 樘周長 ${r2(v.win)} m` : '', v.nd ? `門框 ${v.nd} 樘（寬＋2 高）${r2(v.door)} m` : '', v.joint ? `樓層接縫（外牆全長）${r2(v.joint)} m` : ''].filter(Boolean);
      add('(牆面)外牆防水處理', 'M', `${k}外牆`, v.win + v.door + v.joint, parts.join(' + '));
    }
  }
  const G = [...groups.values()].map(g => ({ ...g, total: r2(sum(g.rows, r => r.q)) }));

  /* structure: concrete and formwork per element, written out per size */
  const byDims = (list: BoxObject[], key: (o: BoxObject) => string) => {
    const g = new Map<string, BoxObject[]>();
    for (const o of list) { const k = key(o); if (!g.has(k)) g.set(k, []); g.get(k)!.push(o); }
    return [...g.entries()];
  };
  const colDims = (o: BoxObject) => o.rc?.b && o.rc.h ? [o.rc.b, o.rc.h] : [Math.min(o.w, o.d), Math.max(o.w, o.d)];
  /* where parts meet, the concrete and the formwork are counted once: a wall stops at the column faces and under the
     beam or slab above it; a column face against a wall needs no formwork */
  const rect = (o: BoxObject) => ({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 });
  const over = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const beamsHere = boxes.filter(o => o.rc?.kind === 'beam' || (o.layer === 'slab' && /梁/.test(o.name)));
  const slabT = slabs[0]?.h || S.slab;
  const storeyTop = Math.max(H, ...walls.map(o => o.y + o.h));
  const colOf = new Map<BoxObject, number>();  // column → wall-covered face area, cm²
  const wallNet = (o: BoxObject) => {
    const r = rect(o), alongX = o.w >= o.d, L = Math.max(o.w, o.d), t = Math.min(o.w, o.d), top = o.y + o.h;
    if (o.rot) return { L, A: L * o.h, cut: 0 };
    // the length inside columns
    let inCols = 0;
    for (const c of cols) {
      if (c.rot) continue;
      const q = rect(c), ix = over(r.x0, r.x1, q.x0 - 3, q.x1 + 3), iz = over(r.z0, r.z1, q.z0 - 3, q.z1 + 3);
      if (ix <= 0 || iz <= 0) continue;
      inCols += Math.max(0, alongX ? over(r.x0, r.x1, q.x0, q.x1) : over(r.z0, r.z1, q.z0, q.z1));
      colOf.set(c, (colOf.get(c) || 0) + t * Math.min(o.h, c.h));
    }
    const net = Math.max(0, L - inCols);
    // the top of the wall that is really beam or slab
    let under = 0, cut = 0;
    for (const b of beamsHere) {
      if (b.rot) continue;
      const q = rect(b), ix = over(r.x0, r.x1, q.x0, q.x1), iz = over(r.z0, r.z1, q.z0, q.z1);
      if (ix <= 0 || iz <= 0) continue;
      const len = Math.min(alongX ? ix : iz, net - under), dep = over(o.y, top, b.y, b.y + b.h);
      if (len <= 0 || dep <= 0) continue;
      under += len; cut += len * dep;
    }
    if (top >= storeyTop - 1) cut += Math.max(0, net - under) * Math.min(slabT, o.h);
    return { L: net, A: Math.max(0, net * o.h - cut), cut };
  };
  const wallParts = new Map(rcWalls.map(o => [o, wallNet(o)]));
  for (const [k, list] of byDims(cols, o => `${o.rc ? `${o.rc.mark} ` : ''}${colDims(o).map(Math.round).join('×')}×${Math.round(o.h)}`)) {
    const o = list[0], [a, b] = colDims(o), covered = sum(list, c => colOf.get(c) || 0);
    row(SEC.rc, CONCRETE, 'M3', `柱 ${k}`, `${m(a)} × ${m(b)} × ${m(o.h)} m × ${list.length} 支`, a * b * o.h / 1e6 * list.length);
    row(SEC.rc, FORMWORK, '㎡', `柱 ${k}`, `周長 2×(${m(a)}+${m(b)}) m × 高 ${m(o.h)} m × ${list.length} 支${covered ? ` − 貼牆面 ${r2(covered / 1e4)} ㎡` : ''}`, Math.max(0, 2 * (a + b) * o.h * list.length - covered) / 1e4);
  }
  for (const [, list] of byDims(rcWalls, o => `${Math.round(Math.min(o.w, o.d))}|${Math.round(o.h)}`)) {
    const t = Math.min(list[0].w, list[0].d), h = list[0].h, L = sum(list, o => wallParts.get(o)!.L), A = sum(list, o => wallParts.get(o)!.A), cut = sum(list, o => wallParts.get(o)!.cut);
    const where = `RC牆 厚${Math.round(t)} 高${Math.round(h)}${/窗台|窗楣|門楣/.test(list[0].name) ? '（窗台/窗楣）' : ''}`;
    const less = cut > 0 ? ` − 梁、板重疊 ${r2(cut / 1e4)} ㎡` : '';
    row(SEC.rc, CONCRETE, 'M3', where, `(長 ${m(L)} m × 高 ${m(h)} m${less}) × 厚 ${m(t)} m（${list.length} 段，柱內已扣）`, A * t / 1e6);
    row(SEC.rc, FORMWORK, '㎡', where, `(長 ${m(L)} m × 高 ${m(h)} m${less}) × 2 面（門窗開口兩面已扣、柱內已扣）`, A * 2 / 1e4);
  }
  const ground = /^1F$|^B/.test(fl) || slabs.some(o => /地坪/.test(o.name));
  const slabA = sum(slabs, o => o.w * o.d / 1e4);
  let slabArea = 0;
  if (slabA > 0) {
    const t = slabs[0].h || S.slab, name = ground ? '地坪' : slabs.some(o => /屋頂/.test(o.name)) ? '屋頂板' : '樓板';
    row(SEC.rc, CONCRETE, 'M3', name, `面積 ${r2(slabA)} ㎡ × 厚 ${m(t)} m`, slabA * t / 100);
    if (!ground) row(SEC.rc, FORMWORK, '㎡', `${name}底模`, `面積 ${r2(slabA)} ㎡`, slabA);
    if (name !== '屋頂板') slabArea = slabA;
    if (name === '屋頂板') row(SEC.water, '屋頂.露台防水處理（含保護層）', '㎡', '屋頂板', `面積 ${r2(slabA)} ㎡`, slabA);
  }
  if (fences.length) {
    const L = sum(fences, o => Math.max(o.w, o.d)) / 100, A = sum(fences, o => Math.max(o.w, o.d) * o.h) / 1e4, V = sum(fences, o => o.w * o.d * o.h) / 1e6;
    const t = Math.min(fences[0].w, fences[0].d), h = fences[0].h;
    row(SEC.road, '圍牆 3500PSI 預拌混凝土', 'M3', '圍牆', `長 ${r2(L)} m × 高 ${m(h)} m × 厚 ${m(t)} m`, V);
    row(SEC.road, '圍牆 模板(含放樣)', '㎡', '圍牆', `長 ${r2(L)} m × 高 ${m(h)} m × 2 面`, A * 2);
    row(SEC.road, '圍牆 泥作打底', '㎡', '圍牆', `長 ${r2(L)} m × 高 ${m(h)} m × 2 面`, A * 2);
  }
  // lean concrete under the foundation (no formwork)
  const pcA = sum(blinding, o => o.w * o.d / 1e4);
  if (pcA > 0) row(SEC.site, '2000PSI預拌混凝土', 'M3', '基礎PC墊層', `面積 ${r2(pcA)} ㎡ × 厚 ${m(blinding[0].h)} m`, pcA * blinding[0].h / 100);
  const eaveA = sum(eaves, o => o.w * o.d / 1e4);
  if (eaveA > 0) {
    const t = eaves[0].h || S.slab;
    row(SEC.rc, CONCRETE, 'M3', '屋簷', `面積 ${r2(eaveA)} ㎡ × 厚 ${m(t)} m`, eaveA * t / 100);
    row(SEC.rc, FORMWORK, '㎡', '屋簷底模', `面積 ${r2(eaveA)} ㎡`, eaveA);
  }
  if (slabA <= 0 && !inp.objects.some(o => o.floor)) {
    // single plans have no slab objects: use the outline
    const fp = bounds.W * bounds.D / 1e4;
    row(SEC.rc, CONCRETE, 'M3', '樓板', `建築外框 ${m(bounds.W)} × ${m(bounds.D)} m × 厚 ${m(S.slab)} m`, fp * S.slab / 100);
    row(SEC.rc, FORMWORK, '㎡', '樓板底模', `建築外框 ${m(bounds.W)} × ${m(bounds.D)} m`, fp);
  }
  const beams = boxes.filter(o => /梁/.test(o.name));
  for (let [k, list] of byDims(beams, o => `${Math.round(Math.min(o.w, o.d))}×${Math.round(o.h)}`)) {
    const b = Math.min(list[0].w, list[0].d), h = list[0].h, L = sum(list, o => Math.max(o.w, o.d));
    if (/估算/.test(list[0].name)) k = `${k}（估算：沿柱列軸線，待結構圖）`;
    else {
      // marks from the structural plans: 地梁 FG1a、FB1a … / 梁 G1a、B1a …
      const marks = [...new Set(list.map(o => /^(地?梁) (\S+?)（/.exec(o.name)).filter(Boolean).map(m => m![2]))].sort();
      const kind = list.some(o => /^地梁/.test(o.name)) ? '地梁' : '';
      if (marks.length) k = `${k}（${kind ? '地梁 ' : ''}${marks.join('、')}）`;
    }
    row(SEC.rc, CONCRETE, 'M3', `梁 ${k}`, `長 ${m(L)} m × 寬 ${m(b)} m × (梁深 ${m(h)} − 板厚 ${m(S.slab)}) m`, L * b * Math.max(0, h - S.slab) / 1e6);
    row(SEC.rc, FORMWORK, '㎡', `梁 ${k}`, `長 ${m(L)} m × (底 ${m(b)} + 2 側 × ${m(h - S.slab)}) m`, L * (b + 2 * Math.max(0, h - S.slab)) / 1e4);
  }
  // stairs: riser count as written on the plan (上16); each flight is wedge steps on a waist slab
  for (const st of boxes.filter(o => o.stair).map(o => o.stair!)) {
    const { risers: N, flights: F, width: w, run, rise, landing } = st;
    const treads = Math.max(0, N - F), slope = Math.hypot(run, rise), flightLen = treads / F * slope;
    const where = `樓梯 ${N} 階（寬 ${m(w)} m，踏 ${m(run)} m，級高 ${m(rise)} m）`;
    row(SEC.rc, CONCRETE, 'M3', where, `踏階 ${treads} × ½ × ${m(w)} × ${m(run)} × ${m(rise)} + 斜板 ${F} 跑 × ${m(w)} × ${m(flightLen)} × ${m(S.slab)} + 平台 ${r2(landing)} ㎡ × ${m(S.slab)}`,
      (treads * w * run * rise / 2 + F * w * flightLen * S.slab) / 1e6 + landing * S.slab / 100);
    row(SEC.rc, FORMWORK, '㎡', where, `斜板底 ${F} 跑 × ${m(w)} × ${m(flightLen)} + 踢面 ${N} × ${m(w)} × ${m(rise)} + 平台底 ${r2(landing)} ㎡`,
      F * w * flightLen / 1e4 + N * w * rise / 1e4 + landing);
    row(SEC.finish, '樓梯踢面石英磚', '㎡', where, `${N} 階 × ${m(w)} × ${m(rise)}（踏面含在樓梯間地坪）`, N * w * rise / 1e4);
    row(SEC.finish, '樓梯止滑條', 'M', where, `${treads} 階 × ${m(w)}`, treads * w / 100);
    row(SEC.misc, '樓梯欄杆扶手 H=90cm', 'M', where, `${F} 跑 × 斜長 ${m(flightLen)} m（√(踏² + 級高²) × ${treads / F} 階）`, F * flightLen / 100);
  }
  for (const [k, list] of byDims(railings, o => `${o.name}|${Math.round(o.h)}`)) {
    const L = sum(list, o => Math.max(o.w, o.d)), [name, h] = k.split('|');
    row(SEC.misc, `${name.replace(/（CAD）/, '')} H=${h}cm`, 'M', '陽台.露台', `${list.length} 段 合計長 ${m(L)} m`, L / 100);
  }

  /* other items */
  row(SEC.temp, '交屋清潔費', '坪', '室內', `面積 ${r2(floorArea)} ㎡ ÷ 3.3058`, floorArea / PING);
  const fp = bounds.W * bounds.D / 1e4, extPerim = 2 * (bounds.W + bounds.D) / 100;
  row(SEC.site, '放樣', '㎡', '建築外框', `${m(bounds.W)} × ${m(bounds.D)} m`, fp);
  row(SEC.site, '施工架', '㎡', '外周', `外周長 ${r2(extPerim)} m × (牆高 ${m(H)} + 1) m`, extPerim * (H + 100) / 100);
  if (fl === '1F' || !objects.some(o => o.floor)) {
    const dig = S.dig ?? 150;
    row(SEC.site, '挖土（估算）', 'M3', '基礎開挖', `建築外框 ${r2(fp)} ㎡ × 開挖深 ${m(dig)} m（依基礎圖調整）`, fp * dig / 100);
    row(SEC.site, '回填土（估算）', 'M3', '基礎開挖', `挖土 × 30%`, fp * dig / 100 * 0.3);
    row(SEC.site, '餘土運棄（估算）', 'M3', '基礎開挖', `挖土 × 70% × 鬆方 1.3`, fp * dig / 100 * 0.7 * 1.3);
  }
  // concrete totals carry the pumping and the rebar
  const conc = sum(calc.filter(c => c.item === CONCRETE), c => c.q);
  if (conc > 0) {
    row(SEC.rc, '壓送', 'M3', '同混凝土', `混凝土 ${r2(conc)} M3`, conc);
  }
  // rebar by the standard drawings and code minimums, member by member (a whole building replaces it with its bar list)
  const rebar = conc > 0 && !inp.noRebar ? computeRebar(objects, null) : undefined;
  if (rebar) calc.push(...rebarCalc([], rebar.rows));
  if (int.length) {
    const L = sum(int, o => Math.max(o.w, o.d)), A = sum(int, o => len(o) * o.h / 100), F = sum(intFill, o => len(o) * o.h / 100);
    row(SEC.finish, '內牆雙面矽酸鈣板(一小時防火時效)', '㎡', `${int.some(o => o.wall === 'light') ? '輕隔間牆' : '隔間牆'} ${int.length} 段`,
      `合計長 ${m(L)} m × 高（各段 ${[...new Set(int.map(o => m(o.h)))].join('/')} m）${intFill.length ? ` + 門楣／窗下 ${intFill.length} 段 ${r2(F)} ㎡` : ''}`, A + F);
  }
  // doors and windows by schedule type
  const dk = new Map<string, { n: number; w: number; h: number; ext: boolean }>();
  for (const d of doors) { const k = schedKey(d.name) || `D 門 ${Math.round(d.w)}*${Math.round(d.h)}`; const c = dk.get(k) || { n: 0, w: d.w, h: d.h, ext: d.ext }; c.n++; dk.set(k, c); }
  for (const [k, c] of dk) row(SEC.open, k, '樘', '門', `${c.n} 樘`, c.n);
  const wk = new Map<string, { n: number; w: number; h: number }>();
  for (const w of wins) { const k = schedKey(w.o.name) || `W 鋁窗 ${Math.round(w.w)}*${Math.round(w.h)}`; const c = wk.get(k) || { n: 0, w: w.w, h: w.h }; c.n++; wk.set(k, c); }
  for (const [k, c] of wk) row(SEC.open, k, '樘', '窗', `${c.n} 樘`, c.n);
  if (winArea) row(SEC.open, '鋁窗玻璃', '㎡', '窗', [...wk.values()].map(c => `${m(c.w)}×${m(c.h)}×${c.n}`).join(' + '), winArea);
  const winPerim = sum(wins, w => 2 * (w.w + w.h) / 100);
  const extDoors = doors.filter(d => d.ext), doorPerim = (d: { w: number; h: number }) => (d.w + 2 * d.h) / 100;
  if (winPerim + sum(extDoors, doorPerim) > 0) row(SEC.open, '外牆門窗防水工程', 'M', '外牆開口', `窗周長 ${r2(winPerim)} m + 外門 ${r2(sum(extDoors, doorPerim))} m`, winPerim + sum(extDoors, doorPerim));
  if (winPerim + sum(doors, doorPerim) > 0) row(SEC.open, '門窗填縫', 'M', '所有門窗', `窗周長 ${r2(winPerim)} m + 門 (寬+2高) ${r2(sum(doors, doorPerim))} m`, winPerim + sum(doors, doorPerim));
  const bath = boxes.filter(o => o.layer === 'bath' && o.h > 10);
  const wet = rooms.filter(r => /廁|浴|衛/.test(r.name)).length;
  const basins = bath.filter(o => /洗手|檯|台/.test(o.name)).length || wet, wc = bath.filter(o => /馬桶/.test(o.name)).length || wet;
  const bathNote = bath.length ? '模型衛浴設備' : '每間浴廁 1 組';
  row(SEC.bath, '洗手台人造石檯面', '組', '浴廁', bathNote, basins);
  row(SEC.bath, '明鏡', '面', '浴廁', bathNote, basins);
  row(SEC.bath, '馬桶(座式)', '組', '浴廁', bathNote, wc);
  for (const t of ['水電工程', '弱電工程', '消防工程']) row(SEC.mep, t, '坪', '室內', `樓地板面積 ${r2(floorArea)} ㎡ ÷ 3.3058（依設備圖確認）`, floorArea / PING);
  // the rooms as rows of cells, only when a storey of a whole building is measured
  let roomRuns: Takeoff['roomRuns'];
  if (S.floor) {
    const STEP = 20, byName = new Map<string, number[][]>();
    for (let z = STEP / 2; z < bounds.D; z += STEP) {
      let cur: number[] | null = null, curName: string | null = null;
      for (let x = STEP / 2; x <= bounds.W + STEP / 2; x += STEP) {
        const n = x < bounds.W ? map.at(x, z) : null;
        if (cur && n !== curName) { cur[2] = x - STEP / 2; (byName.get(curName!) || byName.set(curName!, []).get(curName!)!).push(cur); cur = null; }
        if (!cur && n) { cur = [z - STEP / 2, x - STEP / 2, 0]; curName = n; }
      }
    }
    roomRuns = [...byName].map(([name, runs]) => ({ fl: S.floor!, name, runs }));
  }
  return { budget: budgetOf(calc, fl, materialItems(mats)), groups: G, rooms, calc, floorArea, wallH: H, slabArea: r2(slabArea), ...(roomRuns ? { roomRuns } : {}), ...(rebar ? { rebar } : {}) };
}

/** Budget lines from calculation rows, in the template's section order; door and window types lead their section. */
export function budgetOf(calc: CalcRow[], fl?: string, extra: Record<string, TemplateItem[]> = {}): BudgetLine[] {
  const lines = new Map<string, BudgetLine & { sec0: string; n: number; fls: Set<string> }>();
  for (const c of calc) {
    const k = `${c.sec}|${c.item}|${c.unit}`;
    const cur = lines.get(k);
    if (cur) { cur.q = (cur.q as number) + c.q; cur.n++; cur.fls.add(c.fl); }
    else lines.set(k, { sec0: c.sec, name: c.item, unit: c.unit, q: c.q, n: 1, fls: new Set([c.fl]) });
  }
  const out: BudgetLine[] = [];
  const isType = (n: string) => /^(D 門|W 鋁窗) /.test(n) || /^[A-Z]{1,3}\d{0,3}[A-Z]? \S+ [\d.]+\*/.test(n);
  for (const sec of SEC_ORDER) {
    const body = [...lines.values()].filter(l => l.sec0 === sec);
    out.push({ sec });
    const types = body.filter(l => isType(l.name!)).sort((a, b) => a.name!.localeCompare(b.name!));
    const rest = body.filter(l => !isType(l.name!)), used = new Set<typeof rest[number]>();
    // template order: a measured item takes the place of the first template item it covers;
    // template items nothing covers are listed blank; measured items not in the template go last
    const ordered: (typeof rest[number] | { item: TemplateItem })[] = [...types];
    for (const t of [...(BUDGET_TEMPLATE[sec] || []), ...(extra[sec] || [])]) {
      const hit = rest.filter(l => covers(l.name!, t.name));
      if (!hit.length) { ordered.push({ item: t }); continue; }
      for (const l of hit) if (!used.has(l)) { used.add(l); ordered.push(l); }
    }
    ordered.push(...rest.filter(l => !used.has(l)));
    let i = 0;
    for (const l of ordered) {
      if ('item' in l) { out.push({ i: ++i, name: l.item.name, unit: l.item.unit, q: 0, note: '模型未算出，請自行填入數量', tpl: true }); continue; }
      const multi = l.fls.size > 1 ? `${l.fls.size} 層合計` : fl || [...l.fls][0] || '';
      out.push({ i: ++i, name: l.name, unit: l.unit, q: typeof l.q === 'number' ? r2(l.q) : l.q, note: l.n ? `${multi}，見數量計算式` : '' });
    }
    if (!body.length && !BUDGET_TEMPLATE[sec] && !extra[sec]) out.pop();
  }
  return out;
}

/**
 * Takeoff for a whole-building import: each storey is measured on its own (rooms,
 * walls, openings, slab) and the results are added up. Room names get the storey
 * key in front ("2F 客餐廳") so each floor's finishes can be set separately.
 */
export function computeBuildingTakeoff(objects: ModelObject[], cad: CadData, finishes: Record<string, Partial<FinishChoice>>, settings: TakeoffSettings): Takeoff {
  const floors = cad.floors || [];
  const parts = floors.map(f => computeTakeoff({
    objects: objects.filter(o => o.floor === f.key).map(o => isBox(o) ? { ...o, y: o.y - f.y } : { ...o, y: (o.y || 0) - f.y }),
    bounds: { W: cad.W, D: cad.D },
    labels: f.texts.map(t => ({ n: `${f.key} ${t.s}`, x: t.x, z: t.z })),
    finishes,
    settings: { ...settings, floor: f.key },
    noRebar: true,
  }));
  // building-wide items are not per storey
  let calc = parts.flatMap(p => p.calc).filter(c => c.item !== '放樣' && c.item !== '施工架');
  const rebar = computeRebar(objects, cad);
  const formwork = computeFormwork(objects, cad, settings.slab, floors.map(f => f.key));
  if (cad.rc) {
    // foundation slabs are only on the structural plans
    for (const p of cad.rc.panels.filter(p => /^F/.test(p.mark))) {
      const t = cad.rc.spec.slabs.find(s => s.mark === p.mark)?.t;
      if (!t) continue;
      const A = (p.x1 - p.x0) * (p.z1 - p.z0) / 1e4;
      calc.push({ sec: SEC.rc, item: CONCRETE, unit: 'M3', fl: p.fl, where: `基礎版 ${p.mark} 厚${t}`, expr: `${r2((p.x1 - p.x0) / 100)} × ${r2((p.z1 - p.z0) / 100)} m × 厚 ${m(t)} m（梁心距）`, q: r2(A * t / 100) });
    }
  }
  calc = rebarCalc(calc, rebar.rows);
  const top = Math.max(0, ...floors.map(f => f.y + f.h));
  const perim = 2 * (cad.W + cad.D) / 100;
  const whole = (sec: string, item: string, unit: string, where: string, expr: string, q: number) => calc.push({ sec, item, unit, fl: '整棟', where, expr, q: r2(q) });
  whole(SEC.site, '放樣', '㎡', '建築外框', `${r2(cad.W / 100)} × ${r2(cad.D / 100)} m`, cad.W * cad.D / 1e4);
  whole(SEC.site, '施工架', '㎡', '外周', `外周長 ${r2(perim)} m × (建物高 ${r2(top / 100)} + 1) m`, perim * (top + 100) / 100);
  const order = new Map(SEC_ORDER.map((s, i) => [s, i]));
  const fl = new Map(floors.map((f, i) => [f.key, i]));
  calc.sort((a, b) => (order.get(a.sec)! - order.get(b.sec)!) || a.item.localeCompare(b.item) || ((fl.get(a.fl) ?? -1) - (fl.get(b.fl) ?? -1)));
  const groups = new Map<string, FinishGroup>();
  for (const p of parts) for (const g of p.groups) {
    const cur = groups.get(g.title);
    if (!cur) groups.set(g.title, { ...g, rows: [...g.rows] });
    else { cur.rows.push(...g.rows); cur.total = r2(cur.total + g.total); }
  }
  return {
    ...(rebar ? { rebar } : {}),
    ...(formwork ? { formwork } : {}),
    plans: { formwork: formwork ? formworkPlans(objects, formwork) : [], mason: masonPlans(objects, parts.flatMap(p => p.roomRuns || []), floors.map(f => f.key)) },
    budget: budgetOf(calc, undefined, materialItems(materialsOf(settings.materials))),
    groups: [...groups.values()],
    rooms: parts.flatMap(p => p.rooms),
    calc,
    floorArea: parts.reduce((s, p) => s + p.floorArea, 0),
    slabArea: r2(parts.reduce((s, p) => s + (p.slabArea || 0), 0)),
    wallH: Math.max(WALL_H, ...parts.map(p => p.wallH)),
  };
}

const REBAR_ITEMS = ['鋼筋（SD420＋SD280）', '鋼筋綁紮', '鋼筋運費'];

/** Rebar rows of the calculation sheet from the bar list, per floor and member kind (never estimated from the concrete). */
export function rebarCalc(calc: CalcRow[], rows: RebarRow[]): CalcRow[] {
  const out = calc.filter(c => !REBAR_ITEMS.includes(c.item));
  const g = new Map<string, { fl: string; kind: RebarKind; hi: number; lo: number; n: number; std: boolean }>();
  for (const r of rows) {
    const k = `${r.fl}|${r.kind}`, cur = g.get(k) || { fl: r.fl, kind: r.kind, hi: 0, lo: 0, n: 0, std: false };
    if (r.s >= 6) cur.hi += r.kg; else cur.lo += r.kg;
    cur.n++;
    if (/無.*配筋圖|S0-07/.test(r.expr)) cur.std = true;
    g.set(k, cur);
  }
  const add: CalcRow[] = [];
  for (const v of g.values()) add.push({ sec: SEC.rc, item: REBAR_ITEMS[0], unit: '噸', fl: v.fl, where: `${v.kind}（${v.std ? '依配筋圖／標準圖' : '依配筋圖'}，明細 ${v.n} 筆）`,
    expr: `SD420（#6 以上）${r2(v.hi)} kg + SD280（#5 以下）${r2(v.lo)} kg，見鋼筋明細`, q: Math.round((v.hi + v.lo) / 1000 * 1000) / 1000 });
  const total = add.reduce((a, c) => a + c.q, 0);
  for (const item of REBAR_ITEMS.slice(1)) add.push({ sec: SEC.rc, item, unit: '噸', fl: '整棟', where: '同鋼筋', expr: `鋼筋合計 ${r2(total)} 噸`, q: Math.round(total * 1000) / 1000 });
  return [...out, ...add];
}
