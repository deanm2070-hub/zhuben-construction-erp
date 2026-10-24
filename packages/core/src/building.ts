import { UNIT_SCALE, guessLayerKind, guessUnits } from './cadImport';
import type { DxfDrawing, DxfSeg, DxfText, Pt } from './dxf';
import { pairWalls, wallBox } from './geometry';
import { WALL_H } from './sample';
import { findFlights, planStairs, type StairFlight, type StairPlan } from './stairs';
import { HEIGHT_NOTE, isDoorType, openingName, openingType, PLAN_NOTES, type OpeningType } from './legend';
import { readRebarSpec } from './rebar';
import { checkModel, type Issue } from './sanity';
import { isBox, isDoor, type BoxObject, type CadData, type CadFloor, type DoorObject, type ModelObject, type SlabPanel } from './types';

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
  /** title letter height; set when the region is the sheet frame around the title (then it is not grown) */
  th?: number;
  framed?: boolean;
  /** the sheet frame shared with other views stacked in it */
  frame?: [number, number, number, number];
}
export interface ScheduleItem { code: string; w: number; h: number; name: string; sill: number; kind: 'door' | 'window'; type: OpeningType; /** a corner window: the width of each leg */ legs?: number[]; /** 數量 column of the schedule */ qty?: number; /** storey named in the 位置 row (一樓廁所 → 1F) */ where?: string; /** openings given this code by width, not by a tag on the plan */ guessed?: number }
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
  /** layers read as walls because their lines pair up like double-line walls (drawings whose layer names say nothing) */
  wallLayers: string[];
  /** layers whose repeated small squares are columns (named by colour or pen rather than COL) */
  colLayers: string[];
  /** things the drawing set is missing that make the 3D come out empty */
  warnings: string[];
  /** beams read off the sections (mark and size beside each cut beam), where there are no structural plans */
  beams?: SectionBeam[];
  /** lean-concrete blinding under the foundation written on a section (10cm 2000psi PC), cm */
  blinding?: number;
  /** a site wall drawn on the elevations beside the building (labelled 圍牆), height above the ground floor, cm */
  fenceH?: number;
  /** the drawings checked against each other before the model is built (levels, storeys; widths after building) */
  checks: CrossCheck[];
}

/** One comparison between drawings: agreed (ok), disagreed and settled by the program (fixed), or left to look at (warn). */
export interface CrossCheck { item: string; ok: 'ok' | 'fixed' | 'warn'; text: string }

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
  // 夾層 (mezzanine): above the storey it names, the ground floor when it names none (一層夾層 / 夾層 → 1MF)
  if (/夾層/.test(t)) {
    const m = /([一二三四五六七八九十]+|\d+)(?:層|樓|F)?夾層/.exec(t);
    return [`${m ? cnNum(m[1]) || 1 : 1}MF`];
  }
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
  const m = /^(B|R)?(\d+)F$/.exec(k), mz = /^(\d+)MF$/.exec(k);
  if (k === 'RF') return 2000;
  if (mz) return +mz[1] + 0.5;
  if (!m) return 5000;
  return m[1] === 'B' ? -+m[2] : m[1] === 'R' ? 1000 + +m[2] : +m[2];
};
export const normLevel = (s: string) => {
  const t = s.replace(/\s/g, '').toUpperCase();
  if (/^(B\d+F|\d+M?F|R\d+F|RF|PRF)$/.test(t)) return t === 'PRF' ? 'RF' : t;
  if (/^(B\d+|\d+M?|R\d*)FL$/.test(t)) return t.slice(0, -1);
  return null;
};

const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * q)] : NaN; };
const inBox = (b: SheetView['box'], x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Finds view titles and the region each view occupies. */
export function findViews(d: DxfDrawing): SheetView[] {
  // each file of a merged set has its own title size and sheet spacing
  if (d.parts && d.parts.length > 1) return d.parts.flatMap(p => findViews({ ...d, parts: undefined, texts: d.texts.filter(t => t.x >= p.x0 - 1 && t.x <= p.x1 + 1) }));
  const bare = (x: string) => x.replace(/\s/g, '').replace(/[(（][^)）]*[)）]$/, '');
  // notes that end in 平面圖 (「開啟方向依平面圖」「*相關檢討同二層平面圖」) and lists naming several views are not titles
  const all0 = d.texts.filter(t => TITLE_RE.test(bare(t.s)) && t.s.length <= 24 && !/[、，,。；;：:*＊]|依|詳|見|參|同/.test(t.s));
  // the sheet name in the title block repeats an elevation's or section's title: the label under the view on the same sheet is the one to use
  const FRAME = /圖框|TITLE|FRAME|BORDER/i;
  const all = all0.filter(t => !FRAME.test(t.layer) || !/[立剖]面圖$/.test(bare(t.s))
    || !all0.some(o => !FRAME.test(o.layer) && bare(o.s) === bare(t.s) && Math.hypot(o.x - t.x, o.y - t.y) < (t.h || 1) * 150));
  const SHEET_CODE = /^[A-Z]{1,2}\d{0,2}-\d{1,3}[A-Z]?$/;
  const cand = all.filter(t => {
    const h = t.h || 0;
    if (!h) return true;
    // a column of view names (drawing index, title block): another name of the same size right above or below it
    if (all.some(o => o !== t && Math.abs(o.x - t.x) < h * 2 && Math.abs(o.y - t.y) < h * 3.5 && Math.abs(o.y - t.y) > h * 0.3 && (o.h || 0) > h * 0.75 && (o.h || 0) < h / 0.75)) return false;
    // a row of the drawing index: the sheet number on its left
    if (d.texts.some(o => SHEET_CODE.test(o.s.trim()) && o.x < t.x && t.x - o.x < h * 15 && Math.abs(o.y - t.y) < h * 0.6)) return false;
    return true;
  });
  if (!cand.length) return [];
  // titles come in several sizes (index sheet, sheet names, view labels): use the size that names the most views
  const hs = [...new Set(cand.map(t => t.h || 0))];
  const near = (h: number) => cand.filter(t => (t.h || 0) >= h * 0.7 && (t.h || 0) <= h / 0.7 || !h).length;
  const hMax = hs.length > 1 ? hs.reduce((b, h) => near(h) > near(b) || (near(h) === near(b) && h > b) ? h : b, hs[0]) : hs[0];
  const sized = (hm: number) => cand.filter(t => !hm || (t.h || 0) >= hm * 0.7 && (t.h || 0) <= hm / 0.7 || /門窗[表圖]$/.test(t.s.replace(/\s/g, '')));
  const views = viewsOf(sized(hMax), hMax, bare);
  // plans of other storeys titled in another size (a set whose sheets each use their own lettering): add the storeys still missing
  const have = new Set(views.flatMap(v => v.floors));
  const rest = cand.filter(t => !sized(hMax).includes(t));
  while (rest.length) {
    const h0 = rest[0].h || 0, grp = rest.filter(t => (t.h || 0) >= h0 * 0.7 && (t.h || 0) <= h0 / 0.7);
    for (const t of grp) rest.splice(rest.indexOf(t), 1);
    const add = viewsOf(grp, h0, bare).filter(v => v.kind === 'plan' && v.floors.length && v.floors.some(f => !have.has(f)));
    views.push(...add);
    for (const v of add) v.floors.forEach(f => have.add(f));
  }
  return views;
}

function viewsOf(titles0: DxfText[], hMax: number, bare: (s: string) => string): SheetView[] {
  const titles = titles0.filter((t, i, a) => a.findIndex(o => o.s === t.s && Math.hypot(o.x - t.x, o.y - t.y) < (hMax || 1)) === i);
  const gaps: number[] = [];
  for (const t of titles) {
    let best = Infinity;
    for (const o of titles) if (o !== t && o.x > t.x && Math.abs(o.y - t.y) < (hMax || 10) * 2) best = Math.min(best, o.x - t.x);
    if (isFinite(best)) gaps.push(best);
  }
  // sheets often skip a slot, so the typical view width is the smaller spacings; a lone title: about 55 times its letter height
  const w = quantile(gaps, 0.25) || (hMax ? hMax * (titles.length > 1 ? 30 : 55) : 3000);
  const STRUCT = /結構平面圖$/;
  return titles.filter(t => STRUCT.test(bare(t.s)) || !SKIP_RE.test(t.s)).map(t => {
    const s = bare(t.s);
    const kind: ViewKind = STRUCT.test(s) ? 'structure' : /平面圖$/.test(s) ? 'plan' : /立面圖$/.test(s) ? 'elevation' : /剖面圖$/.test(s) ? 'section' : 'schedule';
    let top = w * 1.3;
    for (const o of titles) if (o !== t && o.y > t.y + w * 0.2 && Math.abs(o.x - t.x) < w * 0.5) top = Math.min(top, o.y - t.y);
    const box: SheetView['box'] = kind === 'schedule'
      ? [t.x - w * 0.3, t.y - w * 0.05, t.x + w * 2, t.y + top]
      : [t.x - w * 0.15, t.y - w * 0.02, t.x + w * 0.85, t.y + top];
    // 基礎及一層結構平面圖 → 1F (its foundation beams sit under the ground floor)
    const floors = kind === 'plan' ? parseFloors(s) : kind === 'structure' ? parseFloors(s.replace(STRUCT, '').replace(/^基礎及?/, '')) : [];
    return { title: s, kind, x: t.x, y: t.y, box, floors, th: t.h };
  });
}

/**
 * A sheet frame (a rectangle drawn round each sheet) holding a view's title is the best guess of that view's region:
 * sets drawn as one sheet per view, stacked in a column with the title at the bottom, otherwise run into the
 * next sheet or stop short of the drawing. The smallest frame around the title is used; a frame holding several
 * views only trims the guessed region.
 */
