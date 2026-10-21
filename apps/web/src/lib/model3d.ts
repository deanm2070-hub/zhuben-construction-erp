import { partsFromSkpScene, type MeshPart } from '@cloud-modeler/core';
import * as THREE from 'three';

/** 3D model files the importer reads: SketchUp itself, and the formats SketchUp exports. */
export const MODEL_EXT = /\.(skp|dae|obj|glb|gltf|fbx|stl)$/i;
export const isModelFile = (f: File) => MODEL_EXT.test(f.name);

/**
 * Reads a SketchUp .skp (SketchUp 2013 and later, with the open-source openskp reader)
 * or an exported .dae / .obj / .glb / .fbx / .stl into mesh parts in plan cm.
 * The readers are only downloaded when a model is opened.
 */
export async function readModel3d(f: File): Promise<MeshPart[]> {
  const ext = (MODEL_EXT.exec(f.name)?.[1] || '').toLowerCase();
  const buf = await f.arrayBuffer();
  if (ext === 'skp') {
    const { buildScene } = await import('openskp');
    let scene;
    try { scene = buildScene(buf, { respectEdgeVisibility: true }); }
    catch (e) { throw new Error(/legacy/i.test((e as Error).message) ? '這個 .skp 是很舊的版本（SketchUp 2013 以前）讀不到，請在 SketchUp 另存為 2017 以後的版本，或匯出 .dae' : `SketchUp 檔讀取失敗（${(e as Error).message.slice(0, 80)}）`); }
    return partsFromSkpScene(scene);
  }
  let root: THREE.Object3D;
  // metres for glTF and Collada (the loader applies the file's unit); OBJ / FBX / STL carry no unit and are guessed from the size
  let known = true;
  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    root = (await new GLTFLoader().parseAsync(buf, '')).scene;
  } else if (ext === 'dae') {
    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
    const c = new ColladaLoader().parse(new TextDecoder().decode(buf), '');
    if (!c) throw new Error('Collada 檔解析失敗');
    root = c.scene;
  } else if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    root = new OBJLoader().parse(new TextDecoder().decode(buf));
    known = false;
  } else if (ext === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    root = new FBXLoader().parse(buf, '');
    known = false;
  } else {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    root = new THREE.Mesh(new STLLoader().parse(buf));
    known = false;
  }
  root.updateMatrixWorld(true);
  const raw: { name: string; color: number; opacity: number; pos: Float32Array; solid: string }[] = [];
  const v = new THREE.Vector3();
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry as THREE.BufferGeometry, p = g.getAttribute('position');
    if (!p) return;
    const index = g.getIndex(), count = index ? index.count : p.count;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    const names: string[] = [];
    for (let a: THREE.Object3D | null = m; a; a = a.parent) if (a.name) names.push(a.name);
    for (const gr of groups) {
      const mat = mats[gr.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
      const n = Math.floor(Math.min(gr.count, count - gr.start) / 3) * 3, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(p, index ? index.getX(gr.start + i) : gr.start + i).applyMatrix4(m.matrixWorld);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      }
      raw.push({ name: [...names, mat?.name || ''].join(' '), color: mat?.color ? mat.color.getHex() : 0xd9d9d9, opacity: mat?.transparent ? mat.opacity : 1, pos, solid: m.uuid });
    }
  });
  if (!raw.length) throw new Error('檔案裡沒有 3D 面');
  let s = 100;
  if (!known) {
    // the biggest dimension of a building: metres when under 150, millimetres when over 2000, else centimetres
    let lo = Infinity, hi = -Infinity;
    for (const r of raw) for (let i = 0; i < r.pos.length; i++) { lo = Math.min(lo, r.pos[i]); hi = Math.max(hi, r.pos[i]); }
    const d = hi - lo;
    s = d < 150 ? 100 : d > 2000 ? 0.1 : 1;
  }
  return raw.map(r => { for (let i = 0; i < r.pos.length; i++) r.pos[i] *= s; return r; });
}
