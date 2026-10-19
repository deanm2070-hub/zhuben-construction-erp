/**
 * Legend of Taiwanese architectural drawings (建築圖例): what opening codes and plan
 * notes mean. The importer reads drawings with these rules; extend the tables here
 * when an office uses other codes.
 */

export type OpeningType = 'swing' | 'shutter' | 'french' | 'window' | 'fixed' | 'louver';
export interface OpeningRule { prefix: RegExp; type: OpeningType; label: string }

/** Code prefixes in 門窗表 and plan tags, longest first. F codes are fire-rated and take their type from the name. */
export const OPENING_CODES: OpeningRule[] = [
  { prefix: /^SD/, type: 'shutter', label: '捲門' },
  { prefix: /^(FS|RS)/, type: 'shutter', label: '防火捲門' },
  { prefix: /^DW/, type: 'french', label: '落地窗' },
  { prefix: /^FD/, type: 'swing', label: '防火門' },
  { prefix: /^FW/, type: 'window', label: '防火窗' },
  { prefix: /^(AD|MD|WD|GD)/, type: 'swing', label: '門' },
  { prefix: /^(LV|L)\d/, type: 'louver', label: '百葉' },
  { prefix: /^(FG|G)\d/, type: 'fixed', label: '固定玻璃' },
  { prefix: /^D/, type: 'swing', label: '門' },
  { prefix: /^(AW|W)/, type: 'window', label: '窗' },
];

/** What an opening is, from its code and the schedule name ("防火捲門", "氣密窗" …). */
export function openingType(code: string, name: string): OpeningType {
  if (/捲門|鐵捲|捲簾/.test(name)) return 'shutter';
  if (/落地/.test(name)) return 'french';
  if (/百葉/.test(name)) return 'louver';
  if (/^F\d/.test(code)) return /門/.test(name) && !/窗/.test(name) ? 'swing' : 'window';
  const r = OPENING_CODES.find(o => o.prefix.test(code));
  if (r) return r.type;
  return /門/.test(name) && !/窗/.test(name) ? 'swing' : 'window';
}

/** Schedule name with the legend meaning made explicit, e.g. DW1 "氣密窗" → "氣密落地窗", SD1 "鐵門" → "鐵捲門". */
export function openingName(code: string, name: string): string {
  const t = openingType(code, name);
  if (t === 'french' && !/落地/.test(name)) return /窗$/.test(name) ? name.replace(/窗$/, '落地窗') : `${name}落地窗`;
  if (t === 'shutter' && !/捲/.test(name)) return /門$/.test(name) ? name.replace(/門$/, '捲門') : `${name}捲門`;
  return name || OPENING_CODES.find(o => o.prefix.test(code))?.label || '';
}

/** Doors open from the floor; French windows are glass down to the floor. */
export const isDoorType = (t: OpeningType) => t === 'swing' || t === 'shutter';

/** Plan notes (室名 and 說明) that change what the lines around them are. */
export const PLAN_NOTES = {
  /** open-air floors whose thin outer edges are railings or parapets, not walls */
  balcony: /陽台|露台|平台|曬衣/,
  /** concrete canopies: the edge line is the slab edge */
  canopy: /雨遮|遮陽板|雨庇/,
  /** lines drawn only as projections of something above or below */
  projection: /投影|上方|虛線/,
  /** holes through the floor */
  void: /天井|挑空|管道|中庭|透空|梯井/,
};

/** Railing / parapet heights written on plans and elevations: "欄杆高度120㎝", "女兒牆高度150cm", "扶手高度90". */
export const HEIGHT_NOTE = /(玻璃欄杆|欄杆|扶手|女兒牆|矮牆|花台)\s*(?:高度|高|H=?)\s*(\d{2,3})/;
