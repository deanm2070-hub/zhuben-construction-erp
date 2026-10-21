import { footprintTest, wallBox } from './geometry';
import type { BoxObject, CadData, CadFloor, CadMesh, CadText, DoorObject, ModelObject } from './types';

/**
 * Building model from a 3D mesh (SketchUp .skp, or a .dae / .obj / .glb export).
 *
 * The mesh is read the way a person reads a model: horizontal faces with a lot of area are
 * floor levels; each storey is cut by horizontal planes every 10 cm, and two parallel cut
 * lines facing away from each other 3–80 cm apart are the two faces of a wall. Where both
 * faces of a wall stop at some heights and go on above, there is an opening: from the floor
 * a door, above a sill a window. Short thick pieces are columns, pieces hanging from the
 * ceiling are beams, horizontal faces at a level are the slab. Whatever is not explained by
 * those members (furniture, stairs, pitched roofs, decoration) is kept as plain mesh so the
 * model still looks like the SketchUp file.
 */

/** One piece of the source: a triangle soup in cm, x east, y up, z south (9 numbers per triangle). */
export interface MeshPart {
  /** names that say what the piece is: group / component / tag (layer) / material, joined */
  name: string;
  color: number;
  /** 1 = opaque */
  opacity?: number;
  /** pieces of one solid (a SketchUp group / component instance) share this; a solid whose faces all look inwards is turned round */
  solid?: string;
  /** the component definition the solid is an instance of */
  def?: string;
  pos: ArrayLike<number>;
}

export interface MeshFloorReport { key: string; base: number; h: number; stairs?: number; walls: number; columns: number; beams: number; doors: number; windows: number; slabs: number; slabArea: number }
export interface MeshBuildResult {
  objects: ModelObject[];
  cad: CadData;
  report: { floors: MeshFloorReport[]; triangles: number; kept: number; furniture: number; singleFace: boolean };
}

type Role = 0 | 1 | 2 | 3 | 4; // struct, furniture, door, window, stair
const R_STRUCT = 0, R_FURN = 1, R_DOOR = 2, R_WIN = 3, R_STAIR = 4;

const FURN_RE = /家具|傢俱|傢具|櫃|桌|椅|床|沙發|茶几|書架|鞋櫃|衣櫃|廚具|流理|爐|冰箱|洗衣|電視|窗簾|地毯|燈|植栽|植物|盆栽|樹|草|車|人物|衛浴|馬桶|浴缸|洗手|面盆|淋浴|鏡|裝飾|擺飾|furn|sofa|couch|chair|stool|table|desk|bed\b|cabinet|wardrobe|closet|shelf|shelves|kitchen|counter|cooktop|oven|fridge|refrigerator|washer|tv\b|television|curtain|blind|rug|carpet|lamp|light|plant|tree|grass|shrub|bush|flower|car\b|vehicle|people|person|human|figure|toilet|wc\b|bathtub|tub\b|sink|basin|shower|faucet|mirror|decor|appliance|entourage/i;
const DOOR_RE = /門|door/i;
const WIN_RE = /窗|玻璃|window|glass|glazing|pane/i;
const STAIR_RE = /樓梯|階梯|踏階|扶手|stair|step|tread|riser|handrail/i;

/** What a piece is by its names; structure (walls, slabs …) is the default and is then told apart by shape. */
export function partRole(name: string, opacity = 1): Role {
  if (FURN_RE.test(name)) return R_FURN;
  if (STAIR_RE.test(name)) return R_STAIR;
  // doors before windows: 落地門窗 / glass doors are doors
  if (DOOR_RE.test(name) && !/門窗表/.test(name)) return R_DOOR;
  if (WIN_RE.test(name) || opacity < 0.9) return R_WIN;
  return R_STRUCT;
}

interface Level { y: number; area: number; t: number; made?: boolean }
interface Storey { key: string; base: number; H: number; clearTop: number; top: boolean; roof: boolean }
interface Iv { a: number; b: number }

const STEP = 10, FIRST = 20.37, CELL = 2, SLAB_DEF = 15;

