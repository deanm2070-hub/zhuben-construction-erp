import type { DxfDrawing } from './dxf';
import { footprintTest, pairWalls, wallBox } from './geometry';
import type { BoxObject, CadData, ModelObject } from './types';

export type LayerKind = 'wall' | 'furn' | 'line' | 'off';
export const UNIT_SCALE: Record<number, number> = { 1: 2.54, 2: 30.48, 4: 0.1, 5: 1, 6: 100 };
export const UNIT_NAME: Record<number, string> = { 4: '公釐 mm', 5: '公分 cm', 6: '公尺 m', 1: '英吋 inch', 2: '英尺 ft' };

export function guessLayerKind(name: string): LayerKind {
  if (/WALL|牆|壁|COLS|COLUMN|柱/i.test(name)) return 'wall';
  if (/FURN|家具|傢俱|CASE|櫃|EQPM|FIXT|PLMB|衛浴|BED|SOFA|CHAIR/i.test(name)) return 'furn';
  if (/DIM|標註|尺寸|HATCH|AXIS|GRID|軸|DEFPOINTS|VIEWPORT/i.test(name)) return 'off';
  return 'line';
}

/** Units code to use: the header value when known, otherwise a guess from the drawing extent. */
export function guessUnits(dxf: DxfDrawing): number {
  if (UNIT_SCALE[dxf.units]) {
    // a header saying millimetres over text a few centimetres high is a centimetre drawing (text is drawn ~3 mm tall at paper scale)
    const hs = dxf.texts.map(t => t.h || 0).filter(h => h > 0).sort((a, b) => a - b);
    return dxf.units === 4 && hs.length >= 50 && hs[Math.floor(hs.length / 2)] < 150 ? 5 : dxf.units;
  }
  // no header: text is drawn about 2–5 mm tall on paper, so at 1:100 – 1:200 it is 20–100 units in a centimetre drawing
  // and 200–1000 in a millimetre one (a sheet set spread over a large area otherwise looks like millimetres by its size)
  const hs = dxf.texts.map(t => t.h || 0).filter(h => h > 0).sort((a, b) => a - b);
  if (hs.length >= 50) {
    const h = hs[Math.floor(hs.length / 2)];
    if (h >= 5 && h < 150) return 5;
    if (h >= 150 && h < 1500) return 4;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of dxf.segs) for (const p of [s.a, s.b]) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const ext = Math.max(maxX - minX, maxY - minY) || 0;
  return ext > 30000 ? 4 : ext < 200 ? 6 : 5;
}

export interface CadBuildResult {
  objects: ModelObject[];
  cad: CadData;
  stats: { walls: number; singleWalls: number; doors: number; windows: number; furniture: number };
}

/** Builds 3D objects from a parsed drawing. `map` says what each layer becomes; `scale` converts drawing units to cm. */
export function buildFromDxf(dxf: DxfDrawing, map: Record<string, LayerKind>, scale: number, wallH: number, name: string, firstId = 1): CadBuildResult | null {
  let id = firstId;
  const inc = (l: string) => !!map[l] && map[l] !== 'off';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of dxf.segs) if (inc(s.layer)) for (const p of [s.a, s.b]) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!isFinite(minX)) return null;
  const X = (x: number) => (x - minX) * scale, Z = (y: number) => (maxY - y) * scale;
  const W = (maxX - minX) * scale, D = (maxY - minY) * scale;

  const walls = pairWalls(dxf.segs.filter(s => map[s.layer] === 'wall').map(s => ({ x1: X(s.a[0]), z1: Z(s.a[1]), x2: X(s.b[0]), z2: Z(s.b[1]) })));
  const objs: ModelObject[] = walls.map(w => wallBox(w, wallH, id++));
  const wallObjs = objs as BoxObject[];

  let furniture = 0;
  for (const p of dxf.polys) {
    if (map[p.layer] !== 'furn' || !p.closed || p.pts.length < 3) continue;
    const px = p.pts.map(q => X(q[0])), pz = p.pts.map(q => Z(q[1]));
    const x0 = Math.min(...px), x1 = Math.max(...px), z0 = Math.min(...pz), z1 = Math.max(...pz), w = x1 - x0, d = z1 - z0;
    if (w < 15 || d < 15 || w > 800 || d > 800) continue;
    const cab = /CASE|櫃/i.test(p.layer), plmb = /PLMB|衛浴/i.test(p.layer);
    const h = cab ? (Math.min(w, d) <= 70 ? 210 : 90) : plmb ? 60 : Math.max(w, d) <= 60 ? 45 : Math.max(w, d) >= 180 && Math.min(w, d) >= 90 ? 50 : 75;
    const kind = cab ? '櫃體' : plmb ? (Math.max(w, d) <= 50 ? '馬桶' : '洗手台') : '家具';
    objs.push({ id: id++, layer: cab ? 'cabinet' : plmb ? 'bath' : 'furniture', name: `${kind}（${p.layer}）`, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w, d, h, y: 0, color: cab ? 0xc98a4b : plmb ? 0xffffff : 0x6f7d93 });
    furniture++;
  }

  // doors: quarter arcs on door layers, radius = leaf width
  const doors = dxf.arcs.filter(a => inc(a.layer) && /DOOR|門/i.test(a.layer) && a.sweep > 70 && a.sweep < 110 && a.r * scale >= 50 && a.r * scale <= 200)
    .map(a => ({ x: X(a.c[0]), z: Z(a.c[1]), w: Math.round(a.r * scale) }));

  // windows: lines on window layers; parallel double lines count once
  const used: { mx: number; mz: number; len: number }[] = [];
  for (const s of dxf.segs) {
    if (!inc(s.layer) || !/WIN|窗/i.test(s.layer)) continue;
    const x1 = X(s.a[0]), z1 = Z(s.a[1]), x2 = X(s.b[0]), z2 = Z(s.b[1]);
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 40) continue;
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    if (used.some(u => Math.hypot(u.mx - mx, u.mz - mz) < 40 && Math.abs(u.len - len) < 20)) continue;
    used.push({ mx, mz, len });
    const host = wallObjs.find(o => footprintTest(o)(mx, mz));
    const t = host ? Math.min(host.w, host.d) + 2 : 6, horiz = Math.abs(x2 - x1) >= Math.abs(z2 - z1);
    const ang = Math.atan2(-(z2 - z1), x2 - x1), axis = Math.abs(Math.sin(ang)) < 2e-3 || Math.abs(Math.cos(ang)) < 2e-3;
    objs.push({ id: id++, layer: 'glass', name: `窗 ${Math.round(len)}×150（CAD）`, x: mx, z: mz, w: axis ? (horiz ? len : t) : len, d: axis ? (horiz ? t : len) : t, h: 150, y: 90, rot: axis ? 0 : ang, color: 0xa9dcff });
  }

  const segs: number[] = [];
  for (const s of dxf.segs) if (map[s.layer] === 'line' || map[s.layer] === 'furn') segs.push(X(s.a[0]), Z(s.a[1]), X(s.b[0]), Z(s.b[1]));
  const texts = dxf.texts.filter(t => inc(t.layer) && t.s.length <= 24).map(t => ({ x: X(t.x), z: Z(t.y), s: t.s }));
  return {
    objects: objs,
    cad: { name, W, D, segs, texts, doors },
    stats: { walls: walls.length, singleWalls: walls.filter(w => w.single).length, doors: doors.length, windows: used.length, furniture },
  };
}
