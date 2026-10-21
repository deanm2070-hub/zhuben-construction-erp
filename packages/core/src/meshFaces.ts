/**
 * Triangle soup back to the faces a modeller expects: coplanar triangles that share edges are joined into one
 * polygon, so a box comes out as six quads rather than twelve triangles with a diagonal across every side.
 * Used to write SketchUp files, where every triangle edge would otherwise show as a drawn line.
 */
export type P3 = [number, number, number];

/**
 * `pos` holds triangles as x, y, z triples (9 numbers per triangle). Returns polygons (outer loops, counter-clockwise
 * seen from the front) in the same coordinates. A plane whose boundary does not close into simple loops, or that
 * would need a hole, is returned as its triangles.
 */
export function mergeCoplanar(pos: ArrayLike<number>, weld = 0.1): P3[][] {
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
  const ids = new Map<string, number>(), pts: P3[] = [];
  const vid = (i: number) => {
    const k = keyOf(pos[i], pos[i + 1], pos[i + 2]);
    let v = ids.get(k);
    if (v === undefined) { v = pts.length; ids.set(k, v); pts.push([pos[i], pos[i + 1], pos[i + 2]]); }
    return v;
  };
  // triangles grouped by plane: normal rounded to 1e-3, offset to the weld size
  const planes = new Map<string, number[][]>();
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const a = vid(i), b = vid(i + 3), c = vid(i + 6);
    if (a === b || b === c || a === c) continue;
    const [p, q, r] = [pts[a], pts[b], pts[c]];
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) continue;
    nx /= L; ny /= L; nz /= L;
    const k = `${Math.round(nx * 1e3)},${Math.round(ny * 1e3)},${Math.round(nz * 1e3)},${Math.round((nx * p[0] + ny * p[1] + nz * p[2]) / weld)}`;
    (planes.get(k) || planes.set(k, []).get(k)!).push([a, b, c]);
  }
  const out: P3[][] = [];
  for (const tris of planes.values()) {
    if (tris.length === 1) { out.push(tris[0].map(v => pts[v])); continue; }
    // boundary = directed edges whose reverse is not in the plane
    const dir = new Set<string>();
    for (const [a, b, c] of tris) for (const [u, w] of [[a, b], [b, c], [c, a]]) dir.add(`${u}>${w}`);
    const next = new Map<number, number[]>();
    let bad = false;
    for (const e of dir) {
      const [u, w] = e.split('>').map(Number);
      if (dir.has(`${w}>${u}`)) continue;
      const l = next.get(u) || next.set(u, []).get(u)!;
      l.push(w);
      if (l.length > 1) bad = true;
    }
    const loops: number[][] = [];
    if (!bad) {
      const used = new Set<number>();
      for (const s of next.keys()) {
        if (used.has(s)) continue;
        const loop: number[] = [];
        let v = s;
        while (!used.has(v)) { used.add(v); loop.push(v); const n = next.get(v); if (!n) { bad = true; break; } v = n[0]; }
        if (bad || v !== s) { bad = true; break; }
        loops.push(loop);
      }
    }
    // more than one loop could be a hole: keep it simple and only merge planes with a single outline per piece
    if (!bad && loops.length) {
      const area = (l: number[]) => {
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < l.length; i++) {
          const p = pts[l[i]], q = pts[l[(i + 1) % l.length]];
          x += p[1] * q[2] - p[2] * q[1]; y += p[2] * q[0] - p[0] * q[2]; z += p[0] * q[1] - p[1] * q[0];
        }
        return Math.hypot(x, y, z) / 2;
      };
      const triArea = tris.reduce((s, t) => s + area(t), 0), loopArea = loops.reduce((s, l) => s + area(l), 0);
      if (Math.abs(triArea - loopArea) <= Math.max(1e-6, triArea * 1e-3)) {
        // drop points lying straight between their neighbours
        for (const l of loops) {
          const keep = l.filter((v, i) => {
            const p = pts[l[(i + l.length - 1) % l.length]], q = pts[v], r = pts[l[(i + 1) % l.length]];
            const ax = q[0] - p[0], ay = q[1] - p[1], az = q[2] - p[2], bx = r[0] - q[0], by = r[1] - q[1], bz = r[2] - q[2];
            return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 1e-6 * Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
          });
          out.push((keep.length >= 3 ? keep : l).map(v => pts[v]));
        }
        continue;
      }
    }
    for (const t of tris) out.push(t.map(v => pts[v]));
  }
  return out;
}