function frameViews(d: DxfDrawing, views: SheetView[]) {
  const rects: [number, number, number, number][] = [];
  for (const p of d.polys) {
    if (p.pts.length < 4 || p.pts.length > 5 || /TEXT|DIM|FURN|AREA/i.test(p.layer)) continue;
    const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]);
    const x0 = minOf(xs), x1 = maxOf(xs), y0 = minOf(ys), y1 = maxOf(ys), tol = (x1 - x0) * 0.002;
    // axis-aligned: every corner on the bounding box
    if (!p.pts.every(q => (Math.abs(q[0] - x0) < tol || Math.abs(q[0] - x1) < tol) && (Math.abs(q[1] - y0) < tol || Math.abs(q[1] - y1) < tol))) continue;
    rects.push([x0, y0, x1, y1]);
  }
  if (!rects.length) return;
  const same = (a: SheetView, b: SheetView) => a.title === b.title && Math.hypot(a.x - b.x, a.y - b.y) < (a.th || 1) * 3;
  for (const v of views) {
    if (!v.th || v.kind === 'schedule') continue;
    let best: typeof rects[number] | null = null, many = false;
    for (const f of rects) {
      const w = f[2] - f[0], h = f[3] - f[1];
      if (w < v.th * 25 || h < v.th * 15 || w > v.th * 400 || !inBox(f, v.x, v.y)) continue;
      if (best && w * h >= (best[2] - best[0]) * (best[3] - best[1])) continue;
      best = f;
      many = views.some(o => o !== v && !same(o, v) && o.kind !== 'schedule' && inBox(f, o.x, o.y));
    }
    if (!best) continue;
    if (!many) { v.box = [...best]; v.framed = true; continue; }
    // several views stacked in one frame, each titled under its drawing (e.g. 屋突二層 above 屋頂層): each one gets the band from its title up to the title above it
    const f = best, inF = views.filter(o => o.kind !== 'schedule' && inBox(f, o.x, o.y) && !views.some(p => p !== o && same(p, o) && views.indexOf(p) < views.indexOf(o)));
    const th = v.th, xs = inF.map(o => o.x);
    if (inF.length > 1 && maxOf(xs) - minOf(xs) < (f[2] - f[0]) * 0.25) {
      const ys = inF.map(o => o.y).sort((a, b) => b - a), i = ys.findIndex(y => Math.abs(y - v.y) < 1e-6);
      if (i >= 0 && ys.every((y, k) => !k || ys[k - 1] - y > th * 10)) {
        v.box = [f[0], i === ys.length - 1 ? f[1] : v.y - th * 2, f[2], i === 0 ? f[3] : ys[i - 1] - th * 2];
        v.framed = true; v.frame = [...f];
        continue;
      }
    }
    v.box = [Math.max(v.box[0], best[0]), Math.max(v.box[1], best[1]), Math.min(v.box[2], best[2]), Math.min(v.box[3], best[3])];
  }
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
  // table layout: codes across the header row, each column giving "W x H", then the name, below it
  // a corner window is written as one size per leg: 210x200+196.5x200
  const PURE = /^(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)(?:\s*\+\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*\d+(?:\.\d+)?)?$/;
  const CODE = /^(?:DW|SD|AW|W|D|AD|F)\d{1,3}[A-Z]?$/;
  const PAIR = /(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/g;
  // grid layout: each cell headed by the code with its size written beside it on the same line ("D1 120*250",
  // or "W10 鋁推窗(80*180)鋁窗(85*180+278*180)" for a window of several pieces), the cell's elevation below with
  // stacked vertical dimensions (sill, then height) standing on the F.L. line, and the material row (鋁推窗, 防火門) under it
  for (const c of d.texts) {
    const cd = c.s.trim();
    if (!CODE.test(cd) || items.some(i => i.code === cd)) continue;
    const h = c.h || 20;
    const side = d.texts.filter(t => t !== c && Math.abs(t.y - c.y) < h * 0.6 && t.x > c.x && t.x - c.x < h * 6 && /\d\s*[xX×*]\s*\d/.test(t.s) && !CODE.test(t.s.trim()))
      .sort((a, b) => a.x - b.x)[0];
    if (!side) continue;
    // "+" joins the legs of a corner window; the pieces of one leg sit side by side
    const legs = side.s.split('+').map(part => [...part.matchAll(PAIR)].reduce((n, m) => n + +m[1], 0)).filter(n => n > 0);
    const pairs = [...side.s.matchAll(PAIR)];
    if (!pairs.length || pairs.some(m => +m[1] > 2000 || +m[2] > 1000)) continue;
    const H = Math.max(...pairs.map(m => +m[2])), W = legs.reduce((a, b) => a + b, 0);
    const fl = d.texts.filter(t => /^F\.?L\.?$/i.test(t.s.trim()) && t.y < c.y && c.y - t.y < h * 36 && t.x > c.x - h * 3 && t.x < c.x + h * 4)
      .sort((a, b) => b.y - a.y)[0];
    const floorY = fl ? fl.y : c.y - h * 36;
    const own = side.s.replace(PAIR, '').replace(/[()（）+\s\d.]/g, '');
    // a finish legend (F1 80*80拋光石英磚) is not an opening
    if (own && !/[門窗]/.test(own)) continue;
    const mat = d.texts.filter(t => t.y < floorY + h && floorY - t.y < h * 6 && Math.abs(t.x - (c.x + side.x) / 2) < h * 8 && /[門窗]/.test(t.s) && !/[:：、]|門窗[表圖]/.test(t.s))
      .sort((a, b) => b.y - a.y || Math.abs(a.x - c.x) - Math.abs(b.x - c.x))[0]?.s.trim() || '';
    const label = /[門窗]/.test(own) ? own : mat;
    const type = openingType(cd, label), kind = isDoorType(type) ? 'door' : 'window';
    let sill = kind === 'door' || type === 'french' ? 0 : 90;
    if (sill && fl && d.dims?.length) {
      const lo = (m: { a: Pt; b: Pt }) => Math.min(m.a[1], m.b[1]), hi = (m: { a: Pt; b: Pt }) => Math.max(m.a[1], m.b[1]);
      const vert = d.dims.filter(m => Math.abs(m.a[0] - m.b[0]) < h * 0.2 && m.a[0] > c.x - h && m.a[0] < c.x + h * 14 && lo(m) > fl.y - h && hi(m) < c.y);
      // the dimension standing on the floor line with another stacked on top of it
      const st = vert.filter(m => Math.abs(lo(m) - fl.y) < h * 0.6 && vert.some(q => q !== m && Math.abs(q.a[0] - m.a[0]) < h * 0.5 && Math.abs(lo(q) - hi(m)) < h * 0.3))
        .sort((a, b) => Math.abs(a.a[0] - c.x) - Math.abs(b.a[0] - c.x))[0];
      if (st) sill = Math.round(st.v);
    }
    items.push({ code: cd, w: W, h: H, name: openingName(cd, label), sill, kind, type, ...(legs.length === 2 ? { legs } : {}) });
  }
  for (const c of d.texts) {
    const cd = c.s.trim();
    if (!CODE.test(cd) || items.some(i => i.code === cd)) continue;
    const h = c.h || 20;
    // a survey point label (D1 on 控制點) is not a door code; a tiny text on Defpoints (a paper size like 840x590) is not its size
    if (/控制點|地籍|地界|測量|SURVEY/i.test(c.layer)) continue;
    const size = d.texts.map(t => ({ t, m: PURE.exec(t.s.trim()) })).filter(o => o.m && (o.t.h || h) > h * 0.2 && !/^DEFPOINTS$/i.test(o.t.layer) && o.t.y < c.y && c.y - o.t.y < h * 80 && o.t.x > c.x - h * 14 && o.t.x < c.x + h * 3)
      .sort((a, b) => b.t.y - a.t.y)[0];
    if (!size) continue;
    const label = d.texts.filter(t => Math.abs(t.x - size.t.x) < h * 2 && t.y < size.t.y && size.t.y - t.y < h * 8 && /[門窗]/.test(t.s) && !/[:：]/.test(t.s)).sort((a, b) => b.y - a.y)[0]?.s.trim() || '';
    const type = openingType(cd, label), kind = isDoorType(type) ? 'door' : 'window';
    const legs = size.m![3] ? [+size.m![1], +size.m![3]] : undefined;
    let sill = kind === 'door' || type === 'french' ? 0 : 90;
    // the elevation in the cell carries a vertical dimension for the window height and, under it, one for the sill
    if (sill && d.dims?.length) {
      const H = +size.m![2], vert = d.dims.filter(m => Math.abs(m.a[0] - m.b[0]) < 0.5 && m.a[0] > c.x - h * 14 && m.a[0] < c.x + h * 6 && Math.max(m.a[1], m.b[1]) < c.y && Math.min(m.a[1], m.b[1]) > size.t.y);
      const hd = vert.find(m => Math.abs(m.v - H) < 0.6);
      const sd = hd && vert.find(m => m !== hd && Math.abs(m.a[0] - hd.a[0]) < h * 2 && Math.abs(Math.max(m.a[1], m.b[1]) - Math.min(hd.a[1], hd.b[1])) < h * 0.3);
      // the height written in the table can disagree with the drawing: then the lowest of two stacked dimensions is the sill
      const low = (m: { a: Pt; b: Pt }) => Math.min(m.a[1], m.b[1]), top = (m: { a: Pt; b: Pt }) => Math.max(m.a[1], m.b[1]);
      const st = sd || vert.filter(m => vert.some(q => q !== m && Math.abs(q.a[0] - m.a[0]) < 0.5 && Math.abs(low(q) - top(m)) < h * 0.3)).sort((p, q) => low(p) - low(q))[0];
      if (st) sill = Math.round(st.v);
    }
    items.push({ code: cd, w: legs ? legs[0] + legs[1] : +size.m![1], h: +size.m![2], name: openingName(cd, label), sill, kind, type, ...(legs ? { legs } : {}) });
  }
  // the 數量 row of a table layout: each number belongs to the code of its column
  for (const q of d.texts.filter(t => /^數量$/.test(t.s.trim()))) {
    const h = q.h || 20;
    const row = d.texts.filter(t => /^\d{1,3}$/.test(t.s.trim()) && Math.abs(t.y - q.y) < h * 1.2 && t.x > q.x);
    for (const n of row) {
      const code = items.map(i => ({ i, c: d.texts.find(t => t.s.trim() === i.code && t.y > q.y && t.y - q.y < h * 90 && Math.abs(t.x - n.x) < h * 14) })).filter(o => o.c)
        .sort((a, b) => Math.abs(a.c!.y - b.c!.y) > h * 2 ? a.c!.y - b.c!.y : Math.abs(a.c!.x - n.x) - Math.abs(b.c!.x - n.x))[0];
      if (code && code.i.qty === undefined) code.i.qty = +n.s;
    }
  }
  // the 位置 row names where a window is (一樓廁所): its storey
  const NUM = '一二三四五六七八九';
  for (const i of items) {
    const c = d.texts.find(t => t.s.trim() === i.code && /^(?:DW|SD|AW|W|D|AD|F)\d/.test(t.s.trim()));
    if (!c) continue;
    const h = c.h || 20;
    const loc = d.texts.filter(t => t.y < c.y && c.y - t.y < h * 90 && Math.abs(t.x - c.x) < h * 12 && /[一二三四五六七八九]樓/.test(t.s)).sort((a, b) => b.y - a.y)[0];
    const m = loc && /([一二三四五六七八九])樓/.exec(loc.s);
    if (m) i.where = `${NUM.indexOf(m[1]) + 1}F`;
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

/**
 * Level rulers: each column of level marks (1F, 2F … RF) in each elevation and section, as heights above its own 1F
 * mark, cm. A sheet that draws several sections side by side gives one ruler per section. A number written beside a
 * mark (2FL ▽ +850) is read too: written heights win over where the mark is drawn.
 */
export function levelRulers(d: DxfDrawing, views: SheetView[], scale: number) {
  const out: { title: string; vals: Record<string, number>; written: boolean }[] = [];
  for (const v of views.filter(v => v.kind === 'elevation' || v.kind === 'section')) {
    const marks = d.texts.filter(t => inBox(v.box, t.x, t.y)).map(t => ({ k: normLevel(t.s), t })).filter((m): m is { k: string; t: DxfText } => !!m.k).sort((p, q) => p.t.x - q.t.x);
    if (marks.length < 2) continue;
    const hs = marks.map(m => m.t.h || 0).filter(h => h > 0), th = hs.length ? quantile(hs, 0.5) : (v.box[2] - v.box[0]) / 200;
    const cols: (typeof marks)[] = [];
    for (const m of marks) { const c = cols[cols.length - 1]; if (c && m.t.x - c[c.length - 1].t.x <= th * 8) c.push(m); else cols.push([m]); }
    for (const c of cols) {
      const y: Record<string, number> = {}, w: Record<string, number> = {};
      for (const m of c) {
        if (m.k in y) continue;
        y[m.k] = m.t.y;
        // a height written on the same line to the right: +850, ±0, 2730
        const num = d.texts.filter(t => t !== m.t && Math.abs(t.y - m.t.y) <= th * 0.8 && t.x > m.t.x && t.x - m.t.x <= th * 10 && /^[+±-]?\s*\d{1,5}(\.\d+)?$/.test(t.s.replace(/[▽▼]/g, '').trim()))
          .sort((p, q) => Math.abs(p.y - m.t.y) - Math.abs(q.y - m.t.y) || p.x - q.x)[0];
        if (num) w[m.k] = parseFloat(num.s.replace(/[▽▼±+\s]/g, '')) * (/-/.test(num.s) ? -1 : 1);
      }
      if (!('1F' in y) || Object.keys(y).length < 2) continue;
      const vals: Record<string, number> = {};
      const drawn = (k: string) => (y[k] - y['1F']) * scale;
      const unit = Object.keys(y).some(k => Math.abs(w[k] - w['1F']) < 100 && Math.abs(drawn(k)) > 150) ? 100 : 1;
      const wr = (k: string) => (w[k] - w['1F']) * unit;
      // written numbers are used when each agrees with where its mark is drawn (else the pairing is off)
      const written = Object.keys(y).every(k => k in w && Math.abs(wr(k) - drawn(k)) <= Math.max(10, Math.abs(drawn(k)) * 0.15));
      for (const k of Object.keys(y)) vals[k] = Math.round(written ? wr(k) : drawn(k));
      out.push({ title: v.title, vals, written });
    }
  }
  return out;
}

/** The level of each storey agreed by most rulers (within 5 cm), and the rulers that say otherwise. */
export function consensusLevels(rulers: ReturnType<typeof levelRulers>) {
  const keys = [...new Set(rulers.flatMap(r => Object.keys(r.vals)))].sort((a, b) => levelOrder(a) - levelOrder(b));
  const levels: Record<string, number> = {}, odd: { title: string; k: string; v: number; agreed: number }[] = [];
  for (const k of keys) {
    const vs = rulers.filter(r => k in r.vals).map(r => r.vals[k]);
    // the value most rulers are within 5 cm of; ties go to written heights, then to the median
    const votes = vs.map(v => ({ v, n: vs.filter(u => Math.abs(u - v) <= 5).length }));
    const best = Math.max(...votes.map(x => x.n)), win = quantile(votes.filter(x => x.n === best).map(x => x.v), 0.5);
    levels[k] = win;
    for (const r of rulers) if (k in r.vals && Math.abs(r.vals[k] - win) > 5) odd.push({ title: r.title, k, v: r.vals[k], agreed: win });
  }
  return { levels, odd };
}

/**
 * A beam cut by a section: its mark and size written beside it (G5 / 50*70), placed on the grid by the section's grid
 * bubbles (on grid line `a`, or a fraction `t` of the way from `a` to `b`), under the slab of `level`. `foot` = a
 * foundation beam under the ground floor.
 */
export interface SectionBeam { kind: string; a: string; b: string; t: number; level: string; mark: string; w: number; h: number; foot: boolean; title: string }

const SEC_BEAM_SIZE = /^(\d{2,3})\s*[*xX×]\s*(\d{2,3})$/, SEC_BEAM_MARK = /^[A-Za-z]{1,3}\d{1,2}[a-z]?$/;
export function sectionBeams(d: DxfDrawing, views: SheetView[], storeys: Storey[], scale: number): { beams: SectionBeam[]; blinding?: number } {
  const out: SectionBeam[] = [], seen = new Set<string>();
  let blinding: number | undefined;
  for (const v of views.filter(v => v.kind === 'section' && !/板剖面|中間帶|詳圖|大樣|廁所|樓梯/.test(v.title))) {
    // a section's box often stops below its top floors (the frame finder): look up to its height again above it
    const [x0, y0, x1, y1] = v.box, box: SheetView['box'] = [x0, y0, x1, y1 + (y1 - y0)];
    const rows = gridLines(d, box, 'row', scale).sort((p, q) => q.at.size - p.at.size);
    if (!rows.length) continue;
    const row = rows[0], gl = [...row.at].sort((p, q) => p[1] - q[1]);
    const ts = d.texts.filter(t => inBox(box, t.x, t.y));
    const th = quantile(ts.map(t => t.h || 0).filter(h => h > 0), 0.5) || 15 / scale;
    const pc = ts.map(t => /(\d{1,2})\s*cm[^0-9]{0,6}\d{4}\s*psi\s*PC/i.exec(t.s)).find(Boolean);
    if (pc) blinding ??= +pc[1];
    const cut: { x: number; y: number; mark: string; w: number; h: number }[] = [];
    for (const t of ts) {
      const m = SEC_BEAM_SIZE.exec(t.s.trim());
      if (!m) continue;
      const mk = ts.filter(o => SEC_BEAM_MARK.test(o.s.trim()) && !GRID_LBL.test(o.s.trim()) && o.y > t.y && o.y - t.y <= Math.max(th * 4, +m[2] * 0.95 / scale) && Math.abs(o.x - t.x) <= th * 3)
        .sort((p, q) => (p.y - t.y) - (q.y - t.y))[0];
      if (!mk) continue;
      cut.push({ x: mk.x, y: mk.y, mark: mk.s.trim(), w: +m[1], h: +m[2] });
    }
    if (!cut.length) continue;
    // heights: from the 1F level mark, else from the row of foundation beams (their marks sit just under the ground floor line)
    const one = ts.find(t => normLevel(t.s) === '1F');
    const foot = cut.filter(c => c.h >= 120);
    const y1F = one ? one.y : foot.length ? quantile(foot.map(c => c.y), 0.5) + th * 1.2 : undefined;
    if (y1F === undefined) continue;
    for (const c of cut) {
      const e = (c.y - y1F) * scale, isFoot = c.h >= 120 && Math.abs(e) < 80;
      // the level line just above the mark
      const st = isFoot ? storeys[0] : storeys.filter(s => s.base >= e - 5 && s.base - e <= 80).sort((p, q) => p.base - q.base)[0];
      if (!st) continue;
      // on a grid line, or between two
      let a = '', b = '', t = 0;
      const on = gl.find(([, gx]) => Math.abs(gx - c.x) * scale <= 40);
      if (on) { a = b = on[0]; }
      else {
        const i = gl.findIndex(([, gx], k) => k < gl.length - 1 && gx < c.x && gl[k + 1][1] > c.x);
        if (i < 0) continue;
        a = gl[i][0]; b = gl[i + 1][0]; t = (c.x - gl[i][1]) / (gl[i + 1][1] - gl[i][1]);
      }
      const key = `${row.kind}|${a}|${b}|${Math.round(t * 20)}|${st.key}|${isFoot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: row.kind, a, b, t, level: st.key, mark: c.mark, w: c.w, h: c.h, foot: isFoot, title: v.title });
    }
  }
  return { beams: out, blinding };
}

/** The height of a site wall on the elevations: the top of the low box nearest a 圍牆 label, above the 1F mark. */
function fenceHeight(d: DxfDrawing, views: SheetView[], scale: number): number | undefined {
  const hs: number[] = [];
  for (const v of views.filter(v => v.kind === 'elevation')) {
    const ts = d.texts.filter(t => inBox(v.box, t.x, t.y));
    const one = ts.find(t => normLevel(t.s) === '1F'), lab = ts.find(t => /^圍牆$/.test(t.s.trim()));
    if (!one || !lab) continue;
    // horizontal lines 60–300 cm above 1F within 15 m of the label, held up by a vertical line reaching down to 1F at an end
    const segs = d.segs.filter(s => inBox(v.box, s.a[0], s.a[1]));
    let best: { h: number; dist: number } | undefined;
    for (const s of segs) {
      if (Math.abs(s.a[1] - s.b[1]) > 1) continue;
      const h = (s.a[1] - one.y) * scale, x0 = Math.min(s.a[0], s.b[0]), x1 = Math.max(s.a[0], s.b[0]);
      if (h < 60 || h > 300 || (x1 - x0) * scale < 100) continue;
      const dist = lab.x < x0 ? x0 - lab.x : lab.x > x1 ? lab.x - x1 : 0;
      if (dist * scale > 1500) continue;
      const post = segs.some(q => Math.abs(q.a[0] - q.b[0]) < 1 && [x0, x1].some(x => Math.abs(q.a[0] - x) < 2)
        && Math.max(q.a[1], q.b[1]) >= s.a[1] - 2 && Math.abs(Math.min(q.a[1], q.b[1]) - one.y) * scale <= 40);
      if (post && (!best || dist < best.dist)) best = { h, dist };
    }
    if (best) hs.push(Math.round(best.h));
  }
  return hs.length ? quantile(hs, 0.5) : undefined;
}

const GRID_LBL = /^(\d{1,2}|[A-Z]|[XY]\d{1,2})$/;
const gridKind = (l: string) => /^X/.test(l) ? 'X' : /^Y/.test(l) ? 'Y' : /^\d/.test(l) ? 'n' : 'a';
const gridOrd = (l: string) => /\d/.test(l) ? +l.replace(/\D/g, '') : l.charCodeAt(0);
/**
 * Rows (along x) or columns (along y) of grid bubbles in a view: labels of one kind (1 2 3 / A B C / X1 X2 / Y1 Y2)
 * on one line, in order along it (either way: elevations seen from the back run backwards), at least 1 m apart.
 */
function gridLines(d: DxfDrawing, box: SheetView['box'], dir: 'row' | 'col', scale: number) {
  const ts = d.texts.filter(t => inBox(box, t.x, t.y) && GRID_LBL.test(t.s.trim()));
  const out: { kind: string; at: Map<string, number> }[] = [], seen = new Set<string>();
  for (const t of ts) {
    const h = (t.h || 20 / scale) * 1.5, kind = gridKind(t.s.trim());
    // (bubbles share one letter height: other numbers on the same line, a neighbouring sheet's, are not grid labels)
    const same = ts.filter(o => gridKind(o.s.trim()) === kind && (dir === 'row' ? Math.abs(o.y - t.y) < h : Math.abs(o.x - t.x) < h)
      && (!t.h || !o.h || Math.abs(o.h - t.h) <= Math.max(o.h, t.h) * 0.1));
    const at = new Map<string, number>();
    for (const o of same.sort((p, q) => (dir === 'row' ? p.x - q.x : p.y - q.y))) if (!at.has(o.s.trim())) at.set(o.s.trim(), dir === 'row' ? o.x : o.y);
    const key = [...at.keys()].join(',');
    if (at.size < 3 || seen.has(key)) continue;
    seen.add(key);
    const ord = [...at.keys()].map(gridOrd), pos = [...at.values()];
    const mono = ord.every((o, i) => i === 0 || o > ord[i - 1]) || ord.every((o, i) => i === 0 || o < ord[i - 1]);
    const gaps = pos.slice(1).map((p, i) => Math.abs(p - pos[i]) * scale);
    if (mono && Math.min(...gaps) >= 100) out.push({ kind, at });
  }
  return out;
}

/**
 * Grid spacing on every elevation, section and structural plan against the architectural plans: the distance between
 * each pair of neighbouring axes must be the same. A bubble labelled differently at the same spacing (X6 where the
 * plans say X7) is a slip on one drawing; the plans are kept.
 */
export function gridChecks(d: DxfDrawing, views: SheetView[], plans: SheetView[], scale: number): CrossCheck[] {
  const ref = new Map<string, Map<string, number>>();
  for (const p of plans) for (const dir of ['row', 'col'] as const) for (const g of gridLines(d, p.box, dir, scale)) {
    const cur = ref.get(g.kind);
    if (!cur || g.at.size > cur.size) ref.set(g.kind, g.at);
  }
  if (!ref.size) return [];
  const out: CrossCheck[] = [], okViews: string[] = [], m = (v: number) => (v / 100).toFixed(2);
  // detail sections (slab strips, enlarged parts) are not drawn to the building's grid
  for (const v of views.filter(v => (v.kind === 'elevation' || v.kind === 'section' || v.kind === 'structure') && !/板剖面|中間帶|詳圖|大樣|廁所/.test(v.title))) {
    const lines = gridLines(d, v.box, 'row', scale).concat(v.kind === 'structure' ? gridLines(d, v.box, 'col', scale) : []);
    const notes: string[] = [];
    let compared = 0;
    for (const g of lines) {
      const r = ref.get(g.kind);
      if (!r) continue;
      const rl = [...r.keys()].sort((p, q) => r.get(p)! - r.get(q)!), vl = [...g.at.keys()];
      // labels the plans do not have: matched by spacing to the plan axis at that distance from a shared axis
      const shared = vl.filter(l => r.has(l));
      if (shared.length < 2) continue;
      const a0 = shared[0], sgn = Math.sign((g.at.get(shared[1])! - g.at.get(a0)!) / (r.get(shared[1])! - r.get(a0)!)) || 1;
      for (const l of vl.filter(l => !r.has(l))) {
        const dv = (g.at.get(l)! - g.at.get(a0)!) * sgn * scale;
        const hit = rl.find(q => Math.abs((r.get(q)! - r.get(a0)!) * scale - dv) <= Math.max(5, Math.abs(dv) * 0.005));
        if (hit && !g.at.has(hit)) notes.push(`標「${l}」的軸線在平面圖是「${hit}」（距 ${a0} ${m(Math.abs(dv))} m，間距相同，以平面圖為準）`);
      }
      for (let i = 1; i < shared.length; i++) {
        const p = shared[i - 1], q = shared[i];
        const dv = Math.abs(g.at.get(q)! - g.at.get(p)!) * scale, dr = Math.abs(r.get(q)! - r.get(p)!) * scale;
        compared++;
        if (Math.abs(dv - dr) > Math.max(10, dr * 0.02)) notes.push(`${p}–${q} 間距 ${m(dv)} m，平面圖 ${m(dr)} m`);
      }
    }
    if (!compared) continue;
    // the model is built on the plans' grid: a different spacing on another drawing is listed, the plans win
    if (notes.length) out.push({ item: '軸線間距', ok: 'fixed', text: `${v.title}：${notes.join('；')}${notes.some(n => !n.includes('以平面圖為準')) ? '（3D 依平面圖的間距建立）' : ''}` });
    else okViews.push(v.title);
  }
  if (okViews.length) out.unshift({ item: '軸線間距', ok: 'ok', text: `${okViews.length} 張圖（${okViews.slice(0, 6).join('、')}${okViews.length > 6 ? ' 等' : ''}）的軸線間距與平面圖一致（${[...ref].map(([, r]) => { const l = [...r.keys()].sort((p, q) => r.get(p)! - r.get(q)!); return `${l[0]}–${l[l.length - 1]}`; }).join('、')}）` });
  return out;
}

/** upstand round the top roof slab (屋頂層), read off the sections, cm */
const ROOF_UPSTAND = 30;

export function analyzeBuilding(d: DxfDrawing, defaultH = WALL_H): BuildingAnalysis | null {
  // what an earlier import learnt about its layers must not leak into this one (a second import in the same session)
  extraWall = new Set(); ignoreNow = new Set();
  const views = findViews(d);
  frameViews(d, views);
  const planViews = views.filter(v => v.kind === 'plan' && v.floors.length);
  if (!planViews.length) return null;
  // a plan with nothing above its title would span a whole column of the sheet: no taller than its siblings
  const hs = planViews.map(v => v.box[3] - v.box[1]).sort((a, b) => a - b), med = hs[Math.floor((hs.length - 1) / 2)];
  for (const v of planViews) if (!v.framed && v.box[3] - v.box[1] > med * 2.5) v.box[3] = v.box[1] + med * 1.4;
  growPlans(d, planViews);
  const { scale, wallLayers } = learnWalls(d, planViews);
  const colLayers = wallLayers.length ? learnColumns(d, planViews, scale) : [];
  if (wallLayers.length) wallLayers.push(...bridgeLayers(d, planViews, scale, wallLayers, colLayers));
  extraWall = new Set(wallLayers); ignoreNow = new Set(); scaleNow = scale;
  // when two files both have a plan of a storey (architectural and structural), the one with the most wall lines wins
  const walls = (v: SheetView) => d.segs.filter(s => isWallLayer(s.layer) && inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1])).length;
  // a site plan that also shows the ground floor (全區暨一層平面圖) only when there is no plan of the building alone
  const site = (v: SheetView) => /全區|總平面|配置/.test(v.title) ? 1 : 0;
  const plans = planViews.map(v => ({ v, n: walls(v) })).sort((a, b) => site(a.v) - site(b.v) || b.n - a.n).map(p => p.v);
  // levels: every ruler on every elevation and section is compared, and the height most of them agree on is used
  const checks: CrossCheck[] = [];
  const rulers = levelRulers(d, views, scale);
  let levels: Record<string, number>;
  if (rulers.length) {
    const c = consensusLevels(rulers);
    levels = c.levels;
    const list = Object.entries(levels).sort((p, q) => p[1] - q[1]).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join('、');
    const where = [...new Set(rulers.map(r => r.title))];
    if (!c.odd.length) checks.push({ item: '樓層高程', ok: 'ok', text: `${rulers.length} 處標高（${where.slice(0, 6).join('、')}${where.length > 6 ? ' 等' : ''}）一致：${list} cm${rulers.every(r => r.written) ? '；標註的高程數字與標高線位置也相符' : ''}` });
    else checks.push({ item: '樓層高程', ok: 'fixed', text: `${c.odd.slice(0, 6).map(o => `${o.title} 的 ${o.k} 標 ${o.v}`).join('、')}，與其他 ${rulers.length - new Set(c.odd.map(o => o.title)).size} 處不同，採多數：${c.odd.slice(0, 6).map(o => `${o.k} ${o.agreed}`).join('、')}（全部：${list} cm）` });
  } else {
    levels = readLevels(d, views, scale);
    checks.push(Object.keys(levels).length
      ? { item: '樓層高程', ok: 'warn', text: `立面、剖面只找到一組標高（沒有 1F 對照），直接採用：${Object.entries(levels).map(([k, v]) => `${k} ${v}`).join('、')} cm` }
      : { item: '樓層高程', ok: 'warn', text: '立面、剖面圖上沒有讀到樓層標高（1F、2F…），各層樓高用預設值，請在下方樓高欄確認' });
  }
  const schedule = parseSchedule(d);
  const pm = d.texts.map(t => /女兒牆[^0-9]{0,6}(\d{2,3})\s*(㎝|cm|公分)/i.exec(t.s)).find(Boolean);
  const parapet = pm ? +pm[1] : 120;
  // storeys: a level on the elevations with no plan between two planned storeys is a typical floor, built from the plan below
  {
    const planned = new Set(plans.flatMap(p => p.floors)), num = (k: string) => /^\d+M?F$/.test(k);
    const pk = [...planned].filter(num).sort((a, b) => levelOrder(a) - levelOrder(b));
    const filled: string[] = [];
    if (pk.length) for (const k of Object.keys(levels).filter(k => num(k) && !planned.has(k)).sort((a, b) => levelOrder(a) - levelOrder(b))) {
      if (levelOrder(k) < levelOrder(pk[0]) || levelOrder(k) > levelOrder(pk[pk.length - 1]) || /M/.test(k)) continue;
      const below = [...planned].filter(num).filter(q => levelOrder(q) < levelOrder(k) && !/M/.test(q)).sort((a, b) => levelOrder(b) - levelOrder(a))[0];
      const p = below && plans.find(v => v.floors.includes(below));
      if (!p) continue;
      p.floors.push(k); planned.add(k); filled.push(`${k}（比照 ${below}）`);
    }
    const unlevelled = Object.keys(levels).length ? [...planned].filter(k => !(k in levels) && k !== 'RF') : [];
    if (filled.length) checks.push({ item: '樓層數', ok: 'fixed', text: `立面／剖面有 ${filled.map(f => f.split('（')[0]).join('、')} 的標高，但沒有這層平面圖，視為標準層：${filled.join('、')}` });
    else checks.push({ item: '樓層數', ok: 'ok', text: `平面圖 ${[...planned].sort((a, b) => levelOrder(a) - levelOrder(b)).join('、')}，立面／剖面標高都有對應` });
    if (unlevelled.length) checks.push({ item: '樓層數', ok: 'warn', text: `${unlevelled.join('、')} 有平面圖，但立面／剖面沒有標高，樓高由上下層推算` });
  }
  const keys = [...new Set(plans.flatMap(p => p.floors))].sort((a, b) => levelOrder(a) - levelOrder(b));
  const lv = Object.entries(levels).sort((a, b) => a[1] - b[1]);
  const storeys: Storey[] = [];
  let base = 0;
  for (const [i, k] of keys.entries()) {
    if (k in levels) base = levels[k];
    else if (i > 0) base = storeys[i - 1].base + storeys[i - 1].h;
    const above = lv.find(([, v]) => v > base + 1);
    const h = k === 'RF' ? ROOF_UPSTAND : !above && i === keys.length - 1 && k.startsWith('R') ? parapet : above ? above[1] - base : defaultH;
    storeys.push({ key: k, title: plans.find(p => p.floors.includes(k))!.title, base, h });
  }
  // a set whose plans carry hardly any wall lines (area-review sheets, site plans) cannot be built into walls
  const warnings: string[] = [];
  const wallSet = new Set(wallLayers);
  let wallSegs = 0;
  for (const g of d.segs) if (wallSet.has(g.layer) || guessLayerKind(g.layer) === 'wall') wallSegs++;
  if (plans.length && wallSegs < 300) warnings.push(`整份圖只讀到 ${wallSegs} 條牆線，這比較像「面積檢討圖」或示意圖，不是畫有牆、門窗的施工平面圖，所以 3D 會幾乎是空的。請改匯入含牆線與門窗的各層平面圖（常見檔名如「各層平面圖」「平面配置圖」的施工圖版本），或直接把這份圖的樓地板面積當作對帳用。`);
  checks.push(...gridChecks(d, views, plans, scale));
  const sb = sectionBeams(d, views, storeys, scale);
  if (sb.beams.length) checks.push({ item: '梁（剖面圖）', ok: 'ok', text: `剖面圖讀到 ${sb.beams.length} 處梁的編號與尺寸（${[...new Set(sb.beams.map(b => `${b.mark} ${b.w}×${b.h}`))].slice(0, 8).join('、')}${sb.beams.length > 8 ? ' 等' : ''}），沒有結構圖的樓層依此建梁${sb.beams.some(b => b.foot) ? '與地梁' : ''}${sb.blinding ? `，基礎下 ${sb.blinding} cm PC 墊層` : ''}` });
  const fenceH = fenceHeight(d, views, scale);
  return { views, plans, levels, storeys, schedule, parapet, scale, wallLayers, colLayers, warnings, checks, beams: sb.beams, blinding: sb.blinding, fenceH };
}

/**
 * A plan's region is guessed from its title, but the title is not always under the drawing's left edge.
 * While lines keep running up to a side edge of the region, the region grows that way (by at most 70% of its width).
 */
function growPlans(d: DxfDrawing, plans: SheetView[]) {
  for (const v of plans) {
    if (v.framed) continue;
    const [x0, y0, x1, y1] = v.box, w = x1 - x0, step = w * 0.02, max = w * 0.7;
    const busy = (a: number, b: number) => {
      let n = 0;
      for (const s of d.segs) {
        const my = (s.a[1] + s.b[1]) / 2;
        if (my < y0 || my > y1 || /TEXT|DIM|圖框|PEN|AREA/i.test(s.layer)) continue;
        if ((s.a[0] >= a && s.a[0] <= b) || (s.b[0] >= a && s.b[0] <= b)) if (++n >= 8) return true;
      }
      return false;
    };
    let lo = x0, hi = x1;
    while (x0 - lo < max && busy(lo - step, lo)) lo -= step;
    while (hi - x1 < max && busy(hi, hi + step)) hi += step;
    v.box = [lo, y0, hi, y1];
  }
}

/** A square column outline: 25–100 cm on a side, at most 2:1. */
const squareCol = (pts: Pt[], k: number) => {
  if (pts.length < 4 || pts.length > 5) return null;
  const xs = pts.map(q => q[0] * k), ys = pts.map(q => q[1] * k), w = maxOf(xs) - minOf(xs), h = maxOf(ys) - minOf(ys);
  return w >= 25 && h >= 25 && w <= 100 && h <= 100 && Math.max(w, h) <= Math.min(w, h) * 2 ? { w, h, x: (maxOf(xs) + minOf(xs)) / 2 / k, y: (maxOf(ys) + minOf(ys)) / 2 / k } : null;
};
/** Layers drawing at least four equal small squares in the plans: those squares are columns. */
function learnColumns(d: DxfDrawing, plans: SheetView[], k: number): string[] {
  const seen = new Map<string, number>();
  for (const p of d.polys) {
    if (/TEXT|DIM|FURN|TOIL|DW|SYM|AREA|PEN|圖框|變更/i.test(p.layer)) continue;
    const c = squareCol(p.pts, k);
    if (!c || !plans.some(v => inBox(v.box, c.x, c.y))) continue;
    const key = `${p.layer}|${Math.round(c.w / 5)}|${Math.round(c.h / 5)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...new Set([...seen].filter(([, n]) => n >= 4).map(([key]) => key.split('|')[0]))];
}

let extraWall = new Set<string>(), ignoreNow = new Set<string>(), scaleNow = 0, optNow: BuildOptions = {};
const isWallLayer = (l: string) => !ignoreNow.has(l) && (guessLayerKind(l) === 'wall' || /^COL/i.test(l) || extraWall.has(l));

/**
 * Drawing units and wall layers of a set whose headers or layer names are no help (a header saying mm over a drawing in cm,
 * walls on layers called C2 or PEN15). When no plan has a wall layer by name, a layer counts as walls if its lines pair up
 * into double-line walls; the unit is the one that makes the most such pairs 8–40 cm thick.
 */
function learnWalls(d: DxfDrawing, plans: SheetView[]): { scale: number; wallLayers: string[] } {
  const header = UNIT_SCALE[guessUnits(d)] || 1;
  const named = plans.some(v => d.segs.some(s => isWallLayer(s.layer) && inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1])));
  const byLayer = new Map<string, DxfSeg[]>(), namedSegs: DxfSeg[] = [];
  for (const v of plans) for (const sg of d.segs) {
    if (!inBox(v.box, sg.a[0], sg.a[1]) || !inBox(v.box, sg.b[0], sg.b[1])) continue;
    if (isWallLayer(sg.layer)) namedSegs.push(sg);
    if (guessLayerKind(sg.layer) !== 'line' || /TEXT|AREA|PEN|DIM|圖框|TOIL|DOOR|DW|STAIR|SYM|AID|PAVE|變更|WIN|窗|門|FURN|家具|衛浴|PLUM|FIX|曲線|等高|CONT|TOPO|地形|地界|ROAD|道路/i.test(sg.layer)) continue;
    (byLayer.get(sg.layer) || byLayer.set(sg.layer, []).get(sg.layer)!).push(sg);
  }
  const pairedLen = (ss: DxfSeg[], k: number) => pairWalls(ss.map(sg => ({ x1: sg.a[0] * k, z1: sg.a[1] * k, x2: sg.b[0] * k, z2: sg.b[1] * k }))).filter(x => !x.single && x.t >= 8 && x.t <= 40);
  if (named) {
    // a layer named WALL can hold only a few pieces (window frames) while the walls themselves are on layer 0: learn those too when they pair up into more wall than the named layers
    const namedLen = pairedLen(namedSegs, header).reduce((n, x) => n + Math.hypot(x.bx - x.ax, x.bz - x.az), 0);
    const extra: string[] = [];
    let total = 0;
    for (const [l, ss] of byLayer) {
      if (ss.length < 8) continue;
      const w = pairedLen(ss, header), len = w.reduce((n, x) => n + Math.hypot(x.bx - x.ax, x.bz - x.az), 0);
      if (len >= 1000 && w.length >= 6) { extra.push(l); total += len; }
    }
    return { scale: header, wallLayers: total > namedLen * 2 ? extra : [] };
  }
  let best = { scale: header, layers: [] as string[], total: 0 };
  for (const k of [header, 1, 0.1, 10]) {
    const layers: string[] = [];
    let total = 0;
    for (const [l, ss] of byLayer) {
      if (ss.length < 8) continue;
      const w = pairWalls(ss.map(sg => ({ x1: sg.a[0] * k, z1: sg.a[1] * k, x2: sg.b[0] * k, z2: sg.b[1] * k }))).filter(x => !x.single && x.t >= 8 && x.t <= 40);
      const len = w.reduce((n, x) => n + Math.hypot(x.bx - x.ax, x.bz - x.az), 0);
      if (len >= 1000 && w.length >= 6) { layers.push(l); total += len; }
    }
    // the header's unit and plain cm are the likely ones; 0.1 and 10 only when neither finds walls
    if (total > best.total * 1.2 && (best.total === 0 || k === 1 || k === header || best.total < 1000)) best = { scale: k, layers, total };
  }
  return { scale: best.scale, wallLayers: best.layers };
}

/**
 * Small layers too short to be learnt as walls (a 10 cm partition drawn on its own layer between two columns): a layer
 * whose lines are mostly double lines 8–30 cm apart and whose ends butt onto columns or learnt walls is walls too.
 */
function bridgeLayers(d: DxfDrawing, plans: SheetView[], k: number, walls: string[], cols: string[]): string[] {
  const wallSet = new Set(walls), colSet = new Set(cols), byLayer = new Map<string, DxfSeg[]>();
  const anchors: DxfSeg[] = [], boxes: number[][] = [];
  const inPlans = (x: number, y: number) => plans.some(v => inBox(v.box, x, y));
  for (const sg of d.segs) {
    if (!inPlans(sg.a[0], sg.a[1]) || !inPlans(sg.b[0], sg.b[1])) continue;
    if (wallSet.has(sg.layer) || guessLayerKind(sg.layer) === 'wall') { anchors.push(sg); continue; }
    if (colSet.has(sg.layer) || guessLayerKind(sg.layer) !== 'line' || /TEXT|AREA|PEN|DIM|圖框|TOIL|DOOR|DW|STAIR|SYM|AID|PAVE|變更|WIN|窗|門|FURN|家具|衛浴|PLUM|FIX|曲線|等高|CONT|TOPO|地形|地界|ROAD|道路|GRID|AXIS|軸|HAT|欄杆|RAIL/i.test(sg.layer)) continue;
    (byLayer.get(sg.layer) || byLayer.set(sg.layer, []).get(sg.layer)!).push(sg);
  }
  for (const p of d.polys) if (colSet.has(p.layer) && p.pts.length && inPlans(p.pts[0][0], p.pts[0][1])) {
    const xs = p.pts.map(q => q[0] * k), ys = p.pts.map(q => q[1] * k);
    boxes.push([minOf(xs), minOf(ys), maxOf(xs), maxOf(ys)]);
  }
  const near = (x: number, z: number, r: number) =>
    boxes.some(b => x >= b[0] - r && x <= b[2] + r && z >= b[1] - r && z <= b[3] + r) ||
    anchors.some(s => {
      const ax = s.a[0] * k, az = s.a[1] * k, dx = s.b[0] * k - ax, dz = s.b[1] * k - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      return Math.hypot(ax + dx * t - x, az + dz * t - z) <= r;
    });
  const out: string[] = [];
  for (const [l, ss] of byLayer) {
    if (ss.length < 4 || ss.length > 400) continue;
    const total = ss.reduce((n, s) => n + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) * k, 0);
    const ws = pairWalls(ss.map(sg => ({ x1: sg.a[0] * k, z1: sg.a[1] * k, x2: sg.b[0] * k, z2: sg.b[1] * k }))).filter(x => !x.single && x.t >= 8 && x.t <= 30);
    const len = ws.reduce((n, x) => n + Math.hypot(x.bx - x.ax, x.bz - x.az), 0);
    let ends = 0;
    for (const w of ws) for (const [x, z] of [[w.ax, w.az], [w.bx, w.bz]]) if (near(x, z, w.t / 2 + 8)) ends++;
    if (len >= 150 && ends >= 2 && len * 2 >= total * 0.6) out.push(l);
  }
  return out;
}

const isOpenLayer = (l: string) => /OPEN|DOOR|WIN|門|窗|^DW$/i.test(l) && !/編號|TAG|TEXT|-T$/i.test(l);

interface PlanGeo { segs: DxfSeg[]; ox: number; oy: number; gx: number[]; gy: number[]; /** origin taken from grid bubbles on that axis */ ax?: boolean; ay?: boolean }

/** Lines with a parallel partner 5–45 cm away overlapping it by at least a third: the two faces of a wall. `u` = drawing units per cm. */
function pairedOnly(ws: DxfSeg[], u: number): DxfSeg[] {
  const L = ws.map(s => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], len = Math.hypot(dx, dy);
    return { s, len, ux: dx / (len || 1), uy: dy / (len || 1) };
  });
  const ok = new Set<number>();
  for (let i = 0; i < L.length; i++) {
    const p = L[i];
    if (p.len < 30 * u) continue;
    for (let j = i + 1; j < L.length; j++) {
      const q = L[j];
      if (q.len < 30 * u || Math.abs(p.ux * q.uy - p.uy * q.ux) > 0.02) continue;
      const ox = q.s.a[0] - p.s.a[0], oy = q.s.a[1] - p.s.a[1], dist = Math.abs(ox * p.uy - oy * p.ux);
      if (dist < 5 * u || dist > 45 * u) continue;
      const t0 = ox * p.ux + oy * p.uy, t1 = (q.s.b[0] - p.s.a[0]) * p.ux + (q.s.b[1] - p.s.a[1]) * p.uy;
      const ov = Math.min(p.len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (ov > Math.min(p.len, q.len) / 3) { ok.add(i); ok.add(j); }
    }
  }
  return ws.filter((_, i) => ok.has(i));
}

/**
 * Plans without grid bubbles are stacked by their wall outline. The corner of the drawn lines is easily thrown off
 * by steps, planters or an axis line, so each such plan is slid onto the ground-floor plan where the most of its
 * wall faces land on that plan's wall faces, trying each corner of the two outlines.
 */
function alignOutlines(gs: PlanGeo[], S: number) {
  const ref = gs[0];
  if (!ref || gs.length < 2) return;
  const u = 1 / S, cell = 20 * u;
  const facesOf = (g: PlanGeo) => {
    const ws = g.segs.filter(q => isWallLayer(q.layer)), pr = pairedOnly(ws, u);
    return pr.length >= 8 ? pr : ws;
  };
  const sample = (ss: DxfSeg[], ox: number, oy: number) => {
    const pts: Pt[] = [];
    for (const q of ss) {
      const n = Math.max(1, Math.ceil(Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) / cell));
      for (let i = 0; i <= n; i++) pts.push([q.a[0] + (q.b[0] - q.a[0]) * i / n - ox, q.a[1] + (q.b[1] - q.a[1]) * i / n - oy]);
    }
    return pts;
  };
  const box = (pts: Pt[]) => ({ x0: minOf(pts.map(p => p[0])), x1: maxOf(pts.map(p => p[0])), y0: minOf(pts.map(p => p[1])), y1: maxOf(pts.map(p => p[1])) });
  const rp = sample(facesOf(ref), ref.ox, ref.oy);
  if (rp.length < 20) return;
  const grid = new Set(rp.map(p => `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)}`)), rb = box(rp);
  const score = (pts: Pt[], dx: number, dy: number) => {
    let n = 0;
    for (const p of pts) {
      const i = Math.round((p[0] + dx) / cell), j = Math.round((p[1] + dy) / cell);
      if (grid.has(`${i},${j}`) || grid.has(`${i + 1},${j}`) || grid.has(`${i - 1},${j}`) || grid.has(`${i},${j + 1}`) || grid.has(`${i},${j - 1}`)) n++;
    }
    return n;
  };
  for (const g of gs.slice(1)) {
    const fx = !!(g.ax && ref.ax), fy = !!(g.ay && ref.ay);
    if (g === ref || (fx && fy)) continue;
    const pts = sample(facesOf(g), g.ox, g.oy);
    if (pts.length < 20) continue;
    const b = box(pts);
    let best = { n: score(pts, 0, 0), dx: 0, dy: 0 };
    for (const dx of fx ? [0] : [rb.x0 - b.x0, rb.x1 - b.x1]) for (const dy of fy ? [0] : [rb.y0 - b.y0, rb.y1 - b.y1]) {
      const n = score(pts, dx, dy);
      if (n > best.n * 1.1) best = { n, dx, dy };
    }
    g.ox -= best.dx; g.oy -= best.dy;
  }
}

/** Plan geometry and the origin used to stack floors: the first numbered grid line and grid line A when the plan has grid bubbles. */
/**
 * A sheet region often holds more than the building: site items such as drains, lamp posts and neighbouring details.
 * Wall lines are grouped by closeness; the building is the biggest group plus any group of comparable size or touching it.
 * Everything outside that area (with a 2 m margin for balconies and canopies) is left out.
 */
export function buildingArea(segs: DxfSeg[], gap: number): { x0: number; y0: number; x1: number; y1: number; dropped: number } | null {
  let ws = segs.filter(s => isWallLayer(s.layer));
  if (ws.length < 20) return null;
  // on a catch-all layer (walls drawn on "0" with the site, contours and sheet frame) only lines with a parallel
  // partner a wall thickness away say where the building is
  const paired = pairedOnly(ws, gap / 400), byPairs = paired.length >= 20 && paired.length < ws.length * 0.8;
  if (byPairs) ws = paired;
  // cells counted from the lines' own corner, so the grouping does not depend on where the sheet sits in the file
  const bx = minOf(ws.flatMap(q => [q.a[0], q.b[0]])), by = minOf(ws.flatMap(q => [q.a[1], q.b[1]]));
  const key = (i: number, j: number) => `${i},${j}`;
  const parent = ws.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const at = new Map<string, number>();
  ws.forEach((s, i) => {
    for (const q of [s.a, s.b, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]]) {
      const ci = Math.floor((q[0] - bx) / gap), cj = Math.floor((q[1] - by) / gap);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const o = at.get(key(ci + di, cj + dj));
        if (o !== undefined) parent[find(i)] = find(o);
      }
      at.set(key(ci, cj), i);
    }
  });
  // the building's walls run square to one another: long lines along the drawing's main direction weigh most
  // (a ladder, hatching or a winding road gives many short or slanting lines)
  const ang = (q: DxfSeg) => ((Math.atan2(q.b[1] - q.a[1], q.b[0] - q.a[0]) * 180 / Math.PI) % 90 + 90) % 90;
  const hist = new Array(90).fill(0);
  for (const q of ws) hist[Math.round(ang(q)) % 90] += Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]);
  const dom = hist.indexOf(Math.max(...hist)), long = gap / 4;
  const weight = (q: DxfSeg) => {
    const len = Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]), da = Math.abs(ang(q) - dom);
    return len >= long && Math.min(da, 90 - da) < 2 ? len : 0;
  };
  const groups = new Map<number, { n: number; w: number; x0: number; y0: number; x1: number; y1: number }>();
  ws.forEach((s, i) => {
    const r = find(i), g = groups.get(r) || { n: 0, w: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    g.n++; g.w += byPairs ? weight(s) : 1; g.x0 = Math.min(g.x0, s.a[0], s.b[0]); g.x1 = Math.max(g.x1, s.a[0], s.b[0]); g.y0 = Math.min(g.y0, s.a[1], s.b[1]); g.y1 = Math.max(g.y1, s.a[1], s.b[1]);
    groups.set(r, g);
  });
  const all = [...groups.values()].sort((p, q) => q.w - p.w), main = all[0];
  const keep = all.filter(g => g === main || g.w >= main.w * 0.2
    || (g.x0 <= main.x1 + gap && g.x1 >= main.x0 - gap && g.y0 <= main.y1 + gap && g.y1 >= main.y0 - gap));
  const area = { x0: minOf(keep.map(g => g.x0)), y0: minOf(keep.map(g => g.y0)), x1: maxOf(keep.map(g => g.x1)), y1: maxOf(keep.map(g => g.y1)), dropped: ws.length - keep.reduce((n, g) => n + g.n, 0) };
  return area.dropped || byPairs ? area : null;
}

