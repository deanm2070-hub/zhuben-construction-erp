import { memberOf } from './pricing';
import type { Issue } from './sanity';
import { isBox, type BoxObject, type ModelObject } from './types';

/**
 * Makes the frame hang together the way a builder would expect, whatever the drawings gave: a column stands on a
 * column (or a wall or a beam) all the way down to the ground, a beam ends on a column or a wall, and a beam with
 * nothing under either end is not a beam. Each change is listed as a ✎ issue so the person can see what was done.
 */
export interface StoreyLevel { key: string; base: number; h: number }

type Rect = { x0: number; x1: number; z0: number; z1: number };
const rect = (o: BoxObject): Rect => {
  const c = Math.abs(Math.cos(o.rot || 0)), s = Math.abs(Math.sin(o.rot || 0));
  const hw = (o.w * c + o.d * s) / 2, hd = (o.w * s + o.d * c) / 2;
  return { x0: o.x - hw, x1: o.x + hw, z0: o.z - hd, z1: o.z + hd };
};
const overlap = (p: Rect, q: Rect, m = 0) => Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) + m) * Math.max(0, Math.min(p.z1, q.z1) - Math.max(p.z0, q.z0) + m);
const touches = (p: Rect, q: Rect, m = 0) => p.x0 < q.x1 + m && q.x0 < p.x1 + m && p.z0 < q.z1 + m && q.z0 < p.z1 + m;
const where = (o: BoxObject) => `${Math.round(o.x)},${Math.round(o.z)}`;

