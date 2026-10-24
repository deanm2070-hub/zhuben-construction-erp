import { memberOf } from './pricing';
import { isBox, type BoxObject, type CadFloor, type ModelObject } from './types';

/**
 * Something about the model that a builder would question: a column with nothing on top, a beam ending in mid-air,
 * a beam marked on the structural plan that was not built … Listed after the import and in the 3D page, each with
 * the parts it is about, so the person can jump there and judge.
 */
export interface Issue {
  /** short code of the rule (COL-TOP, BEAM-END, MARK-BEAM …) */
  kind: string;
  /** warn: looks wrong; info: worth a look, often right; fixed: the software already filled it in */
  sev: 'warn' | 'info' | 'fixed';
  floor?: string;
  text: string;
  /** parts concerned (first one is where to jump) */
  ids?: number[];
  /** where it is, model cm, when no part marks the spot (a mark on the drawing with nothing built) */
  at?: [number, number];
}

type Rect = { x0: number; x1: number; z0: number; z1: number };
const rect = (o: BoxObject): Rect => {
  const c = Math.abs(Math.cos(o.rot || 0)), s = Math.abs(Math.sin(o.rot || 0));
  const hw = (o.w * c + o.d * s) / 2, hd = (o.w * s + o.d * c) / 2;
  return { x0: o.x - hw, x1: o.x + hw, z0: o.z - hd, z1: o.z + hd };
};
const overlap = (p: Rect, q: Rect, m = 0) => Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) + m) * Math.max(0, Math.min(p.z1, q.z1) - Math.max(p.z0, q.z0) + m);
const touches = (p: Rect, q: Rect, m = 0) => p.x0 < q.x1 + m && q.x0 < p.x1 + m && p.z0 < q.z1 + m && q.z0 < p.z1 + m;
const area = (r: Rect) => (r.x1 - r.x0) * (r.z1 - r.z0);
const where = (o: BoxObject) => `${Math.round(o.x)},${Math.round(o.z)}`;
const sizeOf = (o: BoxObject) => `${Math.round(Math.min(o.w, o.d))}×${Math.round(Math.max(o.w, o.d))}`;

/** the two end rectangles of a beam, each a short slice just beyond the end */
function beamEnds(o: BoxObject, len = 15): [Rect, Rect] {
  const r = o.rot || 0, along = o.w >= o.d, L = Math.max(o.w, o.d) / 2, t = Math.min(o.w, o.d) / 2;
  const ux = Math.cos(r) * (along ? 1 : 0) + Math.sin(r) * (along ? 0 : 1), uz = -Math.sin(r) * (along ? 1 : 0) + Math.cos(r) * (along ? 0 : 1);
  const end = (s: number): Rect => {
    const cx = o.x + ux * s * (L - len / 2), cz = o.z + uz * s * (L - len / 2);
    const hw = Math.abs(ux) * len / 2 + Math.abs(uz) * t, hd = Math.abs(uz) * len / 2 + Math.abs(ux) * t;
    return { x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd };
  };
  return [end(-1), end(1)];
}


/** an open run along the edge of a floor plate: nothing stands on it and there is open air beyond */
export interface OpenEdge { floor: string; alongX: boolean; at: number; lo: number; hi: number; out: 1 | -1; top: number; /** the plate the edge belongs to */ plate: BoxObject }

const PLATE = (o: BoxObject) => o.layer === 'slab' && !o.rot && /板|地坪/.test(o.name) && !/梁|屋簷|雨遮|冷氣|外挑|裝飾|墊層|PC/.test(o.name);

/**
 * Walls run along at least two sides of the plate (30% of each side's length, within 40 cm): the plate is the roof
 * over a room, not a slab standing on its own (a canopy, a tank stand).
 */
