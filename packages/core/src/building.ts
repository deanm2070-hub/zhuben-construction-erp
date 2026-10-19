import { UNIT_SCALE, guessLayerKind, guessUnits } from './cadImport';
import type { DxfDrawing, DxfSeg, DxfText } from './dxf';
import { pairWalls, wallBox } from './geometry';
import { WALL_H } from './sample';
import type { BoxObject, CadData, CadFloor, DoorObject, ModelObject } from './types';

/**
 * Whole-building import from a drawing set that has every sheet in model space
 * (a typical Taiwanese 執照圖 DWG): floor plans, elevations / sections with level
 * marks, and a door & window schedule. Each plan becomes one or more storeys.
 */

export type ViewKind = 'plan' | 'elevation' | 'section' | 'schedule';
export interface SheetView {
  title: string;
  kind: ViewKind;
  /** title position (drawing units); the view sits above and to the right of it */
  x: number;
  y: number;
  box: [number, number, number, number];
  /** storey keys a plan stands for, e.g. ['3F', '4F'] */
  floors: string[];
}
export interface ScheduleItem { code: string; w: number; h: number; name: string; sill: number; kind: 'door' | 'window' }
export interface Storey { key: string; title: string; base: number; h: number }
export interface BuildingAnalysis {
  views: SheetView[];
  plans: SheetView[];
  /** level name → height above the first floor, cm */
  levels: Record<string, number>;
  storeys: Storey[];
  schedule: ScheduleItem[];
  parapet: number;
  /** drawing units → cm */
  scale: number;
}

const TITLE_RE = /(平面圖|立面圖|剖面圖|門窗表|門窗圖|門窗詳圖)$/;
const SKIP_RE = /綠化|檢討|面積|計算|配置|位置|覆土|景觀|消防|排水|基地|地籍|樓梯|詳圖|大樣|結構|管線|水電|求積|透視/;
const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNum(s: string): number {
  if (/^\d+$/.test(s)) return +s;
  if (s === '十') return 10;
  const i = s.indexOf('十');
  if (i < 0) return CN[s] || NaN;
  return (i === 0 ? 1 : CN[s[0]]) * 10 + (s[i + 1] ? CN[s[i + 1]] : 0);
}

