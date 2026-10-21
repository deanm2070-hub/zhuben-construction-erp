import { describe, expect, it } from 'vitest';
import { mergeCoplanar } from '../src';

const box = (w: number, h: number, d: number) => {
  const c = [[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0], [0, 0, d], [w, 0, d], [w, h, d], [0, h, d]];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  return q.flatMap(([a, b, c2, e]) => [a, b, c2, a, c2, e].flatMap(i => c[i]));
};

describe('mergeCoplanar', () => {
  it('turns a box of 12 triangles into 6 quads', () => {
    const f = mergeCoplanar(box(100, 50, 20));
    expect(f).toHaveLength(6);
    expect(f.every(p => p.length === 4)).toBe(true);
  });
  it('keeps two separate faces on one plane apart', () => {
    const t = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0];
    const f = mergeCoplanar([...t, ...t.map((v, i) => i % 3 === 0 ? v + 50 : v)]);
    expect(f).toHaveLength(2);
  });
});
