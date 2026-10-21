import { UNIT_SCALE, guessLayerKind, guessUnits } from './cadImport';
import type { DxfDrawing, DxfSeg, DxfText, Pt } from './dxf';
import { pairWalls, wallBox } from './geometry';
import { WALL_H } from './sample';
import { findFlights, planStairs, type StairFlight, type StairPlan } from './stairs';
import { HEIGHT_NOTE, isDoorType, openingName, openingType, PLAN_NOTES, type OpeningType } from './legend';
import { readRebarSpec } from './rebar';
import { isBox, type BoxObject, type CadData, type CadFloor, type DoorObject, type ModelObject, type SlabPanel } from './types';

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
const normLevel = (s: string) => {
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
        v.framed = true;
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

/** upstand round the top roof slab (屋頂層), read off the sections, cm */
const ROOF_UPSTAND = 30;

export function analyzeBuilding(d: DxfDrawing, defaultH = WALL_H): BuildingAnalysis | null {
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
  extraWall = new Set(wallLayers); scaleNow = scale;
  // when two files both have a plan of a storey (architectural and structural), the one with the most wall lines wins
  const walls = (v: SheetView) => d.segs.filter(s => isWallLayer(s.layer) && inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1])).length;
  // a site plan that also shows the ground floor (全區暨一層平面圖) only when there is no plan of the building alone
  const site = (v: SheetView) => /全區|總平面|配置/.test(v.title) ? 1 : 0;
  const plans = planViews.map(v => ({ v, n: walls(v) })).sort((a, b) => site(a.v) - site(b.v) || b.n - a.n).map(p => p.v);
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
    const h = k === 'RF' ? ROOF_UPSTAND : !above && i === keys.length - 1 && k.startsWith('R') ? parapet : above ? above[1] - base : defaultH;
    storeys.push({ key: k, title: plans.find(p => p.floors.includes(k))!.title, base, h });
  }
  // a set whose plans carry hardly any wall lines (area-review sheets, site plans) cannot be built into walls
  const warnings: string[] = [];
  const wallSet = new Set(wallLayers);
  let wallSegs = 0;
  for (const g of d.segs) if (wallSet.has(g.layer) || guessLayerKind(g.layer) === 'wall') wallSegs++;
  if (plans.length && wallSegs < 300) warnings.push(`整份圖只讀到 ${wallSegs} 條牆線，這比較像「面積檢討圖」或示意圖，不是畫有牆、門窗的施工平面圖，所以 3D 會幾乎是空的。請改匯入含牆線與門窗的各層平面圖（常見檔名如「各層平面圖」「平面配置圖」的施工圖版本），或直接把這份圖的樓地板面積當作對帳用。`);
  return { views, plans, levels, storeys, schedule, parapet, scale, wallLayers, colLayers, warnings };
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