/** Storey keys a plan title stands for: 一層→1F, 三層及四層→3F,4F, 二至五層→2F…5F, 屋突一層→R1F, 屋頂層→RF, 地下一層→B1F. */
export function parseFloors(title: string): string[] {
  const t = title.replace(/\s/g, '').replace(/平面圖$/, '');
  if (/屋頂/.test(t) && !/屋突/.test(t)) return ['RF'];
  const out: string[] = [];
  const re = /(地下|屋突|B|R)?([一二三四五六七八九十]+|\d+)(?:層|樓|F|f)?(?:\s*([至~～到\-])\s*(地下|屋突|B|R)?([一二三四五六七八九十]+|\d+)(?:層|樓|F|f)?)?/g;
  for (const m of t.matchAll(re)) {
    const pre = m[1] === '地下' || m[1] === 'B' ? 'B' : m[1] === '屋突' || m[1] === 'R' ? 'R' : '';
    const a = cnNum(m[2]);
    if (!a) continue;
    const b = m[5] ? cnNum(m[5]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(`${pre}${n}F`);
  }
  return [...new Set(out)];
}

const levelOrder = (k: string) => {
  const m = /^(B|R)?(\d+)F$/.exec(k);
  if (k === 'RF') return 2000;
  if (!m) return 5000;
  return m[1] === 'B' ? -+m[2] : m[1] === 'R' ? 1000 + +m[2] : +m[2];
};
const normLevel = (s: string) => {
  const t = s.replace(/\s/g, '').toUpperCase();
  if (/^(B\d+F|\d+F|R\d+F|RF|PRF)$/.test(t)) return t === 'PRF' ? 'RF' : t;
  if (/^(B\d+|\d+)FL$/.test(t)) return t.slice(0, -1);
  return null;
};

const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * q)] : NaN; };
const inBox = (b: SheetView['box'], x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Finds view titles and the region each view occupies. */
export function findViews(d: DxfDrawing): SheetView[] {
  const cand = d.texts.filter(t => TITLE_RE.test(t.s.replace(/\s/g, '')) && t.s.length <= 20);
  if (!cand.length) return [];
  const hMax = Math.max(...cand.map(t => t.h || 0));
  const titles = cand.filter(t => !hMax || (t.h || 0) >= hMax * 0.7)
    .filter((t, i, a) => a.findIndex(o => o.s === t.s && Math.hypot(o.x - t.x, o.y - t.y) < (hMax || 1)) === i);
  const gaps: number[] = [];
  for (const t of titles) {
    let best = Infinity;
    for (const o of titles) if (o !== t && o.x > t.x && Math.abs(o.y - t.y) < (hMax || 10) * 2) best = Math.min(best, o.x - t.x);
    if (isFinite(best)) gaps.push(best);
  }
  // sheets often skip a slot, so the typical view width is the smaller spacings
  const w = quantile(gaps, 0.25) || (hMax ? hMax * 30 : 3000);
  return titles.filter(t => !SKIP_RE.test(t.s)).map(t => {
    const s = t.s.replace(/\s/g, '');
    const kind: ViewKind = /平面圖$/.test(s) ? 'plan' : /立面圖$/.test(s) ? 'elevation' : /剖面圖$/.test(s) ? 'section' : 'schedule';
    let top = w * 1.3;
    for (const o of titles) if (o !== t && o.y > t.y + w * 0.2 && Math.abs(o.x - t.x) < w * 0.5) top = Math.min(top, o.y - t.y);
    const box: SheetView['box'] = kind === 'schedule'
      ? [t.x - w * 0.3, t.y - w * 0.05, t.x + w * 2, t.y + top]
      : [t.x - w * 0.15, t.y - w * 0.02, t.x + w * 0.85, t.y + top];
    return { title: s, kind, x: t.x, y: t.y, box, floors: kind === 'plan' ? parseFloors(s) : [] };
  });
}

/** Door / window schedule: a code next to "W x H 名稱", sill read from the elevation drawn in its cell (bottom of the frame above the FL line). */
export function parseSchedule(d: DxfDrawing): ScheduleItem[] {
  const SIZE = /^(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(.*)$/;
  const items: ScheduleItem[] = [];
  const fl = d.texts.filter(t => /^F\.?L\.?$/i.test(t.s.trim()));
  const openSegs = d.segs.filter(s => /OPEN|DOOR|WIN|門|窗/i.test(s.layer));
  for (const t of d.texts) {
    const m = SIZE.exec(t.s.trim());
    if (!m || !/[門窗]/.test(m[3])) continue;
    const h = t.h || 20;
    const code = d.texts.filter(c => /^[A-Z]{1,3}\d{0,3}[A-Z]?$/.test(c.s.trim()) && Math.abs(c.y - t.y) < h * 0.6 && c.x < t.x && t.x - c.x < h * 8)
      .sort((a, b) => b.x - a.x)[0];
    if (!code || items.some(i => i.code === code.s.trim())) continue;
    const name = m[3].trim(), kind = /門/.test(name) && !/窗/.test(name) ? 'door' : 'window';
    let sill = kind === 'door' ? 0 : 90;
    const f = fl.filter(q => q.y < t.y && t.y - q.y < h * 40 && q.x > code.x && q.x - code.x < h * 50)
      .sort((a, b) => Math.round((a.y - b.y) / h) * -1 || a.x - b.x)[0];
    if (f) {
      const x0 = code.x - h * 2, x1 = f.x;
      // the FL text sits on the floor line; use the line itself when there is one
      const line = d.segs.filter(s => Math.abs(s.a[1] - s.b[1]) < 0.1 && s.a[1] <= f.y + h * 0.2 && s.a[1] > f.y - h && Math.min(s.a[0], s.b[0]) < x1 && Math.max(s.a[0], s.b[0]) > x1 - h * 3)
        .sort((a, b) => b.a[1] - a.a[1])[0];
      const flY = line ? line.a[1] : f.y;
      let bottom = Infinity, top = -Infinity;
      for (const s of openSegs) for (const p of [s.a, s.b]) if (p[0] > x0 && p[0] < x1 && p[1] > flY - h && p[1] < t.y - h) { bottom = Math.min(bottom, p[1]); top = Math.max(top, p[1]); }
      // cell drawings are usually at a larger scale than the plans, so measure against the drawn height
      if (top - bottom > h * 0.5) sill = Math.max(0, Math.round((bottom - flY) / (top - bottom) * +m[2] / 5) * 5);
    }
    items.push({ code: code.s.trim(), w: +m[1], h: +m[2], name, sill, kind });
  }
  return items;
}

/** Level marks (1F, 2F … R1F, RF) from the elevation or section that shows the most of them. Heights in cm above 1F. */
export function readLevels(d: DxfDrawing, views: SheetView[], scale: number): Record<string, number> {
  const marks = d.texts.map(t => ({ k: normLevel(t.s), t })).filter((m): m is { k: string; t: DxfText } => !!m.k);
  let best: { k: string; t: DxfText }[] = [];
  for (const v of views.filter(v => v.kind === 'elevation' || v.kind === 'section')) {
    const inside = marks.filter(m => inBox(v.box, m.t.x, m.t.y));
    if (new Set(inside.map(m => m.k)).size > new Set(best.map(m => m.k)).size) best = inside;
  }
  if (!best.length) return {};
  const y: Record<string, number> = {};
  for (const m of best) if (!(m.k in y)) y[m.k] = m.t.y;
  const keys = Object.keys(y).sort((a, b) => levelOrder(a) - levelOrder(b));
  const ref = y['1F'] ?? y[keys.find(k => !k.startsWith('B')) || keys[0]];
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Math.round((y[k] - ref) * scale);
  return out;
}

export function analyzeBuilding(d: DxfDrawing, defaultH = WALL_H): BuildingAnalysis | null {
  const views = findViews(d);
  const plans = views.filter(v => v.kind === 'plan' && v.floors.length);
  if (!plans.length) return null;
  const scale = UNIT_SCALE[guessUnits(d)] || 1;
  const levels = readLevels(d, views, scale);
  const schedule = parseSchedule(d);
  const pm = d.texts.map(t => /女兒牆[^0-9]{0,6}(\d{2,3})\s*(㎝|cm|公分)/i.exec(t.s)).find(Boolean);
  const parapet = pm ? +pm[1] : 120;
  const keys = [...new Set(plans.flatMap(p => p.floors))].sort((a, b) => levelOrder(a) - levelOrder(b));
  const lv = Object.entries(levels).sort((a, b) => a[1] - b[1]);
  const storeys: Storey[] = [];
  let base = 0;
  for (const [i, k] of keys.entries()) {
    if (k in levels) base = levels[k];
    else if (i > 0) base = storeys[i - 1].base + storeys[i - 1].h;
    const above = lv.find(([, v]) => v > base + 1);
    const h = k === 'RF' || (!above && i === keys.length - 1 && k.startsWith('R')) ? parapet : above ? above[1] - base : defaultH;
    storeys.push({ key: k, title: plans.find(p => p.floors.includes(k))!.title, base, h });
  }
  return { views, plans, levels, storeys, schedule, parapet, scale };
}

const isWallLayer = (l: string) => guessLayerKind(l) === 'wall' || /^COL/i.test(l);
const isOpenLayer = (l: string) => /OPEN|DOOR|WIN|門|窗/i.test(l) && !/編號|TAG|TEXT/i.test(l);

interface PlanGeo { segs: DxfSeg[]; ox: number; oy: number }

/** Plan geometry and the origin used to stack floors: the first numbered grid line and grid line A when the plan has grid bubbles. */
function planGeo(d: DxfDrawing, v: SheetView): PlanGeo {
  const segs = d.segs.filter(s => inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1]));
  const grid = d.texts.filter(t => /GTAG|GRID|AXIS|軸/i.test(t.layer) && inBox(v.box, t.x, t.y));
  const nums = grid.filter(t => /^\d{1,2}$/.test(t.s)).sort((a, b) => +a.s - +b.s);
  const lets = grid.filter(t => /^[A-Z]$/.test(t.s)).sort((a, b) => a.s.localeCompare(b.s));
  if (nums.length && lets.length) return { segs, ox: nums[0].x, oy: lets[0].y };
  const ws = segs.filter(s => isWallLayer(s.layer));
  return { segs, ox: Math.min(...ws.flatMap(s => [s.a[0], s.b[0]])), oy: Math.max(...ws.flatMap(s => [s.a[1], s.b[1]])) };
}

