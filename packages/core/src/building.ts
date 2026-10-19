import { UNIT_SCALE, guessLayerKind, guessUnits } from './cadImport';
import type { DxfDrawing, DxfSeg, DxfText, Pt } from './dxf';
import { pairWalls, wallBox } from './geometry';
import { WALL_H } from './sample';
import { findFlights, planStairs, type StairFlight, type StairPlan } from './stairs';
import { HEIGHT_NOTE, isDoorType, openingName, openingType, PLAN_NOTES, type OpeningType } from './legend';
import type { BoxObject, CadData, CadFloor, DoorObject, ModelObject } from './types';

/**
 * Whole-building import from a drawing set that has every sheet in model space
 * (a typical Taiwanese 執照圖 DWG): floor plans, elevations / sections with level
 * marks, and a door & window schedule. Each plan becomes one or more storeys.
 */

export type ViewKind = 'plan' | 'elevation' | 'section' | 'schedule' | 'structure';
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
export interface ScheduleItem { code: string; w: number; h: number; name: string; sill: number; kind: 'door' | 'window'; type: OpeningType }
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
const SKIP_RE = /綠化|檢討|面積|計算|配置|位置|覆土|景觀|消防|排水|基地|地籍|樓梯|詳圖|大樣|結構|管線|水電|求積|透視|[梁樑]|配筋|基礎|樓版|版筋|柱|框架|筏|椿|樁/;
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
  // each file of a merged set has its own title size and sheet spacing
  if (d.parts && d.parts.length > 1) return d.parts.flatMap(p => findViews({ ...d, parts: undefined, texts: d.texts.filter(t => t.x >= p.x0 - 1 && t.x <= p.x1 + 1) }));
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
  const STRUCT = /結構平面圖$/;
  return titles.filter(t => STRUCT.test(t.s.replace(/\s/g, '')) || !SKIP_RE.test(t.s)).map(t => {
    const s = t.s.replace(/\s/g, '');
    const kind: ViewKind = STRUCT.test(s) ? 'structure' : /平面圖$/.test(s) ? 'plan' : /立面圖$/.test(s) ? 'elevation' : /剖面圖$/.test(s) ? 'section' : 'schedule';
    let top = w * 1.3;
    for (const o of titles) if (o !== t && o.y > t.y + w * 0.2 && Math.abs(o.x - t.x) < w * 0.5) top = Math.min(top, o.y - t.y);
    const box: SheetView['box'] = kind === 'schedule'
      ? [t.x - w * 0.3, t.y - w * 0.05, t.x + w * 2, t.y + top]
      : [t.x - w * 0.15, t.y - w * 0.02, t.x + w * 0.85, t.y + top];
    // 基礎及一層結構平面圖 → 1F (its foundation beams sit under the ground floor)
    const floors = kind === 'plan' ? parseFloors(s) : kind === 'structure' ? parseFloors(s.replace(STRUCT, '').replace(/^基礎及?/, '')) : [];
    return { title: s, kind, x: t.x, y: t.y, box, floors };
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
    const cd = code.s.trim(), type = openingType(cd, m[3].trim()), name = openingName(cd, m[3].trim());
    const kind = isDoorType(type) ? 'door' : 'window';
    let sill = kind === 'door' || type === 'french' ? 0 : 90;
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
      if (top - bottom > h * 0.5 && type !== 'french') sill = Math.max(0, Math.round((bottom - flY) / (top - bottom) * +m[2] / 5) * 5);
    }
    items.push({ code: cd, w: +m[1], h: +m[2], name, sill, kind, type });
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
  // when two files both have a plan of a storey (architectural and structural), the one with the most wall lines wins
  const walls = (v: SheetView) => d.segs.filter(s => isWallLayer(s.layer) && inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1])).length;
  const plans = views.filter(v => v.kind === 'plan' && v.floors.length).map(v => ({ v, n: walls(v) })).sort((a, b) => b.n - a.n).map(p => p.v);
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

interface PlanGeo { segs: DxfSeg[]; ox: number; oy: number; gx: number[]; gy: number[] }

/** Plan geometry and the origin used to stack floors: the first numbered grid line and grid line A when the plan has grid bubbles. */
function planGeo(d: DxfDrawing, v: SheetView): PlanGeo {
  const segs = d.segs.filter(s => inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1]));
  const grid = d.texts.filter(t => /GTAG|GRID|AXIS|軸/i.test(t.layer) && inBox(v.box, t.x, t.y));
  const nums = grid.filter(t => /^\d{1,2}$/.test(t.s)).sort((a, b) => +a.s - +b.s);
  const lets = grid.filter(t => /^[A-Z]$/.test(t.s)).sort((a, b) => a.s.localeCompare(b.s));
  const gx = [...new Set(nums.map(t => Math.round(t.x)))], gy = [...new Set(lets.map(t => Math.round(t.y)))];
  if (nums.length && lets.length) return { segs, ox: nums[0].x, oy: lets[0].y, gx, gy };
  const ws = segs.filter(s => isWallLayer(s.layer));
  return { segs, ox: Math.min(...ws.flatMap(s => [s.a[0], s.b[0]])), oy: Math.max(...ws.flatMap(s => [s.a[1], s.b[1]])), gx, gy };
}

/** Slab thickness used for the 3D floor plates, cm. */
const SLAB = 15;

/** Along / across coordinates of an axis-aligned box for a line running along `axis`. */
const spanOf = (o: BoxObject, axis: 'x' | 'z') => axis === 'x'
  ? { lo: o.x - o.w / 2, hi: o.x + o.w / 2, c: o.z, half: o.d / 2 }
  : { lo: o.z - o.d / 2, hi: o.z + o.d / 2, c: o.x, half: o.w / 2 };