export function planGeo(d: DxfDrawing, v: SheetView): PlanGeo {
  let segs = d.segs.filter(s => inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1]));
  const k = scaleNow || UNIT_SCALE[guessUnits(d)] || 1, area = buildingArea(segs, 400 / k), m = 200 / k;
  if (area) segs = segs.filter(s => [s.a, s.b].every(q => q[0] >= area.x0 - m && q[0] <= area.x1 + m && q[1] >= area.y0 - m && q[1] <= area.y1 + m));
  const grid = d.texts.filter(t => /GTAG|GRID|AXIS|軸|格線/i.test(t.layer) && inBox(v.box, t.x, t.y));
  const nums = grid.filter(t => /^\d{1,2}$/.test(t.s)).sort((a, b) => +a.s - +b.s);
  const lets = grid.filter(t => /^[A-Z]$/.test(t.s)).sort((a, b) => a.s.localeCompare(b.s));
  const gx = [...new Set(nums.map(t => Math.round(t.x)))], gy = [...new Set(lets.map(t => Math.round(t.y)))];
  if (nums.length && lets.length) return { segs, ox: nums[0].x, oy: lets[0].y, gx, gy, ax: true, ay: true };
  // grid bubbles on a layer with no grid-like name (T08): a row of 1 2 3 … and a column of A B C … on one layer
  const byLayer = new Map<string, DxfText[]>();
  for (const t of d.texts) if (/^(\d{1,2}|[A-Z])$/.test(t.s.trim()) && inBox(v.box, t.x, t.y)) (byLayer.get(t.layer) || byLayer.set(t.layer, []).get(t.layer)!).push(t);
  const row = (xs: DxfText[], h: number) => xs.filter(t => xs.filter(o => Math.abs(o.y - t.y) < h).length >= 2);
  for (const [layer, ts] of byLayer) {
    const h = ts[0].h || 20;
    const col = (xs: DxfText[]) => xs.filter(t => xs.filter(o => Math.abs(o.x - t.x) < h * 2).length >= 2);
    let n = row(ts.filter(t => /^\d+$/.test(t.s.trim())), h).sort((a, b) => +a.s - +b.s);
    const l = col(ts.filter(t => /^[A-Z]$/.test(t.s.trim()))).sort((a, b) => a.s.trim().localeCompare(b.s.trim()));
    // the lower of two plans stacked in one frame shares the number bubbles drawn over the upper one
    const fr = v.frame;
    if (n.length < 2 && fr) n = row(d.texts.filter(t => t.layer === layer && /^\d{1,2}$/.test(t.s.trim()) && inBox(fr, t.x, t.y)), h).sort((a, b) => +a.s - +b.s);
    if (n.length >= 2 && l.length >= 2 && new Set(n.map(t => t.s.trim())).size === n.length && new Set(l.map(t => t.s.trim())).size === l.length)
      return { segs, ox: n[0].x, oy: l[0].y, gx: n.map(t => Math.round(t.x)), gy: l.map(t => Math.round(t.y)), ax: true, ay: true };
  }
  const ws = segs.filter(s => isWallLayer(s.layer));
  // X1 X2 … / Y1 Y2 … grid bubbles on any layer (also "X" with the number as a separate text beside it)
  // the bubbles of one axis often sit just outside the sheet region found for the view (Y bubbles left of a plan
  // drawn close to its frame): look a bit further out across that axis, and take the column of bubbles nearest the view
  const [bx0, by0, bx1, by1] = v.box, mw = (bx1 - bx0) * 0.3, mh = (by1 - by0) * 0.3;
  const xy = (axis: 'X' | 'Y') => {
    const inside = xyIn(axis, v.box);
    if (inside.length >= 2) return inside;
    const wide = xyIn(axis, axis === 'Y' ? [bx0 - mw, by0, bx1 + mw, by1] : [bx0, by0 - mh, bx1, by1 + mh]);
    const off = (p: { x: number; y: number }) => axis === 'Y' ? Math.max(0, bx0 - p.x, p.x - bx1) : Math.max(0, by0 - p.y, p.y - by1);
    const lines = new Map<number, typeof wide>();
    for (const p of wide) { const k = Math.round((axis === 'Y' ? p.x : p.y) / 20); (lines.get(k) || lines.set(k, []).get(k)!).push(p); }
    // the same bubble is often drawn twice (on two layers): one per number
    const best = [...lines.values()].map(l => [...new Map(l.map(p => [p.n, p])).values()]).filter(l => l.length >= 2).sort((a, b) => off(a[0]) - off(b[0]))[0];
    return best ? best.sort((a, b) => a.n - b.n) : inside;
  };
  const xyIn = (axis: 'X' | 'Y', box: number[]) => {
    const out: { n: number; x: number; y: number }[] = [];
    for (const t of d.texts) {
      if (!inBox(box as SheetView['box'], t.x, t.y)) continue;
      const m = new RegExp(`^${axis}\\s*-?(\\d{1,2})$`).exec(t.s.trim());
      if (m) { out.push({ n: +m[1], x: t.x, y: t.y }); continue; }
      if (t.s.trim() !== axis) continue;
      const h = t.h || 20, dg = d.texts.find(o => /^\d{1,2}$/.test(o.s.trim()) && o.x > t.x && o.x - t.x < h * 1.5 && Math.abs(o.y - t.y) < h);
      if (dg) out.push({ n: +dg.s.trim(), x: t.x, y: t.y });
    }
    return out.sort((a, b) => a.n - b.n);
  };
  const bx = xy('X'), by = xy('Y');
  return {
    segs, gx, gy,
    ox: bx.length >= 2 ? bx[0].x : minOf(ws.flatMap(s => [s.a[0], s.b[0]])),
    oy: by.length >= 2 ? by[0].y : maxOf(ws.flatMap(s => [s.a[1], s.b[1]])),
    ax: bx.length >= 2, ay: by.length >= 2,
  };
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
const DOOR_CODE = /^(?:D|SD|AD)\d/;
function cutTagged(walls: BoxObject[], tag: { code: string; x: number; z: number }, width: number, openSegs: { x1: number; z1: number; x2: number; z2: number }[], planSegs: { x1: number; z1: number; x2: number; z2: number }[] = [], leafFirst = false): Opening | null {
  let best: { axis: 'x' | 'z'; wall: BoxObject; u: number; d: number } | null = null;
  if (!leafFirst) for (const s of openSegs) {
    const axis = Math.abs(s.z1 - s.z2) < 0.5 ? 'x' : Math.abs(s.x1 - s.x2) < 0.5 ? 'z' : null;
    if (!axis) continue;
    const L = Math.abs(axis === 'x' ? s.x2 - s.x1 : s.z2 - s.z1);
    const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2, d = Math.hypot(mx - tag.x, mz - tag.z);
    if (L < width * 0.4 || d > 150 || (best && d >= best.d)) continue;
    const u = axis === 'x' ? mx : mz, v = axis === 'x' ? mz : mx;
    const wall = walls.find(o => runsAlong(o, axis) && Math.abs(spanOf(o, axis).c - v) <= spanOf(o, axis).half + 15 && u > spanOf(o, axis).lo + width * 0.3 && u < spanOf(o, axis).hi - width * 0.3);
    if (wall) best = { axis, wall, u, d };
  }
  if (!best && !leafFirst) {
    // no frame lines match a wall: cut the nearest wall run at the tag, at the schedule width
    let nd = 110;
    for (const o of walls) for (const axis of ['x', 'z'] as const) {
      if (!runsAlong(o, axis)) continue;
      const sp = spanOf(o, axis), u = axis === 'x' ? tag.x : tag.z, v = axis === 'x' ? tag.z : tag.x, dd = Math.abs(sp.c - v);
      if (dd < nd && u > sp.lo + width * 0.3 && u < sp.hi - width * 0.3) { nd = dd; best = { axis, wall: o, u, d: dd }; }
    }
  }
  if (!best && (DOOR_CODE.test(tag.code) || /^DW\d/.test(tag.code))) {
    // a door drawn open: its leaf is a line of about the door width standing square off the wall at the hinge,
    // with the tag inside the swing; the opening runs from the hinge along the wall towards the tag
    let door: Opening | null = null, dd = 150;
    for (const s of planSegs) {
      const la = Math.abs(s.z1 - s.z2) < 0.5 ? 'x' : Math.abs(s.x1 - s.x2) < 0.5 ? 'z' : null, L = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      if (!la || L < width * 0.8 || L > width * 1.25) continue;
      const md = Math.hypot((s.x1 + s.x2) / 2 - tag.x, (s.z1 + s.z2) / 2 - tag.z);
      if (md > dd) continue;
      const wa = la === 'x' ? 'z' : 'x';
      for (const [P, Q] of [[[s.x1, s.z1], [s.x2, s.z2]], [[s.x2, s.z2], [s.x1, s.z1]]]) {
        const pu = wa === 'x' ? P[0] : P[1], pv = wa === 'x' ? P[1] : P[0], qv = wa === 'x' ? Q[1] : Q[0], tu = wa === 'x' ? tag.x : tag.z, tv = wa === 'x' ? tag.z : tag.x;
        const w = walls.filter(o => runsAlong(o, wa) && Math.abs(spanOf(o, wa).c - pv) <= spanOf(o, wa).half + 8 && spanOf(o, wa).lo < pu + width * 2 && spanOf(o, wa).hi > pu - width * 2)
          .sort((p, q) => Math.abs(spanOf(p, wa).c - pv) - Math.abs(spanOf(q, wa).c - pv))[0];
        if (!w) continue;
        const sp = spanOf(w, wa), at = sp.c;
        if (Math.abs(qv - at) < width * 0.7 || Math.hypot(tu - pu, tv - at) > width * 2.5) continue;
        const dir = tu > pu ? 1 : -1, a = Math.min(pu, pu + dir * width), b = Math.max(pu, pu + dir * width);
        door = { axis: wa, cx: wa === 'x' ? (a + b) / 2 : at, cz: wa === 'x' ? at : (a + b) / 2, a, b, len: b - a, t: sp.half * 2, arc: true, tag: tag.code };
        dd = md;
      }
    }
    if (door) return door;
  }
  if (!best) {
    // a gap of about the schedule width between two wall ends on one line
    let gap: Opening | null = null, gd = 150;
    for (const o of walls) for (const axis of ['x', 'z'] as const) {
      if (!runsAlong(o, axis)) continue;
      const p = spanOf(o, axis);
      for (const q of walls) {
        if (q === o || q.rot) continue;
        const r = spanOf(q, axis), g = r.lo - p.hi;
        if (g < width * 0.65 || g > width * 1.4 || Math.abs(r.c - p.c) > Math.max(p.half, r.half) + 2) continue;
        const cx = axis === 'x' ? (p.hi + r.lo) / 2 : p.c, cz = axis === 'x' ? p.c : (p.hi + r.lo) / 2, dd = Math.hypot(cx - tag.x, cz - tag.z);
        if (dd < gd) { gd = dd; gap = { axis, cx, cz, a: p.hi, b: r.lo, len: g, t: p.half * 2, arc: false, tag: tag.code }; }
      }
    }
    if (gap) return gap;
  }
  if (!best && !DOOR_CODE.test(tag.code)) {
    // no wall there at all (it was a projection line, or never drawn): the window frame lines alone give the opening
    let ref: { axis: 'x' | 'z'; v: number; d: number } | null = null;
    for (const s of openSegs) {
      const axis = Math.abs(s.z1 - s.z2) < 0.5 ? 'x' : Math.abs(s.x1 - s.x2) < 0.5 ? 'z' : null;
      if (!axis || Math.abs(axis === 'x' ? s.x2 - s.x1 : s.z2 - s.z1) < width * 0.4) continue;
      const d = Math.hypot((s.x1 + s.x2) / 2 - tag.x, (s.z1 + s.z2) / 2 - tag.z);
      if (d <= 150 && (!ref || d < ref.d)) ref = { axis, v: axis === 'x' ? s.z1 : s.x1, d };
    }
    if (!ref) return null;
    const { axis, v } = ref, near = openSegs.filter(s => axis === 'x' ? Math.abs(s.z1 - s.z2) < 0.5 && Math.abs(s.z1 - v) < 25 : Math.abs(s.x1 - s.x2) < 0.5 && Math.abs(s.x1 - v) < 25)
      .map(s => ({ s, lo: axis === 'x' ? Math.min(s.x1, s.x2) : Math.min(s.z1, s.z2), hi: axis === 'x' ? Math.max(s.x1, s.x2) : Math.max(s.z1, s.z2) }));
    // the frame is the run of parallel lines touching the one nearest the tag (the next window's frame starts after a jamb gap)
    const first = near.reduce((p, q) => Math.abs((q.lo + q.hi) / 2 - (axis === 'x' ? tag.x : tag.z)) < Math.abs((p.lo + p.hi) / 2 - (axis === 'x' ? tag.x : tag.z)) && q.hi - q.lo >= width * 0.4 ? q : p);
    let lo = first.lo, hi = first.hi, grew = true;
    const par: typeof openSegs = [];
    while (grew) { grew = false; for (const q of near) if (!par.includes(q.s) && q.lo <= hi + 1 && q.hi >= lo - 1) { par.push(q.s); lo = Math.min(lo, q.lo); hi = Math.max(hi, q.hi); grew = true; } }
    const vs = par.map(s => axis === 'x' ? s.z1 : s.x1), c = (minOf(vs) + maxOf(vs)) / 2, t = Math.max(10, maxOf(vs) - minOf(vs));
    // the frame stops short of the jambs: run the opening to a wall or column face close by
    for (const o of walls) {
      const sp = spanOf(o, axis);
      if (Math.abs(sp.c - c) > sp.half + t / 2 + 5) continue;
      if (sp.lo >= hi - 1 && sp.lo - hi < 40) hi = sp.lo;
      if (sp.hi <= lo + 1 && lo - sp.hi < 40) lo = sp.hi;
    }
    if (hi - lo < width * 0.5 || hi - lo > width * 1.5) return null;
    return { axis, cx: axis === 'x' ? (lo + hi) / 2 : c, cz: axis === 'x' ? c : (lo + hi) / 2, a: lo, b: hi, len: hi - lo, t, arc: false, tag: tag.code };
  }
  if (!best) return null;
  const { axis, wall, u } = best, sp = spanOf(wall, axis);
  const a = Math.max(sp.lo, u - width / 2), b = Math.min(sp.hi, u + width / 2);
  if (b - a < width * 0.5) return null;
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
  if (!Number.isFinite(W) || !Number.isFinite(D)) W = D = 0;
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
  // walls grown by two cells: closes gaps up to about 40 cm (an opening drawn a little short of its jamb)
  let thick: Uint8Array | null = null;
  const grown = () => {
    if (thick) return thick;
    thick = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (wall[k]) {
      const i = k % nx, j = (k / nx) | 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < nz) thick[b * nx + a] = 1; }
    }
    return thick;
  };
  const region = (x: number, z: number, limit: number, close = false): Uint8Array | null => {
    const k0 = cell(x, z), solid = close ? grown() : wall;
    if (k0 < 0 || solid[k0]) return close ? region(x, z, limit) : null;
    const seen = new Uint8Array(N), stack = [k0];
    seen[k0] = 1;
    let n = 0;
    while (stack.length) {
      const k = stack.pop()!;
      if (++n > limit) return null;
      for (const m of nb(k)) if (!seen[m] && !solid[m]) { seen[m] = 1; stack.push(m); }
    }
    // grow back over the two cells taken by the thickened walls
    if (close) for (let r = 0; r < 2; r++) { const add: number[] = []; for (let k = 0; k < N; k++) if (seen[k]) for (const m of nb(k)) if (!seen[m] && !wall[m]) add.push(m); for (const m of add) seen[m] = 1; }
    return seen;
  };
  return { C, M, nx, nz, N, wall, nb, cell, region };
}

/**
 * Floor plate of a storey as rectangles: everything inside the outer walls (doorways up to
 * about a metre are bridged), the walls themselves included, minus shafts and light wells
 * named 天井 / 挑空 / 管道 and the `holes` cut for stairs coming up from below.
 */
/** min / max of a long list (Math.min(...list) overflows the call stack on a big drawing) */
function minOf(a: number[]) { let v = Infinity; for (const x of a) if (x < v) v = x; return v; }
function maxOf(a: number[]) { let v = -Infinity; for (const x of a) if (x > v) v = x; return v; }

/** the drawing's own 「*NF樓地板面積計算」 sum (…=228.32㎡) against the slab area the model built */
function areaChecks(d: DxfDrawing, keys: string[], objects: ModelObject[]) {
  const heads = d.texts.map(t => ({ f: /^\*?\s*([1-9]\d?)\s*F\s*樓地板面積/.exec(t.s.trim())?.[1], x: t.x, y: t.y })).filter(h => h.f);
  const heads2 = d.texts.filter(t => /^\*?\s*[1-9]\d?\s*F\s*(陽台|露台)面積|^\*?\s*[1-9]\d?\s*F\s*#/.test(t.s.trim()));
  const out: { floor: string; stated: number; built: number }[] = [];
  for (const h of heads) {
    const key = h.f + 'F';
    if (!keys.includes(key) || out.some(o => o.floor === key)) continue;
    const stop = maxOf([...heads2.filter(t => Math.abs(t.x - h.x) < 800 && t.y < h.y).map(t => t.y), h.y - 1500]);
    const r = d.texts.map(t => ({ v: /=\s*([\d.]+)\s*㎡/.exec(t.s), x: t.x, y: t.y })).filter(t => t.v && Math.abs(t.x - h.x) < 800 && t.y < h.y && t.y > stop).sort((p, q) => q.y - p.y)[0];
    if (!r) continue;
    const built = objects.reduce((n, o) => n + (o.floor === key && isBox(o) && o.layer === 'slab' && /（CAD）/.test(o.name) ? o.w * o.d : 0), 0) / 1e4;
    out.push({ floor: key, stated: +r.v![1], built: Math.round(built * 100) / 100 });
  }
  return out;
}

export function slabRects(walls: BoxObject[], labels: { x: number; z: number; s: string }[], W: number, D: number, holes: { x0: number; x1: number; z0: number; z1: number }[] = []) {
  // the margin round the plan must be wider than the widest bridging, or the thickened walls seal off the border
  const { C, M, nx, nz, N, wall, nb } = raster(walls, W, D, 200);
  const inside = (R: number) => {
    const dil = new Uint8Array(N);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (wall[j * nx + i])
      for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++)
        if ((a - i) ** 2 + (b - j) ** 2 <= R * R) dil[b * nx + a] = 1;
    // outside: flood from the border through the dilated walls, then grow back up to the walls
    const out = new Uint8Array(N);
    const q: number[] = [];
    for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; if ((i === 0 || j === 0 || i === nx - 1 || j === nz - 1) && !dil[k]) { out[k] = 1; q.push(k); } }
    while (q.length) { const k = q.pop()!; for (const m of nb(k)) if (!out[m] && !dil[m]) { out[m] = 1; q.push(m); } }
    // diagonal steps too, or the inside corners of the outside keep triangles R cells across (slivers of slab in the
    // corners of a terrace or a recess); a diagonal step does not slip between two wall cells
    for (let step = 0; step < R + 1; step++) {
      const add: number[] = [];
      for (let k = 0; k < N; k++) if (out[k]) {
        for (const m of nb(k)) if (!out[m] && !wall[m]) add.push(m);
        const i = k % nx;
        for (const [di, dj] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          if (i + di < 0 || i + di >= nx) continue;
          const m = k + dj * nx + di;
          if (m < 0 || m >= N || out[m] || wall[m] || wall[k + di] || wall[k + dj * nx]) continue;
          add.push(m);
        }
      }
      if (!add.length) break;
      for (const m of add) out[m] = 1;
    }
    const keep = new Uint8Array(N);
    let n = 0;
    for (let k = 0; k < N; k++) if (!out[k]) { keep[k] = 1; n++; }
    return { keep, n };
  };
  // gaps up to a metre are bridged first; a facade of columns, shop fronts and windows can leave wider ones that let
  // the outside flood into the rooms: bridge wider gaps while that still adds a good part of the floor
  let best = inside(5);
  for (const R of [10, 15]) {
    const t = inside(R);
    if (t.n < best.n * 1.15) break;
    best = t;
  }
  const keep = best.keep;
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
  return maskRects(keep, nx, nz, C, M);
}

type Rect = { x0: number; x1: number; z0: number; z1: number };
/**
 * The space round a label on a plan, closed off by any drawn line (walls, columns, the single line of a balcony
 * railing, window frames): a balcony strip outside the exterior wall that no wall box closes. Small gaps are bridged.
 * Null when it runs out further than maxArea cm² (the label is not in a closed space).
 */
export function spaceFromLines(segs: { x1: number; z1: number; x2: number; z2: number }[], x: number, z: number, maxArea = 600000): Rect[] | null {
  const C = 10, R0 = Math.sqrt(maxArea) * 1.5;
  const x0 = x - R0, z0 = z - R0, nx = Math.ceil(2 * R0 / C), nz = nx, N = nx * nz;
  const line = new Uint8Array(N);
  for (const q of segs) {
    const L = Math.hypot(q.x2 - q.x1, q.z2 - q.z1), n = Math.max(1, Math.ceil(L / 4));
    if (Math.max(q.x1, q.x2) < x0 || Math.min(q.x1, q.x2) > x0 + 2 * R0 || Math.max(q.z1, q.z2) < z0 || Math.min(q.z1, q.z2) > z0 + 2 * R0) continue;
    for (let t = 0; t <= n; t++) {
      const i = Math.floor((q.x1 + (q.x2 - q.x1) * t / n - x0) / C), j = Math.floor((q.z1 + (q.z2 - q.z1) * t / n - z0) / C);
      if (i >= 0 && j >= 0 && i < nx && j < nz) line[j * nx + i] = 1;
    }
  }
  const k0 = Math.floor((z - z0) / C) * nx + Math.floor((x - x0) / C), limit = maxArea / (C * C);
  for (const R of [0, 1, 2, 3, 4, 6]) {
    const solid = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (line[k]) {
      const i = k % nx, j = (k / nx) | 0;
      for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++) solid[b * nx + a] = 1;
    }
    // a label written over a line (a door swing): start from the nearest free cell beside it
    let ks = k0;
    for (let r = 1; solid[ks] && r <= 4; r++) for (let dj = -r; dj <= r && solid[ks]; dj++) for (let di = -r; di <= r; di++) { const m = k0 + dj * nx + di; if (m >= 0 && m < N && !solid[m]) { ks = m; break; } }
    if (solid[ks]) continue;
    const seen = new Uint8Array(N), st = [ks];
    seen[ks] = 1;
    let n = 0, open = false;
    while (st.length) {
      const k = st.pop()!, i = k % nx, j = (k / nx) | 0;
      if (++n > limit || i === 0 || j === 0 || i === nx - 1 || j === nz - 1) { open = true; break; }
      for (const m of [k - 1, k + 1, k - nx, k + nx]) if (!seen[m] && !solid[m]) { seen[m] = 1; st.push(m); }
    }
    if (open) continue;
    // back out to the lines, then over them (the line's own width: half a wall, the railing)
    for (let step = 0; step < R + 2; step++) {
      const add: number[] = [];
      for (let k = 0; k < N; k++) if (seen[k]) for (const m of [k - 1, k + 1, k - nx, k + nx]) if (m >= 0 && m < N && !seen[m] && (step === R + 1 || !line[m])) add.push(m);
      for (const m of add) seen[m] = 1;
    }
    return maskRects(seen, nx, nz, C, 0, 2000).map(r => ({ x0: r.x0 + x0, x1: r.x1 + x0, z0: r.z0 + z0, z1: r.z1 + z0 }));
  }
  return null;
}

/**
 * Rectangles crossed corner to corner by an X on a plan: drawn solid, the storey has no floor slab there (a void, a
 * shaft); drawn dashed, it is the projection of the opening in the floor above. At least 80 cm each way (smaller
 * crosses are columns, pipes and symbols).
 */
export function crossRects(segs: { x1: number; z1: number; x2: number; z2: number; dashed?: boolean }[]): (Rect & { dashed: boolean })[] {
  const diag = segs.filter(q => Math.abs(q.x1 - q.x2) >= 80 && Math.abs(q.z1 - q.z2) >= 80);
  const out: (Rect & { dashed: boolean })[] = [];
  for (let i = 0; i < diag.length; i++) for (let j = i + 1; j < diag.length; j++) {
    const p = diag[i], q = diag[j];
    if (Math.sign((p.x1 - p.x2) * (p.z1 - p.z2)) === Math.sign((q.x1 - q.x2) * (q.z1 - q.z2))) continue;
    const r = { x0: Math.min(p.x1, p.x2), x1: Math.max(p.x1, p.x2), z0: Math.min(p.z1, p.z2), z1: Math.max(p.z1, p.z2) };
    const t = { x0: Math.min(q.x1, q.x2), x1: Math.max(q.x1, q.x2), z0: Math.min(q.z1, q.z2), z1: Math.max(q.z1, q.z2) };
    if (Math.abs(r.x0 - t.x0) > 15 || Math.abs(r.x1 - t.x1) > 15 || Math.abs(r.z0 - t.z0) > 15 || Math.abs(r.z1 - t.z1) > 15) continue;
    const dashed = !!(p.dashed && q.dashed);
    if (!out.some(o => o.dashed === dashed && Math.abs(o.x0 - r.x0) < 15 && Math.abs(o.z0 - r.z0) < 15 && Math.abs(o.x1 - r.x1) < 15 && Math.abs(o.z1 - r.z1) < 15)) out.push({ ...r, dashed });
  }
  return out;
}
/**
 * Manual correction: the floor of the room around (x, z), bounded by a storey's walls, as rectangles. Doorways are
 * bridged (up to about 2.4 m, the narrowest bridging that closes the room is used); the slab runs under the walls'
 * inner halves. Parts already covered by `existing` slabs are left out. Empty when the point is not inside a room.
 */
export function roomSlabAt(walls: BoxObject[], x: number, z: number, W: number, D: number, existing: Rect[] = [], under = 2, within?: Rect[]): Rect[] {
  const { C, M, nx, nz, N, wall, nb, cell } = raster(walls, W, D, 200);
  // within a floor plate: its edge closes the space like a wall (a terrace bounded by walls on one side, open on the other)
  if (within) {
    const inPlate = new Uint8Array(N);
    for (const r of within)
      for (let j = Math.max(0, Math.round((r.z0 + M) / C)); j < Math.min(nz, Math.round((r.z1 + M) / C)); j++)
        for (let i = Math.max(0, Math.round((r.x0 + M) / C)); i < Math.min(nx, Math.round((r.x1 + M) / C)); i++) inPlate[j * nx + i] = 1;
    for (let k = 0; k < N; k++) if (!inPlate[k]) wall[k] = 1;
  }
  const k0 = cell(x, z);
  if (k0 < 0 || wall[k0]) return [];
  // inside a plate the space never opens to the outside: bridge doorways as widely as the seed allows
  for (const R of within ? [12, 8, 5, 3, 0] : [0, 3, 5, 8, 12]) {
    const dil = new Uint8Array(N);
    if (R) {
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (wall[j * nx + i])
        for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++)
          if ((a - i) ** 2 + (b - j) ** 2 <= R * R) dil[b * nx + a] = 1;
    } else dil.set(wall);
    if (dil[k0]) continue;
    const seen = new Uint8Array(N), stack = [k0];
    seen[k0] = 1;
    let open = false;
    while (stack.length && !open) {
      const k = stack.pop()!, i = k % nx, j = (k / nx) | 0;
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) { open = true; break; }
      for (const m of nb(k)) if (!seen[m] && !dil[m]) { seen[m] = 1; stack.push(m); }
    }
    if (open) continue;
    // back out to the wall faces: straight runs that end on a wall within the bridging (twice, for the corners),
    // so nothing spills out through a bridged doorway; then two cells (20 cm) under the walls
    for (let pass = 0; pass < 2 && R; pass++) {
      const add: number[] = [];
      for (let k = 0; k < N; k++) if (seen[k]) {
        const i = k % nx, j = (k / nx) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let s = 1;
          for (; s <= R + 1; s++) { const a = i + di * s, b = j + dj * s; if (a < 0 || b < 0 || a >= nx || b >= nz || wall[b * nx + a]) break; }
          const a = i + di * s, b = j + dj * s;
          if (s > R + 1 || a < 0 || b < 0 || a >= nx || b >= nz) continue;
          for (let t = 1; t < s; t++) add.push((j + dj * t) * nx + i + di * t);
        }
      }
      for (const m of add) seen[m] = 1;
    }
    for (let step = 0; step < under; step++) {
      const add: number[] = [];
      for (let k = 0; k < N; k++) if (seen[k]) for (const m of nb(k)) if (!seen[m] && wall[m]) add.push(m);
      for (const m of add) seen[m] = 1;
    }
    for (const r of existing)
      for (let j = Math.max(0, Math.round((r.z0 + M) / C)); j < Math.min(nz, Math.round((r.z1 + M) / C)); j++)
        for (let i = Math.max(0, Math.round((r.x0 + M) / C)); i < Math.min(nx, Math.round((r.x1 + M) / C)); i++) seen[j * nx + i] = 0;
    return maskRects(seen, nx, nz, C, M, 2000);
  }
  return [];
}

/** The part of rectangles `a` not covered by rectangles `b`, on a 10 cm grid, as rectangles of at least 0.2 m². */
/** `open`: slivers thinner than twice this many 10 cm cells are dropped (a narrow ledge is kept with 1) */
function subtractRects(a: Rect[], b: Rect[], W: number, D: number, open = 3): Rect[] {
  if (!a.length) return [];
  const M = 80, C = 10, nx = Math.ceil((W + 2 * M) / C), nz = Math.ceil((D + 2 * M) / C), m = new Uint8Array(nx * nz);
  const paint = (rs: Rect[], v: number) => {
    for (const r of rs)
      for (let j = Math.max(0, Math.round((r.z0 + M) / C)); j < Math.min(nz, Math.round((r.z1 + M) / C)); j++)
        for (let i = Math.max(0, Math.round((r.x0 + M) / C)); i < Math.min(nx, Math.round((r.x1 + M) / C)); i++) m[j * nx + i] = v;
  };
  paint(a, 1); paint(b, 0);
  // slivers along the edges of the two (thinner than 60 cm) are rounding, not floor: open the mask by 30 cm
  const morph = (src: Uint8Array, grow: boolean) => {
    const out = new Uint8Array(src.length), R = open;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      let hit = !grow;
      for (let b2 = j - R; b2 <= j + R && hit !== grow; b2++) for (let a2 = i - R; a2 <= i + R; a2++) {
        const v = b2 >= 0 && a2 >= 0 && b2 < nz && a2 < nx ? src[b2 * nx + a2] : 0;
        if (grow ? v : !v) { hit = grow; break; }
      }
      out[j * nx + i] = hit ? 1 : 0;
    }
    return out;
  };
  const opened = morph(morph(m, false), true);
  for (let k = 0; k < m.length; k++) opened[k] &= m[k];
  return maskRects(opened, nx, nz, C, M, 2000);
}
/** Cells of a raster merged into rectangles: runs per row, stacked while the next row has the same run. */
/** An outline of square corners as rectangles (5 cm raster). */
function polyRects(pts: number[][]): Rect[] {
  const C = 5, x0 = minOf(pts.map(p => p[0])), z0 = minOf(pts.map(p => p[1]));
  const nx = Math.ceil((maxOf(pts.map(p => p[0])) - x0) / C), nz = Math.ceil((maxOf(pts.map(p => p[1])) - z0) / C);
  if (nx <= 0 || nz <= 0 || nx * nz > 4e6) return [];
  const keep = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = z0 + (j + 0.5) * C;
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * C;
      let inside = false;
      for (let k = 0, l = pts.length - 1; k < pts.length; l = k++) {
        const [xi, zi] = pts[k], [xj, zj] = pts[l];
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) keep[j * nx + i] = 1;
    }
  }
  return maskRects(keep, nx, nz, C, 0, 0).map(r => ({ x0: r.x0 + x0, x1: r.x1 + x0, z0: r.z0 + z0, z1: r.z1 + z0 }));
}

function maskRects(keep: Uint8Array, nx: number, nz: number, C: number, M: number, minArea = 400): Rect[] {
  const rects: Rect[] = [];
  const open = new Map<string, Rect>();
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
  return rects.filter(r => (r.x1 - r.x0) * (r.z1 - r.z0) >= minArea);
}

/** open-air spaces named on a plan: walkways, terraces, balconies, courtyards */
const OUTDOOR = /外廊|騎樓|迴廊|露台|平台|陽台|曬衣|庭院|中庭|廣場|車道/;
/**
 * The roof plan laid on the top indoor storey. Indoor is what that storey's full-height walls, windows and doorways
 * close off from the outside (gaps up to a metre bridged), less the open-air spaces named on it (外廊, 露台),
 * each flooded out to the walls round it. The roof slab covers the indoor floor, and whatever the roof outline (holes in it filled) reaches beyond
 * that is the eaves (屋簷). Without a usable roof outline the indoor floor alone is roofed.
 */
