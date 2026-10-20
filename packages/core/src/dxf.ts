/** Minimal ASCII DXF reader: lines, polylines, arcs, circles, text and block inserts. */
export type Pt = [number, number];
/** `color` is the AutoCAD colour index when the file gives one (1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white) */
export interface DxfSeg { layer: string; a: Pt; b: Pt; color?: number }
export interface DxfPoly { layer: string; pts: Pt[]; closed: boolean }
export interface DxfText { layer: string; x: number; y: number; s: string; /** text height */ h?: number; /** attribute tag (ATTRIB) */ tag?: string }
export interface DxfArc { layer: string; c: Pt; r: number; sweep: number; /** start and end points */ p0?: Pt; p1?: Pt }
export interface DxfDrawing {
  segs: DxfSeg[];
  polys: DxfPoly[];
  texts: DxfText[];
  arcs: DxfArc[];
  /** entity count per layer */
  layers: Map<string, number>;
  /** $INSUNITS header value (0 when absent) */
  units: number;
  /** $ACADVER header value, e.g. AC1032 */
  version: string;
  blockCount: number;
  inserts: number;
  /** x ranges of the files a merged drawing was put together from */
  parts?: { x0: number; x1: number; name?: string }[];
}

export const DWG_VERSIONS: Record<string, string> = {
  AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004',
  AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018–2025',
};
const CODEPAGES: Record<string, string> = { ANSI_950: 'big5', ANSI_936: 'gbk', ANSI_932: 'shift_jis', ANSI_949: 'euc-kr', ANSI_1252: 'windows-1252' };

/** Returns the DWG version code (e.g. AC1032) when the bytes are a DWG file, else null. */
export function dwgSignature(bytes: Uint8Array): string | null {
  const head = String.fromCharCode(...bytes.slice(0, 6));
  return /^AC10\d\d$/.test(head) ? head : null;
}

/** Decodes DXF bytes. Files before AutoCAD 2007 use the drawing's ANSI code page (Big5 for Traditional Chinese). */
export function decodeDxf(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 300000));
  const ver = (head.match(/\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/) || [])[1] || '';
  const cp = (head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\w+)/) || [])[1] || '';
  let enc = 'utf-8';
  if (ver && ver < 'AC1021' && CODEPAGES[cp]) enc = CODEPAGES[cp];
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

export function cleanText(s: string): string {
  return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;\\{}]*;/g, '').replace(/[{}]/g, '')
    .replace(/%%[cdp]/gi, '').replace(/\s+/g, ' ').trim();
}

interface Entity { type: string; codes: [number, string][] }
interface Block { name: string; bx: number; by: number; ents: Entity[] }
interface Xf { a: number; b: number; c: number; d: number; e: number; f: number }

function codeMap(en: Entity): Record<number, string> {
  const g: Record<number, string> = {};
  for (const [c, v] of en.codes) if (!(c in g)) g[c] = v;
  return g;
}
const all = (en: Entity, code: number) => en.codes.filter(c => c[0] === code).map(c => c[1]);

