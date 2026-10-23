import type { Material } from '@cloud-modeler/core';

/** the 建材項目 list is also kept on this computer, so a new project starts with it */
const KEY = 'zb-materials';
export function saveMaterials(list: Material[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage off: the project still carries the list */ }
}
export function loadMaterials(): Material[] | undefined {
  try { const v = localStorage.getItem(KEY); return v ? JSON.parse(v) as Material[] : undefined; } catch { return undefined; }
}