export function wallsOnTwoSides(p: BoxObject, walls: BoxObject[]): boolean {
  const r = rect(p);
  const along = (x0: number, x1: number, z: number, ax: boolean) => {
    let cov = 0;
    for (const o of walls) {
      if (o.rot) continue;
      const ox0 = ax ? o.x - o.w / 2 : o.z - o.d / 2, ox1 = ax ? o.x + o.w / 2 : o.z + o.d / 2, oz = ax ? o.z : o.x, t = (ax ? o.d : o.w) / 2;
      if (Math.abs(oz - z) <= t + 40) cov += Math.max(0, Math.min(x1, ox1) - Math.max(x0, ox0));
    }
    return cov >= (x1 - x0) * 0.3;
  };
  return [along(r.x0, r.x1, r.z0, true), along(r.x0, r.x1, r.z1, true), along(r.z0, r.z1, r.x0, false), along(r.z0, r.z1, r.x1, false)].filter(Boolean).length >= 2;
}

/**
 * Edges of the floor plates above ground that nothing closes: no wall, railing, parapet, window or column stands on
 * them, no plate of the same level continues past them, and no stair runs through the opening beyond. A floor above
 * makes no difference: a balcony under a balcony needs its railing as much. A person could walk off such an edge, so
 * a building has a parapet or railing there.
 */
export function openSlabEdges(objects: ModelObject[], floor: string): OpenEdge[] {
  const boxes = objects.filter(isBox);
  const plates = boxes.filter(o => o.floor === floor && PLATE(o) && o.y + o.h >= 100);
  if (!plates.length) return [];
  const allPlates = boxes.filter(PLATE);
  const stairs = boxes.filter(o => o.stair || o.layer === 'stair' || /踏階|樓梯/.test(o.name)).map(rect);
  const doors = objects.filter(o => !isBox(o) && o.floor === floor) as { axis: 'x' | 'z'; at: number; a: number; b: number }[];
  const out: OpenEdge[] = [];
  for (const p of plates) {
    const top = p.y + p.h, r = rect(p);
    // what stands on this level: rises at least 25 cm above the plate (a 30 cm curb counts)
    const standing = boxes.filter(o => o.layer !== 'slab' && o.y < top + 30 && o.y + o.h > top + 25 && !o.stair && o.layer !== 'stair').map(o => ({ r: rect(o), o }));
    const level = allPlates.filter(q => q !== p && Math.abs(q.y + q.h - top) <= 30).map(rect);
    const inR = (x: number, z: number, q: Rect, m = 0) => x > q.x0 - m && x < q.x1 + m && z > q.z0 - m && z < q.z1 + m;
    for (const side of ['x0', 'x1', 'z0', 'z1'] as const) {
      const alongX = side[0] === 'z', at = r[side], dir: 1 | -1 = side.endsWith('0') ? -1 : 1, lo = alongX ? r.x0 : r.z0, hi = alongX ? r.x1 : r.z1;
      const free: number[] = [];
      for (let u = lo + 5; u < hi; u += 10) {
        const ex = alongX ? u : at, ez = alongX ? at : u, ox = alongX ? u : at + dir * 15, oz = alongX ? at + dir * 15 : u;
        if (level.some(q => [5, 15, 40, 65].some(g => inR(alongX ? u : at + dir * g, alongX ? at + dir * g : u, q)))) continue; // the plate goes on (a thin strip, or a slit between two pieces)
        if (stairs.some(q => inR(ox, oz, q, 30))) continue;                // the stair opening
        if (standing.some(s => inR(ex, ez, s.r, 25))) continue;            // a wall, railing, parapet or column on the edge
        if (doors.some(d => (d.axis === 'x') === alongX && Math.abs(d.at - at) <= 25 && u >= d.a - 5 && u <= d.b + 5)) continue;
        free.push(u);
      }
      for (let i = 0; i < free.length;) {
        let j = i;
        while (j + 1 < free.length && free[j + 1] - free[j] < 15) j++;
        if (free[j] - free[i] + 10 >= 60) out.push({ floor, alongX, at, lo: free[i] - 5, hi: free[j] + 5, out: dir, top, plate: p });
        i = j + 1;
      }
    }
  }
  return out;
}

