import { BUDGET_TEMPLATE, covers, type TemplateItem } from './budgetTemplate';
import { computeRebar, type RebarKind, type RebarRow } from './rebar';
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
export const EXT_FINISHES = ['外牆1:3水泥砂漿打底+抿石子', '外牆1:3水泥砂漿打底+水泥漆', '外牆複合式鍍鋁鋅彩色鋼板', '外牆企口型金屬飾板'];
export const DEFAULT_SETTINGS: TakeoffSettings = { ext: 0, floor: '1F', slab: 15, rebar: 120 };

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
  /** bar list from the reinforcement drawings, and the members whose schedule was not found */
  rebar?: { rows: RebarRow[]; missing: string[] };
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
  const walls = boxes.filter(o => o.layer === 'wall' && o.h > 0);
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
  const slabs = boxes.filter(o => o.layer === 'slab' && !/梁|屋簷/.test(o.name)), eaves = boxes.filter(o => o.layer === 'slab' && /屋簷/.test(o.name));
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
  for (const r of rooms) {
    const { f, c, w } = r.fin;
    const win = winsOf.get(r.name), wa = win?.a || 0;
    const wallA = Math.max(0, r.perim * clear / 100 - wa);
    const wallExpr = `周長 ${r2(r.perim)} m × 淨高 ${m(clear)} m${wa ? ` − 窗 ${win!.n} 樘 ${r2(wa)} ㎡` : ''}`;
    const area = `面積 ${r2(r.area)} ㎡`;
    const F = FINISHES.f as Record<string, string>, Cc = FINISHES.c as Record<string, string>, Wd = FINISHES.w as Record<string, string>;
    if (f !== '-' && F[f]) add(`(地坪)${f}-${F[f]}`, 'M2', r.name, r.area, area);
    if (c !== '-' && Cc[c]) add(`(平頂)${c}-${Cc[c]}`, 'M2', r.name, r.area, area);
    if (w === 'W1A' || w === 'W1B') {
      add(`(牆面)${w}-${Wd[w]}`, 'M2', r.name, wallA, wallExpr);
      add('(踢腳)綠建材水泥漆踢腳 H=15cm', 'M', r.name, r.perim, `周長 ${r2(r.perim)} m（門洞已扣）`);
    }
    if (w === 'W2') {
      add('(牆面)W2A-內牆1:2防水水泥砂漿打底', 'M2', r.name, wallA, wallExpr);
      add('(牆面)W2C-內牆貼30*60cm磁磚', 'M2', r.name, wallA, wallExpr);
    }
    if (f === 'F5') add('(牆面)廁所.茶水間地坪.牆面防水處理(H=1.2M)', 'M2', r.name, r.area + r.perim * 1.2, `面積 ${r2(r.area)} ㎡ + 周長 ${r2(r.perim)} m × 1.2 m`);
    if (f === 'F4' && !/露台|平台|屋頂/.test(r.name)) add('(地坪)陽台地坪防水處理', 'M2', r.name, r.area, area);
    if (/露台|平台|屋頂/.test(r.name)) add('(屋頂)屋頂.露台防水處理（含保護層）', 'M2', r.name, r.area, area);
  }
  // exterior walls: the pieces next to openings are already cut, so area is length × height
  const facade: Partial<Record<Facade, { a: number; L: number }>> = {};
  for (const o of ext) { const k = facadeOf(o, cx, cz); const cur = facade[k] || { a: 0, L: 0 }; cur.a += len(o) * o.h / 100; cur.L += len(o); facade[k] = cur; }
  // imported single drawings have solid walls behind their windows, so take the glass off
  const winOff: Partial<Record<Facade, number>> = {};
  if (inp.cadDoors) for (const w of wins) { const k = facadeOf(w.o, cx, cz); winOff[k] = (winOff[k] || 0) + w.w * w.h / 1e4; }
  for (const k of FACADES) {
    const v = facade[k];
    if (!v) continue;
    const q = v.a - (winOff[k] || 0), expr = `Σ 牆段 長×高（${r2(v.L)} m 牆段，開口已扣）${winOff[k] ? ` − 窗 ${r2(winOff[k]!)} ㎡` : ''}`;
    add(`(牆面)${EXT_FINISHES[S.ext] || EXT_FINISHES[0]}`, 'M2', `${k}外牆`, q, expr);
    add('(牆面)外牆防水處理', 'M2', `${k}外牆`, q, expr);
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
    row(SEC.rc, '鋼筋（SD420＋SD280）', '噸', '同混凝土', `混凝土 ${r2(conc)} M3 × ${S.rebar} kg/M3 ÷ 1000`, conc * S.rebar / 1000);
    row(SEC.rc, '鋼筋綁紮', '噸', '同鋼筋', `混凝土 ${r2(conc)} M3 × ${S.rebar} kg/M3 ÷ 1000`, conc * S.rebar / 1000);
    row(SEC.rc, '鋼筋運費', '噸', '同鋼筋', `混凝土 ${r2(conc)} M3 × ${S.rebar} kg/M3 ÷ 1000`, conc * S.rebar / 1000);
  }
  if (int.length) {
    const L = sum(int, o => Math.max(o.w, o.d)), A = sum(int, o => len(o) * o.h / 100);
    row(SEC.finish, '內牆雙面矽酸鈣板(一小時防火時效)', '㎡', `${int.some(o => o.wall === 'light') ? '輕隔間牆' : '隔間牆'} ${int.length} 段`, `合計長 ${m(L)} m × 高（各段 ${[...new Set(int.map(o => m(o.h)))].join('/')} m）`, A);
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
  return { budget: budgetOf(calc, fl), groups: G, rooms, calc, floorArea, wallH: H, slabArea: r2(slabArea) };
}