function roofSplit(roof: Rect[], below: Rect[], walls: BoxObject[], outdoor: { x: number; z: number }[], rooms: { x: number; z: number }[], W: number, D: number): { indoor: Rect[]; eaves: Rect[] } {
  const { C, M, nx, nz, N, wall, nb } = raster(walls, W, D);
  const paint = (rs: Rect[]) => {
    const m = new Uint8Array(N);
    for (const r of rs)
      for (let j = Math.max(0, Math.round((r.z0 + M) / C)); j < Math.min(nz, Math.round((r.z1 + M) / C)); j++)
        for (let i = Math.max(0, Math.round((r.x0 + M) / C)); i < Math.min(nx, Math.round((r.x1 + M) / C)); i++) m[j * nx + i] = 1;
    return m;
  };
  const fillHoles = (m: Uint8Array) => {
    const out = new Uint8Array(N), q: number[] = [];
    for (let k = 0; k < N; k++) { const i = k % nx, j = (k / nx) | 0; if ((i === 0 || j === 0 || i === nx - 1 || j === nz - 1) && !m[k]) { out[k] = 1; q.push(k); } }
    while (q.length) { const k = q.pop()!; for (const n of nb(k)) if (!out[n] && !m[n]) { out[n] = 1; q.push(n); } }
    return out;
  };
  const dilate = (R: number) => {
    const t = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (wall[k]) {
      const i = k % nx, j = (k / nx) | 0;
      for (let b = Math.max(0, j - R); b <= Math.min(nz - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(nx - 1, i + R); a++)
        if ((a - i) ** 2 + (b - j) ** 2 <= R * R) t[b * nx + a] = 1;
    }
    return t;
  };
  // walls thickened by half a metre so doorless gaps close, flooded from outside, then grown back up to the walls
  const R = 5, thick = dilate(R);
  const out = fillHoles(thick);
  for (let step = 0; step < R + 1; step++) {
    const add: number[] = [];
    for (let k = 0; k < N; k++) if (out[k]) for (const n of nb(k)) if (!out[n] && !wall[n]) add.push(n);
    if (!add.length) break;
    for (const n of add) out[n] = 1;
  }
  // open-air spaces against rooms: every space named on the plan grows out from its name at the same pace between
  // the walls (thickened 20 cm), so an opening with nothing drawn in it is shared out where the two meet instead of
  // letting a walkway flood the room behind it; what the open-air names claim is outside, grown back up to the walls
  const cellOf = (p: { x: number; z: number }) => Math.floor((p.z + M) / C) * nx + Math.floor((p.x + M) / C);
  const r2 = 2, bar = dilate(r2), owner = new Int8Array(N);
  let front: number[] = [];
  for (const [list, tag] of [[outdoor, 1], [rooms, 2]] as const) for (const p of list) {
    const k = cellOf(p);
    if (k >= 0 && k < N && !out[k] && !bar[k] && !owner[k]) { owner[k] = tag; front.push(k); }
  }
  while (front.length) {
    const next: number[] = [];
    for (const k of front) for (const m of nb(k)) if (!owner[m] && !bar[m] && !out[m]) { owner[m] = owner[k]; next.push(m); }
    front = next;
  }
  const open = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (owner[k] === 1) open[k] = 1;
  for (let step = 0; step < r2 + 1; step++) {
    const add: number[] = [];
    for (let k = 0; k < N; k++) if (open[k]) for (const m of nb(k)) if (!open[m] && !wall[m] && owner[m] !== 2) add.push(m);
    for (const m of add) open[m] = 1;
  }
  for (let k = 0; k < N; k++) if (open[k]) out[k] = 1;
  const floor = paint(below), indoor = new Uint8Array(N);
  let nIn = 0;
  for (let k = 0; k < N; k++) if (!out[k] && floor[k]) { indoor[k] = 1; nIn++; }
  if (!nIn) return { indoor: below, eaves: [] };
  const rfOut = fillHoles(paint(roof)), eave = new Uint8Array(N);
  let nRf = 0;
  for (let k = 0; k < N; k++) if (!rfOut[k]) nRf++;
  // (a usable roof outline also bounds the roof: a walled yard or the outdoor steps are not roofed because the
  // walls round them close them off)
  if (nRf >= nIn * 0.3) for (let k = 0; k < N; k++) { eave[k] = !rfOut[k] && !indoor[k] ? 1 : 0; if (rfOut[k]) indoor[k] = 0; }
  // strips narrower than 20 cm along the outline are drawing slack, not eaves
  const eaves = maskRects(eave, nx, nz, C, M, 2000).filter(r => Math.min(r.x1 - r.x0, r.z1 - r.z0) >= 20);
  return { indoor: maskRects(indoor, nx, nz, C, M), eaves };
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
const STAIR_LAYER = /STAIR|樓梯|階梯|(^|\$)STA$/i;

/**
 * Thin wall lines (12 cm or less) that border a space named 陽台 / 露台 / 平台 are its
 * railing or parapet, those bordering a 雨遮 are the canopy edge, and those round a
 * projection note (上方雨遮投影) are not built at all. The outer edge of a 露台 / 平台, and
 * of the roof deck of a 屋突 storey, is its parapet or railing whatever the wall thickness.
 */
function classifyEdges(walls: BoxObject[], shut: BoxObject[], notes: { x: number; z: number; s: string }[], W: number, D: number, roof: boolean, rcColor?: number) {
  const g = raster([...walls, ...shut], W, D);
  const spaces: { kind: EdgeKind; label: string; cells: Uint8Array }[] = [];
  for (const n of notes) {
    const kind: EdgeKind | null = PLAN_NOTES.projection.test(n.s) ? 'projection' : PLAN_NOTES.canopy.test(n.s) ? 'canopy' : PLAN_NOTES.balcony.test(n.s) && n.s.length <= 8 ? 'balcony' : null;
    if (!kind) continue;
    // labels sit inside their space; a bigger space has leaked out through a doorway that was not found
    const cells = kind === 'balcony' ? g.region(n.x, n.z, 2500, /陽台/.test(n.s)) : g.region(n.x, n.z, 4000);
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
      const terrace = (k: number) => k >= 0 && (spaces.some(sp => sp.cells[k] && sp.kind === 'balcony' && /露台|平台|陽台/.test(sp.label)) || !!deck?.[k]);
      const air = (k: number) => k < 0 || !!outside[k];
      if ((terrace(ks[0]) && air(ks[1])) || (terrace(ks[1]) && air(ks[0]))) edge++;
      if (deck && terrace(ks[0]) && terrace(ks[1])) between++;
    }
    const label = labels[0] || (roof ? '屋頂平台' : '');
    // a wall drawn in the concrete-wall colour (15 cm or more) is a wall, even round a terrace (an RC end wall, a decorative column)
    if (rcColor !== undefined && w.wc === rcColor && Math.min(w.w, w.d) >= 14) continue;
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
  // a roof deck with a 女兒牆 height on the drawings is walled by an RC parapet, level with the column heads
  if (/平台/.test(label) && parapet) return { h: parapet, glass: false, solid: true, name: '女兒牆（CAD）' };
  if (/平台/.test(label)) {
    const m = notes.map(n => HEIGHT_NOTE.exec(n.s)).find(m => m && /欄杆|扶手/.test(m[1]));
    if (m) { const glass = /玻璃/.test(m[1]); return { h: +m[2], glass, solid: false, name: glass ? '玻璃欄杆（CAD）' : '欄杆（CAD）' }; }
  }
  // a balcony edge drawn as a double line is an RC railing
  const rc = /陽台/.test(label) && Math.min(w.w, w.d) > 12;
  let best: { m: RegExpExecArray; d: number } | null = null;
  for (const n of notes) {
    const m = HEIGHT_NOTE.exec(n.s), dist = Math.hypot(n.x - w.x, n.z - w.z);
    if (m && dist < 500 && (!best || dist < best.d)) best = { m, d: dist };
  }
  if (!best) return rc ? { h: def.h, glass: false, solid: true, name: 'RC欄杆（CAD）' } : def;
  const h = +best.m[2], kind = best.m[1];
  if (rc && !/女兒牆|矮牆|花台|玻璃/.test(kind)) return { h, glass: false, solid: true, name: 'RC欄杆（CAD）' };
  if (/女兒牆|矮牆|花台/.test(kind)) return { h, glass: false, solid: true, name: kind === '花台' ? '花台（CAD）' : '女兒牆（CAD）' };
  const glass = /玻璃/.test(kind) || def.glass;
  return { h, glass, solid: false, name: glass ? '玻璃欄杆（CAD）' : '欄杆（CAD）' };
}

/** Stairs of a storey from the tread lines; 上 labels mark where the climb starts. */
/**
 * The stairs drawn on one storey's plan. `ups` are the heights from this floor up to each storey above (the first is
 * the storey height): a riser count written on the plan (UP45) that is too many for one storey climbs on past a
 * mezzanine to the floor it fits (45 risers over 1F + 1MF, 800 cm, each 17.8 cm).
 */
function stairsOf(segs: { x1: number; z1: number; x2: number; z2: number }[], notes: { x: number; z: number; s: string }[], H: number, ups: number[] = [H]): (StairPlan & { labelled: number; climb: number })[] {
  const flights = findFlights(segs);
  if (!flights.length) return [];
  const start = notes.filter(n => /^(上|UP)\s*\d*$|^U\d{1,2}$/i.test(n.s.trim()));
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
  const labOf = new Map<StairPlan, { x: number; z: number; s: string }>();
  const plans = planStairs(flights, H, start, extent).map(sp => {
    // the 上 label of this stair gives its riser count
    const xs = sp.holes.flatMap(h => [h.x0, h.x1]), zs = sp.holes.flatMap(h => [h.z0, h.z1]);
    const lab = start.find(n => n.x > minOf(xs) - 60 && n.x < maxOf(xs) + 60 && n.z > minOf(zs) - 60 && n.z < maxOf(zs) + 60)
      // a riser count (U22) may sit a little further off, by the first step between two columns
      ?? start.find(n => /^U(P)?\s*\d/i.test(n.s.trim()) && n.x > minOf(xs) - 150 && n.x < maxOf(xs) + 150 && n.z > minOf(zs) - 150 && n.z < maxOf(zs) + 150);
    const N = lab ? +(/\d+/.exec(lab.s)?.[0] || 0) : 0;
    if (!(N >= 4 && N <= 80)) {
      // a few steps with no count written that would need risers over 21 cm to reach the floor above are only a
      // short run of steps (an entrance, a change of level): about 17 cm each
      if (H / sp.risers <= 21) return { ...sp, labelled: 0, climb: H };
      const short = planStairs(flights, sp.risers * 17, [], extent).find(q => q.risers === sp.risers && q.holes.some(h => sp.holes.some(o => h.x0 < o.x1 && h.x1 > o.x0 && h.z0 < o.z1 && h.z1 > o.z0)));
      return { ...(short || sp), labelled: 0, climb: sp.risers * 17 };
    }
    // the floor it reaches: the first whose height gives a riser of 14 to 21 cm
    const climb = ups.find(h => h / N >= 14 && h / N <= 21) ?? H;
    // a straight flight drawn with a few treads fewer than its count starts that many treads earlier, toward the label
    // (U22 written between the columns where the first step is, the tread lines starting past it)
    if (climb === H && !sp.landings.length && N > sp.risers && N - sp.risers <= 6) {
      const f = flights.find(q => sp.holes.some(h => (q.axis === 'z' ? (q.lo + q.hi) / 2 > h.x0 && (q.lo + q.hi) / 2 < h.x1 : (q.lo + q.hi) / 2 > h.z0 && (q.lo + q.hi) / 2 < h.z1)));
      if (f && lab) {
        const k = N - sp.risers, run = sp.run, along = f.axis === 'z' ? lab.z : lab.x, first = f.at[0], last = f.at[f.at.length - 1];
        const pre = Math.abs(along - first) <= Math.abs(along - last);
        const at = pre ? [...Array.from({ length: k }, (_, j) => first - (k - j) * run), ...f.at] : [...f.at, ...Array.from({ length: k }, (_, j) => last + (j + 1) * run)];
        const ext: StairFlight = { ...f, at }, mid = (f.lo + f.hi) / 2, s0 = pre ? at[0] : at[at.length - 1];
        const go = planStairs([ext], H, [f.axis === 'z' ? { x: mid, z: s0 } : { x: s0, z: mid }], extent)[0];
        if (go) return { ...go, labelled: N, climb };
      }
    }
    const box = { x0: minOf(xs), x1: maxOf(xs), z0: minOf(zs), z1: maxOf(zs) };
    const over = (q: StairPlan) => q.holes.some(h => h.x0 < box.x1 && h.x1 > box.x0 && h.z0 < box.z1 && h.z1 > box.z0);
    // a U stair with its count written: risers of climb / N each, round its flights until all N are climbed
    const round = planStairs(flights, climb, [lab!], extent, N).find(q => over(q) && q.risers === N && q.landings.length > 0);
    if (round && (climb > H || sp.landings.length)) {
      const r = { ...round, labelled: N, climb };
      labOf.set(r, lab!);
      return r;
    }
    if (climb === H) return { ...sp, labelled: N, climb };
    const again = planStairs(flights, climb, [lab!], extent).find(over);
    return again ? { ...again, labelled: N, climb } : { ...sp, labelled: N, climb: H };
  });
  // a U stair drawn as two flights is planned once per flight; the round one built from its count covers both
  const hit = (a: StairPlan, b: StairPlan) => a.holes.some(h => b.holes.some(o => h.x0 < o.x1 && h.x1 > o.x0 && h.z0 < o.z1 && h.z1 > o.z0));
  const rounds = plans.filter(p => labOf.has(p));
  return plans.filter(p => labOf.has(p)
    ? rounds.find(r => labOf.get(r) === labOf.get(p)) === p
    : !rounds.some(r => r.labelled === p.labelled && hit(r, p)));
}

/** Choices the user made on the review page; each defaults to what the drawing suggests. */
export interface BuildOptions {
  /** colour index of the exterior wall lines; -1 = do not tell concrete from light walls by colour */
  extColor?: number;
  /** keep lines marked 投影線 as walls instead of treating them as the projection of the storey above */
  noProjection?: boolean;
  /** drop slanted lines as cross lines even when long */
  noSlants?: boolean;
  /** sill height per door / window code, cm, where the schedule does not give it */
  sills?: Record<string, number>;
  /** what a drawing layer is, set by hand or learnt from the corrections made on earlier imports of the same office's drawings */
  layers?: Record<string, LayerRole>;
}
/** wall (concrete or partition by colour and thickness), rc / light (always that wall type), column (squares are columns), ignore */
export type LayerRole = 'wall' | 'rc' | 'light' | 'column' | 'ignore';

/** What was read, for the review page. */
export interface BuildReport {
  wallColours: { color: number; length: number }[];
  projectionLabels: number;
  stairs: { from: string; to: string; risers: number }[];
  slantWalls: number;
  unmatchedTags: { floor: string; code: string }[];
  perFloor: { key: string; walls: number; doors: number; windows: number; slabs: number }[];
  /** door / window schedule against what was built */
  /** 樓地板面積 written on the drawing (法規檢討) against the slab built */
  areaChecks: { floor: string; stated: number; built: number }[];
  /** drawings compared with each other: levels and storeys before building, elevation widths after */
  cross: CrossCheck[];
  /** what does not add up in the built model (合理性自檢), and what the software filled in on its own */
  issues: Issue[];
  tally: { code: string; name: string; qty?: number; built: number; guessed?: number; tagged?: number }[];
}

export interface BuildingResult {
  objects: ModelObject[];
  cad: CadData;
  analysis: BuildingAnalysis;
  report: BuildReport;
  stats: { floors: number; walls: number; doors: number; windows: number; railings: number; heads: number; /** colour index read as the exterior wall line, when the plans use more than one wall colour */ extColor?: number };
}

const BEAM_LAYER = /^BM|BEAM|梁/i;
/** Beam marks on structural plans: G1a(30x60), FG4a(50x155/195), or the mark and the size as two texts. */
const BEAM_MARK = /^(F?[GBJ]\d*[a-z]?|F?J\d*[a-z]?)\s*\((\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*\/\s*(\d{2,3}))?\)$/;
const BEAM_CODE = /^F?[GBJ]\d*[a-z]?$/, BEAM_SIZE = /^\((\d{2,3})\s*[xX×]\s*(\d{2,3})(?:\s*\/\s*(\d{2,3}))?\)$/;

/** A row of a 尺寸表 (size table): marks it covers, e.g. "FB*,FG*,CFG*" or "Fb1~Fb3", and the section written beside them. */
interface SizeRow { test: (code: string) => boolean; w: number; h: number; x: number; y: number }
export function readSizeTable(d: DxfDrawing): SizeRow[] {
  const SIZE2 = /^(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)$/, LIST = /^[A-Za-z][A-Za-z0-9*~,]*$/;
  const rows: SizeRow[] = [];
  for (const t of d.texts) {
    let s = t.s.trim(), y = t.y;
    if (!LIST.test(s) || s.length < 2) continue;
    const h = t.h || 12;
    // a list ending in a comma goes on in the line below ("b101~b105,Cb101," / "Cb103~Cb105"); its size is written between the two
    if (s.endsWith(',')) {
      const next = d.texts.filter(o => o !== t && LIST.test(o.s.trim()) && Math.abs(o.x - t.x) < h && t.y - o.y > h * 0.5 && t.y - o.y < h * 3)
        .sort((p, q) => q.y - p.y)[0];
      if (next) { s += next.s.trim(); y = (t.y + next.y) / 2; }
    }
    const sz = d.texts.map(o => ({ o, m: SIZE2.exec(o.s.trim()) })).filter(q => q.m && Math.abs(q.o.y - y) <= h * 0.6 && q.o.x > t.x + h * 6 && q.o.x < t.x + h * 60)
      .sort((p, q) => Math.abs(p.o.y - y) - Math.abs(q.o.y - y))[0];
    if (!sz) continue;
    const parts = s.split(',').filter(Boolean).map(tok => {
      const star = /^([A-Za-z]+)\*$/.exec(tok), range = /^([A-Za-z]+)(\d+)~(?:[A-Za-z]+)?(\d+)$/.exec(tok);
      if (star) return (c: string) => c.startsWith(star[1]);
      if (range) return (c: string) => { const m = /^([A-Za-z]+)(\d+)$/.exec(c); return !!m && m[1] === range[1] && +m[2] >= +range[2] && +m[2] <= +range[3]; };
      return (c: string) => c === tok;
    });
    rows.push({ test: c => parts.some(f => f(c)), w: +sz.m![1], h: +sz.m![2], x: t.x, y: t.y });
  }
  return rows;
}

/** Beams of one structural plan: paired beam outlines, each named and sized by the nearest beam mark. */
function readBeams(d: DxfDrawing, v: SheetView, X: (x: number) => number, Z: (y: number) => number, S: number, table: SizeRow[] = []) {
  const segs = d.segs.filter(s => BEAM_LAYER.test(s.layer) && inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1]));
  // a mark at a corner can sit a little outside the sheet view's box (羅宅 Cb104 beside the slanted edge)
  const gx = (v.box[2] - v.box[0]) * 0.05, gy = (v.box[3] - v.box[1]) * 0.05;
  const tbox: [number, number, number, number] = [v.box[0] - gx, v.box[1] - gy, v.box[2] + gx, v.box[3] + gy];
  const texts = d.texts.filter(t => inBox(tbox, t.x, t.y));
  const marks: { code: string; w: number; h: number; x: number; z: number }[] = [];
  for (const t of texts) {
    const m = BEAM_MARK.exec(t.s.trim());
    if (m) { marks.push({ code: m[1], w: +m[2], h: m[4] ? (+m[3] + +m[4]) / 2 : +m[3], x: X(t.x), z: Z(t.y) }); continue; }
    // marks written alone, their section given in the plan's size table (nearest table to this plan wins; the specific row beats the wildcard)
    if (/梁編號/.test(t.layer) && table.length) {
      const code = t.s.trim(), cx = (v.box[0] + v.box[2]) / 2, cy = (v.box[1] + v.box[3]) / 2;
      const hit = table.filter(r => r.test(code)).sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy))[0];
      if (hit) { marks.push({ code, w: hit.w, h: hit.h, x: X(t.x), z: Z(t.y) }); continue; }
    }
    if (!BEAM_CODE.test(t.s.trim())) continue;
    const sz = texts.map(o => ({ o, m: BEAM_SIZE.exec(o.s.trim()) })).filter(q => q.m && Math.hypot(q.o.x - t.x, q.o.y - t.y) < (t.h || 25) * 4)
      .sort((p, q) => Math.hypot(p.o.x - t.x, p.o.y - t.y) - Math.hypot(q.o.x - t.x, q.o.y - t.y))[0];
    if (sz) marks.push({ code: t.s.trim(), w: +sz.m![1], h: sz.m![3] ? (+sz.m![2] + +sz.m![3]) / 2 : +sz.m![2], x: X(t.x), z: Z(t.y) });
  }
  // pairWalls carries a wall half its thickness past the drawn lines to close corners; a beam ends where its lines
  // end (a cantilever stops at the slab edge, not 20 cm beyond it)
  const paired = pairWalls(segs.map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) })));
  const lines = paired.filter(l => !l.single && l.t >= 15 && l.t <= 80).map(l => {
    const L0 = Math.hypot(l.bx - l.ax, l.bz - l.az), e = Math.min(l.t / 2, L0 / 4), fx = (l.bx - l.ax) / L0 * e, fz = (l.bz - l.az) / L0 * e;
    return { ...l, ax: l.ax + fx, az: l.az + fz, bx: l.bx - fx, bz: l.bz - fz };
  });
  // the mark is written beside the beam, within its length
  const dist = (l: (typeof lines)[number], m: (typeof marks)[number]) => {
    const len = Math.hypot(l.bx - l.ax, l.bz - l.az), ux = (l.bx - l.ax) / len, uz = (l.bz - l.az) / len;
    const u = (m.x - l.ax) * ux + (m.z - l.az) * uz, off = Math.abs((m.x - l.ax) * uz - (m.z - l.az) * ux);
    // (a mark is written within its beam's span: one just past the end counts, but weakly, so it does not take the
    // neighbouring beam's line from the mark written along it)
    return u < -60 || u > len + 60 || off > 70 * S + l.t ? Infinity : off + 3 * Math.max(0, -u, u - len);
  };
  // each mark claims the line it sits beside (the nearest one of its width; a mark of another width only when no
  // line of its own width is near): marks are written beside their own beam, so this direction is the reliable one.
  // A line two marks claim keeps the closer and the other goes to its next line. Lines left without a mark take the
  // nearest one (a beam running over several spans is marked once)
  const score = (l: (typeof lines)[number], m: (typeof marks)[number]) => { const dd = dist(l, m); return dd + Math.min(100, Math.abs(m.w - l.t) * 8); };
  const cand = marks.map(m => lines.map((l, i) => ({ i, sc: score(l, m) })).filter(c => c.sc < Infinity).sort((a, b) => a.sc - b.sc));
  const markOf: (number | null)[] = lines.map(() => null), scoreOf = lines.map(() => Infinity);
  const queue = marks.map((_, k) => ({ k, tries: 0 }));
  while (queue.length) {
    const q = queue.shift()!, c = cand[q.k][q.tries];
    if (!c || q.tries > 3) continue;
    if (markOf[c.i] === null || scoreOf[c.i] > c.sc) {
      const was = markOf[c.i];
      markOf[c.i] = q.k; scoreOf[c.i] = c.sc;
      if (was !== null) queue.push({ k: was, tries: cand[was].findIndex(x => x.i === c.i) + 1 });
    } else queue.push({ k: q.k, tries: q.tries + 1 });
  }
  const out = lines.map((l, i) => {
    const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
    let mark: (typeof marks)[number] | null = markOf[i] !== null ? marks[markOf[i]!] : null;
    if (!mark) { let bd = Infinity; for (const m of marks) { const sc = score(l, m); if (sc < bd) { bd = sc; mark = m; } } }
    return { ax: l.ax, az: l.az, bx: l.bx, bz: l.bz, len, t: l.t, mark, single: false };
  });
  // a beam drawn with one line only (its other face is the slab edge or a wall line) is still built, along that
  // line with the size its mark gives, when the mark sits beside it and no pair of lines claimed the mark
  const claimed = new Set(out.map(l => l.mark));
  const singles = paired.filter(l => l.single && Math.hypot(l.bx - l.ax, l.bz - l.az) >= 60).map(l => ({ ...l, t: 0 }));
  for (const m of marks) {
    if (claimed.has(m)) continue;
    const l = singles.map(l => ({ l, d: dist(l, m) })).filter(q => q.d < 70 * S + m.w).sort((p, q) => p.d - q.d)[0]?.l;
    if (!l) continue;
    const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
    if (out.some(o => o.mark === m) || singles.filter(x => x !== l && dist(x, m) < 70 * S + m.w && Math.abs(Math.atan2(x.bz - x.az, x.bx - x.ax) - Math.atan2(l.bz - l.az, l.bx - l.ax)) % Math.PI < 0.05).length > 2) continue;
    out.push({ ax: l.ax, az: l.az, bx: l.bx, bz: l.bz, len, t: 0, mark: m, single: true });
  }
  // marks away from every beam line (a size table or legend beside the plan) are not counted as beams left unbuilt
  const bx0 = minOf(lines.map(l => Math.min(l.ax, l.bx))) - 150 * S, bx1 = maxOf(lines.map(l => Math.max(l.ax, l.bx))) + 150 * S;
  const bz0 = minOf(lines.map(l => Math.min(l.az, l.bz))) - 150 * S, bz1 = maxOf(lines.map(l => Math.max(l.az, l.bz))) + 150 * S;
  const onPlan = lines.length ? marks.filter(m => m.x > bx0 && m.x < bx1 && m.z > bz0 && m.z < bz1) : [];
  // (debugging aid for the test harness: DBGM=<mark> prints how that mark was matched)
  const dbg = typeof process !== 'undefined' && process.env?.DBGM;
  if (dbg) for (const m of marks) if (m.code === dbg) console.log('MK', v.title, m.code, Math.round(m.x), Math.round(m.z), 'onPlan', onPlan.includes(m), 'claimed', out.some(o => o.mark === m), 'lines', lines.map((l, i) => ({ l, i, sc: score(l, m) })).filter(q => q.sc < 400).map(q => `${Math.round(q.l.ax)},${Math.round(q.l.az)}-${Math.round(q.l.bx)},${Math.round(q.l.bz)} t${Math.round(q.l.t)} sc${Math.round(q.sc)}->${out[q.i].mark?.code}`).join(' | '), 'singles', singles.filter(l => dist(l, m) < 200).map(l => `${Math.round(l.ax)},${Math.round(l.az)}-${Math.round(l.bx)},${Math.round(l.bz)} d${Math.round(dist(l, m))}`).join(' | '));
  return { lines: out, marks: onPlan };
}

/** column outlines; numbered variants (COL1) are the columns of the storey below, drawn hidden */
const COL_LAYER = /^(?:0?S-)?(?:COL|COLUMN|COLS|柱)$/i, COL_MARK = /^C\d+[a-z]?$/;
/** Columns of one structural plan: closed outlines on the column layer, each named by the nearest column mark (C1, C2 …). */
function readColumns(d: DxfDrawing, v: SheetView, X: (x: number) => number, Z: (y: number) => number, S: number) {
  const marks = d.texts.filter(t => COL_MARK.test(t.s.trim()) && inBox(v.box, t.x, t.y)).map(t => ({ mark: t.s.trim(), x: X(t.x), z: Z(t.y) }));
  const out: { mark: string; x: number; z: number; w: number; d: number }[] = [];
  for (const p of d.polys) {
    if (!COL_LAYER.test(p.layer) || p.pts.length < 4 || !p.pts.every(q => inBox(v.box, q[0], q[1]))) continue;
    const xs = p.pts.map(q => X(q[0])), zs = p.pts.map(q => Z(q[1]));
    const x0 = minOf(xs), x1 = maxOf(xs), z0 = minOf(zs), z1 = maxOf(zs), w = x1 - x0, dd = z1 - z0;
    if (w < 20 || dd < 20 || w > 200 || dd > 200) continue;
    const x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    if (out.some(c => Math.abs(c.x - x) < 5 && Math.abs(c.z - z) < 5)) continue;
    const m = marks.map(m => ({ m, dist: Math.hypot(m.x - x, m.z - z) })).sort((a, b) => a.dist - b.dist)[0];
    if (!m || m.dist > Math.max(w, dd) + 120 * S) continue;
    out.push({ mark: m.m.mark, x, z, w: Math.round(w), d: Math.round(dd) });
  }
  // marks on the plan that no column outline sits by (an outline on another layer, or drawn as lines)
  const x0 = minOf(out.map(c => c.x)) - 150 * S, x1 = maxOf(out.map(c => c.x)) + 150 * S, z0 = minOf(out.map(c => c.z)) - 150 * S, z1 = maxOf(out.map(c => c.z)) + 150 * S;
  const missing = out.length ? marks.filter(m => m.x > x0 && m.x < x1 && m.z > z0 && m.z < z1 && !out.some(c => Math.hypot(c.x - m.x, c.z - m.z) <= Math.max(c.w, c.d) + 120 * S)) : [];
  return Object.assign(out, { missing });
}

const SLAB_MARK = /^(?:F?C?S\d{1,2}|BS\d{1,2}|Sw)$/;
/** Slab panels of one structural plan: from each slab mark (S1, CS1, FS1 …) out to the beam centre lines round it. */
function readPanels(d: DxfDrawing, v: SheetView, X: (x: number) => number, Z: (y: number) => number, lines: ReturnType<typeof readBeams>['lines'], W: number, D: number) {
  const out: { mark: string; x0: number; x1: number; z0: number; z1: number }[] = [];
  const ln = lines.map(l => ({ ...l, xa: Math.min(l.ax, l.bx), xb: Math.max(l.ax, l.bx), za: Math.min(l.az, l.bz), zb: Math.max(l.az, l.bz), vert: Math.abs(l.bx - l.ax) < Math.abs(l.bz - l.az) }));
  for (const t of d.texts) {
    const mark = t.s.trim();
    if (!SLAB_MARK.test(mark) || /圖框/.test(t.layer) || !inBox(v.box, t.x, t.y)) continue;
    const x = X(t.x), z = Z(t.y);
    const hit = (dir: 'x+' | 'x-' | 'z+' | 'z-') => {
      let best = Infinity;
      for (const l of ln) {
        if (dir[0] === 'x' ? !l.vert || z < l.za - 20 || z > l.zb + 20 : l.vert || x < l.xa - 20 || x > l.xb + 20) continue;
        const c = dir[0] === 'x' ? (l.xa + l.xb) / 2 : (l.za + l.zb) / 2, dd = dir[1] === '+' ? c - (dir[0] === 'x' ? x : z) : (dir[0] === 'x' ? x : z) - c;
        if (dd > 5 && dd < best) best = dd;
      }
      return best;
    };
    let [xp, xm, zp, zm] = (['x+', 'x-', 'z+', 'z-'] as const).map(hit);
    // a cantilever has no beam at its free edge: up to the outline, at most 1.5 m
    const free = (v: number, edge: number) => isFinite(v) && v < 1500 ? v : Math.max(30, Math.min(150, edge));
    xp = free(xp, W - x); xm = free(xm, x); zp = free(zp, D - z); zm = free(zm, z);
    if (out.some(p => p.mark === mark && Math.abs(p.x0 - (x - xm)) < 5 && Math.abs(p.z0 - (z - zm)) < 5)) continue;
    out.push({ mark, x0: x - xm, x1: x + xp, z0: z - zm, z1: z + zp });
  }
  return out;
}

interface PlanLine { x1: number; z1: number; x2: number; z2: number; win: boolean; layer: string }

/**
 * Between two columns standing in line there is nearly always a wall or a window. Where the model has neither
 * but the plan draws two or more lines along that span (window frames, a wall on a layer not read as wall,
 * a balcony upstand), the span is closed: a window with sill and head when the lines are on a window layer,
 * a 110 cm upstand on a balcony, otherwise a full-height wall. Returns the next free id.
 */
