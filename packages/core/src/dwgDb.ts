import { cleanText, DASHED_LT, type DxfDrawing, type Pt } from './dxf';

/* Subset of the database @mlightcad/libredwg-web returns from `convert()`. */
interface V { x: number; y: number }
interface DbEntity {
  /** the block record (model space, a layout's paper space, a block definition) the entity belongs to */
  ownerBlockRecordSoftId?: string;
  type: string;
  layer?: string; colorIndex?: number; lineType?: string;
  startPoint?: V; endPoint?: V;
  vertices?: (V & { bulge?: number })[]; flag?: number;
  center?: V; radius?: number; startAngle?: number; endAngle?: number;
  text?: string | { text?: string; startPoint?: V; textHeight?: number };
  textHeight?: number; height?: number; insertionPoint?: V; tag?: string;
  name?: string; xScale?: number; yScale?: number; rotation?: number;
  attribs?: DbEntity[];
  subDefinitionPoint1?: V; subDefinitionPoint2?: V; measurement?: number;
}
interface DbBlock { name: string; handle?: string; basePoint?: V; entities?: DbEntity[] }
export interface DwgDatabase {
  header?: { INSUNITS?: number; ACADVER?: string };
  tables?: { BLOCK_RECORD?: { entries?: DbBlock[] }; LAYER?: { entries?: { name: string; colorIndex?: number; lineType?: string }[] } };
  entities: DbEntity[];
}

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/** Flattens a libredwg-web database (model space, nested block inserts, attributes) into a DxfDrawing. */
export function drawingFromDwg(db: DwgDatabase, version = ''): DxfDrawing {
  const blocks = new Map((db.tables?.BLOCK_RECORD?.entries || []).map(b => [b.name, b]));
  const out: DxfDrawing = { segs: [], polys: [], texts: [], arcs: [], dims: [], layers: new Map(), units: db.header?.INSUNITS || 0, version: db.header?.ACADVER || version, blockCount: blocks.size, inserts: 0 };
  const layerColor = new Map((db.tables?.LAYER?.entries || []).map(l => [l.name, Math.abs(l.colorIndex ?? 7)]));
  const layerDashed = new Set((db.tables?.LAYER?.entries || []).filter(l => DASHED_LT.test(l.lineType || '')).map(l => l.name));
  const bump = (l: string) => out.layers.set(l, (out.layers.get(l) || 0) + 1);

  const walk = (ents: DbEntity[], m: M, parent: string | null, depth: number, pcolor?: number) => {
    const P = (x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const k = Math.hypot(m[0], m[1]);
    for (const e of ents) {
      const raw = e.layer || '0', layer = raw === '0' && parent ? parent : raw;
      const t = e.type;
      // AutoCAD colour index: 256 = by layer, 0 = by block (the insert's colour)
      // line type: its own, or the layer's when by layer (empty / ByLayer)
      const lt = e.lineType || '', dashed = /^(BYLAYER)?$/i.test(lt) ? layerDashed.has(layer) || layerDashed.has(raw) : DASHED_LT.test(lt);
      const ci = e.colorIndex, color = ci === undefined || ci === 256 ? layerColor.get(layer) ?? layerColor.get(raw) : ci === 0 ? pcolor ?? layerColor.get(layer) : Math.abs(ci);
      if (t === 'LINE' && e.startPoint && e.endPoint) {
        out.segs.push(dashed ? { layer, a: P(e.startPoint.x, e.startPoint.y), b: P(e.endPoint.x, e.endPoint.y), color, dashed } : { layer, a: P(e.startPoint.x, e.startPoint.y), b: P(e.endPoint.x, e.endPoint.y), color }); bump(layer);
      } else if ((t === 'LWPOLYLINE' || t === 'POLYLINE2D') && e.vertices?.length) {
        const pts = e.vertices.map(v => P(v.x, v.y)), closed = ((e.flag || 0) & 1) === 1;
        for (let i = 0; i + 1 < pts.length; i++) out.segs.push(dashed ? { layer, a: pts[i], b: pts[i + 1], color, dashed } : { layer, a: pts[i], b: pts[i + 1], color });
        if (closed && pts.length > 2) out.segs.push(dashed ? { layer, a: pts[pts.length - 1], b: pts[0], color, dashed } : { layer, a: pts[pts.length - 1], b: pts[0], color });
        out.polys.push({ layer, pts, closed }); bump(layer);
      } else if ((t === 'ARC' || t === 'CIRCLE') && e.center && e.radius) {
        const a0 = t === 'ARC' ? e.startAngle || 0 : 0;
        let sw = t === 'ARC' ? (e.endAngle || 0) - a0 : 2 * Math.PI;
        if (sw <= 0) sw += 2 * Math.PI;
        const n = Math.max(6, Math.ceil(sw / 0.17));
        const pts: Pt[] = [];
        for (let i = 0; i <= n; i++) {
          const a = a0 + sw * i / n;
          pts.push(P(e.center.x + e.radius * Math.cos(a), e.center.y + e.radius * Math.sin(a)));
          if (i) out.segs.push({ layer, a: pts[i - 1], b: pts[i], color });
        }
        if (t === 'ARC') out.arcs.push({ layer, c: P(e.center.x, e.center.y), r: e.radius * k, sweep: sw * 180 / Math.PI, p0: pts[0], p1: pts[n] });
        bump(layer);
      } else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB') {
        const obj = typeof e.text === 'object' ? e.text : null;
        const s = cleanText(String(obj ? obj.text ?? '' : e.text ?? ''));
        const p = obj?.startPoint || e.startPoint || e.insertionPoint;
        if (!s || !p) continue;
        const [x, y] = P(p.x, p.y), h = (obj?.textHeight || e.textHeight || e.height || 0) * k;
        out.texts.push(e.tag ? { layer, x, y, s, h, tag: e.tag } : { layer, x, y, s, h }); bump(layer);
      } else if (t === 'DIMENSION' && e.subDefinitionPoint1 && e.subDefinitionPoint2 && e.measurement) {
        // the value written is the measured one unless overridden with a plain number
        const o = typeof e.text === 'string' ? e.text.trim() : '', v = /^\d+(?:\.\d+)?$/.test(o) ? +o : e.measurement;
        out.dims!.push({ layer, a: P(e.subDefinitionPoint1.x, e.subDefinitionPoint1.y), b: P(e.subDefinitionPoint2.x, e.subDefinitionPoint2.y), v });
      } else if (t === 'INSERT' && depth < 6 && e.name) {
        const b = blocks.get(e.name);
        if (b && ((b as { flags?: number }).flags ?? 0) & 4 && !(b.entities || []).length) { (out.xrefs ??= []).includes(e.name) || out.xrefs.push(e.name); }
        if (b) {
          out.inserts++;
          const r = e.rotation || 0, c = Math.cos(r), sn = Math.sin(r), sx = e.xScale ?? 1, sy = e.yScale ?? 1, ip = e.insertionPoint || { x: 0, y: 0 }, bp = b.basePoint || { x: 0, y: 0 };
          walk(b.entities || [], mul(mul(m, [c * sx, sn * sx, -sn * sy, c * sy, ip.x, ip.y]), [1, 0, 0, 1, -bp.x, -bp.y]), layer, depth + 1, color);
        }
        if (e.attribs?.length) walk(e.attribs, m, layer, depth);
      }
    }
  };
  // only model space: the layouts' paper space holds title blocks and viewport labels in sheet units (a 0.28 mm
  // sheet title at (6, 5) would otherwise land in the model as a view title)
  const ms = (db.tables?.BLOCK_RECORD?.entries || []).find(b => /^\*Model_Space$/i.test(b.name))?.handle;
  const paper = new Set((db.tables?.BLOCK_RECORD?.entries || []).filter(b => /^\*Paper_Space/i.test(b.name) && b.handle).map(b => b.handle!.toUpperCase()));
  const ents = (db.entities || []).filter(e => { const o = e.ownerBlockRecordSoftId; return !o || (ms && o.toUpperCase() === ms.toUpperCase()) || !paper.has(o.toUpperCase()); });
  walk(ents, [1, 0, 0, 1, 0, 0], null, 0);
  return out;
}