const runsAlong = (o: BoxObject, axis: 'x' | 'z') => !o.rot && (axis === 'x' ? o.w > o.d * 1.5 : o.d > o.w * 1.5);
const setSpan = (o: BoxObject, axis: 'x' | 'z', lo: number, hi: number) => {
  if (axis === 'x') { o.x = (lo + hi) / 2; o.w = hi - lo; } else { o.z = (lo + hi) / 2; o.d = hi - lo; }
};

/**
 * A tag with no opening next to it: the window or door is drawn across a continuous wall.
 * Find its frame lines near the tag and cut an opening of the schedule width into that wall.
 */
function cutTagged(walls: BoxObject[], tag: { code: string; x: number; z: number }, width: number, openSegs: { x1: number; z1: number; x2: number; z2: number }[]): Opening | null {
  let best: { axis: 'x' | 'z'; wall: BoxObject; u: number; d: number } | null = null;
  for (const s of openSegs) {
    const axis = Math.abs(s.z1 - s.z2) < 0.5 ? 'x' : Math.abs(s.x1 - s.x2) < 0.5 ? 'z' : null;
    if (!axis) continue;
    const L = Math.abs(axis === 'x' ? s.x2 - s.x1 : s.z2 - s.z1);
    const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2, d = Math.hypot(mx - tag.x, mz - tag.z);
    if (L < width * 0.4 || d > 150 || (best && d >= best.d)) continue;
    const u = axis === 'x' ? mx : mz, v = axis === 'x' ? mz : mx;
    const wall = walls.find(o => runsAlong(o, axis) && Math.abs(spanOf(o, axis).c - v) <= spanOf(o, axis).half + 3 && u > spanOf(o, axis).lo + width / 2 - 5 && u < spanOf(o, axis).hi - width / 2 + 5);
    if (wall) best = { axis, wall, u, d };
  }
  if (!best) return null;
  const { axis, wall, u } = best, sp = spanOf(wall, axis);
  const a = Math.max(sp.lo, u - width / 2), b = Math.min(sp.hi, u + width / 2);
  if (b - a < width * 0.8) return null;
  // split the wall around the opening
  if (sp.hi - b > 1) walls.push({ ...wall, ...(axis === 'x' ? { x: (b + sp.hi) / 2, w: sp.hi - b } : { z: (b + sp.hi) / 2, d: sp.hi - b }) });
  if (a - sp.lo > 1) setSpan(wall, axis, sp.lo, a); else setSpan(wall, axis, 0, 0);
  return { axis, cx: axis === 'x' ? (a + b) / 2 : sp.c, cz: axis === 'x' ? sp.c : (a + b) / 2, a, b, len: b - a, t: sp.half * 2, arc: false, tag: tag.code };
}

/** Closes short breaks (up to 70 cm) between pieces of the same wall where nothing else (column, opening) sits. */
function fillGaps(walls: BoxObject[], openings: Opening[]) {
  for (const axis of ['x', 'z'] as const) {
    const runs = walls.filter(o => runsAlong(o, axis) && o.w > 1 && o.d > 1);
    for (const w of runs) {
      const sw = spanOf(w, axis);
      let nxt: BoxObject | null = null;
      for (const o of runs) {
        const so = spanOf(o, axis);
        if (o === w || Math.abs(so.c - sw.c) > 3 || Math.abs(so.half - sw.half) > 3 || so.lo < sw.hi - 0.5) continue;
        if (!nxt || so.lo < spanOf(nxt, axis).lo) nxt = o;
      }
      if (!nxt) continue;
      const gap = spanOf(nxt, axis).lo - sw.hi;
      if (gap < 0.5 || gap > 70) continue;
      const mu = sw.hi + gap / 2, px = axis === 'x' ? mu : sw.c, pz = axis === 'x' ? sw.c : mu;
      if (walls.some(o => o !== w && o !== nxt && !o.rot && Math.abs(px - o.x) < o.w / 2 + 1 && Math.abs(pz - o.z) < o.d / 2 + 1)) continue;
      if (openings.some(op => op.axis === axis && Math.abs((axis === 'x' ? op.cz : op.cx) - sw.c) < 30 && mu > op.a - 5 && mu < op.b + 5)) continue;
      setSpan(w, axis, sw.lo, sw.hi + gap);
    }
  }
}

/** 10 cm occupancy grid of a storey's wall boxes, with a margin around the plan. */
function raster(walls: BoxObject[], W: number, D: number, M = 80) {
  const C = 10, nx = Math.ceil((W + 2 * M) / C), nz = Math.ceil((D + 2 * M) / C), N = nx * nz;
  const wall = new Uint8Array(N);
  for (const o of walls) {
    if (o.w <= 1 || o.d <= 1) continue;
    const c = Math.cos(o.rot || 0), sn = Math.sin(o.rot || 0), r = Math.hypot(o.w, o.d) / 2;
    for (let j = Math.max(0, Math.floor((o.z - r + M) / C)); j <= Math.min(nz - 1, Math.ceil((o.z + r + M) / C)); j++)
      for (let i = Math.max(0, Math.floor((o.x - r + M) / C)); i <= Math.min(nx - 1, Math.ceil((o.x + r + M) / C)); i++) {
        const dx = i * C + C / 2 - M - o.x, dz = j * C + C / 2 - M - o.z;
        if (Math.abs(dx * c - dz * sn) <= o.w / 2 + 2 && Math.abs(dx * sn + dz * c) <= o.d / 2 + 2) wall[j * nx + i] = 1;
      }
  }
  const nb = (k: number) => { const i = k % nx, j = (k / nx) | 0, o: number[] = []; if (i > 0) o.push(k - 1); if (i < nx - 1) o.push(k + 1); if (j > 0) o.push(k - nx); if (j < nz - 1) o.push(k + nx); return o; };
  const cell = (x: number, z: number) => { const i = Math.floor((x + M) / C), j = Math.floor((z + M) / C); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };
  /** cells of the space around (x, z) bounded by walls, or null when it is larger than `limit` cells */
  const region = (x: number, z: number, limit: number) => {
    const k0 = cell(x, z);
    if (k0 < 0 || wall[k0]) return null;
    const seen = new Uint8Array(N), stack = [k0];
    seen[k0] = 1;
    let n = 0;
    while (stack.length) {
      const k = stack.pop()!;
      if (++n > limit) return null;
      for (const m of nb(k)) if (!seen[m] && !wall[m]) { seen[m] = 1; stack.push(m); }
    }
    return seen;
  };
  return { C, M, nx, nz, N, wall, nb, cell, region };
}

