import type { BoxObject } from './types';

/** Point-in-footprint test for a (possibly rotated) box. */
export function footprintTest(o: Pick<BoxObject, 'x' | 'z' | 'w' | 'd' | 'rot'>) {
  const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
  return (x: number, z: number) => {
    const dx = x - o.x, dz = z - o.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) <= o.w / 2 && Math.abs(lz) <= o.d / 2;
  };
}

export interface Seg2 { x1: number; z1: number; x2: number; z2: number }
export interface WallLine { ax: number; az: number; bx: number; bz: number; t: number; single?: boolean }

/**
 * Turns wall outlines into wall centre lines with thickness.
 * Parallel lines 4–60 cm apart that overlap are paired; each wall is extended by half its
 * thickness at both ends so corners close. Long lines with no partner become 10 cm walls.
 */
export function pairWalls(S: Seg2[]): WallLine[] {
  const info = S.map(s => {
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1, L = Math.hypot(dx, dz);
    return { ...s, L, ux: dx / L, uz: dz / L, cov: 0 };
  }).filter(s => s.L > 1);
  const n = info.length, out: WallLine[] = [];
  const order = [...info.keys()].sort((a, b) => info[a].L - info[b].L);
  for (const j of order) {
    const s = info[j];
    if (s.cov >= s.L * 0.9 || s.L < 15) continue;
    const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2;
    let best: { i: number; d: number; lo: number; hi: number } | null = null;
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const o = info[i];
      if (Math.abs(s.ux * o.uz - s.uz * o.ux) > 0.03) continue;
      const d = Math.abs((mx - o.x1) * o.uz - (mz - o.z1) * o.ux);
      if (d < 4 || d > 60) continue;
      const t1 = (s.x1 - o.x1) * o.ux + (s.z1 - o.z1) * o.uz, t2 = (s.x2 - o.x1) * o.ux + (s.z2 - o.z1) * o.uz;
      const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(o.L, Math.max(t1, t2));
      if (hi - lo < Math.min(15, s.L * 0.5)) continue;
      if (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && hi - lo > best.hi - best.lo)) best = { i, d, lo, hi };
    }
    if (!best) continue;
    const o = info[best.i], nx = -o.uz, nz = o.ux;
    const side = Math.sign((mx - o.x1) * nx + (mz - o.z1) * nz) || 1, off = side * best.d / 2;
    const lo = best.lo - best.d / 2, hi = best.hi + best.d / 2;
    out.push({ ax: o.x1 + o.ux * lo + nx * off, az: o.z1 + o.uz * lo + nz * off, bx: o.x1 + o.ux * hi + nx * off, bz: o.z1 + o.uz * hi + nz * off, t: best.d });
    s.cov = s.L;
    o.cov += best.hi - best.lo;
  }
  for (const s of info) if (s.cov === 0 && s.L >= 80) out.push({ ax: s.x1, az: s.z1, bx: s.x2, bz: s.z2, t: 10, single: true });
  return out;
}

/** Box for a wall centre line; axis-aligned walls get rot 0 so snapping stays simple. */
export function wallBox(w: WallLine, h: number, id: number): BoxObject {
  const dx = w.bx - w.ax, dz = w.bz - w.az, L = Math.hypot(dx, dz);
  let rot = Math.atan2(-dz, dx), ww = L, dd = w.t;
  const r = ((rot % Math.PI) + Math.PI) % Math.PI;
  if (r < 2e-3 || Math.PI - r < 2e-3) rot = 0;
  else if (Math.abs(r - Math.PI / 2) < 2e-3) { rot = 0; ww = w.t; dd = L; }
  const R = (v: number) => Math.round(v * 10) / 10;
  return { id, layer: 'wall', name: w.t >= 18 ? '外牆（CAD）' : '隔間牆（CAD）', x: R((w.ax + w.bx) / 2), z: R((w.az + w.bz) / 2), w: R(ww), d: R(dd), h, y: 0, rot, color: 0xeeebe5 };
}