export function buildFromMesh(parts: MeshPart[], name: string, firstId = 1): MeshBuildResult | null {
  // ---------- triangles ----------
  let T = 0;
  for (const p of parts) T += Math.floor(p.pos.length / 9);
  // a component placed several times that is small and low (chairs, lamps, window units) is a fitting, not structure
  const solidBox = new Map<string, number[]>(), defSolids = new Map<string, Set<string>>();
  for (const p of parts) {
    if (!p.def || !p.solid) continue;
    if (!defSolids.has(p.def)) defSolids.set(p.def, new Set());
    defSolids.get(p.def)!.add(p.solid);
    const b = solidBox.get(p.solid) || [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i + 2 < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { b[k * 2] = Math.min(b[k * 2], p.pos[i + k]); b[k * 2 + 1] = Math.max(b[k * 2 + 1], p.pos[i + k]); }
    solidBox.set(p.solid, b);
  }
  const fitting = (p: MeshPart) => {
    const b = p.solid && solidBox.get(p.solid);
    return !!b && (defSolids.get(p.def!)?.size || 0) >= 2 && b[3] - b[2] < 200 && Math.max(b[1] - b[0], b[5] - b[4]) <= 300;
  };
  const P = new Float64Array(T * 9), N = new Float32Array(T * 3), A = new Float32Array(T), role = new Uint8Array(T), partOf = new Int32Array(T);
  let t = 0;
  parts.forEach((p, pi) => {
    let r = partRole(p.name, p.opacity ?? 1);
    if (r === R_STRUCT && fitting(p)) r = R_FURN;
    for (let i = 0; i + 8 < p.pos.length; i += 9) {
      for (let k = 0; k < 9; k++) P[t * 9 + k] = p.pos[i + k];
      const ux = P[t * 9 + 3] - P[t * 9], uy = P[t * 9 + 4] - P[t * 9 + 1], uz = P[t * 9 + 5] - P[t * 9 + 2];
      const vx = P[t * 9 + 6] - P[t * 9], vy = P[t * 9 + 7] - P[t * 9 + 1], vz = P[t * 9 + 8] - P[t * 9 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz);
      if (L < 1e-6) continue;
      N[t * 3] = nx / L; N[t * 3 + 1] = ny / L; N[t * 3 + 2] = nz / L;
      A[t] = L / 2; role[t] = r; partOf[t] = pi;
      t++;
    }
  });
  T = t;
  if (!T) return null;
  // faces drawn back side out (common in SketchUp): a closed solid with negative volume is turned round
  const vol = new Map<string, number>();
  for (let i = 0; i < T; i++) {
    const k = parts[partOf[i]].solid ?? `#${partOf[i]}`, o = i * 9;
    const v = (P[o] * (P[o + 4] * P[o + 8] - P[o + 5] * P[o + 7]) - P[o + 1] * (P[o + 3] * P[o + 8] - P[o + 5] * P[o + 6]) + P[o + 2] * (P[o + 3] * P[o + 7] - P[o + 4] * P[o + 6])) / 6;
    vol.set(k, (vol.get(k) || 0) + v);
  }
  for (let i = 0; i < T; i++) if ((vol.get(parts[partOf[i]].solid ?? `#${partOf[i]}`) || 0) < -1e3) for (let k = 0; k < 3; k++) N[i * 3 + k] = -N[i * 3 + k];
  const cy = (i: number) => (P[i * 9 + 1] + P[i * 9 + 4] + P[i * 9 + 7]) / 3;
  const cx = (i: number) => (P[i * 9] + P[i * 9 + 3] + P[i * 9 + 6]) / 3;
  const cz = (i: number) => (P[i * 9 + 2] + P[i * 9 + 5] + P[i * 9 + 8]) / 3;
  const isVert = (i: number) => Math.abs(N[i * 3 + 1]) < 0.05;
  const isHorz = (i: number) => Math.abs(N[i * 3 + 1]) > 0.999;

  // building extent: vertical structural faces (terrain and far-off props are horizontal or small)
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity, vy0 = Infinity, vy1 = -Infinity;
  for (let i = 0; i < T; i++) {
    if (role[i] !== R_STRUCT || !isVert(i) || A[i] < 10) continue;
    for (let k = 0; k < 3; k++) {
      const x = P[i * 9 + k * 3], y = P[i * 9 + k * 3 + 1], z = P[i * 9 + k * 3 + 2];
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); vy0 = Math.min(vy0, y); vy1 = Math.max(vy1, y);
    }
  }
  if (!isFinite(bx0)) return null;
  const ox = bx0, oz = bz0, W = bx1 - bx0, D = bz1 - bz0;
  const inB = (x: number, z: number, m = 50) => x >= bx0 - m && x <= bx1 + m && z >= bz0 - m && z <= bz1 + m;

  // ---------- levels: horizontal faces facing up with a lot of area ----------
  const upArea = new Map<number, number>(), dnTris: number[] = [], upTris: number[] = [];
  for (let i = 0; i < T; i++) {
    if (role[i] !== R_STRUCT || !isHorz(i) || !inB(cx(i), cz(i))) continue;
    const y = cy(i);
    if (N[i * 3 + 1] > 0) { upArea.set(Math.round(y), (upArea.get(Math.round(y)) || 0) + A[i]); upTris.push(i); } else dnTris.push(i);
  }
  const keys = [...upArea.keys()].sort((a, b) => a - b);
  const groups: Level[] = [];
  for (let i = 0; i < keys.length;) {
    let j = i, area = 0, wy = 0;
    while (j < keys.length && (j === i || keys[j] - keys[j - 1] <= 3)) { const a = upArea.get(keys[j])!; area += a; wy += a * keys[j]; j++; }
    groups.push({ y: wy / area, area, t: SLAB_DEF });
    i = j;
  }
  const maxA = Math.max(0, ...groups.map(g => g.area));
  const levels: Level[] = [];
  for (const g of groups.filter(g => g.area >= Math.max(3e4, 0.15 * maxA))) {
    const last = levels[levels.length - 1];
    if (!last) levels.push(g);
    // a finish layer or terrain just under the floor: keep the upper face
    else if (g.y - last.y < 60) levels[levels.length - 1] = { ...g, area: Math.max(g.area, last.area) };
    else if (g.y - last.y < 180) { if (g.area > last.area) levels[levels.length - 1] = g; }
    else levels.push(g);
  }
  // walls that start well below the lowest floor face (no ground slab drawn)
  if (!levels.length || vy0 < levels[0].y - 150) levels.unshift({ y: vy0, area: 0, t: SLAB_DEF, made: true });
  // slab thickness: the biggest downward face a little under each level
  for (const L of levels) {
    const h = new Map<number, number>();
    for (const i of dnTris) { const y = cy(i); if (y < L.y - 3 && y > L.y - 80) h.set(Math.round(y), (h.get(Math.round(y)) || 0) + A[i]); }
    let best = 0, by = 0;
    for (const [y, a] of h) if (a > best) { best = a; by = y; }
    if (best >= Math.max(1e4, L.area * 0.2)) L.t = Math.min(60, Math.max(5, Math.round(L.y - by)));
  }

  // ---------- storeys ----------
  const storeys: Storey[] = [];
  levels.forEach((L, i) => {
    const next = levels[i + 1];
    if (next) return storeys.push({ key: '', base: L.y, H: next.y - L.y, clearTop: next.y - next.t, top: false, roof: false });
    const tall = vy1 - L.y;
    if (tall >= 200) storeys.push({ key: '', base: L.y, H: tall, clearTop: vy1, top: true, roof: false });
    else storeys.push({ key: 'RF', base: L.y, H: Math.max(0, tall), clearTop: L.y + Math.max(0, tall), top: true, roof: true });
  });
  let n = 0;
  for (const s of storeys) if (!s.roof) s.key = `${++n}F`;

  // ---------- plane cuts ----------
  const vtris: number[] = [];
  for (let i = 0; i < T; i++) if (role[i] === R_STRUCT && isVert(i)) vtris.push(i);
  type Cut = { x1: number; z1: number; x2: number; z2: number; nx: number; nz: number };
  const cutAt = (h: number, list: number[]): Cut[] => {
    const out: Cut[] = [];
    for (const i of list) {
      const o = i * 9, ys = [P[o + 1], P[o + 4], P[o + 7]];
      if (Math.min(ys[0], ys[1], ys[2]) > h || Math.max(ys[0], ys[1], ys[2]) < h) continue;
      const pts: number[] = [];
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const ya = ys[a], yb = ys[b];
        if ((ya - h) * (yb - h) >= 0) continue;
        const f = (h - ya) / (yb - ya);
        pts.push(P[o + a * 3] + f * (P[o + b * 3] - P[o + a * 3]), P[o + a * 3 + 2] + f * (P[o + b * 3 + 2] - P[o + a * 3 + 2]));
      }
      if (pts.length < 4) continue;
      const hx = N[i * 3], hz = N[i * 3 + 2], hl = Math.hypot(hx, hz);
      if (Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < 0.05) continue;
      out.push({ x1: pts[0], z1: pts[1], x2: pts[2], z2: pts[3], nx: hx / hl, nz: hz / hl });
    }
    return out;
  };

  const objects: ModelObject[] = [];
  let id = firstId;
  const floorsOut: CadFloor[] = [];
  const reports: MeshFloorReport[] = [];
  const explained: BoxObject[] = [];
  let singleFace = false;
  const y0 = storeys.find(s => !s.roof)?.base ?? storeys[0].base;

  // horizontal faces for exact sill / head heights
  const hz: { x: number; z: number; y: number; a: number; up: boolean }[] = [];
  for (let i = 0; i < T; i++) if (role[i] === R_STRUCT && isHorz(i)) hz.push({ x: cx(i), z: cz(i), y: cy(i), a: A[i], up: N[i * 3 + 1] > 0 });

  const storeyBoxes = new Map<string, BoxObject[]>();
  type End = { a: number; b: number; lo: number; hi: number; at: (u: number) => { x: number; z: number }; remake: (a: number, b: number) => BoxObject };
  const ends = new Map<BoxObject, End>();
  for (const st of storeys) {
    const boxes: BoxObject[] = [];
    storeyBoxes.set(st.key, boxes);
    const rep: MeshFloorReport = { key: st.key, base: Math.round(st.base - y0), h: Math.round(st.H), walls: 0, columns: 0, beams: 0, doors: 0, windows: 0, slabs: 0, slabArea: 0 };
    reports.push(rep);
    const hs: number[] = [];
    for (let h = st.base + FIRST; h < st.clearTop - 3; h += STEP) hs.push(h);
    const K = hs.length;
    const list = vtris.filter(i => { const o = i * 9; return Math.max(P[o + 1], P[o + 4], P[o + 7]) >= st.base && Math.min(P[o + 1], P[o + 4], P[o + 7]) <= st.clearTop; });
    if (K >= 2 && list.length) {
      // every cut segment on its plane: direction φ ∈ [0, π), offset s along m = (cos φ, sin φ), side = which way the face looks
      type Seg = { phi: number; side: number; s: number; u0: number; u1: number; k: number };
      const segs: Seg[] = [];
      hs.forEach((h, k) => {
        for (const c of cutAt(h, list)) {
          let phi = Math.atan2(c.nz, c.nx), side = 1;
          if (phi < -0.001) { phi += Math.PI; side = -1; }
          if (phi > Math.PI - 0.001) { phi -= Math.PI; side = -side; }
          segs.push({ phi, side, s: 0, u0: 0, u1: 0, k, ...{ _c: c } } as Seg & { _c: Cut });
        }
      });
      segs.sort((a, b) => a.phi - b.phi);
      // direction groups
      const dirGroups: Seg[][] = [];
      for (const sg of segs) {
        const g = dirGroups[dirGroups.length - 1];
        if (g && sg.phi - g[g.length - 1].phi <= 0.004) g.push(sg); else dirGroups.push([sg]);
      }
      // wrap-around: φ just under π is the same direction as φ just over 0
      if (dirGroups.length > 1) {
        const last = dirGroups[dirGroups.length - 1], first = dirGroups[0];
        if (last[last.length - 1].phi > Math.PI - 0.004 && first[0].phi < 0.004) {
          for (const sg of last) { sg.phi -= Math.PI; sg.side = -sg.side; }
          first.unshift(...last); dirGroups.pop();
        }
      }
      type Plane = { side: number; s: number; iv: Iv[][] };
      type Pair = { phi: number; A: Plane; B: Plane; sA: number; sB: number; iv: Iv[][]; single?: boolean };
      const pairs: Pair[] = [];
      const dirs: { phi: number; planes: Plane[] }[] = [];
      for (const g of dirGroups) {
        const phi = g.reduce((s, x) => s + x.phi, 0) / g.length, mx = Math.cos(phi), mz = Math.sin(phi);
        for (const sg of g as (Seg & { _c: Cut })[]) {
          const c = sg._c;
          sg.s = ((c.x1 + c.x2) * mx + (c.z1 + c.z2) * mz) / 2;
          const ua = -c.x1 * mz + c.z1 * mx, ub = -c.x2 * mz + c.z2 * mx;
          sg.u0 = Math.min(ua, ub); sg.u1 = Math.max(ua, ub);
        }
        const planes: Plane[] = [];
        for (const side of [1, -1]) {
          const ss = g.filter(x => x.side === side).sort((a, b) => a.s - b.s);
          let cur: Seg[] = [];
          const flush = () => {
            if (!cur.length) return;
            const iv: Iv[][] = Array.from({ length: K }, () => []);
            for (const x of cur) iv[x.k].push({ a: x.u0, b: x.u1 });
            planes.push({ side, s: cur.reduce((s, x) => s + x.s, 0) / cur.length, iv: iv.map(l => merge(l, 0.5)) });
            cur = [];
          };
          for (const x of ss) { if (cur.length && x.s - cur[cur.length - 1].s > 1) flush(); cur.push(x); }
          flush();
        }
        dirs.push({ phi, planes });
        const plus = planes.filter(p => p.side === 1), minus = planes.filter(p => p.side === -1);
        const found = new Map<string, Pair>();
        for (const Ap of plus) {
          const cands = minus.filter(B => Ap.s - B.s >= 3 && Ap.s - B.s <= 80).sort((a, b) => b.s - a.s);
          if (!cands.length) continue;
          for (let k = 0; k < K; k++) {
            let rem = Ap.iv[k];
            for (const B of cands) {
              if (!rem.length) break;
              const ov = intersect(rem, B.iv[k]);
              if (ov.length) {
                const key = `${planes.indexOf(Ap)}|${planes.indexOf(B)}`;
                let pr = found.get(key);
                if (!pr) { pr = { phi, A: Ap, B, sA: Ap.s, sB: B.s, iv: Array.from({ length: K }, () => []) }; found.set(key, pr); }
                pr.iv[k].push(...ov);
              }
              rem = subtract(rem, B.iv[k]);
            }
          }
        }
        pairs.push(...found.values());
      }
      // a model drawn with single faces (no wall thickness): tall faces become 10 cm walls
      const paired = pairs.reduce((s, p) => s + Math.max(0, ...p.iv.map(l => l.reduce((a, v) => a + v.b - v.a, 0))), 0);
      if (paired < 300) {
        singleFace = true;
        for (const d of dirs) for (const pl of d.planes) {
          const cover = pl.iv.filter(l => l.reduce((a, v) => a + v.b - v.a, 0) >= 60).length;
          if (cover < K * 0.6) continue;
          if (pairs.some(p => p.phi === d.phi && Math.abs((p.sA + p.sB) / 2 - (pl.s - pl.side * 5)) < 3)) continue;
          const sA = pl.side > 0 ? pl.s : pl.s + 10, sB = sA - 10;
          pairs.push({ phi: d.phi, A: pl, B: pl, sA, sB, iv: pl.iv.map(l => l.slice()), single: true });
        }
      }

      ends.clear();
      for (const pr of pairs) emitWall(pr, st, hs, boxes, rep);
      // both walls of a corner grow into it: the first keeps the corner, the other gives way (and so does a wall grown into a cross wall drawn as its own box)
      for (const [box, e] of ends) {
        const i = boxes.indexOf(box);
        const inOther = (u: number) => { const p = e.at(u); return boxes.some((c, j) => j !== i && c.layer === 'wall' && footprintTest({ ...c, w: c.w - 1, d: c.d - 1 })(p.x, p.z)); };
        const lo = e.lo && inOther(e.a + e.lo / 2) ? e.lo : 0, hi = e.hi && inOther(e.b - e.hi / 2) ? e.hi : 0;
        if (lo || hi) boxes[i] = e.remake(e.a + lo, e.b - hi);
      }
      groupColumns(boxes, rep);
    }
    // a roof deck or terrace storey: the low walls round it are parapets
    if (st.roof) for (const b of boxes) if (b.layer === 'wall' && !/柱/.test(b.name)) b.name = '女兒牆（SketchUp）';
    classifyExterior(boxes);
    rep.walls = boxes.filter(b => b.layer === 'wall' && !/柱|窗台|窗楣|門楣|隔間牆下/.test(b.name)).length;
    for (const b of boxes) objects.push(b);
  }

  /** One wall (pair of faces) of a storey: an occupancy grid along the wall × cut height, read column by column. */
  function emitWall(pr: { phi: number; A: { iv: Iv[][] }; B: { iv: Iv[][] }; sA: number; sB: number; iv: Iv[][]; single?: boolean }, st: Storey, hs: number[], boxes: BoxObject[], rep: MeshFloorReport) {
    const K = hs.length, raw = pr.sA - pr.sB, th = Math.abs(raw - Math.round(raw)) < 0.3 ? Math.round(raw) : raw, c = (pr.sA + pr.sB) / 2;
    if (th < 5 && !pr.single) return;
    // junctions: where a cross wall butts in, one face goes on across the gap; openings break both faces
    const rows = pr.iv.map((l, k) => {
      const m = merge(l, 0.5), out: Iv[] = [];
      for (const v of m) {
        const last = out[out.length - 1];
        if (last && v.a - last.b <= 80 && (covers(pr.A.iv[k], last.b, v.a) || covers(pr.B.iv[k], last.b, v.a))) last.b = v.b;
        else out.push({ ...v });
      }
      return out;
    });
    let u0 = Infinity, u1 = -Infinity;
    for (const l of rows) for (const v of l) { u0 = Math.min(u0, v.a); u1 = Math.max(u1, v.b); }
    if (!isFinite(u0) || u1 - u0 < 10) return;
    const J = Math.ceil((u1 - u0) / CELL);
    const solid: Uint8Array[] = rows.map(l => {
      const r = new Uint8Array(J);
      for (const v of l) for (let j = Math.max(0, Math.floor((v.a - u0) / CELL + 0.5)); j < Math.min(J, Math.ceil((v.b - u0) / CELL - 0.5)); j++) r[j] = 1;
      return r;
    });
    // column signatures
    const sig: string[] = [];
    for (let j = 0; j < J; j++) {
      let cnt = 0, topS = -1;
      for (let k = 0; k < K; k++) if (solid[k][j]) { cnt++; topS = k; }
      if (cnt === K) { sig.push('S'); continue; }
      if (!cnt) { sig.push('E'); continue; }
      // the longest run of empty cuts
      let g0 = -1, g1 = -1;
      for (let k = 0; k < K;) {
        if (solid[k][j]) { k++; continue; }
        let e = k;
        while (e + 1 < K && !solid[e + 1][j]) e++;
        if (e - k > g1 - g0) { g0 = k; g1 = e; }
        k = e + 1;
      }
      sig.push(g1 === K - 1 ? `L:${topS}` : `O:${g0}:${g1}`);
    }
    // runs, with flicker shorter than 12 cm folded into a neighbour
    let runs: { s: string; j0: number; j1: number }[] = [];
    for (let j = 0; j < J; j++) {
      const r = runs[runs.length - 1];
      if (r && r.s === sig[j]) r.j1 = j + 1; else runs.push({ s: sig[j], j0: j, j1: j + 1 });
    }
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.j1 - r.j0 >= 6 || runs.length === 1) continue;
        const a = runs[i - 1], b = runs[i + 1];
        const to = a && b ? (a.s === b.s || a.j1 - a.j0 >= b.j1 - b.j0 ? a : b) : a || b;
        to.j0 = Math.min(to.j0, r.j0); to.j1 = Math.max(to.j1, r.j1);
        runs.splice(i, 1); i--; changed = true;
      }
      const m: typeof runs = [];
      for (const r of runs) { const l = m[m.length - 1]; if (l && l.s === r.s) l.j1 = r.j1; else m.push({ ...r }); }
      runs = m;
      if (!changed) break;
    }
    while (runs.length && runs[0].s === 'E') runs.shift();
    while (runs.length && runs[runs.length - 1].s === 'E') runs.pop();
    if (!runs.length) return;
    const maxTop = Math.max(...runs.map(r => r.s === 'S' ? K - 1 : r.s.startsWith('L') ? +r.s.split(':')[1] : r.s.startsWith('O') ? K - 1 : -1));
    if (hs[maxTop] + 5 - st.base < 30) return;
    // thin boards, door leaves, glass: not walls
    if (th < 8 && !pr.single && runs.every(r => r.s !== 'S')) return;
    const mx = Math.cos(pr.phi), mz = Math.sin(pr.phi);
    const at = (u: number) => ({ x: c * mx - u * mz, z: c * mz + u * mx });
    // wall height: to the next floor level (slab on top), or as drawn on the top storey
    let fullH = st.top ? Math.round(hs[K - 1] + 5 - st.base) : st.H;
    const ext = (side: 'lo' | 'hi') => {
      // a corner: the outer face runs on past the wall's end; grow to it (the cross wall gives way below)
      const u = side === 'lo' ? u0 : u1;
      let far = u;
      for (const pl of [pr.A, pr.B]) for (const l of pl.iv) for (const v of l) {
        if (side === 'lo' && v.a < u && v.b > u + 1 && u - v.a <= th + 2) far = Math.min(far, v.a);
        if (side === 'hi' && v.b > u && v.a < u - 1 && v.b - u <= th + 2) far = Math.max(far, v.b);
      }
      return Math.abs(far - u);
    };
    const eLo = ext('lo'), eHi = ext('hi');
    const tt = Math.max(th, pr.single ? 10 : th);
    const mk = (a: number, b: number, y: number, h: number, nm: string, layer: BoxObject['layer'] = 'wall', color = 0xeeebe5, thick = tt): BoxObject => {
      const p = at(a), q = at(b);
      const box = wallBox({ ax: p.x, az: p.z, bx: q.x, bz: q.z, t: thick }, Math.round(h), id++);
      return { ...box, layer, name: nm, y: Math.round((y - y0) * 10) / 10, color, floor: st.key };
    };
    const soffit = (a: number, b: number, y: number) => {
      let area = 0;
      for (const f of hz) {
        if (f.up || Math.abs(f.y - y) > 3) continue;
        const s = f.x * mx + f.z * mz, u = -f.x * mz + f.z * mx;
        if (s >= pr.sB - 1 && s <= pr.sA + 1 && u >= a - 1 && u <= b + 1) area += f.a;
      }
      return area;
    };
    const refine = (a: number, b: number, est: number) => {
      let best = 0, by = est;
      const h = new Map<number, number>();
      for (const f of hz) {
        // either way up: faces drawn back side out are common
        if (Math.abs(f.y - est) > 12) continue;
        const s = f.x * mx + f.z * mz, u = -f.x * mz + f.z * mx;
        if (s < pr.sB - 2 || s > pr.sA + 2 || u < a - 2 || u > b + 2) continue;
        const k = Math.round(f.y);
        h.set(k, (h.get(k) || 0) + f.a);
      }
      for (const [y, a2] of h) if (a2 > best) { best = a2; by = y; }
      return by;
    };
    if (st.top) fullH = Math.round(refine(u0, u1, hs[K - 1] + 5) - st.base);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      let a = u0 + r.j0 * CELL, b = u0 + r.j1 * CELL;
      if (i === 0) a -= eLo;
      if (i === runs.length - 1) b += eHi;
      const len = b - a;
      if (r.s === 'E') continue;
      const wallPiece = (h: number, nm: string) => {
        const box = mk(a, b, st.base, h, nm);
        boxes.push(box);
        const lo = i === 0 ? eLo : 0, hi = i === runs.length - 1 ? eHi : 0;
        if (lo || hi) ends.set(box, { a, b, lo, hi, at, remake: (p, q) => ({ ...mk(p, q, st.base, h, nm), id: box.id }) });
      };
      if (r.s === 'S') { wallPiece(st.top ? Math.round(refine(a, b, hs[K - 1] + 5) - st.base) : fullH, '牆'); continue; }
      if (r.s.startsWith('L')) {
        const h = Math.round(refine(a, b, hs[+r.s.split(':')[1]] + 5) - st.base);
        if (th > 30 && !st.roof) continue; // counters and benches are not walls
        wallPiece(h, h >= 200 ? '牆' : '矮牆');
        continue;
      }
      const [, g0s, g1s] = r.s.split(':'), g0 = +g0s, g1 = +g1s;
      const head = Math.min(fullH, refine(a, b, hs[g1] + 5) - st.base);
      const sill = g0 === 0 ? 0 : Math.max(0, refine(a, b, hs[g0] - 5) - st.base);
      const above = fullH - head;
      // nothing standing under it anywhere along the wall: a beam
      const beamOnly = runs.every(q => q.s.startsWith('O:0:') || q.s === 'E');
      if (g0 === 0 && (beamOnly || len > 300)) {
        // a beam has a soffit (a face looking down) under it; a stair seen from the side has treads instead
        if (above <= 0 || soffit(a, b, st.base + head) < 0.4 * len * th) continue;
        boxes.push(mk(a, b, st.base + head, above, '梁（SketchUp）', 'slab', 0xcfc9bd));
        rep.beams++;
        continue;
      }
      if (len < 20) { boxes.push(mk(a, b, st.base, fullH, '牆')); continue; }
      if (sill > 0) boxes.push(mk(a, b, st.base, sill, '窗台'));
      if (above > 0) boxes.push(mk(a, b, st.base + head, above, g0 === 0 ? '門楣' : '窗楣'));
      const axisX = Math.abs(Math.sin(pr.phi)) > 0.9999, axisZ = Math.abs(Math.cos(pr.phi)) > 0.9999;
      if (g0 === 0 && head >= 150 && (axisX || axisZ)) {
        // m along z (φ = 90°): the wall runs along x and u = −x
        const lo = axisX ? Math.min(-a, -b) : a, hi = axisX ? Math.max(-a, -b) : b;
        const d: DoorObject = { id: id++, layer: 'door', name: `門 ${Math.round(len)}×${Math.round(head)}（SketchUp）`, axis: axisX ? 'x' : 'z', at: Math.round(c * 10) / 10, a: Math.round(lo * 10) / 10, b: Math.round(hi * 10) / 10, flip: 0, color: 0x9a6a43, floor: st.key, y: Math.round(st.base - y0), h: Math.round(head) };
        objects.push(d);
        explained.push(mk(a, b, st.base, head, 'open', 'custom'));
        rep.doors++;
      } else {
        const g = mk(a, b, st.base + sill, head - sill, `${g0 === 0 ? '門' : '窗'} ${Math.round(len)}×${Math.round(head - sill)}（SketchUp）`, 'glass', 0xa9dcff, Math.min(6, tt));
        boxes.push(g);
        explained.push(mk(a, b, st.base + sill, head - sill, 'open', 'custom'));
        if (g0 === 0) rep.doors++; else rep.windows++;
      }
    }
  }

  /** Short thick wall pieces that overlap (a column has four faces, so both directions pair up) become one column. */
  function groupColumns(boxes: BoxObject[], rep: MeshFloorReport) {
    const cand = boxes.filter(b => b.layer === 'wall' && b.name === '牆' && Math.min(b.w, b.d) >= 20 && Math.max(b.w, b.d) <= 120);
    const corners = (b: BoxObject) => {
      const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => { const lx = i * b.w / 2, lz = j * b.d / 2; return { x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c }; });
    };
    const overlap = (p: BoxObject, q: BoxObject) => {
      const tp = footprintTest({ ...p, w: p.w + 2, d: p.d + 2 }), tq = footprintTest({ ...q, w: q.w + 2, d: q.d + 2 });
      return corners(q).some(k => tp(k.x, k.z)) || corners(p).some(k => tq(k.x, k.z)) || tp(q.x, q.z);
    };
    const used = new Set<BoxObject>();
    for (const b of cand) {
      if (used.has(b)) continue;
      const grp = [b];
      for (let i = 0; i < grp.length; i++) for (const q of cand) if (!used.has(q) && !grp.includes(q) && overlap(grp[i], q)) grp.push(q);
      const both = grp.some(q => Math.abs(Math.sin((q.rot || 0) - (b.rot || 0))) > 0.7 || (q.w > q.d) !== (b.w > b.d));
      if (!both && Math.max(b.w, b.d) > Math.min(b.w, b.d) * 2.5) continue;
      for (const q of grp) used.add(q);
      // in the first piece's frame
      const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const q of grp) for (const k of corners(q)) {
        const dx = k.x - b.x, dz = k.z - b.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
        x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); z0 = Math.min(z0, lz); z1 = Math.max(z1, lz);
      }
      const mxl = (x0 + x1) / 2, mzl = (z0 + z1) / 2;
      const col: BoxObject = { ...b, id: b.id, name: '柱（SketchUp）', x: Math.round((b.x + mxl * c + mzl * s) * 10) / 10, z: Math.round((b.z - mxl * s + mzl * c) * 10) / 10, w: Math.round(x1 - x0), d: Math.round(z1 - z0), h: Math.max(...grp.map(q => q.h)) };
      for (const q of grp) boxes.splice(boxes.indexOf(q), 1);
      boxes.push(col);
      rep.columns++;
    }
  }

  // ---------- plan frame: the building's corner at (0, 0) ----------
  const shift = (o: ModelObject) => {
    if (o.layer === 'door') { if (o.axis === 'x') { o.at = r1(o.at - oz); o.a = r1(o.a - ox); o.b = r1(o.b - ox); } else { o.at = r1(o.at - ox); o.a = r1(o.a - oz); o.b = r1(o.b - oz); } }
    else { o.x = r1(o.x - ox); o.z = r1(o.z - oz); }
  };
  objects.forEach(shift);
  explained.forEach(shift);

  /** Which cells of a plan grid lie outside the building (reached from the border without crossing walls). */
  function classifyExterior(boxes: BoxObject[]) {
    const C = 10, M = 60, nx = Math.ceil((W + 2 * M) / C), nz = Math.ceil((D + 2 * M) / C);
    const wall = new Uint8Array(nx * nz);
    const walls = boxes.filter(b => b.layer === 'wall' || b.layer === 'glass');
    for (const b of walls) {
      const o = { ...b, x: b.x - ox, z: b.z - oz, w: Math.max(b.w, C + 1), d: Math.max(b.d, C + 1) };
      const test = footprintTest(o), r = Math.hypot(o.w, o.d) / 2;
      for (let j = Math.max(0, Math.floor((o.z - r + M) / C)); j <= Math.min(nz - 1, Math.ceil((o.z + r + M) / C)); j++)
        for (let i = Math.max(0, Math.floor((o.x - r + M) / C)); i <= Math.min(nx - 1, Math.ceil((o.x + r + M) / C)); i++)
          if (test(-M + (i + .5) * C, -M + (j + .5) * C)) wall[j * nx + i] = 1;
    }
    const out = new Uint8Array(nx * nz), q: number[] = [0];
    out[0] = 1;
    while (q.length) {
      const v = q.pop()!, i = v % nx, j = (v - i) / nx;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const w = b * nx + a;
        if (out[w] || wall[w]) continue;
        out[w] = 1; q.push(w);
      }
    }
    const outside = (x: number, z: number) => {
      const i = Math.floor((x - ox + M) / C), j = Math.floor((z - oz + M) / C);
      return i < 0 || j < 0 || i >= nx || j >= nz || !!out[j * nx + i];
    };
    for (const b of boxes) {
      if (b.layer !== 'wall' || /柱/.test(b.name)) continue;
      const along = b.w >= b.d, th = Math.min(b.w, b.d), c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
      // the two sides of the wall, 15 cm out
      const off = th / 2 + 15, nxl = along ? 0 : 1, nzl = along ? 1 : 0;
      const p1 = { x: b.x + (nxl * off) * c + (nzl * off) * s, z: b.z - (nxl * off) * s + (nzl * off) * c };
      const p2 = { x: b.x - (nxl * off) * c - (nzl * off) * s, z: b.z + (nxl * off) * s - (nzl * off) * c };
      const ext = outside(p1.x, p1.z) || outside(p2.x, p2.z);
      const base = b.name;
      if (/女兒牆/.test(base)) { b.wall = 'rc'; continue; }
      if (ext) { b.wall = 'rc'; b.name = base === '牆' ? '外牆（SketchUp）' : base === '矮牆' ? '矮牆（SketchUp，外側）' : `${base}（SketchUp）`; }
      else if (th >= 18) { b.wall = 'rc'; b.name = base === '牆' ? 'RC牆（SketchUp）' : `${base}（SketchUp）`; }
      else { b.wall = 'light'; b.name = base === '牆' ? '隔間牆（SketchUp）' : base === '窗台' ? '隔間牆下（SketchUp）' : base === '窗楣' || base === '門楣' ? '隔間門楣（SketchUp）' : `${base}（SketchUp）`; }
    }
  }

  // ---------- slabs: upward faces at each level, plus the walls standing on it ----------
  const C = 10, nx = Math.ceil(W / C) + 1, nz = Math.ceil(D / C) + 1;
  const insideTri = (i: number, x: number, z: number) => {
    const o = i * 9, ax = P[o] - ox, az = P[o + 2] - oz, bx = P[o + 3] - ox, bz = P[o + 5] - oz, qx = P[o + 6] - ox, qz = P[o + 8] - oz;
    const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - qx) * (bz - qz) - (bx - qx) * (z - qz), d3 = (x - ax) * (qz - az) - (qx - ax) * (z - az);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  levels.forEach((L, li) => {
    const st = storeys[li];
    const below = storeys[li - 1];
    const mask = new Uint8Array(nx * nz);
    for (const i of upTris) {
      if (Math.abs(cy(i) - L.y) > 4) continue;
      const o = i * 9, xs = [P[o], P[o + 3], P[o + 6]].map(v => v - ox), zs = [P[o + 2], P[o + 5], P[o + 8]].map(v => v - oz);
      for (let j = Math.max(0, Math.floor(Math.min(...zs) / C)); j <= Math.min(nz - 1, Math.ceil(Math.max(...zs) / C)); j++)
        for (let k = Math.max(0, Math.floor(Math.min(...xs) / C)); k <= Math.min(nx - 1, Math.ceil(Math.max(...xs) / C)); k++)
          if (insideTri(i, (k + .5) * C, (j + .5) * C)) mask[j * nx + k] = 1;
    }
    const stand = [...(storeyBoxes.get(st.key) || []), ...(below ? (storeyBoxes.get(below.key) || []).filter(b => b.y + b.h >= L.y - y0 - 5) : [])];
    const hasFaces = mask.some(v => v);
    for (const b of stand) {
      if (b.layer !== 'wall') continue;
      const test = footprintTest(b), r = Math.hypot(b.w, b.d) / 2;
      for (let j = Math.max(0, Math.floor((b.z - r) / C)); j <= Math.min(nz - 1, Math.ceil((b.z + r) / C)); j++)
        for (let k = Math.max(0, Math.floor((b.x - r) / C)); k <= Math.min(nx - 1, Math.ceil((b.x + r) / C)); k++)
          if (test((k + .5) * C, (j + .5) * C)) mask[j * nx + k] = 1;
    }
    // small gaps between faces and walls are slab too; big ones (stair wells, voids) stay open; with no floor faces at all, the floor is everything inside the walls
    fillHoles(mask, nx, nz, hasFaces ? 150 : Infinity);
    let area = 0;
    for (const rc of rectangles(mask, nx, nz)) {
      const x0 = rc.i0 * C, x1 = Math.min(W, rc.i1 * C), z0 = rc.j0 * C, z1 = Math.min(D, rc.j1 * C);
      if (x1 - x0 < 5 || z1 - z0 < 5) continue;
      const nm = st.roof ? '屋頂板（SketchUp）' : li === 0 ? '地坪（SketchUp）' : '樓板（SketchUp）';
      const box: BoxObject = { id: id++, layer: 'slab', name: nm, x: r1((x0 + x1) / 2), z: r1((z0 + z1) / 2), w: r1(x1 - x0), d: r1(z1 - z0), h: L.t, y: r1(L.y - y0 - L.t), color: 0xd6d1c7, floor: st.key };
      objects.push(box);
      area += box.w * box.d / 1e4;
      reports[li].slabs++;
    }
    reports[li].slabArea = Math.round(area * 100) / 100;
  });

  // ---------- stairs: a run of small treads climbing by an even rise ----------
  storeys.forEach((st, si) => {
    const next = storeys[si + 1];
    if (!next) return;
    const byY = new Map<number, { x0: number; x1: number; z0: number; z1: number; a: number; sx: number; sz: number }>();
    for (let i = 0; i < T; i++) {
      if ((role[i] !== R_STRUCT && role[i] !== R_STAIR) || !isHorz(i) || N[i * 3 + 1] < 0) continue;
      const y = cy(i);
      if (y < st.base + 8 || y > next.base - 3) continue;
      const k = Math.round(y), o = i * 9;
      const b = byY.get(k) || { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, a: 0, sx: 0, sz: 0 };
      for (let v = 0; v < 3; v++) { b.x0 = Math.min(b.x0, P[o + v * 3]); b.x1 = Math.max(b.x1, P[o + v * 3]); b.z0 = Math.min(b.z0, P[o + v * 3 + 2]); b.z1 = Math.max(b.z1, P[o + v * 3 + 2]); }
      b.a += A[i]; b.sx += A[i] * cx(i); b.sz += A[i] * cz(i);
      byY.set(k, b);
    }
    const ts = [...byY].map(([y, b]) => ({ y, ...b, cx: b.sx / b.a, cz: b.sz / b.a })).filter(t => t.a <= 4e4 && t.x1 - t.x0 <= 400 && t.z1 - t.z0 <= 400).sort((a, b) => a.y - b.y);
    // the longest chain of treads with an even rise, each next to the one below
    let best: typeof ts = [];
    for (let i = 0; i < ts.length; i++) {
      const ch = [ts[i]];
      for (let j = i + 1; j < ts.length; j++) {
        const p = ch[ch.length - 1], q = ts[j], rise = q.y - p.y;
        if (rise < 12) continue;
        if (rise > 23) break;
        if (ch.length > 1 && Math.abs(rise - (p.y - ch[ch.length - 2].y)) > 2.5) continue;
        if (Math.hypot(q.cx - p.cx, q.cz - p.cz) > 160) continue;
        ch.push(q);
      }
      if (ch.length > best.length) best = ch;
    }
    if (best.length < 5) return;
    const rises = best.slice(1).map((t, i) => t.y - best[i].y).sort((a, b) => a - b), rise = rises[rises.length >> 1];
    const areas = best.map(t => t.a).sort((a, b) => a - b), med = areas[areas.length >> 1];
    const landing = best.filter(t => t.a > med * 1.8);
    const steps = best.filter(t => t.a <= med * 1.8);
    const runs = steps.slice(1).map((t, i) => Math.hypot(t.cx - steps[i].cx, t.cz - steps[i].cz)).filter(d => d > 10 && d < 45).sort((a, b) => a - b);
    const run = runs.length ? runs[runs.length >> 1] : 25;
    const width = steps.map(t => Math.max(t.x1 - t.x0, t.z1 - t.z0)).sort((a, b) => a - b)[steps.length >> 1];
    const risers = Math.round((next.base - st.base) / rise);
    const info = { risers, flights: landing.length ? 2 : 1, width: Math.round(width), run: Math.round(run), rise: Math.round(rise * 10) / 10, landing: Math.round(landing.reduce((s, t) => s + t.a, 0) / 100) / 100 };
    best.forEach((t, i) => {
      const box: BoxObject = { id: id++, layer: 'stair', name: landing.includes(t) ? '樓梯平台（SketchUp）' : '樓梯踏階（SketchUp）', x: r1((t.x0 + t.x1) / 2 - ox), z: r1((t.z0 + t.z1) / 2 - oz), w: r1(t.x1 - t.x0), d: r1(t.z1 - t.z0), h: r1(Math.min(rise, t.y - st.base)), y: r1(t.y - y0 - Math.min(rise, t.y - st.base)), color: 0xd9d4ca, floor: st.key, rise, ...(i ? {} : { stair: info }) };
      objects.push(box);
    });
    reports[si].stairs = (reports[si].stairs || 0) + 1;
  });

  // ---------- what the members do not explain stays as mesh ----------
  const all = [...objects.filter((o): o is BoxObject => o.layer !== 'door'), ...explained];
  const G = 200, index = new Map<string, BoxObject[]>();
  for (const b of all) {
    const r = Math.hypot(b.w, b.d) / 2 + 3;
    for (let i = Math.floor((b.x - r) / G); i <= Math.floor((b.x + r) / G); i++) for (let j = Math.floor((b.z - r) / G); j <= Math.floor((b.z + r) / G); j++) {
      const k = `${i},${j}`;
      if (!index.has(k)) index.set(k, []);
      index.get(k)!.push(b);
    }
  }
  const tests = new Map<BoxObject, (x: number, z: number) => boolean>();
  const covered = (x: number, y: number, z: number) => {
    for (const b of index.get(`${Math.floor(x / G)},${Math.floor(z / G)}`) || []) {
      if (y < b.y - 1.5 || y > b.y + b.h + 1.5) continue;
      let f = tests.get(b);
      if (!f) { f = footprintTest({ ...b, w: b.w + 3, d: b.d + 3 }); tests.set(b, f); }
      if (f(x, z)) return true;
    }
    return false;
  };
  const storeyOf = (y: number) => { let k = storeys[0].key; for (const s of storeys) if (y >= s.base - y0 - 1) k = s.key; return k; };
  const buckets = new Map<string, { floor: string; color: number; opacity: number; tri: number[] }>();
  let kept = 0, furniture = 0;
  for (let i = 0; i < T; i++) {
    const x = cx(i) - ox, y = cy(i) - y0, z = cz(i) - oz;
    if (covered(x, y, z)) continue;
    const p = parts[partOf[i]], fl = storeyOf(y), key = `${fl}|${p.color}|${p.opacity ?? 1}`;
    let bk = buckets.get(key);
    if (!bk) { bk = { floor: fl, color: p.color, opacity: p.opacity ?? 1, tri: [] }; buckets.set(key, bk); }
    for (let k = 0; k < 3; k++) bk.tri.push(P[i * 9 + k * 3] - ox, P[i * 9 + k * 3 + 1] - y0, P[i * 9 + k * 3 + 2] - oz);
    kept++;
    if (role[i] === R_FURN) furniture++;
  }
  const meshes: CadMesh[] = [...buckets.values()].map(b => ({ floor: b.floor, color: b.color, ...(b.opacity < 1 ? { opacity: b.opacity } : {}), ...packMesh(b.tri) }));

  // ---------- storeys for the floor switcher, plan cut lines, room names ----------
  for (const st of storeys) {
    const cut = cutAt(st.base + Math.min(120, Math.max(10, st.H / 2)), [...Array(T).keys()].filter(i => isVert(i)));
    const segs: number[] = [];
    for (const c of cut) segs.push(r1(c.x1 - ox), r1(c.z1 - oz), r1(c.x2 - ox), r1(c.z2 - oz));
    const fl: CadFloor = { key: st.key, title: `${st.key}（SketchUp）`, y: Math.round(st.base - y0), h: Math.round(st.roof ? Math.max(st.H, 0) : st.H), segs, texts: [] };
    // a roof deck is not a room: no indoor finishes there
    fl.texts = st.roof ? [] : roomNames(objects.filter(o => o.floor === st.key), W, D);
    floorsOut.push(fl);
  }

  return {
    objects,
    cad: { name, W: r1(W), D: r1(D), segs: [], texts: [], doors: [], floors: floorsOut, meshes },
    report: { floors: reports, triangles: T, kept, furniture, singleFace },
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function merge(l: Iv[], tol: number): Iv[] {
  const s = l.slice().sort((a, b) => a.a - b.a), out: Iv[] = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v.a <= last.b + tol) last.b = Math.max(last.b, v.b); else out.push({ ...v });
  }
  return out;
}
function intersect(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const x of a) for (const y of b) { const lo = Math.max(x.a, y.a), hi = Math.min(x.b, y.b); if (hi - lo > 0.5) out.push({ a: lo, b: hi }); }
  return out;
}
function subtract(a: Iv[], b: Iv[]): Iv[] {
  let cur = a.slice();
  for (const y of b) {
    const nxt: Iv[] = [];
    for (const x of cur) {
      if (y.b <= x.a || y.a >= x.b) { nxt.push(x); continue; }
      if (y.a - x.a > 0.5) nxt.push({ a: x.a, b: y.a });
      if (x.b - y.b > 0.5) nxt.push({ a: y.b, b: x.b });
    }
    cur = nxt;
  }
  return cur;
}
const covers = (l: Iv[], a: number, b: number) => l.some(v => v.a <= a + 1 && v.b >= b - 1);