/**
 * Floor plate of a storey as rectangles: everything inside the outer walls (doorways up to
 * about a metre are bridged), the walls themselves included, minus shafts and light wells
 * named 天井 / 挑空 / 管道 and the `holes` cut for stairs coming up from below.
 */
export function slabRects(walls: BoxObject[], labels: { x: number; z: number; s: string }[], W: number, D: number, holes: { x0: number; x1: number; z0: number; z1: number }[] = []) {
  const { C, M, nx, nz, N, wall, nb } = raster(walls, W, D);
  const R = 5, dil = new Uint8Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (wall[j * nx + i])
    for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++)
      if ((a - i) ** 2 + (b - j) ** 2 <= R * R) dil[b * nx + a] = 1;
  // outside: flood from the border through the dilated walls, then grow back up to the walls
  const out = new Uint8Array(N);
  let q: number[] = [];
  for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; if ((i === 0 || j === 0 || i === nx - 1 || j === nz - 1) && !dil[k]) { out[k] = 1; q.push(k); } }
  while (q.length) { const k = q.pop()!; for (const m of nb(k)) if (!out[m] && !dil[m]) { out[m] = 1; q.push(m); } }
  for (let step = 0; step < R + 1; step++) {
    const add: number[] = [];
    for (let k = 0; k < N; k++) if (out[k]) for (const m of nb(k)) if (!out[m] && !wall[m]) add.push(m);
    if (!add.length) break;
    for (const m of add) out[m] = 1;
  }
  const keep = new Uint8Array(N);
  for (let k = 0; k < N; k++) keep[k] = out[k] ? 0 : 1;
  for (const h of holes)
    for (let j = Math.max(0, Math.round((h.z0 + M) / C)); j < Math.min(nz, Math.round((h.z1 + M) / C)); j++)
      for (let i = Math.max(0, Math.round((h.x0 + M) / C)); i < Math.min(nx, Math.round((h.x1 + M) / C)); i++) keep[j * nx + i] = 0;
  // voids: flood each shaft label inside its own walls
  for (const l of labels) {
    if (!PLAN_NOTES.void.test(l.s) || PLAN_NOTES.projection.test(l.s)) continue;
    const k0 = Math.floor((l.z + M) / C) * nx + Math.floor((l.x + M) / C);
    if (k0 < 0 || k0 >= N || !keep[k0] || wall[k0]) continue;
    const seen = new Uint8Array(N), stack = [k0];
    seen[k0] = 1;
    let n = 0;
    while (stack.length && n < 4000) { const k = stack.pop()!; n++; for (const m of nb(k)) if (!seen[m] && !wall[m] && keep[m]) { seen[m] = 1; stack.push(m); } }
    if (n < 4000) for (let k = 0; k < N; k++) if (seen[k]) keep[k] = 0; // a void larger than 40 m² is not a shaft
  }
  // merge cells into rectangles: runs per row, stacked while the next row has the same run
  const rects: { x0: number; x1: number; z0: number; z1: number }[] = [];
  const open = new Map<string, { x0: number; x1: number; z0: number; z1: number }>();
  for (let j = 0; j <= nz; j++) {
    const runs: [number, number][] = [];
    if (j < nz) for (let i = 0; i < nx;) { if (!keep[j * nx + i]) { i++; continue; } let e = i; while (e < nx && keep[j * nx + e]) e++; runs.push([i, e]); i = e; }
    const keys = new Set(runs.map(r => `${r[0]},${r[1]}`));
    for (const [k, r] of open) if (!keys.has(k)) { rects.push(r); open.delete(k); }
    for (const [a, b] of runs) {
      const k = `${a},${b}`, z = j * C - M;
      if (open.has(k)) open.get(k)!.z1 = z + C;
      else open.set(k, { x0: a * C - M, x1: b * C - M, z0: z, z1: z + C });
    }
  }
  return rects.filter(r => (r.x1 - r.x0) * (r.z1 - r.z0) >= 400);
}

type EdgeKind = 'balcony' | 'canopy' | 'projection';
/** estimated beam width, cm; the depth comes from the sections */
const BEAM_W = 40;
/** Beam depth drawn in the sections (BEAM layer outlines), else 60 cm. */
function beamDepthOf(d: DxfDrawing, a: BuildingAnalysis) {
  const secs = a.views.filter(v => v.kind === 'section');
  const segs = d.segs.filter(s => /BEAM|梁/i.test(s.layer) && secs.some(v => inBox(v.box, s.a[0], s.a[1])));
  const t = pairWalls(segs.map(s => ({ x1: s.a[0], z1: s.a[1], x2: s.b[0], z2: s.b[1] }))).filter(w => !w.single && Math.abs(w.az - w.bz) < 0.5).map(w => w.t * a.scale).sort((p, q) => p - q);
  const mid = t[Math.floor(t.length / 2)];
  return mid >= 30 && mid <= 120 ? Math.round(mid / 5) * 5 : 60;
}
const STAIR_LAYER = /STAIR|樓梯|階梯/i;

