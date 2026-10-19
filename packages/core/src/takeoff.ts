import { computeRooms, type RoomLabel, type RoomStat } from './rooms';
import { WALL_H } from './sample';
import { isBox, isDoor, type BoxObject, type Bounds, type CadDoor, type FinishChoice, type ModelObject, type RoomRect, type TakeoffSettings } from './types';

export const PING = 3.3058;
export const FINISHES = {
  f: { F1: '地坪整體粉光+金鋼砂', F2A: '地坪1:3水泥砂漿打底+80*80cm拋光石英磚', F2B: '樓梯地坪1:3水泥砂漿打底+80*80cm拋光石英磚', F4: '地坪1:3水泥砂漿打底+30*30cm地磚', F5: '地坪1:2防水水泥砂漿打底+30*30cm止滑地磚', '-': '不施作' },
  c: { C1: '平頂明架石膏板天花', C2: '平頂PVC企口天花板', '-': '不施作' },
  w: { W1A: '內牆1:3水泥粉光+水泥漆(綠建材)', W1B: '內牆矽酸鈣板批土整平+水泥漆(綠建材)', W2: '內牆防水打底+貼30*60cm磁磚', '-': '不施作' },
} as const;
export const FINISH_SHORT: Record<string, string> = { F1: '粉光金鋼砂', F2A: '拋光石英磚', F2B: '樓梯石英磚', F4: '地磚', F5: '止滑地磚', C1: '石膏板天花', C2: 'PVC天花', W1A: '水泥粉光＋漆', W1B: '矽酸鈣板＋漆', W2: '防水＋磁磚' };
export const EXT_FINISHES = ['外牆1:3水泥砂漿打底+抿石子', '外牆1:3水泥砂漿打底+水泥漆', '外牆複合式鍍鋁鋅彩色鋼板', '外牆企口型金屬飾板'];
export const DEFAULT_SETTINGS: TakeoffSettings = { ext: 0, floor: '1F', slab: 15, rebar: 120 };

/** Finish codes picked from the room name. */
export function defaultFinish(name: string): FinishChoice {
  if (/廁|浴|洗手|衛|茶水|廚|Kitchen/i.test(name)) return { f: 'F5', c: 'C2', w: 'W2' };
  if (/陽台|露台/.test(name)) return { f: 'F4', c: '-', w: '-' };
  if (/樓梯/.test(name)) return { f: 'F2B', c: '-', w: 'W1B' };
  if (/廠房|作業|倉|儲|機房|車庫|收納/.test(name)) return { f: 'F1', c: '-', w: 'W1A' };
  return { f: 'F2A', c: 'C1', w: 'W1A' };
}

export type Facade = '北向' | '東向' | '南向' | '西向';
/** Which way an exterior wall piece faces, judged from the plan centre (north is the top). */
export function facadeOf(o: BoxObject, cx: number, cz: number): Facade {
  const r = o.rot || 0, along = o.w >= o.d;
  let nx = along ? Math.sin(r) : Math.cos(r), nz = along ? Math.cos(r) : -Math.sin(r);
  if ((o.x - cx) * nx + (o.z - cz) * nz < 0) { nx = -nx; nz = -nz; }
  return Math.abs(nz) >= Math.abs(nx) ? (nz < 0 ? '北向' : '南向') : (nx < 0 ? '西向' : '東向');
}

export interface FinishRow { fl: string; name: string; q: number }
export interface FinishGroup { title: string; unit: 'M2' | 'M'; rows: FinishRow[]; total: number }
export interface BudgetLine { sec?: string; i?: number; name?: string; unit?: string; q?: number | string; note?: string }
export interface RoomWithFinish extends RoomStat { fl: string; fin: FinishChoice }
export interface Takeoff { budget: BudgetLine[]; groups: FinishGroup[]; rooms: RoomWithFinish[]; floorArea: number; wallH: number }