export interface BuildingResult {
  objects: ModelObject[];
  cad: CadData;
  analysis: BuildingAnalysis;
  stats: { floors: number; walls: number; doors: number; windows: number };
}

/** Builds every storey of the analysed drawing set, stacked at its level. */
export function buildBuilding(d: DxfDrawing, a: BuildingAnalysis, name: string, firstId = 1): BuildingResult {
  const S = a.scale;
  const geos = new Map(a.plans.map(p => [p, planGeo(d, p)]));
  let minX = Infinity, maxY = -Infinity, maxX = -Infinity, minY = Infinity;
  for (const [, g] of geos) for (const s of g.segs) if (isWallLayer(s.layer)) for (const p of [s.a, s.b]) {
    minX = Math.min(minX, p[0] - g.ox); maxX = Math.max(maxX, p[0] - g.ox); minY = Math.min(minY, p[1] - g.oy); maxY = Math.max(maxY, p[1] - g.oy);
  }
  const W = (maxX - minX) * S, D = (maxY - minY) * S;
  const codes = new Map(a.schedule.map(i => [i.code, i]));
  let id = firstId;
  const objects: ModelObject[] = [];
  const floors: CadFloor[] = [];
  let nWalls = 0, nDoors = 0, nWins = 0;

  for (const st of a.storeys) {
    const plan = a.plans.find(p => p.floors.includes(st.key))!, g = geos.get(plan)!;
    const X = (x: number) => (x - g.ox - minX) * S, Z = (y: number) => (maxY - (y - g.oy)) * S;
    const H = st.h, parapet = st.key === 'RF';
    const lines = pairWalls(g.segs.filter(s => isWallLayer(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) })));
    const openSegs = g.segs.filter(s => isOpenLayer(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const swings = d.arcs.filter(c => isOpenLayer(c.layer) && inBox(plan.box, c.c[0], c.c[1]) && c.sweep > 70 && c.sweep < 110 && c.r * S >= 50 && c.r * S <= 200 && c.p0 && c.p1)
      .map(c => ({ x: X(c.c[0]), z: Z(c.c[1]), r: c.r * S, ends: [[X(c.p0![0]), Z(c.p0![1])], [X(c.p1![0]), Z(c.p1![1])]] as [number, number][] }));
    const tags: { code: string; x: number; z: number }[] = [];
    for (const t of d.texts) {
      const c = t.s.trim();
      if (!codes.has(c) || !inBox(plan.box, t.x, t.y)) continue;
      const x = X(t.x), z = Z(t.y);
      if (!tags.some(o => o.code === c && Math.hypot(o.x - x, o.z - z) < 5)) tags.push({ code: c, x, z });
    }
    const add = (o: Omit<BoxObject, 'id' | 'floor'>) => objects.push({ ...o, id: id++, floor: st.key, y: st.base + o.y });

    // unpaired diagonal lines are usually shaft crosses or hatching, not walls
    const walls = dropLouvers(lines.filter(w => !w.single || Math.abs(w.ax - w.bx) < 1 || Math.abs(w.az - w.bz) < 1).map(w => wallBox(w, H, 0)));
    const openings = parapet ? [] : findOpenings(walls, openSegs, swings);
    for (const b of walls) if (b.w > 1 && b.d > 1) add({ ...b, y: 0, name: parapet ? '女兒牆（CAD）' : b.name });
    nWalls += walls.length;
    for (const op of openings) {
      const tag = tags.filter(t => Math.hypot(t.x - op.cx, t.z - op.cz) < 200).sort((p, q) => Math.hypot(p.x - op.cx, p.z - op.cz) - Math.hypot(q.x - op.cx, q.z - op.cz))[0];
      const it = tag ? codes.get(tag.code)! : null;
      const door = it ? it.kind === 'door' : op.arc;
      const sill = it ? it.sill : door ? 0 : 90;
      const oh = Math.min(H - sill, it ? it.h : door ? 210 : 150);
      const label = it ? `${it.code} ${it.name} ${it.w}×${it.h}` : door ? `門 ${Math.round(op.len)}×210` : `窗 ${Math.round(op.len)}×150`;
      const along = op.axis === 'x';
      const box = (y: number, h: number, nm: string, layer: BoxObject['layer'], color: number, t = op.t) =>
        add({ layer, name: nm, x: op.cx, z: op.cz, w: along ? op.len : t, d: along ? t : op.len, h, y, color });
      const outer = op.t >= 18;
      if (sill > 0) box(0, sill, outer ? '窗台（CAD）' : '隔間牆下（CAD）', 'wall', 0xeeebe5);
      if (H - sill - oh > 0) box(sill + oh, H - sill - oh, outer ? '窗楣（CAD）' : '隔間門楣（CAD）', 'wall', 0xeeebe5);
      if (door) {
        const dObj: DoorObject = { id: id++, layer: 'door', name: label, axis: op.axis, at: along ? op.cz : op.cx, a: op.a, b: op.b, flip: 0, color: 0x9a6a43, floor: st.key, y: st.base, h: oh };
        objects.push(dObj);
        nDoors++;
      } else {
        box(sill, oh, label, 'glass', 0xa9dcff, Math.min(op.t, 6));
        nWins++;
      }
    }
    const segs: number[] = [];
    for (const s of g.segs) if (!isWallLayer(s.layer) && !/GRID|GTAG|AXIS|軸|DIM|標註|Defpoints|AREA|TEXT|圖框/i.test(s.layer)) segs.push(X(s.a[0]), Z(s.a[1]), X(s.b[0]), Z(s.b[1]));
    const texts = d.texts.filter(t => inBox(plan.box, t.x, t.y) && /^TEXT$|ROOM|室名|空間/i.test(t.layer) && /[一-鿿]/.test(t.s) && t.s.length <= 12 && !/[0-9]{2,}|㎡|坪|高度|詳|說明|同|$^/.test(t.s))
      .map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }))
      .filter(t => t.x > -50 && t.z > -50 && t.x < W + 50 && t.z < D + 50);
    floors.push({ key: st.key, title: plan.title, y: st.base, h: H, segs, texts });
  }
  return {
    objects,
    cad: { name, W, D, segs: [], texts: [], doors: [], floors },
    analysis: a,
    stats: { floors: floors.length, walls: nWalls, doors: nDoors, windows: nWins },
  };
}