function fillBetweenColumns(objects: ModelObject[], f: CadFloor, lines: PlanLine[], outdoor: { x: number; z: number }[], id: number): number {
  const mine = objects.filter((o): o is BoxObject => isBox(o) && o.floor === f.key);
  // (columns read from a column layer stand in the walls already drawn: no fill between them)
  const cols = mine.filter(o => o.layer === 'wall' && !o.rot && o.src !== 'column' && Math.min(o.w, o.d) >= 25 && Math.max(o.w, o.d) <= 120 && Math.max(o.w, o.d) <= Math.min(o.w, o.d) * 2.5 && o.h >= f.h * 0.8);
  if (cols.length < 2) return id;
  const doors = objects.filter((o): o is DoorObject => !isBox(o) && o.layer === 'door' && o.floor === f.key);
  const done = new Set<string>();
  for (const axis of ['x', 'z'] as const) {
    const lo = (o: BoxObject) => axis === 'x' ? o.x - o.w / 2 : o.z - o.d / 2, hi = (o: BoxObject) => axis === 'x' ? o.x + o.w / 2 : o.z + o.d / 2;
    const clo = (o: BoxObject) => axis === 'x' ? o.z - o.d / 2 : o.x - o.w / 2, chi = (o: BoxObject) => axis === 'x' ? o.z + o.d / 2 : o.x + o.w / 2;
    for (const c of cols) {
      // the next column along the axis whose cross range overlaps this one's
      const next = cols.filter(o => o !== c && lo(o) > hi(c) + 50 && lo(o) - hi(c) < 900 && Math.min(chi(o), chi(c)) - Math.max(clo(o), clo(c)) >= Math.min(chi(o) - clo(o), chi(c) - clo(c)) * 0.5)
        .sort((p, q) => lo(p) - lo(q))[0];
      if (!next) continue;
      const a = hi(c), b = lo(next), v0 = Math.max(clo(c), clo(next)), v1 = Math.min(chi(c), chi(next));
      const key = `${axis}${Math.round(a)},${Math.round(b)},${Math.round(v0)}`;
      if (done.has(key)) continue;
      done.add(key);
      // a column standing in the way means the two are not neighbours
      if (cols.some(o => o !== c && o !== next && hi(o) > a && lo(o) < b && chi(o) > v0 && clo(o) < v1)) continue;
      // what the model already has along the span
      const cover: [number, number][] = [];
      for (const o of mine) {
        if (o === c || o === next || o.layer === 'slab' || o.rot) continue;
        const along = axis === 'x' ? o.w >= o.d : o.d >= o.w;
        if (!along || chi(o) < v0 - 15 || clo(o) > v1 + 15) continue;
        if (hi(o) > a && lo(o) < b) cover.push([Math.max(a, lo(o)), Math.min(b, hi(o))]);
      }
      for (const dr of doors) if (dr.axis === axis && dr.at > v0 - 15 && dr.at < v1 + 15 && dr.b > a && dr.a < b) cover.push([Math.max(a, dr.a), Math.min(b, dr.b)]);
      const gaps = openSpans(a, b, cover).filter(([p, q]) => q - p >= 40);
      if (!gaps.length) continue;
      for (const [p, q] of gaps) {
        // drawn lines running along the gap inside the columns' band
        const ev = lines.filter(l => {
          const along = axis === 'x' ? Math.abs(l.z1 - l.z2) < 1 : Math.abs(l.x1 - l.x2) < 1;
          // beams and ceiling lines drawn dashed over the plan run from column to column too: they are not walls
          if (!along || /BEAM|梁|HID|隱|DASH|虛|CEIL|天花|投影|上方|GRID|軸|T08/i.test(l.layer)) return false;
          const v = axis === 'x' ? l.z1 : l.x1, s0 = Math.min(axis === 'x' ? l.x1 : l.z1, axis === 'x' ? l.x2 : l.z2), s1 = Math.max(axis === 'x' ? l.x1 : l.z1, axis === 'x' ? l.x2 : l.z2);
          return v >= v0 - 5 && v <= v1 + 5 && Math.min(s1, q) - Math.max(s0, p) >= (q - p) * 0.6;
        });
        const vs = [...new Set(ev.map(l => Math.round(axis === 'x' ? l.z1 : l.x1)))];
        if (vs.length < 2) continue;
        const win = ev.filter(l => l.win).length * 2 >= ev.length;
        const m0 = Math.min(...vs), m1 = Math.max(...vs), t = Math.min(30, Math.max(12, m1 - m0)), mid = (m0 + m1) / 2;
        const len = q - p, cu = (p + q) / 2;
        const box = (y: number, h: number, name: string, layer: BoxObject['layer'], color: number, th = t) => {
          objects.push({ id: id++, layer, name, x: axis === 'x' ? cu : mid, z: axis === 'x' ? mid : cu, w: axis === 'x' ? len : th, d: axis === 'x' ? th : len, h, y: f.y + y, color, floor: f.key });
        };
        if (win) {
          const sill = 90, oh = Math.min(f.h - sill - 20, 150);
          box(0, sill, '窗台（自動補牆）', 'wall', 0xeeebe5);
          box(sill, oh, `窗 ${Math.round(len)}×${Math.round(oh)}（自動補牆）`, 'glass', 0xa9dcff, Math.min(t, 6));
          box(sill + oh, f.h - sill - oh, '窗楣（自動補牆）', 'wall', 0xeeebe5);
        } else if (outdoor.some(o => Math.abs((axis === 'x' ? o.x : o.z) - cu) < len / 2 + 50 && Math.abs((axis === 'x' ? o.z : o.x) - mid) < 300)) {
          box(0, 110, '陽台女兒牆（自動補牆）', 'wall', 0xeeebe5);
        } else box(0, f.h, '外牆（自動補牆）', 'wall', 0xeeebe5);
      }
    }
  }
  return id;
}

/** Parts of [a, b] not covered by any of the intervals. */
function openSpans(a: number, b: number, cover: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let at = a;
  for (const [p, q] of cover.sort((u, v) => u[0] - v[0])) {
    if (p > at) out.push([at, Math.min(p, b)]);
    at = Math.max(at, q);
    if (at >= b) break;
  }
  if (at < b) out.push([at, b]);
  return out;
}

