import { EXT_FINISHES, FINISHES, SEC } from './takeoff';
import type { PriceRate } from './pricing';
import type { TemplateItem } from './budgetTemplate';

/** where a material goes: outside wall faces, inside wall faces, floors, ceilings, or a budget item of its own */
export type MaterialUse = 'ext' | 'wall' | 'floor' | 'ceil' | 'item';
export const MATERIAL_USES: Record<MaterialUse, string> = { ext: '外牆面', wall: '內牆面', floor: '地坪', ceil: '天花', item: '其他項目' };
/** how a face with the material looks in the 3D model */
export type MaterialLook = 'stone' | 'tile' | 'rib' | 'panel' | 'paint' | 'ceramic';
export const MATERIAL_LOOKS: Record<MaterialLook, string> = { stone: '抿石子顆粒', tile: '二丁掛磚', rib: '浪板', panel: '金屬板', paint: '平塗', ceramic: '磁磚' };

/** One item of the 建材項目 list: the name is the line on the budget (品名規格). */
export interface Material {
  name: string;
  use: MaterialUse;
  unit: string;
  /** budget section (default by use: 泥作.裝修, 其他) */
  sec?: string;
  look?: MaterialLook;
  /** '#rrggbb' */
  color?: string;
  /** default unit prices, used on the budget until a price is typed there */
  mat?: number;
  lab?: number;
  /** exterior finishes: goes on a 1:3 mortar base coat (counted as 外牆1:3水泥砂漿打底); default read from the name */
  base?: boolean;
  /** a built-in item taken off the pickers */
  hidden?: boolean;
  /** shipped with the program (finish codes F1, W1A … and the exterior finishes) */
  builtin?: boolean;
}

const guessLook = (name: string): MaterialLook =>
  /二丁掛/.test(name) ? 'tile' : /磁磚|地磚|石英磚/.test(name) ? 'ceramic' : /抿石子|洗石/.test(name) ? 'stone' : /浪板|鋼板/.test(name) ? 'rib' : /金屬|鋁板|飾板/.test(name) ? 'panel' : 'paint';

/** The items the program knows without being told: exterior finishes and the room finish codes. */
export function builtinMaterials(): Material[] {
  const out: Material[] = EXT_FINISHES.map(name => ({ name, use: 'ext' as const, unit: '㎡', look: guessLook(name), builtin: true }));
  const uses: [keyof typeof FINISHES, MaterialUse][] = [['w', 'wall'], ['f', 'floor'], ['c', 'ceil']];
  for (const [k, use] of uses) for (const [code, name] of Object.entries(FINISHES[k])) {
    if (code === '-') continue;
    out.push({ name: `${code}-${name}`, use, unit: '㎡', look: use === 'wall' && code !== 'W2' ? 'paint' : guessLook(name), builtin: true });
  }
  return out;
}

/** The project's list: the built-in items with the project's changes laid over them, then the project's own items. */
export function materialsOf(own?: Material[]): Material[] {
  const mine = new Map((own || []).map(m => [m.name, m]));
  const base = builtinMaterials().map(b => mine.has(b.name) ? { ...b, ...mine.get(b.name)!, builtin: true } : b);
  const names = new Set(base.map(b => b.name));
  return [...base, ...(own || []).filter(m => !names.has(m.name)).map(m => ({ ...m, builtin: false }))];
}

/** finish code (W1A) or material name → the material, for a room finish choice */
export function materialFor(list: Material[], use: MaterialUse, v: string): Material | undefined {
  return list.find(m => m.use === use && (m.name === v || m.name.startsWith(`${v}-`)));
}

export const sectionOf = (m: Material) => m.sec || (m.use === 'item' ? SEC.other : SEC.finish);

/** default unit prices by budget line name and unit */
export function materialRates(list: Material[]): Record<string, PriceRate> {
  const out: Record<string, PriceRate> = {};
  for (const m of list) if (m.mat || m.lab) out[`${m.name}|${m.unit}`] = { mat: m.mat, lab: m.lab };
  return out;
}

/** items of their own (use 'item') listed on the budget even before they have a quantity */
export function materialItems(list: Material[]): Record<string, TemplateItem[]> {
  const out: Record<string, TemplateItem[]> = {};
  for (const m of list) if (m.use === 'item' && !m.hidden) (out[sectionOf(m)] ||= []).push({ name: m.name, unit: m.unit });
  return out;
}
