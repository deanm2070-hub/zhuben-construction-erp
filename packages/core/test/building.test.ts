import { describe, expect, it } from 'vitest';
import {
  analyzeBuilding, buildBuilding, computeBuildingTakeoff, CONCRETE, DEFAULT_SETTINGS, drawingFromDwg, findFlights, isBox, isDoor, mergeDrawings,
  openingName, openingType, parseFloors, planStairs,
  type DwgDatabase, type DxfDrawing, type Pt,
} from '../src';

/** A two-storey drawing set in model space, laid out the way 執照圖 sheets are. */
function drawingSet(): DxfDrawing {
  const d: DxfDrawing = { segs: [], polys: [], texts: [], arcs: [], layers: new Map(), units: 5, version: 'AC1027', blockCount: 0, inserts: 0 };
  const line = (layer: string, a: Pt, b: Pt) => d.segs.push({ layer, a, b });
  const text = (layer: string, x: number, y: number, s: string, h = 20) => d.texts.push({ layer, x, y, s, h });
  const hWall = (ox: number, x1: number, x2: number, y: number) => { line('WALL', [ox + x1, y], [ox + x2, y]); line('WALL', [ox + x1, y + 20], [ox + x2, y + 20]); };
  const vWall = (ox: number, x: number, y1: number, y2: number) => { line('WALL', [ox + x, y1], [ox + x, y2]); line('WALL', [ox + x + 20, y1], [ox + x + 20, y2]); };
  for (const [ox, title] of [[0, '一層平面圖'], [2000, '二層平面圖']] as const) {
    text('TEXT3', ox, 0, title, 80);
    hWall(ox, 300, 500, 300); hWall(ox, 590, 900, 300); // door gap 500–590
    hWall(ox, 300, 600, 680); hWall(ox, 750, 900, 680); // window gap 600–750
    vWall(ox, 300, 300, 700); vWall(ox, 880, 300, 700);
    d.arcs.push({ layer: 'OPEN', c: [ox + 500, 310], r: 90, sweep: 90, p0: [ox + 590, 310], p1: [ox + 500, 400] });
    line('OPEN', [ox + 600, 685], [ox + 750, 685]); line('OPEN', [ox + 600, 695], [ox + 750, 695]);
    text('編號_門', ox + 545, 360, 'D1'); text('編號_窗', ox + 675, 650, 'W1');
    text('GTAG', ox + 300, 800, '1'); text('GTAG', ox + 200, 700, 'A');
    text('TEXT', ox + 600, 500, '客廳');
    // balcony north of the window wall, closed by a single railing line
    vWall(ox, 300, 700, 800); vWall(ox, 880, 700, 800);
    line('WALL3', [ox + 320, 800], [ox + 880, 800]);
    text('TEXT', ox + 450, 760, '陽台');
  }
  text('TEXT3', 4000, 0, '西向立面圖', 80);
  text('立面_高程', 4100, 100, '1F'); text('立面_高程', 4100, 400, '2F'); text('立面_高程', 4100, 700, 'RF');
  text('TEXT3', 6000, 0, '門窗表', 80);
  text('TEXT', 6000, 500, 'D1'); text('TEXT', 6060, 500, '90x210 木門');
  text('TEXT', 6900, 500, 'W1'); text('TEXT', 6960, 500, '150x120 鋁窗');
  // window drawn at the schedule's own scale: 100 above the FL line, 120 tall
  text('OPEN', 7300, 100, 'FL'); line('0', [6900, 95], [7350, 95]);
  for (const [a, b] of [[[7000, 195], [7150, 195]], [[7150, 195], [7150, 315]], [[7150, 315], [7000, 315]], [[7000, 315], [7000, 195]]] as [Pt, Pt][]) line('OPEN', a, b);
  return d;
}

describe('parseFloors', () => {
  it('reads Chinese storey titles', () => {
    expect(parseFloors('一層平面圖')).toEqual(['1F']);
    expect(parseFloors('三層及四層平面圖')).toEqual(['3F', '4F']);
    expect(parseFloors('二至五層平面圖')).toEqual(['2F', '3F', '4F', '5F']);
    expect(parseFloors('屋突一層平面圖')).toEqual(['R1F']);
    expect(parseFloors('屋頂層平面圖')).toEqual(['RF']);
    expect(parseFloors('地下一層平面圖')).toEqual(['B1F']);
    expect(parseFloors('十二層平面圖')).toEqual(['12F']);
  });
});