/**
 * Thin wall lines (12 cm or less) that border a space named 陽台 / 露台 / 平台 are its
 * railing or parapet, those bordering a 雨遮 are the canopy edge, and those round a
 * projection note (上方雨遮投影) are not built at all. The outer edge of a 露台 / 平台, and
 * of the roof deck of a 屋突 storey, is its parapet or railing whatever the wall thickness.
 */
function classifyEdges(walls: BoxObject[], shut: BoxObject[], notes: { x: number; z: number; s: string }[], W: number, D: number, roof: boolean) {
  const g = raster([...walls, ...shut], W, D);
  const spaces: { kind: EdgeKind; label: string; cells: Uint8Array }[] = [];
  for (const n of notes) {
    const kind: EdgeKind | null = PLAN_NOTES.projection.test(n.s) ? 'projection' : PLAN_NOTES.canopy.test(n.s) ? 'canopy' : PLAN_NOTES.balcony.test(n.s) && n.s.length <= 8 ? 'balcony' : null;
    if (!kind) continue;
    // labels sit inside their space; a bigger space has leaked out through a doorway that was not found
    const cells = g.region(n.x, n.z, kind === 'balcony' ? 2500 : 4000);
    if (cells) spaces.push({ kind, label: n.s.trim(), cells });
  }
  // a note inside a terrace (上方透空遮陽, 雨遮 drawn over it) does not make the terrace a projection or canopy
  const open = spaces.filter(sp => sp.kind === 'balcony');
  for (let i = spaces.length - 1; i >= 0; i--) {
    const sp = spaces[i];
    if (sp.kind !== 'balcony' && open.some(b => b.cells.some((v, k) => v && sp.cells[k]))) spaces.splice(i, 1);
  }
  // outside the building: flooded in from the margin
  const outside = g.region(-g.M + 1, -g.M + 1, g.N) || new Uint8Array(g.N);
  // on a roof storey everything outdoors that is not the stair / machine rooms is roof deck
  let deck: Uint8Array | null = null;
  if (roof) {
    deck = new Uint8Array(g.N);
    const indoor = new Uint8Array(g.N);
    for (const n of notes) {
      if (!/梯|機房|水箱|室|電梯|梯廳|天井|管道/.test(n.s) || PLAN_NOTES.balcony.test(n.s)) continue;
      const c = g.region(n.x, n.z, 2500);
      if (c) for (let k = 0; k < g.N; k++) if (c[k]) indoor[k] = 1;
    }
    // canopies and projections stay what they are
    for (const sp of spaces) if (sp.kind !== 'balcony') for (let k = 0; k < g.N; k++) if (sp.cells[k]) indoor[k] = 1;
    for (let k = 0; k < g.N; k++) if (!g.wall[k] && !outside[k] && !indoor[k]) deck[k] = 1;
  }
  const out = new Map<BoxObject, { kind: EdgeKind; label: string }>();
  for (const w of walls) {
    if (w.rot || Math.max(w.w, w.d) < 40) continue;
    const along = w.w >= w.d, half = Math.min(w.w, w.d) / 2 + 8, len = Math.max(w.w, w.d), thin = Math.min(w.w, w.d) <= 12;
    const hits = new Map<EdgeKind, number>(), labels: string[] = [];
    let edge = 0, between = 0;
    for (const f of [0.2, 0.5, 0.8]) {
      const u = -len / 2 + len * f;
      // the first open cell past this wall (and any wall layer drawn against it)
      const at = (side: number) => {
        let k = -1;
        for (let o = half; o <= half + 60; o += 5) { k = g.cell(w.x + (along ? u : side * o), w.z + (along ? side * o : u)); if (k < 0 || !g.wall[k]) break; }
        return k;
      };
      const ks = [at(-1), at(1)], here = new Set<EdgeKind>();
      for (const k of ks) for (const sp of spaces) if (k >= 0 && sp.cells[k]) { here.add(sp.kind); if (sp.kind === 'balcony') labels.push(sp.label); }
      for (const h of here) hits.set(h, (hits.get(h) || 0) + 1);
      // a terrace or roof deck on one side and open air on the other: its parapet or railing, however thick
      const terrace = (k: number) => k >= 0 && (spaces.some(sp => sp.cells[k] && sp.kind === 'balcony' && /露台|平台/.test(sp.label)) || !!deck?.[k]);
      const air = (k: number) => k < 0 || !!outside[k];
      if ((terrace(ks[0]) && air(ks[1])) || (terrace(ks[1]) && air(ks[0]))) edge++;
      if (deck && terrace(ks[0]) && terrace(ks[1])) between++;
    }
    const label = labels[0] || (roof ? '屋頂平台' : '');
    if (edge >= 2 && Math.min(w.w, w.d) <= 60) { out.set(w, { kind: 'balcony', label }); continue; }
    // a line between two parts of a roof deck is only a step in the slab
    if (between >= 2 && thin) { out.set(w, { kind: 'projection', label }); continue; }
    if (!thin) continue;
    const two = (k: EdgeKind) => (hits.get(k) || 0) >= 2;
    const kind = two('projection') ? 'projection' : two('balcony') ? 'balcony' : two('canopy') ? 'canopy' : null;
    if (kind) out.set(w, { kind, label });
  }
  // a double wall line gives two parallel edges: one railing or parapet stands there, the other line is dropped
  const rails = [...out].filter(([, e]) => e.kind === 'balcony').map(([w]) => w);
  for (const a of rails) for (const b of rails) {
    if (a === b || out.get(a)?.kind !== 'balcony' || out.get(b)?.kind !== 'balcony') continue;
    const ax = a.w >= a.d, bx = b.w >= b.d;
    if (ax !== bx) continue;
    const off = ax ? Math.abs(a.z - b.z) : Math.abs(a.x - b.x);
    const lo = Math.max(ax ? a.x - a.w / 2 : a.z - a.d / 2, ax ? b.x - b.w / 2 : b.z - b.d / 2), hi = Math.min(ax ? a.x + a.w / 2 : a.z + a.d / 2, ax ? b.x + b.w / 2 : b.z + b.d / 2);
    const short = Math.min(Math.max(a.w, a.d), Math.max(b.w, b.d));
    if (off < 35 && hi - lo > short * 0.6 && Math.max(a.w, a.d) <= Math.max(b.w, b.d)) out.set(a, { ...out.get(a)!, kind: 'projection' });
  }
  return out;
}