/** Fills enclosed empty regions of the grid up to `maxCells` cells. */
function fillHoles(mask: Uint8Array, nx: number, nz: number, maxCells: number) {
  const seen = new Uint8Array(nx * nz);
  for (let s = 0; s < nx * nz; s++) {
    if (mask[s] || seen[s]) continue;
    const comp: number[] = [s], q = [s];
    seen[s] = 1;
    let border = false;
    while (q.length) {
      const v = q.pop()!, i = v % nx, j = (v - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) border = true;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const w = b * nx + a;
        if (mask[w] || seen[w]) continue;
        seen[w] = 1; q.push(w); comp.push(w);
      }
    }
    if (!border && comp.length <= maxCells) for (const v of comp) mask[v] = 1;
  }
}

/** Greedy cover of the filled cells by rectangles (cell index ranges, end exclusive). */
function rectangles(mask: Uint8Array, nx: number, nz: number) {
  const left = mask.slice(), out: { i0: number; i1: number; j0: number; j1: number }[] = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!left[j * nx + i]) continue;
    let i1 = i;
    while (i1 < nx && left[j * nx + i1]) i1++;
    let j1 = j + 1;
    while (j1 < nz) {
      let ok = true;
      for (let k = i; k < i1; k++) if (!left[j1 * nx + k]) { ok = false; break; }
      if (!ok) break;
      j1++;
    }
    for (let b = j; b < j1; b++) for (let k = i; k < i1; k++) left[b * nx + k] = 0;
    out.push({ i0: i, i1, j0: j, j1 });
  }
  return out;
}

