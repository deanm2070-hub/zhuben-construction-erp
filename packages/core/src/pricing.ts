import { isBox, isDoor, type ModelObject } from './types';
import type { BudgetLine, CalcRow } from './takeoff';

/** Unit prices of one budget line, NT$ per unit; waste is a percentage added to the quantity. */
export interface PriceRate { mat?: number; lab?: number; eq?: number; waste?: number; note?: string }
/** A line typed in by hand: an item the model does not measure (or a correction to one). */
export interface CustomLine extends PriceRate { id: string; sec: string; name: string; unit: string; q: number }
export interface QuoteInfo { company?: string; client?: string; site?: string; date?: string; valid?: string; contact?: string; terms?: string }
export interface Pricing {
  /** keyed by budgetKey(): section | item | unit */
  rates: Record<string, PriceRate>;
  custom: CustomLine[];
  /** percentages of the direct cost: management, profit; tax is on direct + fees */
  fees: { mgmt: number; profit: number; tax: number };
  quote: QuoteInfo;
}
export const DEFAULT_PRICING: Pricing = { rates: {}, custom: [], fees: { mgmt: 5, profit: 10, tax: 5 }, quote: {} };
export const withPricing = (p?: Partial<Pricing> | null): Pricing => ({
  ...DEFAULT_PRICING, ...(p || {}),
  rates: p?.rates || {}, custom: p?.custom || [], fees: { ...DEFAULT_PRICING.fees, ...(p?.fees || {}) }, quote: { ...(p?.quote || {}) },
});

export const budgetKey = (sec: string, name: string, unit: string) => `${sec}|${name}|${unit}`;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r0 = (v: number) => Math.round(v);

export interface PricedLine {
  key: string; i: number; name: string; unit: string;
  /** quantity from the model (lump-sum items such as 另計 count as 1) and with waste added */
  q: number; qw: number; waste: number; lump: boolean;
  mat: number; lab: number; eq: number;
  /** unit price and line total */
  up: number; matT: number; labT: number; eqT: number; total: number;
  note: string; custom?: CustomLine;
}
export interface PricedSection { sec: string; lines: PricedLine[]; mat: number; lab: number; eq: number; total: number }
export interface PricedBudget {
  sections: PricedSection[];
  mat: number; lab: number; eq: number; direct: number;
  mgmt: number; profit: number; tax: number; grand: number;
  /** lines with any unit price, of all lines */
  priced: number; count: number;
}

/** Prices the budget lines of a takeoff and the hand-typed lines, section by section, then adds the fees and tax. */
export function priceBudget(budget: BudgetLine[], P: Pricing): PricedBudget {
  const sections: PricedSection[] = [];
  let cur: PricedSection | null = null;
  const line = (sec: string, i: number, name: string, unit: string, q0: number | string | undefined, note: string, rate: PriceRate, custom?: CustomLine): PricedLine => {
    const lump = typeof q0 !== 'number';
    const q = lump ? 1 : q0 as number, waste = rate.waste || 0, qw = r2(q * (1 + waste / 100));
    const mat = rate.mat || 0, lab = rate.lab || 0, eq = rate.eq || 0;
    const matT = r0(qw * mat), labT = r0(qw * lab), eqT = r0(qw * eq);
    return { key: custom ? `custom|${custom.id}` : budgetKey(sec, name, unit), i, name, unit, q, qw, waste, lump, mat, lab, eq, up: r2(mat + lab + eq), matT, labT, eqT, total: matT + labT + eqT, note: rate.note || note, custom };
  };
  for (const b of budget) {
    if (b.sec) { cur = { sec: b.sec, lines: [], mat: 0, lab: 0, eq: 0, total: 0 }; sections.push(cur); continue; }
    if (!cur) continue;
    cur.lines.push(line(cur.sec, b.i || cur.lines.length + 1, b.name || '', b.unit || '', b.q, b.note || '', P.rates[budgetKey(cur.sec, b.name || '', b.unit || '')] || {}));
  }
  for (const c of P.custom) {
    let s = sections.find(x => x.sec === c.sec);
    if (!s) { s = { sec: c.sec, lines: [], mat: 0, lab: 0, eq: 0, total: 0 }; sections.push(s); }
    s.lines.push(line(c.sec, s.lines.length + 1, c.name, c.unit, c.q, '自訂工項', c, c));
  }
  let mat = 0, lab = 0, eq = 0, priced = 0, count = 0;
  for (const s of sections) {
    for (const l of s.lines) { s.mat += l.matT; s.lab += l.labT; s.eq += l.eqT; count++; if (l.up > 0) priced++; }
    s.total = s.mat + s.lab + s.eq;
    mat += s.mat; lab += s.lab; eq += s.eq;
  }
  const direct = mat + lab + eq;
  const mgmt = r0(direct * P.fees.mgmt / 100), profit = r0(direct * P.fees.profit / 100);
  const tax = r0((direct + mgmt + profit) * P.fees.tax / 100);
  return { sections: sections.filter(s => s.lines.length), mat, lab, eq, direct, mgmt, profit, tax, grand: direct + mgmt + profit + tax, priced, count };
}