interface Railing { h: number; glass: boolean; solid: boolean; name: string }
/** Railing used where a plan gives no height: the elevations' note (玻璃欄杆高度120㎝), else a 110 cm metal railing. */
function railingDefault(d: DxfDrawing, a: BuildingAnalysis): Railing {
  const views = a.views.filter(v => v.kind === 'elevation' || v.kind === 'section');
  for (const t of d.texts) {
    const m = HEIGHT_NOTE.exec(t.s);
    if (!m || !/欄杆|扶手/.test(m[1]) || !views.some(v => inBox(v.box, t.x, t.y))) continue;
    const glass = /玻璃/.test(t.s);
    return { h: +m[2], glass, solid: false, name: glass ? '玻璃欄杆（CAD）' : '欄杆（CAD）' };
  }
  const glass = d.texts.some(t => /玻璃欄杆/.test(t.s));
  return { h: 110, glass, solid: false, name: glass ? '玻璃欄杆（CAD）' : '欄杆（CAD）' };
}
/**
 * What stands on a balcony edge. A 露台 is walled round by its parapet when the drawings give a
 * 女兒牆 height; a 平台 or roof deck takes the railing height written on its plan; otherwise the
 * nearest height note on the plan decides between parapet (女兒牆 / 花台) and railing.
 */
function railingFor(w: BoxObject, notes: { x: number; z: number; s: string }[], def: Railing, label: string, parapet: number | null): Railing {
  if (/露台/.test(label) && parapet) return { h: parapet, glass: false, solid: true, name: '女兒牆（CAD）' };
  if (/平台/.test(label)) {
    const m = notes.map(n => HEIGHT_NOTE.exec(n.s)).find(m => m && /欄杆|扶手/.test(m[1]));
    if (m) { const glass = /玻璃/.test(m[1]); return { h: +m[2], glass, solid: false, name: glass ? '玻璃欄杆（CAD）' : '欄杆（CAD）' }; }
  }
  let best: { m: RegExpExecArray; d: number } | null = null;
  for (const n of notes) {
    const m = HEIGHT_NOTE.exec(n.s), dist = Math.hypot(n.x - w.x, n.z - w.z);
    if (m && dist < 500 && (!best || dist < best.d)) best = { m, d: dist };
  }
  if (!best) return def;
  const h = +best.m[2], kind = best.m[1];
  if (/女兒牆|矮牆|花台/.test(kind)) return { h, glass: false, solid: true, name: kind === '花台' ? '花台（CAD）' : '女兒牆（CAD）' };
  const glass = /玻璃/.test(kind) || def.glass;
  return { h, glass, solid: false, name: glass ? '玻璃欄杆（CAD）' : '欄杆（CAD）' };
}

/** Stairs of a storey from the tread lines; 上 labels mark where the climb starts. */
function stairsOf(segs: { x1: number; z1: number; x2: number; z2: number }[], notes: { x: number; z: number; s: string }[], H: number): (StairPlan & { labelled: number })[] {
  const flights = findFlights(segs);
  if (!flights.length) return [];
  const start = notes.filter(n => /^(上|UP)\s*\d*$/i.test(n.s.trim()));
  // only 下 arrows: the top of the stair (屋突), nothing climbs from here
  if (!start.length && notes.some(n => /^(下|DN)\s*\d*$/i.test(n.s.trim()))) return [];
  // how far the stair linework reaches past the last tread, toward the half landing
  const extent = (f: StairFlight, dir: 1 | -1) => {
    const end = dir > 0 ? f.at[f.at.length - 1] : f.at[0];
    let far = end;
    for (const s of segs) for (const [x, z] of [[s.x1, s.z1], [s.x2, s.z2]]) {
      const across = f.axis === 'z' ? x : z, along = f.axis === 'z' ? z : x;
      if (across < f.lo - 5 || across > f.hi + 5 || (along - end) * dir < 0 || Math.abs(along - end) > 250) continue;
      if ((along - far) * dir > 0) far = along;
    }
    return far;
  };
  return planStairs(flights, H, start, extent).map(sp => {
    // the 上 label of this stair gives its riser count
    const xs = sp.holes.flatMap(h => [h.x0, h.x1]), zs = sp.holes.flatMap(h => [h.z0, h.z1]);
    const lab = start.find(n => n.x > Math.min(...xs) - 60 && n.x < Math.max(...xs) + 60 && n.z > Math.min(...zs) - 60 && n.z < Math.max(...zs) + 60);
    const N = lab ? +(/\d+/.exec(lab.s)?.[0] || 0) : 0;
    return { ...sp, labelled: N >= 4 && N <= 40 ? N : 0 };
  });
}

export interface BuildingResult {
  objects: ModelObject[];
  cad: CadData;
  analysis: BuildingAnalysis;
  stats: { floors: number; walls: number; doors: number; windows: number; railings: number };
}

