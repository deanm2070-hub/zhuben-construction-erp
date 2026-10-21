import { describe, expect, it } from 'vitest';
import { buildFromMesh, computeBuildingTakeoff, DEFAULT_SETTINGS, isBox, isDoor, unpackMesh, type MeshPart } from '../src';

/** Triangles of an axis-aligned box, faces looking out. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
  const v = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  // each face: 4 corners counter-clockwise seen from outside
  const faces = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
  const out: number[] = [];
  for (const [a, b, c, d] of faces) out.push(...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d));
  return out;
}
/** The outside of the union of boxes, as one mass with no inner faces (the way push/pull modelling ends up). */
function union(parts: number[][], flip = false): number[] {
  // every 108 numbers (12 triangles) of a part is one box
  const boxes = parts.flatMap(p => Array.from({ length: p.length / 108 }, (_, i) => p.slice(i * 108, i * 108 + 108)));
  const bb = boxes.map(b => { const xs = b.filter((_, i) => i % 3 === 0), ys = b.filter((_, i) => i % 3 === 1), zs = b.filter((_, i) => i % 3 === 2); return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)]; });
  const X = [...new Set(bb.flatMap(b => [b[0], b[1]]))].sort((a, b) => a - b), Y = [...new Set(bb.flatMap(b => [b[2], b[3]]))].sort((a, b) => a - b), Z = [...new Set(bb.flatMap(b => [b[4], b[5]]))].sort((a, b) => a - b);
  const filled = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < X.length - 1 && j < Y.length - 1 && k < Z.length - 1 &&
    bb.some(b => X[i] >= b[0] && X[i + 1] <= b[1] && Y[j] >= b[2] && Y[j + 1] <= b[3] && Z[k] >= b[4] && Z[k + 1] <= b[5]);
  const out: number[] = [];
  const quad = (p: number[][]) => { const q = flip ? [p[0], p[3], p[2], p[1]] : p; out.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]); };
  for (let i = 0; i < X.length - 1; i++) for (let j = 0; j < Y.length - 1; j++) for (let k = 0; k < Z.length - 1; k++) {
    if (!filled(i, j, k)) continue;
    const [x0, x1, y0, y1, z0, z1] = [X[i], X[i + 1], Y[j], Y[j + 1], Z[k], Z[k + 1]];
    if (!filled(i - 1, j, k)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
    if (!filled(i + 1, j, k)) quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
    if (!filled(i, j - 1, k)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
    if (!filled(i, j + 1, k)) quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]);
    if (!filled(i, j, k - 1)) quad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
    if (!filled(i, j, k + 1)) quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  }
  return out;
}
const part = (name: string, ...boxes: number[][]): MeshPart => ({ name, color: 0xcccccc, pos: boxes.flat() });

/** Two storeys 10 × 8 m, 20 cm exterior walls, a 12 cm partition, a column, a beam, a roof with a parapet. */
function house(): MeshPart[] {
  const walls = (b: number, top: number) => [
    box(0, 1000, b, top, 0, 20), box(0, 1000, b, top, 780, 800), box(0, 20, b, top, 20, 780), box(980, 1000, b, top, 20, 780)];
  return [
    part('Ground slab', box(0, 1000, -15, 0, 0, 800)),
    // north wall with a 150 cm window (sill 90, head 210), south wall with a 100 cm door
    part('1F walls',
      box(0, 400, 0, 285, 0, 20), box(550, 1000, 0, 285, 0, 20), box(400, 550, 0, 90, 0, 20), box(400, 550, 210, 285, 0, 20),
      box(0, 200, 0, 285, 780, 800), box(300, 1000, 0, 285, 780, 800), box(200, 300, 210, 285, 780, 800),
      box(0, 20, 0, 285, 20, 780), box(980, 1000, 0, 285, 20, 780),
      // partition with a 90 cm door
      box(500, 512, 0, 285, 20, 300), box(500, 512, 0, 285, 390, 780), box(500, 512, 210, 285, 300, 390)),
    part('Column', box(700, 750, 0, 285, 400, 450)),
    part('Beam', box(20, 980, 225, 285, 600, 630)),
    part('2F slab', box(0, 1000, 285, 300, 0, 800)),
    part('2F walls', ...walls(300, 585)),
    part('Roof slab', box(0, 1000, 585, 600, 0, 800)),
    part('Parapet', box(0, 1000, 600, 700, 0, 15), box(0, 1000, 600, 700, 785, 800), box(0, 15, 600, 700, 15, 785), box(985, 1000, 600, 700, 15, 785)),
    part('Dining table', box(200, 320, 0, 75, 200, 280)),
  ];
}