/** Unit prices carried over from another project: same item name and unit, any section. */
export function carryRates(from: Pricing, budget: BudgetLine[]): Record<string, PriceRate> {
  const byName = new Map<string, PriceRate>();
  for (const [k, v] of Object.entries(from.rates)) { const [, name, unit] = k.split('|'); byName.set(`${name}|${unit}`, v); }
  const out: Record<string, PriceRate> = {};
  let sec = '';
  for (const b of budget) {
    if (b.sec) { sec = b.sec; continue; }
    const r = byName.get(`${b.name}|${b.unit}`);
    if (r) out[budgetKey(sec, b.name || '', b.unit || '')] = { ...r };
  }
  return out;
}

/** Member kinds used to sort quantities and to show or hide parts of the 3D model. */
export const MEMBERS = ['基礎', '柱', '梁', '樓板', '牆', '樓梯', '門窗', '欄杆', '裝修', '防水', '設備', '假設土方', '其他'] as const;
export type Member = typeof MEMBERS[number];

/** Which member kind a line of the calculation sheet is about. */
export function memberOfCalc(c: CalcRow): Member {
  const w = c.where;
  if (/^基礎版|^地梁/.test(w) || /挖土|回填|運棄/.test(c.item)) return /^基礎版|^地梁/.test(w) ? '基礎' : '假設土方';
  if (/^柱/.test(w)) return '柱';
  if (/^梁|梁 /.test(w)) return '梁';
  if (/^(樓板|地坪|屋頂板|屋簷)/.test(w)) return '樓板';
  if (/^RC牆/.test(w)) return '牆';
  if (/^樓梯/.test(w)) return '樓梯';
  if (/^一、|^二、/.test(c.sec)) return '假設土方';
  if (/門窗/.test(c.sec)) return '門窗';
  if (/欄杆/.test(c.item)) return '欄杆';
  if (/防水/.test(c.sec) || /防水/.test(c.item)) return '防水';
  if (/裝修|泥作/.test(c.sec)) return '裝修';
  if (/衛浴|水電|弱電|消防/.test(c.sec)) return '設備';
  if (/^(鋼筋|壓送)/.test(c.item)) {
    const k = /^(柱|梁|版|基礎版|牆|樓梯)/.exec(w)?.[1];
    return k === '版' ? '樓板' : k === '基礎版' ? '基礎' : (k as Member) || '其他';
  }
  return '其他';
}

