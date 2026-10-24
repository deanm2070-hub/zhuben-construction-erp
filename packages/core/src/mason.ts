import type { CalcRow } from './takeoff';

/**
 * 泥作報表: the plastering and tiling quantities regrouped the way a mason's takeoff is read, one table per work item,
 * each line with the space it is for and how it was worked out, subtotals per floor and a total.
 */
export interface MasonLine { fl: string; where: string; expr: string; q: number }
export interface MasonItem { key: string; title: string; unit: string; note?: string; lines: MasonLine[]; floors: { fl: string; q: number }[]; total: number }

const r2 = (v: number) => Math.round(v * 100) / 100;

const WET = /廁|浴|洗手|衛/, KITCHEN = /廚|茶水|Kitchen/i, BALCONY = /陽台|露台|平台/, LOBBY = /梯廳/, STAIR = /樓梯|安全梯|梯間/;
/** the room a line belongs to: where reads like "2F 主臥浴室"; a beam line carries （梁） after the room */
const roomOf = (where: string, fl: string) => where.split(`${fl} `).join('').replace(/（梁）$/, '（梁）');

type Rule = { key: string; title: string; test: (c: CalcRow) => boolean; note?: string };
/** rooms whose walls are tiled: the tiles go on the waterproof base coat only, so no plaster finish is counted there */
let tiledRooms = new Set<string>();
const roomKey = (c: CalcRow) => `${c.fl}|${roomOf(c.where, c.fl).replace(/（梁）$/, '')}`;
const plain = (c: CalcRow) => !tiledRooms.has(roomKey(c));
const isFloor = (c: CalcRow) => /^F\d/.test(c.item) && c.unit === '㎡';
const tile = (c: CalcRow) => isFloor(c) && !/^F1[-\s]|金鋼砂/.test(c.item);
const RULES: Rule[] = [
  { key: 'extPlaster', title: '外牆粉刷（外牆 1:3 水泥砂漿打底）', test: c => /^外牆1:3水泥砂漿打底/.test(c.item) && c.unit === '㎡' },
  { key: 'pebble', title: '抿石子', test: c => /抿石子/.test(c.item) && c.unit === '㎡' },
  { key: 'extOther', title: '外牆其他飾面（二丁掛、水泥漆、金屬板…）', test: c => /^外牆/.test(c.item) && c.unit === '㎡' && !/^外牆1:3水泥砂漿打底|抿石子|防水|門窗/.test(c.item) },
  { key: 'wallBase', title: '內牆打底', note: '只記貼壁磚牆面的防水打底（W2A）。油漆牆面的打底含在內牆粉光，不重複計入。', test: c => /^W2A-/.test(c.item) && c.unit === '㎡' },
  { key: 'wallFinish', title: '內牆粉光', note: '不貼磚的內牆 1:3 水泥粉光＋水泥漆（W1A）；貼壁磚的牆面不計粉光；油漆牆面的打底含在此項。', test: c => /^W1A-/.test(c.item) && c.unit === '㎡' && plain(c) },
  { key: 'floorIn', title: '室內地磚', test: c => tile(c) && !WET.test(c.where) && !BALCONY.test(c.where) && !LOBBY.test(c.where) && !STAIR.test(c.where) },
  { key: 'floorBalcony', title: '陽台地磚', test: c => tile(c) && BALCONY.test(c.where) && !STAIR.test(c.where) },
  { key: 'floorWet', title: '廁所地磚', test: c => tile(c) && WET.test(c.where) },
  { key: 'floorLobby', title: '梯廳地磚', test: c => tile(c) && LOBBY.test(c.where) && !WET.test(c.where) },
  { key: 'floorStair', title: '樓梯地磚', note: '樓梯間地坪（F2B）及踢面石英磚。', test: c => (tile(c) && STAIR.test(c.where) && !WET.test(c.where) && !LOBBY.test(c.where)) || c.item === '樓梯踢面石英磚' },
  { key: 'wallTileWet', title: '廁所壁磚', test: c => /^W2C-/.test(c.item) && WET.test(c.where) },
  { key: 'wallTileKitchen', title: '廚房壁磚', test: c => /^W2C-/.test(c.item) && KITCHEN.test(c.where) && !WET.test(c.where) },
  { key: 'wallTileLobby', title: '梯廳壁磚', test: c => /^W2C-/.test(c.item) && LOBBY.test(c.where) && !WET.test(c.where) && !KITCHEN.test(c.where) },
  { key: 'wallTileOther', title: '其他壁磚', test: c => /^W2C-/.test(c.item) && !WET.test(c.where) && !KITCHEN.test(c.where) && !LOBBY.test(c.where) },
  { key: 'floorScreed', title: '地坪整體粉光（金鋼砂）', test: c => isFloor(c) && !tile(c) },
];

export function masonReport(calc: CalcRow[], floorOrder?: string[], plans?: { fl: string; nos?: Record<string, number> }[]): MasonItem[] {
  const noOf = (fl: string, room: string) => plans?.find(p => p.fl === fl)?.nos?.[room.replace(/（梁）$/, '')];
  const order = floorOrder || [...new Set(calc.map(c => c.fl))];
  const rank = (fl: string) => { const i = order.indexOf(fl); return i < 0 ? 999 : i; };
  const out: MasonItem[] = [];
  tiledRooms = new Set(calc.filter(c => /^W2C-/.test(c.item)).map(roomKey));
  for (const rule of RULES) {
    const rows = calc.filter(rule.test);
    if (!rows.length) continue;
    const lines = rows.map(c => ({ fl: c.fl, where: (n => n ? `${n}. ${roomOf(c.where, c.fl)}` : roomOf(c.where, c.fl))(noOf(c.fl, roomOf(c.where, c.fl))), expr: c.expr, q: c.q })).sort((a, b) => rank(a.fl) - rank(b.fl));
    const floors: { fl: string; q: number }[] = [];
    for (const l of lines) { const f = floors.find(x => x.fl === l.fl); if (f) f.q = r2(f.q + l.q); else floors.push({ fl: l.fl, q: l.q }); }
    out.push({ key: rule.key, title: rule.title, unit: '㎡', ...(rule.note ? { note: rule.note } : {}), lines, floors, total: r2(lines.reduce((s, l) => s + l.q, 0)) });
  }
  return out;
}

/** a mason table as cells: 樓層 位置 計算式 數量 單位, with 樓層小計 after each floor and 合計 */
export function masonCells(it: MasonItem): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const { fl, q } of it.floors) {
    const ls = it.lines.filter(l => l.fl === fl);
    ls.forEach((l, i) => rows.push([i === 0 ? fl : '', l.where, l.expr, l.q.toFixed(2), it.unit]));
    rows.push(['', '樓層小計', '', q.toFixed(2), it.unit]);
  }
  rows.push(['', `${it.title.replace(/（.*$/, '')} 合計`, '', it.total.toFixed(2), it.unit]);
  return rows;
}