describe('analyzeBuilding', () => {
  const a = analyzeBuilding(drawingSet())!;
  it('finds the views, storey heights and the door / window schedule', () => {
    expect(a.views.map(v => `${v.kind}:${v.title}`)).toEqual(['plan:一層平面圖', 'plan:二層平面圖', 'elevation:西向立面圖', 'schedule:門窗表']);
    expect(a.levels).toEqual({ '1F': 0, '2F': 300, RF: 600 });
    expect(a.storeys.map(s => [s.key, s.base, s.h])).toEqual([['1F', 0, 300], ['2F', 300, 300]]);
    expect(a.schedule).toEqual([
      { code: 'D1', w: 90, h: 210, name: '木門', sill: 0, kind: 'door', type: 'swing' },
      { code: 'W1', w: 150, h: 120, name: '鋁窗', sill: 100, kind: 'window', type: 'window' },
    ]);
  });

  it('stacks the storeys and opens doors and windows at the schedule heights', () => {
    const r = buildBuilding(drawingSet(), a, 'set.dxf');
    expect(r.stats).toMatchObject({ floors: 2, doors: 2, windows: 2 });
    const doors = r.objects.filter(isDoor);
    expect(doors.map(o => [o.floor, o.y, o.h, Math.round(o.b - o.a)])).toEqual([['1F', 0, 210, 90], ['2F', 300, 210, 90]]);
    const glass = r.objects.filter(o => isBox(o) && o.layer === 'glass');
    expect(glass.map(o => isBox(o) && [o.floor, o.y, o.h, Math.round(Math.max(o.w, o.d))])).toEqual([['1F', 100, 120, 150], ['2F', 400, 120, 150]]);
    const sill = r.objects.find(o => isBox(o) && o.floor === '2F' && o.name === '窗台（CAD）');
    expect(sill && isBox(sill) && [sill.y, sill.h]).toEqual([300, 100]);
    expect(r.cad.floors!.map(f => [f.key, f.y, f.h, f.texts.map(t => t.s)])).toEqual([['1F', 0, 300, ['客廳', '陽台']], ['2F', 300, 300, ['客廳', '陽台']]]);
  });

  it('adds up the takeoff over the storeys', () => {
    const r = buildBuilding(drawingSet(), a, 'set.dxf');
    const t = computeBuildingTakeoff(r.objects, r.cad, {}, DEFAULT_SETTINGS);
    expect(t.rooms.map(x => x.name)).toEqual(['1F 客廳', '1F 陽台', '2F 客廳', '2F 陽台']);
    expect(t.budget.find(b => b.name === 'D1 木門 90*210')?.q).toBe(2);
    expect(t.budget.find(b => b.name === 'W1 鋁窗 150*120')?.q).toBe(2);
    // every budget quantity is backed by calculation rows per storey
    const d1 = t.calc.filter(c => c.item === 'D1 木門 90*210');
    expect(d1.map(c => [c.fl, c.q])).toEqual([['1F', 1], ['2F', 1]]);
    const conc = t.calc.filter(c => c.item === CONCRETE);
    expect(conc.some(c => c.where === '樓板' && /面積 [\d.]+ ㎡ × 厚 0.15 m/.test(c.expr))).toBe(true);
    expect(t.budget.find(b => b.name === CONCRETE)?.q).toBeCloseTo(conc.reduce((s, c) => s + c.q, 0), 1);
    expect(t.calc.find(c => c.item === '欄杆 H=110cm')?.q).toBeCloseTo(5.6, 1);
  });

  it('turns the thin edge of a balcony into a railing', () => {
    const r = buildBuilding(drawingSet(), a, 'set.dxf');
    const rails = r.objects.filter(o => isBox(o) && /欄杆/.test(o.name));
    expect(rails.map(o => isBox(o) && [o.floor, o.layer, o.h, Math.round(Math.max(o.w, o.d))])).toEqual([['1F', 'rail', 110, 560], ['2F', 'rail', 110, 560]]);
    expect(r.objects.some(o => isBox(o) && o.layer === 'wall' && o.floor === '1F' && Math.abs(o.z - (r.cad.D - 400)) < 1 && o.w > 500)).toBe(false);
  });
});

