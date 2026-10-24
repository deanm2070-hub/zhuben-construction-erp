import { isBox, type BoxObject, type CadData, type ModelObject } from './types';

/**
 * 模板報表: one line per slab panel (the layout of a formwork report).
 *   原始模板   the soffit form, panel area
 *   封模       edge forms along the panel sides that rest on no beam, wall, column or neighbouring panel, length × slab thickness
 *   扣版牆接頭 where an RC wall runs along a panel side, length × slab thickness is taken off
 *   扣柱頭     column sections that stand inside the panel are taken off the soffit
 *   真實模板   原始 + 封模 − 扣
 * All in ㎡ with the working shown as an expression in metres.
 */
export interface FormworkRow {
  fl: string; mark: string; no: number;
  area: number; areaExpr: string;
  edge: number; edgeExpr: string;
  wall: number; wallExpr: string;
  col: number; colExpr: string;
  /** 扣接頭合計 (negative) */
  cut: number;
  real: number;
}
export interface FormworkFloor { fl: string; label: string; rows: FormworkRow[]; area: number; edge: number; wall: number; col: number; cut: number; real: number }
export interface FormworkReport { floors: FormworkFloor[]; total: Omit<FormworkFloor, 'fl' | 'label' | 'rows'>; slab: number; note: string[] }

const r2 = (v: number) => Math.round(v * 100) / 100;
const m = (cm: number) => r2(cm / 100);

interface Rect { x0: number; x1: number; z0: number; z1: number }
const rectOf = (o: BoxObject): Rect => ({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 });

/** union length of [lo,hi] intervals clipped to [a,b] */
function covered(iv: [number, number][], a: number, b: number) {
  const s = iv.map(([l, h]): [number, number] => [Math.max(a, l), Math.min(b, h)]).filter(([l, h]) => h > l).sort((p, q) => p[0] - q[0]);
  let len = 0, cur = a;
  for (const [l, h] of s) { if (h <= cur) continue; len += h - Math.max(l, cur); cur = h; }
  return len;
}

/** floor key → the label a formwork report uses: 4F → 4, R1F → R1, foundation → F */
const label = (fl: string) => fl === 'F' ? 'F' : fl.replace(/F$/, '');