export interface TakeoffInput {
  objects: ModelObject[];
  bounds: Bounds;
  labels: RoomLabel[];
  /** known room rectangles (sample plan); omit for imported drawings */
  rects?: RoomRect[];
  cadDoors?: CadDoor[];
  finishes: Record<string, Partial<FinishChoice>>;
  settings: TakeoffSettings;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const FACADES: Facade[] = ['北向', '東向', '南向', '西向'];

export function computeTakeoff(inp: TakeoffInput): Takeoff {
  const { objects, bounds, settings: S } = inp;
  const cx = bounds.W / 2, cz = bounds.D / 2;
  const boxes = objects.filter(isBox);
  const walls = boxes.filter(o => o.layer === 'wall' && o.h > 0);
  const isExt = (o: BoxObject) => /外牆|窗台|窗楣/.test(o.name) || Math.min(o.w, o.d) >= 18;
  const len = (o: BoxObject) => Math.max(o.w, o.d) / 100;
  const sum = <T>(a: T[], f: (o: T) => number) => a.reduce((s, o) => s + f(o), 0);
  const full = walls.filter(o => o.y === 0 && o.h >= 200);
  const H = full.length ? Math.max(...full.map(o => o.h)) : WALL_H;
  const ext = walls.filter(isExt), int = full.filter(o => !isExt(o));
  const rooms: RoomWithFinish[] = computeRooms(objects, bounds, inp.labels, inp.rects)
    .map(r => ({ ...r, fl: S.floor, fin: { ...defaultFinish(r.name), ...(inp.finishes[r.name] || {}) } }));
  const floorArea = sum(rooms, r => r.area);

  const doors = objects.filter(isDoor).map(o => ({ w: o.b - o.a, ext: /大門/.test(o.name) }))
    .concat((inp.cadDoors || []).map(d => ({ w: d.w, ext: d.x < 30 || d.z < 30 || d.x > bounds.W - 30 || d.z > bounds.D - 30 })));
  const wins = boxes.filter(o => o.layer === 'glass' && o.y > 0).map(o => ({ w: Math.max(o.w, o.d), h: o.h, o }));
  const winArea = sum(wins, w => w.w * w.h / 1e4);

  const groups = new Map<string, FinishGroup>();
  const add = (title: string, unit: 'M2' | 'M', fl: string, name: string, q: number) => {
    if (q <= 0) return;
    if (!groups.has(title)) groups.set(title, { title, unit, rows: [], total: 0 });
    groups.get(title)!.rows.push({ fl, name, q: r2(q) });
  };
  for (const r of rooms) {
    const { f, c, w } = r.fin, wallA = r.perim * H / 100;
    const F = FINISHES.f as Record<string, string>, Cc = FINISHES.c as Record<string, string>, Wd = FINISHES.w as Record<string, string>;
    if (f !== '-' && F[f]) add(`(地坪)${f}-${F[f]}`, 'M2', r.fl, r.name, r.area);
    if (c !== '-' && Cc[c]) add(`(平頂)${c}-${Cc[c]}`, 'M2', r.fl, r.name, r.area);
    if (w === 'W1A' || w === 'W1B') {
      add(`(牆面)${w}-${Wd[w]}`, 'M2', r.fl, r.name, wallA);
      add('(踢腳)綠建材水泥漆踢腳 H=15cm', 'M', r.fl, r.name, r.perim);
    }
    if (w === 'W2') {
      add('(牆面)W2A-內牆1:2防水水泥砂漿打底', 'M2', r.fl, r.name, wallA);
      add('(牆面)W2C-內牆貼30*60cm磁磚', 'M2', r.fl, r.name, wallA);
    }
    if (f === 'F5') add('(牆面)廁所.茶水間地坪.牆面防水處理(H=1.2M)', 'M2', r.fl, r.name, r.area + r.perim * 1.2);
    if (f === 'F4') add('(地坪)陽台地坪防水處理', 'M2', r.fl, r.name, r.area);
  }
  const facade: Partial<Record<Facade, number>> = {};
  for (const o of ext) { const k = facadeOf(o, cx, cz); facade[k] = (facade[k] || 0) + len(o) * o.h / 100; }
  // imported walls are solid behind their windows, so take the glass off
  if (inp.cadDoors) for (const w of wins) { const k = facadeOf(w.o, cx, cz); if (facade[k]) facade[k]! -= w.w * w.h / 1e4; }
  for (const k of FACADES) if (facade[k]) add(`(牆面)${EXT_FINISHES[S.ext] || EXT_FINISHES[0]}`, 'M2', S.floor, `${k}外牆`, facade[k]!);
  for (const k of FACADES) if (facade[k]) add('(牆面)外牆防水處理', 'M2', S.floor, `${k}外牆`, facade[k]!);
  const G = [...groups.values()].map(g => ({ ...g, total: r2(sum(g.rows, r => r.q)) }));

  const extVol = sum(ext, o => o.w * o.d * o.h / 1e6), extFace = sum(ext, o => len(o) * o.h / 100);
  const footprint = bounds.W * bounds.D / 1e4, extPerim = 2 * (bounds.W + bounds.D) / 100;
  const slabVol = footprint * S.slab / 100, conc = extVol + slabVol, steel = conc * S.rebar / 1000;
  const intArea = sum(int, o => len(o) * o.h / 100);

  const B: BudgetLine[] = [];
  let n = 0;
  const sec = (t: string) => { B.push({ sec: t }); n = 0; };
  const item = (name: string, unit: string, q: number | string, note = '') => B.push({ i: ++n, name, unit, q: typeof q === 'number' ? r2(q) : q, note });
  const strip = (t: string) => t.replace(/^\([^)]*\)/, '');
  sec('一、假設工程');
  item('交屋清潔費', '坪', floorArea / PING, `室內面積 ${r2(floorArea)} ㎡`);
  sec('二、放樣.土方及搭架工程');
  item('放樣', '㎡', footprint, `建築外框 ${Math.round(bounds.W)}×${Math.round(bounds.D)} cm`);
  item('施工架', '㎡', extPerim * (H + 100) / 100, `外周長 ${r2(extPerim)} m × (牆高+1 m)`);
  item('挖土／回填', 'M3', '需基礎圖', '模型未含基礎深度');
  sec('三、結構體工程');
  item('4000PSI 預拌混凝土', 'M3', conc, `外牆 ${r2(extVol)} + 樓板 ${r2(slabVol)}（板厚 ${S.slab} cm）`);
  item('壓送', 'M3', conc);
  item('鋼筋（SD420＋SD280）', '噸', steel, `以 ${S.rebar} kg/M3 估算`);
  item('鋼筋綁紮', '噸', steel);
  item('鋼筋運費', '噸', steel);
  item('一般模板組立及損耗', '㎡', extFace * 2 + footprint, '外牆兩面＋樓板底');
  sec('四、泥作.裝修工程');
  for (const g of G) if (!/防水處理/.test(g.title)) item(strip(g.title), g.unit === 'M2' ? '㎡' : 'M', g.total);
  item('內牆雙面矽酸鈣板(一小時防火時效)', '㎡', intArea, `隔間牆 ${int.length} 段，若為磚牆請改項目`);
  sec('五、防水工程');
  for (const g of G) if (/防水處理/.test(g.title)) item(strip(g.title), '㎡', g.total);
  sec('六、門窗工程');
  const dk: Record<string, number> = {};
  for (const d of doors) { const k = `${Math.round(d.w)}*210`; dk[k] = (dk[k] || 0) + 1; }
  for (const k of Object.keys(dk).sort()) item(`D 門 ${k}`, '樘', dk[k]);
  const wk: Record<string, number> = {};
  for (const w of wins) { const k = `${Math.round(w.w)}*${Math.round(w.h)}`; wk[k] = (wk[k] || 0) + 1; }
  for (const k of Object.keys(wk).sort()) item(`W 鋁窗 ${k}`, '樘', wk[k]);
  item('鋁窗玻璃', '㎡', winArea);
  const winPerim = sum(wins, w => 2 * (w.w + w.h) / 100);
  item('外牆門窗防水工程', 'M', winPerim + sum(doors.filter(d => d.ext), d => (d.w + 420) / 100), '外牆開口周長');
  item('門窗填縫', 'M', winPerim + sum(doors, d => (d.w + 420) / 100), '所有門窗周長');
  sec('九、衛浴設備');
  const bath = boxes.filter(o => o.layer === 'bath' && o.h > 10);
  const basins = bath.filter(o => /洗手|檯|台/.test(o.name)).length, wc = bath.filter(o => /馬桶/.test(o.name)).length;
  item('洗手台人造石檯面', '組', basins);
  item('明鏡', '面', basins);
  item('馬桶(座式)', '組', wc);
  sec('其他（模型未含，請依圖說另計）');
  for (const t of ['鋼架工程', '水電工程', '弱電工程', '消防工程', '道路排水溝及圍牆工程', '雜項工程']) item(t, '式', '另計');
  return { budget: B, groups: G, rooms, floorArea, wallH: H };
}