export function rationalizeFrame(objects: ModelObject[], storeys: StoreyLevel[], nextId: number): { issues: Issue[]; id: number } {
  const issues: Issue[] = [];
  let id = nextId;
  const S = storeys.slice().sort((p, q) => p.base - q.base);
  if (S.length < 2) return { issues, id };
  const box = () => objects.filter(isBox);
  const kind = (o: BoxObject) => memberOf(o);
  const bearing = (o: BoxObject) => { const m = kind(o); return m === '柱' || m === '梁' || m === '基礎' || (m === '牆' && Math.min(o.w, o.d) >= 12 && o.h >= 100); };
  const top = (o: BoxObject) => o.y + o.h;

  // 1. columns continue to the ground: a column with nothing under it gets one on the storey below, and so on down
  for (let i = S.length - 1; i > 0; i--) {
    const st = S[i], lower = S[i - 1];
    const all = box();
    const under = all.filter(o => (o.floor === lower.key || o.floor === st.key) && bearing(o));
    for (const c of all.filter(o => o.floor === st.key && kind(o) === '柱')) {
      // a short post with no structural tag (a parapet pier, a decorative post), or one not starting at the floor, is not a column of the frame
      if ((!c.rc && c.h < 200) || c.y > st.base + 30 || /裝飾/.test(c.name)) continue;
      // posts on a rooftop storey only count when the structural plan knows them
      if (!c.rc && /^R\d*F$/.test(st.key)) continue;
      const r = rect(c);
      const stands = under.some(o => o !== c && overlap(rect(o), r, 4) > 0.3 * (c.w * c.d) && Math.abs(top(o) - c.y) <= 25);
      if (stands) continue;
      const h = Math.max(100, c.y - lower.base);
      const nc: BoxObject = { id: id++, layer: 'wall', name: `${c.name.replace(/（.*$/, '')}（自動補柱）`, floor: lower.key, x: c.x, z: c.z, w: c.w, d: c.d, h, y: lower.base, rot: c.rot, color: c.color, wall: 'rc', ...(c.rc ? { rc: { ...c.rc, fl: lower.key } } : {}), src: 'auto' };
      objects.push(nc);
      issues.push({ kind: 'COL-ADD', sev: 'fixed', floor: lower.key, ids: [nc.id, c.id], text: `${st.key} 的柱 ${c.name.replace(/（.*$/, '')}（${Math.round(Math.min(c.w, c.d))}×${Math.round(Math.max(c.w, c.d))}，${where(c)}）下方沒有柱，${lower.key} 補了一根同尺寸的柱（斷柱接上）` });
    }
  }

  // 2. beams end on something: an end in mid-air is stretched to the next column or wall along its line (within 2 m),
  //    and a beam with both ends in the air after that is dropped
  const all = box();
  const beams = all.filter(o => kind(o) === '梁' && !o.rot);
  for (const b of beams) {
    const alongX = b.w >= b.d, t = Math.min(b.w, b.d), L = Math.max(b.w, b.d);
    const same = all.filter(o => o !== b && bearing(o) && o.y < top(b) + 5 && top(o) > b.y - 5 && (o.floor === b.floor || Math.abs(top(o) - b.y) <= 30 || Math.abs(o.y - top(b)) <= 30));
    const endRect = (s: -1 | 1, len = 15): Rect => {
      const c = alongX ? b.x + s * (L / 2 - len / 2) : b.z + s * (L / 2 - len / 2);
      return alongX ? { x0: c - len / 2, x1: c + len / 2, z0: b.z - t / 2, z1: b.z + t / 2 } : { x0: b.x - t / 2, x1: b.x + t / 2, z0: c - len / 2, z1: c + len / 2 };
    };
    const held = (s: -1 | 1) => same.some(o => touches(rect(o), endRect(s), 10));
    const free: (-1 | 1)[] = ([-1, 1] as const).filter(s => !held(s));
    if (!free.length) continue;
    let fixed = 0;
    for (const s of free) {
      // the nearest column or wall further along the line, within its lateral band
      const end = alongX ? b.x + s * L / 2 : b.z + s * L / 2;
      let best: { o: BoxObject; d: number; to: number } | null = null;
      for (const o of same) {
        const r = rect(o), band = alongX ? r.z0 < b.z + t / 2 + 10 && r.z1 > b.z - t / 2 - 10 : r.x0 < b.x + t / 2 + 10 && r.x1 > b.x - t / 2 - 10;
        if (!band) continue;
        const near = alongX ? (s > 0 ? r.x0 : r.x1) : (s > 0 ? r.z0 : r.z1), far = alongX ? (s > 0 ? r.x1 : r.x0) : (s > 0 ? r.z1 : r.z0);
        const d = (near - end) * s;
        if (d < -5 || d > 200) continue;
        // a column or wall: run into its far face; a beam or anything else: up to its near face
        const to = kind(o) === '柱' || kind(o) === '牆' ? far : near;
        if (!best || d < best.d) best = { o, d, to };
      }
      if (!best) continue;
      const lo = alongX ? b.x - b.w / 2 : b.z - b.d / 2, hi = alongX ? b.x + b.w / 2 : b.z + b.d / 2;
      const nlo = s < 0 ? Math.min(lo, best.to) : lo, nhi = s > 0 ? Math.max(hi, best.to) : hi;
      if (alongX) { b.x = (nlo + nhi) / 2; b.w = nhi - nlo; } else { b.z = (nlo + nhi) / 2; b.d = nhi - nlo; }
      fixed++;
      issues.push({ kind: 'BEAM-EXT', sev: 'fixed', floor: b.floor, ids: [b.id, best.o.id], text: `${b.name.replace(/（.*$/, '')} 的一端懸空，延長 ${Math.round(best.d)} cm 接到${kind(best.o)}上（${where(b)}）` });
    }
    if (free.length === 2 && fixed === 0 && !b.rc) {
      objects.splice(objects.indexOf(b), 1);
      issues.push({ kind: 'BEAM-DROP', sev: 'fixed', floor: b.floor, at: [b.x, b.z], text: `漂浮的梁：${b.name.replace(/（.*$/, '')}（${Math.round(L)} cm） 兩端都沒有柱牆、附近也沒有可以接的，已移除（${where(b)}）` });
    }
  }
  return { issues, id };
}