/** Room names for the takeoff: each closed space of a storey gets 空間 1, 空間 2 … at a point inside it. */
function roomNames(objs: ModelObject[], W: number, D: number): CadText[] {
  const C = 10, M = 60, nx = Math.ceil((W + 2 * M) / C), nz = Math.ceil((D + 2 * M) / C), R = 5;
  const wall = new Uint8Array(nx * nz);
  for (const o of objs) {
    if (o.layer === 'door' || (o.layer !== 'wall' && o.layer !== 'glass')) continue;
    const b = { ...o, w: o.w + 2 * R * C, d: o.d + 2 * R * C };
    const test = footprintTest(b), r = Math.hypot(b.w, b.d) / 2;
    for (let j = Math.max(0, Math.floor((o.z - r + M) / C)); j <= Math.min(nz - 1, Math.ceil((o.z + r + M) / C)); j++)
      for (let i = Math.max(0, Math.floor((o.x - r + M) / C)); i <= Math.min(nx - 1, Math.ceil((o.x + r + M) / C)); i++)
        if (test(-M + (i + .5) * C, -M + (j + .5) * C)) wall[j * nx + i] = 1;
  }
  const seen = new Uint8Array(nx * nz), out: CadText[] = [];
  for (let s = 0; s < nx * nz; s++) {
    if (wall[s] || seen[s]) continue;
    const comp: number[] = [], q = [s];
    seen[s] = 1;
    let border = false;
    while (q.length) {
      const v = q.pop()!, i = v % nx, j = (v - i) / nx;
      comp.push(v);
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) border = true;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const w = b * nx + a;
        if (wall[w] || seen[w]) continue;
        seen[w] = 1; q.push(w);
      }
    }
    if (border || comp.length * C * C < 0.5e4) continue;
    // the cell nearest the middle of the space
    let sx = 0, sz = 0;
    for (const v of comp) { sx += v % nx; sz += Math.floor(v / nx); }
    sx /= comp.length; sz /= comp.length;
    let best = comp[0], bd = Infinity;
    for (const v of comp) { const d = (v % nx - sx) ** 2 + (Math.floor(v / nx) - sz) ** 2; if (d < bd) { bd = d; best = v; } }
    out.push({ x: -M + (best % nx + .5) * C, z: -M + (Math.floor(best / nx) + .5) * C, s: '' });
  }
  out.sort((a, b) => a.z - b.z || a.x - b.x);
  out.forEach((t, i) => { t.s = `空間${i + 1}`; });
  return out;
}