/** Removes rows of identical short strips (louvres, grilles, shading fins, their cross lines) that pair up like walls. */
function dropLouvers(boxes: BoxObject[]): BoxObject[] {
  return boxes.filter(o => {
    // a few degrees off square is a cross line paired with its neighbour, not a wall
    const off = Math.abs(((o.rot || 0) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2));
    if (Math.min(off, Math.PI / 2 - off) > 0.01 && Math.min(off, Math.PI / 2 - off) < 0.25) return false;
    if (Math.max(o.w, o.d) > 300 || Math.min(o.w, o.d) >= 30) return true;
    const twins = boxes.filter(q => q !== o && Math.abs((q.rot || 0) - (o.rot || 0)) < 0.02 && Math.abs(q.w - o.w) < 3 && Math.abs(q.d - o.d) < 3 && Math.hypot(q.x - o.x, q.z - o.z) < 150);
    return twins.length < 3;
  });
}

interface Opening { axis: 'x' | 'z'; cx: number; cz: number; a: number; b: number; len: number; t: number; arc: boolean }
type Seg2 = { x1: number; z1: number; x2: number; z2: number };
type Swing = { x: number; z: number; r: number; ends: [number, number][] };

/**
 * Door and window openings in a storey's walls. Walls are axis-aligned boxes and get
 * trimmed where they reach into an opening (pairWalls lengthens walls by half their
 * thickness so corners close). Doors come from swing arcs, windows and other openings
 * from door / window linework lying between two walls or columns.
 */
