import { describe, expect, it } from 'vitest';
import { buildFromDxf, computeTakeoff, DEFAULT_SETTINGS, guessLayerKind, parseDxf, SAMPLE_D, SAMPLE_ROOMS, SAMPLE_W, sampleDxf, sampleObjects, materialRates, materialsOf, priceBudget, withPricing, type LayerKind } from '../src';

const line = (t: ReturnType<typeof computeTakeoff>, name: string) => t.budget.find(b => b.name === name)?.q;

describe('takeoff on the sample flat', () => {
  const t = computeTakeoff({
    objects: sampleObjects(), bounds: { W: SAMPLE_W, D: SAMPLE_D },
    labels: SAMPLE_ROOMS.map(r => ({ n: r.n, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 })),
    rects: SAMPLE_ROOMS, finishes: {}, settings: DEFAULT_SETTINGS,
  });
  it('measures every room', () => {
    expect(t.rooms).toHaveLength(11);
    expect(t.floorArea).toBeCloseTo(97.46, 1);
  });
  it('counts doors and windows by size', () => {
    expect(line(t, 'D 門 80*210')).toBe(5);
    expect(line(t, 'D 門 90*210')).toBe(2);
    expect(line(t, 'W 鋁窗 360*140')).toBe(1);
    expect(line(t, '鋁窗玻璃')).toBeCloseTo(8.68, 2);
  });
  it('splits exterior walls by facade', () => {
    const g = t.groups.find(g => g.title === '(牆面)外牆防水處理')!;
    expect(g.rows.map(r => r.name)).toEqual(['北向外牆', '東向外牆', '南向外牆', '西向外牆']);
  });
  it('applies wet-room finishes from the room name', () => {
    expect(t.rooms.find(r => r.name === '雙衛浴區')!.fin).toEqual({ f: 'F5', c: 'C2', w: 'W2' });
    expect(t.groups.some(g => g.title.startsWith('(牆面)廁所'))).toBe(true);
  });
  it('counts faces given a finish by hand instead of the default 二丁掛, and leaves the base coat off stone', () => {
    const tot = (tk: ReturnType<typeof computeTakeoff>, title: string) => tk.groups.find(g => g.title === title)?.total || 0;
    const g0 = tot(t, '(牆面)外牆二丁掛');
    expect(g0).toBeGreaterThan(0);
    expect(tot(t, '(牆面)外牆1:3水泥砂漿打底')).toBeCloseTo(g0, 1);
    const objs = sampleObjects();
    const w = objs.find(o => 'w' in o && o.layer === 'wall' && o.name.startsWith('外牆') && o.w > o.d) as import('../src').BoxObject;
    const f = w.z >= SAMPLE_D / 2 ? 4 : 5, a = w.w * w.h / 1e4;
    const run = (mat: string) => { w.faces = { [f]: mat }; return computeTakeoff({ objects: objs, bounds: { W: SAMPLE_W, D: SAMPLE_D }, labels: [], rects: SAMPLE_ROOMS, finishes: {}, settings: DEFAULT_SETTINGS }); };
    const t3 = run('外牆1:3水泥砂漿打底+抿石子');
    expect(tot(t3, '(牆面)外牆抿石子')).toBeCloseTo(a, 1);
    expect(tot(t3, '(牆面)外牆二丁掛')).toBeCloseTo(g0 - a, 1);
    expect(tot(t3, '(牆面)外牆1:3水泥砂漿打底')).toBeCloseTo(g0, 1);
    const t4 = run('外牆石材乾掛');
    expect(tot(t4, '(牆面)外牆石材乾掛')).toBeCloseTo(a, 1);
    expect(tot(t4, '(牆面)外牆1:3水泥砂漿打底')).toBeCloseTo(g0 - a, 1);
  });
  it('runs exterior waterproofing along frames and floor joints, or over the wall area when asked', () => {
    expect(t.groups.find(g => g.title === '(牆面)外牆防水處理')!.unit).toBe('M');
    const t4 = computeTakeoff({ objects: sampleObjects(), bounds: { W: SAMPLE_W, D: SAMPLE_D }, labels: [], rects: SAMPLE_ROOMS, finishes: {}, settings: { ...DEFAULT_SETTINGS, extWater: 'area', wetH: 120 } });
    expect(t4.groups.find(g => g.title === '(牆面)外牆防水處理')!.unit).toBe('M2');
    expect(t4.groups.some(g => g.title.includes('防水處理(H=1.2M)'))).toBe(true);
  });
  it('uses the 建材項目 list: own finishes, own budget items and default prices', () => {
    const materials = [
      { name: '地坪超耐磨木地板', use: 'floor' as const, unit: '㎡', mat: 2800 },
      { name: '外牆1:3水泥砂漿打底+石材乾掛', use: 'ext' as const, unit: '㎡' },
      { name: '室內門檻石', use: 'item' as const, unit: '支', sec: '四、泥作.裝修工程' },
    ];
    const t5 = computeTakeoff({ objects: sampleObjects(), bounds: { W: SAMPLE_W, D: SAMPLE_D }, labels: [], rects: SAMPLE_ROOMS,
      finishes: { 次臥室: { f: '地坪超耐磨木地板' } }, settings: { ...DEFAULT_SETTINGS, materials, extName: '外牆1:3水泥砂漿打底+石材乾掛' } });
    expect(t5.groups.find(g => g.title === '(地坪)地坪超耐磨木地板')!.rows.map(r => r.name)).toEqual(['次臥室']);
    expect(t5.groups.some(g => g.title === '(牆面)外牆石材乾掛')).toBe(true);
    expect(t5.groups.some(g => g.title === '(牆面)外牆1:3水泥砂漿打底')).toBe(false);
    expect(t5.budget.find(b => b.name === '室內門檻石')).toMatchObject({ tpl: true, unit: '支' });
    const pb = priceBudget(t5.budget, withPricing(null), materialRates(materialsOf(materials)));
    expect(pb.sections.flatMap(s => s.lines).find(l => l.name === '地坪超耐磨木地板')!.mat).toBe(2800);
  });
  it('honours finish overrides', () => {
    const t2 = computeTakeoff({
      objects: sampleObjects(), bounds: { W: SAMPLE_W, D: SAMPLE_D }, labels: [], rects: SAMPLE_ROOMS,
      finishes: { 次臥室: { f: 'F1' } }, settings: DEFAULT_SETTINGS,
    });
    expect(t2.groups.find(g => g.title.startsWith('(地坪)F1'))!.rows.map(r => r.name)).toContain('次臥室');
  });
});

describe('takeoff on an imported drawing', () => {
  it('splits rooms from labels and counts CAD doors', () => {
    const dxf = parseDxf(sampleDxf());
    const map: Record<string, LayerKind> = {};
    for (const l of dxf.layers.keys()) map[l] = guessLayerKind(l);
    const res = buildFromDxf(dxf, map, 0.1, 280, 'sample.dxf')!;
    const t = computeTakeoff({ objects: res.objects, bounds: { W: res.cad.W, D: res.cad.D }, labels: res.cad.texts.map(x => ({ n: x.s, x: x.x, z: x.z })), cadDoors: res.cad.doors, finishes: {}, settings: DEFAULT_SETTINGS });
    const names = t.rooms.map(r => r.name);
    expect(names).toContain('主臥室');
    expect(names).toContain('浴室');
    expect(t.rooms.find(r => r.name === '主臥室')!.area).toBeGreaterThan(9.5);
    expect(t.budget.filter(b => b.name?.startsWith('D 門')).reduce((s, b) => s + (b.q as number), 0)).toBe(5);
  });
});
