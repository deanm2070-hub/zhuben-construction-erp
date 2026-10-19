/**
 * Stairs from plan linework: the tread lines of each flight are parallel lines of the
 * same length at an even spacing (STAIR layer). Two flights side by side with the same
 * run make a dog-leg stair with a half landing at the far end; a lone flight is straight.
 */

export interface StairFlight {
  /** the tread lines run across this axis; the flight climbs along the other */
  axis: 'x' | 'z';
  /** across: tread line extent */
  lo: number;
  hi: number;
  /** along: tread line positions, ascending */
  at: number[];
}

export interface StairStep { x0: number; x1: number; z0: number; z1: number; top: number }
export interface StairPlan {
  steps: StairStep[];
  landings: StairStep[];
  /** inner handrail, one piece per step: plan line at a height (top of the step) */
  rails: { x0: number; z0: number; x1: number; z1: number; top: number }[];
  /** plan rectangles the stair occupies above the floor (flights and half landing) */
  holes: { x0: number; x1: number; z0: number; z1: number }[];
  risers: number;
  width: number;
  /** tread depth, cm */
  run: number;
}

type Seg = { x1: number; z1: number; x2: number; z2: number };

export function findFlights(segs: Seg[]): StairFlight[] {
  const groups = new Map<string, { axis: 'x' | 'z'; lo: number; hi: number; at: number[] }>();
  for (const s of segs) {
    // horizontal lines (along x) are treads of a flight climbing along z
    const horiz = Math.abs(s.z1 - s.z2) < 0.5, vert = Math.abs(s.x1 - s.x2) < 0.5;
    if (!horiz && !vert) continue;
    const lo = horiz ? Math.min(s.x1, s.x2) : Math.min(s.z1, s.z2), hi = horiz ? Math.max(s.x1, s.x2) : Math.max(s.z1, s.z2);
    if (hi - lo < 50 || hi - lo > 250) continue;
    const axis = horiz ? 'z' : 'x';
    const k = `${axis}${Math.round(lo / 3)},${Math.round(hi / 3)}`;
    if (!groups.has(k)) groups.set(k, { axis, lo, hi, at: [] });
    groups.get(k)!.at.push(horiz ? s.z1 : s.x1);
  }
  const out: StairFlight[] = [];
  for (const g of groups.values()) {
    const at = [...new Set(g.at.map(v => Math.round(v * 2) / 2))].sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > 3);
    // runs with an even tread depth
    let run: number[] = [];
    const flush = () => { if (run.length >= 3) out.push({ axis: g.axis, lo: g.lo, hi: g.hi, at: run }); run = []; };
    for (const v of at) {
      if (run.length >= 2) {
        const step = run[1] - run[0], d = v - run[run.length - 1];
        // one tread line left out of the drawing
        if (Math.abs(d - 2 * step) <= 3) run.push(run[run.length - 1] + step);
        else if (Math.abs(d - step) > 3) { flush(); }
      } else if (run.length === 1) {
        const d = v - run[0];
        if (d < 15 || d > 40) run = [];
      }
      run.push(v);
    }
    flush();
  }
  return out;
}

/**
 * A flight of n tread lines has n risers: the first and last lines are the nosings at the
 * landings, so n - 1 treads lie between them.
 *
 * Builds the steps of the stairs on one storey of height H.
 * `start` is where the up arrow / 上 label sits; the flight closest to it starts the climb.
 * `extent` returns how far the stair linework reaches along a flight past a given position.
 */
