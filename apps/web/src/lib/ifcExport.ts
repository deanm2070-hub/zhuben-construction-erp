import { isBox, isDoor, memberOf, unpackMesh, type CadData, type ModelObject } from '@cloud-modeler/core';

/**
 * The model as an IFC4 file (STEP text, metres): one IfcBuildingStorey per storey, each part an IfcColumn, IfcBeam,
 * IfcWall, IfcSlab, IfcWindow, IfcDoor … by its member kind, as a rectangle extruded upwards, coloured as in the
 * model. Imported SketchUp geometry goes in as triangulated IfcBuildingElementProxy.
 * Plan axes: model x → IFC X (east), model z (south) → −Y (north up), height → Z.
 */
export function buildIfc(objects: ModelObject[], cad: CadData | null, project: string): string {
  const lines: string[] = [];
  let n = 0;
  const add = (s: string) => { lines.push(`#${++n}=${s};`); return `#${n}`; };
  const m = (cm: number) => num(cm / 100);
  const pt = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const dir = (x: number, y: number, z: number) => add(`IFCDIRECTION((${num(x)},${num(y)},${num(z)}))`);

  const origin = pt(0, 0, 0), zUp = dir(0, 0, 1), xDir = dir(1, 0, 0);
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},${zUp},${xDir})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = add(`IFCUNITASSIGNMENT((${[
    'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)',
    'IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)', 'IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)',
  ].map(add).join(',')}))`);
  const proj = add(`IFCPROJECT('${guid()}',$,${str(project)},$,$,$,$,(${ctx}),${units})`);
  const place0 = () => add(`IFCLOCALPLACEMENT($,${add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)})`);
  const site = add(`IFCSITE('${guid()}',$,'Site',$,$,${place0()},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldg = add(`IFCBUILDING('${guid()}',$,${str(project)},$,$,${place0()},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,${proj},(${site}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,${site},(${bldg}))`);

  // storeys low to high; parts without a storey go on the lowest one
  const floors = [...(cad?.floors || [])].sort((a, b) => a.y - b.y);
  const keys = floors.length ? floors.map(f => f.key) : ['1F'];
  const storey = new Map<string, string>(), members = new Map<string, string[]>();
  for (const k of keys) {
    const f = floors.find(x => x.key === k);
    storey.set(k, add(`IFCBUILDINGSTOREY('${guid()}',$,${str(k)},$,$,${place0()},$,$,.ELEMENT.,${m(f?.y || 0)})`));
    members.set(k, []);
  }
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,${bldg},(${keys.map(k => storey.get(k)).join(',')}))`);
  const home = (floor?: string) => members.get(floor && members.has(floor) ? floor : keys[0])!;

  const styles = new Map<number, string>();
  const style = (color: number, opacity = 1) => {
    const k = color * 10 + Math.round((1 - opacity) * 9);
    if (!styles.has(k)) {
      const c = add(`IFCCOLOURRGB($,${num((color >> 16 & 255) / 255)},${num((color >> 8 & 255) / 255)},${num((color & 255) / 255)})`);
      const sh = add(`IFCSURFACESTYLERENDERING(${c},${num(1 - opacity)},$,$,$,$,$,$,.NOTDEFINED.)`);
      styles.set(k, add(`IFCSURFACESTYLE($,.BOTH.,(${sh}))`));
    }
    return styles.get(k)!;
  };
  /** an upright box: centre of its foot at (x, y, z) in model cm, w along its own x turned by rot, d across */
  const box = (x: number, y: number, z: number, w: number, d: number, h: number, rot: number, color: number, opacity = 1) => {
    const p2 = add(`IFCAXIS2PLACEMENT2D(${add('IFCCARTESIANPOINT((0.,0.))')},$)`);
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2},${m(Math.max(1, w))},${m(Math.max(1, d))})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${prof},${add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)},${zUp},${m(Math.max(1, h))})`);
    add(`IFCSTYLEDITEM(${solid},(${style(color, opacity)}),$)`);
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`);
    const at = add(`IFCAXIS2PLACEMENT3D(${pt(x / 100, -z / 100, y / 100)},${zUp},${dir(Math.cos(rot), Math.sin(rot), 0)})`);
    return { place: add(`IFCLOCALPLACEMENT($,${at})`), shape: add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`) };
  };

  for (const o of objects) {
    const kind = memberOf(o), name = str(o.name || kind);
    if (isDoor(o)) {
      const len = o.b - o.a, h = o.h || 210, mid = (o.a + o.b) / 2;
      const g = o.axis === 'x' ? box(mid, o.y || 0, o.at, len, 12, h, 0, o.color) : box(o.at, o.y || 0, mid, len, 12, h, -Math.PI / 2, o.color);
      home(o.floor).push(add(`IFCDOOR('${guid()}',$,${name},$,$,${g.place},${g.shape},$,${m(h)},${m(len)},.${/捲門/.test(o.name) ? 'GATE' : 'DOOR'}.,$,$)`));
      continue;
    }
    if (!isBox(o)) continue;
    const glass = o.layer === 'glass';
    const g = box(o.x, o.y, o.z, o.w, o.d, o.h, o.rot || 0, o.color ?? 0xd9d9d9, glass ? 0.4 : 1);
    const head = (t: string) => `${t}('${guid()}',$,${name},$,$,${g.place},${g.shape},$`;
    let e: string;
    if (kind === '柱') e = `${head('IFCCOLUMN')},.COLUMN.)`;
    else if (kind === '梁') e = `${head('IFCBEAM')},.BEAM.)`;
    else if (kind === '基礎') e = /梁/.test(o.name) ? `${head('IFCBEAM')},.BEAM.)` : `${head('IFCFOOTING')},.PAD_FOOTING.)`;
    else if (kind === '樓板') e = `${head('IFCSLAB')},.${/屋頂|屋簷/.test(o.name) ? 'ROOF' : /地坪/.test(o.name) ? 'BASESLAB' : 'FLOOR'}.)`;
    else if (kind === '牆') e = `${head('IFCWALL')},.STANDARD.)`;
    else if (kind === '門窗') e = /門/.test(o.name) ? `${head('IFCDOOR')},${m(o.h)},${m(Math.max(o.w, o.d))},.DOOR.,$,$)` : `${head('IFCWINDOW')},${m(o.h)},${m(Math.max(o.w, o.d))},.WINDOW.,$,$)`;
    else if (kind === '樓梯') e = `${head('IFCSTAIR')},.NOTDEFINED.)`;
    else if (kind === '欄杆') e = `${head('IFCRAILING')},.GUARDRAIL.)`;
    else if (kind === '設備') e = `${head('IFCFURNITURE')},.NOTDEFINED.)`;
    else e = `${head('IFCBUILDINGELEMENTPROXY')},.NOTDEFINED.)`;
    home(o.floor).push(add(e));
  }

  for (const cm of cad?.meshes || []) {
    const { pos, idx } = unpackMesh(cm);
    if (idx.length < 3) continue;
    const pts: string[] = [];
    for (let i = 0; i < pos.length; i += 3) pts.push(`(${m(pos[i])},${m(-pos[i + 2])},${m(pos[i + 1])})`);
    const tri: string[] = [];
    for (let i = 0; i + 2 < idx.length; i += 3) tri.push(`(${idx[i] + 1},${idx[i + 1] + 1},${idx[i + 2] + 1})`);
    const set = add(`IFCTRIANGULATEDFACESET(${add(`IFCCARTESIANPOINTLIST3D((${pts.join(',')}))`)},$,$,(${tri.join(',')}),$)`);
    add(`IFCSTYLEDITEM(${set},(${style(cm.color ?? 0xd9d9d9, cm.opacity ?? 1)}),$)`);
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${set}))`);
    home(cm.floor).push(add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,'SketchUp 物件',$,$,${place0()},${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`)},$,.NOTDEFINED.)`));
  }

  for (const k of keys) {
    const list = members.get(k)!;
    if (list.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${list.join(',')}),${storey.get(k)})`);
  }

  const now = new Date().toISOString().slice(0, 19);
  return [
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${str(project + '.ifc')},'${now}',(''),(''),'zhuben','zhuben','');`,
    "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

/** a STEP real: always with a decimal point, never in exponent form for ordinary sizes */
function num(v: number) {
  if (!Number.isFinite(v)) return '0.';
  const s = (Math.round(v * 1e6) / 1e6).toString();
  if (/e/i.test(s)) return v.toExponential(6).replace(/e/i, 'E').replace(/^(-?\d)E/, '$1.E');
  return s.includes('.') ? s : s + '.';
}
/** a STEP string: quotes doubled, anything outside ASCII as \X2\ UTF-16 \X0\ */
function str(s: string) {
  let out = '', wide = '';
  const flush = () => { if (wide) { out += `\\X2\\${wide}\\X0\\`; wide = ''; } };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) { flush(); out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch; }
    else for (const u of ch.split('')) wide += u.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  flush();
  return `'${out}'`;
}
/** IFC GlobalId: 128 random bits in the 22-character IFC base 64 */
const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function guid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = B64[b[0] >> 6];
  let acc = BigInt(0);
  for (const x of b) acc = (acc << BigInt(8)) | BigInt(x);
  for (let i = 20; i >= 0; i--) s += B64[Number((acc >> BigInt(i * 6)) & BigInt(63))];
  return s;
}
