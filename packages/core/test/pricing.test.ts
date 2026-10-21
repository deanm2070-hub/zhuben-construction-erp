import { describe, expect, it } from 'vitest';
import { budgetKey, budgetOf, carryRates, computeTakeoff, CONCRETE, DEFAULT_SETTINGS, diffVersion, groupQuantities, memberOf, priceBudget, SAMPLE_D, SAMPLE_ROOMS, SAMPLE_W, sampleObjects, SEC, snapshotVersion, withPricing } from '../src';

const t = computeTakeoff({
  objects: sampleObjects(), bounds: { W: SAMPLE_W, D: SAMPLE_D },
  labels: SAMPLE_ROOMS.map(r => ({ n: r.n, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 })),
  rects: SAMPLE_ROOMS, finishes: {}, settings: DEFAULT_SETTINGS,
});
const concQ = t.budget.find(b => b.name === CONCRETE)!.q as number;

describe('pricing the budget', () => {
  const P = withPricing({ rates: { [budgetKey(SEC.rc, CONCRETE, 'M3')]: { mat: 3000, lab: 500, eq: 100, waste: 5 } }, fees: { mgmt: 5, profit: 10, tax: 5 } });
  const pb = priceBudget(t.budget, P);
  const conc = pb.sections.find(s => s.sec === SEC.rc)!.lines.find(l => l.name === CONCRETE)!;
  it('adds waste to the quantity and multiplies each price', () => {
    expect(conc.qw).toBeCloseTo(concQ * 1.05, 1);
    expect(conc.matT).toBe(Math.round(conc.qw * 3000));
    expect(conc.total).toBe(conc.matT + conc.labT + conc.eqT);
    expect(conc.up).toBe(3600);
  });
  it('adds management, profit and tax on the direct cost', () => {
    expect(pb.direct).toBe(conc.total);
    expect(pb.mgmt).toBe(Math.round(pb.direct * 0.05));
    expect(pb.grand).toBe(pb.direct + pb.mgmt + pb.profit + Math.round((pb.direct + pb.mgmt + pb.profit) * 0.05));
    expect(pb.priced).toBe(1);
    expect(pb.count).toBeGreaterThan(10);
  });
  it('prices hand-typed lines in their section', () => {
    const p2 = priceBudget(t.budget, { ...P, custom: [{ id: 'a', sec: SEC.misc, name: '鐵捲門', unit: '樘', q: 2, mat: 30000 }] });
    expect(p2.direct).toBe(pb.direct + 60000);
  });
  it('carries prices over by item name', () => {
    const r = carryRates(P, t.budget);
    expect(Object.values(r)[0].mat).toBe(3000);
  });
  it('compares a saved version with now', () => {
    const v = snapshotVersion('v1', t.floorArea, pb);
    expect(diffVersion(v, pb)).toHaveLength(0);
    const p3 = priceBudget(t.budget, withPricing({ rates: { [budgetKey(SEC.rc, CONCRETE, 'M3')]: { mat: 3500 } } }));
    expect(diffVersion(v, p3).map(d => d.name)).toContain(CONCRETE);
  });
});

describe('grouping quantities', () => {
  it('sums by floor, member and item', () => {
    const byMember = groupQuantities(t.calc, 'member');
    expect(byMember.map(g => g.key)).toContain('裝修');
    const total = (gs: ReturnType<typeof groupQuantities>) => gs.flatMap(g => g.rows).filter(r => r.item === CONCRETE).reduce((a, r) => a + r.q, 0);
    expect(total(groupQuantities(t.calc, 'floor'))).toBeCloseTo(concQ, 1);
    expect(groupQuantities(t.calc, 'item').find(g => g.key === CONCRETE)).toBeTruthy();
  });
  it('sorts 3D parts into member kinds', () => {
    const kinds = new Set(sampleObjects().map(memberOf));
    expect(kinds.has('牆')).toBe(true);
    expect(kinds.has('門窗')).toBe(true);
  });
});

describe('報價單範本工項', () => {
  it('lists template items the model gives no quantity for, and covers combined items', () => {
    const b = budgetOf([
      { sec: SEC.finish, item: 'F2A-地坪1:3水泥砂漿打底+80*80cm拋光石英磚', unit: '㎡', q: 10, fl: '1F', where: '', expr: '' },
      { sec: SEC.rc, item: '鋼筋（SD420＋SD280）', unit: '噸', q: 2, fl: '1F', where: '', expr: '' },
    ] as any);
    const names = b.filter(l => !l.sec).map(l => l.name);
    expect(names).toContain('T頭續接器');
    expect(names).toContain('RH-300*300*10*15');
    expect(names).not.toContain('F2A-地坪80*80cm拋光石英磚-材料');
    expect(names).not.toContain('SD420高拉力鋼筋(#6以上.含#6)');
    expect(b.find(l => l.name === 'T頭續接器')).toMatchObject({ q: 0, tpl: true });
  });
  it('uses a hand-typed quantity, and prices a blank 式 item as 1 式', () => {
    const b = budgetOf([]);
    const P = withPricing({ rates: { [budgetKey(SEC.rc, 'T頭續接器', '個')]: { qty: 40, mat: 50 }, [budgetKey(SEC.temp, '臨時廁所', '式')]: { mat: 3000 } } });
    const pb = priceBudget(b, P);
    const all = pb.sections.flatMap(s => s.lines);
    expect(all.find(l => l.name === 'T頭續接器')).toMatchObject({ q: 40, manual: true, total: 2000 });
    expect(all.find(l => l.name === '臨時廁所')).toMatchObject({ q: 1, lump: true, total: 3000 });
    expect(all.find(l => l.name === '安全圍籬')!.total).toBe(0);
  });
});
