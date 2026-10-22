import { guessLayerKind, type DrawingStyle, type DxfDrawing, type LayerRole } from '@cloud-modeler/core';

/**
 * Drawing styles: the way each office draws, kept in this browser and copied into every project that used one
 * (so another device picks it up when the project is opened). A new drawing set is matched by its office name in
 * the title block, else by how many of its plan layers a style knows.
 */
const KEY = 'zb-styles';

export function allStyles(): DrawingStyle[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function saveAll(list: DrawingStyle[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private window */ }
}
export function putStyle(s: DrawingStyle) {
  saveAll([s, ...allStyles().filter(x => x.id !== s.id)]);
}
/** a copy from a project: kept if newer than this browser's, learnt roles of both merged */
export function mergeStyle(s: DrawingStyle) {
  const mine = allStyles().find(x => x.id === s.id);
  if (!mine) return putStyle(s);
  putStyle({ ...(s.updated > mine.updated ? s : mine), learnt: { ...mine.learnt, ...s.learnt }, manual: s.updated > mine.updated ? s.manual : mine.manual });
}

/** The office named in the title block (○○建築師事務所), if any. */
export function officeOf(d: DxfDrawing): string {
  const n = new Map<string, number>();
  for (const t of d.texts) {
    const m = /([一-鿿A-Za-z]{2,12}建築師事務所)/.exec(t.s.replace(/\s+/g, ''));
    if (m && !/^(本|該|原|由|經|及|與|之)/.test(m[1])) n.set(m[1], (n.get(m[1]) || 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/** Layers carrying linework inside the plans, busiest first (text, dimension and grid layers left out). */
export function planLayers(d: DxfDrawing, boxes: [number, number, number, number][]): { layer: string; n: number }[] {
  const n = new Map<string, number>();
  for (const s of d.segs) {
    if (/TEXT|DIM|尺寸|標註|GRID|AXIS|軸|Defpoints|圖框/i.test(s.layer) || guessLayerKind(s.layer) === 'off') continue;
    if (!boxes.some(b => s.a[0] >= b[0] && s.a[0] <= b[2] && s.a[1] >= b[1] && s.a[1] <= b[3])) continue;
    n.set(s.layer, (n.get(s.layer) || 0) + 1);
  }
  return [...n].filter(([, c]) => c >= 4).sort((a, b) => b[1] - a[1]).map(([layer, c]) => ({ layer, n: c }));
}

export function findStyle(office: string, layers: string[]): DrawingStyle | null {
  const list = allStyles();
  if (office) { const s = list.find(x => x.name === office); if (s) return s; }
  let best: DrawingStyle | null = null, score = 0.5;
  const set = new Set(layers);
  for (const s of list) {
    const both = s.layers.filter(l => set.has(l)).length, j = both / (s.layers.length + layers.length - both || 1);
    if (j >= score) { best = s; score = j; }
  }
  return best;
}

export function newStyle(office: string, layers: string[]): DrawingStyle {
  return { id: `st-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: office || `圖層 ${layers.slice(0, 3).join('、')}`, layers: layers.slice(0, 60), manual: {}, learnt: {}, updated: Date.now() };
}

/** The roles in force: learnt from every project (the latest project wins a disagreement), then the hand-set ones. */
export function rolesOf(s: DrawingStyle | null): { roles: Record<string, LayerRole>; why: Record<string, string> } {
  const roles: Record<string, LayerRole> = {}, why: Record<string, string> = {};
  if (!s) return { roles, why };
  for (const p of Object.values(s.learnt)) for (const [l, r] of Object.entries(p.roles)) { roles[l] = r; why[l] = `${p.project ? `「${p.project}」` : ''}${p.why[l] || ''}`; }
  for (const [l, r] of Object.entries(s.manual)) { roles[l] = r; why[l] = '匯入時手動設定'; }
  return { roles, why };
}
