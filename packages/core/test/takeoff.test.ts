import { describe, expect, it } from 'vitest';
import { buildFromDxf, computeTakeoff, DEFAULT_SETTINGS, guessLayerKind, parseDxf, SAMPLE_D, SAMPLE_ROOMS, SAMPLE_W, sampleDxf, sampleObjects, type LayerKind } from '../src';

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
