/**
 * Learning from hand corrections: what the user changes on an imported model says what a drawing layer really is.
 * Deleting most of what one layer built → that layer is not walls; turning its walls into partitions → it is the
 * partition layer; adding walls by hand along lines of a layer the import skipped → that layer is walls.
 * The roles learnt go into BuildOptions.layers on the next import of drawings in the same style (the same office).
 */
import type { LayerRole } from './building';
import { memberOf } from './pricing';
import { isDoor, type BoxObject, type CadData, type ModelObject } from './types';

/** what a part counts as, in the words of the 構件類別 list */
export const PART_KINDS = ['柱', '梁', '樓板', 'RC牆', '隔間牆', '樓梯', '欄杆', '設備', '其他'] as const;
export type PartKind = typeof PART_KINDS[number];
export function partKind(o: ModelObject): PartKind {
  if (isDoor(o)) return '其他';
  const m = memberOf(o);
  if (m === '牆') return o.wall === 'light' || (o.wall !== 'rc' && Math.min(o.w, o.d) < 18) ? '隔間牆' : 'RC牆';
  if (m === '基礎') return o.rc?.kind === 'beam' ? '梁' : '樓板';
  return (PART_KINDS as readonly string[]).includes(m) ? m as PartKind : '其他';
}

/** one correction, kept per part id so undoing it takes it back */
export interface Fix {
  kind: 'del' | 'type' | 'add';
  /** drawing layer the part was built from */
  src?: string;
  floor?: string;
  name?: string;
  /** type change: from → to */
  from?: PartKind;
  to?: PartKind;
  /** wall added by hand: the drawing layers whose lines run along it */
  layers?: string[];
  /** when, ms */
  t: number;
}

const MANUAL = /（手動補牆）|（自建）/;

/** The plan lines of a skipped layer that a hand-added wall lies on: lines along it, inside its footprint, covering half its length. */
export function layersUnder(o: BoxObject, cad: CadData | null): string[] {
  const f = cad?.floors?.find(x => x.key === o.floor);
  if (!f?.segLayer || !cad?.layers) return [];
  const along = o.w >= o.d, len = Math.max(o.w, o.d), half = Math.min(o.w, o.d) / 2 + 6;
  const cover = new Map<number, number>();
  for (let i = 0; i < f.segLayer.length; i++) {
    const x1 = f.segs[i * 4], z1 = f.segs[i * 4 + 1], x2 = f.segs[i * 4 + 2], z2 = f.segs[i * 4 + 3];
    if (along ? Math.abs(z1 - z2) > 1 : Math.abs(x1 - x2) > 1) continue;
    if (along ? Math.abs(z1 - o.z) > half : Math.abs(x1 - o.x) > half) continue;
    const a = along ? Math.min(x1, x2) : Math.min(z1, z2), b = along ? Math.max(x1, x2) : Math.max(z1, z2), c = along ? o.x : o.z;
    const ov = Math.min(b, c + len / 2) - Math.max(a, c - len / 2);
    if (ov > 0) cover.set(f.segLayer[i], (cover.get(f.segLayer[i]) || 0) + ov);
  }
  // both faces of a wall: up to twice its length
  return [...cover].filter(([, v]) => v >= len * 0.5).map(([i]) => cad.layers![i]);
}

/**
 * Brings the corrections up to date after the model changed. `base` is the model as it was when last checked;
 * returns the new list (only parts that differ from the import).
 */
export function trackFixes(fixes: Record<string, Fix>, base: Map<number, ModelObject>, now: ModelObject[], cad: CadData | null, t = Date.now()): Record<string, Fix> {
  const out = { ...fixes }, cur = new Map(now.map(o => [o.id, o]));
  for (const [id, o] of base) {
    if (cur.has(id)) continue;
    const prev = out[id];
    if (prev?.kind === 'add') delete out[id];
    else if (!isDoor(o) && o.src) out[id] = { kind: 'del', src: o.src, floor: o.floor, name: o.name, t };
  }
  for (const o of now) {
    const was = base.get(o.id), prev = out[o.id];
    if (!was) {
      if (prev?.kind === 'del') { delete out[o.id]; continue; }
      if (!isDoor(o) && MANUAL.test(o.name) && o.layer === 'wall') out[o.id] = { kind: 'add', floor: o.floor, name: o.name, layers: layersUnder(o, cad), t };
      continue;
    }
    if (isDoor(o) || !o.src) continue;
    const k0 = partKind(was), k1 = partKind(o);
    if (k0 === k1) continue;
    const from = prev?.kind === 'type' ? prev.from! : k0;
    if (from === k1) delete out[o.id];
    else out[o.id] = { kind: 'type', src: o.src, floor: o.floor, name: o.name, from, to: k1, t };
  }
  return out;
}

const ROLE_OF: Partial<Record<PartKind, LayerRole>> = { 'RC牆': 'rc', '隔間牆': 'light', '柱': 'column' };
export const ROLE_NAME: Record<LayerRole, string> = { wall: '牆', rc: 'RC 牆', light: '輕隔間牆', column: '柱', ignore: '不建（非牆）' };

/** The layer roles the corrections support, each with the reason in words. */
export function learnRoles(fixes: Fix[], objects: ModelObject[]): { roles: Record<string, LayerRole>; why: Record<string, string> } {
  const roles: Record<string, LayerRole> = {}, why: Record<string, string> = {};
  const built = new Map<string, number>();
  for (const o of objects) if (!isDoor(o) && o.src) built.set(o.src, (built.get(o.src) || 0) + 1);
  const by = new Map<string, Fix[]>();
  for (const f of fixes) for (const l of f.kind === 'add' ? f.layers || [] : f.src ? [f.src] : []) (by.get(l) || by.set(l, []).get(l)!).push(f);
  for (const [l, fs] of by) {
    const types = fs.filter(f => f.kind === 'type' && f.to && ROLE_OF[f.to]);
    const votes = new Map<LayerRole, number>();
    for (const f of types) votes.set(ROLE_OF[f.to!]!, (votes.get(ROLE_OF[f.to!]!) || 0) + 1);
    const top = [...votes].sort((p, q) => q[1] - p[1])[0];
    if (top && top[1] >= 2 && top[1] >= types.length * 0.7) { roles[l] = top[0]; why[l] = `改了 ${top[1]} 個構件的類別為「${ROLE_NAME[top[0]]}」`; continue; }
    const dels = fs.filter(f => f.kind === 'del').length, left = built.get(l) || 0;
    if (dels >= 3 && dels >= (dels + left) * 0.6) { roles[l] = 'ignore'; why[l] = `刪除了這個圖層建出的 ${dels} 個構件（共 ${dels + left} 個）`; continue; }
    const adds = fs.filter(f => f.kind === 'add').length;
    if (adds >= 2) { roles[l] = 'wall'; why[l] = `沿著這個圖層的線手動補了 ${adds} 道牆`; }
  }
  return { roles, why };
}