describe('drawingFromDwg', () => {
  it('flattens block inserts and keeps attribute tags', () => {
    const db: DwgDatabase = {
      header: { INSUNITS: 5 },
      tables: { BLOCK_RECORD: { entries: [{ name: 'TAG', basePoint: { x: 0, y: 0 }, entities: [{ type: 'LINE', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 } }] }] } },
      entities: [{
        type: 'INSERT', layer: '編號_門', name: 'TAG', insertionPoint: { x: 100, y: 50 }, xScale: 2, yScale: 2, rotation: Math.PI / 2,
        attribs: [{ type: 'ATTRIB', layer: '編號_門', tag: 'NO', text: { text: 'D1', startPoint: { x: 100, y: 50 }, textHeight: 15 } }],
      }],
    };
    const d = drawingFromDwg(db);
    expect(d.units).toBe(5);
    expect(d.segs).toHaveLength(1);
    expect(d.segs[0].layer).toBe('編號_門');
    expect(d.segs[0].b[0]).toBeCloseTo(100);
    expect(d.segs[0].b[1]).toBeCloseTo(70);
    expect(d.texts).toEqual([{ layer: '編號_門', x: 100, y: 50, s: 'D1', h: 15, tag: 'NO' }]);
  });
});

describe('legend', () => {
  it('reads Taiwanese opening codes', () => {
    expect([openingType('DW1', '氣密窗'), openingName('DW1', '氣密窗')]).toEqual(['french', '氣密落地窗']);
    expect([openingType('SD1', '鐵門'), openingName('SD1', '鐵門')]).toEqual(['shutter', '鐵捲門']);
    expect(openingType('F4', '防火捲門')).toBe('shutter');
    expect(openingType('F2', '防火氣密窗')).toBe('window');
    expect(openingType('F1', '防火門')).toBe('swing');
  });
});

describe('stairs', () => {
  it('builds a dog-leg stair from two flights of tread lines', () => {
    const segs = [];
    for (let i = 0; i < 7; i++) {
      segs.push({ x1: 0, z1: 100 + i * 25, x2: 100, z2: 100 + i * 25 });
      segs.push({ x1: 100, z1: 100 + i * 25, x2: 200, z2: 100 + i * 25 });
    }
    const flights = findFlights(segs);
    expect(flights.map(f => [f.lo, f.hi, f.at.length])).toEqual([[0, 100, 7], [100, 200, 7]]);
    const [sp] = planStairs(flights, 320, [{ x: 50, z: 90 }], () => 350);
    expect(sp.risers).toBe(14);
    expect(sp.steps).toHaveLength(12);
    expect(sp.landings[0]).toMatchObject({ x0: 0, x1: 200, z0: 250, z1: 350, top: 160 });
    expect(Math.max(...sp.steps.map(s => s.top))).toBeCloseTo(160 + 160 / 7 * 6, 5);
  });
});

describe('mergeDrawings', () => {
  it('lays several files side by side', () => {
    const one = (x: number): DxfDrawing => ({ segs: [{ layer: 'A', a: [x, 0], b: [x + 100, 0] }], polys: [], texts: [{ layer: 'T', x, y: 0, s: 'x' }], arcs: [], layers: new Map([['A', 1]]), units: 5, version: '', blockCount: 0, inserts: 0 });
    const m = mergeDrawings([one(0), one(0)]);
    expect(m.segs.map(s => s.a[0])).toEqual([0, 1100]);
    expect(m.layers.get('A')).toBe(2);
  });
  it('keeps the architectural plans when a structural file comes first', () => {
    const arch = drawingSet();
    // structural sheets: big titles, beam layout plans of the same storeys, no walls
    const st: DxfDrawing = { segs: [], polys: [], texts: [], arcs: [], layers: new Map(), units: 4, version: '', blockCount: 0, inserts: 0 };
    for (const [i, t] of ['二層結構平面圖', '三層梁配筋平面圖', '基礎平面圖'].entries()) {
      st.texts.push({ layer: 'TITLE', x: i * 40000, y: 0, s: t, h: 1500 });
      st.segs.push({ layer: 'BEAM', a: [i * 40000 + 3000, 3000], b: [i * 40000 + 9000, 3000] });
    }
    const run = (d: DxfDrawing) => { const a = analyzeBuilding(d)!; return { analysis: a, objects: buildBuilding(d, a, 'x').objects }; };
    const one = run(arch), both = run(mergeDrawings([st, arch]));
    expect(both.analysis.storeys.map(s => s.key)).toEqual(one.analysis.storeys.map(s => s.key));
    expect(both.objects.filter(o => o.layer === 'wall').length).toBe(one.objects.filter(o => o.layer === 'wall').length);
  });
});