/** Member kind of a 3D part, for showing and hiding them by kind. */
export function memberOf(o: ModelObject): Member {
  if (isDoor(o)) return '門窗';
  if (!isBox(o)) return '其他';
  if (o.rc?.kind === 'column') return '柱';
  if (o.rc?.kind === 'beam' || /梁/.test(o.name)) return /^地梁/.test(o.name) ? '基礎' : '梁';
  if (o.stair || o.layer === 'stair' || /樓梯|踏階/.test(o.name)) return '樓梯';
  if (o.layer === 'rail' || /欄杆/.test(o.name)) return '欄杆';
  if (o.layer === 'glass') return '門窗';
  if (o.layer === 'slab') return /基礎/.test(o.name) ? '基礎' : '樓板';
  if (o.layer === 'wall') {
    const t = Math.min(o.w, o.d), L = Math.max(o.w, o.d);
    if (/柱/.test(o.name) || (!o.rot && t >= 30 && L <= t * 2.5 && o.h >= 200)) return '柱';
    return '牆';
  }
  if (o.layer === 'bath' || o.layer === 'cabinet' || o.layer === 'furniture') return '設備';
  return '其他';
}

export type GroupBy = 'item' | 'floor' | 'member' | 'area';
export interface QtyGroup { key: string; rows: { item: string; unit: string; q: number; n: number }[] }
/**
 * Quantities of the calculation sheet summed by floor, member kind or area (floor + place),
 * each group listing its items with their totals.
 */
export function groupQuantities(calc: CalcRow[], by: GroupBy): QtyGroup[] {
  const keyOf = (c: CalcRow) => by === 'floor' ? c.fl : by === 'member' ? memberOfCalc(c) : by === 'area' ? `${c.fl} ${c.where.replace(/（.*$/, '')}` : c.item;
  const groups = new Map<string, Map<string, { item: string; unit: string; q: number; n: number }>>();
  for (const c of calc) {
    const k = keyOf(c);
    if (!groups.has(k)) groups.set(k, new Map());
    const g = groups.get(k)!, ik = by === 'item' ? `${c.fl}|${c.unit}` : `${c.item}|${c.unit}`;
    const cur = g.get(ik) || { item: by === 'item' ? c.fl : c.item, unit: c.unit, q: 0, n: 0 };
    cur.q += c.q; cur.n++;
    g.set(ik, cur);
  }
  const order = by === 'member' ? (k: string) => MEMBERS.indexOf(k as Member) : () => 0;
  return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]))
    .map(([key, g]) => ({ key, rows: [...g.values()].map(r => ({ ...r, q: r2(r.q) })) }));
}

/** A saved state of the quantities and prices, to compare later versions with. */
export interface CalcVersion {
  id: string; at: string; label: string; by?: string;
  floorArea: number; direct: number; grand: number;
  lines: { sec: string; name: string; unit: string; q: number; total: number }[];
}
export function snapshotVersion(label: string, floorArea: number, pb: PricedBudget, by?: string): CalcVersion {
  return {
    id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), label, by,
    floorArea: r2(floorArea), direct: pb.direct, grand: pb.grand,
    lines: pb.sections.flatMap(s => s.lines.map(l => ({ sec: s.sec, name: l.name, unit: l.unit, q: l.q, total: l.total }))),
  };
}
export interface VersionDiff { name: string; unit: string; was: number; now: number; wasT: number; nowT: number }
/** Items whose quantity or total changed between a saved version and now. */
export function diffVersion(v: CalcVersion, pb: PricedBudget): VersionDiff[] {
  const now = new Map(pb.sections.flatMap(s => s.lines.map(l => [`${s.sec}|${l.name}|${l.unit}`, l] as const)));
  const was = new Map(v.lines.map(l => [`${l.sec}|${l.name}|${l.unit}`, l] as const));
  const out: VersionDiff[] = [];
  for (const k of new Set([...now.keys(), ...was.keys()])) {
    const a = was.get(k), b = now.get(k);
    const d = { name: (a || b)!.name, unit: (a || b)!.unit, was: a?.q ?? 0, now: b?.q ?? 0, wasT: a?.total ?? 0, nowT: b?.total ?? 0 };
    if (Math.abs(d.was - d.now) > 0.005 || d.wasT !== d.nowT) out.push(d);
  }
  return out;
}
