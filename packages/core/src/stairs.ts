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

export interface StairStep { x0: number; x1: number; z0: number; z1: number; top: number; soffit?: { axis: 'x' | 'z'; lo: number; hi: number } }
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
  return joinFlights(out);
}

/**
 * Pieces of one flight drawn apart: tread lines broken by a cut line (the part above the cut drawn shorter or longer)
 * or a straight stair with a landing part-way (the same width and tread depth on both sides of a gap up to 2.5 m).
 * They become one flight whose lines keep the gap; the gap is the landing.
 */
function joinFlights(fl: StairFlight[]): StairFlight[] {
  const run = (f: StairFlight) => (f.at[f.at.length - 1] - f.at[0]) / (f.at.length - 1);
  const out = [...fl];
  for (let again = true; again;) {
    again = false;
    for (const a of out) for (const b of out) {
      if (a === b || a.axis !== b.axis || b.at[0] <= a.at[a.at.length - 1]) continue;
      // across: the narrower one lies within the wider, give or take 10 cm
      const inside = (p: StairFlight, q: StairFlight) => p.lo >= q.lo - 10 && p.hi <= q.hi + 10;
      if (!inside(a, b) && !inside(b, a)) continue;
      if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) < 0.7 * Math.min(a.hi - a.lo, b.hi - b.lo)) continue;
      const ra = run(a), rb = run(b), gap = b.at[0] - a.at[a.at.length - 1];
      if (Math.abs(ra - rb) > 3 || gap > 250 || gap < ra - 3) continue;
      const j: StairFlight = { axis: a.axis, lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), at: [...a.at, ...b.at] };
      out.splice(out.indexOf(a), 1, j); out.splice(out.indexOf(b), 1);
      again = true;
      break;
    }
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
export function planStairs(flights: StairFlight[], H: number, start: { x: number; z: number }[], extent: (f: StairFlight, dir: 1 | -1) => number,
  /** a riser count written on the plan (UP45): every riser is H / N, and a U stair goes on round its two flights
   * (one storey above another, past a mezzanine) until all N are climbed */
  count?: number): StairPlan[] {
  const used = new Set<StairFlight>();
  const plans: StairPlan[] = [];
  const near = (f: StairFlight, p: { x: number; z: number }) => {
    const across = f.axis === 'z' ? p.x : p.z, along = f.axis === 'z' ? p.z : p.x;
    return across > f.lo - 10 && across < f.hi + 10 && along > f.at[0] - 120 && along < f.at[f.at.length - 1] + 120;
  };
  const rect = (f: StairFlight, a: number, b: number, lo = f.lo, hi = f.hi) => f.axis === 'z'
    ? { x0: lo, x1: hi, z0: Math.min(a, b), z1: Math.max(a, b) }
    : { x0: Math.min(a, b), x1: Math.max(a, b), z0: lo, z1: hi };
  // waist slab: the underside runs parallel to the nosings, 17 cm (slab thickness along the vertical) below them, never under the floor
  const sof = (f: StairFlight, ua: number, ub: number, va: number, vb: number) => {
    const a = Math.max(0, va - 17), b = Math.max(0, vb - 17);
    return { axis: f.axis, lo: ua < ub ? a : b, hi: ua < ub ? b : a };
  };
  const railAt = (f: StairFlight, across: number, a: number, b: number, top: number) => f.axis === 'z'
    ? { x0: across, x1: across, z0: a, z1: b, top }
    : { x0: a, x1: b, z0: across, z1: across, top };

  for (let A of flights) {
    if (used.has(A)) continue;
    let n = A.at.length;
    const ov = (q: StairFlight) => Math.min(q.at[q.at.length - 1], A.at[n - 1]) - Math.max(q.at[0], A.at[0]);
    // the two flights of a U stair lie side by side; one may show a tread or two fewer (cut short on the plan)
    const B = flights.find(q => q !== A && !used.has(q) && q.axis === A.axis
      && (q.at.length === n ? Math.abs(q.at[0] - A.at[0]) < 3 && Math.abs(q.at[n - 1] - A.at[n - 1]) < 3
        : Math.abs(q.at.length - n) <= (count ? 6 : 3) && ov(q) > 0.7 * Math.min(q.at[q.at.length - 1] - q.at[0], A.at[n - 1] - A.at[0]))
      && (Math.abs(q.lo - A.hi) < 40 || Math.abs(A.lo - q.hi) < 40));
    used.add(A);
    if (B && count && A.at.length + B.at.length >= Math.min(count, 1.5 * Math.max(A.at.length, B.at.length))) {
      used.add(B);
      plans.push(roundU(A, B));
      continue;
    }
    // unequal flights: both take the treads of the longer one
    if (B && B.at.length > n) { A = { ...A, at: B.at }; n = A.at.length; }
    const first = A.at[0], last = A.at[n - 1];
    const steps: StairStep[] = [], landings: StairStep[] = [], rails: StairPlan['rails'] = [], holes: StairPlan['holes'] = [];
    if (!B) {
      // straight flight: climbs the whole storey, upward away from the 上 label end
      const risers = n, r = H / risers;
      const up = start.some(p => near(A, p) && Math.abs((A.axis === 'z' ? p.z : p.x) - last) < Math.abs((A.axis === 'z' ? p.z : p.x) - first)) ? -1 : 1;
      const at = up > 0 ? A.at : [...A.at].reverse();
      for (let j = 1; j < n; j++) steps.push({ ...rect(A, at[j - 1], at[j]), top: j * r, soffit: sof(A, at[j - 1], at[j], (j - 1) * r, j * r) });
      for (const side of [A.lo, A.hi]) for (let j = 1; j < n; j++) rails.push(railAt(A, side, at[j - 1], at[j], j * r));
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
    for (let j = 1; j < n; j++) steps.push({ ...rect(up, at[j - 1], at[j]), top: j * r, soffit: sof(up, at[j - 1], at[j], (j - 1) * r, j * r) });
    for (let j = 1; j < n; j++) steps.push({ ...rect(down, at[n - j], at[n - j - 1]), top: half + j * r, soffit: sof(down, at[n - j], at[n - j - 1], half + (j - 1) * r, half + j * r) });
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

  /** a U stair climbed riser by riser at H / count, each flight as drawn, round and round until count risers */
  function roundU(A: StairFlight, B: StairFlight): StairPlan {
    const N = count!, r = H / N;
    const startA = start.find(p => near(A, p)), startB = start.find(p => near(B, p));
    const first = startB && !startA ? B : A, s = startA || startB;
    const along = (f: StairFlight) => s ? (f.axis === 'z' ? s.z : s.x) : f.at[0];
    // the first flight climbs away from the label; the second comes back
    let dir: 1 | -1 = Math.abs(along(first) - first.at[0]) <= Math.abs(along(first) - first.at[first.at.length - 1]) ? 1 : -1;
    const steps: StairStep[] = [], landings: StairStep[] = [], rails: StairPlan['rails'] = [];
    const lo = Math.min(A.lo, B.lo), hi = Math.max(A.hi, B.hi), inner = A.hi <= B.lo + 1 ? (A.hi + B.lo) / 2 : (A.lo + B.hi) / 2;
    let f = first, k = 0;
    const ends: number[] = [];
    while (k < N - 1) {
      const at = dir > 0 ? f.at : [...f.at].reverse();
      for (let j = 1; j < at.length && k < N - 1; j++) {
        k++;
        steps.push({ ...rect(f, at[j - 1], at[j]), top: k * r, soffit: sof(f, at[j - 1], at[j], (k - 1) * r, k * r) });
        rails.push(railAt(f, inner, at[j - 1], at[j], k * r));
      }
      if (k >= N - 1) break;
      // the turn: a landing across both flights past the last tread, one riser up
      k++;
      const end = at[at.length - 1], far = extent(f, dir);
      const out = Math.abs(far - end) > 20 ? far : end + dir * (f.hi - f.lo);
      ends.push(out);
      landings.push({ ...rect(f, end, out, lo, hi), top: k * r });
      f = f === A ? B : A;
      dir = dir > 0 ? -1 : 1;
    }
    const a0 = Math.min(...A.at, ...B.at, ...ends), a1 = Math.max(...A.at, ...B.at, ...ends);
    return { steps, landings, rails, holes: [rect(A, a0, a1, lo, hi)], risers: N, width: first.hi - first.lo, run: (A.at[A.at.length - 1] - A.at[0]) / (A.at.length - 1) };
  }
}
