import { mergeCoplanar } from '@cloud-modeler/core';

type Part = { name: string; floor: string; layer: string; color: number; opacity: number; tris: Float32Array };

/** what each model layer is called as a SketchUp tag */
const LAYER_NAME: Record<string, string> = {
  wall: '牆柱', glass: '門窗', door: '門窗', slab: '樓板', stair: '樓梯', rail: '欄杆', beam: '梁', furniture: '家具設備', floor: '地坪',
};
const CM_PER_INCH = 2.54;

/**
 * Writes the model as a SketchUp .skp file (SketchUp 2013–2020 format, opened by every later version) with the
 * open-source openskp writer. Each object is a group named after it; tags (layers) are per floor and per kind
 * (1F 牆柱, 1F 門窗 …) so floors and trades can be switched off in SketchUp. Coplanar triangles are joined back into
 * faces so walls and slabs show clean outlines. Units: plan cm become SketchUp inches internally (SketchUp shows them
 * in whatever unit the template uses); the model's Y-up becomes SketchUp's Z-up.
 */
export async function buildSkp(parts: Part[]): Promise<Uint8Array> {
  const { create } = await import('openskp');
  const b = create();
  const mats = new Map<string, number>(), tags = new Map<string, number>();
  const matOf = (c: number, op: number) => {
    const k = `${c}|${op.toFixed(2)}`;
    let id = mats.get(k);
    if (id === undefined) {
      id = b.addMaterial(`色${mats.size + 1}_${c.toString(16).padStart(6, '0')}`, [(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], op < 1 ? op : undefined);
      mats.set(k, id);
    }
    return id;
  };
  const tagOf = (floor: string, layer: string) => {
    const k = `${floor ? `${floor} ` : ''}${LAYER_NAME[layer] || '其他'}`;
    let id = tags.get(k);
    if (id === undefined) { id = b.addLayer(k); tags.set(k, id); }
    return id;
  };
  // the writer wants every material, then every tag, before any geometry
  for (const p of parts) matOf(p.color, p.opacity);
  for (const p of parts) tagOf(p.floor, p.layer);
  // inches, Z up: (x, y, z) → (x, -z, y)
  const conv = (p: number[]): [number, number, number] => [p[0] / CM_PER_INCH, -p[2] / CM_PER_INCH, p[1] / CM_PER_INCH];
  let faces = 0;
  for (const p of parts) {
    const polys = mergeCoplanar(p.tris);
    if (!polys.length) continue;
    const material = matOf(p.color, p.opacity), layer = tagOf(p.floor, p.layer);
    b.addGroup(def => {
      for (const poly of polys) {
        // (x, y, z) → (x, -z, y) mirrors nothing (it is a rotation), so the winding and front side are kept
        try { def.addFace(poly.map(conv), { material, layer, autoTriangulate: true }); faces++; } catch { /* a sliver too small for SketchUp */ }
      }
    }, { name: p.name.slice(0, 60), layer });
  }
  if (!faces) throw new Error('模型裡沒有可匯出的面');
  return b.toBytes();
}
