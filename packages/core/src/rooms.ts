import { footprintTest } from './geometry';
import { isBox, type Bounds, type ModelObject, type RoomRect } from './types';

export interface RoomLabel { n: string; x: number; z: number }
export interface RoomStat { name: string; area: number; perim: number }

const CELL = 10, MARGIN = 60, CLOSE = 5; // cm, cm, cells (doorways up to ~100 cm are closed)

/**
 * Splits the plan into rooms on a 10 cm grid.
 * With `rects` (the sample flat) each free cell belongs to the rectangle it falls in.
 * Otherwise walls are dilated to close doorways, each label floods its room, and the
 * rooms grow back to the walls. Area is in m², perimeter (wall contact) in m.
 */
export function computeRooms(objects: ModelObject[], bounds: Bounds, labels: RoomLabel[], rects?: RoomRect[]): RoomStat[] {
  return roomMap(objects, bounds, labels, rects).rooms;
}

/** Rooms plus a lookup of the room a plan point lies in (null for walls and outside). */
export function roomMap(objects: ModelObject[], bounds: Bounds, labels: RoomLabel[], rects?: RoomRect[]): { rooms: RoomStat[]; at: (x: number, z: number) => string | null } {
  const C = CELL, x0 = -MARGIN, z0 = -MARGIN;
  const nx = Math.ceil((bounds.W + 2 * MARGIN) / C), nz = Math.ceil((bounds.D + 2 * MARGIN) / C), N = nx * nz;
  const wall = new Uint8Array(N);
  for (const o0 of objects) {
    // railings close balconies like walls do
    if (!isBox(o0) || (o0.layer !== 'wall' && !/欄杆/.test(o0.name)) || o0.y > 150) continue;
    // thin pieces (glass, 10 cm single lines) must still cover the grid
    const o = { ...o0, w: Math.max(o0.w, C + 1), d: Math.max(o0.d, C + 1) };
    const test = footprintTest(o), r = Math.hypot(o.w, o.d) / 2;
    const i0 = Math.max(0, Math.floor((o.x - r - x0) / C)), i1 = Math.min(nx - 1, Math.ceil((o.x + r - x0) / C));
    const j0 = Math.max(0, Math.floor((o.z - r - z0) / C)), j1 = Math.min(nz - 1, Math.ceil((o.z + r - z0) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (test(x0 + (i + .5) * C, z0 + (j + .5) * C)) wall[j * nx + i] = 1;
  }
  const nb = (i: number, j: number) => [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < nx && b < nz);
  const finish = (res: { name: string; cells: number; edges: number }[]) =>
    res.filter(r => r.cells * C * C / 1e4 >= 0.5).map(r => ({ name: r.name, area: r.cells * C * C / 1e4, perim: r.edges * C / 100 }));

  if (rects) {
    const res = rects.map(r => ({ name: r.n, cells: 0, edges: 0 }));
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (wall[j * nx + i]) continue;
      const x = x0 + (i + .5) * C, z = z0 + (j + .5) * C;
      const ri = rects.findIndex(r => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1);
      if (ri < 0) continue;
      res[ri].cells++;
      for (const [a, b] of nb(i, j)) if (wall[b * nx + a]) res[ri].edges++;
    }
    return {
      rooms: finish(res),
      at: (x, z) => rects.find(r => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1)?.n ?? null,
    };
  }

  const R = CLOSE, dil = new Uint8Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (wall[j * nx + i])
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      if (di * di + dj * dj > R * R) continue;
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < nx && b < nz) dil[b * nx + a] = 1;
    }
  // doors and floor-level glass close their openings while rooms are told apart, but are not wall
  const closed = (x0c: number, x1c: number, z0c: number, z1c: number) => {
    for (let j = Math.max(0, Math.floor((z0c - z0) / C)); j <= Math.min(nz - 1, Math.floor((z1c - z0) / C)); j++)
      for (let i = Math.max(0, Math.floor((x0c - x0) / C)); i <= Math.min(nx - 1, Math.floor((x1c - x0) / C)); i++) dil[j * nx + i] = 1;
  };
  for (const o of objects) {
    if (o.layer === 'door') {
      const along = o.axis === 'x';
      if (along) closed(o.a, o.b, o.at - 8, o.at + 8); else closed(o.at - 8, o.at + 8, o.a, o.b);
    } else if (o.layer === 'glass' && o.y < 150 && !o.rot) closed(o.x - o.w / 2 - 4, o.x + o.w / 2 + 4, o.z - o.d / 2 - 4, o.z + o.d / 2 + 4);
  }
  const owner = new Int32Array(N).fill(-1);
  const flood = (seeds: number[], id: number) => {
    const q = [...seeds];
    for (const k of q) owner[k] = id;
    while (q.length) {
      const k = q.pop()!;
      for (const [a, b] of nb(k % nx, (k / nx) | 0)) {
        const m = b * nx + a;
        if (owner[m] !== -1 || dil[m]) continue;
        owner[m] = id; q.push(m);
      }
    }
  };
  const border: number[] = [];
  for (let i = 0; i < nx; i++) border.push(i, (nz - 1) * nx + i);
  for (let j = 0; j < nz; j++) border.push(j * nx, j * nx + nx - 1);
  flood(border.filter(k => !dil[k]), 0);

  const rooms: { names: string[] }[] = [];
  for (const l of labels) {
    const ci = Math.floor((l.x - x0) / C), cj = Math.floor((l.z - z0) / C);
    let found = -1;
    for (let r = 0; r <= 5 && found < 0; r++) for (let dj = -r; dj <= r && found < 0; dj++) for (let di = -r; di <= r; di++) {
      const a = ci + di, b = cj + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const k = b * nx + a;
      if (!wall[k] && owner[k] !== 0) { found = k; break; }
    }
    if (found < 0) continue;
    if (owner[found] > 0) { rooms[owner[found] - 1].names.push(l.n); continue; }
    rooms.push({ names: [l.n] });
    if (dil[found]) owner[found] = rooms.length; else flood([found], rooms.length);
  }
  // grow every region back toward the walls, all at once so doorways split fairly
  let front: number[] = [];
  for (let k = 0; k < N; k++) if (owner[k] !== -1) front.push(k);
  while (front.length) {
    const next: number[] = [];
    for (const k of front) for (const [a, b] of nb(k % nx, (k / nx) | 0)) {
      const m = b * nx + a;
      if (owner[m] !== -1 || wall[m]) continue;
      owner[m] = owner[k]; next.push(m);
    }
    front = next;
  }
  let other = 0;
  for (let k = 0; k < N; k++) if (owner[k] === -1 && !wall[k]) { owner[k] = rooms.length + 1; other++; }
  if (other) rooms.push({ names: ['其他未標示空間'] });
  const res = rooms.map(r => ({ name: r.names.join('＋'), cells: 0, edges: 0 }));
  for (let k = 0; k < N; k++) {
    const id = owner[k];
    if (id <= 0) continue;
    const r = res[id - 1];
    r.cells++;
    for (const [a, b] of nb(k % nx, (k / nx) | 0)) if (wall[b * nx + a]) r.edges++;
  }
  return {
    rooms: finish(res),
    at: (x, z) => {
      const i = Math.floor((x - x0) / C), j = Math.floor((z - z0) / C);
      if (i < 0 || j < 0 || i >= nx || j >= nz) return null;
      const id = owner[j * nx + i];
      return id > 0 && !wall[j * nx + i] ? res[id - 1].name : null;
    },
  };
}
