import type { DxfDrawing, DxfText } from './dxf';
import { memberOf } from './pricing';
import { isBox, type Bar, type BeamCallout, type BeamDetail, type BoxObject, type CadData, type ColumnDetail, type ModelObject, type RebarSpec, type SlabDetail, type Spacing, type StairDetail } from './types';

/**
 * Rebar standards of the drawing set (S0-01 ~ S0-03, fc' = 280 kgf/cm²): #5 and smaller are SD280,
 * #6 and larger SD420. Lengths in cm, indexed by bar size.
 */
const tbl = (v: number[]) => Object.fromEntries(v.map((x, i) => [i + 3, x])) as Record<number, number>;
export const REBAR_STD = {
  fc: 280,
  /** unit weight, kg/m (S0-01) */
  kg: tbl([0.56, 0.994, 1.56, 2.25, 3.04, 3.98, 5.08, 6.39, 7.9, 9.57]),
  /** nominal diameter, cm */
  d: tbl([0.953, 1.27, 1.59, 1.91, 2.22, 2.54, 2.87, 3.22, 3.58, 3.99]),
  /** tension development length ld, top bars (a) and other bars (b), S0-02 */
  ldTop: { 2800: tbl([32, 42, 53, 63, 92, 105, 118, 133, 147, 162]), 4200: tbl([48, 63, 79, 95, 137, 157, 177, 199, 221, 243]) },
  ld: { 2800: tbl([30, 33, 41, 49, 71, 81, 91, 102, 114, 125]), 4200: tbl([37, 49, 61, 73, 106, 121, 136, 153, 170, 187]) },
  /** class B tension lap lst, top bars (c) and other bars (d); also the column lap, S0-02 */
  lstTop: { 2800: tbl([41, 55, 69, 82, 119, 136, 154, 172, 192]), 4200: tbl([62, 82, 103, 123, 178, 204, 230, 258, 287]) },
  lst: { 2800: tbl([32, 42, 53, 63, 92, 105, 118, 133, 147]), 4200: tbl([48, 63, 79, 95, 137, 157, 177, 199, 221]) },
  /** hooked bar development ldh in a seismic joint, S0-03 */
  ldh: { 2800: tbl([15, 15, 16, 20, 23, 26, 29]), 4200: tbl([15, 20, 24, 29, 34, 39, 44]) },
  /** 90° hook extension Al, S0-03 */
  hook: tbl([15, 20, 25, 31, 36, 41, 49, 55, 61, 71]),
  /** stock bar length; longer runs are lapped */
  stock: 1200,
};
export const fyOf = (s: number) => s >= 6 ? 4200 : 2800;
const S_ = REBAR_STD;
export const ldOf = (s: number, top = false) => (top ? S_.ldTop : S_.ld)[fyOf(s)][s] ?? 40 * S_.d[s];
export const lstOf = (s: number, top = false) => (top ? S_.lstTop : S_.lst)[fyOf(s)][s] ?? 50 * S_.d[s];
export const ldhOf = (s: number) => S_.ldh[fyOf(s)][s] ?? 15 * S_.d[s];
export const hookOf = (s: number) => S_.hook[s] ?? 12 * S_.d[s];
/** 135° seismic hook of stirrups and ties: 6d, at least 7.5 cm */
export const hook135 = (s: number) => Math.max(6 * (S_.d[s] || 1), 7.5);
/** non-structural wall bars by thickness, S0-07 (vertical, horizontal, layers) */
export function wallStd(t: number): { v: Spacing; h: Spacing; layers: number } {
  if (t < 14) return { v: { s: 3, at: 15 }, h: { s: 3, at: 15 }, layers: 1 };
  if (t < 17) return { v: { s: 3, at: 15 }, h: { s: 3, at: 15 }, layers: 2 };
  if (t < 22) return { v: { s: 4, at: 20 }, h: { s: 4, at: 20 }, layers: 2 };
  return { v: { s: 4, at: 15 }, h: { s: 4, at: 20 }, layers: 2 };
}

/** standard stair (no stair schedule): waist slab 15 cm, a #3@20 distribution, b #4@15 bottom, c #4@15 top */
const STD_STAIR: StairDetail = { floors: [], t: 15, a: { s: 3, at: 20 }, b: { s: 4, at: 15 }, c: { s: 4, at: 15 } };

/* ---------------- reading the detail sheets ---------------- */

const clean = (s: string) => s.replace(/%%[uUoO]/g, '').replace(/\s+/g, ' ').trim();
/** A floor token of the detail sheets as a storey key: 2 → 2F, R/R1/R1F → R1F, P/PR/PRF → the top storey. */
export function floorKey(tok: string, keys: string[]): string | null {
  const t = tok.toUpperCase().replace(/\s/g, '');
  const n = /^(\d+)F?$/.exec(t);
  if (n) return `${+n[1]}F`;
  if (/^R\d?F?$/.test(t)) { const k = t === 'R' || t === 'RF' ? 'R1F' : t.endsWith('F') ? t : `${t}F`; return keys.includes(k) ? k : keys.includes('RF') ? 'RF' : k; }
  if (/^P(R?F)?$/.test(t)) return keys.includes('RF') ? 'RF' : keys[keys.length - 1] || 'RF';
  return null;
}
/** "2~R1F", "2~5F", "1F", "PRF" as storey keys, in storey order. */
export function floorRange(tok: string, keys: string[]): string[] {
  const [a, b] = tok.split('~');
  const ka = floorKey(a, keys);
  if (!ka) return [];
  if (b === undefined) return [ka];
  const kb = floorKey(b, keys);
  const i = keys.indexOf(ka), j = kb ? keys.indexOf(kb) : -1;
  return i >= 0 && j >= i ? keys.slice(i, j + 1) : [ka];
}

