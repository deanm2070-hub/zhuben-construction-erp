import { describe, expect, it } from 'vitest';
import { buildFromDxf, cleanText, decodeDxf, dwgSignature, guessLayerKind, guessUnits, parseDxf, sampleDxf, UNIT_SCALE, type LayerKind } from '../src';

describe('parseDxf', () => {
  const dxf = parseDxf(sampleDxf());
  it('reads header, layers, blocks and inserts', () => {
    expect(dxf.version).toBe('AC1032');
    expect(dxf.units).toBe(4);
    expect(dxf.layers.get('A-WALL')).toBe(28);
    expect(dxf.blockCount).toBe(1);
    expect(dxf.inserts).toBe(6);
    expect(dxf.texts.map(t => t.s)).toContain('主臥室');
  });
  it('inherits the insert layer for block entities on layer 0', () => {
    expect(dxf.polys.filter(p => p.layer === 'A-FURN')).toHaveLength(11);
  });
  it('rotates inserted blocks', () => {
    const rotated = dxf.polys.filter(p => p.layer === 'A-FURN' && p.pts.some(q => Math.abs(q[1] - 2600) < 1e-6));
    expect(rotated).toHaveLength(3);
  });
});

describe('buildFromDxf', () => {
  it('builds walls, doors, windows and furniture from the sample drawing', () => {
    const dxf = parseDxf(sampleDxf());
    const map: Record<string, LayerKind> = {};
    for (const l of dxf.layers.keys()) map[l] = guessLayerKind(l);
    const res = buildFromDxf(dxf, map, UNIT_SCALE[guessUnits(dxf)], 280, 'sample.dxf')!;
    expect(res.stats).toEqual({ walls: 14, singleWalls: 0, doors: 5, windows: 4, furniture: 16 });
    expect(Math.round(res.cad.W)).toBe(920);
    expect(Math.round(res.cad.D)).toBe(740);
    const ext = res.objects.filter(o => o.name === '外牆（CAD）');
    expect(ext).toHaveLength(5);
    expect(res.cad.texts.map(t => t.s)).not.toContain('9000');
  });
});

describe('helpers', () => {
  it('recognises DWG files by signature', () => {
    expect(dwgSignature(new TextEncoder().encode('AC1032xxxx'))).toBe('AC1032');
    expect(dwgSignature(new TextEncoder().encode('  0\nSECTION'))).toBeNull();
  });
  it('decodes Big5 text in pre-2007 DXF files', () => {
    const big5 = new Uint8Array([0xa5, 0x44, 0xaa, 0xd7, 0xab, 0xc7]); // 主臥室
    const head = new TextEncoder().encode('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$DWGCODEPAGE\n3\nANSI_950\n0\nENDSEC\n1\n');
    const buf = new Uint8Array(head.length + big5.length); buf.set(head); buf.set(big5, head.length);
    expect(decodeDxf(buf).endsWith('主臥室')).toBe(true);
  });
  it('strips MTEXT formatting', () => {
    expect(cleanText('{\\fArial|b1;客廳}\\P\\U+5EDA房')).toBe('客廳 廚房');
  });
});
