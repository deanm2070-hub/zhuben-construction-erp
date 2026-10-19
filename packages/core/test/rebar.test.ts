import { describe, expect, it } from 'vitest';
import { computeRebar, floorRange, ldhOf, lstOf, readRebarSpec, rebarSummary, REBAR_STD, type BoxObject, type CadData, type DxfDrawing } from '../src';

const KEYS = ['1F', '2F', '3F', '4F', '5F', 'R1F', 'RF'];
function sheet(texts: [string, number, number, number?][]): DxfDrawing {
  return { segs: [], polys: [], texts: texts.map(([s, x, y, h]) => ({ layer: 'TXT', s, x, y, h: h ?? 8 })), arcs: [], layers: new Map(), units: 0, version: 'AC1027', blockCount: 0, inserts: 0 };
}

describe('rebar standards', () => {
  it('reads the floor tokens of the detail sheets', () => {
    expect(floorRange('2~R1F', KEYS)).toEqual(['2F', '3F', '4F', '5F', 'R1F']);
    expect(floorRange('2~PRF', KEYS)).toEqual(['2F', '3F', '4F', '5F', 'R1F', 'RF']);
    expect(floorRange('R', KEYS)).toEqual(['R1F']);
    expect(floorRange('P', KEYS)).toEqual(['RF']);
  });
  it('uses the S0 tables: SD280 up to #5, SD420 from #6', () => {
    expect(lstOf(3)).toBe(32);
    expect(lstOf(6)).toBe(95);
    expect(ldhOf(6)).toBe(29);
    expect(REBAR_STD.kg[6]).toBe(2.25);
  });
});

describe('reinforcement sheets', () => {
  // a beam detail: name under the drawing, top bars above the stirrups, bottom below
  const beam = sheet([
    ['%%U2G1a(30X60)', 1000, 0, 16],
    ['3-#6', 990, 140], ['4-#6', 1180, 140], ['100', 1170, 170],
    ['#3-11@15', 990, 90], ['#3-11@12', 1130, 90],
    ['3-#6', 990, 40],
  ]);
  // a column schedule: marks across, storeys down
  const cols = sheet([
    ['C-NO', 660, 1570, 9], ['C2', 1008, 1560, 12], ['2F', 652, 1440, 12],
    ['斷 面', 649, 1360, 9], ['40 X 60', 925, 1360, 9],
    ['鋼 筋', 649, 1345, 9], ['20-#7', 934, 1345, 9],
    ['圍束區', 653, 1330, 9], ['#4@10', 950, 1330, 9], ['4', 1026, 1330, 9], ['2', 1058, 1330, 9],
    ['中央區', 653, 1315, 9], ['#4@12', 950, 1315, 9],
    ['接 頭', 649, 1300, 9], ['#4@10', 950, 1300, 9],
  ]);
  it('reads beam callouts, stirrup zones and cut-off lengths', () => {
    const spec = readRebarSpec(beam, KEYS)!;
    const b = spec.beams[0];
    expect(b).toMatchObject({ mark: 'G1a', floors: ['2F'], b: 30, h: 60 });
    expect(b.top.map(c => c.n)).toEqual([3, 4]);
    expect(b.top[1].cut).toBe(100);
    expect(b.bot).toHaveLength(1);
    expect(b.stir.map(z => `${z.n}@${z.at}`)).toEqual(['11@15', '11@12']);
  });
  it('reads the column schedule', () => {
    const c = readRebarSpec(cols, KEYS)!.columns[0];
    expect(c).toMatchObject({ fl: '2F', mark: 'C2', b: 40, h: 60, bars: [{ n: 20, s: 7 }] });
    expect(c.hoop).toEqual({ s: 4, at: [10, 12, 10], ties: [4, 2] });
  });
  it('lists every bar with its length and weight', () => {
    const spec = readRebarSpec({ ...beam, texts: [...beam.texts, ...cols.texts] }, KEYS)!;
    const box = (o: Partial<BoxObject>): BoxObject => ({ id: 1, layer: 'slab', name: '', x: 0, z: 0, w: 300, d: 30, h: 60, y: 0, color: 0, ...o });
    const objects = [
      box({ name: '梁 G1a（結構圖）', floor: '1F', x: 150, rc: { kind: 'beam', mark: 'G1a', fl: '2F' } }),
      box({ layer: 'wall', name: '柱', floor: '2F', w: 40, d: 60, h: 320, rc: { kind: 'column', mark: 'C2', fl: '2F', b: 40, h: 60 } }),
    ];
    const cad: CadData = { name: 'x', W: 1000, D: 1000, segs: [], texts: [], doors: [], floors: KEYS.map((key, i) => ({ key, title: key, y: i * 320, h: 320, segs: [], texts: [] })), rc: { spec, panels: [] } };
    const { rows, missing } = computeRebar(objects, cad);
    expect(missing).toEqual([]);
    const cont = rows.find(r => r.mark === 'G1a' && r.part === '上層主筋 通長')!;
    // 300 span + hooked anchorage ldh 29 + 31 at both free ends
    expect(cont).toMatchObject({ s: 6, n: 3, len: 300 + 2 * (29 + 31) });
    expect(cont.kg).toBeCloseTo(4.2 * 3 * 2.25, 1);
    expect(rows.find(r => r.part === '上層端部補強筋')).toMatchObject({ n: 1, len: Math.round(100 + 60) });
    expect(rows.find(r => r.mark === 'G1a' && r.part === '箍筋')).toMatchObject({ s: 3, n: 22 });
    const main = rows.find(r => r.mark === 'C2' && r.part === '主筋')!;
    // storey 320 + half a lap (staggered every other storey) + hooked into the beam at the top
    expect(main.n).toBe(20);
    expect(main.len).toBe(Math.round(320 + 137 / 2 + 60 - 8 + 36));
    const sum = rebarSummary(rows);
    expect(sum.byFloor.get('2F')!.合計).toBeCloseTo(rows.reduce((a, r) => a + r.kg, 0), 5);
  });
});