/** Triangle soup → shared vertices on a 1 cm grid, base64 (Int16 positions, Uint16/Uint32 indices). */
export function packMesh(tri: number[]): { pos: string; idx: string; wide?: boolean } {
  const map = new Map<string, number>(), pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < tri.length; i += 3) {
    const x = Math.max(-32767, Math.min(32767, Math.round(tri[i]))), y = Math.max(-32767, Math.min(32767, Math.round(tri[i + 1]))), z = Math.max(-32767, Math.min(32767, Math.round(tri[i + 2])));
    const k = `${x},${y},${z}`;
    let v = map.get(k);
    if (v === undefined) { v = pos.length / 3; map.set(k, v); pos.push(x, y, z); }
    idx.push(v);
  }
  // drop triangles that collapsed on the grid
  const keep: number[] = [];
  for (let i = 0; i < idx.length; i += 3) if (idx[i] !== idx[i + 1] && idx[i + 1] !== idx[i + 2] && idx[i] !== idx[i + 2]) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  const wide = pos.length / 3 > 65535;
  return { pos: b64(new Uint8Array(new Int16Array(pos).buffer)), idx: b64(new Uint8Array((wide ? new Uint32Array(keep) : new Uint16Array(keep)).buffer)), ...(wide ? { wide } : {}) };
}
export function unpackMesh(m: CadMesh): { pos: Float32Array; idx: Uint16Array | Uint32Array } {
  const p = unb64(m.pos), q = unb64(m.idx);
  const pos = Float32Array.from(new Int16Array(p.buffer, p.byteOffset, p.byteLength / 2));
  const idx = m.wide ? new Uint32Array(q.buffer, q.byteOffset, q.byteLength / 4) : new Uint16Array(q.buffer, q.byteOffset, q.byteLength / 2);
  return { pos, idx };
}
function b64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** The parts of a baked SketchUp scene (openskp `buildScene`: metres, glTF Y-up) in plan cm. */
export interface SkpSceneLike {
  glbPrimitives: { positions: Float32Array; indices: Uint32Array; materialIndex: number; geomName: string }[];
  meshIndex: Record<string, { name: string; definitionName: string; layer: string; path: string }>;
  gltfMaterials: unknown[];
}
export function partsFromSkpScene(sc: SkpSceneLike): MeshPart[] {
  return sc.glbPrimitives.map(p => {
    const meta = sc.meshIndex[p.geomName];
    const mat = sc.gltfMaterials[p.materialIndex] as { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } } | undefined;
    const f = mat?.pbrMetallicRoughness?.baseColorFactor || [0.85, 0.85, 0.85, 1];
    // openskp gives the colour as 0–1 of the 0–255 value; unpainted faces come as (255, 84, 84)
    const g = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
    const plain = g(f[0]) === 255 && g(f[1]) === 84 && g(f[2]) === 84;
    const pos = new Float32Array(p.indices.length * 3);
    for (let i = 0; i < p.indices.length; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = p.positions[p.indices[i] * 3 + k] * 100;
    return {
      name: [meta?.name, meta?.definitionName, meta?.layer, meta?.path, mat?.name].filter(Boolean).join(' '),
      color: plain ? 0xe8e6e1 : (g(f[0]) << 16) | (g(f[1]) << 8) | g(f[2]),
      opacity: f[3] ?? 1,
      solid: meta?.path || p.geomName,
      def: meta?.definitionName,
      pos,
    };
  });
}
