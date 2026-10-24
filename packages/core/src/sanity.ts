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