const BAR = /^(\d+)-#(\d+)$/, STIR = /^(?:(\d)\*)?#(\d+)-(\d+)@(\d+)$/, WEB = /^(?:WEB\s*)?(\d+)-#(\d+)\s*\(E\.?F\.?\)$/i;
const DETAIL_NAME = /^(?:(\d+F?|R\d?F?|P(?:R?F)?)(?:~(\d+F?|R\d?F?|P(?:R?F)?))?)?(F?[GBJ]\d*[a-z]?)\((\d+)\s*[xX×]\s*(\d+)(?:\/(\d+))?\)$/;

/** Beam details (S2): each beam name sits under its drawing; callouts above the stirrup text are top bars. */
function readBeamDetails(texts: DxfText[], keys: string[]): BeamDetail[] {
  const names = texts.map(t => ({ t, m: DETAIL_NAME.exec(clean(t.s)) })).filter(q => q.m && /%%U/i.test(q.t.s))
    .map(({ t, m }) => {
      const s = clean(t.s), h = t.h || 16;
      const floors = m![1] ? floorRange(m![2] ? `${m![1]}~${m![2]}` : m![1], keys) : /^F/.test(m![3]) ? [keys[0] || '1F'] : [];
      return { t, cx: t.x + s.length * h * 0.3, y: t.y, h, mark: m![3], b: +m![4], depth: m![6] ? (+m![5] + +m![6]) / 2 : +m![5], floors };
    });
  if (!names.length) return [];
  const H = names[0].h;
  type Item = { t: DxfText; s: string };
  const owned = new Map(names.map(n => [n, [] as Item[]]));
  for (const t of texts) {
    const s = clean(t.s);
    if (!(BAR.test(s) || STIR.test(s) || WEB.test(s) || /^\d{2,3}$/.test(s) || /^(TOP|BOT|STIR\.?)\s/i.test(s))) continue;
    // the nearest row below, then the nearest name in it
    const cand = names.filter(n => t.y > n.y && t.y - n.y < 30 * H && Math.abs(t.x - n.cx) < 20 * H);
    if (!cand.length) continue;
    const row = Math.max(...cand.map(n => n.y));
    const best = cand.filter(n => Math.abs(n.y - row) < H).sort((a, b) => Math.abs(t.x - a.cx) - Math.abs(t.x - b.cx))[0];
    owned.get(best)!.push({ t, s });
  }
  const out: BeamDetail[] = [];
  for (const n of names) {
    const items = owned.get(n)!;
    const d: BeamDetail = { mark: n.mark, floors: n.floors, b: n.b, h: n.depth, top: [], bot: [], stir: [] };
    const label = (re: RegExp) => items.map(i => re.exec(i.s)).find(Boolean);
    const lt = label(/^TOP\s+(\d+)-#(\d+)$/i), lb = label(/^BOT\s+(\d+)-#(\d+)$/i), ls = label(/^STIR\.?\s*#(\d+)@(\d+)$/i);
    if (lt || lb || ls) {
      // typical section: TOP 3-#6 / STIR. #3@15 / BOT 3-#6 / WEB 5-#4(E.F.)
      if (lt) d.top.push({ n: +lt[1], s: +lt[2], r: 0.5 });
      if (lb) d.bot.push({ n: +lb[1], s: +lb[2], r: 0.5 });
      if (ls) d.stir.push({ s: +ls[1], at: +ls[2], sets: 1 });
      const w = items.map(i => /^WEB\s+(\d+)-#(\d+)/i.exec(i.s)).find(Boolean);
      if (w) d.web = { n: +w[1], s: +w[2] };
      out.push(d);
      continue;
    }
    const stirs = items.filter(i => STIR.test(i.s));
    const midY = stirs.length ? stirs.reduce((a, i) => a + i.t.y, 0) / stirs.length : n.y + 8 * H;
    for (const i of stirs) { const m = STIR.exec(i.s)!; d.stir.push({ sets: +(m[1] || 1), s: +m[2], n: +m[3], at: +m[4] }); }
    const webs = items.map(i => WEB.exec(i.s)).filter(Boolean);
    if (webs.length) d.web = { n: webs.reduce((a, m) => a + +m![1], 0), s: +webs[0]![2] };
    const bars = items.filter(i => BAR.test(i.s));
    const xs = items.filter(i => !/^\d{2,3}$/.test(i.s)).map(i => i.t.x);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), span = Math.max(1, x1 - x0);
    const dims = items.filter(i => /^\d{2,3}$/.test(i.s));
    for (const i of bars) {
      const m = BAR.exec(i.s)!, top = i.t.y > midY;
      // a cut-off length written beside the callout, on the same face
      const dim = dims.filter(o => (o.t.y > midY) === top && Math.abs(o.t.x - i.t.x) < 4 * H).sort((a, b) => Math.abs(a.t.x - i.t.x) - Math.abs(b.t.x - i.t.x))[0];
      const c: BeamCallout = { n: +m[1], s: +m[2], r: Math.round((i.t.x - x0) / span * 100) / 100, ...(dim ? { cut: +dim.s } : {}) };
      (top ? d.top : d.bot).push(c);
    }
    if (d.top.length || d.bot.length || d.stir.length) out.push(d);
  }
  return out;
}

/** Column schedule (S3): marks across, storeys down; 斷面 / 鋼筋 / 圍束區 / 中央區 / 接頭 rows. */
function readColumns(texts: DxfText[], keys: string[]): ColumnDetail[] {
  const head = texts.find(t => /^C-?NO$/i.test(clean(t.s)));
  if (!head) return [];
  const H = head.h || 9;
  const marks = texts.filter(t => /^C\d+[a-z]?$/.test(clean(t.s)) && Math.abs(t.y - head.y) < 3 * H && t.x > head.x).sort((a, b) => a.x - b.x);
  if (!marks.length) return [];
  const colW = marks.length > 1 ? (marks[marks.length - 1].x - marks[0].x) / (marks.length - 1) : 200;
  const col = (x: number) => [...marks].sort((a, b) => Math.abs(x - a.x) - Math.abs(x - b.x)).find(m => Math.abs(x - m.x) < colW * 0.75);
  const left = (t: DxfText) => Math.abs(t.x - head.x) < 3.5 * H;
  const floorsL = texts.filter(t => left(t) && t.y < head.y && floorKey(clean(t.s), keys) && /^(\d+F|R\d*F|PR?F)$/i.test(clean(t.s)));
  const labels = (re: RegExp) => texts.filter(t => left(t) && re.test(clean(t.s).replace(/\s/g, '')));
  const out: ColumnDetail[] = [];
  for (const sec of labels(/^斷面$/)) {
    const fl = floorsL.filter(f => f.y > sec.y).sort((a, b) => a.y - b.y)[0];
    if (!fl) continue;
    const below = (re: RegExp) => labels(re).filter(l => l.y < sec.y && sec.y - l.y < 8 * H).sort((a, b) => b.y - a.y)[0];
    const rBar = below(/^鋼筋$/), rows = [below(/^圍束區$/), below(/^中央區$/), below(/^接頭$/)];
    const at = (y: number | undefined) => texts.filter(t => y !== undefined && Math.abs(t.y - y) < H * 0.4 && !left(t));
    for (const m of marks) {
      const cell = (y: number | undefined) => at(y).filter(t => col(t.x) === m).sort((a, b) => a.x - b.x);
      const size = cell(sec.y).map(t => /^(\d+)\s*X\s*(\d+)$/i.exec(clean(t.s))).find(Boolean);
      if (!size) continue;
      const bars: Bar[] = cell(rBar?.y).map(t => BAR.exec(clean(t.s))).filter(Boolean).map(b => ({ n: +b![1], s: +b![2] }));
      const hoops = rows.map(r => {
        const c = cell(r?.y), sp = c.map(t => /^#(\d+)@(\d+)$/.exec(clean(t.s))).find(Boolean);
        const nums = c.filter(t => /^\d+$/.test(clean(t.s))).map(t => +clean(t.s));
        return { s: sp ? +sp[1] : 4, at: sp ? +sp[2] : 15, ties: [nums[0] || 0, nums[1] || 0] as [number, number] };
      });
      const b = Math.min(+size[1], +size[2]), h = Math.max(+size[1], +size[2]);
      out.push({ fl: floorKey(clean(fl.s), keys)!, mark: clean(m.s), b, h, bars, hoop: { s: hoops[0].s, at: [hoops[0].at, hoops[1].at, hoops[2].at], ties: hoops[0].ties } });
    }
  }
  return out;
}

/** Slab schedules (S4): 板編號 / 板厚 / 置筋方式 / 頂 底 × 短向 長向. */
function readSlabs(texts: DxfText[], keys: string[]): SlabDetail[] {
  const out: SlabDetail[] = [];
  for (const head of texts.filter(t => clean(t.s) === '板編號')) {
    const H = head.h || 10;
    const inTbl = (t: DxfText) => t.x > head.x - 6 * H && t.x < head.x + 60 * H && t.y < head.y && t.y > head.y - 120 * H;
    const rows = texts.filter(t => inTbl(t) && /^(?:([\dRP][\w~]*)\s+)?(F?C?S\d+)$/.test(clean(t.s)) && t.x < head.x + 8 * H);
    const sp = texts.filter(t => inTbl(t) && /^#\d+@\d+$/.test(clean(t.s)));
    for (const r of rows) {
      const m = /^(?:([\dRP][\w~]*)\s+)?(F?C?S\d+)$/.exec(clean(r.s))!;
      const near = rows.filter(o => o !== r).map(o => Math.abs(o.y - r.y));
      const band = Math.min(4 * H, ...near.map(v => v / 2));
      const mine = sp.filter(t => Math.abs(t.y - r.y) < band);
      if (mine.length < 4) continue;
      const ys = [...new Set(mine.map(t => Math.round(t.y)))].sort((a, b) => b - a);
      const line = (y: number) => mine.filter(t => Math.abs(t.y - y) < H / 2).sort((a, b) => a.x - b.x).map(t => { const q = /^#(\d+)@(\d+)$/.exec(clean(t.s))!; return { s: +q[1], at: +q[2] }; });
      const top = line(ys[0]), bot = line(ys[ys.length - 1]);
      if (top.length < 2 || bot.length < 2) continue;
      const rowT = texts.filter(t => inTbl(t) && Math.abs(t.y - r.y) < band);
      const t = rowT.map(t => /^(\d+)\s*cm$/i.exec(clean(t.s))).find(Boolean);
      const type = rowT.map(t => /^([A-D])\.?$/.exec(clean(t.s))).find(Boolean);
      out.push({ mark: m[2], floors: m[1] ? floorRange(m[1], keys) : [], t: t ? +t[1] : 15, type: type ? type[1] : 'C', short: [top[0], bot[0]], long: [top[1], bot[1]] });
    }
  }
  return out;
}

/** Stair schedule (S5): rows "1F(含)以下" / "2F(含)以上" with T and bars a, b, c. */
function readStairs(texts: DxfText[], keys: string[]): StairDetail[] {
  const head = texts.find(t => clean(t.s) === '樓梯配筋表');
  if (!head) return [];
  const H = head.h || 10;
  const out: StairDetail[] = [];
  for (const r of texts.filter(t => /^(\d+)F/.test(clean(t.s)) && t.y < head.y && head.y - t.y < 20 * H && Math.abs(t.x - head.x) < 15 * H)) {
    const row = texts.filter(t => Math.abs(t.y - r.y) < H * 0.6);
    const sp = row.filter(t => /^#\d+@\d+$/.test(clean(t.s))).sort((a, b) => a.x - b.x).map(t => { const q = /^#(\d+)@(\d+)$/.exec(clean(t.s))!; return { s: +q[1], at: +q[2] }; });
    if (sp.length < 3) continue;
    const k = floorKey(/^(\d+)F/.exec(clean(r.s))![1], keys)!, i = keys.indexOf(k);
    const up = row.some(t => /以上/.test(t.s)), down = row.some(t => /以下/.test(t.s));
    const floors = i < 0 ? [k] : up ? keys.slice(i) : down ? keys.slice(0, i + 1) : [k];
    const T = row.map(t => /^(\d{2})$/.exec(clean(t.s))).find(Boolean);
    out.push({ floors, t: T ? +T[1] : 15, a: sp[0], b: sp[1], c: sp[2] });
  }
  return out;
}

/** Every reinforcement schedule found in the drawing set; keys are the storeys, bottom to top. */
export function readRebarSpec(d: DxfDrawing, keys: string[]): RebarSpec | null {
  const texts = d.texts;
  const spec: RebarSpec = { beams: readBeamDetails(texts, keys), columns: readColumns(texts, keys), slabs: readSlabs(texts, keys), stairs: readStairs(texts, keys), sheets: [] };
  const ph = texts.map(t => /^#(\d+)@(\d+)\s*\(H\)$/.exec(clean(t.s))).find(Boolean), pv = texts.map(t => /^#(\d+)@(\d+)\s*\(V\)$/.exec(clean(t.s))).find(Boolean);
  if (ph && pv && texts.some(t => /女兒牆配筋/.test(t.s))) spec.parapet = { h: { s: +ph[1], at: +ph[2] }, v: { s: +pv[1], at: +pv[2] } };
  if (spec.beams.length) spec.sheets.push('梁配筋圖');
  if (spec.columns.length) spec.sheets.push('柱配筋圖');
  if (spec.slabs.some(s => /^F/.test(s.mark))) spec.sheets.push('基礎板配筋圖');
  if (spec.slabs.some(s => !/^F/.test(s.mark))) spec.sheets.push('板配筋圖');
  if (spec.stairs.length || spec.parapet) spec.sheets.push('雜項配筋圖');
  return spec.sheets.length ? spec : null;
}

/* ---------------- bar list ---------------- */

export type RebarKind = '柱' | '梁' | '版' | '基礎版' | '牆' | '樓梯';
export const REBAR_KINDS: RebarKind[] = ['柱', '梁', '版', '基礎版', '牆', '樓梯'];
/** One line of the bar list: n bars of #s, each len cm long. */
export interface RebarRow { fl: string; kind: RebarKind; mark: string; part: string; s: number; len: number; n: number; kg: number; expr: string }
/** missing: marks with no schedule on the drawings; standard: members worked out by the standard drawings and code minimums instead */
export interface RebarResult { rows: RebarRow[]; missing: string[]; standard: string[] }

const r1 = (v: number) => Math.round(v * 10) / 10;
const cm = (v: number) => String(Math.round(v));
const lapOf = (len: number, s: number, top = false) => len > S_.stock ? len * lstOf(s, top) / S_.stock : 0;
const lapTxt = (len: number, s: number, top = false) => len > S_.stock ? ` + 搭接 ${cm(lapOf(len, s, top))}（每 12m 一處 lst ${lstOf(s, top)}）` : '';

const isColumnShape = (o: BoxObject) => !o.rot && Math.min(o.w, o.d) >= 30 && Math.max(o.w, o.d) <= Math.min(o.w, o.d) * 2.5 && o.h >= 200;

/** Walls that are concrete in the takeoff: exterior walls, sills, lintels and parapets (not columns). */
export function rcWallsOf(boxes: BoxObject[]): BoxObject[] {
  const tagged = new Set(boxes.filter(o => o.rc?.kind === 'column').map(o => o.floor));
  return boxes.filter(o => o.layer === 'wall' && o.h > 0 && !o.rc && (o.wall ? o.wall === 'rc' : /外牆|窗台|窗楣|女兒牆/.test(o.name) || Math.min(o.w, o.d) >= 18)
    && (tagged.has(o.floor) || !isColumnShape(o)));
}

/**
 * Bar list of the whole building: every member from the structural plans with its schedule,
 * lengths by the standard drawings (development, laps, hooks), weights by bar size.
 */
export function computeRebar(objects: ModelObject[], cad: Pick<CadData, 'floors' | 'rc'> | null): RebarResult {
  const rows: RebarRow[] = [], missing: string[] = [], standard: string[] = [];
  // no structural drawings: every member by the standard drawings and the code minimums
  const spec: RebarSpec = cad?.rc?.spec ?? { beams: [], columns: [], slabs: [], stairs: [], sheets: [] };
  const floors = cad?.floors || [], keys = floors.map(f => f.key);
  const std = (what: string) => { if (!standard.includes(what)) standard.push(what); };
  const storey = new Map(floors.map(f => [f.key, f]));
  const boxes = objects.filter(isBox);
  // members of one kind and mark on a floor with the same bars are listed once, times the members
  const acc = new Map<string, RebarRow & { per: number; m: number }>();
  const add = (fl: string, kind: RebarKind, mark: string, part: string, s: number, len: number, per: number, expr: string, members = 1) => {
    // cut lengths are taken up to the next 5 cm (6.23 m → 6.25 m, 3.26 m → 3.30 m)
    const raw = Math.round(len * 10) / 10;
    len = Math.ceil(raw / 5 - 1e-9) * 5;
    if (per <= 0 || len <= 0) return;
    if (len !== raw) expr = `${expr}；單支 ${Math.round(raw) / 100} m 進位至 ${len / 100} m`;
    const k = [fl, kind, mark, part, s, len, per].join('|');
    const cur = acc.get(k);
    if (cur) { cur.m += members; return; }
    acc.set(k, { fl, kind, mark, part, s, len, n: 0, kg: 0, expr, per, m: members });
  };
  const near = <T extends { floors?: string[]; fl?: string }>(list: T[], fl: string): T | undefined => {
    const has = (x: T) => x.floors ? x.floors.includes(fl) : x.fl === fl;
    const hit = list.find(has);
    if (hit) return hit;
    // the nearest storey that has one
    const i = keys.indexOf(fl);
    return [...list].sort((a, b) => dist(a) - dist(b))[0];
    function dist(x: T) { const fs = x.floors ?? [x.fl!]; return Math.min(...fs.map(f => Math.abs(keys.indexOf(f) - i))); }
  };

  const ldTxt = (s: number) => `彎鉤錨定 ldh ${ldhOf(s)}+${hookOf(s)}`;
  /** a beam with no schedule: code minimum As = 14/fy·b·d top and bottom (#6), #3 stirrups @10 within 2h of each end, @d/2 between */
  function minBeam(o: BoxObject, fl: string, mark: string) {
    const b = Math.round(Math.min(o.w, o.d)), h = Math.round(o.h), L = Math.max(o.w, o.d), d = h - 6;
    if (b < 10 || h < 20) return;
    std(`梁 ${mark}`);
    const As = 14 / 4200 * b * d, n = Math.max(2, Math.ceil(As / 2.87)), a = ldhOf(6) + hookOf(6), lap = lapOf(L + 2 * a, 6);
    const W = `${fl} ${mark}（${b}×${h}，梁長 ${cm(L)}，無梁配筋圖：規範最少配筋）`;
    for (const face of ['上層', '下層'])
      add(fl, '梁', mark, `${face}主筋 通長`, 6, L + 2 * a + lap, n, `${W}：As,min = 14/fy × b × d = 14/4200 × ${b} × ${d} = ${r1(As)} cm² → ${n}-#6；梁長 ${cm(L)} + 兩端 ${ldTxt(6)}${lapTxt(L + 2 * a, 6, face === '上層')}`);
    const end = Math.min(2 * h, L / 2), mid = Math.min(20, Math.floor(d / 2)), nEnd = 2 * Math.ceil(end / 10), nMid = Math.max(0, Math.ceil((L - 2 * end) / mid) - 1);
    add(fl, '梁', mark, '箍筋', 3, 2 * (b - 8) + 2 * (h - 8) + 2 * hook135(3), nEnd + nMid, `${W}：2×(${b}−8) + 2×(${h}−8) + 135°彎鉤 2×${r1(hook135(3))}；兩端 2h = ${cm(end)} 內 @10 共 ${nEnd} + 中央 @${mid}（d/2）共 ${nMid}`);
  }
  /** a column with no schedule: code minimum 1% of the section (#7, even count, at least 4), #4 hoops @10 at the ends, @15 between */
  function minColumn(o: BoxObject, fl: string, mark: string) {
    const b = Math.round(Math.min(o.w, o.d)), hh = Math.round(Math.max(o.w, o.d)), st = storey.get(fl), H = st?.h || o.h;
    if (b < 20) return;
    std(`柱 ${mark}`);
    const As = 0.01 * b * hh, n = Math.max(4, 2 * Math.ceil(As / 3.87 / 2)), i = keys.indexOf(fl), foot = i <= 0 ? ldhOf(7) + hookOf(7) : 0;
    const W = `${fl} ${mark}（${b}×${hh}，層高 ${cm(H)}，無柱配筋圖：規範最少配筋）`;
    add(fl, '柱', mark, '主筋', 7, H + lstOf(7) / 2 + foot, n, `${W}：ρmin 1% × ${b} × ${hh} = ${r1(As)} cm² → ${n}-#7；層高 ${cm(H)} + 搭接 lst ${lstOf(7)}÷2${foot ? ` + 基礎錨定 ${ldhOf(7)}+${hookOf(7)}` : ''}`);
    const Hn = Math.max(100, H - 60), lo = Math.max(hh, Hn / 6, 45), sets = 2 * Math.ceil(lo / 10) + Math.max(0, Math.ceil((Hn - 2 * lo) / 15) - 1) + Math.ceil(60 / 10);
    add(fl, '柱', mark, '箍筋', 4, 2 * (b - 8) + 2 * (hh - 8) + 2 * hook135(4), sets, `${W}：2×(${b}−8) + 2×(${hh}−8) + 2×${r1(hook135(4))}；圍束區 2×${cm(lo)} @10 + 中央 @15 + 梁柱接頭 60 @10，共 ${sets} 組`);
  }
  /** a slab with no schedule: the standard slab bars, top and bottom both ways (#4@20; foundation slabs #5@20) */
  function stdSlab(fl: string, kind: RebarKind, mark: string, lx: number, lz: number, t?: number) {
    if (lx < 30 || lz < 30) return;
    std(kind === '基礎版' ? '基礎版' : `樓板 ${fl}`);
    const s = kind === '基礎版' ? 5 : 4, at = 20, Ls = Math.min(lx, lz), Ll = Math.max(lx, lz);
    const W = `${fl} ${mark}（${cm(Ls)}×${cm(Ll)}${t ? `，厚 ${cm(t)}` : ''}，無版配筋圖：標準雙層雙向 #${s}@${at}）`;
    for (const face of ['頂層', '底層']) {
      add(fl, kind, mark, `${face}短向筋`, s, Ls + 2 * hookOf(s) + lapOf(Ls, s), Math.floor(Ll / at) + 1, `${W}：短跨 ${cm(Ls)} + 兩端彎鉤 2×${hookOf(s)}${lapTxt(Ls, s)}；長跨 ${cm(Ll)} ÷ @${at} + 1`);
      add(fl, kind, mark, `${face}長向筋`, s, Ll + 2 * hookOf(s) + lapOf(Ll, s), Math.floor(Ls / at) + 1, `${W}：長跨 ${cm(Ll)} + 兩端彎鉤 2×${hookOf(s)}${lapTxt(Ll, s)}；短跨 ${cm(Ls)} ÷ @${at} + 1`);
    }
  }

  /* beams */
  const beams = boxes.filter(o => o.rc?.kind === 'beam');
  // beams the plans only estimate (no structural plan for that storey): code minimum bars
  const rcBeamFl = new Set(beams.map(o => o.rc!.fl));
  for (const o of boxes) if (!o.rc && memberOf(o) === '梁' && !rcBeamFl.has(o.floor || '1F')) minBeam(o, o.floor || '1F', /^地梁/.test(o.name) ? '地梁' : '梁');
  for (const o of beams) {
    const { mark, fl } = o.rc!;
    const cands = spec.beams.filter(b => b.mark === mark);
    const det = near(cands, fl);
    if (!det) { if (!missing.includes(`梁 ${mark}`)) missing.push(`梁 ${mark}`); minBeam(o, fl, mark); continue; }
    const borrowed = !det.floors.includes(fl) ? `（${fl} 無此梁配筋，依 ${det.floors.join('、')}）` : '';
    const along = o.w >= o.d, L = along ? o.w : o.d;
    // each end: a beam carrying on past the column means the bars run through, else they hook into it
    const ends = [-1, 1].map(sgn => {
      const ex = o.x + (along ? sgn * L / 2 : 0), ez = o.z + (along ? 0 : sgn * L / 2);
      let gap = Infinity;
      for (const p of beams) {
        if (p === o || p.rc!.fl !== fl || (p.w >= p.d) !== along) continue;
        const off = along ? Math.abs(p.z - o.z) : Math.abs(p.x - o.x);
        if (off > 20) continue;
        const pl = along ? p.w : p.d, pc = along ? p.x : p.z, c = along ? ex : ez;
        const g = sgn > 0 ? (pc - pl / 2) - c : c - (pc + pl / 2);
        if (g > -5 && g < 150) gap = Math.min(gap, Math.max(0, g));
      }
      return gap;
    });
    const anch = (s: number) => ends.map(g => isFinite(g) ? g / 2 : ldhOf(s) + hookOf(s));
    const anchTxt = (s: number) => ends.map(g => !isFinite(g) ? `彎鉤錨定 ldh ${ldhOf(s)}+${hookOf(s)}` : g < 10 ? '與鄰跨連續 0' : `穿柱 ${cm(g / 2)}`).join('、');
    const W = `${fl} ${mark}（${det.b}×${det.h}，梁長 ${cm(L)}）${borrowed}`;
    for (const [face, list] of [['上層', det.top], ['下層', det.bot]] as const) {
      const top = face === '上層';
      // positions along the span; layers drawn one over the other add up
      const pos: { r: number; bars: Map<number, number>; cut?: number }[] = [];
      for (const c of list) {
        let p = pos.find(q => Math.abs(q.r - c.r) < 0.08);
        if (!p) pos.push(p = { r: c.r, bars: new Map() });
        p.bars.set(c.s, (p.bars.get(c.s) || 0) + c.n);
        if (c.cut) p.cut = c.cut;
      }
      const sizes = [...new Set(list.map(c => c.s))];
      for (const s of sizes) {
        const cont = Math.min(...pos.map(p => p.bars.get(s) || 0));
        const [a1, a2] = anch(s), lap = lapOf(L + a1 + a2, s, top);
        if (cont > 0) add(fl, '梁', mark, `${face}主筋 通長`, s, L + a1 + a2 + lap, cont, `${W}：梁長 ${cm(L)} + 兩端 ${anchTxt(s)}${lapTxt(L + a1 + a2, s, top)}`);
        for (const p of pos) {
          const extra = (p.bars.get(s) || 0) - cont;
          if (extra <= 0) continue;
          const end = p.r < 0.3 || p.r > 0.7, a = (a1 + a2) / 2;
          if (end) {
            const cut = Math.max(p.cut || 0, 0.3 * L, ldOf(s, top));
            add(fl, '梁', mark, `${face}端部補強筋`, s, cut + a, extra, `${W}：伸入梁內 max(圖示 ${p.cut ?? '—'}, 0.3 Ln ${cm(0.3 * L)}, ld ${ldOf(s, top)}) = ${cm(cut)} + 支承端錨定 ${cm(a)}`);
          } else add(fl, '梁', mark, `${face}中央補強筋`, s, (top ? 0.5 : 0.75) * L, extra, `${W}：${top ? '0.5' : '0.75'} × 梁長 ${cm(L)}（兩端各留 ${top ? '0.25' : '0.125'} Ln）`);
        }
      }
    }
    if (det.web) {
      const s = det.web.s, [a1, a2] = [ldOf(s), ldOf(s)];
      add(fl, '梁', mark, '腰筋（雙面）', s, L + a1 + a2 + lapOf(L, s), det.web.n * 2, `${W}：梁長 ${cm(L)} + 兩端 ld ${ldOf(s)}${lapTxt(L + a1 + a2, s)}；每面 ${det.web.n} 支 × 2 面`);
    }
    const counted = det.stir.filter(z => z.n), drawn = counted.reduce((a, z) => a + z.n! * z.at, 0);
    for (const s of [...new Set(det.stir.map(z => z.s))]) {
      const zones = det.stir.filter(z => z.s === s);
      const len = 2 * (det.b - 8) + 2 * (det.h - 8) + 2 * hook135(s);
      let n: number, how: string;
      if (counted.length && drawn > 0) {
        const N = zones.reduce((a, z) => a + (z.n || 0) * z.sets, 0), k = Math.abs(L - drawn) / drawn < 0.1 ? 1 : L / drawn;
        n = Math.max(2, Math.round(N * k));
        how = `圖示 ${zones.map(z => `${z.sets > 1 ? `${z.sets}×` : ''}${z.n}@${z.at}`).join(' + ')}${k === 1 ? '' : ` × 梁長比 ${cm(L)}/${cm(drawn)}`}`;
      } else {
        const z = zones[0]; n = (Math.ceil(L / z.at) + 1) * z.sets; how = `梁長 ${cm(L)} ÷ @${z.at} + 1`;
      }
      add(fl, '梁', mark, '箍筋', s, len, n, `${W}：2×(${det.b}−8) + 2×(${det.h}−8) + 135°彎鉤 2×${r1(hook135(s))}；${how}`);
    }
  }

  /* columns */
  const cols = boxes.filter(o => o.rc?.kind === 'column');
  const rcColFl = new Set(cols.map(o => o.rc!.fl));
  for (const o of boxes) if (!o.rc && memberOf(o) === '柱' && !rcColFl.has(o.floor || '1F')) minColumn(o, o.floor || '1F', '柱');
  for (const o of cols) {
    const { mark, fl } = o.rc!;
    const det = spec.columns.find(c => c.fl === fl && c.mark === mark) ?? near(spec.columns.filter(c => c.mark === mark), fl);
    if (!det) { if (!missing.includes(`柱 ${mark}`)) missing.push(`柱 ${mark}`); minColumn(o, fl, mark); continue; }
    const st = storey.get(fl), h = st?.h || o.h;
    const i = keys.indexOf(fl), up = keys[i + 1];
    const hb = Math.max(0, ...beams.filter(b => b.rc!.fl === up).map(b => b.h)) || 60;
    const topEnd = !spec.columns.some(c => c.fl === up && c.mark === mark) && !cols.some(c => c.rc!.fl === up && c.rc!.mark === mark);
    const W = `${fl} ${mark}（${det.b}×${det.h}，層高 ${cm(h)}）${det.fl !== fl ? `（依 ${det.fl} 配筋）` : ''}`;
    for (const b of det.bars) {
      const s = b.s, lap = lstOf(s) / 2, foot = i === 0 ? ldhOf(s) + hookOf(s) : 0, head = topEnd ? hb - 8 + hookOf(s) : 0;
      add(fl, '柱', mark, '主筋', s, h + lap + foot + head, b.n,
        `${W}：層高 ${cm(h)} + 搭接 lst ${lstOf(s)}÷2（隔層錯開搭接）${foot ? ` + 基礎錨定 ${ldhOf(s)}+${hookOf(s)}` : ''}${head ? ` + 柱頂彎入梁 ${cm(hb - 8)}+${hookOf(s)}` : ''}`);
    }
    const s = det.hoop.s, [s1, s2, s3] = det.hoop.at, Hn = Math.max(100, h - hb);
    const lo = Math.max(det.h, Hn / 6, 45), nConf = 2 * Math.ceil(lo / s1), nMid = Math.max(0, Math.ceil((Hn - 2 * lo) / s2) - 1), nJ = Math.ceil(hb / s3);
    const sets = nConf + nMid + nJ;
    const how = `圍束區 2×${cm(lo)}÷${s1} = ${nConf} + 中央區 ${cm(Hn - 2 * lo)}÷${s2} = ${nMid} + 接頭 ${cm(hb)}÷${s3} = ${nJ}（淨高 ${cm(Hn)}，lo = max(${det.h}, Hn/6, 45)）`;
    add(fl, '柱', mark, '箍筋', s, 2 * (det.b - 8) + 2 * (det.h - 8) + 2 * hook135(s), sets, `${W}：2×(${det.b}−8) + 2×(${det.h}−8) + 2×${r1(hook135(s))}；${how}`);
    const [tx, ty] = det.hoop.ties;
    if (tx) add(fl, '柱', mark, '繫筋（短向）', s, det.b - 8 + 2 * hook135(s), tx * sets, `${W}：${det.b}−8 + 2×${r1(hook135(s))}；每組 ${tx} 支 × ${sets} 組`);
    if (ty) add(fl, '柱', mark, '繫筋（長向）', s, det.h - 8 + 2 * hook135(s), ty * sets, `${W}：${det.h}−8 + 2×${r1(hook135(s))}；每組 ${ty} 支 × ${sets} 組`);
  }

  /* slabs and foundation slabs */
  for (const p of cad?.rc?.panels || []) {
    const det = spec.slabs.find(s => s.mark === p.mark && (s.floors.includes(p.fl) || !s.floors.length)) ?? near(spec.slabs.filter(s => s.mark === p.mark && s.floors.length), p.fl);
    if (!det) { if (!missing.includes(`版 ${p.mark}`)) missing.push(`版 ${p.mark}`); stdSlab(p.fl, /^F/.test(p.mark) ? '基礎版' : '版', p.mark, p.x1 - p.x0, p.z1 - p.z0); continue; }
    const lx = p.x1 - p.x0, lz = p.z1 - p.z0, Ls = Math.min(lx, lz), Ll = Math.max(lx, lz);
    const kind: RebarKind = /^F/.test(p.mark) ? '基礎版' : '版';
    const W = `${p.fl} ${p.mark}（厚 ${det.t}，${cm(Ls)}×${cm(Ll)} 梁心距）`;
    det.short.forEach((sp, j) => {
      const face = j ? '底層' : '頂層';
      add(p.fl, kind, p.mark, `${face}短向筋`, sp.s, Ls + lapOf(Ls, sp.s, !j), Math.floor(Ll / sp.at) + 1, `${W}：短跨 ${cm(Ls)}${lapTxt(Ls, sp.s, !j)}；長跨 ${cm(Ll)} ÷ @${sp.at} + 1`);
    });
    det.long.forEach((sp, j) => {
      const face = j ? '底層' : '頂層';
      add(p.fl, kind, p.mark, `${face}長向筋`, sp.s, Ll + lapOf(Ll, sp.s, !j), Math.floor(Ls / sp.at) + 1, `${W}：長跨 ${cm(Ll)}${lapTxt(Ll, sp.s, !j)}；短跨 ${cm(Ls)} ÷ @${sp.at} + 1`);
    });
  }

  // slabs of storeys with no slab plan: the standard slab bars on each slab of the model
  const panelFl = new Set((cad?.rc?.panels || []).map(p => `${p.fl}|${/^F/.test(p.mark) ? 'F' : 'S'}`));
  for (const o of boxes) {
    const m = memberOf(o), fl = o.floor || '1F';
    if (o.rc || o.rot || o.layer !== 'slab' || o.h < 8 || (m !== '樓板' && m !== '基礎')) continue;
    const kind: RebarKind = m === '基礎' ? '基礎版' : '版';
    if (panelFl.has(`${fl}|${kind === '基礎版' ? 'F' : 'S'}`)) continue;
    stdSlab(fl, kind, o.name.replace(/（.*$/, '') || '樓板', o.w, o.d, o.h);
  }

  /* walls: grouped per floor, thickness and height */
  const walls = new Map<string, BoxObject[]>();
  for (const o of rcWallsOf(boxes)) {
    const t = Math.round(Math.min(o.w, o.d)), para = /女兒牆/.test(o.name);
    const k = `${o.floor || ''}|${para ? '女兒牆' : /窗台|窗楣|門楣/.test(o.name) ? '窗台窗楣' : 'RC牆'}|${t}|${Math.round(o.h)}`;
    if (!walls.has(k)) walls.set(k, []);
    walls.get(k)!.push(o);
  }
  for (const [k, list] of walls) {
    const [fl, name, ts, hs] = k.split('|'), t = +ts, h = +hs;
    const std = name === '女兒牆' && spec.parapet ? { ...spec.parapet, layers: t >= 15 ? 2 : 1 } : wallStd(t);
    const src = name === '女兒牆' && spec.parapet ? '女兒牆配筋圖' : 'S0-07 牆配筋標準';
    const L = list.reduce((a, o) => a + Math.max(o.w, o.d), 0);
    const W = `${fl} ${name} 厚${t} 高${h}（${list.length} 段，合計長 ${cm(L)}，${src} ${std.layers === 2 ? '雙層' : '單層'}）`;
    const nv = list.reduce((a, o) => a + Math.floor(Math.max(o.w, o.d) / std.v.at) + 1, 0) * std.layers;
    add(fl, '牆', `${name} t${t}`, '垂直筋', std.v.s, h + lstOf(std.v.s), nv, `${W}：高 ${h} + 搭接 lst ${lstOf(std.v.s)}；Σ(段長 ÷ @${std.v.at} + 1) × ${std.layers} 層`);
    const nh = (Math.floor(h / std.h.at) + 1) * std.layers;
    add(fl, '牆', `${name} t${t}`, '水平筋（各段合計長）', std.h.s, L + list.length * 2 * ldOf(std.h.s), nh, `${W}：各段長合計 ${cm(L)} + 每段兩端錨定 2×ld ${ldOf(std.h.s)} × ${list.length} 段；高 ${h} ÷ @${std.h.at} + 1 = ${nh / std.layers} 道 × ${std.layers} 層`);
  }

  /* stairs */
  for (const o of boxes.filter(o => o.stair)) {
    const fl = o.floor || '1F', det = near(spec.stairs, fl) ?? (std('樓梯'), STD_STAIR);
    const { risers: N, flights: F, width: w, run, rise } = o.stair!;
    const treads = Math.max(0, N - F), flight = treads / F * Math.hypot(run, rise);
    const W = `${fl} 樓梯（${F} 跑，寬 ${cm(w)}，斜長 ${cm(flight)}，厚 ${det.t}${det === STD_STAIR ? '，無樓梯配筋圖：標準樓梯配筋' : ''}）`;
    for (const [part, sp] of [['底層主筋 b', det.b], ['頂層主筋 c', det.c]] as const)
      add(fl, '樓梯', '樓梯', part, sp.s, flight + 2 * ldOf(sp.s), (Math.floor(w / sp.at) + 1) * F, `${W}：斜長 ${cm(flight)} + 兩端 ld ${ldOf(sp.s)}；寬 ${cm(w)} ÷ @${sp.at} + 1，× ${F} 跑`);
    add(fl, '樓梯', '樓梯', '分佈筋 a（上下層）', det.a.s, w - 8, (Math.floor(flight / det.a.at) + 1) * 2 * F, `${W}：寬 ${cm(w)} − 8；斜長 ÷ @${det.a.at} + 1，上下 2 層 × ${F} 跑`);
  }

  for (const r of acc.values()) {
    const n = r.per * r.m;
    rows.push({ fl: r.fl, kind: r.kind, mark: r.mark, part: r.part, s: r.s, len: r.len, n, kg: Math.round(r.len / 100 * n * S_.kg[r.s] * 10) / 10,
      expr: `${r.expr}${r.m > 1 ? `；每${r.kind === '版' || r.kind === '基礎版' ? '版' : r.kind === '柱' ? '柱' : r.kind === '梁' ? '梁' : '組'} ${r.per} 支 × ${r.m} ${r.kind === '牆' || r.kind === '樓梯' ? '組' : '處'}` : ''}` });
  }
  const order = new Map(keys.map((k, i) => [k, i])), ko = new Map(REBAR_KINDS.map((k, i) => [k, i]));
  rows.sort((a, b) => (order.get(a.fl) ?? 99) - (order.get(b.fl) ?? 99) || ko.get(a.kind)! - ko.get(b.kind)! || a.mark.localeCompare(b.mark, undefined, { numeric: true }) || a.part.localeCompare(b.part) || b.s - a.s);
  return { rows, missing, standard };
}

/** Weight per floor and member kind, and per bar size, kg. */
export function rebarSummary(rows: RebarRow[]) {
  const byFloor = new Map<string, Record<RebarKind | '合計', number>>();
  const bySize = new Map<number, { len: number; kg: number }>();
  for (const r of rows) {
    if (!byFloor.has(r.fl)) byFloor.set(r.fl, { 柱: 0, 梁: 0, 版: 0, 基礎版: 0, 牆: 0, 樓梯: 0, 合計: 0 });
    const f = byFloor.get(r.fl)!;
    f[r.kind] += r.kg; f.合計 += r.kg;
    const z = bySize.get(r.s) || { len: 0, kg: 0 };
    z.len += r.len * r.n / 100; z.kg += r.kg;
    bySize.set(r.s, z);
  }
  return { byFloor, bySize: [...bySize.entries()].sort((a, b) => a[0] - b[0]) };
}