const BEAM_LAYER = /^BM|BEAM|梁/i;
/** Beam marks on structural plans: G1a(30x60), FG4a(50x155/195), or the mark and the size as two texts. */
const BEAM_MARK = /^(F?[GBJ]\d*[a-z]?|F?J\d*[a-z]?)\s*\((\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*\/\s*(\d{2,3}))?\)$/;
const BEAM_CODE = /^F?[GBJ]\d*[a-z]?$/, BEAM_SIZE = /^\((\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*\/\s*(\d{2,3}))?\)$/;

/** Beams of one structural plan: paired beam outlines, each named and sized by the nearest beam mark. */
function readBeams(d: DxfDrawing, v: SheetView, X: (x: number) => number, Z: (y: number) => number, S: number) {
  const segs = d.segs.filter(s => BEAM_LAYER.test(s.layer) && inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1]));
  const texts = d.texts.filter(t => inBox(v.box, t.x, t.y));
  const marks: { code: string; w: number; h: number; x: number; z: number }[] = [];
  for (const t of texts) {
    const m = BEAM_MARK.exec(t.s.trim());
    if (m) { marks.push({ code: m[1], w: +m[2], h: m[4] ? (+m[3] + +m[4]) / 2 : +m[3], x: X(t.x), z: Z(t.y) }); continue; }
    if (!BEAM_CODE.test(t.s.trim())) continue;
    const sz = texts.map(o => ({ o, m: BEAM_SIZE.exec(o.s.trim()) })).filter(q => q.m && Math.hypot(q.o.x - t.x, q.o.y - t.y) < (t.h || 25) * 4)
      .sort((p, q) => Math.hypot(p.o.x - t.x, p.o.y - t.y) - Math.hypot(q.o.x - t.x, q.o.y - t.y))[0];
    if (sz) marks.push({ code: t.s.trim(), w: +sz.m![1], h: sz.m![3] ? (+sz.m![2] + +sz.m![3]) / 2 : +sz.m![2], x: X(t.x), z: Z(t.y) });
  }
  const lines = pairWalls(segs.map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }))).filter(l => !l.single && l.t >= 15 && l.t <= 80);
  return lines.map(l => {
    const len = Math.hypot(l.bx - l.ax, l.bz - l.az), ux = (l.bx - l.ax) / len, uz = (l.bz - l.az) / len;
    // the mark is written beside the beam, within its length
    let best: (typeof marks)[number] | null = null, bd = Infinity;
    for (const m of marks) {
      const u = (m.x - l.ax) * ux + (m.z - l.az) * uz, off = Math.abs((m.x - l.ax) * uz - (m.z - l.az) * ux);
      if (u < -60 || u > len + 60 || off > 70 * S + l.t) continue;
      const dist = off + Math.max(0, -u, u - len);
      if (dist < bd) { bd = dist; best = m; }
    }
    return { ax: l.ax, az: l.az, bx: l.bx, bz: l.bz, len, t: l.t, mark: best };
  });
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
  let nWalls = 0, nDoors = 0, nWins = 0, nRails = 0;
  let below: StairPlan['holes'] = [];
  const railing = railingDefault(d, a), beamDepth = beamDepthOf(d, a);
  // 女兒牆高度 written anywhere (plans, elevations, sections)
  const parapetNote = d.texts.some(t => /女兒牆/.test(HEIGHT_NOTE.exec(t.s)?.[1] || '')) ? a.parapet : null;
  const slabsOf = new Map<string, { x0: number; x1: number; z0: number; z1: number }[]>();
  const beamLines: { st: Storey; xs: number[]; zs: number[] }[] = [];

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
    const texts = d.texts.filter(t => inBox(plan.box, t.x, t.y) && /^TEXT$|ROOM|室名|空間/i.test(t.layer) && /[一-鿿]/.test(t.s) && t.s.length <= 12 && !/[0-9]{2,}|㎡|坪|高度|詳|說明|同|$^/.test(t.s))
      .map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }))
      .filter(t => t.x > -50 && t.z > -50 && t.x < W + 50 && t.z < D + 50);
    const add = (o: Omit<BoxObject, 'id' | 'floor'>) => objects.push({ ...o, id: id++, floor: st.key, y: st.base + o.y });

    // unpaired diagonal lines are usually shaft crosses or hatching, not walls
    const walls = dropLouvers(lines.filter(w => !w.single || Math.abs(w.ax - w.bx) < 1 || Math.abs(w.az - w.bz) < 1).map(w => wallBox(w, H, 0)));
    const openings = parapet ? [] : findOpenings(walls, openSegs, swings);
    // each opening takes the nearest tag; tags left over point at openings drawn without a wall gap
    const dist = (t: { x: number; z: number }, op: Opening) => Math.hypot(t.x - op.cx, t.z - op.cz);
    for (const op of openings) op.tag = tags.filter(t => dist(t, op) < 200).sort((p, q) => dist(p, op) - dist(q, op))[0]?.code;
    if (!parapet) {
      const used = new Set(tags.filter(t => openings.some(op => dist(t, op) < 200 && op.tag === t.code)));
      for (const t of tags) if (!used.has(t)) { const op = cutTagged(walls, t, codes.get(t.code)!.w, openSegs); if (op) openings.push(op); }
      fillGaps(walls, openings);
    }
    // openings count as closed when finding the outline
    const shut = openings.map(op => ({ ...walls[0], x: op.cx, z: op.cz, w: op.axis === 'x' ? op.len : op.t, d: op.axis === 'x' ? op.t : op.len, rot: 0 }));
    // thin lines round balconies are railings, round canopies the slab edge, and projections nothing
    const notes = d.texts.filter(t => inBox(plan.box, t.x, t.y)).map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }));
    const edges = parapet ? new Map<BoxObject, { kind: EdgeKind; label: string }>() : classifyEdges(walls, shut, notes, W, D, st.key.startsWith('R'));
    const slabEdges: BoxObject[] = [];
    for (const [w, { kind, label }] of edges) {
      walls.splice(walls.indexOf(w), 1);
      if (kind === 'canopy') { slabEdges.push(w); continue; }
      if (kind !== 'balcony') continue;
      const rail = railingFor(w, notes, railing, label, parapetNote);
      slabEdges.push(w);
      if (rail.solid) add({ ...w, layer: 'wall', y: 0, h: rail.h, name: rail.name, color: 0xeeebe5 });
      else add({ ...w, layer: rail.glass ? 'glass' : 'rail', y: 0, h: rail.h, w: w.w >= w.d ? w.w : 4, d: w.w >= w.d ? 4 : w.d, name: rail.name, color: rail.glass ? 0xa9dcff : 0x6b7280 });
      nRails++;
    }
    for (const b of walls) if (b.w > 1 && b.d > 1) add({ ...b, y: 0, name: parapet ? '女兒牆（CAD）' : b.name });
    nWalls += walls.length;
    // stairs: steps, half landings and the inner handrail; the storey above gets a hole in its slab
    const stairSegs = g.segs.filter(s => STAIR_LAYER.test(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const stairs = parapet ? [] : stairsOf(stairSegs, notes, H);
    for (const sp of stairs) {
      const r = H / sp.risers;
      // quantities follow the riser count written on the plan (上16); the drawing may leave treads out
      const N = sp.labelled || sp.risers, flights = sp.landings.length ? 2 : 1;
      const info = { risers: N, flights, width: sp.width, run: sp.run, rise: H / N, landing: sp.landings.reduce((s, t) => s + (t.x1 - t.x0) * (t.z1 - t.z0) / 1e4, 0) };
      sp.steps.forEach((t, i) => add({ layer: 'stair', name: '樓梯踏階（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: t.x1 - t.x0, d: t.z1 - t.z0, h: Math.min(t.top, r + SLAB), y: t.top - Math.min(t.top, r + SLAB), color: 0xd9d4ca, rise: r, ...(i ? {} : { stair: info }) }));
      for (const t of sp.landings) add({ layer: 'stair', name: '樓梯平台（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: t.x1 - t.x0, d: t.z1 - t.z0, h: SLAB, y: t.top - SLAB, color: 0xd9d4ca });
      for (const t of sp.rails) add({ layer: 'rail', name: '樓梯扶手（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: Math.max(4, t.x1 - t.x0), d: Math.max(4, t.z1 - t.z0), h: 90, y: t.top, color: 0x4b5563, rise: r });
    }
    if (!parapet) beamLines.push({ st, xs: g.gx.map(X), zs: g.gy.map(Z) });
    const holes = below;
    slabsOf.set(st.key, []);
    below = stairs.flatMap(sp => sp.holes);
    for (const r of slabRects(walls.length ? [...walls, ...shut, ...slabEdges] : walls, texts, W, D, holes)) {
      add({ layer: 'slab', name: st.key === '1F' ? '地坪（CAD）' : st.key === 'RF' ? '屋頂板（CAD）' : '樓板（CAD）', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: -SLAB, color: 0xd6d1c7 });
      slabsOf.get(st.key)!.push(r);
    }
    for (const op of openings) {
      const it = op.tag ? codes.get(op.tag)! : null;
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
    const near = (x: number, z: number) => x > -100 && z > -100 && x < W + 100 && z < D + 100;
    for (const s of g.segs) {
      if (isWallLayer(s.layer) || /GRID|GTAG|AXIS|軸|DIM|標註|Defpoints|AREA|TEXT|圖框|範圍|地界|道路|PARK/i.test(s.layer)) continue;
      const x1 = X(s.a[0]), z1 = Z(s.a[1]), x2 = X(s.b[0]), z2 = Z(s.b[1]);
      if (near(x1, z1) && near(x2, z2)) segs.push(x1, z1, x2, z2);
    }
    floors.push({ key: st.key, title: plan.title, y: st.base, h: H, segs, texts });
  }
  // beams from structural plans (二層結構平面圖 → under the 2F slab), lined up on the grid bubbles
  const drawn = new Set<string>();
  for (const v of a.views.filter(v => v.kind === 'structure' && v.floors.length)) {
    const gs = planGeo(d, v);
    if (!gs.gx.length || !gs.gy.length) continue;
    const X = (x: number) => (x - gs.ox - minX) * S, Z = (y: number) => (maxY - (y - gs.oy)) * S;
    const beams = readBeams(d, v, X, Z, S).filter(b => b.mark);
    if (!beams.length) continue;
    for (const key of v.floors) {
      const i = a.storeys.findIndex(s => s.key === key);
      if (i < 0) continue;
      // the beams carry this floor: they hang under its slab, in the storey below (foundation beams under 1F)
      const host = i > 0 ? a.storeys[i - 1] : a.storeys[0], top = a.storeys[i].base;
      if (i > 0) drawn.add(host.key);
      for (const b of beams) {
        const m = b.mark!, ground = i === 0, along = Math.abs(b.bx - b.ax) >= Math.abs(b.bz - b.az);
        objects.push({ id: id++, layer: 'slab', name: `${ground ? '地梁' : '梁'} ${m.code}（結構圖）`, floor: host.key, y: top - m.h, h: m.h, color: 0xcfc9bd,
          x: (b.ax + b.bx) / 2, z: (b.az + b.bz) / 2, ...(along ? { w: b.len, d: m.w } : { w: m.w, d: b.len }) });
      }
    }
  }
  // beams are rarely on architectural plans: estimate one along every grid line, under the slab of the storey above
  for (const { st, xs, zs } of beamLines) {
    if (drawn.has(st.key)) continue;
    const next = a.storeys[a.storeys.indexOf(st) + 1], above = next ? slabsOf.get(next.key) || [] : [];
    const beam = (axis: 'x' | 'z', at: number) => {
      // where the slab above covers the grid line
      const runs = above.filter(r => axis === 'x' ? at >= r.z0 && at <= r.z1 : at >= r.x0 && at <= r.x1)
        .map(r => axis === 'x' ? [r.x0, r.x1] : [r.z0, r.z1]).sort((p, q) => p[0] - q[0]);
      const merged: number[][] = [];
      for (const r of runs) { const m = merged[merged.length - 1]; if (m && r[0] <= m[1] + 1) m[1] = Math.max(m[1], r[1]); else merged.push([...r]); }
      for (const [lo, hi] of merged) {
        if (hi - lo < 100) continue;
        const c = axis === 'x' ? Math.min(D - BEAM_W / 2, Math.max(BEAM_W / 2, at)) : Math.min(W - BEAM_W / 2, Math.max(BEAM_W / 2, at));
        objects.push({ id: id++, layer: 'slab', name: '梁（估算）', floor: st.key, y: st.base + st.h - beamDepth, h: beamDepth, color: 0xcfc9bd,
          ...(axis === 'x' ? { x: (lo + hi) / 2, z: c, w: hi - lo, d: BEAM_W } : { x: c, z: (lo + hi) / 2, w: BEAM_W, d: hi - lo }) });
      }
    };
    for (const x of xs) if (x > -5 && x < W + 5) beam('z', x);
    for (const z of zs) if (z > -5 && z < D + 5) beam('x', z);
  }
  return {
    objects,
    cad: { name, W, D, segs: [], texts: [], doors: [], floors },
    analysis: a,
    stats: { floors: floors.length, walls: nWalls, doors: nDoors, windows: nWins, railings: nRails },
  };
}

/** Removes rows of identical short strips (louvres, grilles, shading fins, their cross lines) that pair up like walls. */
function dropLouvers(boxes: BoxObject[]): BoxObject[] {
  return boxes.filter(o => {
    // a few degrees off square is a cross line paired with its neighbour, not a wall
    const off = Math.abs(((o.rot || 0) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2));
    if (Math.min(off, Math.PI / 2 - off) > 0.01 && Math.min(off, Math.PI / 2 - off) < 0.25) return false;
    if (Math.max(o.w, o.d) > 300 || Math.min(o.w, o.d) >= 35) return true;
    const twins = boxes.filter(q => q !== o && Math.abs((q.rot || 0) - (o.rot || 0)) < 0.02 && Math.abs(q.w - o.w) < 3 && Math.abs(q.d - o.d) < 3 && Math.hypot(q.x - o.x, q.z - o.z) < 150);
    return twins.length < 3;
  });
}

interface Opening { axis: 'x' | 'z'; cx: number; cz: number; a: number; b: number; len: number; t: number; arc: boolean; tag?: string }
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
      const end = u0 + dir * s.r;
      // the wall behind the hinge, or (when the hinge side is open) the wall the closed leaf meets
      const jamb = cast(axis, at0, u0, dir === 1 ? -1 : 1, 25, true) || cast(axis, at0, end, dir, 15, true);
      if (!jamb) continue;
      const sp = span(jamb.o, axis), run = isRun(jamb.o, axis);
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

/**
 * Several drawing files (architectural and structural sets) as one model space: each file
 * is moved to the right of the previous one so their sheets never overlap.
 */
export function mergeDrawings(ds: DxfDrawing[]): DxfDrawing {
  if (ds.length === 1) return ds[0];
  // everything is put in centimetres; files without a units header get them guessed from their size
  const out: DxfDrawing = { segs: [], polys: [], texts: [], arcs: [], layers: new Map(), units: 5, version: ds[0].version, blockCount: 0, inserts: 0, parts: [] };
  let at = 0;
  for (const d0 of ds) {
    const k = UNIT_SCALE[guessUnits(d0)] || 1;
    const sc = (p: Pt): Pt => [p[0] * k, p[1] * k];
    const d = k === 1 ? d0 : { ...d0, segs: d0.segs.map(s => ({ ...s, a: sc(s.a), b: sc(s.b) })), polys: d0.polys.map(p => ({ ...p, pts: p.pts.map(sc) })), texts: d0.texts.map(t => ({ ...t, x: t.x * k, y: t.y * k, ...(t.h ? { h: t.h * k } : {}) })), arcs: d0.arcs.map(c => ({ ...c, c: sc(c.c), r: c.r * k, ...(c.p0 ? { p0: sc(c.p0) } : {}), ...(c.p1 ? { p1: sc(c.p1) } : {}) })) };
    let minX = Infinity, maxX = -Infinity;
    for (const s of d.segs) for (const p of [s.a, s.b]) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
    for (const t of d.texts) { minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); }
    if (!isFinite(minX)) continue;
    const dx = at - minX, mv = (p: Pt): Pt => [p[0] + dx, p[1]];
    out.segs.push(...d.segs.map(s => ({ ...s, a: mv(s.a), b: mv(s.b) })));
    out.polys.push(...d.polys.map(p => ({ ...p, pts: p.pts.map(mv) })));
    out.texts.push(...d.texts.map(t => ({ ...t, x: t.x + dx })));
    out.arcs.push(...d.arcs.map(c => ({ ...c, c: mv(c.c), ...(c.p0 ? { p0: mv(c.p0) } : {}), ...(c.p1 ? { p1: mv(c.p1) } : {}) })));
    for (const [l, n] of d.layers) out.layers.set(l, (out.layers.get(l) || 0) + n);
    out.blockCount += d.blockCount; out.inserts += d.inserts;
    out.parts!.push({ x0: at, x1: at + maxX - minX });
    at += maxX - minX + Math.max(1000, (maxX - minX) * 0.1);
  }
  return out;
}