describe.each([
  ['each member its own group', () => house()],
  ['one mass, faces back side out', () => { const h = house(); return [{ name: 'Model', color: 0xdddddd, pos: union(h.slice(0, -1).map(p => Array.from(p.pos)), true) }, h[h.length - 1]]; }],
])('SketchUp-style mesh to building: %s', (_, make) => {
  const r = buildFromMesh(make(), 'house.skp')!;
  const fl = (k: string) => r.report.floors.find(f => f.key === k)!;
  it('finds the storeys from the floor faces', () => {
    expect(r.cad.floors!.map(f => [f.key, f.y, f.h])).toEqual([['1F', 0, 300], ['2F', 300, 300], ['RF', 600, 100]]);
    expect(r.cad.W).toBe(1000);
    expect(r.cad.D).toBe(800);
  });
  it('reads doors, windows, the column and the beam', () => {
    expect(fl("1F")).toMatchObject({ doors: 2, windows: 1, columns: 1 });
    expect(fl("1F").beams).toBeGreaterThanOrEqual(1);
    const win = r.objects.find(o => isBox(o) && o.layer === 'glass')!;
    expect(isBox(win) && [win.y, win.h, Math.max(win.w, win.d)]).toEqual([90, 120, 150]);
    const doors = r.objects.filter(isDoor).map(d => [d.axis, d.b - d.a, d.h]).sort();
    expect(doors).toEqual([['x', 100, 210], ['z', 90, 210]]);
    const col = r.objects.find(o => isBox(o) && /柱/.test(o.name))!;
    expect(isBox(col) && [col.w, col.d, col.h]).toEqual([50, 50, 300]);
  });
  it('builds the exterior walls once, corners included', () => {
    const ext = r.objects.filter(o => isBox(o) && o.floor === '2F' && o.layer === 'wall');
    const vol = ext.reduce((s, o) => s + (isBox(o) ? o.w * o.d : 0), 0);
    // 2 × 1000 × 20 + 2 × 760 × 20
    expect(vol).toBeCloseTo(70400, -2);
    expect(ext.every(o => isBox(o) && o.wall === 'rc' && /外牆/.test(o.name))).toBe(true);
  });
  it('lays the slabs and the parapet', () => {
    expect(fl('1F').slabArea).toBeCloseTo(80, 0);
    expect(fl('2F').slabArea).toBeCloseTo(80, 0);
    expect(fl('RF').slabArea).toBeCloseTo(80, 0);
    expect(r.objects.filter(o => o.floor === 'RF' && /女兒牆/.test(o.name)).length).toBeGreaterThanOrEqual(4);
  });
  it('keeps the furniture as mesh', () => {
    // its underside lies on the slab and is hidden
    expect(r.report.furniture).toBe(10);
    const m = r.cad.meshes!.find(m => m.floor === '1F')!;
    expect(unpackMesh(m).idx.length).toBe(30);
  });
  it('gives a takeoff', () => {
    const t = computeBuildingTakeoff(r.objects, r.cad, {}, DEFAULT_SETTINGS);
    expect(t.calc.some(c => /混凝土/.test(c.item))).toBe(true);
    expect(t.rooms.length).toBeGreaterThanOrEqual(3);
  });
});

describe('SketchUp-style mesh: stairs and fittings', () => {
  const steps = Array.from({ length: 15 }, (_, i) => box(600 + i * 25, 625 + i * 25, 0, (i + 1) * 18.75, 100, 210));
  // low 25 cm deep cabinets, unnamed, the same component three times
  const units = [0, 1, 2].map(i => ({ name: 'Group#12', def: 'Component#3', solid: `unit${i}`, color: 0x885533, pos: box(100 + i * 110, 200 + i * 110, 0, 90, 300, 325) }));
  const r = buildFromMesh([...house(), part('Group#9', ...steps), ...units], 'stair.skp')!;
  it('reads a stair from its even treads', () => {
    const s = r.objects.find(o => isBox(o) && o.stair);
    expect(isBox(s!) && s.stair).toMatchObject({ risers: 16, flights: 1, width: 110, run: 25 });
    expect(r.report.floors[0].stairs).toBe(1);
  });
  it('treats a small component placed several times as a fitting', () => {
    expect(r.objects.some(o => isBox(o) && o.layer === 'wall' && o.x > 90 && o.x < 420 && o.z > 290 && o.z < 340)).toBe(false);
  });
});