/** Builds every storey of the analysed drawing set, stacked at its level. */
export function buildBuilding(d: DxfDrawing, a: BuildingAnalysis, name: string, firstId = 1, opts: BuildOptions = {}): BuildingResult {
  const S = a.scale;
  const roles = Object.entries(opts.layers || {});
  extraWall = new Set([...a.wallLayers, ...roles.filter(([, r]) => r === 'wall' || r === 'rc' || r === 'light').map(([l]) => l)]);
  ignoreNow = new Set(roles.filter(([, r]) => r === 'ignore' || r === 'column').map(([l]) => l));
  scaleNow = S; optNow = opts;
  const colLs = [...a.colLayers.filter(l => !roles.some(([k, r]) => k === l && r !== 'column')), ...roles.filter(([, r]) => r === 'column').map(([l]) => l)];
  const unmatchedTags: BuildReport['unmatchedTags'] = [], stairList: BuildReport['stairs'] = [];
  let projectionLabels = 0;
  const geos = new Map(a.plans.map(p => [p, planGeo(d, p)]));
  // the plans the storeys are built from (a site plan repeating the ground floor is not one of them)
  const used = new Set(a.storeys.map(st => a.plans.find(p => p.floors.includes(st.key))));
  alignOutlines(a.storeys.map(st => geos.get(a.plans.find(p => p.floors.includes(st.key))!)!), S);
  let minX = Infinity, maxY = -Infinity, maxX = -Infinity, minY = Infinity;
  for (const [p, g] of geos) if (used.has(p)) for (const s of g.segs) if (isWallLayer(s.layer)) for (const p of [s.a, s.b]) {
    minX = Math.min(minX, p[0] - g.ox); maxX = Math.max(maxX, p[0] - g.ox); minY = Math.min(minY, p[1] - g.oy); maxY = Math.max(maxY, p[1] - g.oy);
  }
  let W = (maxX - minX) * S, D = (maxY - minY) * S;
  const codes = new Map(a.schedule.map(i => [i.code, i]));
  // tags written on the plans per code (a corner window counts once per leg); openings without a tag are given the codes still short of this
  const taggedN = new Map<string, number>(), builtCount = new Map<string, number>(), guessedN = new Map<string, number>();
  for (const p of a.plans.filter(p => used.has(p))) {
    const seen: { c: string; x: number; y: number }[] = [];
    for (const t of d.texts) {
      const c = t.s.trim();
      const g = geos.get(p)!, tx = (t.x - g.ox - minX) * S, tz = (maxY - (t.y - g.oy)) * S;
      if (!codes.has(c) || !inBox(p.box, t.x, t.y) || tx < -100 || tz < -100 || tx > W + 100 || tz > D + 100 || seen.some(o => o.c === c && Math.hypot(o.x - t.x, o.y - t.y) < 1)) continue;
      seen.push({ c, x: t.x, y: t.y });
      taggedN.set(c, (taggedN.get(c) || 0) + 1);
      builtCount.set(c, (builtCount.get(c) || 0) + (codes.get(c)!.legs ? codes.get(c)!.legs!.length : 1));
    }
  }
  let id = firstId;
  const objects: ModelObject[] = [];
  const floors: CadFloor[] = [];
  const linesOf = new Map<string, PlanLine[]>();
  /** floor and balcony outlines of the area review drawn on each plan */
  const areaOf = new Map<string, { kind: 'floor' | 'balcony'; rects: Rect[] }[]>();
  /** every drawn line of a storey's plan but notes, dimensions and grids: what closes off a space on the drawing */
  const drawnOf = new Map<string, { x1: number; z1: number; x2: number; z2: number }[]>();
  /** the plan's short texts in model coordinates, per storey */
  const notesOf = new Map<string, { x: number; z: number; s: string }[]>();
  // a piece of floor is carried up only inside a space closed off on the plan above (walls, parapets, grilles,
  // any line): a piece off the outer corner of the walls, or the outdoor steps beside the building, lies in the open
  const closedOn = (lines: { x1: number; z1: number; x2: number; z2: number }[] | undefined, ws: { x: number; z: number; w: number; d: number; rot?: number }[]) => {
    const spaces: Rect[] = [];
    return (r: Rect) => {
      if (!lines?.length) return true;
      // (not from inside a wall: the space between its two lines, or over a line at a space's edge)
      const seeds = [[(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2], [r.x0 + 5, r.z0 + 5], [r.x1 - 5, r.z0 + 5], [r.x0 + 5, r.z1 - 5], [r.x1 - 5, r.z1 - 5]]
        .filter(([x, z]) => !ws.some(o => Math.abs(x - o.x) < (o.rot ? Math.max(o.w, o.d) : o.w) / 2 + 5 && Math.abs(z - o.z) < (o.rot ? Math.max(o.w, o.d) : o.d) / 2 + 5));
      // (a strip wholly under a wall, the roof under its parapet, belongs to the space the wall bounds)
      if (!seeds.length) return true;
      const at = ([x, z]: number[]) => spaces.some(q => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1);
      if (seeds.some(at)) return true;
      for (const [x, z] of seeds) {
        const got = spaceFromLines(lines, x, z, 1e6);
        if (got?.length && Math.min(maxOf(got.map(q => q.x1)) - minOf(got.map(q => q.x0)), maxOf(got.map(q => q.z1)) - minOf(got.map(q => q.z0))) >= 60) { spaces.push(...got); return true; }
      }
      return false;
    };
  };
  let nWalls = 0, nDoors = 0, nWins = 0, nRails = 0, cutHeads = 0;
  let below: StairPlan['holes'] = [];
  /** a stair that climbs past a storey (over a mezzanine): holes in the storeys it passes and in the one it arrives at */
  const passHoles = new Map<string, StairPlan['holes']>();
  const railing = railingDefault(d, a), beamDepth = beamDepthOf(d, a);
  // 女兒牆高度 written anywhere (plans, elevations, sections)
  const parapetNote = d.texts.some(t => /女兒牆/.test(HEIGHT_NOTE.exec(t.s)?.[1] || '')) ? a.parapet : null;
  const slabsOf = new Map<string, { x0: number; x1: number; z0: number; z1: number }[]>();
  const holesOf = new Map<string, { x0: number; x1: number; z0: number; z1: number }[]>();
  const terraces = new Map<string, { x: number; z: number; s: string }[]>();
  /** floor openings: the storey's own (solid X), the storey above's (dashed X), the open sky over a 露台 */
  const voidsOf = new Map<string, Rect[]>(), voidsUp = new Map<string, Rect[]>(), openAt = new Map<string, { x: number; z: number }[]>();
  /** balconies (floor and ceiling slab) and terraces (floor only) found from the plan lines round their labels */
  const outSpaces = new Map<string, { kind: 'balcony' | 'terrace' | 'ac' | 'panel'; rects: Rect[]; h?: number }[]>();
  const greenOf = new Map<string, { x1: number; z1: number; x2: number; z2: number }[]>();
  /** names of open-air spaces on each storey (外廊, 露台 …) on any layer: they are not under the roof */
  const outdoorOf = new Map<string, { x: number; z: number }[]>(), roomsOf = new Map<string, { x: number; z: number }[]>();
  const slants: { key: string; side: 'w' | 'e'; x1: number; z1: number; x2: number; z2: number }[] = [];
  const beamLines: { st: Storey; xs: number[]; zs: number[]; grids: Map<string, { axis: 'x' | 'z'; at: Map<string, number> }> }[] = [];
  /** drawing layer names, referred to by number from each floor's plan lines */
  const layerNames: string[] = [], layerNo = (l: string) => { const i = layerNames.indexOf(l); return i >= 0 ? i : layerNames.push(l) - 1; };

  // an unlabelled stair is drawn in full on the plan of the storey it arrives at (the lower plan cuts it short): it climbs the storey below
  const stairPre = new Map<string, ReturnType<typeof stairsOf>>();
  const stairIn = new Map<string, { segs: { x1: number; z1: number; x2: number; z2: number }[]; notes: { x: number; z: number; s: string }[]; labelled: boolean }>();
  for (const st of a.storeys) {
    if (st.key === 'RF') continue;
    const plan = a.plans.find(p => p.floors.includes(st.key))!, g = geos.get(plan)!;
    const X = (x: number) => (x - g.ox - minX) * S, Z = (y: number) => (maxY - (y - g.oy)) * S;
    const segs = g.segs.filter(s => STAIR_LAYER.test(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const notes = d.texts.filter(t => inBox(plan.box, t.x, t.y)).map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }));
    stairIn.set(st.key, { segs, notes, labelled: notes.some(n => /^(上|下|UP|DN)\s*\d*$|^U\d{1,2}$/i.test(n.s.trim())) });
    const i = a.storeys.indexOf(st), ups = a.storeys.slice(i, i + 3).filter(u => u.key !== 'RF').map(u => u.base + u.h - st.base);
    stairPre.set(st.key, stairsOf(segs, notes, st.h, ups));
  }
  a.storeys.forEach((st, i) => {
    const nx = a.storeys[i + 1], q = stairPre.get(st.key), p = nx && stairPre.get(nx.key), qi = stairIn.get(st.key), pi = nx && stairIn.get(nx.key);
    // a labelled lower plan (U22) cut short keeps its label: its count and start go with the full flight drawn above
    if (!nx || !q?.length || p?.length !== 1 || pi!.labelled || p[0].risers <= q[0].risers || (qi!.labelled && q.length !== 1)) return;
    const box = (sp: StairPlan) => ({ x0: minOf(sp.holes.map(h => h.x0)), x1: maxOf(sp.holes.map(h => h.x1)), z0: minOf(sp.holes.map(h => h.z0)), z1: maxOf(sp.holes.map(h => h.z1)) });
    const A = box(q[0]), B = box(p[0]);
    if (Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) < 30 || Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0) < 30) return;
    const i2 = a.storeys.indexOf(st), ups = a.storeys.slice(i2, i2 + 3).filter(u => u.key !== 'RF').map(u => u.base + u.h - st.base);
    stairPre.set(st.key, qi!.labelled ? stairsOf(pi!.segs, qi!.notes, st.h, ups) : stairsOf(pi!.segs, [], st.h));
    stairPre.set(nx.key, []);
  });

  for (const st of a.storeys) {
    const plan = a.plans.find(p => p.floors.includes(st.key))!, g = geos.get(plan)!;
    const X = (x: number) => (x - g.ox - minX) * S, Z = (y: number) => (maxY - (y - g.oy)) * S;
    const H = st.h, parapet = st.key === 'RF';
    const lines = pairWalls(g.segs.filter(s => isWallLayer(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]), c: /^(?:0?S-)?(?:COL|COLUMN|COLS|柱)/i.test(s.layer) ? undefined : s.color, l: s.layer })));
    const openSegs = g.segs.filter(s => isOpenLayer(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const planSegs = g.segs.filter(s => !/GRID|AXIS|DIM|軸|尺寸/i.test(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const swings = d.arcs.filter(c => isOpenLayer(c.layer) && inBox(plan.box, c.c[0], c.c[1]) && c.sweep > 70 && c.sweep < 110 && c.r * S >= 50 && c.r * S <= 200 && c.p0 && c.p1)
      .map(c => ({ x: X(c.c[0]), z: Z(c.c[1]), r: c.r * S, ends: [[X(c.p0![0]), Z(c.p0![1])], [X(c.p1![0]), Z(c.p1![1])]] as [number, number][] }));
    const tags: { code: string; x: number; z: number }[] = [];
    for (const t of d.texts) {
      const c = t.s.trim();
      if (!codes.has(c) || !inBox(plan.box, t.x, t.y)) continue;
      const x = X(t.x), z = Z(t.y);
      // a code written in a note beside the building (a legal-review line) is not a tag on a door or window
      if (x < -100 || z < -100 || x > W + 100 || z > D + 100) continue;
      if (!tags.some(o => o.code === c && Math.hypot(o.x - x, o.z - z) < 5)) tags.push({ code: c, x, z });
    }
    const texts = d.texts.filter(t => inBox(plan.box, t.x, t.y) && /(^|\$)TEXT$|ROOM|室名|空間/i.test(t.layer) && /[一-鿿]/.test(t.s) && t.s.length <= 12 && !/[0-9]{2,}|㎡|坪|高度|詳|說明|同|$^/.test(t.s))
      .map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }))
      .filter(t => t.x > -50 && t.z > -50 && t.x < W + 50 && t.z < D + 50);
    const add = (o: Omit<BoxObject, 'id' | 'floor'>) => objects.push({ ...o, id: id++, floor: st.key, y: st.base + o.y });

    // unpaired diagonal lines are usually shaft crosses or hatching, not walls
    const walls = dropLouvers(lines.filter(w => !w.single || Math.abs(w.ax - w.bx) < 1 || Math.abs(w.az - w.bz) < 1).map(w => wallBox(w, H, 0)));
    // a long slanted wall-layer line on the outer side is the slanted edge of this storey's slab (balcony following the site boundary)
    {
      const cand = g.segs.filter(q => isWallLayer(q.layer)).map(q => ({ x1: X(q.a[0]), z1: Z(q.a[1]), x2: X(q.b[0]), z2: Z(q.b[1]) }))
        .filter(q => { const dx = Math.abs(q.x2 - q.x1), dz = Math.abs(q.z2 - q.z1); return dz >= 250 && dx / dz > 0.04 && dx / dz < 0.6; });
      for (const side of ['w', 'e'] as const) {
        const here = cand.filter(q => side === 'w' ? (q.x1 + q.x2) / 2 < W / 2 : (q.x1 + q.x2) / 2 >= W / 2);
        const best = here.sort((p, q) => side === 'w' ? (p.x1 + p.x2) - (q.x1 + q.x2) : (q.x1 + q.x2) - (p.x1 + p.x2))[0];
        if (best) slants.push({ key: st.key, side, ...best });
      }
    }
    // a line marked 投影線 is the outline of the storey above projecting out (a balcony), not a wall: drop what lies beyond the facade it hangs off
    for (const t of d.texts) {
      if (opts.noProjection || !/投影線/.test(t.s) || !inBox(plan.box, t.x, t.y)) continue;
      projectionLabels++;
      const tx = X(t.x), tz = Z(t.y);
      let near: { c: number; horiz: boolean; d: number } | null = null;
      for (const q of openSegs) {
        const horiz = Math.abs(q.z1 - q.z2) < 0.5, vert = Math.abs(q.x1 - q.x2) < 0.5;
        if ((!horiz && !vert) || Math.hypot(q.x1 - q.x2, q.z1 - q.z2) < 40) continue;
        // the facade line the label hangs off: 40 to 300 cm away across, level with the label along
        const across = Math.abs((horiz ? tz - q.z1 : tx - q.x1)), lo = horiz ? Math.min(q.x1, q.x2) : Math.min(q.z1, q.z2), hi = horiz ? Math.max(q.x1, q.x2) : Math.max(q.z1, q.z2), along = horiz ? tx : tz;
        if (across < 40 || across > 300 || along < lo - 450 || along > hi + 450) continue;
        if (!near || across < near.d) near = { c: horiz ? q.z1 : q.x1, horiz, d: across };
      }
      // the line the label points at: its colour is the projection colour, and walls of that colour out beyond the rest are projection too
      let hit: BoxObject | null = null, hd = 300;
      for (const o of walls) {
        if (o.wc === undefined || (Math.max(o.w, o.d) < 120 && Math.min(o.w, o.d) >= 25)) continue;
        const dd = Math.hypot(Math.max(Math.abs(tx - o.x) - o.w / 2, 0), Math.max(Math.abs(tz - o.z) - o.d / 2, 0));
        if (dd < hd) { hd = dd; hit = o; }
      }
      if (hit) {
        const rest = walls.filter(o => o.wc !== hit!.wc);
        if (rest.length) {
          const hx0 = minOf(rest.map(o => o.x - o.w / 2)), hx1 = maxOf(rest.map(o => o.x + o.w / 2)), hz0 = minOf(rest.map(o => o.z - o.d / 2)), hz1 = maxOf(rest.map(o => o.z + o.d / 2));
          for (let i = walls.length - 1; i >= 0; i--) {
            const o = walls[i];
            if (o.wc === hit.wc && (o.x < hx0 - 10 || o.x > hx1 + 10 || o.z < hz0 - 10 || o.z > hz1 + 10) && !(Math.max(o.w, o.d) < 120 && Math.min(o.w, o.d) >= 25)) walls.splice(i, 1);
          }
        }
      }
      if (!near) continue;
      const sign = (near.horiz ? tz : tx) > near.c ? 1 : -1;
      for (let i = walls.length - 1; i >= 0; i--) {
        const o = walls[i];
        if (Math.max(o.w, o.d) < 120 && Math.min(o.w, o.d) >= 25) continue;
        if (((near.horiz ? o.z : o.x) - near.c) * sign > 40) walls.splice(i, 1);
      }
    }
    const openings = parapet ? [] : findOpenings(walls, openSegs, swings);
    // a door drawn over a wall that has no gap (a door added later, on its own layer, not the door layers read above): a quarter swing hinged inside
    // the wall with its closed leaf lying along it cuts the wall open
    if (!parapet) for (const c of d.arcs) {
      if (isOpenLayer(c.layer) || !inBox(plan.box, c.c[0], c.c[1]) || c.sweep < 80 || c.sweep > 100 || c.r * S < 60 || c.r * S > 150 || !c.p0 || !c.p1) continue;
      const hx = X(c.c[0]), hz = Z(c.c[1]), r = c.r * S;
      for (const [ex, ez] of [[X(c.p0[0]), Z(c.p0[1])], [X(c.p1[0]), Z(c.p1[1])]]) {
        const axis = Math.abs(ex - hx) > Math.abs(ez - hz) * 4 ? 'x' : Math.abs(ez - hz) > Math.abs(ex - hx) * 4 ? 'z' : null;
        if (!axis) continue;
        const u0 = axis === 'x' ? hx : hz, u1 = axis === 'x' ? ex : ez, at = axis === 'x' ? hz : hx;
        const a0 = Math.min(u0, u1), b0 = Math.max(u0, u1);
        const w = walls.find(o => runsAlong(o, axis) && Math.abs(spanOf(o, axis).c - at) <= spanOf(o, axis).half + 3 && spanOf(o, axis).lo <= a0 + 2 && spanOf(o, axis).hi >= b0 - 2);
        if (!w || openings.some(op => op.axis === axis && Math.abs((axis === 'x' ? op.cz : op.cx) - at) < 30 && op.a < b0 && op.b > a0)) continue;
        const sp = spanOf(w, axis), t = sp.half * 2;
        if (b0 - sp.lo < 10 || sp.hi - a0 < 10) continue;
        const rest = { ...w };
        setSpan(w, axis, sp.lo, a0);
        if (sp.hi - b0 > 1) { setSpan(rest, axis, b0, sp.hi); walls.push(rest); }
        if (a0 - sp.lo <= 1) walls.splice(walls.indexOf(w), 1);
        openings.push({ axis, cx: axis === 'x' ? (a0 + b0) / 2 : sp.c, cz: axis === 'x' ? sp.c : (a0 + b0) / 2, a: a0, b: b0, len: r, t, arc: true });
        break;
      }
    }
    // each opening takes the nearest tag; tags left over point at openings drawn without a wall gap
    const dist = (t: { x: number; z: number }, op: Opening) => Math.hypot(t.x - op.cx, t.z - op.cz);
    // openings with no tag on the plan take a schedule code that is still short of its quantity, by width (and by the storey the schedule names)
    const stillShort = (it: ScheduleItem) => it.qty !== undefined && (builtCount.get(it.code) || 0) < it.qty * (it.legs ? it.legs.length : 1);
    const owner = new Map<Opening, (typeof tags)[number]>();
    for (const op of openings) { const t = tags.filter(t => dist(t, op) < 200).sort((p, q) => dist(p, op) - dist(q, op))[0]; if (t) { owner.set(op, t); op.tag = t.code; } }
    // a tag names one opening: a door tag goes to the opening with a swing, else the nearest; a door tag's other
    // claimant without a swing is not an opening at all (a shaft or a door leaf drawn beside it), so its wall is closed again
    for (const t of tags) {
      const mine = openings.filter(op => owner.get(op) === t);
      if (mine.length < 2) continue;
      const door = DOOR_CODE.test(t.code);
      mine.sort((p, q) => (door ? +q.arc - +p.arc : 0) || dist(t, p) - dist(t, q));
      for (const op of mine.slice(1)) {
        op.tag = undefined;
        if (!door || op.arc) continue;
        const at = op.axis === 'x' ? op.cz : op.cx;
        const nb = walls.find(o => runsAlong(o, op.axis) && Math.abs(spanOf(o, op.axis).c - at) < 25 && (Math.abs(spanOf(o, op.axis).hi - op.a) < 30 || Math.abs(spanOf(o, op.axis).lo - op.b) < 30));
        if (nb) { const w = { ...nb }; setSpan(w, op.axis, op.a, op.b); walls.push(w); }
        openings.splice(openings.indexOf(op), 1);
      }
    }
    if (!parapet) {
      const used = new Set(tags.filter(t => openings.some(op => dist(t, op) < 200 && op.tag === t.code)));
      for (const t of tags) if (!used.has(t)) { const clash = (op: Opening | null) => !!op && openings.some(q => q.axis === op.axis && Math.abs((q.axis === 'x' ? q.cz - op.cz : q.cx - op.cx)) < 30 && q.a < op.b - 5 && q.b > op.a + 5);
        const it = codes.get(t.code)!;
        let op: Opening | null = null;
        // a corner window is found by one leg; the other is picked up at its corner below
        for (const w of it.legs || [it.w]) {
          op = cutTagged(walls, t, w, openSegs, planSegs);
          // lines that already belong to another opening: look for the door leaf instead
          if (clash(op)) op = cutTagged(walls, t, w, openSegs, planSegs, true);
          if (op && !clash(op)) break;
        }
        if (clash(op)) op = null;
        if (op) openings.push(op); else if (!openings.some(op => op.tag === t.code && dist(t, op) < 400)) unmatchedTags.push({ floor: st.key, code: t.code }); }
      // a corner window turns at one end of the opening it was matched to: the other leg's frame runs off that corner
      for (const op of [...openings]) {
        if (!(op.tag && codes.get(op.tag)?.legs)) continue;
        const at = op.axis === 'x' ? op.cz : op.cx, la = op.axis === 'x' ? 'z' : 'x';
        for (const end of [op.a, op.b]) {
          const near = openSegs.filter(q => la === 'x' ? Math.abs(q.z1 - q.z2) < 0.5 : Math.abs(q.x1 - q.x2) < 0.5)
            .map(q => ({ v: la === 'x' ? q.z1 : q.x1, lo: la === 'x' ? Math.min(q.x1, q.x2) : Math.min(q.z1, q.z2), hi: la === 'x' ? Math.max(q.x1, q.x2) : Math.max(q.z1, q.z2) }))
            .filter(q => Math.abs(q.v - end) <= 40);
          const seed = near.filter(q => q.hi - q.lo >= 40 && (Math.abs(q.lo - at) <= 40 || Math.abs(q.hi - at) <= 40))[0];
          if (!seed) continue;
          let lo = seed.lo, hi = seed.hi, grew = true;
          const run = new Set([seed]);
          while (grew) { grew = false; for (const q of near) if (!run.has(q) && q.lo <= hi + 1 && q.hi >= lo - 1 && Math.abs(q.v - seed.v) < 25) { run.add(q); lo = Math.min(lo, q.lo); hi = Math.max(hi, q.hi); grew = true; } }
          const vs = [...run].map(q => q.v), c = (minOf(vs) + maxOf(vs)) / 2, t = Math.max(10, maxOf(vs) - minOf(vs));
          const leg: Opening = { axis: la, cx: la === 'x' ? (lo + hi) / 2 : c, cz: la === 'x' ? c : (lo + hi) / 2, a: lo, b: hi, len: hi - lo, t, arc: false, tag: op.tag };
          if (leg.len >= 40 && !openings.some(q => q.axis === la && Math.abs((la === 'x' ? q.cz - leg.cz : q.cx - leg.cx)) < 30 && q.a < hi - 5 && q.b > lo + 5)) openings.push(leg);
        }
      }
      // a window with no tag takes the nearest-width window code the schedule still counts short of (named storey first)
      {
        const pairs: { op: Opening; it: ScheduleItem; score: number }[] = [];
        for (const op of openings) {
          if (op.tag || op.arc) continue;
          for (const it of a.schedule) {
            if (it.kind !== 'window' || it.legs || it.qty === undefined) continue;
            const diff = Math.abs(op.len - it.w);
            if (diff > Math.max(25, it.w * 0.4)) continue;
            pairs.push({ op, it, score: diff + (it.where && it.where !== st.key ? 1000 : 0) });
          }
        }
        pairs.sort((p, q) => p.score - q.score);
        for (const { op, it } of pairs) {
          if (op.tag || !stillShort(it)) continue;
          op.tag = it.code; guessedN.set(it.code, (guessedN.get(it.code) || 0) + 1);
          builtCount.set(it.code, (builtCount.get(it.code) || 0) + 1);
        }
      }
      // a wall drawn straight through an opening is cut out of it
      for (const op of openings) for (let i = walls.length - 1; i >= 0; i--) {
        const o = walls[i];
        if (o.name === '柱' || o.rc) continue;
        const sp = spanOf(o, op.axis), oc = op.axis === 'x' ? op.cz : op.cx;
        // stray bits inside the opening (a sill or threshold line, the frame of a bay window) are not walls
        if (!o.rot && Math.abs(sp.c - oc) <= sp.half + op.t / 2 + 2 && sp.lo >= op.a - 3 && sp.hi <= op.b + 3 && sp.half <= 40) { walls.splice(i, 1); continue; }
        if (!runsAlong(o, op.axis) || Math.max(o.w, o.d) < 60) continue;
        if (Math.abs(sp.c - oc) > sp.half + 1 || sp.lo >= op.b - 5 || sp.hi <= op.a + 5) continue;
        if (sp.lo >= op.a - 1 && sp.hi <= op.b + 1) { walls.splice(i, 1); continue; }
        if (sp.hi > op.b + 1) walls.push({ ...o, ...(op.axis === 'x' ? { x: (op.b + sp.hi) / 2, w: sp.hi - op.b } : { z: (op.b + sp.hi) / 2, d: sp.hi - op.b }) });
        if (sp.lo < op.a - 1) setSpan(o, op.axis, sp.lo, op.a); else walls.splice(i, 1);
      }
      fillGaps(walls, openings);
    }
    // openings count as closed when finding the outline
    const shut = openings.map(op => ({ ...walls[0], x: op.cx, z: op.cz, w: op.axis === 'x' ? op.len : op.t, d: op.axis === 'x' ? op.t : op.len, rot: 0 }));
    // thin lines round balconies are railings, round canopies the slab edge, and projections nothing
    const notes = d.texts.filter(t => inBox(plan.box, t.x, t.y)).map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }));
    notesOf.set(st.key, notes);
    // in a balcony a double line on any layer (often the stair layer), or a short slanted pair on the wall layer, is an RC railing
    const railCand: BoxObject[] = [];
    if (!parapet) {
      const balc = notes.filter(n => /陽台|露台/.test(n.s) && n.s.length <= 8 && !/投影|面積/.test(n.s));
      const stairPairs = pairWalls(g.segs.filter(q => STAIR_LAYER.test(q.layer)).map(q => ({ x1: X(q.a[0]), z1: Z(q.a[1]), x2: X(q.b[0]), z2: Z(q.b[1]) })));
      const slanted = lines.filter(l => Math.abs(l.ax - l.bx) >= 1 && Math.abs(l.az - l.bz) >= 1);
      // a stair is not a balcony: its treads (equal parallel lines a riser apart) and anything over its flights or landings stay stair
      const flight = (stairPre.get(st.key) || []).flatMap(sp => [...sp.steps, ...sp.landings]);
      const inStair = (x: number, z: number) => flight.some(t => x >= Math.min(t.x0, t.x1) - 40 && x <= Math.max(t.x0, t.x1) + 40 && z >= Math.min(t.z0, t.z1) - 40 && z <= Math.max(t.z0, t.z1) + 40);
      const tread = (l: typeof stairPairs[number]) => {
        const lx = Math.abs(l.bx - l.ax) >= Math.abs(l.bz - l.az), len = Math.hypot(l.bx - l.ax, l.bz - l.az);
        return stairPairs.filter(o => o !== l && (Math.abs(o.bx - o.ax) >= Math.abs(o.bz - o.az)) === lx && Math.abs(Math.hypot(o.bx - o.ax, o.bz - o.az) - len) < 10
          && (lx ? Math.abs((o.ax + o.bx) / 2 - (l.ax + l.bx) / 2) < 15 && Math.abs(o.az - l.az) < 120 : Math.abs((o.az + o.bz) / 2 - (l.az + l.bz) / 2) < 15 && Math.abs(o.ax - l.ax) < 120)).length >= 2;
      };
      for (const l of [...stairPairs, ...slanted]) {
        const len = Math.hypot(l.bx - l.ax, l.bz - l.az), mx = (l.ax + l.bx) / 2, mz = (l.az + l.bz) / 2;
        if (l.single || l.t < 8 || l.t > 25 || len < 60 || len > 1200 || !balc.some(n => Math.hypot(n.x - mx, n.z - mz) < 450)) continue;
        if (inStair(mx, mz) || (stairPairs.includes(l) && tread(l))) continue;
        const b = wallBox(l, H, 0);
        // already built (a slanted wall kept as a wall), or this pair found twice
        if ([...walls, ...railCand].some(o => Math.abs(o.x - b.x) < 10 && Math.abs(o.z - b.z) < 10 && Math.abs(Math.max(o.w, o.d) - Math.max(b.w, b.d)) < 30)) continue;
        railCand.push(b);
      }
      // a run of equal parallel pairs side by side (treads, louvres, a hatch) is a pattern, not a railing
      const same = (p: BoxObject, q: BoxObject) => p !== q && Math.abs((p.rot || 0) - (q.rot || 0)) < 0.2 && Math.abs(p.w - q.w) < 10 && Math.abs(p.d - q.d) < 10 && Math.hypot(p.x - q.x, p.z - q.z) < 130;
      const pattern = railCand.filter(p => railCand.filter(q => same(p, q)).length >= 2);
      for (const p of pattern) railCand.splice(railCand.indexOf(p), 1);
    }
    // the colour most of this storey's thick wall lines are drawn in is the concrete-wall colour (only when the walls use two colours or more)
    const colLen = new Map<number, number>();
    for (const w of walls) if (w.wc !== undefined && Math.min(w.w, w.d) >= 14 && w.name !== '柱') colLen.set(w.wc, (colLen.get(w.wc) || 0) + Math.max(w.w, w.d));
    const rcColor = colLen.size >= 2 ? [...colLen].sort((p, q) => q[1] - p[1])[0][0] : undefined;
    const edges = parapet ? new Map<BoxObject, { kind: EdgeKind; label: string }>() : classifyEdges(walls, [...shut, ...railCand], notes, W, D, st.key.startsWith('R'), rcColor);
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
    // columns on a layer named for them (column, 柱): a red outline, often only three sides with the fourth on the wall
    // line it stands against; each becomes a 柱 reaching through that wall (the pairs its lines made are not walls)
    if (!parapet) {
      const COLL = /(^|\$)(column|col|柱)[^$]*$/i;
      const cs = [...g.segs.filter(q => COLL.test(q.layer)).map(q => [q.a, q.b]),
        ...d.polys.filter(p => COLL.test(p.layer) && p.pts.length && inBox(plan.box, p.pts[0][0], p.pts[0][1])).flatMap(p => p.pts.slice(1).map((q, i) => [p.pts[i], q]).concat(p.closed ? [[p.pts[p.pts.length - 1], p.pts[0]]] : []))]
        .map(([a, b]) => ({ x1: X(a[0]), z1: Z(a[1]), x2: X(b[0]), z2: Z(b[1]) }))
        .filter(q => (Math.abs(q.x1 - q.x2) < 1 || Math.abs(q.z1 - q.z2) < 1) && Math.hypot(q.x2 - q.x1, q.z2 - q.z1) >= 5);
      // connected outlines
      const grp = cs.map((_, i) => i), root = (i: number): number => grp[i] === i ? i : (grp[i] = root(grp[i]));
      const near = (p: number[], q: number[]) => Math.abs(p[0] - q[0]) < 3 && Math.abs(p[1] - q[1]) < 3;
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if ([[a.x1, a.z1], [a.x2, a.z2]].some(p => [[b.x1, b.z1], [b.x2, b.z2]].some(q => near(p, q)))) grp[root(i)] = root(j);
      }
      const sets = new Map<number, typeof cs>();
      cs.forEach((q, i) => (sets.get(root(i)) || sets.set(root(i), []).get(root(i))!).push(q));
      const made: BoxObject[] = [];
      for (const qs of sets.values()) {
        let x0 = minOf(qs.flatMap(q => [q.x1, q.x2])), x1 = maxOf(qs.flatMap(q => [q.x1, q.x2])), z0 = minOf(qs.flatMap(q => [q.z1, q.z2])), z1 = maxOf(qs.flatMap(q => [q.z1, q.z2]));
        if (x1 - x0 < 15 || z1 - z0 < 15 || x1 - x0 > 200 || z1 - z0 > 200) continue;
        // a side with no line of its own is open onto the wall: carry the column through to the wall's far face
        const on = (horiz: boolean, c: number, lo: number, hi: number) => qs.filter(q => horiz ? Math.abs(q.z1 - c) < 2 && Math.abs(q.z2 - c) < 2 : Math.abs(q.x1 - c) < 2 && Math.abs(q.x2 - c) < 2)
          .reduce((n, q) => n + (horiz ? Math.abs(q.x2 - q.x1) : Math.abs(q.z2 - q.z1)), 0) >= (hi - lo) * 0.6;
        const sides = { n: on(true, z0, x0, x1), s: on(true, z1, x0, x1), w: on(false, x0, z0, z1), e: on(false, x1, z0, z1) };
        const through = (side: 'n' | 's' | 'w' | 'e') => {
          const horiz = side === 'n' || side === 's', c = { n: z0, s: z1, w: x0, e: x1 }[side], out = side === 'n' || side === 'w' ? -1 : 1;
          const host = walls.find(o => !o.rot && (horiz ? o.w > o.d && Math.abs((o.z - out * o.d / 2) - c) < 4 && o.x - o.w / 2 < x1 && o.x + o.w / 2 > x0
            : o.d > o.w && Math.abs((o.x - out * o.w / 2) - c) < 4 && o.z - o.d / 2 < z1 && o.z + o.d / 2 > z0) && Math.min(o.w, o.d) <= 60);
          return host ? (horiz ? host.z + out * host.d / 2 : host.x + out * host.w / 2) : c;
        };
        if (!sides.n) z0 = through('n');
        if (!sides.s) z1 = through('s');
        if (!sides.w) x0 = through('w');
        if (!sides.e) x1 = through('e');
        const x = (x0 + x1) / 2, z = (z0 + z1) / 2;
        if (x < -50 || z < -50 || x > W + 50 || z > D + 50) continue;
        if ([...made, ...objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && o.name === '柱')].some(o => Math.abs(o.x - x) < 10 && Math.abs(o.z - z) < 10)) continue;
        made.push({ id: 0, layer: 'wall', name: '柱', x, z, w: Math.round(x1 - x0), d: Math.round(z1 - z0), y: 0, h: H, color: 0xeeebe5, src: 'column' });
      }
      if (made.length) {
        for (let i = walls.length - 1; i >= 0; i--) if (walls[i].src && COLL.test(walls[i].src!)) walls.splice(i, 1);
        for (const c of made) { const { id: _, ...o } = c; add(o); }
      }
    }
    for (const b of walls) if (b.w > 1 && b.d > 1) add({ ...b, y: 0, name: parapet ? '女兒牆（CAD）' : b.name });
    for (const b of railCand) {
      add({ ...b, layer: 'wall', y: 0, h: railing.h, name: 'RC欄杆（CAD）', color: 0xeeebe5 });
      if (!b.rot) slabEdges.push(b);
      nRails++;
    }
    // columns drawn as plain squares on a colour- or pen-named layer
    if (!parapet && colLs.length) for (const p of d.polys) {
      if (!colLs.includes(p.layer)) continue;
      const c = squareCol(p.pts, S);
      if (!c || !inBox(plan.box, c.x, c.y)) continue;
      const x = X(c.x), z = Z(c.y);
      if (walls.some(w => w.name === '柱' && Math.abs(w.x - x) < 5 && Math.abs(w.z - z) < 5)) continue;
      add({ layer: 'wall', name: '柱', x, z, w: Math.round(c.w), d: Math.round(c.h), y: 0, h: H, color: 0xeeebe5, src: p.layer });
    }
    nWalls += walls.length;
    // stairs: steps, half landings and the inner handrail; the storey above gets a hole in its slab
    const stairSegs = g.segs.filter(s => STAIR_LAYER.test(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const stairs = parapet ? [] : stairPre.get(st.key) ?? stairsOf(stairSegs, notes, H);
    for (const sp of stairs) {
      const climb = 'climb' in sp ? (sp as { climb: number }).climb : H, si = a.storeys.indexOf(st);
      // the storey it arrives at; storeys it passes (a mezzanine) are open over it too
      let to = si + 1;
      while (to < a.storeys.length - 1 && a.storeys[to].base - st.base < climb - 5) { (passHoles.get(a.storeys[to].key) || passHoles.set(a.storeys[to].key, []).get(a.storeys[to].key)!).push(...sp.holes); to++; }
      if (to > si + 1 && a.storeys[to]) (passHoles.get(a.storeys[to].key) || passHoles.set(a.storeys[to].key, []).get(a.storeys[to].key)!).push(...sp.holes);
      stairList.push({ from: st.key, to: a.storeys[to]?.key || '', risers: sp.labelled || sp.risers });
      const r = climb / sp.risers;
      // quantities follow the riser count written on the plan (上16); the drawing may leave treads out
      const N = sp.labelled || sp.risers, flights = sp.landings.length ? 2 : 1;
      const info = { risers: N, flights, width: sp.width, run: sp.run, rise: climb / N, landing: sp.landings.reduce((s, t) => s + (t.x1 - t.x0) * (t.z1 - t.z0) / 1e4, 0) };
      sp.steps.forEach((t, i) => add({ layer: 'stair', name: '樓梯踏階（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: t.x1 - t.x0, d: t.z1 - t.z0, h: Math.min(t.top, r + SLAB), y: t.top - Math.min(t.top, r + SLAB), color: 0xd9d4ca, rise: r, ...(t.soffit ? { soffit: { ...t.soffit, lo: t.soffit.lo + st.base, hi: t.soffit.hi + st.base } } : {}), ...(i ? {} : { stair: info }) }));
      for (const t of sp.landings) add({ layer: 'stair', name: '樓梯平台（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: t.x1 - t.x0, d: t.z1 - t.z0, h: SLAB, y: t.top - SLAB, color: 0xd9d4ca });
      // a handrail along a wall is left to the wall (a straight flight gets one on each open side)
      const byWall = (x: number, z: number) => walls.some(b => Math.abs(x - b.x) <= b.w / 2 + 12 && Math.abs(z - b.z) <= b.d / 2 + 12 && (!b.rot || Math.abs(Math.sin(b.rot * 2)) < 0.01));
      for (const t of sp.rails) if (!byWall((t.x0 + t.x1) / 2, (t.z0 + t.z1) / 2)) add({ layer: 'rail', name: '樓梯扶手（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: Math.max(4, t.x1 - t.x0), d: Math.max(4, t.z1 - t.z0), h: 90, y: t.top, color: 0x4b5563, rise: r });
    }
    if (!parapet) {
      // grid bubbles by label, for the beams read off the sections (bubbles may sit a little outside the view)
      const [bx0, by0, bx1, by1] = plan.box, mx = (bx1 - bx0) * 0.3, my = (by1 - by0) * 0.3, gb: SheetView['box'] = [bx0 - mx, by0 - my, bx1 + mx, by1 + my];
      const grids = new Map<string, { axis: 'x' | 'z'; at: Map<string, number> }>();
      // per kind the longest run of bubbles (stair tread numbers or a table's row numbers can also line up)
      for (const dir of ['row', 'col'] as const) for (const gr of gridLines(d, gb, dir, a.scale)) {
        const cur = grids.get(gr.kind);
        if (cur && cur.at.size >= gr.at.size) continue;
        grids.set(gr.kind, { axis: dir === 'row' ? 'x' : 'z', at: new Map([...gr.at].map(([l, v]) => [l, dir === 'row' ? X(v) : Z(v)])) });
      }
      beamLines.push({ st, xs: g.gx.map(X), zs: g.gy.map(Z), grids });
    }
    const holes = [...below, ...(passHoles.get(st.key) || [])];
    holesOf.set(st.key, holes);
    slabsOf.set(st.key, []);
    // indoor room names (客廳, 廚房, 臥室 …): short labels of two to five characters naming a space
    roomsOf.set(st.key, d.texts.filter(t => inBox(plan.box, t.x, t.y) && /^[一-鿿]{2,5}$/.test(t.s.trim()) && /[廳房室廚廁浴衛鋪舖間廊道梯]/.test(t.s) && !OUTDOOR.test(t.s) && !/平面圖|立面|剖面|投影|上方/.test(t.s)).map(t => ({ x: X(t.x), z: Z(t.y) })));
    outdoorOf.set(st.key, d.texts.filter(t => inBox(plan.box, t.x, t.y) && t.s.trim().length <= 8 && OUTDOOR.test(t.s) && !PLAN_NOTES.projection.test(t.s)).map(t => ({ x: X(t.x), z: Z(t.y) })));
    terraces.set(st.key, texts.filter(t => /露台|平台/.test(t.s) && !/屋突屋頂平台|上方/.test(t.s) || /屋突屋頂平台/.test(t.s)));
    // (a short run of steps leaves the floor above whole)
    below = stairs.filter(sp => !('climb' in sp) || Math.abs((sp as { climb: number }).climb - H) <= 5).flatMap(sp => sp.holes);
    {
      const crosses = crossRects(g.segs.filter(q => !/GRID|AXIS|DIM|軸|尺寸|FURN|傢俱|家具/i.test(q.layer)).map(q => ({ x1: X(q.a[0]), z1: Z(q.a[1]), x2: X(q.b[0]), z2: Z(q.b[1]), dashed: q.dashed })))
        .filter(r => r.x1 > -50 && r.z1 > -50 && r.x0 < W + 50 && r.z0 < D + 50);
      // nothing is open above the roof: an X on the roof plan marks what lies under it (a stair hall, a lift shaft)
      voidsOf.set(st.key, st.key === 'RF' ? [] : crosses.filter(r => !r.dashed));
      voidsUp.set(st.key, st.key === 'RF' ? [] : crosses.filter(r => r.dashed));
      // a 露台 is open to the sky: the storey above has no floor over it
      openAt.set(st.key, texts.filter(t => /露台/.test(t.s) && !/上方|投影|範圍|面積|計算/.test(t.s)));
      const lineSegs = g.segs.filter(q => !/GRID|AXIS|DIM|軸|尺寸|FURN|傢俱|家具|TEXT|HAT|落水|toilet|編號|Defpoints|BEAM|梁|STA|樓梯|AREA|面積|高程|標高/i.test(q.layer))
        .map(q => ({ x1: X(q.a[0]), z1: Z(q.a[1]), x2: X(q.b[0]), z2: Z(q.b[1]) }));
      drawnOf.set(st.key, lineSegs);
      // the floor-area outlines of the area review (樓地板面積範圍 on layer area, 陽台面積範圍 on area-陽台): floor there
      for (const p of d.polys) {
        const kind = /(^|\$)area$/i.test(p.layer) ? 'floor' : /(^|\$)area-陽台$/i.test(p.layer) ? 'balcony' : '';
        if (!kind || p.pts.length < 4 || !p.pts.every(q => inBox(plan.box, q[0], q[1]))) continue;
        const pts = p.pts.map(q => [X(q[0]), Z(q[1])]);
        if (!pts.every((q, i) => { const r = pts[(i + 1) % pts.length]; return Math.abs(q[0] - r[0]) < 1 || Math.abs(q[1] - r[1]) < 1; })) continue;
        const rs = polyRects(pts);
        if (rs.reduce((n, r) => n + (r.x1 - r.x0) * (r.z1 - r.z0), 0) < 40000) continue;
        (areaOf.get(st.key) || areaOf.set(st.key, []).get(st.key)!).push({ kind, rects: rs });
      }
      // green lines (colour 3) round a balcony or terrace are its 120 cm RC railing
      greenOf.set(st.key, g.segs.filter(q => q.color === 3 && !/TEXT|DIM|HAT|FURN|AREA|面積|尺寸|GRID|AXIS|軸|Defpoints/i.test(q.layer))
        .map(q => ({ x1: X(q.a[0]), z1: Z(q.a[1]), x2: X(q.b[0]), z2: Z(q.b[1]) }))
        .filter(q => (Math.abs(q.x1 - q.x2) < 1 || Math.abs(q.z1 - q.z2) < 1) && Math.hypot(q.x2 - q.x1, q.z2 - q.z1) >= 40));
      // the edge height written beside a label: H=1.2M, H=金屬格柵85cm
      const heightNear = (x: number, z: number, what?: RegExp) => {
        let best: number | undefined, bd = 150;
        for (const n of notes) {
          const dd = Math.hypot(n.x - x, n.z - z);
          const m = /H\s*=\s*[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(M|m|cm|CM|㎝)?/.exec(n.s);
          if (!m || dd > bd || (what && !what.test(n.s))) continue;
          const v = +m[1] * (/^m$/i.test(m[2] || '') || (!m[2] && +m[1] < 5) ? 100 : 1);
          if (v >= 30 && v <= 300) { best = v; bd = dd; }
        }
        return best;
      };
      outSpaces.set(st.key, texts.filter(t => /陽台|露台|AC專用板|冷氣|空調|室外機|裝飾板/.test(t.s) && t.s.trim().length <= 8 && !/上方|投影|範圍|面積|計算|頂板|檢討|管線/.test(t.s)).flatMap(t => {
        const rects = spaceFromLines(lineSegs, t.x, t.z);
        // an air-conditioner ledge (AC專用板, 冷氣平台) is a slab with a grille on its open sides; a 裝飾板 strip has the decorative RC panel on its edge
        const kind = /露台/.test(t.s) ? 'terrace' as const : /陽台/.test(t.s) ? 'balcony' as const : /裝飾板/.test(t.s) ? 'panel' as const : 'ac' as const;
        return rects ? [{ kind, rects, h: kind === 'ac' ? heightNear(t.x, t.z, /格柵|欄杆|百葉/) : kind === 'panel' ? heightNear(t.x, t.z) : undefined }] : [];
      }));
    }
    // (the roof only within the decks outlined on the roof plan: the flood also fills between a parapet and the sheet's edge)
    const onRoof = parapet && drawnOf.get(st.key)?.length ? closedOn(drawnOf.get(st.key), walls) : () => true;
    for (const r of slabRects(walls.length ? [...walls, ...shut, ...slabEdges] : walls, texts, W, D, holes)) {
      if (!onRoof(r)) continue;
      add({ layer: 'slab', name: st.key === '1F' ? '地坪（CAD）' : st.key === 'RF' ? '屋頂板（CAD）' : '樓板（CAD）', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: -SLAB, color: 0xd6d1c7 });
      slabsOf.get(st.key)!.push(r);
    }
    for (const op of openings) {
      const it = op.tag ? codes.get(op.tag)! : null;
      // narrower than its schedule size with a column or wall just beyond one end: the opening runs up to that face
      // (frame lines stopping short of a column leave a gap the window fills on site)
      if (it && !it.legs && it.w > op.len + 5) {
        const lack = it.w - op.len + 10, at = op.axis === 'x' ? op.cz : op.cx;
        const lo = (o: BoxObject) => op.axis === 'x' ? o.x - o.w / 2 : o.z - o.d / 2, hi = (o: BoxObject) => op.axis === 'x' ? o.x + o.w / 2 : o.z + o.d / 2;
        // a sliver of wall closing the end (the frame's side drawn as a wall pair) is part of the opening
        for (const end of ['a', 'b'] as const) {
          const stub = walls.find(o => !o.rot && /隔間|RC牆|外牆/.test(o.name) && Math.abs((op.axis === 'x' ? o.z : o.x) - at) <= (op.axis === 'x' ? o.d : o.w) / 2 + op.t / 2
            && (end === 'b' ? Math.abs(lo(o) - op.b) <= 2 : Math.abs(hi(o) - op.a) <= 2) && hi(o) - lo(o) <= Math.min(lack, 40) && op.len + hi(o) - lo(o) <= it.w + 10);
          if (!stub) continue;
          if (end === 'b') op.b = hi(stub); else op.a = lo(stub);
          op.len = op.b - op.a;
          walls.splice(walls.indexOf(stub), 1);
          const k = objects.findIndex(o => isBox(o) && o.floor === st.key && o.layer === 'wall' && Math.abs(o.x - stub.x) < 0.5 && Math.abs(o.z - stub.z) < 0.5 && Math.abs(o.w - stub.w) < 0.5 && Math.abs(o.d - stub.d) < 0.5);
          if (k >= 0) { objects.splice(k, 1); nWalls--; }
        }
        const solid = [...walls, ...objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && o.layer === 'wall' && /柱/.test(o.name))]
          .filter(o => !o.rot && Math.abs((op.axis === 'x' ? o.z : o.x) - at) <= (op.axis === 'x' ? o.d : o.w) / 2 + op.t / 2);
        // never into the wall or column beside it
        for (const o of solid) { if (lo(o) < op.a && hi(o) > op.a && hi(o) < op.b) op.a = hi(o); if (lo(o) < op.b && hi(o) > op.b && lo(o) > op.a) op.b = lo(o); }
        op.len = op.b - op.a;
        // an end already against a part (a column the frame runs into) stays where it is
        const shutB = solid.some(o => lo(o) <= op.b + 1 && hi(o) > op.b + 1), shutA = solid.some(o => hi(o) >= op.a - 1 && lo(o) < op.a - 1);
        const right = shutB ? undefined : solid.map(lo).filter(v => v >= op.b - 1 && v - op.b <= lack).sort((p, q) => p - q)[0];
        const left = shutA ? undefined : solid.map(hi).filter(v => v <= op.a + 1 && op.a - v <= lack).sort((p, q) => q - p)[0];
        if (right !== undefined && right - op.b > 1) op.b = right;
        if (left !== undefined && op.a - left > 1 && op.b - left <= it.w + 10) op.a = left;
        op.len = op.b - op.a;
        if (op.axis === 'x') op.cx = (op.a + op.b) / 2; else op.cz = (op.a + op.b) / 2;
      }
      const door = it ? it.kind === 'door' : op.arc;
      const sill = it ? optNow.sills?.[it.code] ?? it.sill : door ? 0 : 90;
      const oh = Math.min(H - sill, it ? it.h : door ? 210 : 150);
      const label = it ? `${it.code} ${it.name} ${it.w}×${it.h}` : door ? `門 ${Math.round(op.len)}×210` : `窗 ${Math.round(op.len)}×150`;
      const along = op.axis === 'x';
      const box = (y: number, h: number, nm: string, layer: BoxObject['layer'], color: number, t = op.t) =>
        add({ layer, name: nm, x: op.cx, z: op.cz, w: along ? op.len : t, d: along ? t : op.len, h, y, color });
      const outer = op.t >= 18;
      if (sill > 0) box(0, sill, outer ? '窗台（CAD）' : '隔間牆下（CAD）', 'wall', 0xeeebe5);
      if (H - sill - oh > 0) box(sill + oh, H - sill - oh, outer ? (door ? '門楣（CAD）' : '窗楣（CAD）') : '隔間門楣（CAD）', 'wall', 0xeeebe5);
      if (door) {
        const dObj: DoorObject = { id: id++, layer: 'door', name: label, axis: op.axis, at: along ? op.cz : op.cx, a: op.a, b: op.b, flip: 0, color: 0x9a6a43, floor: st.key, y: st.base, h: oh };
        objects.push(dObj);
        nDoors++;
      } else {
        box(sill, oh, label, 'glass', 0xa9dcff, Math.min(op.t, 6));
        nWins++;
      }
    }
    const segs: number[] = [], segLayer: number[] = [], planLines: PlanLine[] = [];
    const near = (x: number, z: number) => x > -100 && z > -100 && x < W + 100 && z < D + 100;
    for (const s of g.segs) {
      if (isWallLayer(s.layer) || /GRID|GTAG|AXIS|軸|DIM|標註|Defpoints|AREA|TEXT|圖框|範圍|地界|道路|PARK/i.test(s.layer)) continue;
      const x1 = X(s.a[0]), z1 = Z(s.a[1]), x2 = X(s.b[0]), z2 = Z(s.b[1]);
      if (near(x1, z1) && near(x2, z2)) { segs.push(x1, z1, x2, z2); segLayer.push(layerNo(s.layer)); planLines.push({ x1, z1, x2, z2, win: /WIN|窗/i.test(s.layer) && !/編號|TAG|TEXT/i.test(s.layer), layer: s.layer }); }
    }
    linesOf.set(st.key, planLines);
    // shown on the plan view: room names inside the building, not the legal-review notes and legends round it
    const wx0 = minOf(walls.map(o => o.x - o.w / 2)) - 50, wx1 = maxOf(walls.map(o => o.x + o.w / 2)) + 50, wz0 = minOf(walls.map(o => o.z - o.d / 2)) - 50, wz1 = maxOf(walls.map(o => o.z + o.d / 2)) + 50;
    const shown = texts.filter(t => (!walls.length || (t.x >= wx0 && t.x <= wx1 && t.z >= wz0 && t.z <= wz1))
      && !/檢討|規定|面積|計算|圖例|範圍|線|[≦≧<>]|透空|投影|裝飾|增築|項\s*目|小\s*計|平面圖|面\s*積|防火|時效|事務所|建築師|紅磚|[0-9]\/[0-9]B|責任|施工|專用|材料|構造|做法|詳圖|^[A-Z]{1,3}[0-9]*$|^[東西南北]$/.test(t.s));
    floors.push({ key: st.key, title: plan.title, y: st.base, h: H, segs, segLayer, texts: shown });
  }
  // beams from structural plans (二層結構平面圖 → under the 2F slab), lined up on the grid bubbles
  const drawn = new Set<string>();
  const table = readSizeTable(d);
  const madeBy = new Map<ModelObject, SheetView>();
  const rcPanels: SlabPanel[] = [];
  const structViews = a.views.filter(v => v.kind === 'structure' && v.floors.length);
  const prepped = new Map<SheetView, { lines: ReturnType<typeof readBeams>['lines']; beams: ReturnType<typeof readBeams>['lines']; cols: ReturnType<typeof readColumns>; panels: ReturnType<typeof readPanels>; marks: ReturnType<typeof readBeams>['marks']; S: number }>();
  for (const v of structViews) {
    const gs = planGeo(d, v);
    if (!isFinite(gs.ox) || !isFinite(gs.oy)) continue;
    let X = (x: number) => (x - gs.ox - minX) * S, Z = (y: number) => (maxY - (y - gs.oy)) * S;
    // sheets without grid bubbles line up by their wall outline, which can differ a little from the architectural plan:
    // slide the sheet so its columns land on the architectural ones
    if (!gs.gx.length || !gs.gy.length) {
      const sc = readColumns(d, v, X, Z, S), ac = objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'wall' && o.name === '柱' && o.floor === v.floors[0]);
      let best = { n: 0, dx: 0, dz: 0 };
      for (const p of sc) for (const q of ac) {
        const dx = q.x - p.x, dz = q.z - p.z;
        const n = sc.filter(c => ac.some(o => Math.abs(o.x - (c.x + dx)) < 15 && Math.abs(o.z - (c.z + dz)) < 15)).length;
        if (n > best.n) best = { n, dx, dz };
      }
      if (best.n >= 4) { const X0 = X, Z0 = Z; X = x => X0(x) + best.dx; Z = y => Z0(y) + best.dz; }
    }
    const { lines, marks } = readBeams(d, v, X, Z, S, table), beams = lines.filter(b => b.mark);
    const cols = readColumns(d, v, X, Z, S), panels = readPanels(d, v, X, Z, lines.filter(l => !l.single), W, D);
    prepped.set(v, { lines, beams, cols, panels, marks, S });
  }
  // a floor can have more than one structural sheet (an older revision, another building): the one whose beams run along the architectural walls is used
  const fit = (v: SheetView, key: string) => {
    const i = a.storeys.findIndex(s => s.key === key), host = i > 0 ? a.storeys[i - 1].key : key;
    const ws = objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'wall' && !o.rc && (o.floor === host || o.floor === key) && Math.max(o.w, o.d) > 60);
    let n = 0;
    for (const b of prepped.get(v)!.beams) {
      const mx = (b.ax + b.bx) / 2, mz = (b.az + b.bz) / 2;
      if (ws.some(o => { const r = o.rot || 0, along = o.w >= o.d, h = Math.max(o.w, o.d) / 2, ux = Math.cos(r) * (along ? 1 : 0) + Math.sin(r) * (along ? 0 : 1), uz = -Math.sin(r) * (along ? 1 : 0) + Math.cos(r) * (along ? 0 : 1);
        const t = Math.max(-h, Math.min(h, (mx - o.x) * ux + (mz - o.z) * uz)); return Math.hypot(mx - (o.x + ux * t), mz - (o.z + uz * t)) < Math.min(o.w, o.d) / 2 + 45; })) n++;
    }
    return n;
  };
  const issues: Issue[] = [];
  const chosen = new Map<string, { v: SheetView; n: number }>();
  for (const v of structViews) if (prepped.has(v)) for (const key of v.floors) {
    const n = fit(v, key), c = chosen.get(key);
    if (!c || n > c.n) chosen.set(key, { v, n });
  }
  for (const v of structViews) {
    const pv = prepped.get(v);
    if (!pv) continue;
    const { beams, cols, panels, marks, S } = pv;
    for (const key of v.floors) {
      if (chosen.get(key)?.v !== v) continue;
      const i = a.storeys.findIndex(s => s.key === key);
      if (i < 0) continue;
      // the beams carry this floor: they hang under its slab, in the storey below (foundation beams under 1F)
      const host = i > 0 ? a.storeys[i - 1] : a.storeys[0], top = a.storeys[i].base;
      if (i > 0 && beams.length) drawn.add(host.key);
      for (const b of beams) {
        const m = b.mark!, ground = i === 0, along = Math.abs(b.bx - b.ax) >= Math.abs(b.bz - b.az);
        const bx = (b.ax + b.bx) / 2, bz = (b.az + b.bz) / 2;
        // a beam drawn off the grid (e.g. along a slanted site line) is turned to follow it
        const ang = Math.atan2(b.bz - b.az, b.bx - b.ax), off = Math.abs(((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - 0), slant = Math.min(off, Math.PI / 2 - off) > 0.03 && b.len > 100;
        if (objects.some(o => isBox(o) && madeBy.get(o) !== v && o.rc?.kind === 'beam' && o.floor === host.key && Math.abs(o.x - bx) < 8 && Math.abs(o.z - bz) < 8 && Math.abs(Math.max(o.w, o.d) - b.len) < 15 && Math.abs(o.y + o.h - top) < 5)) continue;
        // an edge beam drawn narrower than its marked size keeps its outer face on the slab edge (the extra width goes inward)
        const spare = Math.max(0, (m.w - b.t) / 2) + 1, cx = (b.ax + b.bx) / 2, cz = (b.az + b.bz) / 2;
        const sx = slant || along ? 0 : cx + m.w / 2 > W && cx + m.w / 2 - W <= spare ? W - m.w / 2 - cx : cx - m.w / 2 < 0 && -(cx - m.w / 2) <= spare ? m.w / 2 - cx : 0;
        const sz = slant || !along ? 0 : cz + m.w / 2 > D && cz + m.w / 2 - D <= spare ? D - m.w / 2 - cz : cz - m.w / 2 < 0 && -(cz - m.w / 2) <= spare ? m.w / 2 - cz : 0;
        objects.push({ id: id++, layer: 'slab', name: `${ground ? '地梁' : '梁'} ${m.code}（結構圖）`, floor: host.key, y: top - m.h, h: m.h, color: 0xcfc9bd,
          x: cx + sx, z: cz + sz, ...(slant ? { w: b.len, d: m.w, rot: -ang } : along ? { w: b.len, d: m.w } : { w: m.w, d: b.len }), rc: { kind: 'beam', mark: m.code, fl: key } });
        madeBy.set(objects[objects.length - 1], v);
        if (b.single) issues.push({ kind: 'MARK-BEAM', sev: 'fixed', floor: host.key, ids: [id - 1], text: `${v.title}：梁 ${m.code} 只畫了一條梁線，依編號的尺寸 ${m.w}×${m.h} 沿這條線建出（${Math.round(b.len)} cm）` });
      }
      // every beam mark on the plan should now have a beam beside it; every column mark a column
      const unbuilt = new Map<string, typeof marks>();
      for (const m of marks) {
        const near = objects.some(o => isBox(o) && o.rc?.kind === 'beam' && o.rc.mark === m.code && o.rc.fl === key
          && Math.abs(m.x - o.x) <= Math.max(o.w, o.d) / 2 + 70 * S + 60 && Math.abs(m.z - o.z) <= Math.max(o.w, o.d) / 2 + 70 * S + 60);
        if (near) continue;
        const k = `${m.code}|${m.w}×${m.h}`;
        if (!unbuilt.has(k)) unbuilt.set(k, []);
        if (!unbuilt.get(k)!.some(q => Math.hypot(q.x - m.x, q.z - m.z) < 50)) unbuilt.get(k)!.push(m);
      }
      for (const [k, ms] of unbuilt) {
        const [code, size] = k.split('|'), wallBeam = /^W/i.test(code);
        issues.push({ kind: 'MARK-BEAM', sev: wallBeam ? 'info' : 'warn', floor: host.key, at: [ms[0].x, ms[0].z],
          text: `${v.title}：梁 ${code}（${size}）${ms.length > 1 ? `有 ${ms.length} 處` : ''}標示的位置沒有建出梁${wallBeam ? '；W 開頭是牆梁，藏在牆裡，牆已經建出的話可以不理' : '，圖上找不到這根梁的兩條梁線（可用「補牆板」或畫線補上）'}` });
      }
      for (const m of cols.missing) issues.push({ kind: 'MARK-COL', sev: 'warn', floor: key, at: [m.x, m.z], text: `${v.title}：柱編號 ${m.mark} 旁邊沒有柱的外框（柱框可能畫在別的圖層）` });
      // columns of this storey: the architectural column there takes the mark and the structural size, else one is added
      const st = a.storeys[i];
      for (const c of cols) {
        // the same plan is often drawn twice on one sheet (title block copy)
        if (objects.some(o => isBox(o) && madeBy.get(o) !== v && o.rc?.kind === 'column' && o.floor === key && Math.abs(o.x - c.x) < 8 && Math.abs(o.z - c.z) < 8)) continue;
        const arch = objects.find(o => isBox(o) && o.floor === key && o.layer === 'wall' && !o.rc && !o.rot && o.h >= 200 && Math.min(o.w, o.d) >= 25
          && Math.abs(o.x - c.x) <= o.w / 2 + 5 && Math.abs(o.z - c.z) <= o.d / 2 + 5 && Math.max(o.w, o.d) <= Math.min(o.w, o.d) * 3) as BoxObject | undefined;
        const tag = { kind: 'column' as const, mark: c.mark, fl: key, b: Math.min(c.w, c.d), h: Math.max(c.w, c.d) };
        if (arch) { arch.rc = tag; arch.x = c.x; arch.z = c.z; arch.w = c.w; arch.d = c.d; madeBy.set(arch, v); }
        else objects.push({ id: id++, layer: 'wall', name: `柱 ${c.mark}（結構圖）`, floor: key, x: c.x, z: c.z, w: c.w, d: c.d, h: st.h, y: st.base, color: 0xeeebe5, rc: tag });
        if (!arch) madeBy.set(objects[objects.length - 1], v);
      }
      for (const p of panels) rcPanels.push({ ...p, fl: key });
    }
  }
  // a wall that runs into a column ends at the column face (plans often draw walls to the column's centre line); a
  // piece lying wholly inside a column goes. It is one piece of concrete, so the model shows no stub beside the column
  {
    const colsAll = objects.filter((o): o is BoxObject => isBox(o) && o.rc?.kind === 'column');
    for (let i = objects.length - 1; i >= 0; i--) {
      const w = objects[i];
      if (!isBox(w) || w.layer !== 'wall' || w.rc || w.rot || w.h < 100) continue;
      for (const c of colsAll) {
        if (c.floor !== w.floor || c.rot) continue;
        const cx0 = c.x - c.w / 2, cx1 = c.x + c.w / 2, cz0 = c.z - c.d / 2, cz1 = c.z + c.d / 2;
        let wx0 = w.x - w.w / 2, wx1 = w.x + w.w / 2, wz0 = w.z - w.d / 2, wz1 = w.z + w.d / 2;
        if (wx0 >= cx1 - 1 || wx1 <= cx0 + 1 || wz0 >= cz1 - 1 || wz1 <= cz0 + 1) continue;
        const along = w.w >= w.d;
        // across the wall the column must cover it, else the wall passes beside the column
        if (along ? !(cz0 <= wz0 + 3 && cz1 >= wz1 - 3) : !(cx0 <= wx0 + 3 && cx1 >= wx1 - 3)) continue;
        const a0 = along ? wx0 : wz0, a1 = along ? wx1 : wz1, c0 = along ? cx0 : cz0, c1 = along ? cx1 : cz1;
        if (a0 >= c0 - 1 && a1 <= c1 + 1) { objects.splice(i, 1); break; }
        if (a0 < c0 && a1 > c1) continue;
        if (a0 >= c0 - 1) { if (along) wx0 = c1; else wz0 = c1; } else { if (along) wx1 = c0; else wz1 = c0; }
        w.x = (wx0 + wx1) / 2; w.w = wx1 - wx0; w.z = (wz0 + wz1) / 2; w.d = wz1 - wz0;
        if (Math.max(w.w, w.d) < 5) { objects.splice(i, 1); break; }
      }
    }
  }
  // beams are rarely on architectural plans: estimate one along every grid line, under the slab of the storey above
  // beams read off the sections (no structural plans): each on its grid line, its own size, where the slab above covers
  // the line; the foundation beams under the ground floor slab, on a blinding of lean concrete
  const secLines = new Map<string, { axis: 'x' | 'z'; at: number }[]>();
  let footDeep = 0;
  for (const { st, grids } of beamLines) {
    if (drawn.has(st.key)) continue;
    const i = a.storeys.indexOf(st), next = a.storeys[i + 1];
    for (const sb of a.beams || []) {
      const foot = sb.foot && i === 0;
      if (!foot && (sb.foot || !next || sb.level !== next.key)) continue;
      const gr = grids.get(sb.kind), pa = gr?.at.get(sb.a), pb = gr?.at.get(sb.b);
      if (!gr || pa === undefined || pb === undefined) continue;
      const at = pa + sb.t * (pb - pa), along = gr.axis === 'x' ? 'z' : 'x';
      const over = slabsOf.get(foot ? st.key : next!.key) || [];
      // (the slab beside the line: on a wall line the slab stops at the wall faces)
      const reach = sb.w / 2 + 30;
      const runs = over.filter(r => along === 'z' ? at >= r.x0 - reach && at <= r.x1 + reach : at >= r.z0 - reach && at <= r.z1 + reach)
        .map(r => along === 'z' ? [r.z0, r.z1] : [r.x0, r.x1]).sort((p, q) => p[0] - q[0]);
      const merged: number[][] = [];
      for (const r of runs) { const m = merged[merged.length - 1]; if (m && r[0] <= m[1] + 1) m[1] = Math.max(m[1], r[1]); else merged.push([...r]); }
      // no slab beside the line (a beam under a terrace edge, over an open front): the beam spans the walls and
      // columns standing on the line on this storey
      if (!merged.some(([lo, hi]) => hi - lo >= 100)) {
        const on = objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && o.layer === 'wall' && !o.rot && o.h >= st.h * 0.8
          && (along === 'z' ? Math.abs(o.x - at) <= o.w / 2 + reach : Math.abs(o.z - at) <= o.d / 2 + reach));
        const ext = on.map(o => along === 'z' ? [o.z - o.d / 2, o.z + o.d / 2] : [o.x - o.w / 2, o.x + o.w / 2]);
        if (on.length >= 2 || ext.some(([lo, hi]) => hi - lo >= 100)) merged.splice(0, merged.length, [minOf(ext.map(e => e[0])), maxOf(ext.map(e => e[1]))]);
      }
      const top = foot ? st.base : next!.base;
      for (const [lo, hi] of merged) {
        if (hi - lo < 100) continue;
        const c = along === 'z' ? Math.min(W - sb.w / 2, Math.max(sb.w / 2, at)) : Math.min(D - sb.w / 2, Math.max(sb.w / 2, at));
        objects.push({ id: id++, layer: 'slab', name: `${foot ? '地梁' : '梁'} ${sb.mark} ${sb.w}×${sb.h}（剖面圖）`, floor: st.key, y: top - sb.h, h: sb.h, color: 0xcfc9bd,
          ...(along === 'z' ? { x: c, z: (lo + hi) / 2, w: sb.w, d: hi - lo } : { x: (lo + hi) / 2, z: c, w: hi - lo, d: sb.w }), rc: { kind: 'beam', mark: sb.mark, fl: foot ? st.key : next!.key } });
        (secLines.get(st.key) || secLines.set(st.key, []).get(st.key)!).push({ axis: gr.axis, at });
        if (foot) footDeep = Math.max(footDeep, sb.h);
      }
    }
  }
  if (footDeep && a.blinding && a.storeys[0]) {
    const g0 = a.storeys[0];
    for (const r of slabsOf.get(g0.key) || [])
      objects.push({ id: id++, layer: 'slab', name: `基礎PC墊層 ${a.blinding}cm（剖面圖）`, floor: g0.key, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: a.blinding, y: g0.base - footDeep - a.blinding, color: 0xbdb8ae });
  }
  for (const { st, xs, zs } of beamLines) {
    if (drawn.has(st.key)) continue;
    const next = a.storeys[a.storeys.indexOf(st) + 1], above = next ? slabsOf.get(next.key) || [] : [];
    // grid lines a section gave a beam on keep that beam
    const done = secLines.get(st.key) || [];
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
    for (const x of xs) if (x > -5 && x < W + 5 && !done.some(l => l.axis === 'x' && Math.abs(l.at - x) < 30)) beam('z', x);
    for (const z of zs) if (z > -5 && z < D + 5 && !done.some(l => l.axis === 'z' && Math.abs(l.at - z) < 30)) beam('x', z);
  }
  // slab panels read from the structural plans fill the floor where no walls enclose it
  for (const p of rcPanels) {
    const st = a.storeys.find(q => q.key === p.fl);
    if (!st || st.key === '1F') continue;
    let rs = [{ x0: Math.max(0, p.x0), x1: Math.min(W, p.x1), z0: Math.max(0, p.z0), z1: Math.min(D, p.z1) }].filter(r => r.x1 - r.x0 > 20 && r.z1 - r.z0 > 20);
    for (const h of [...(slabsOf.get(st.key) || []), ...(holesOf.get(st.key) || [])]) rs = rs.flatMap(q => {
      if (h.x1 <= q.x0 + 1 || h.x0 >= q.x1 - 1 || h.z1 <= q.z0 + 1 || h.z0 >= q.z1 - 1) return [q];
      const o = [];
      if (h.x0 > q.x0) o.push({ ...q, x1: h.x0 });
      if (h.x1 < q.x1) o.push({ ...q, x0: h.x1 });
      const x0 = Math.max(q.x0, h.x0), x1 = Math.min(q.x1, h.x1);
      if (h.z0 > q.z0) o.push({ x0, x1, z0: q.z0, z1: h.z0 });
      if (h.z1 < q.z1) o.push({ x0, x1, z0: h.z1, z1: q.z1 });
      return o;
    });
    for (const r of rs) {
      if (r.x1 - r.x0 < 20 || r.z1 - r.z0 < 20) continue;
      objects.push({ id: id++, layer: 'slab', name: st.key === 'RF' ? '屋頂板（結構圖）' : '樓板（結構圖）', floor: st.key, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: st.base - SLAB, color: 0xd6d1c7 });
      slabsOf.get(st.key)!.push(r);
    }
  }
  // slab edges that follow a slanted line: cut the slab back to it in 30 cm strips
  for (const sl of slants) {
    const zlo = Math.min(sl.z1, sl.z2), zhi = Math.max(sl.z1, sl.z2);
    const lineX = (z: number) => sl.x1 + (sl.x2 - sl.x1) * (z - sl.z1) / (sl.z2 - sl.z1);
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (!isBox(o) || o.floor !== sl.key || o.layer !== 'slab' || !/樓板|屋頂板|地坪/.test(o.name) || o.rot) continue;
      const x0 = o.x - o.w / 2, x1 = o.x + o.w / 2, z0 = o.z - o.d / 2, z1 = o.z + o.d / 2;
      if (z1 < zlo || z0 > zhi) continue;
      const out = sl.side === 'w' ? x0 < Math.min(lineX(Math.max(z0, zlo)), lineX(Math.min(z1, zhi))) - 5 : x1 > Math.max(lineX(Math.max(z0, zlo)), lineX(Math.min(z1, zhi))) + 5;
      if (!out) continue;
      const pieces: { x0: number; x1: number; z0: number; z1: number }[] = [];
      for (let z = z0; z < z1 - 1; z += 30) {
        const zb = Math.min(z + 30, z1), zm = (z + zb) / 2;
        let a = x0, b = x1;
        if (zm >= zlo && zm <= zhi) { if (sl.side === 'w') a = Math.max(x0, lineX(zm)); else b = Math.min(x1, lineX(zm)); }
        if (b - a < 10) continue;
        const last = pieces[pieces.length - 1];
        if (last && Math.abs(last.x0 - a) < 2 && Math.abs(last.x1 - b) < 2) last.z1 = zb; else pieces.push({ x0: a, x1: b, z0: z, z1: zb });
      }
      objects.splice(i, 1, ...pieces.map(r => ({ ...o, id: id++, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 })));
    }
  }
  // and extended out to it where the slab stops short (up to 1.5 m): the slanted line is where the balcony slab ends
  for (const sl of slants) {
    const zlo = Math.min(sl.z1, sl.z2), zhi = Math.max(sl.z1, sl.z2);
    const lineX = (z: number) => sl.x1 + (sl.x2 - sl.x1) * (z - sl.z1) / (sl.z2 - sl.z1);
    const slabs = objects.filter((o): o is BoxObject => isBox(o) && o.floor === sl.key && o.layer === 'slab' && /樓板|屋頂板|地坪/.test(o.name) && !o.rot);
    if (!slabs.length) continue;
    const proto = slabs[0], add: { x0: number; x1: number; z0: number; z1: number }[] = [];
    for (let z = zlo; z < zhi - 1; z += 30) {
      const zb = Math.min(z + 30, zhi), zm = (z + zb) / 2, lx = lineX(zm);
      const under = slabs.filter(o => zm >= o.z - o.d / 2 && zm <= o.z + o.d / 2);
      const edge = sl.side === 'w' ? minOf(under.map(o => o.x - o.w / 2)) : maxOf(under.map(o => o.x + o.w / 2));
      if (!isFinite(edge)) continue;
      const gap = sl.side === 'w' ? edge - lx : lx - edge;
      if (gap < 5 || gap > 150) continue;
      const r = sl.side === 'w' ? { x0: lx, x1: edge, z0: z, z1: zb } : { x0: edge, x1: lx, z0: z, z1: zb };
      const last = add[add.length - 1];
      if (last && Math.abs(last.x0 - r.x0) < 3 && Math.abs(last.x1 - r.x1) < 3) last.z1 = zb; else add.push(r);
    }
    for (const r of add) objects.push({ ...proto, id: id++, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 });
  }
  // wall lines: the colour of the exterior wall decides. Walls drawn in it are concrete, walls in another colour are light partitions.
  const wallBoxes = objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'wall' && o.wc !== undefined && !o.rc && /^(外牆|隔間牆)（CAD）/.test(o.name) && !(Math.max(o.w, o.d) < 120 && Math.min(o.w, o.d) >= 25));
  let extColor: number | undefined;
  if (new Set(wallBoxes.map(o => o.wc)).size >= 2) {
    const lenOf = (o: BoxObject) => Math.max(o.w, o.d), votes = new Map<number, number>();
    const xs = wallBoxes.flatMap(o => [o.x - o.w / 2, o.x + o.w / 2]), zs = wallBoxes.flatMap(o => [o.z - o.d / 2, o.z + o.d / 2]);
    const x0 = minOf(xs), x1 = maxOf(xs), z0 = minOf(zs), z1 = maxOf(zs);
    const onRim = (o: BoxObject) => o.w >= o.d ? Math.min(Math.abs(o.z - z0), Math.abs(o.z - z1)) < 40 : Math.min(Math.abs(o.x - x0), Math.abs(o.x - x1)) < 40;
    for (const o of wallBoxes) if (onRim(o)) votes.set(o.wc!, (votes.get(o.wc!) || 0) + lenOf(o));
    extColor = opts.extColor === -1 ? undefined : opts.extColor ?? [...votes].sort((p, q) => q[1] - p[1])[0]?.[0];
    // a wall on the outline is an exterior wall whatever colour it is drawn in
    if (extColor !== undefined) for (const o of wallBoxes) {
      o.wall = o.wc === extColor || onRim(o) ? 'rc' : 'light';
      o.name = o.wall === 'light' ? '輕隔間牆（CAD）' : Math.min(o.w, o.d) >= 18 ? '外牆（CAD）' : 'RC牆（CAD）';
    }
  }
  // a layer known to hold only concrete walls or only partitions
  for (const o of wallBoxes) {
    const r = o.src && opts.layers?.[o.src];
    if (r !== 'rc' && r !== 'light') continue;
    o.wall = r;
    o.name = r === 'light' ? '輕隔間牆（CAD）' : Math.min(o.w, o.d) >= 18 ? '外牆（CAD）' : 'RC牆（CAD）';
  }
  // the wall over a door or window (and under a window) is the wall the opening is cut in: concrete over an opening
  // in an RC wall, a light partition over a door in a light partition
  const fills = objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'wall' && /^(窗台|窗楣|門楣|隔間門楣|隔間牆下)（CAD）$/.test(o.name));
  const hosts = objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'wall' && !o.rc && !o.rot && /^(外牆|隔間牆|RC牆|輕隔間牆)（CAD）/.test(o.name));
  for (const f of fills) {
    const along = f.w >= f.d, len = along ? f.w : f.d, t = along ? f.d : f.w;
    const h = hosts.find(o => o.floor === f.floor && (o.w >= o.d) === along && Math.abs(along ? o.z - f.z : o.x - f.x) <= Math.max(t, along ? o.d : o.w) / 2 + 3
      && Math.abs(along ? o.x - f.x : o.z - f.z) - (along ? o.w : o.d) / 2 - len / 2 <= 12);
    const light = h ? h.wall === 'light' || /輕隔間/.test(h.name) : t < 18;
    const rc = h ? !light && (h.wall === 'rc' || Math.min(h.w, h.d) >= 12) : !light;
    if (h) { f.wall = light ? 'light' : rc ? 'rc' : h.wall; if (h.wc !== undefined) f.wc = h.wc; }
    else f.wall = light ? 'light' : 'rc';
    const top = !/窗台|牆下/.test(f.name);
    // over an opening in an interior RC wall: no facade finish (takeoff reads the RC牆 prefix)
    const inner = !light && !!h && /^RC牆/.test(h.name) ? 'RC牆' : '';
    f.name = light ? (top ? '輕隔間門楣（CAD）' : '輕隔間牆下（CAD）') : inner + (top ? (/門楣/.test(f.name) ? '門楣（CAD）' : '窗楣（CAD）') : '窗台（CAD）');
  }
  // the roof plan sits on the top indoor storey: the roof slab covers that storey (a roof plan that shows only the
  // parapet leaves holes, so its slabs are used), and what the roof outline reaches beyond it is the eaves (屋簷)
  const top = a.storeys[a.storeys.length - 1], under = a.storeys[a.storeys.length - 2];
  if (top && under && top.key === 'RF' && !under.key.startsWith('R')) {
    const roof = slabsOf.get('RF') || [], below0 = slabsOf.get(under.key) || [];
    const { indoor: below, eaves } = roofSplit(roof, below0, [
      ...objects.filter((o): o is BoxObject => isBox(o) && o.floor === under.key && (o.layer === 'glass' || (o.layer === 'wall' && o.h >= under.h * 0.8))),
      // doorways close the rooms off too
      ...objects.filter((o): o is DoorObject => !isBox(o) && o.floor === under.key).map(o => ({ ...o, layer: 'wall' as const, x: o.axis === 'x' ? (o.a + o.b) / 2 : o.at, z: o.axis === 'x' ? o.at : (o.a + o.b) / 2, w: o.axis === 'x' ? Math.abs(o.b - o.a) : 20, d: o.axis === 'x' ? 20 : Math.abs(o.b - o.a), h: 1, y: 0, color: 0 }) as BoxObject),
    ], outdoorOf.get(under.key) || [], roomsOf.get(under.key) || [], W, D);
    if (below.length) {
      for (let i = objects.length - 1; i >= 0; i--) { const o = objects[i]; if (isBox(o) && o.floor === 'RF' && o.layer === 'slab') objects.splice(i, 1); }
      slabsOf.set('RF', []);
      // the stair up to the roof leaves its opening
      const cut = (r: { x0: number; x1: number; z0: number; z1: number }) => (holesOf.get('RF') || []).reduce((rs, h) => rs.flatMap(q => {
        if (h.x1 <= q.x0 || h.x0 >= q.x1 || h.z1 <= q.z0 || h.z0 >= q.z1) return [q];
        const out = [];
        if (h.x0 > q.x0) out.push({ ...q, x1: h.x0 });
        if (h.x1 < q.x1) out.push({ ...q, x0: h.x1 });
        const a = Math.max(q.x0, h.x0), b = Math.min(q.x1, h.x1);
        if (h.z0 > q.z0) out.push({ x0: a, x1: b, z0: q.z0, z1: h.z0 });
        if (h.z1 < q.z1) out.push({ x0: a, x1: b, z0: h.z1, z1: q.z1 });
        return out;
      }), [r]);
      for (const r of below.flatMap(cut)) {
        objects.push({ id: id++, layer: 'slab', name: '屋頂板（CAD）', floor: 'RF', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: top.base - SLAB, color: 0xd6d1c7 });
        slabsOf.get('RF')!.push(r);
      }
      for (const r of eaves) {
        objects.push({ id: id++, layer: 'slab', name: '屋簷（CAD）', floor: 'RF', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: top.base - SLAB, color: 0xd6d1c7 });
        slabsOf.get('RF')!.push(r);
      }
    }
  }
  // a storey's floor slab is the ceiling of the storey under it: where the walls on this level do not close off all
  // of the indoor floor below (a roof terrace, a shop front, walls lost in the drawing), carry the slab up from there.
  // A mezzanine covers only part of the storey under it, and a roof storey's terrace is not roofed over.
  for (let i = 1; i < a.storeys.length; i++) {
    const st = a.storeys[i];
    if (/MF$/.test(st.key)) continue;
    let j = i - 1;
    while (j > 0 && /MF$/.test(a.storeys[j].key)) j--;
    const lower = a.storeys[j];
    // over a roof storey (its terrace inside the parapet looks indoor) only a roof with no slab of its own is filled
    // (a stray patch off the building, a north arrow or a site item, is not a roof of its own)
    const below = slabsOf.get(lower.key) || [];
    let from = below;
    if (/^R\d+F$/.test(lower.key)) {
      // a rooftop structure stands on the roof below it: its floor is that roof, within the walls it stands in;
      // the roof over a rooftop structure covers it within its own walls, over its stair and voids too
      // (a roof plan with no walls of its own: the walls of the rooftop structure under it)
      const own = (k: string) => objects.filter((o): o is BoxObject => isBox(o) && o.floor === k && o.layer === 'wall' && !o.rot);
      const roofOver = st.key === 'RF' && !own(st.key).some(o => Math.max(o.w, o.d) >= 150);
      const ws = roofOver ? own(lower.key).filter(o => o.h >= lower.h * 0.8) : own(st.key);
      const groups: { x0: number; x1: number; z0: number; z1: number; len: number }[] = [];
      for (const w of ws) {
        const b = { x0: w.x - w.w / 2, x1: w.x + w.w / 2, z0: w.z - w.d / 2, z1: w.z + w.d / 2, len: Math.max(w.w, w.d) };
        const hit = groups.filter(g => b.x0 < g.x1 + 150 && g.x0 < b.x1 + 150 && b.z0 < g.z1 + 150 && g.z0 < b.z1 + 150);
        const m = hit.reduce((g, h) => ({ x0: Math.min(g.x0, h.x0), x1: Math.max(g.x1, h.x1), z0: Math.min(g.z0, h.z0), z1: Math.max(g.z1, h.z1), len: g.len + h.len }), b);
        for (const h of hit) groups.splice(groups.indexOf(h), 1);
        groups.push(m);
      }
      const foot = groups.filter(g => g.len >= 600);
      if (!foot.length) continue;
      from = (roofOver ? [...below, ...holesOf.get(lower.key) || [], ...voidsOf.get(lower.key) || []] : below).flatMap(r => foot.flatMap(g => {
        const c = { x0: Math.max(r.x0, g.x0), x1: Math.min(r.x1, g.x1), z0: Math.max(r.z0, g.z0), z1: Math.min(r.z1, g.z1) };
        return c.x1 - c.x0 > 5 && c.z1 - c.z0 > 5 ? [c] : [];
      }));
      // not over the roof deck of the storey below (a cluster's bounding box also takes in the deck beside an L of walls)
      // a piece of floor with a wall along one side only is the roof deck beside an L of walls (the cluster's
      // bounding box takes it in): kept only with walls along two of its sides
      const sides = (r: Rect) => {
        const along = (x0: number, x1: number, z: number, ax: boolean) => {
          let cov = 0;
          for (const o of ws) {
            const ox0 = ax ? o.x - o.w / 2 : o.z - o.d / 2, ox1 = ax ? o.x + o.w / 2 : o.z + o.d / 2, oz = ax ? o.z : o.x, t = (ax ? o.d : o.w) / 2;
            if (Math.abs(oz - z) <= t + 40) cov += Math.max(0, Math.min(x1, ox1) - Math.max(x0, ox0));
          }
          return cov >= (x1 - x0) * 0.3;
        };
        return [along(r.x0, r.x1, r.z0, true), along(r.x0, r.x1, r.z1, true), along(r.z0, r.z1, r.x0, false), along(r.z0, r.z1, r.x1, false)].filter(Boolean).length;
      };
      // and inside a space closed off on the drawing (walls, parapets, grilles, any line): a piece off the outer corner
      // of the walls has walls on two sides too, but on the plan it lies in the open
      const inSpace = closedOn(roofOver ? undefined : drawnOf.get(st.key), ws);
      from = from.filter(r => (Math.min(r.x1 - r.x0, r.z1 - r.z0) < 60 || sides(r) >= 2) && inSpace(r));
    }
    // (not over this storey's stair holes and voids: the floor below has no hole, the stair arrives through it)
    if (st.key === 'RF' && !/^R\d+F$/.test(lower.key) && drawnOf.get('RF')?.length) {
      // the roof over a one-storey building: within the roof decks drawn on the roof plan, not over the steps and
      // the deck walls outside the building (the deck's curved edge wall, its planter)
      const inRoof = closedOn(drawnOf.get('RF'), objects.filter((o): o is BoxObject => isBox(o) && o.floor === lower.key && o.layer === 'wall'));
      from = from.filter(r => Math.min(r.x1 - r.x0, r.z1 - r.z0) >= 20 && inRoof(r));
    }
    const add = subtractRects(from, [...slabsOf.get(st.key) || [], ...holesOf.get(st.key) || [], ...voidsOf.get(st.key) || []], W, D);
    if (!slabsOf.has(st.key)) slabsOf.set(st.key, []);
    for (const r of add) {
      objects.push({ id: id++, layer: 'slab', name: st.key === 'RF' ? '屋頂板（CAD）' : '樓板（CAD）', floor: st.key, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: st.base - SLAB, color: 0xd6d1c7 });
      slabsOf.get(st.key)!.push(r);
    }
  }
  // the ground floor slab runs under the whole storey above, open fronts too (parking bays, a shop front, an arcade
  // with no wall closing it off on the plan)
  {
    const g = a.storeys[0], up = a.storeys.slice(1).find(q => !/MF$/.test(q.key));
    if (g && up && slabsOf.has(g.key)) {
      // within the storey's own structure (its full-height walls and columns), not under eaves or a cantilever
      const full = objects.filter((o): o is BoxObject => isBox(o) && o.floor === g.key && o.layer === 'wall' && !o.rot && o.h >= g.h * 0.8);
      const fx0 = minOf(full.map(o => o.x - o.w / 2)), fx1 = maxOf(full.map(o => o.x + o.w / 2)), fz0 = minOf(full.map(o => o.z - o.d / 2)), fz1 = maxOf(full.map(o => o.z + o.d / 2));
      const inside = (slabsOf.get(up.key) || []).map(r => ({ x0: Math.max(r.x0, fx0), x1: Math.min(r.x1, fx1), z0: Math.max(r.z0, fz0), z1: Math.min(r.z1, fz1) })).filter(r => r.x1 > r.x0 && r.z1 > r.z0);
      for (const r of full.length ? subtractRects(inside, slabsOf.get(g.key)!, W, D) : []) {
        if ((r.x1 - r.x0) * (r.z1 - r.z0) < 2500) continue;
        objects.push({ id: id++, layer: 'slab', name: '地坪（CAD）', floor: g.key, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: g.base - SLAB, color: 0xd6d1c7 });
        slabsOf.get(g.key)!.push(r);
      }
    }
  }
  // floor openings marked on the plans: cut out of the slabs (beams stay where they are)
  // balconies and terraces outside the walls: their own floor slab where the plate does not reach
  const slabAt = (st: Storey, rs: Rect[], name: string, open = 3) => {
    const add = subtractRects(rs, slabsOf.get(st.key) || [], W, D, open);
    for (const r of add) {
      objects.push({ id: id++, layer: 'slab', name, floor: st.key, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: st.base - SLAB, color: 0xd6d1c7 });
      (slabsOf.get(st.key) || slabsOf.set(st.key, []).get(st.key)!).push(r);
    }
  };
  // the area review's floor outlines are floor even where no walls close them off on the plan (a mezzanine room with
  // brick walls on an unnamed layer); not over the voids and holes marked on the plans
  for (const st of a.storeys) for (const ar of areaOf.get(st.key) || []) {
    // the ground storey stands on the 地坪 above; the roof is built from its own plan
    if (st.key === 'RF' || st === a.storeys[0]) continue;
    const open = [...voidsOf.get(st.key) || [], ...holesOf.get(st.key) || []];
    const rs = open.length ? subtractRects(ar.rects, open, W, D) : ar.rects;
    slabAt(st, rs, ar.kind === 'balcony' ? '陽台樓板（CAD）' : '樓板（CAD）');
  }
  for (const st of a.storeys) for (const sp of outSpaces.get(st.key) || []) {
    slabAt(st, sp.rects, sp.kind === 'balcony' ? '陽台樓板（CAD）' : sp.kind === 'ac' ? '冷氣平台板（CAD）' : sp.kind === 'panel' ? '外挑板（CAD）' : '露台樓板（CAD）', sp.kind === 'ac' || sp.kind === 'panel' ? 1 : 3);
    if (sp.kind === 'terrace') (voidsUp.get(st.key) || voidsUp.set(st.key, []).get(st.key)!).push(...sp.rects);
  }
  // each 露台: its part of the floor plate, closed off by the walls (doorways bridged) and the plate's edge
  for (const st of a.storeys) {
    const at = openAt.get(st.key) || [];
    if (!at.length) continue;
    const ws = objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && (o.layer === 'wall' || o.layer === 'glass') && o.h >= 60);
    voidsUp.get(st.key)!.push(...at.flatMap(t => roomSlabAt(ws, t.x, t.z, W, D, [], 0, slabsOf.get(st.key) || [])));
  }
  a.storeys.forEach((st, i) => {
    const cuts = [...(voidsOf.get(st.key) || []), ...(i ? voidsUp.get(a.storeys[i - 1].key) || [] : [])];
    if (!cuts.length) return;
    const hit = (o: BoxObject) => cuts.some(c => o.x - o.w / 2 < c.x1 && o.x + o.w / 2 > c.x0 && o.z - o.d / 2 < c.z1 && o.z + o.d / 2 > c.z0);
    const keep: Rect[] = [];
    for (let k = objects.length - 1; k >= 0; k--) {
      const o = objects[k];
      if (!isBox(o) || o.floor !== st.key || o.layer !== 'slab' || /梁/.test(o.name) || o.rot || Math.abs(o.y + o.h - st.base) > 5) continue;
      if (!hit(o)) { keep.push({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 }); continue; }
      objects.splice(k, 1);
      for (const r of subtractRects([{ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 }], cuts, W, D)) {
        objects.push({ ...o, id: id++, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 });
        keep.push(r);
      }
    }
    slabsOf.set(st.key, keep);
  });
  // RC railings drawn green round each balcony and terrace: the lines near it and those joined on to them
  for (const st of a.storeys) {
    const sps = outSpaces.get(st.key) || [], gs = greenOf.get(st.key) || [];
    if (!sps.length || !gs.length) continue;
    const near = (q: typeof gs[number]) => sps.some(sp => sp.rects.some(r => Math.min(q.x1, q.x2) < r.x1 + 60 && Math.max(q.x1, q.x2) > r.x0 - 60 && Math.min(q.z1, q.z2) < r.z1 + 60 && Math.max(q.z1, q.z2) > r.z0 - 60));
    const take = new Set(gs.filter(near));
    for (let grew = true; grew;) {
      grew = false;
      for (const q of gs) if (!take.has(q) && [...take].some(p => [[p.x1, p.z1], [p.x2, p.z2]].some(([x, z]) => Math.hypot(x - q.x1, z - q.z1) < 30 || Math.hypot(x - q.x2, z - q.z2) < 30))) { take.add(q); grew = true; }
    }
    const solid = objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && o.layer === 'wall' && o.h > 150);
    const done: BoxObject[] = [];
    for (const q of take) {
      const alongX = Math.abs(q.z1 - q.z2) < 1, a0 = alongX ? Math.min(q.x1, q.x2) : Math.min(q.z1, q.z2), a1 = alongX ? Math.max(q.x1, q.x2) : Math.max(q.z1, q.z2), c = alongX ? q.z1 : q.x1;
      // a double green line is one railing (its two faces)
      if (done.some(o => alongX ? o.w >= o.d && Math.abs(o.z - c) < 30 && o.x - o.w / 2 < a1 - 10 && o.x + o.w / 2 > a0 + 10 : o.d > o.w && Math.abs(o.x - c) < 30 && o.z - o.d / 2 < a1 - 10 && o.z + o.d / 2 > a0 + 10)) continue;
      const b: BoxObject = { id: id++, layer: 'wall', name: 'RC欄杆（CAD）', floor: st.key, x: alongX ? (a0 + a1) / 2 : c, z: alongX ? c : (a0 + a1) / 2, w: alongX ? a1 - a0 : 15, d: alongX ? 15 : a1 - a0, h: 120, y: st.base, color: 0xeeebe5 };
      // already a wall there
      if (solid.some(o => Math.abs(o.x - b.x) < (o.w + b.w) / 2 - 5 && Math.abs(o.z - b.z) < (o.d + b.d) / 2 - 5 && (alongX ? Math.min(o.x + o.w / 2, a1) - Math.max(o.x - o.w / 2, a0) : Math.min(o.z + o.d / 2, a1) - Math.max(o.z - o.d / 2, a0)) > (a1 - a0) * 0.6)) continue;
      // the thin railing drawn on the same edge gives way
      for (let k = objects.length - 1; k >= 0; k--) {
        const o = objects[k];
        if (isBox(o) && o.floor === st.key && /欄杆/.test(o.name) && o.layer !== 'wall' && Math.abs(o.x - b.x) < (o.w + b.w) / 2 + 10 && Math.abs(o.z - b.z) < (o.d + b.d) / 2 + 10) objects.splice(k, 1);
      }
      objects.push(b);
      done.push(b);
    }
  }
  // the open sides of balconies and terraces (no wall, window or railing built there, open air beyond): a 110 cm railing
  for (const st of a.storeys) for (const sp of outSpaces.get(st.key) || []) {
    const bx = { x0: minOf(sp.rects.map(r => r.x0)), x1: maxOf(sp.rects.map(r => r.x1)), z0: minOf(sp.rects.map(r => r.z0)), z1: maxOf(sp.rects.map(r => r.z1)) };
    const solid = objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && (o.layer === 'wall' || o.layer === 'glass' || o.layer === 'rail'));
    const plate = (slabsOf.get(st.key) || []).filter(r => !sp.rects.includes(r));
    const inRect = (x: number, z: number, r: Rect) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
    for (const side of ['x0', 'x1', 'z0', 'z1'] as const) {
      const alongX = side[0] === 'z', at = bx[side], out = side.endsWith('0') ? -1 : 1, lo = alongX ? bx.x0 : bx.z0, hi = alongX ? bx.x1 : bx.z1;
      const free: number[] = [];
      for (let u = lo + 5; u < hi; u += 10) {
        const px = alongX ? u : at, pz = alongX ? at : u;
        if (!sp.rects.some(r => inRect(alongX ? px : px - out * 15, alongX ? pz - out * 15 : pz, r))) continue;
        const covered = solid.some(o => Math.abs(px - o.x) < o.w / 2 + (alongX ? 0 : 25) && Math.abs(pz - o.z) < o.d / 2 + (alongX ? 25 : 0));
        const indoor = plate.some(r => inRect(alongX ? px : px + out * 40, alongX ? pz + out * 40 : pz, r));
        if (!covered && !indoor) free.push(u);
      }
      for (let i = 0; i < free.length;) {
        let j = i;
        while (j + 1 < free.length && free[j + 1] - free[j] < 15) j++;
        const a0 = free[i] - 5, a1 = free[j] + 5;
        if (a1 - a0 >= 60) {
          const c = (a0 + a1) / 2, t = sp.kind === 'panel' ? 15 : sp.kind === 'ac' ? 5 : 15, pos = at - out * t / 2;
          const [layer, name, h, color] = sp.kind === 'ac' ? ['rail' as const, '冷氣平台格柵（CAD）', sp.h ?? 90, 0x8a8f96]
            : sp.kind === 'panel' ? ['wall' as const, 'RC裝飾板（CAD）', sp.h ?? 120, 0xeeebe5] : ['rail' as const, '陽台欄杆（CAD）', 110, 0xd9d6cf];
          objects.push({ id: id++, layer, name, floor: st.key, x: alongX ? c : pos, z: alongX ? pos : c, w: alongX ? a1 - a0 : t, d: alongX ? t : a1 - a0, h, y: st.base, color });
        }
        i = j + 1;
      }
    }
  }
  // a balcony has a slab over it too: the floor of the balcony above, or its own roof
  a.storeys.forEach((st, i) => {
    const up = a.storeys[i + 1];
    if (!up) return;
    for (const sp of outSpaces.get(st.key) || []) if (sp.kind === 'balcony') {
      const free = subtractRects(sp.rects, voidsOf.get(up.key) || [], W, D);
      slabAt(up, free, up.key === 'RF' ? '屋頂板（CAD）' : '陽台頂板（CAD）');
    }
  });
  for (const f of floors) id = fillBetweenColumns(objects, f, linesOf.get(f.key) || [], outdoorOf.get(f.key) || [], id);
  // a room closed in by full-height walls on all four sides (its doors and windows count as wall) is indoors even when
  // the plan above draws no floor over it (a stair landing beside a 屋突, a shaft): it gets a roof slab at the next level
  a.storeys.forEach((st, i) => {
    const next = a.storeys[i + 1];
    if (!next || st.key === 'RF') return;
    const top = st.base + st.h - 5;
    const ws = objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && o.layer === 'wall' && !o.rot && o.y + o.h >= top);
    const ds = objects.filter((o): o is DoorObject => isDoor(o) && o.floor === st.key);
    const cover = [...(slabsOf.get(next.key) || []), ...(holesOf.get(next.key) || []), ...(voidsOf.get(next.key) || [])];
    // (under the roof plan only where it outlines a deck: a walled yard or the outdoor steps stay open)
    const onRoof = next.key === 'RF' ? closedOn(drawnOf.get('RF'), objects.filter((o): o is BoxObject => isBox(o) && o.floor === 'RF' && o.layer === 'wall')) : () => true;
    for (const r of [...(slabsOf.get(st.key) || [])]) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      if (w < 80 || d < 80 || w * d > 60e4 || !onRoof(r)) continue;
      if ((terraces.get(st.key) || []).some(t => t.x >= r.x0 && t.x <= r.x1 && t.z >= r.z0 && t.z <= r.z1)) continue;
      const open = subtractRects([r], cover, W, D);
      if (open.reduce((n, q) => n + (q.x1 - q.x0) * (q.z1 - q.z0), 0) < w * d * 0.5) continue;
      // share of each side with a wall (or a door) standing on it
      const side = (alongX: boolean, at: number, lo: number, hi: number) => {
        const iv: [number, number][] = [];
        for (const o of ws) if ((o.w >= o.d) === alongX && Math.abs((alongX ? o.z : o.x) - at) <= (alongX ? o.d : o.w) / 2 + 30) {
          const c = alongX ? o.x : o.z, h = (alongX ? o.w : o.d) / 2; iv.push([c - h, c + h]);
        }
        for (const o of ds) if ((o.axis === 'x') === alongX && Math.abs(o.at - at) <= 30) iv.push([o.a, o.b]);
        let n = 0, end = lo;
        for (const [a0, a1] of iv.map(([a0, a1]) => [Math.max(lo, a0), Math.min(hi, a1)] as [number, number]).filter(([a0, a1]) => a1 > a0).sort((p, q) => p[0] - q[0])) {
          if (a1 <= end) continue;
          n += a1 - Math.max(a0, end); end = a1;
        }
        return n / (hi - lo);
      };
      const walled = [side(true, r.z0, r.x0, r.x1), side(true, r.z1, r.x0, r.x1), side(false, r.x0, r.z0, r.z1), side(false, r.x1, r.z0, r.z1)].every(f => f >= 0.8);
      // or the plan above draws the outline of that open part (a light well's top drawn with its railing round it)
      const o = { x0: minOf(open.map(q => q.x0)), x1: maxOf(open.map(q => q.x1)), z0: minOf(open.map(q => q.z0)), z1: maxOf(open.map(q => q.z1)) };
      const ls = linesOf.get(next.key) || [];
      const drawn = (alongX: boolean, at: number, lo: number, hi: number) => {
        let best = 0;
        for (const tol of [30]) {
          const iv = ls.filter(l => alongX ? Math.abs(l.z1 - l.z2) < 1 && Math.abs(l.z1 - at) <= tol : Math.abs(l.x1 - l.x2) < 1 && Math.abs(l.x1 - at) <= tol)
            .map(l => alongX ? [Math.min(l.x1, l.x2), Math.max(l.x1, l.x2)] : [Math.min(l.z1, l.z2), Math.max(l.z1, l.z2)]);
          let n = 0, end = lo;
          for (const [a0, a1] of iv.map(([a0, a1]) => [Math.max(lo, a0), Math.min(hi, a1)]).filter(([a0, a1]) => a1 > a0).sort((p, q) => p[0] - q[0])) { if (a1 <= end) continue; n += a1 - Math.max(a0, end); end = a1; }
          best = Math.max(best, n / (hi - lo));
        }
        return best;
      };
      const outline = !walled && [drawn(true, o.z0, o.x0, o.x1), drawn(true, o.z1, o.x0, o.x1), drawn(false, o.x0, o.z0, o.z1), drawn(false, o.x1, o.z0, o.z1)].every(f => f >= 0.8);
      if (!walled && !outline) continue;
      const before = (slabsOf.get(next.key) || []).slice();
      slabAt(next, open, next.key === 'RF' ? '屋頂板（CAD）' : '頂板（CAD）');
      if (!outline) continue;
      // a roof standing out from the floor above has a 120 cm railing round it where it does not meet that floor
      const edge = (alongX: boolean, at: number, lo: number, hi: number, out: number) => {
        const free: number[] = [];
        for (let u = lo + 5; u < hi; u += 10) {
          const px = alongX ? u : at + out * 20, pz = alongX ? at + out * 20 : u;
          const ex = alongX ? u : at, ez = alongX ? at : u;
          const walledUp = objects.some(w => isBox(w) && w.floor === next.key && (w.layer === 'wall' || w.layer === 'rail') && !w.rot && Math.abs(ex - w.x) <= w.w / 2 + 25 && Math.abs(ez - w.z) <= w.d / 2 + 25);
          if (!walledUp && !before.some(q => px >= q.x0 - 5 && px <= q.x1 + 5 && pz >= q.z0 - 5 && pz <= q.z1 + 5)) free.push(u);
        }
        if (free.length * 10 < 60) return;
        const a0 = free[0] - 5, a1 = free[free.length - 1] + 5, c = (a0 + a1) / 2, t = 15, pos = at - out * t / 2;
        objects.push({ id: id++, layer: 'wall', name: 'RC欄杆（CAD）', floor: next.key, x: alongX ? c : pos, z: alongX ? pos : c, w: alongX ? a1 - a0 : t, d: alongX ? t : a1 - a0, h: 120, y: next.base, color: 0xd9d6cf });
      };
      edge(true, o.z0, o.x0, o.x1, -1); edge(true, o.z1, o.x0, o.x1, 1); edge(false, o.x0, o.z0, o.z1, -1); edge(false, o.x1, o.z0, o.z1, 1);
    }
  });
  // columns and walls standing on a terrace or roof deck (nothing above them) end level with the parapet round it
  const headH = parapetNote ?? a.parapet;
  a.storeys.forEach((st, i) => {
    const next = a.storeys[i + 1];
    if (!next) return;
    // a stair well or a void (天井, double-height room) in the floor above still has the storey's walls running up beside it
    const cover = [...(slabsOf.get(next.key) || []), ...(holesOf.get(next.key) || []), ...(voidsOf.get(next.key) || [])];
    // the terraces themselves, walled off from the rooms beside them (a stair room on a roof deck keeps its roof)
    const stWalls = objects.filter((o): o is BoxObject => isBox(o) && o.floor === st.key && (o.layer === 'wall' || o.layer === 'glass') && o.h >= 60);
    const terr = (terraces.get(st.key) || []).map(t => roomSlabAt(stWalls, t.x, t.z, W, D, [], 0, slabsOf.get(st.key) || []));
    const inR = (rs: Rect[], x: number, z: number) => rs.some(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
    const upOn = objects.filter((o): o is BoxObject => isBox(o) && o.floor === next.key && o.layer === 'wall' && !o.rot && o.h >= next.h * 0.8 && o.y === next.base);
    for (const o of objects) {
      // (a curved wall round a deck is many short turned pieces: each one is judged by its centre)
      if (!isBox(o) || o.floor !== st.key || o.layer !== 'wall' || o.y !== st.base || o.h < headH + 40 || o.h < st.h - 5) continue;
      if (/窗台|窗楣|門楣|隔間牆下/.test(o.name)) continue;
      // a column or wall with one standing on it on the storey above runs on up to it (a column at a terrace edge)
      if (upOn.some(u => Math.abs(u.x - o.x) <= (u.w + o.w) / 2 - 5 && Math.abs(u.z - o.z) <= (u.d + o.d) / 2 - 5)) continue;
      const inside = (r: { x0: number; x1: number; z0: number; z1: number }) => o.x >= r.x0 - 30 && o.x <= r.x1 + 30 && o.z >= r.z0 - 30 && o.z <= r.z1 + 30;
      // a terrace's own slab: a 露台 / 平台 label inside it, the sunshade slab over it does not count as a roof
      const onTerrace = (slabsOf.get(st.key) || []).some(r => inside(r) && (terraces.get(st.key) || []).some(t => t.x >= r.x0 && t.x <= r.x1 && t.z >= r.z0 && t.z <= r.z1));
      if (!onTerrace && cover.some(inside)) continue;
      if (onTerrace && terr.length && terr.every(rs => rs.length)) {
        // a wall with a roofed room (not the terrace) on one side runs up to that roof
        const ax = o.w >= o.d;
        const roofed = [-1, 1].some(sd => [25, 60].some(dd => {
          const off = Math.min(o.w, o.d) / 2 + dd, x = o.x + (ax ? 0 : sd * off), z = o.z + (ax ? sd * off : 0);
          return inR(cover, x, z) && !terr.some(rs => inR(rs, x, z));
        }));
        if (roofed) continue;
      }
      o.h = headH;
      o.name = /柱/.test(o.name) || o.rc ? o.name : `${o.name}（露台頂，同女兒牆高）`;
      cutHeads++;
      // an outdoor kerb or step on the ground with its level written beside it (+20, FL+40): that high
      if (i === 0 && !/柱/.test(o.name)) {
        const lv = (notesOf.get(st.key) || []).map(n => ({ n, dd: Math.hypot(Math.max(0, Math.abs(n.x - o.x) - o.w / 2), Math.max(0, Math.abs(n.z - o.z) - o.d / 2)), m: /^(?:FL\s*)?\+\s*(\d{1,3})$/.exec(n.s.trim()) }))
          .filter(q => q.m && q.dd <= 120 && +q.m![1] >= 5 && +q.m![1] <= 100).sort((p, q) => p.dd - q.dd)[0];
        if (lv) { o.h = +lv.m![1]; o.name = `台階 +${lv.m![1]}（CAD）`; }
      }
    }
  });
  // the same plan referenced twice (an xref nested in itself) draws every wall twice: keep one of each identical box
  const seenBox = new Set<string>();
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!isBox(o)) continue;
    const r = (v: number | undefined) => Math.round((v || 0) * 2);
    const k = [o.floor, o.layer, r(o.x), r(o.z), r(o.y), r(o.w), r(o.d), r(o.h), Math.round((o.rot || 0) * 1000)].join();
    if (seenBox.has(k)) { objects.splice(i--, 1); if (o.layer === 'wall') nWalls--; else if (o.layer === 'glass') nWins--; }
    else seenBox.add(k);
  }
  // a wall lying wholly inside another (a second outline of the same wall, a stub drawn into a thicker one) is built once
  const innerOf = objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'wall' && !o.rot);
  const gone = new Set<BoxObject>();
  for (const p of innerOf) {
    if (/柱/.test(p.name)) continue;
    const q = innerOf.find(q => q !== p && !gone.has(q) && q.floor === p.floor && p.x - p.w / 2 >= q.x - q.w / 2 - 1 && p.x + p.w / 2 <= q.x + q.w / 2 + 1 && p.z - p.d / 2 >= q.z - q.d / 2 - 1 && p.z + p.d / 2 <= q.z + q.d / 2 + 1
      && p.y >= q.y - 1 && p.y + p.h <= q.y + q.h + 1 && (p.w * p.d < q.w * q.d || p.id > q.id));
    if (q) gone.add(p);
  }
  for (let i = objects.length - 1; i >= 0; i--) if (gone.has(objects[i] as BoxObject)) { objects.splice(i, 1); nWalls--; }
  // a little group of walls 3 m or more away from the rest of its floor is a site item drawn on a wall layer
  // (a meter box, a gate post): left out with the floor patches under it
  const wallsOf = (k: string) => objects.filter((o): o is BoxObject => isBox(o) && o.floor === k && o.layer === 'wall');
  const big = a.storeys.map(st => wallsOf(st.key)).sort((p, q) => q.length - p.length)[0] || [];
  const bb = big.length ? { x0: minOf(big.map(o => o.x - o.w / 2)) - 300, x1: maxOf(big.map(o => o.x + o.w / 2)) + 300, z0: minOf(big.map(o => o.z - o.d / 2)) - 300, z1: maxOf(big.map(o => o.z + o.d / 2)) + 300 } : null;
  for (const st of a.storeys) {
    const ws = wallsOf(st.key);
    if (!ws.length) continue;
    const parent = ws.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      const p = ws[i], q = ws[j];
      if (Math.abs(p.x - q.x) < (p.w + q.w) / 2 + 300 && Math.abs(p.z - q.z) < (p.d + q.d) / 2 + 300) parent[find(i)] = find(j);
    }
    const groups = new Map<number, BoxObject[]>();
    ws.forEach((o, i) => (groups.get(find(i)) || groups.set(find(i), []).get(find(i))!).push(o));
    for (const g of groups.values()) {
      const x0 = minOf(g.map(o => o.x - o.w / 2)), x1 = maxOf(g.map(o => o.x + o.w / 2)), z0 = minOf(g.map(o => o.z - o.d / 2)), z1 = maxOf(g.map(o => o.z + o.d / 2));
      const outside = !!bb && (x0 > bb.x1 || x1 < bb.x0 || z0 > bb.z1 || z1 < bb.z0);
      if (Math.max(x1 - x0, z1 - z0) > 300 || (!outside && (ws.length < 10 || g.length * 4 > ws.length))) continue;
      const drop = new Set<ModelObject>(g);
      for (const o of objects) if (isBox(o) && o.floor === st.key && o.layer === 'slab' && o.x > x0 - 10 && o.x < x1 + 10 && o.z > z0 - 10 && o.z < z1 + 10 && Math.max(o.w, o.d) <= 320) drop.add(o);
      for (let i = objects.length - 1; i >= 0; i--) if (drop.has(objects[i])) { if (objects[i].layer === 'wall') nWalls--; objects.splice(i, 1); }
    }
  }
  if (bb) for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (isBox(o) && o.layer === 'slab' && Math.max(o.w, o.d) <= 320 && (o.x - o.w / 2 > bb.x1 || o.x + o.w / 2 < bb.x0 || o.z - o.d / 2 > bb.z1 || o.z + o.d / 2 < bb.z0)) objects.splice(i, 1);
  }
  // site walls: low walls on the ground floor outside the building (beyond its full-height walls and the storey above),
  // or on a 圍牆 layer; as high as the elevations draw them when a low box on an elevation stands over them
  {
    const g = a.storeys[0], up = a.storeys.slice(1).find(q => !/MF$/.test(q.key));
    const mine = objects.filter((o): o is BoxObject => isBox(o) && o.floor === g?.key && o.layer === 'wall' && !o.rot);
    const full = mine.filter(o => o.h >= (g?.h || 300) * 0.8 && Math.max(o.w, o.d) >= 150);
    const plate = up ? slabsOf.get(up.key) || [] : [];
    if (g && full.length) {
      const fx0 = minOf(full.map(o => o.x - o.w / 2)), fx1 = maxOf(full.map(o => o.x + o.w / 2)), fz0 = minOf(full.map(o => o.z - o.d / 2)), fz1 = maxOf(full.map(o => o.z + o.d / 2));
      for (const o of mine) {
        const named = /圍牆/.test(o.src || '');
        const outside = o.x + o.w / 2 < fx0 - 20 || o.x - o.w / 2 > fx1 + 20 || o.z + o.d / 2 < fz0 - 20 || o.z - o.d / 2 > fz1 + 20;
        const under = plate.some(r => o.x + o.w / 2 > r.x0 - 30 && o.x - o.w / 2 < r.x1 + 30 && o.z + o.d / 2 > r.z0 - 30 && o.z - o.d / 2 < r.z1 + 30);
        if (!named && !(o.h <= 200 && outside && !under)) continue;
        o.name = '圍牆（CAD）'; o.wall = 'rc';
        if (a.fenceH) { o.h = a.fenceH; }
      }
    }
  }
  // with the site items gone the model can start well inside the drawn area: move it to the origin so the
  // stated width and depth are the building's
  {
    const bx = objects.filter(isBox), ext = (o: BoxObject) => o.rot ? Math.max(o.w, o.d) / 2 : 0;
    if (bx.length) {
      const x0 = minOf(bx.map(o => o.x - (ext(o) || o.w / 2))), x1 = maxOf(bx.map(o => o.x + (ext(o) || o.w / 2)));
      const z0 = minOf(bx.map(o => o.z - (ext(o) || o.d / 2))), z1 = maxOf(bx.map(o => o.z + (ext(o) || o.d / 2)));
      if (x0 > 100 || z0 > 100 || W - x1 > 100 || D - z1 > 100) {
        const sx = Math.max(0, x0), sz = Math.max(0, z0);
        for (const o of objects) {
          if (isBox(o)) { o.x -= sx; o.z -= sz; continue; }
          const dr = o as DoorObject;
          if (dr.axis === 'x') { dr.a -= sx; dr.b -= sx; dr.at -= sz; } else { dr.a -= sz; dr.b -= sz; dr.at -= sx; }
        }
        for (const f of floors) {
          for (let i = 0; i < f.segs.length; i += 2) { f.segs[i] -= sx; f.segs[i + 1] -= sz; }
          for (const t of f.texts) { t.x -= sx; t.z -= sz; }
        }
        for (const p of rcPanels) { p.x0 -= sx; p.x1 -= sx; p.z0 -= sz; p.z1 -= sz; }
        W = x1 - sx; D = z1 - sz;
      }
    }
  }
  const spec = readRebarSpec(d, a.storeys.map(s => s.key));
  const colourLen = new Map<number, number>();
  for (const o of wallBoxes) colourLen.set(o.wc!, (colourLen.get(o.wc!) || 0) + Math.max(o.w, o.d));
  const report: BuildReport = {
    wallColours: [...colourLen].map(([color, length]) => ({ color, length: Math.round(length) })).sort((p, q) => q.length - p.length),
    projectionLabels, stairs: stairList,
    slantWalls: objects.filter(o => isBox(o) && o.layer === 'wall' && o.rot && Math.max(o.w, o.d) >= 300).length,
    unmatchedTags,
    areaChecks: areaChecks(d, a.storeys.map(st => st.key), objects),
    cross: a.checks || [],
    issues: [...issues, ...checkModel(objects, floors)],
    tally: a.schedule.map(i => {
      const n = objects.filter(o => (o.layer === 'door' || o.layer === 'glass') && o.name.split(' ')[0] === i.code).length;
      return { code: i.code, name: i.name, ...(i.qty !== undefined ? { qty: i.qty } : {}), built: i.legs ? Math.ceil(n / 2) : n, ...(guessedN.get(i.code) ? { guessed: guessedN.get(i.code) } : {}), tagged: taggedN.get(i.code) || 0 };
    }),
    perFloor: a.storeys.map(st => {
      const of = objects.filter(o => o.floor === st.key);
      return { key: st.key, walls: of.filter(o => isBox(o) && o.layer === 'wall').length, doors: of.filter(o => !isBox(o)).length, windows: of.filter(o => isBox(o) && o.layer === 'glass').length, slabs: of.filter(o => isBox(o) && o.layer === 'slab' && /板|地坪/.test(o.name) && !/梁/.test(o.name)).length };
    }),
  };
  return {
    objects,
    report,
    cad: { name, W, D, segs: [], texts: [], doors: [], floors, layers: layerNames, ...(spec ? { rc: { spec, panels: rcPanels } } : {}) },
    analysis: a,
    stats: { floors: floors.length, walls: nWalls, doors: nDoors, windows: nWins, railings: nRails, heads: cutHeads, ...(extColor !== undefined ? { extColor } : {}) },
  };
}