/** Budget lines from calculation rows, in the template's section order; door and window types lead their section. */
export function budgetOf(calc: CalcRow[], fl?: string): BudgetLine[] {
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
    for (const t of BUDGET_TEMPLATE[sec] || []) {
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
    if (!body.length && !BUDGET_TEMPLATE[sec]) out.pop();
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
  }));
  // building-wide items are not per storey
  let calc = parts.flatMap(p => p.calc).filter(c => c.item !== '放樣' && c.item !== '施工架');
  const rebar = cad.rc ? computeRebar(objects, cad) : undefined;
  if (cad.rc) {
    // foundation slabs are only on the structural plans
    for (const p of cad.rc.panels.filter(p => /^F/.test(p.mark))) {
      const t = cad.rc.spec.slabs.find(s => s.mark === p.mark)?.t;
      if (!t) continue;
      const A = (p.x1 - p.x0) * (p.z1 - p.z0) / 1e4;
      calc.push({ sec: SEC.rc, item: CONCRETE, unit: 'M3', fl: p.fl, where: `基礎版 ${p.mark} 厚${t}`, expr: `${r2((p.x1 - p.x0) / 100)} × ${r2((p.z1 - p.z0) / 100)} m × 厚 ${m(t)} m（梁心距）`, q: r2(A * t / 100) });
    }
  }
  if (rebar?.rows.length) calc = rebarCalc(calc, rebar.rows, settings);
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
    budget: budgetOf(calc),
    groups: [...groups.values()],
    rooms: parts.flatMap(p => p.rooms),
    calc,
    floorArea: parts.reduce((s, p) => s + p.floorArea, 0),
    slabArea: r2(parts.reduce((s, p) => s + (p.slabArea || 0), 0)),
    wallH: Math.max(WALL_H, ...parts.map(p => p.wallH)),
  };
}

const REBAR_ITEMS = ['鋼筋（SD420＋SD280）', '鋼筋綁紮', '鋼筋運費'];
/** Concrete rows of the calculation sheet by member kind, for the members without a reinforcement schedule. */
const kindOfWhere = (w: string): RebarKind | null => /^柱/.test(w) ? '柱' : /^(地?梁)/.test(w) ? '梁' : /^基礎版/.test(w) ? '基礎版' : /^(樓板|地坪|屋頂板)/.test(w) ? '版' : /^RC牆/.test(w) ? '牆' : /^樓梯/.test(w) ? '樓梯' : null;

/** Rebar rows of the calculation sheet from the bar list: per floor and member kind; members without a schedule keep the kg/M3 estimate. */
function rebarCalc(calc: CalcRow[], rows: RebarRow[], S: TakeoffSettings): CalcRow[] {
  const out = calc.filter(c => !REBAR_ITEMS.includes(c.item));
  const done = new Set(rows.map(r => `${r.fl}|${r.kind}`));
  const g = new Map<string, { fl: string; kind: RebarKind; hi: number; lo: number; n: number }>();
  for (const r of rows) {
    const k = `${r.fl}|${r.kind}`, cur = g.get(k) || { fl: r.fl, kind: r.kind, hi: 0, lo: 0, n: 0 };
    if (r.s >= 6) cur.hi += r.kg; else cur.lo += r.kg;
    cur.n++;
    g.set(k, cur);
  }
  const add: CalcRow[] = [];
  for (const v of g.values()) add.push({ sec: SEC.rc, item: REBAR_ITEMS[0], unit: '噸', fl: v.fl, where: `${v.kind}（依配筋圖，明細 ${v.n} 筆）`,
    expr: `SD420（#6 以上）${r2(v.hi)} kg + SD280（#5 以下）${r2(v.lo)} kg，見鋼筋明細`, q: Math.round((v.hi + v.lo) / 1000 * 1000) / 1000 });
  const est = new Map<string, { fl: string; kind: RebarKind; v: number }>();
  for (const c of calc) {
    if (c.item !== CONCRETE) continue;
    const kind = kindOfWhere(c.where);
    if (!kind || done.has(`${c.fl}|${kind}`)) continue;
    const k = `${c.fl}|${kind}`, cur = est.get(k) || { fl: c.fl, kind, v: 0 };
    cur.v += c.q; est.set(k, cur);
  }
  for (const e of est.values()) add.push({ sec: SEC.rc, item: REBAR_ITEMS[0], unit: '噸', fl: e.fl, where: `${e.kind}（無配筋圖，估算）`, expr: `混凝土 ${r2(e.v)} M3 × ${S.rebar} kg/M3 ÷ 1000`, q: Math.round(e.v * S.rebar) / 1000 });
  const total = add.reduce((a, c) => a + c.q, 0);
  for (const item of REBAR_ITEMS.slice(1)) add.push({ sec: SEC.rc, item, unit: '噸', fl: '整棟', where: '同鋼筋', expr: `鋼筋合計 ${r2(total)} 噸`, q: Math.round(total * 1000) / 1000 });
  return [...out, ...add];
}
