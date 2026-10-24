import type { FormworkReport } from './formwork';
import { isBox, type BoxObject, type ModelObject } from './types';

/** a storey drawn as an SVG, with its labels matching the lines of a report; nos = the numbers given to rooms (mason) */
export interface PlanSheet { fl: string; title: string; svg: string; nos?: Record<string, number> }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const PALETTE = ['#cfe3ff', '#ffe3c2', '#d6f0d2', '#f5d0e6', '#e3dcff', '#fff2b3', '#c9f0f0', '#f3d6c9'];

/** the structure drawn under the labels: columns dark, RC walls grey, beams outlined, light partitions thin */
function base(objects: ModelObject[], fl: string) {
  const out: string[] = [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (a: number, b: number, c: number, d: number) => { x0 = Math.min(x0, a); x1 = Math.max(x1, b); z0 = Math.min(z0, c); z1 = Math.max(z1, d); };
  const boxes = objects.filter(isBox).filter((o): o is BoxObject => o.floor === fl && !o.rot);
  for (const o of boxes) {
    const rc = o.rc?.kind, wall = o.layer === 'wall' && o.y < 150 && o.h >= 100 && !/欄杆|門楣|窗/.test(o.name);
    if (!rc && !wall) continue;
    const rx = o.x - o.w / 2, rz = o.z - o.d / 2;
    grow(rx, rx + o.w, rz, rz + o.d);
    const light = /輕隔間/.test(o.name) || (o.layer === 'wall' && !rc && Math.min(o.w, o.d) < 12);
    const style = rc === 'column' ? 'fill="#333"' : rc === 'beam' ? 'fill="none" stroke="#999" stroke-width="3" stroke-dasharray="14 8"' : light ? 'fill="#c8c8c8"' : 'fill="#6a6a6a"';
    out.push(`<rect x="${r(rx)}" y="${r(rz)}" width="${r(o.w)}" height="${r(o.d)}" ${style}/>`);
  }
  return { out, x0, x1, z0, z1 };
}
const r = (v: number) => Math.round(v * 10) / 10;

function wrap(b: ReturnType<typeof base>, layers: string[], extra: { x0: number; x1: number; z0: number; z1: number }) {
  const x0 = Math.min(b.x0, extra.x0), x1 = Math.max(b.x1, extra.x1), z0 = Math.min(b.z0, extra.z0), z1 = Math.max(b.z1, extra.z1);
  if (!isFinite(x0) || !isFinite(z0)) return '';
  const pad = Math.max(x1 - x0, z1 - z0) * 0.03 + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(x0 - pad)} ${r(z0 - pad)} ${r(x1 - x0 + 2 * pad)} ${r(z1 - z0 + 2 * pad)}" width="100%" style="max-width:900px;background:#fff;border:1px solid #bbb" font-family="sans-serif">${layers.join('')}</svg>`;
}

/** formwork plans: every slab panel shaded with its 版內編 number and 版編號, the numbers of the formwork table */
export function formworkPlans(objects: ModelObject[], fw: FormworkReport): PlanSheet[] {
  const out: PlanSheet[] = [];
  for (const f of fw.floors) {
    if (!f.rows.length) continue;
    const b = base(objects, f.fl);
    const ext = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const p of f.rows) { ext.x0 = Math.min(ext.x0, p.x0); ext.x1 = Math.max(ext.x1, p.x1); ext.z0 = Math.min(ext.z0, p.z0); ext.z1 = Math.max(ext.z1, p.z1); }
    const fs = Math.max(30, Math.min(110, (ext.x1 - ext.x0) / 45));
    const panels = f.rows.map((p, i) => {
      const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, small = Math.min(p.x1 - p.x0, p.z1 - p.z0) < fs * 3;
      const f1 = small ? fs * 0.7 : fs;
      return `<rect x="${r(p.x0)}" y="${r(p.z0)}" width="${r(p.x1 - p.x0)}" height="${r(p.z1 - p.z0)}" fill="${PALETTE[i % PALETTE.length]}" fill-opacity=".75" stroke="#2b6cb0" stroke-width="3"/>`
        + `<text x="${r(cx)}" y="${r(cz)}" font-size="${r(f1)}" font-weight="bold" text-anchor="middle" fill="#7a1c1c">${p.no}</text>`
        + `<text x="${r(cx)}" y="${r(cz + f1 * 1.1)}" font-size="${r(f1 * 0.7)}" text-anchor="middle" fill="#222">${esc(p.mark)}</text>`;
    });
    const svg = wrap(b, [...panels, ...b.out], ext);
    if (svg) out.push({ fl: f.fl, title: f.fl === 'F' ? '基礎層 版平面（紅色數字＝表中的版內編）' : `${f.label}F 版平面（紅色數字＝表中的版內編，下方小字＝版編號）`, svg });
  }
  return out;
}