export function computeFormwork(objects: ModelObject[], cad: CadData, slabT: number, floorOrder: string[]): FormworkReport | null {
  const boxes = objects.filter(isBox);
  type P = { fl: string; mark: string } & Rect;
  const panels: P[] = [];
  const spec = cad.rc?.spec;
  const tOf = (mark: string) => (spec?.slabs.find(s => s.mark === mark)?.t ?? slabT) / 100;
  if (cad.rc?.panels.length) {
    const seen = new Set<string>();
    for (const p of cad.rc.panels) {
      const isF = /^F/.test(p.mark);
      const fl = isF ? 'F' : p.fl, k = `${fl}|${Math.round(p.x0)}|${Math.round(p.x1)}|${Math.round(p.z0)}|${Math.round(p.z1)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      panels.push({ fl, mark: p.mark, x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 });
    }
  } else {
    // no structural plans: the slabs built from the architectural plans
    for (const o of boxes) if (o.layer === 'slab' && /樓板（CAD）|屋頂板（CAD）/.test(o.name) && o.floor) panels.push({ fl: o.floor, mark: 'S', ...rectOf(o) });
  }
  if (!panels.length) return null;

  const note = [
    '原始模板＝版底面積；封模＝版邊不靠梁、牆、柱或相鄰版的長度 × 版厚；扣版牆接頭＝RC 牆貼著版邊的長度 × 版厚；扣柱頭＝柱斷面落在版內的面積。',
    cad.rc?.panels.length ? '版的範圍與版厚來自結構平面圖（版編號、版厚）。' : '沒有結構平面圖，版的範圍取自建築平面圖的樓板，版厚用工程數量設定的樓板厚度。',
    '各家模板計算的扣除規則略有差異，如與你慣用的算法不同，請告訴我規則。',
  ];
  const byFl = new Map<string, P[]>();
  for (const p of panels) (byFl.get(p.fl) || byFl.set(p.fl, []).get(p.fl)!).push(p);
  const flKeys = [...byFl.keys()].sort((a, b) => (a === 'F' ? -1 : b === 'F' ? 1 : 0) || (floorOrder.indexOf(a) - floorOrder.indexOf(b)));
  const floors: FormworkFloor[] = [];
  let no = 0;
  // top storey first, foundation last, as the report is read
  for (const fl of [...flKeys].reverse()) {
    const list = byFl.get(fl)!;
    list.sort((a, b) => a.mark.localeCompare(b.mark, undefined, { numeric: true }) || b.z1 - a.z1 || a.x0 - b.x0);
    const onFl = boxes.filter(o => o.floor === fl && !o.rot);
    const beams = onFl.filter(o => o.rc?.kind === 'beam').map(rectOf);
    const cols = onFl.filter(o => o.rc?.kind === 'column').map(rectOf);
    const walls = onFl.filter(o => o.layer === 'wall' && !o.rc && Math.min(o.w, o.d) >= 15 && /RC|外牆|剪力|牆/.test(o.name) && !/輕隔間|門楣|窗|女兒牆|欄杆/.test(o.name)).map(rectOf);
    const rows: FormworkRow[] = [];
    for (const p of list) {
      const t = tOf(p.mark), isF = fl === 'F';
      const w = p.x1 - p.x0, d = p.z1 - p.z0;
      if (w < 30 || d < 30) continue;
      const area = isF ? 0 : w * d / 1e4;
      const edges: { len: number; a: number; b: number; across: number; horiz: boolean }[] = [
        { len: w, a: p.x0, b: p.x1, across: p.z0, horiz: true }, { len: w, a: p.x0, b: p.x1, across: p.z1, horiz: true },
        { len: d, a: p.z0, b: p.z1, across: p.x0, horiz: false }, { len: d, a: p.z0, b: p.z1, across: p.x1, horiz: false },
      ];
      const edgeTerms: string[] = [], wallTerms: string[] = [];
      let edge = 0, wall = 0;
      for (const e of edges) {
        const ivOf = (rs: Rect[], tol: number) => rs.filter(r => e.horiz ? r.z0 - tol <= e.across && r.z1 + tol >= e.across : r.x0 - tol <= e.across && r.x1 + tol >= e.across)
          .map((r): [number, number] => e.horiz ? [r.x0, r.x1] : [r.z0, r.z1]);
        // a neighbouring panel shares the side
        const nb = list.filter(q => q !== p).filter(q => e.horiz
          ? (Math.abs(q.z0 - e.across) < 8 || Math.abs(q.z1 - e.across) < 8)
          : (Math.abs(q.x0 - e.across) < 8 || Math.abs(q.x1 - e.across) < 8))
          .map((q): [number, number] => e.horiz ? [q.x0, q.x1] : [q.z0, q.z1]);
        const support = [...ivOf(beams, 25), ...ivOf(cols, 25), ...ivOf(walls, 25), ...nb];
        const free = isF ? e.len - covered(nb, e.a, e.b) : e.len - covered(support, e.a, e.b);
        if (free > 5) { edge += free / 100 * t; edgeTerms.push(`${m(free)}*${r2(t)}`); }
        if (!isF) {
          const wl = covered(ivOf(walls, 12), e.a, e.b);
          if (wl > 5) { wall += wl / 100 * t; wallTerms.push(`${m(wl)}*${r2(t)}`); }
        }
      }
      let col = 0;
      const colTerms: string[] = [];
      if (!isF) for (const c of cols) {
        const ox = Math.min(c.x1, p.x1) - Math.max(c.x0, p.x0), oz = Math.min(c.z1, p.z1) - Math.max(c.z0, p.z0);
        if (ox > 5 && oz > 5 && ox * oz > 400) { col += ox * oz / 1e4; colTerms.push(`${m(ox)}*${m(oz)}`); }
      }
      // a column sits on the panel corner: only the part inside counts, so a sliver is nothing
      const cut = -(r2(wall) + r2(col));
      const row: FormworkRow = {
        fl, mark: p.mark, no: 0,
        area: r2(area), areaExpr: isF ? '' : `${m(w)}*${m(d)}`,
        edge: r2(edge), edgeExpr: edgeTerms.join(' + '),
        wall: -r2(wall), wallExpr: wallTerms.join(' + '),
        col: -r2(col), colExpr: colTerms.join(' + '),
        cut: r2(cut),
        real: r2(r2(area) + r2(edge) + cut),
      };
      rows.push(row);
    }
    for (const r of rows) r.no = ++no;
    const sum = (k: 'area' | 'edge' | 'wall' | 'col' | 'cut' | 'real') => r2(rows.reduce((s, r) => s + r[k], 0));
    floors.push({ fl, label: label(fl), rows, area: sum('area'), edge: sum('edge'), wall: sum('wall'), col: sum('col'), cut: sum('cut'), real: sum('real') });
  }
  const all = (k: 'area' | 'edge' | 'wall' | 'col' | 'cut' | 'real') => r2(floors.reduce((s, f) => s + f[k], 0));
  return { floors, total: { area: all('area'), edge: all('edge'), wall: all('wall'), col: all('col'), cut: all('cut'), real: all('real') }, slab: r2(floors.filter(f => f.fl !== 'F').reduce((s, f) => s + f.area, 0)), note };
}