export function findOpenings(boxes: BoxObject[], openSegs: Seg2[], swings: Swing[]): Opening[] {
  const out: Opening[] = [];
  const solid = boxes.filter(o => !o.rot);
  // along / across coordinates of a box for an opening running along `axis`
  const span = (o: BoxObject, axis: 'x' | 'z') => axis === 'x'
    ? { lo: o.x - o.w / 2, hi: o.x + o.w / 2, c: o.z, half: o.d / 2 }
    : { lo: o.z - o.d / 2, hi: o.z + o.d / 2, c: o.x, half: o.w / 2 };
  const isRun = (o: BoxObject, axis: 'x' | 'z') => axis === 'x' ? o.w > o.d * 1.5 : o.d > o.w * 1.5;
  /** first wall face hit going from u along the line `at`, in direction dir */
  const cast = (axis: 'x' | 'z', at: number, u: number, dir: 1 | -1, max: number, behind = false) => {
    let best: { u: number; o: BoxObject } | null = null;
    for (const o of solid) {
      const sp = span(o, axis);
      if (Math.abs(sp.c - at) > sp.half + 0.5) continue;
      const face = dir > 0 ? sp.lo : sp.hi;
      // walls are lengthened by half their thickness, so a jamb face may sit that far behind a hinge
      if ((face - u) * dir < -(behind ? sp.half + 1 : 1) || Math.abs(face - u) > max) continue;
      if (!best || (face - best.u) * dir < 0) best = { u: face, o };
    }
    return best;
  };
  const insideWall = (x: number, z: number) => solid.some(o => Math.abs(x - o.x) < o.w / 2 - 0.5 && Math.abs(z - o.z) < o.d / 2 - 0.5);
  const taken = (axis: 'x' | 'z', at: number, a: number, b: number) => out.some(o => o.axis === axis && Math.abs((axis === 'x' ? o.cz : o.cx) - at) < 30 && o.a < b - 5 && o.b > a + 5);
  const push = (axis: 'x' | 'z', at: number, a: number, b: number, t: number, arc: boolean) => {
    if (b - a < 50 || b - a > 450 || taken(axis, at, a, b)) return;
    out.push({ axis, cx: axis === 'x' ? (a + b) / 2 : at, cz: axis === 'x' ? at : (a + b) / 2, a, b, len: b - a, t, arc });
  };

  // doors: the closed leaf runs from the hinge along the wall, and the wall continues behind the hinge
  for (const s of swings) {
    const cands: { axis: 'x' | 'z'; at: number; a: number; b: number; t: number; run: boolean }[] = [];
    for (const [ex, ez] of s.ends) {
      const dx = ex - s.x, dz = ez - s.z;
      const axis = Math.abs(dx) > Math.abs(dz) * 4 ? 'x' : Math.abs(dz) > Math.abs(dx) * 4 ? 'z' : null;
      if (!axis) continue;
      const dir = (axis === 'x' ? dx : dz) > 0 ? 1 : -1;
      const u0 = axis === 'x' ? s.x : s.z, at0 = axis === 'x' ? s.z : s.x;
      const jamb = cast(axis, at0, u0, dir === 1 ? -1 : 1, 25, true);
      if (!jamb) continue;
      const sp = span(jamb.o, axis), run = isRun(jamb.o, axis), end = u0 + dir * s.r;
      cands.push({ axis, at: run ? sp.c : at0, a: Math.min(u0, end), b: Math.max(u0, end), t: run ? sp.half * 2 : 20, run });
    }
    // the closed leaf lies along a wall; next to a column either end can look like a jamb
    const c = cands.find(q => q.run) || (cands.length === 1 ? cands[0] : null);
    if (c) push(c.axis, c.at, c.a, c.b, c.t, true);
  }

  // other openings: linework between two walls / columns
  for (const s of openSegs) {
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1, L = Math.hypot(dx, dz);
    if (L < 40) continue;
    const axis = Math.abs(dz) < 0.5 ? 'x' : Math.abs(dx) < 0.5 ? 'z' : null;
    if (!axis) continue;
    const at0 = axis === 'x' ? s.z1 : s.x1, m = axis === 'x' ? (s.x1 + s.x2) / 2 : (s.z1 + s.z2) / 2;
    if (insideWall(axis === 'x' ? m : at0, axis === 'x' ? at0 : m)) continue;
    const lo = cast(axis, at0, m, -1, 450), hi = cast(axis, at0, m, 1, 450);
    if (!lo || !hi || hi.u - lo.u < 50 || hi.u - lo.u > 450 || L < (hi.u - lo.u) * 0.4) continue;
    if (taken(axis, at0, lo.u, hi.u)) continue;
    // centre and thickness from the jambs when they are walls on this line, else from the linework
    const runs = [lo.o, hi.o].filter(o => isRun(o, axis));
    let at = at0, t = 20;
    if (runs.length) { const sp = span(runs[0], axis); at = sp.c; t = sp.half * 2; }
    else {
      const par = openSegs.filter(q => (axis === 'x' ? Math.abs(q.z1 - q.z2) < 0.5 : Math.abs(q.x1 - q.x2) < 0.5)
        && Math.abs((axis === 'x' ? q.z1 : q.x1) - at0) < 30
        && Math.min(axis === 'x' ? q.x1 : q.z1, axis === 'x' ? q.x2 : q.z2) < hi.u && Math.max(axis === 'x' ? q.x1 : q.z1, axis === 'x' ? q.x2 : q.z2) > lo.u)
        .map(q => axis === 'x' ? q.z1 : q.x1);
      at = (Math.min(...par) + Math.max(...par)) / 2;
      t = Math.min(30, Math.max(10, Math.max(...par) - Math.min(...par) + 4));
    }
    // the frame usually runs under the wall ends that pairWalls lengthened; take its full width
    let a = lo.u, b = hi.u;
    for (const q of openSegs) {
      const qa = axis === 'x' ? Math.min(q.x1, q.x2) : Math.min(q.z1, q.z2), qb = axis === 'x' ? Math.max(q.x1, q.x2) : Math.max(q.z1, q.z2);
      const v = axis === 'x' ? (q.z1 + q.z2) / 2 : (q.x1 + q.x2) / 2;
      if (Math.abs(v - at0) > 30 || qb < lo.u || qa > hi.u) continue;
      a = Math.min(a, Math.max(qa, lo.u - 15)); b = Math.max(b, Math.min(qb, hi.u + 15));
    }
    push(axis, at, a, b, t, false);
  }

  // trim wall ends that reach into an opening (at most half the wall's thickness)
  for (const op of out) for (const o of solid) {
    if (!isRun(o, op.axis)) continue;
    const sp = span(o, op.axis);
    if (Math.abs(sp.c - (op.axis === 'x' ? op.cz : op.cx)) > sp.half + 1) continue;
    const lim = sp.half + 2;
    let { lo, hi } = sp;
    if (hi > op.a && hi - op.a <= lim && lo < op.a) hi = op.a;
    else if (lo < op.b && op.b - lo <= lim && hi > op.b) lo = op.b;
    else continue;
    if (op.axis === 'x') { o.x = (lo + hi) / 2; o.w = hi - lo; } else { o.z = (lo + hi) / 2; o.d = hi - lo; }
  }
  return out;
}