/** mason plans: every room of a storey shaded, numbered and named like the 位置 column of the mason tables */
export function masonPlans(objects: ModelObject[], runs: { fl: string; name: string; runs: number[][] }[], order: string[]): PlanSheet[] {
  const out: PlanSheet[] = [];
  for (const fl of [...order].reverse()) {
    const mine = runs.filter(x => x.fl === fl && x.runs.length);
    if (!mine.length) continue;
    const b = base(objects, fl), nos: Record<string, number> = {};
    const ext = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    const shapes: string[] = [], labels: string[] = [];
    mine.forEach((room, i) => {
      const plain = room.name.split(`${fl} `).join('');
      nos[plain] = i + 1;
      let sx = 0, sz = 0, n = 0;
      for (const [z, a, c] of room.runs) {
        shapes.push(`<rect x="${r(a)}" y="${r(z)}" width="${r(c - a)}" height="20.6" fill="${PALETTE[i % PALETTE.length]}"/>`);
        ext.x0 = Math.min(ext.x0, a); ext.x1 = Math.max(ext.x1, c); ext.z0 = Math.min(ext.z0, z); ext.z1 = Math.max(ext.z1, z + 20);
        sx += (a + c) / 2 * (c - a); sz += (z + 10) * (c - a); n += c - a;
      }
      if (!n) return;
      const w = room.runs.reduce((m, [, a, c]) => Math.max(m, c - a), 0), fs = Math.max(20, Math.min(isFinite(b.x0) ? (b.x1 - b.x0) / 26 : 70, w / 9));
      const label = plain.length > 8 ? `${plain.slice(0, 8)}…` : plain;
      labels.push(`<text x="${r(sx / n)}" y="${r(sz / n)}" font-size="${r(fs * 1.2)}" font-weight="bold" text-anchor="middle" fill="#7a1c1c" stroke="#fff" stroke-width="${r(fs / 6)}" paint-order="stroke">${i + 1}</text><text x="${r(sx / n)}" y="${r(sz / n + fs * 1.1)}" font-size="${r(fs)}" text-anchor="middle" fill="#222" stroke="#fff" stroke-width="${r(fs / 6)}" paint-order="stroke">${esc(label)}</text>`);
    });
    // the four facades of the exterior-wall items (外牆粉刷、抿石子…), named like their 位置 in the tables
    if (isFinite(b.x0)) {
      const fs = Math.max(30, (b.x1 - b.x0) / 40), cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, g = fs * 0.9;
      const side = (x1: number, z1: number, x2: number, z2: number) => `<line x1="${r(x1)}" y1="${r(z1)}" x2="${r(x2)}" y2="${r(z2)}" stroke="#d9480f" stroke-width="${r(fs / 5)}"/>`;
      labels.push(side(b.x0, b.z0 - g * 0.6, b.x1, b.z0 - g * 0.6), side(b.x0, b.z1 + g * 0.6, b.x1, b.z1 + g * 0.6), side(b.x0 - g * 0.6, b.z0, b.x0 - g * 0.6, b.z1), side(b.x1 + g * 0.6, b.z0, b.x1 + g * 0.6, b.z1));
      const tx = (t: string, x: number, z: number, rot = 0) => `<text x="${r(x)}" y="${r(z)}" font-size="${r(fs)}" font-weight="bold" text-anchor="middle" fill="#d9480f"${rot ? ` transform="rotate(${rot} ${r(x)} ${r(z)})"` : ''}>${t}</text>`;
      labels.push(tx('北向外牆', cx, b.z0 - g * 1.3), tx('南向外牆', cx, b.z1 + g * 2.2), tx('西向外牆', b.x0 - g * 1.4, cz, -90), tx('東向外牆', b.x1 + g * 2.2, cz, 90));
      ext.x0 = Math.min(ext.x0, b.x0 - g * 3); ext.x1 = Math.max(ext.x1, b.x1 + g * 3); ext.z0 = Math.min(ext.z0, b.z0 - g * 3); ext.z1 = Math.max(ext.z1, b.z1 + g * 3);
    }
    const svg = wrap(b, [...shapes, ...b.out, ...labels], ext);
    if (svg) out.push({ fl, title: `${fl} 平面（紅色數字＝泥作表「位置」欄的空間編號；橘色＝外牆項目的東南西北向外牆）`, svg, nos });
  }
  return out;
}

