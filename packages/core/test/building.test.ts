import { describe, expect, it } from 'vitest';
import {
  analyzeBuilding, buildBuilding, computeBuildingTakeoff, DEFAULT_SETTINGS, drawingFromDwg, isBox, isDoor, parseFloors,
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
      { code: 'D1', w: 90, h: 210, name: '木門', sill: 0, kind: 'door' },
      { code: 'W1', w: 150, h: 120, name: '鋁窗', sill: 100, kind: 'window' },
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
    expect(r.cad.floors!.map(f => [f.key, f.y, f.h, f.texts.map(t => t.s)])).toEqual([['1F', 0, 300, ['客廳']], ['2F', 300, 300, ['客廳']]]);
  });

  it('adds up the takeoff over the storeys', () => {
    const r = buildBuilding(drawingSet(), a, 'set.dxf');
    const t = computeBuildingTakeoff(r.objects, r.cad, {}, DEFAULT_SETTINGS);
    expect(t.rooms.map(x => x.name)).toEqual(['1F 客廳', '2F 客廳']);
    expect(t.budget.find(b => b.name === 'D1 木門 90*210')?.q).toBe(2);
    expect(t.budget.find(b => b.name === 'W1 鋁窗 150*120')?.q).toBe(2);
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