let extraWall = new Set<string>(), scaleNow = 0, optNow: BuildOptions = {};
const isWallLayer = (l: string) => guessLayerKind(l) === 'wall' || /^COL/i.test(l) || extraWall.has(l);

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
  const cell = (v: number) => Math.floor(v / gap), key = (i: number, j: number) => `${i},${j}`;
  const parent = ws.map((_, i) => i), find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const at = new Map<string, number>();
  ws.forEach((s, i) => {
    for (const q of [s.a, s.b, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]]) {
      const ci = cell(q[0]), cj = cell(q[1]);
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

function planGeo(d: DxfDrawing, v: SheetView): PlanGeo {
  let segs = d.segs.filter(s => inBox(v.box, s.a[0], s.a[1]) && inBox(v.box, s.b[0], s.b[1]));
  const k = scaleNow || UNIT_SCALE[guessUnits(d)] || 1, area = buildingArea(segs, 400 / k), m = 200 / k;
  if (area) segs = segs.filter(s => [s.a, s.b].every(q => q[0] >= area.x0 - m && q[0] <= area.x1 + m && q[1] >= area.y0 - m && q[1] <= area.y1 + m));
  const grid = d.texts.filter(t => /GTAG|GRID|AXIS|軸|格線/i.test(t.layer) && inBox(v.box, t.x, t.y));
  const nums = grid.filter(t => /^\d{1,2}$/.test(t.s)).sort((a, b) => +a.s - +b.s);
  const lets = grid.filter(t => /^[A-Z]$/.test(t.s)).sort((a, b) => a.s.localeCompare(b.s));
  const gx = [...new Set(nums.map(t => Math.round(t.x)))], gy = [...new Set(lets.map(t => Math.round(t.y)))];
  if (nums.length && lets.length) return { segs, ox: nums[0].x, oy: lets[0].y, gx, gy, ax: true, ay: true };
  const ws = segs.filter(s => isWallLayer(s.layer));
  // X1 X2 … / Y1 Y2 … grid bubbles on any layer (also "X" with the number as a separate text beside it)
  const xy = (axis: 'X' | 'Y') => {
    const out: { n: number; x: number; y: number }[] = [];
    for (const t of d.texts) {
      if (!inBox(v.box, t.x, t.y)) continue;
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
  return maskRects(keep, nx, nz, C, M);
}

type Rect = { x0: number; x1: number; z0: number; z1: number };
/** Cells of a raster merged into rectangles: runs per row, stacked while the next row has the same run. */
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
  if (nRf >= nIn * 0.3) for (let k = 0; k < N; k++) eave[k] = !rfOut[k] && !indoor[k] ? 1 : 0;
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
    const lab = start.find(n => n.x > minOf(xs) - 60 && n.x < maxOf(xs) + 60 && n.z > minOf(zs) - 60 && n.z < maxOf(zs) + 60);
    const N = lab ? +(/\d+/.exec(lab.s)?.[0] || 0) : 0;
    return { ...sp, labelled: N >= 4 && N <= 40 ? N : 0 };
  });
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
}

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
    const s = t.s.trim();
    if (!LIST.test(s) || s.length < 2) continue;
    const h = t.h || 12;
    const sz = d.texts.map(o => ({ o, m: SIZE2.exec(o.s.trim()) })).filter(q => q.m && Math.abs(q.o.y - t.y) <= h * 0.6 && q.o.x > t.x + h * 6 && q.o.x < t.x + h * 60)
      .sort((p, q) => Math.abs(p.o.y - t.y) - Math.abs(q.o.y - t.y))[0];
    if (!sz) continue;
    const parts = s.split(',').map(tok => {
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
  const texts = d.texts.filter(t => inBox(v.box, t.x, t.y));
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
  return out;
}

const SLAB_MARK = /^(?:F?C?S\d{1,2}|BS\d{1,2}|Sw)$/;
/** Slab panels of one structural plan: from each slab mark (S1, CS1, FS1 …) out to the beam centre lines round it. */
function readPanels(d: DxfDrawing, v: SheetView, X: (x: number) => number, Z: (y: number) => number, lines: ReturnType<typeof readBeams>, W: number, D: number) {
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

/** Builds every storey of the analysed drawing set, stacked at its level. */
export function buildBuilding(d: DxfDrawing, a: BuildingAnalysis, name: string, firstId = 1, opts: BuildOptions = {}): BuildingResult {
  const S = a.scale;
  extraWall = new Set(a.wallLayers); scaleNow = S; optNow = opts;
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
  const W = (maxX - minX) * S, D = (maxY - minY) * S;
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
  let nWalls = 0, nDoors = 0, nWins = 0, nRails = 0, cutHeads = 0;
  let below: StairPlan['holes'] = [];
  const railing = railingDefault(d, a), beamDepth = beamDepthOf(d, a);
  // 女兒牆高度 written anywhere (plans, elevations, sections)
  const parapetNote = d.texts.some(t => /女兒牆/.test(HEIGHT_NOTE.exec(t.s)?.[1] || '')) ? a.parapet : null;
  const slabsOf = new Map<string, { x0: number; x1: number; z0: number; z1: number }[]>();
  const holesOf = new Map<string, { x0: number; x1: number; z0: number; z1: number }[]>();
  const terraces = new Map<string, { x: number; z: number; s: string }[]>();
  /** names of open-air spaces on each storey (外廊, 露台 …) on any layer: they are not under the roof */
  const outdoorOf = new Map<string, { x: number; z: number }[]>(), roomsOf = new Map<string, { x: number; z: number }[]>();
  const slants: { key: string; side: 'w' | 'e'; x1: number; z1: number; x2: number; z2: number }[] = [];
  const beamLines: { st: Storey; xs: number[]; zs: number[] }[] = [];

  // an unlabelled stair is drawn in full on the plan of the storey it arrives at (the lower plan cuts it short): it climbs the storey below
  const stairPre = new Map<string, ReturnType<typeof stairsOf>>();
  const stairIn = new Map<string, { segs: { x1: number; z1: number; x2: number; z2: number }[]; labelled: boolean }>();
  for (const st of a.storeys) {
    if (st.key === 'RF') continue;
    const plan = a.plans.find(p => p.floors.includes(st.key))!, g = geos.get(plan)!;
    const X = (x: number) => (x - g.ox - minX) * S, Z = (y: number) => (maxY - (y - g.oy)) * S;
    const segs = g.segs.filter(s => STAIR_LAYER.test(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const notes = d.texts.filter(t => inBox(plan.box, t.x, t.y)).map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }));
    stairIn.set(st.key, { segs, labelled: notes.some(n => /^(上|下|UP|DN)\s*\d*$/i.test(n.s.trim())) });
    stairPre.set(st.key, stairsOf(segs, notes, st.h));
  }
  a.storeys.forEach((st, i) => {
    const nx = a.storeys[i + 1], q = stairPre.get(st.key), p = nx && stairPre.get(nx.key), qi = stairIn.get(st.key), pi = nx && stairIn.get(nx.key);
    if (!nx || !q?.length || p?.length !== 1 || qi!.labelled || pi!.labelled || p[0].risers <= q[0].risers) return;
    const box = (sp: StairPlan) => ({ x0: minOf(sp.holes.map(h => h.x0)), x1: maxOf(sp.holes.map(h => h.x1)), z0: minOf(sp.holes.map(h => h.z0)), z1: maxOf(sp.holes.map(h => h.z1)) });
    const A = box(q[0]), B = box(p[0]);
    if (Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) < 30 || Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0) < 30) return;
    stairPre.set(st.key, stairsOf(pi!.segs, [], st.h));
    stairPre.set(nx.key, []);
  });

  for (const st of a.storeys) {
    const plan = a.plans.find(p => p.floors.includes(st.key))!, g = geos.get(plan)!;
    const X = (x: number) => (x - g.ox - minX) * S, Z = (y: number) => (maxY - (y - g.oy)) * S;
    const H = st.h, parapet = st.key === 'RF';
    const lines = pairWalls(g.segs.filter(s => isWallLayer(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]), c: /^(?:0?S-)?(?:COL|COLUMN|COLS|柱)/i.test(s.layer) ? undefined : s.color })));
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
    const texts = d.texts.filter(t => inBox(plan.box, t.x, t.y) && /^TEXT$|ROOM|室名|空間/i.test(t.layer) && /[一-鿿]/.test(t.s) && t.s.length <= 12 && !/[0-9]{2,}|㎡|坪|高度|詳|說明|同|$^/.test(t.s))
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
    // in a balcony a double line on any layer (often the stair layer), or a short slanted pair on the wall layer, is an RC railing
    const railCand: BoxObject[] = [];
    if (!parapet) {
      const balc = notes.filter(n => /陽台|露台/.test(n.s) && n.s.length <= 8 && !/投影|面積/.test(n.s));
      const stairPairs = pairWalls(g.segs.filter(q => STAIR_LAYER.test(q.layer)).map(q => ({ x1: X(q.a[0]), z1: Z(q.a[1]), x2: X(q.b[0]), z2: Z(q.b[1]) })));
      const slanted = lines.filter(l => Math.abs(l.ax - l.bx) >= 1 && Math.abs(l.az - l.bz) >= 1);
      for (const l of [...stairPairs, ...slanted]) {
        const len = Math.hypot(l.bx - l.ax, l.bz - l.az), mx = (l.ax + l.bx) / 2, mz = (l.az + l.bz) / 2;
        if (l.single || l.t < 8 || l.t > 25 || len < 60 || len > 1200 || !balc.some(n => Math.hypot(n.x - mx, n.z - mz) < 450)) continue;
        const b = wallBox(l, H, 0);
        // already built (a slanted wall kept as a wall), or this pair found twice
        if ([...walls, ...railCand].some(o => Math.abs(o.x - b.x) < 10 && Math.abs(o.z - b.z) < 10 && Math.abs(Math.max(o.w, o.d) - Math.max(b.w, b.d)) < 30)) continue;
        railCand.push(b);
      }
    }
    const edges = parapet ? new Map<BoxObject, { kind: EdgeKind; label: string }>() : classifyEdges(walls, [...shut, ...railCand], notes, W, D, st.key.startsWith('R'));
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
    for (const b of railCand) {
      add({ ...b, layer: 'wall', y: 0, h: railing.h, name: 'RC欄杆（CAD）', color: 0xeeebe5 });
      if (!b.rot) slabEdges.push(b);
      nRails++;
    }
    // columns drawn as plain squares on a colour- or pen-named layer
    if (!parapet && a.colLayers.length) for (const p of d.polys) {
      if (!a.colLayers.includes(p.layer)) continue;
      const c = squareCol(p.pts, S);
      if (!c || !inBox(plan.box, c.x, c.y)) continue;
      const x = X(c.x), z = Z(c.y);
      if (walls.some(w => w.name === '柱' && Math.abs(w.x - x) < 5 && Math.abs(w.z - z) < 5)) continue;
      add({ layer: 'wall', name: '柱', x, z, w: Math.round(c.w), d: Math.round(c.h), y: 0, h: H, color: 0xeeebe5 });
    }
    nWalls += walls.length;
    // stairs: steps, half landings and the inner handrail; the storey above gets a hole in its slab
    const stairSegs = g.segs.filter(s => STAIR_LAYER.test(s.layer)).map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) }));
    const stairs = parapet ? [] : stairPre.get(st.key) ?? stairsOf(stairSegs, notes, H);
    for (const sp of stairs) {
      stairList.push({ from: st.key, to: a.storeys[a.storeys.indexOf(st) + 1]?.key || '', risers: sp.labelled || sp.risers });
      const r = H / sp.risers;
      // quantities follow the riser count written on the plan (上16); the drawing may leave treads out
      const N = sp.labelled || sp.risers, flights = sp.landings.length ? 2 : 1;
      const info = { risers: N, flights, width: sp.width, run: sp.run, rise: H / N, landing: sp.landings.reduce((s, t) => s + (t.x1 - t.x0) * (t.z1 - t.z0) / 1e4, 0) };
      sp.steps.forEach((t, i) => add({ layer: 'stair', name: '樓梯踏階（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: t.x1 - t.x0, d: t.z1 - t.z0, h: Math.min(t.top, r + SLAB), y: t.top - Math.min(t.top, r + SLAB), color: 0xd9d4ca, rise: r, ...(t.soffit ? { soffit: { ...t.soffit, lo: t.soffit.lo + st.base, hi: t.soffit.hi + st.base } } : {}), ...(i ? {} : { stair: info }) }));
      for (const t of sp.landings) add({ layer: 'stair', name: '樓梯平台（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: t.x1 - t.x0, d: t.z1 - t.z0, h: SLAB, y: t.top - SLAB, color: 0xd9d4ca });
      for (const t of sp.rails) add({ layer: 'rail', name: '樓梯扶手（CAD）', x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2, w: Math.max(4, t.x1 - t.x0), d: Math.max(4, t.z1 - t.z0), h: 90, y: t.top, color: 0x4b5563, rise: r });
    }
    if (!parapet) beamLines.push({ st, xs: g.gx.map(X), zs: g.gy.map(Z) });
    const holes = below;
    holesOf.set(st.key, holes);
    slabsOf.set(st.key, []);
    // indoor room names (客廳, 廚房, 臥室 …): short labels of two to five characters naming a space
    roomsOf.set(st.key, d.texts.filter(t => inBox(plan.box, t.x, t.y) && /^[一-鿿]{2,5}$/.test(t.s.trim()) && /[廳房室廚廁浴衛鋪舖間廊道梯]/.test(t.s) && !OUTDOOR.test(t.s) && !/平面圖|立面|剖面|投影|上方/.test(t.s)).map(t => ({ x: X(t.x), z: Z(t.y) })));
    outdoorOf.set(st.key, d.texts.filter(t => inBox(plan.box, t.x, t.y) && t.s.trim().length <= 8 && OUTDOOR.test(t.s) && !PLAN_NOTES.projection.test(t.s)).map(t => ({ x: X(t.x), z: Z(t.y) })));
    terraces.set(st.key, texts.filter(t => /露台|平台/.test(t.s) && !/屋突屋頂平台|上方/.test(t.s) || /屋突屋頂平台/.test(t.s)));
    below = stairs.flatMap(sp => sp.holes);
    for (const r of slabRects(walls.length ? [...walls, ...shut, ...slabEdges] : walls, texts, W, D, holes)) {
      add({ layer: 'slab', name: st.key === '1F' ? '地坪（CAD）' : st.key === 'RF' ? '屋頂板（CAD）' : '樓板（CAD）', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: SLAB, y: -SLAB, color: 0xd6d1c7 });
      slabsOf.get(st.key)!.push(r);
    }
    for (const op of openings) {
      const it = op.tag ? codes.get(op.tag)! : null;
      const door = it ? it.kind === 'door' : op.arc;
      const sill = it ? optNow.sills?.[it.code] ?? it.sill : door ? 0 : 90;
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
  const table = readSizeTable(d);
  const madeBy = new Map<ModelObject, SheetView>();
  const rcPanels: SlabPanel[] = [];
  const structViews = a.views.filter(v => v.kind === 'structure' && v.floors.length);
  const prepped = new Map<SheetView, { lines: ReturnType<typeof readBeams>; beams: ReturnType<typeof readBeams>; cols: ReturnType<typeof readColumns>; panels: ReturnType<typeof readPanels> }>();
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
    const lines = readBeams(d, v, X, Z, S, table), beams = lines.filter(b => b.mark);
    const cols = readColumns(d, v, X, Z, S), panels = readPanels(d, v, X, Z, lines, W, D);
    prepped.set(v, { lines, beams, cols, panels });
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
  const chosen = new Map<string, { v: SheetView; n: number }>();
  for (const v of structViews) if (prepped.has(v)) for (const key of v.floors) {
    const n = fit(v, key), c = chosen.get(key);
    if (!c || n > c.n) chosen.set(key, { v, n });
  }
  for (const v of structViews) {
    const pv = prepped.get(v);
    if (!pv) continue;
    const { beams, cols, panels } = pv;
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
        objects.push({ id: id++, layer: 'slab', name: `${ground ? '地梁' : '梁'} ${m.code}（結構圖）`, floor: host.key, y: top - m.h, h: m.h, color: 0xcfc9bd,
          x: (b.ax + b.bx) / 2, z: (b.az + b.bz) / 2, ...(slant ? { w: b.len, d: m.w, rot: -ang } : along ? { w: b.len, d: m.w } : { w: m.w, d: b.len }), rc: { kind: 'beam', mark: m.code, fl: key } });
        madeBy.set(objects[objects.length - 1], v);
      }
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
  // columns and walls standing on a terrace or roof deck (nothing above them) end level with the parapet round it
  const headH = parapetNote ?? a.parapet;
  a.storeys.forEach((st, i) => {
    const next = a.storeys[i + 1];
    if (!next) return;
    const cover = slabsOf.get(next.key) || [];
    for (const o of objects) {
      if (!isBox(o) || o.floor !== st.key || o.layer !== 'wall' || o.rot || o.y !== st.base || o.h < headH + 40 || o.h < st.h - 5) continue;
      if (/窗台|窗楣|門楣|隔間牆下/.test(o.name)) continue;
      const inside = (r: { x0: number; x1: number; z0: number; z1: number }) => o.x >= r.x0 - 30 && o.x <= r.x1 + 30 && o.z >= r.z0 - 30 && o.z <= r.z1 + 30;
      // a terrace's own slab: a 露台 / 平台 label inside it, the sunshade slab over it does not count as a roof
      const onTerrace = (slabsOf.get(st.key) || []).some(r => inside(r) && (terraces.get(st.key) || []).some(t => t.x >= r.x0 && t.x <= r.x1 && t.z >= r.z0 && t.z <= r.z1));
      if (!onTerrace && cover.some(inside)) continue;
      o.h = headH;
      o.name = /柱/.test(o.name) || o.rc ? o.name : `${o.name}（露台頂，同女兒牆高）`;
      cutHeads++;
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
  const spec = readRebarSpec(d, a.storeys.map(s => s.key));
  const colourLen = new Map<number, number>();
  for (const o of wallBoxes) colourLen.set(o.wc!, (colourLen.get(o.wc!) || 0) + Math.max(o.w, o.d));
  const report: BuildReport = {
    wallColours: [...colourLen].map(([color, length]) => ({ color, length: Math.round(length) })).sort((p, q) => q.length - p.length),
    projectionLabels, stairs: stairList,
    slantWalls: objects.filter(o => isBox(o) && o.layer === 'wall' && o.rot && Math.max(o.w, o.d) >= 300).length,
    unmatchedTags,
    areaChecks: areaChecks(d, a.storeys.map(st => st.key), objects),
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
    cad: { name, W, D, segs: [], texts: [], doors: [], floors, ...(spec ? { rc: { spec, panels: rcPanels } } : {}) },
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