/** member plans: the columns, walls and beams of every formwork row of a storey drawn and labelled 柱1、牆1、梁1 like the table */
export function memberPlans(objects: ModelObject[], groups: { fl: string; kind: string; where: string; boxes: number[][] }[], order: string[]): PlanSheet[] {
  const out: PlanSheet[] = [];
  const COLOR: Record<string, string> = { 柱: '#c92a2a', 牆: '#1c7ed6', 梁: '#2f9e44' };
  for (const fl of [...order].reverse()) {
    const mine = groups.filter(g => g.fl === fl && g.boxes.length);
    if (!mine.length) continue;
    const b = base(objects, fl), nos: Record<string, number> = {}, count: Record<string, number> = {};
    const ext = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const g of mine) for (const [x, z, w, d] of g.boxes) { ext.x0 = Math.min(ext.x0, x); ext.x1 = Math.max(ext.x1, x + w); ext.z0 = Math.min(ext.z0, z); ext.z1 = Math.max(ext.z1, z + d); }
    const fs = Math.max(26, (Math.max(ext.x1, b.x1) - Math.min(ext.x0, b.x0)) / 55);
    const shapes: string[] = [], labels: string[] = [];
    for (const g of mine) {
      const n = (count[g.kind] = (count[g.kind] || 0) + 1), tag = `${g.kind}${n}`, col = COLOR[g.kind] || '#555';
      nos[g.where] = n;
      const biggest = new Set([...g.boxes].sort((a, c) => Math.max(c[2], c[3]) - Math.max(a[2], a[3])).slice(0, 2));
      for (const bx of g.boxes) {
        const [x, z, w, d] = bx;
        shapes.push(`<rect x="${r(x)}" y="${r(z)}" width="${r(w)}" height="${r(d)}" fill="${col}" fill-opacity="${g.kind === '柱' ? 0.9 : 0.55}" stroke="${col}" stroke-width="2"/>`);
        // a long beam or wall is tagged once near its middle, a column beside it
        const tall = d > w, cx = x + w / 2, cz = z + d / 2, big = Math.max(w, d) > fs * 4 && biggest.has(bx);
        labels.push(`<text x="${r(g.kind === '柱' ? x + w + fs * 0.2 : cx)}" y="${r(g.kind === '柱' ? z - fs * 0.15 : cz + (tall ? 0 : -fs * 0.35))}" font-size="${r(g.kind === '柱' ? fs * 0.8 : fs)}" font-weight="bold" fill="${col}" ${big || g.kind === '柱' ? '' : 'display="none"'} ${tall && g.kind !== '柱' ? `text-anchor="start" transform="translate(${r(fs * 0.4)} 0)"` : g.kind === '柱' ? '' : 'text-anchor="middle"'} stroke="#fff" stroke-width="${r(fs / 8)}" paint-order="stroke">${tag}</text>`);
      }
    }
    const svg = wrap(b, [...b.out.filter(s => !s.includes('fill="#333"')), ...shapes, ...labels], ext);
    if (svg) out.push({ fl, title: `${fl} 柱（紅）、牆（藍）、梁（綠）平面（編號＝模板表「位置」欄的柱1、牆1、梁1）`, svg, nos });
  }
  return out;
}