/**
 * Checks the built model for things that do not add up structurally. Pure geometry: it needs no drawing, so it can
 * run again after the person edits the model.
 */
export function checkModel(objects: ModelObject[], floors: CadFloor[] | undefined): Issue[] {
  const out: Issue[] = [];
  const boxes = objects.filter(isBox);
  if (!boxes.length) return out;
  const F = (floors || []).slice().sort((p, q) => p.y - q.y);
  const below = (key: string | undefined) => { const i = F.findIndex(f => f.key === key); return i > 0 ? F[i - 1].key : null; };
  const above = (key: string | undefined) => { const i = F.findIndex(f => f.key === key); return i >= 0 && i < F.length - 1 ? F[i + 1].key : null; };
  const lowest = F[0]?.key;
  const member = new Map<BoxObject, string>();
  for (const o of boxes) member.set(o, memberOf(o));
  const R = new Map<BoxObject, Rect>();
  const rc = (o: BoxObject) => { let r = R.get(o); if (!r) { r = rect(o); R.set(o, r); } return r; };
  const byFloor = new Map<string, BoxObject[]>();
  for (const o of boxes) { const k = o.floor || ''; if (!byFloor.has(k)) byFloor.set(k, []); byFloor.get(k)!.push(o); }
  const on = (k: string | null | undefined) => (k && byFloor.get(k)) || [];
  const cols = boxes.filter(o => member.get(o) === '柱');
  const beams = boxes.filter(o => member.get(o) === '梁' || (member.get(o) === '基礎' && /梁/.test(o.name)));
  const solid = (o: BoxObject) => { const m = member.get(o); return m === '柱' || m === '梁' || m === '基礎' || m === '樓板' || (m === '牆' && Math.min(o.w, o.d) >= 10 && o.h >= 100); };
  const top = (o: BoxObject) => o.y + o.h;

  // 1. a column must carry something: a beam, a slab or a wall / column starting at its top
  for (const c of cols) {
    const r = rc(c), t = top(c);
    const carried = [...on(c.floor), ...on(above(c.floor))].some(o => o !== c && solid(o) && touches(rc(o), r, 2) && o.y <= t + 15 && top(o) >= t - 15 && (member.get(o) !== '牆' || o.y >= t - 15));
    if (carried) continue;
    // on the top storey a column the structural plan does not know is often a decorative post or a parapet pier
    const deco = !c.rc && (c.h < 200 || !above(c.floor));
    out.push({ kind: 'COL-TOP', sev: deco ? 'info' : 'warn', floor: c.floor, ids: [c.id], text: `柱頂沒有梁、樓板或上層構件：${c.name}（${sizeOf(c)}，${where(c)}）${deco ? '。頂層建築圖的柱，可能是裝飾柱或女兒牆柱' : '。可能這層的結構圖沒讀到梁，或柱高不對'}` });
  }
  // 2. a column above the ground storey must stand on something
  for (const c of cols) {
    if (!c.floor || c.floor === lowest || c.y <= 0) continue;
    const r = rc(c), b = below(c.floor);
    const stands = [...on(b), ...on(c.floor)].some(o => o !== c && solid(o) && overlap(rc(o), r, 4) > 0 && Math.abs(top(o) - c.y) <= 20);
    if (!stands) out.push({ kind: 'COL-FLOAT', sev: 'warn', floor: c.floor, ids: [c.id], text: `柱下方沒有柱、牆或梁（懸空柱）：${c.name}（${sizeOf(c)}，${where(c)}）` });
  }
  // 3. two columns on top of each other on the same floor (the same column read twice from two drawings)
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
    const p = cols[i], q = cols[j];
    if (p.floor !== q.floor || Math.abs(p.y - q.y) > 30) continue;
    const ov = overlap(rc(p), rc(q));
    if (ov > 0.4 * Math.min(area(rc(p)), area(rc(q)))) out.push({ kind: 'COL-DUP', sev: 'warn', floor: p.floor, ids: [p.id, q.id], text: `兩根柱重疊（多了一根柱）：${p.name} ${sizeOf(p)} 與 ${q.name} ${sizeOf(q)}，${where(p)}` });
  }
  // 4. the column above is a different size from the one below (set out that way on purpose, or one of them read wrong)
  for (const c of cols) {
    const b = below(c.floor); if (!b) continue;
    const under = on(b).filter(o => member.get(o) === '柱' && overlap(rc(o), rc(c)) > 0.3 * Math.min(area(rc(o)), area(rc(c))));
    for (const u of under) {
      const same = Math.abs(Math.min(c.w, c.d) - Math.min(u.w, u.d)) <= 4 && Math.abs(Math.max(c.w, c.d) - Math.max(u.w, u.d)) <= 4;
      const shifted = Math.hypot(c.x - u.x, c.z - u.z) > 6;
      if (same && !shifted) continue;
      const mark = c.rc?.mark && u.rc?.mark && c.rc.mark === u.rc.mark;
      out.push({ kind: 'COL-SIZE', sev: 'info', floor: c.floor, ids: [c.id, u.id],
        text: `${c.floor} 的柱 ${sizeOf(c)}${c.rc?.mark ? `（${c.rc.mark}）` : ''}${shifted ? '偏離' : '與'}${b} 的柱 ${sizeOf(u)}${u.rc?.mark ? `（${u.rc.mark}）` : ''}${shifted ? ` ${Math.round(Math.hypot(c.x - u.x, c.z - u.z))} cm` : '尺寸不同'}，${where(c)}。${mark ? '柱配筋表分層給不同尺寸的話是正常的' : '圖上本來就不同的話可以不理'}` });
    }
  }
  // 5. a beam must bear on something at its ends (cantilevers at one end at least)
  for (const bm of beams) {
    if (Math.max(bm.w, bm.d) < 60) continue;
    const ends = beamEnds(bm), cant = /^(梁|地梁)? ?C/i.test(bm.name.replace(/（.*$/, '')) || /^C/i.test(bm.rc?.mark || '');
    const near = [...on(bm.floor), ...on(above(bm.floor)), ...on(below(bm.floor))].filter(o => o !== bm && solid(o) && o.y <= top(bm) + 5 && top(o) >= bm.y - 5);
    const held = ends.map(e => near.some(o => touches(rc(o), e, 2)));
    const free = held.filter(h => !h).length;
    if (free === 0 || (cant && free === 1)) continue;
    out.push({ kind: 'BEAM-END', sev: free === 2 ? 'warn' : 'info', floor: bm.floor, ids: [bm.id],
      text: `梁${free === 2 ? '兩端都' : '一端'}沒有柱、牆或梁支承：${bm.name.replace(/（.*$/, '')}（${Math.round(Math.max(bm.w, bm.d))} cm 長，${where(bm)}）${cant ? '' : free === 1 ? '。懸臂梁的話可以不理' : ''}` });
  }
  // 6. walls above the ground storey with no slab under them and nothing below (floating)
  const slabs = boxes.filter(o => member.get(o) === '樓板' || (member.get(o) === '基礎' && !/梁/.test(o.name)));
  for (const w of boxes) {
    if (member.get(w) !== '牆' || !w.floor || w.floor === lowest || w.y < 0 || Math.max(w.w, w.d) < 60) continue;
    const r = rc(w), b = below(w.floor);
    const fb = F.find(f => f.key === w.floor);
    const onSlab = slabs.some(s => (s.floor === w.floor || s.floor === b) && touches(rc(s), r, 20) && Math.abs(top(s) - (fb ? fb.y : w.y)) <= 25);
    if (onSlab) continue;
    const onPart = [...on(b), ...on(w.floor)].some(o => o !== w && solid(o) && touches(rc(o), r, 10) && Math.abs(top(o) - w.y) <= 25);
    if (!onPart) out.push({ kind: 'WALL-FLOAT', sev: 'warn', floor: w.floor, ids: [w.id], text: `牆下方沒有樓板、梁或牆（浮空）：${w.name.replace(/（.*$/, '')}（${Math.round(Math.max(w.w, w.d))} cm，${where(w)}）` });
  }
  // 7. a door or window not in a wall
  const walls = boxes.filter(o => member.get(o) === '牆' || member.get(o) === '柱');
  for (const o of objects) {
    let r: Rect | null = null;
    if (isBox(o)) { if (o.layer === 'glass' && !/欄杆/.test(o.name)) r = rc(o); }
    else { const m = (o.a + o.b) / 2; r = o.axis === 'x' ? { x0: o.a, x1: o.b, z0: o.at - 20, z1: o.at + 20 } : { x0: o.at - 20, x1: o.at + 20, z0: o.a, z1: o.b }; void m; }
    if (!r) continue;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    if (!walls.some(w => w.floor === o.floor && touches(rc(w), r!, 15))) out.push({ kind: 'OPEN-WALL', sev: 'info', floor: o.floor, ids: [o.id], text: `門窗旁邊沒有牆：${o.name.split('（')[0]}（${Math.round(cx)},${Math.round(cz)}）` });
  }
  // 8. a stair whose top steps run into the slab of the storey above (no opening)
  for (const s of boxes) {
    if (!(s.stair || s.layer === 'stair') || !/踏階/.test(s.name)) continue;
    const nx = above(s.floor); if (!nx) continue;
    const fn = F.find(f => f.key === nx)!;
    if (top(s) < fn.y - 60) continue;
    const cover = slabs.find(o => o.floor === nx && overlap(rc(o), rc(s), -5) > 0 && Math.abs(o.y - fn.y) <= 30);
    if (cover) out.push({ kind: 'STAIR-COVER', sev: 'warn', floor: s.floor, ids: [s.id, cover.id], text: `樓梯最上面的踏階被上一層樓板蓋住（沒有樓梯開口）：${where(s)}` });
  }
  // 9. an open plate edge above ground with nothing to stop a person walking off it (the very top of a rooftop
  // structure only has its 30 cm curb where it roofs a room; a slab piece up there on its own needs nothing)
  const hasRoofStruct = F.some(f => /^R\d+F$/.test(f.key));
  for (const f of F) {
    const topF = hasRoofStruct && f === F[F.length - 1];
    let j = F.indexOf(f) - 1;
    while (j > 0 && /MF$/.test(F[j].key)) j--;
    const lower = j >= 0 ? F[j] : undefined;
    const lowWalls = lower ? boxes.filter(o => o.floor === lower.key && o.layer === 'wall' && o.h >= lower.h * 0.6) : [];
    for (const e of openSlabEdges(objects, f.key)) {
      if (topF && !wallsOnTwoSides(e.plate, lowWalls)) continue;
      const len = Math.round(e.hi - e.lo), cx = e.alongX ? (e.lo + e.hi) / 2 : e.at, cz = e.alongX ? e.at : (e.lo + e.hi) / 2;
      out.push({ kind: 'SLAB-EDGE', sev: 'warn', floor: f.key, at: [cx, cz], text: `樓板邊緣沒有牆、女兒牆或欄杆（${len} cm 開放的板邊，可能掉下去）：${Math.round(cx)},${Math.round(cz)}` });
    }
  }
  // one line per spot: the same stair or wall can trip a rule many times
  const seen = new Set<string>();
  return out.filter(i => { const k = `${i.kind}|${i.floor}|${i.text.replace(/\d+,\d+/g, '')}|${i.ids?.[0]}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Issues grouped for display: floor order as built, warnings first. */
export function sortIssues(issues: Issue[], floors: CadFloor[] | undefined): Issue[] {
  const order = new Map((floors || []).map((f, i) => [f.key, i]));
  const sev = { warn: 0, fixed: 1, info: 2 };
  return issues.slice().sort((a, b) => sev[a.sev] - sev[b.sev] || (order.get(a.floor || '') ?? 99) - (order.get(b.floor || '') ?? 99) || a.kind.localeCompare(b.kind));
}
