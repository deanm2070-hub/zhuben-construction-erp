import { describe, expect, it } from 'vitest';
import { learnRoles, partKind, trackFixes, type Fix } from '../src/learn';
import type { BoxObject, CadData, ModelObject } from '../src/types';

const wall = (id: number, x: number, src = 'C3', t = 10): BoxObject => ({ id, layer: 'wall', name: '隔間牆（CAD）', x, z: 0, w: 200, d: t, h: 300, y: 0, color: 0, floor: '1F', src });
const cad: CadData = { name: 'x', W: 1000, D: 1000, segs: [], texts: [], doors: [], layers: ['A', 'GREEN'],
  floors: [{ key: '1F', title: '', y: 0, h: 300, segs: [0, 495, 400, 495, 0, 505, 400, 505, 0, 300, 400, 300], segLayer: [1, 1, 0], texts: [] }] };

describe('learning from corrections', () => {
  it('deleting most of a layer marks it not walls, and undo takes it back', () => {
    const base = new Map<number, ModelObject>([1, 2, 3, 4].map(i => [i, wall(i, i * 300, 'HATCH')]));
    let fx = trackFixes({}, base, [wall(4, 1200, 'HATCH')], cad);
    expect(Object.keys(fx)).toHaveLength(3);
    expect(learnRoles(Object.values(fx), [wall(4, 1200, 'HATCH')]).roles).toEqual({ HATCH: 'ignore' });
    const b2 = new Map<number, ModelObject>([[4, wall(4, 1200, 'HATCH')]]);
    fx = trackFixes(fx, b2, [wall(1, 300, 'HATCH'), wall(4, 1200, 'HATCH')], cad);
    expect(Object.keys(fx)).toHaveLength(2);
  });
  it('type changes and hand-added walls teach the layer', () => {
    const w1 = wall(1, 0, 'W2', 20), w2 = wall(2, 400, 'W2', 20);
    expect(partKind(w1)).toBe('RC牆');
    const base = new Map<number, ModelObject>([[1, w1], [2, w2]]);
    const now: ModelObject[] = [{ ...w1, wall: 'light' }, { ...w2, wall: 'light' }];
    const fx = trackFixes({}, base, now, cad);
    expect(learnRoles(Object.values(fx), now).roles).toEqual({ W2: 'light' });
    const add = (id: number): BoxObject => ({ ...wall(id, 200, ''), src: undefined, name: '牆（手動補牆）', z: 500 });
    const f2 = trackFixes({}, new Map(), [add(10), add(11)], cad);
    expect(Object.values(f2).map((f: Fix) => f.layers)).toEqual([['GREEN'], ['GREEN']]);
    expect(learnRoles(Object.values(f2), []).roles).toEqual({ GREEN: 'wall' });
  });
});