/** Removes rows of identical short strips (louvres, grilles, shading fins, their cross lines) that pair up like walls. */
function dropLouvers(boxes: BoxObject[]): BoxObject[] {
  return boxes.filter(o => {
    // a few degrees off square is a cross line paired with its neighbour, not a wall
    const off = Math.abs(((o.rot || 0) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2));
    // (a long slanted wall, like one following a site boundary, is real)
    if (Math.min(off, Math.PI / 2 - off) > 0.01 && Math.min(off, Math.PI / 2 - off) < 0.25 && (optNow.noSlants || Math.max(o.w, o.d) < 300)) return false;
    if (Math.max(o.w, o.d) > 300 || Math.min(o.w, o.d) >= 35) return true;
    // (the same wall found twice is not a twin: an exact copy counts once; nested outlines a little apart in size do count)
    const twins = boxes.filter(q => q !== o && Math.abs((q.rot || 0) - (o.rot || 0)) < 0.02 && Math.abs(q.w - o.w) < 3 && Math.abs(q.d - o.d) < 3 && Math.hypot(q.x - o.x, q.z - o.z) < 150);
    const at = new Set(twins.map(q => [q.x, q.z, q.w, q.d].map(v => Math.round(v * 2)).join()));
    at.delete([o.x, o.z, o.w, o.d].map(v => Math.round(v * 2)).join());
    return at.size < 3;
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
  const cast = (axis: 'x' | 'z', at: number, u: number, dir: 1 | -1, max: number, behind = false, slack = 0) => {
    let best: { u: number; o: BoxObject } | null = null;
    for (const o of solid) {
      const sp = span(o, axis);
      if (Math.abs(sp.c - at) > sp.half + 0.5 + slack) continue;
      const face = dir > 0 ? sp.lo : sp.hi;
      // walls are lengthened by half their thickness, so a jamb face may sit that far behind a hinge
      if ((face - u) * dir < -(behind ? sp.half + 1 + slack : 1) || Math.abs(face - u) > max) continue;
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
    let lone: { axis: 'x' | 'z'; at: number; a: number; b: number; t: number } | null = null;
    for (const slack of [0, 12]) {
      const cands: { axis: 'x' | 'z'; at: number; a: number; b: number; t: number; run: boolean }[] = [];
      for (const [ex, ez] of s.ends) {
        const dx = ex - s.x, dz = ez - s.z;
        const axis = Math.abs(dx) > Math.abs(dz) * 4 ? 'x' : Math.abs(dz) > Math.abs(dx) * 4 ? 'z' : null;
        if (!axis) continue;
        const dir = (axis === 'x' ? dx : dz) > 0 ? 1 : -1;
        const u0 = axis === 'x' ? s.x : s.z, at0 = axis === 'x' ? s.z : s.x;
        const end = u0 + dir * s.r;
        // the wall behind the hinge, or (when the hinge side is open) the wall the closed leaf meets
        const jamb = cast(axis, at0, u0, dir === 1 ? -1 : 1, 25, true, slack) || cast(axis, at0, end, dir, 15, true, slack);
        if (!jamb) continue;
        const sp = span(jamb.o, axis), run = isRun(jamb.o, axis);
        cands.push({ axis, at: run ? sp.c : at0, a: Math.min(u0, end), b: Math.max(u0, end), t: run ? sp.half * 2 : 20, run });
      }
      // the closed leaf lies along a wall; next to a column either end can look like a jamb
      const c = cands.find(q => q.run);
      if (c) { push(c.axis, c.at, c.a, c.b, c.t, true); lone = null; break; }
      if (!slack && cands.length === 1) lone = cands[0];
    }
    // second pass above lets walls drawn a little off the hinge line count as the jamb; only then a lone end is taken
    if (lone) push(lone.axis, lone.at, lone.a, lone.b, lone.t, true);
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
      at = (minOf(par) + maxOf(par)) / 2;
      t = Math.min(30, Math.max(10, maxOf(par) - minOf(par) + 4));
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

  // the two leaves of a double door meet: one opening
  for (let i = 0; i < out.length; i++) for (let j = out.length - 1; j > i; j--) {
    const p = out[i], q = out[j];
    if (!p.arc || !q.arc || p.axis !== q.axis || Math.abs((p.axis === 'x' ? p.cz - q.cz : p.cx - q.cx)) > 15 || q.a > p.b + 10 || p.a > q.b + 10) continue;
    p.a = Math.min(p.a, q.a); p.b = Math.max(p.b, q.b); p.len = p.b - p.a;
    if (p.axis === 'x') p.cx = (p.a + p.b) / 2; else p.cz = (p.a + p.b) / 2;
    out.splice(j, 1);
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
  const out: DxfDrawing = { segs: [], polys: [], texts: [], arcs: [], dims: [], layers: new Map(), units: 5, version: ds[0].version, blockCount: 0, inserts: 0, parts: [] };
  let at = 0;
  for (const d0 of ds) {
    const k = UNIT_SCALE[guessUnits(d0)] || 1;
    const sc = (p: Pt): Pt => [p[0] * k, p[1] * k];
    const d = k === 1 ? d0 : { ...d0, segs: d0.segs.map(s => ({ ...s, a: sc(s.a), b: sc(s.b) })), polys: d0.polys.map(p => ({ ...p, pts: p.pts.map(sc) })), texts: d0.texts.map(t => ({ ...t, x: t.x * k, y: t.y * k, ...(t.h ? { h: t.h * k } : {}) })), arcs: d0.arcs.map(c => ({ ...c, c: sc(c.c), r: c.r * k, ...(c.p0 ? { p0: sc(c.p0) } : {}), ...(c.p1 ? { p1: sc(c.p1) } : {}) })), dims: d0.dims?.map(m => ({ ...m, a: sc(m.a), b: sc(m.b) })) };
    let minX = Infinity, maxX = -Infinity;
    for (const s of d.segs) for (const p of [s.a, s.b]) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
    for (const t of d.texts) { minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); }
    if (!isFinite(minX)) continue;
    const dx = at - minX, mv = (p: Pt): Pt => [p[0] + dx, p[1]];
    for (const v of d.segs.map(s => ({ ...s, a: mv(s.a), b: mv(s.b) }))) out.segs.push(v);
    for (const v of d.polys.map(p => ({ ...p, pts: p.pts.map(mv) }))) out.polys.push(v);
    for (const v of d.texts.map(t => ({ ...t, x: t.x + dx }))) out.texts.push(v);
    for (const v of d.arcs.map(c => ({ ...c, c: mv(c.c), ...(c.p0 ? { p0: mv(c.p0) } : {}), ...(c.p1 ? { p1: mv(c.p1) } : {}) }))) out.arcs.push(v);
    for (const v of (d.dims || []).map(m => ({ ...m, a: mv(m.a), b: mv(m.b) }))) out.dims!.push(v);
    for (const [l, n] of d.layers) out.layers.set(l, (out.layers.get(l) || 0) + n);
    out.blockCount += d.blockCount; out.inserts += d.inserts;
    out.parts!.push({ x0: at, x1: at + maxX - minX });
    at += maxX - minX + Math.max(1000, (maxX - minX) * 0.1);
  }
  return out;
}