export function planStairs(flights: StairFlight[], H: number, start: { x: number; z: number }[], extent: (f: StairFlight, dir: 1 | -1) => number): StairPlan[] {
  const used = new Set<StairFlight>();
  const plans: StairPlan[] = [];
  const near = (f: StairFlight, p: { x: number; z: number }) => {
    const across = f.axis === 'z' ? p.x : p.z, along = f.axis === 'z' ? p.z : p.x;
    return across > f.lo - 10 && across < f.hi + 10 && along > f.at[0] - 120 && along < f.at[f.at.length - 1] + 120;
  };
  const rect = (f: StairFlight, a: number, b: number, lo = f.lo, hi = f.hi) => f.axis === 'z'
    ? { x0: lo, x1: hi, z0: Math.min(a, b), z1: Math.max(a, b) }
    : { x0: Math.min(a, b), x1: Math.max(a, b), z0: lo, z1: hi };
  const railAt = (f: StairFlight, across: number, a: number, b: number, top: number) => f.axis === 'z'
    ? { x0: across, x1: across, z0: a, z1: b, top }
    : { x0: a, x1: b, z0: across, z1: across, top };

  for (const A of flights) {
    if (used.has(A)) continue;
    const n = A.at.length;
    const B = flights.find(q => q !== A && !used.has(q) && q.axis === A.axis && q.at.length === n
      && Math.abs(q.at[0] - A.at[0]) < 3 && Math.abs(q.at[n - 1] - A.at[n - 1]) < 3
      && (Math.abs(q.lo - A.hi) < 40 || Math.abs(A.lo - q.hi) < 40));
    used.add(A);
    const first = A.at[0], last = A.at[n - 1];
    const steps: StairStep[] = [], landings: StairStep[] = [], rails: StairPlan['rails'] = [], holes: StairPlan['holes'] = [];
    if (!B) {
      // straight flight: climbs the whole storey, upward away from the 上 label end
      const risers = n, r = H / risers;
      const up = start.some(p => near(A, p) && Math.abs((A.axis === 'z' ? p.z : p.x) - last) < Math.abs((A.axis === 'z' ? p.z : p.x) - first)) ? -1 : 1;
      const at = up > 0 ? A.at : [...A.at].reverse();
      for (let j = 1; j < n; j++) steps.push({ ...rect(A, at[j - 1], at[j]), top: j * r });
      for (let j = 1; j < n; j++) rails.push(railAt(A, A.hi, at[j - 1], at[j], j * r));
      holes.push(rect(A, at[0], at[n - 1]));
      plans.push({ steps, landings, rails, holes, risers, width: A.hi - A.lo, run: (A.at[n - 1] - A.at[0]) / (n - 1) });
      continue;
    }
    used.add(B);
    // the flight nearer the 上 label climbs first; the floor landing is at the label end
    const startA = start.find(p => near(A, p)), startB = start.find(p => near(B, p));
    const up = startB && !startA ? B : A, down = up === A ? B : A;
    const s = startA || startB;
    const sAlong = s ? (A.axis === 'z' ? s.z : s.x) : first;
    const dir: 1 | -1 = Math.abs(sAlong - first) <= Math.abs(sAlong - last) ? 1 : -1;
    const at = dir > 0 ? A.at : [...A.at].reverse();
    const half = H / 2, risers = n, r = half / risers;
    for (let j = 1; j < n; j++) steps.push({ ...rect(up, at[j - 1], at[j]), top: j * r });
    for (let j = 1; j < n; j++) steps.push({ ...rect(down, at[n - j], at[n - j - 1]), top: half + j * r });
    // half landing across both flights, out to the end of the stair linework
    const lo = Math.min(A.lo, B.lo), hi = Math.max(A.hi, B.hi), end = extent(A, dir);
    const far = Math.abs(end - at[n - 1]) > 20 ? end : at[n - 1] + dir * (up.hi - up.lo);
    landings.push({ ...rect(A, at[n - 1], far, lo, hi), top: half });
    const inner = up.hi <= down.lo + 1 ? (up.hi + down.lo) / 2 : (up.lo + down.hi) / 2;
    for (let j = 1; j < n; j++) rails.push(railAt(A, inner, at[j - 1], at[j], j * r));
    for (let j = 1; j < n; j++) rails.push(railAt(A, inner, at[n - j], at[n - j - 1], half + j * r));
    holes.push(rect(A, at[0], far, lo, hi));
    plans.push({ steps, landings, rails, holes, risers: risers * 2, width: up.hi - up.lo, run: (A.at[n - 1] - A.at[0]) / (n - 1) });
  }
  return plans;
}