export function parseDxf(text: string): DxfDrawing {
  const L = text.split(/\r\n|\r|\n/);
  const P: [number, string][] = [];
  for (let i = 0; i + 1 < L.length;) {
    const c = parseInt(L[i].trim(), 10);
    if (isNaN(c)) { i++; continue; }
    P.push([c, L[i + 1].trim()]);
    i += 2;
  }
  let units = 0, version = '', section: string | null = null;
  let cur: Entity | null = null, curBlock: Block | null = null;
  const blocks: Record<string, Block> = {};
  const ents: Entity[] = [];
  const flush = () => {
    if (!cur) return;
    if (cur.type === 'BLOCK') {
      const g = codeMap(cur);
      curBlock = { name: g[2], bx: +g[10] || 0, by: +g[20] || 0, ents: [] };
      blocks[curBlock.name] = curBlock;
    } else if (cur.type === 'ENDBLK') curBlock = null;
    else if (section === 'BLOCKS' && curBlock) curBlock.ents.push(cur);
    else if (section === 'ENTITIES') ents.push(cur);
    cur = null;
  };
  for (let k = 0; k < P.length; k++) {
    const [c, v] = P[k];
    if (c === 0) {
      flush();
      if (v === 'SECTION') { section = P[k + 1] && P[k + 1][0] === 2 ? P[k + 1][1] : null; k++; continue; }
      if (v === 'ENDSEC') { section = null; continue; }
      if (section === 'BLOCKS' || section === 'ENTITIES') cur = { type: v, codes: [] };
    } else if (cur) cur.codes.push([c, v]);
    else if (section === 'HEADER' && c === 9 && P[k + 1]) {
      if (v === '$INSUNITS') units = +P[k + 1][1];
      if (v === '$ACADVER') version = P[k + 1][1];
    }
  }
  flush();

  const out: DxfDrawing = { segs: [], polys: [], texts: [], arcs: [], layers: new Map(), units, version, blockCount: Object.keys(blocks).length, inserts: 0 };
  const bump = (l: string) => out.layers.set(l, (out.layers.get(l) || 0) + 1);
  const seg = (layer: string, a: Pt, b: Pt) => out.segs.push({ layer, a, b });
  const poly = (layer: string, pts: Pt[], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) seg(layer, pts[i], pts[i + 1]);
    if (closed && pts.length > 2) seg(layer, pts[pts.length - 1], pts[0]);
    out.polys.push({ layer, pts, closed });
  };

  function explode(list: Entity[], xf: Xf, inherit: string | null, depth: number) {
    const T = (x: number, y: number): Pt => [xf.a * x + xf.c * y + xf.e, xf.b * x + xf.d * y + xf.f];
    let pl: DxfPoly | null = null;
    for (const en of list) {
      const g = codeMap(en);
      let layer = g[8] || '0';
      if (inherit && layer === '0') layer = inherit;
      const t = en.type;
      if (t === 'LINE') { seg(layer, T(+g[10], +g[20]), T(+g[11], +g[21])); bump(layer); }
      else if (t === 'LWPOLYLINE') {
        const xs = all(en, 10), ys = all(en, 20);
        poly(layer, xs.map((x, i) => T(+x, +ys[i])), (+g[70] & 1) === 1); bump(layer);
      }
      else if (t === 'POLYLINE') pl = { layer, pts: [], closed: (+g[70] & 1) === 1 };
      else if (t === 'VERTEX') { if (pl) pl.pts.push(T(+g[10], +g[20])); }
      else if (t === 'SEQEND') { if (pl) { poly(pl.layer, pl.pts, pl.closed); bump(pl.layer); } pl = null; }
      else if (t === 'ARC' || t === 'CIRCLE') {
        const cx = +g[10], cy = +g[20], r = +g[40];
        const a0 = t === 'ARC' ? +g[50] : 0;
        let a1 = t === 'ARC' ? +g[51] : 360;
        if (a1 <= a0) a1 += 360;
        const n = Math.max(6, Math.ceil((a1 - a0) / 10)), pts: Pt[] = [];
        for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; pts.push(T(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
        for (let i = 0; i + 1 < pts.length; i++) seg(layer, pts[i], pts[i + 1]);
        if (t === 'ARC') out.arcs.push({ layer, c: T(cx, cy), r: r * Math.sqrt(Math.abs(xf.a * xf.d - xf.b * xf.c)), sweep: a1 - a0, p0: pts[0], p1: pts[pts.length - 1] });
        bump(layer);
      }
      else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB') {
        const s = cleanText(all(en, 3).join('') + (g[1] || ''));
        if (s) {
          const [x, y] = T(+g[10], +g[20]), h = (+g[40] || 0) * Math.hypot(xf.a, xf.b);
          out.texts.push(t === 'ATTRIB' ? { layer, x, y, s, h, tag: g[2] } : { layer, x, y, s, h }); bump(layer);
        }
      }
      else if (t === 'INSERT' && depth < 6) {
        const b = blocks[g[2]];
        if (!b) continue;
        out.inserts++;
        const sx = +(g[41] ?? 1) || 1, sy = +(g[42] ?? 1) || 1, r = (+g[50] || 0) * Math.PI / 180, ix = +g[10] || 0, iy = +g[20] || 0;
        const cs = Math.cos(r), sn = Math.sin(r);
        const la = sx * cs, lb = sx * sn, lc = -sy * sn, ld = sy * cs;
        const le = ix - (la * b.bx + lc * b.by), lf = iy - (lb * b.bx + ld * b.by);
        explode(b.ents, {
          a: xf.a * la + xf.c * lb, b: xf.b * la + xf.d * lb, c: xf.a * lc + xf.c * ld, d: xf.b * lc + xf.d * ld,
          e: xf.a * le + xf.c * lf + xf.e, f: xf.b * le + xf.d * lf + xf.f,
        }, layer, depth + 1);
      }
    }
  }
  explode(ents, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, null, 0);
  return out;
}
