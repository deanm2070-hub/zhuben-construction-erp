import { groupQuantities, type FormworkReport, PING, REBAR_KINDS, REBAR_STD, rebarSummary, type GroupBy, type PricedBudget, type Pricing, type Takeoff } from '@cloud-modeler/core';
import * as XLSX from 'xlsx';

/** The reports a project can print or download, in the order they appear. */
export const REPORTS = [
  ['quote', '預算報價單', '工項、數量、損耗、材料／工資／機具單價與複價、管理費、利潤、稅金'],
  ['boq', '工程數量表（依工項）', '每個工項的總數量與計算依據'],
  ['floor', '依樓層統計', '各樓層的各工項數量'],
  ['member', '依構件統計', '基礎、柱、梁、樓板、牆、樓梯、門窗、裝修…'],
  ['area', '依施工區域統計', '各樓層各位置（構件、空間、立面）的數量'],
  ['calc', '數量計算式（計算依據）', '每一筆數量的樓層、位置與算式，可逐筆追溯'],
  ['formwork', '模板報表', '每塊版的原始模板、封模、扣版牆接頭、扣柱頭，附計算式與各層小計'],
  ['rebar', '鋼筋料單', '樓層、構件、編號、號數、長度、支數、重量'],
  ['rebarSum', '鋼筋統計', '分層、分構件、分號數重量'],
  ['finish', '裝修細項', '依做法分層分空間的面積與長度'],
  ['rooms', '空間面積與做法', '各空間面積、坪數、地坪／天花／牆面做法'],
] as const;
export type ReportKey = typeof REPORTS[number][0];

export interface ReportCtx { project: string; t: Takeoff; pb: PricedBudget; pricing: Pricing; info?: { client?: string; site?: string } }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const n2 = (v: number) => v.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const n0 = (v: number) => v ? Math.round(v).toLocaleString('zh-TW') : '';
const r2 = (v: number) => Math.round(v * 100) / 100;
export const money = (v: number) => `NT$ ${Math.round(v).toLocaleString('zh-TW')}`;
const GROUP_TITLE: Record<GroupBy, string> = { item: '工項', floor: '樓層', member: '構件', area: '施工區域' };

/** 工程數量表 rows from the item list as the user edited it (deleted items left out, own items added): [sec] or [i, name, unit, q, note] */
function boqRows(pb: PricedBudget): (string | number)[][] {
  return pb.sections.flatMap(s => [[s.sec], ...s.lines.map(l => [l.i, l.name, l.unit, l.tpl && !l.manual && l.q0 == null ? '' : l.q, l.custom ? '自訂工項' : l.note])]);
}
function table(head: string[], rows: string[], cls = '') {
  return `<table class="${cls}"><thead><tr>${head.map(h => `<th${/數量|單價|複價|合計|長|重|支數|%|面積|坪|金額|周長/.test(h) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
const td = (v: unknown, num = false) => `<td${num ? ' class="num"' : ''}>${typeof v === 'number' ? n2(v) : esc(v)}</td>`;

/** 模板報表 as rows of cells in the report's layout: 棟別 樓層 版編號 版內編 | 原始模板 計算式 封模 計算式 扣版牆接頭 計算式 扣柱頭 計算式 扣接頭合計 真實模板 */
export function formworkCells(f: FormworkReport): (string | number)[][] {
  const out: (string | number)[][] = [];
  const z = (v: number) => v.toFixed(2);
  f.floors.forEach((fl, fi) => {
    let prev = '';
    fl.rows.forEach((r, i) => {
      out.push([fi === 0 && i === 0 ? 'A' : '', i === 0 ? fl.label : '', r.mark === prev ? '' : r.mark, r.no, z(r.area), r.areaExpr, z(r.edge), r.edgeExpr, z(r.wall), r.wallExpr, z(r.col), r.colExpr, z(r.cut), z(r.real)]);
      prev = r.mark;
    });
    out.push(['', '', '樓層小計', '', z(fl.area), '', z(fl.edge), '', z(fl.wall), '', z(fl.col), '', z(fl.cut), z(fl.real)]);
  });
  const t = f.total;
  out.push(['合計', '', '', '', z(t.area), '', z(t.edge), '', z(t.wall), '', z(t.col), '', z(t.cut), z(t.real)]);
  return out;
}
const FORMWORK_HEAD = ['棟別', '樓層', '版編號', '版內編', '原始模板', '計算式', '封模', '計算式', '扣版牆接頭', '計算式', '扣柱頭', '計算式', '扣接頭合計', '真實模板'];

function section(key: ReportKey, c: ReportCtx): string {
  const { t, pb, pricing: P } = c;
  if (key === 'quote') {
    const q = P.quote;
    const head = `<div class="qhead">
      <div><b>${esc(q.company || '')}</b></div>
      <table class="meta"><tbody>
        <tr><th>工程名稱</th><td>${esc(c.project)}</td><th>報價日期</th><td>${esc(q.date || new Date().toISOString().slice(0, 10))}</td></tr>
        <tr><th>業主</th><td>${esc(q.client || c.info?.client || '')}</td><th>有效期限</th><td>${esc(q.valid || '')}</td></tr>
        <tr><th>工程地點</th><td>${esc(q.site || c.info?.site || '')}</td><th>聯絡人</th><td>${esc(q.contact || '')}</td></tr>
      </tbody></table></div>`;
    const rows: string[] = [];
    for (const s of pb.sections) {
      rows.push(`<tr class="sec"><td colspan="10">${esc(s.sec)}</td><td class="num">${n0(s.total)}</td><td></td></tr>`);
      for (const l of s.lines) rows.push(`<tr>${td(l.i)}${td(l.name)}${td(l.unit)}${td(l.lump ? '1 式' : l.q, true)}${td(l.waste ? `${l.waste}%` : '', true)}${td(l.qw, true)}<td class="num">${n0(l.mat)}</td><td class="num">${n0(l.lab)}</td><td class="num">${n0(l.eq)}</td><td class="num">${l.up ? n2(l.up) : ""}</td><td class="num">${n0(l.total)}</td>${td(l.note)}</tr>`);
    }
    const sum = `<table class="sum"><tbody>
      <tr><th>材料費</th><td class="num">${money(pb.mat)}</td></tr>
      <tr><th>工資</th><td class="num">${money(pb.lab)}</td></tr>
      <tr><th>機具費</th><td class="num">${money(pb.eq)}</td></tr>
      <tr><th>直接工程費 小計</th><td class="num">${money(pb.direct)}</td></tr>
      <tr><th>管理費 ${P.fees.mgmt}%</th><td class="num">${money(pb.mgmt)}</td></tr>
      <tr><th>利潤 ${P.fees.profit}%</th><td class="num">${money(pb.profit)}</td></tr>
      <tr><th>營業稅 ${P.fees.tax}%</th><td class="num">${money(pb.tax)}</td></tr>
      <tr class="grand"><th>總計（含稅）</th><td class="num">${money(pb.grand)}</td></tr>
    </tbody></table>`;
    const terms = q.terms ? `<p class="terms">${esc(q.terms).replace(/\n/g, '<br>')}</p>` : '';
    return `${head}${table(['項次', '名稱及規格', '單位', '數量', '損耗', '含損數量', '材料單價', '工資單價', '機具單價', '單價', '複價', '備註'], rows, 'quote')}${sum}${terms}<div class="sign"><span>業主簽認：</span><span>報價人：</span></div>`;
  }
  if (key === 'boq') {
    return table(['項次', '名稱及規格', '單位', '數量', '計算依據'], boqRows(c.pb).map(b => b.length === 1
      ? `<tr class="sec"><td colspan="5">${esc(b[0])}</td></tr>`
      : `<tr>${td(b[0])}${td(b[1])}${td(b[2])}${td(b[3], true)}${td(b[4])}</tr>`));
  }
  if (key === 'floor' || key === 'member' || key === 'area') {
    return groupQuantities(t.calc, key).map(g => `<h3>${esc(GROUP_TITLE[key])}：${esc(g.key)}</h3>${table(['工程項目', '數量', '單位', '筆數'], g.rows.map(r => `<tr>${td(r.item)}${td(r.q, true)}${td(r.unit)}${td(r.n, true)}</tr>`))}`).join('');
  }
  if (key === 'calc') {
    const rows: string[] = [];
    for (const k of [...new Set(t.calc.map(x => `${x.item}|${x.unit}`))]) {
      const [item, unit] = k.split('|'), list = t.calc.filter(x => x.item === item && x.unit === unit);
      rows.push(`<tr class="sec"><td colspan="3">${esc(item)}</td><td class="num">${n2(r2(list.reduce((a, x) => a + x.q, 0)))}</td><td>${esc(unit)}</td></tr>`);
      for (const x of list) rows.push(`<tr>${td(x.fl)}${td(x.where)}<td class="expr">${esc(x.expr)}</td>${td(x.q, true)}${td(x.unit)}</tr>`);
    }
    return table(['樓層', '位置／構件', '計算式', '數量', '單位'], rows);
  }
  if (key === 'rebar') {
    const rb = t.rebar?.rows || [];
    if (!rb.length) return '<p class="muted">沒有鋼筋料單（模型沒有混凝土構件）。</p>';
    return table(['樓層', '構件', '編號', '位置', '號數', '單支長 m', '支數', '總長 m', '重量 kg'], rb.map(r => `<tr>${td(r.fl)}${td(r.kind)}${td(r.mark)}${td(r.part)}${td(`#${r.s}`)}${td(r.len / 100, true)}${td(r.n, true)}${td(r2(r.len * r.n / 100), true)}${td(r.kg, true)}</tr>`));
  }
  if (key === 'formwork') {
    const f = t.formwork;
    if (!f) return '<p class="muted">沒有模板報表（模型沒有樓板範圍）。</p>';
    const rows = formworkCells(f).map(r => {
      const sub = r[2] === '樓層小計' || r[0] === '合計';
      return `<tr${sub ? ' class="sec"' : ''}>${r.map((v, i) => `<td${i >= 4 && ![5, 7, 9, 11].includes(i) ? ' class="num"' : ''}>${esc(v)}</td>`).join('')}</tr>`;
    });
    return `<table><thead><tr><th rowspan="2">棟別</th><th rowspan="2">樓層</th><th rowspan="2">版編號</th><th rowspan="2">版內編</th><th colspan="10">版　明　細</th></tr><tr>${FORMWORK_HEAD.slice(4).map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table><p class="muted">${esc(f.note.join(' '))}</p>`;
  }
  if (key === 'rebarSum') {
    const rb = t.rebar?.rows || [];
    if (!rb.length) return '<p class="muted">沒有鋼筋料單。</p>';
    const { byFloor, bySize } = rebarSummary(rb);
    return table(['樓層', ...REBAR_KINDS.map(k => `${k} kg`), '合計 kg'], [...byFloor].map(([f, v]) => `<tr>${td(f)}${REBAR_KINDS.map(k => td(r2(v[k]), true)).join('')}${td(r2(v.合計), true)}</tr>`))
      + table(['號數', '總長 m', '單位重 kg/m', '重量 kg'], bySize.map(([z, v]) => `<tr>${td(`#${z}`)}${td(r2(v.len), true)}${td(REBAR_STD.kg[z], true)}${td(r2(v.kg), true)}</tr>`));
  }
  if (key === 'finish') {
    return t.groups.map(g => `<h3>${esc(g.title)}</h3>${table(['樓層', '空間', '數量', '單位'], [...g.rows.map(r => `<tr>${td(r.fl)}${td(r.name)}${td(r.q, true)}${td(g.unit)}</tr>`), `<tr class="sec"><td colspan="2">合計</td>${td(g.total, true)}${td(g.unit)}</tr>`])}`).join('');
  }
  return table(['空間', '面積 ㎡', '坪', '地坪', '天花', '牆面'], t.rooms.map(r => `<tr>${td(r.name)}${td(r2(r.area), true)}${td(r2(r.area / PING), true)}${td(r.fin.f)}${td(r.fin.c)}${td(r.fin.w)}</tr>`));
}

/** A printable HTML document of the chosen reports (one page break between them). */
export function reportHtml(keys: ReportKey[], c: ReportCtx) {
  const body = keys.map(k => `<section><h2>${esc(REPORTS.find(r => r[0] === k)![1])}</h2><p class="muted">${esc(c.project)}｜${new Date().toLocaleDateString('zh-TW')}</p>${section(k, c)}</section>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(c.project)} 報表</title><style>
  @page{size:A4;margin:12mm}
  body{font:12px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;color:#1c2433;margin:0;padding:12px;background:#fff}
  section+section{break-before:page;margin-top:28px}
  h2{font-size:18px;margin:0 0 2px}h3{font-size:13px;margin:14px 0 4px}
  .muted{color:#667085;margin:0 0 8px}
  table{border-collapse:collapse;width:100%;margin:4px 0 10px;font-variant-numeric:tabular-nums}
  th,td{border:1px solid #c9d0da;padding:3px 6px;text-align:left;vertical-align:top}
  th{background:#eef1f5;font-weight:700;white-space:nowrap}
  .num{text-align:right;white-space:nowrap}.expr{font-size:11px;color:#475467}
  tr.sec td{background:#f6f8fb;font-weight:700}
  thead{display:table-header-group}tr{break-inside:avoid}
  .qhead{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}.qhead b{font-size:15px}
  table.meta th{width:70px}
  table.sum{width:auto;margin-left:auto;min-width:300px}table.sum th{text-align:right}
  table.sum tr.grand th,table.sum tr.grand td{font-size:14px;background:#e6f4f1}
  .terms{white-space:normal;line-height:1.7}
  .sign{display:flex;justify-content:space-between;margin-top:40px;font-weight:700}.sign span{width:45%;border-top:1px solid #1c2433;padding-top:6px}
  </style></head><body>${body}</body></html>`;
}

/** Prints the reports through a hidden frame: the print dialog can save them as PDF. */
export function printReports(html: string) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const d = f.contentDocument!;
  d.open(); d.write(html); d.close();
  setTimeout(() => {
    f.contentWindow!.focus();
    f.contentWindow!.print();
    setTimeout(() => f.remove(), 60000);
  }, 300);
}

type Cell = string | number | { f: string; v?: number; z?: string };
function sheet(rows: Cell[][], cols: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(v => typeof v === 'object' ? null : v)));
  rows.forEach((r, ri) => r.forEach((v, ci) => {
    if (typeof v === 'object' && v) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 'n', v: v.v ?? 0, f: v.f, ...(v.z ? { z: v.z } : {}) };
  }));
  ws['!cols'] = cols.map(wch => ({ wch }));
  return ws;
}

/** Workbook of the chosen reports; the quotation keeps its formulas so prices can still be changed in Excel. */
export function reportWorkbook(keys: ReportKey[], c: ReportCtx) {
  const wb = XLSX.utils.book_new();
  const { t, pb, pricing: P } = c;
  for (const k of keys) {
    const title = REPORTS.find(r => r[0] === k)![1].replace(/[（(].*$/, '');
    let ws: XLSX.WorkSheet;
    if (k === 'quote') {
      const q = P.quote;
      const rows: Cell[][] = [[q.company || ''], ['預算報價單'], [`工程名稱：${c.project}`, '', '', '', '', '', '', '', `報價日期：${q.date || new Date().toISOString().slice(0, 10)}`],
        [`業主：${q.client || c.info?.client || ''}`, '', '', '', '', '', '', '', `有效期限：${q.valid || ''}`], [`工程地點：${q.site || c.info?.site || ''}`, '', '', '', '', '', '', '', `聯絡人：${q.contact || ''}`], [],
        ['項次', '名稱及規格', '單位', '數量', '損耗%', '含損數量', '材料單價', '材料複價', '工資單價', '工資複價', '機具單價', '機具複價', '複價', '備註']];
      const subtotalRows: number[] = [];
      for (const s of pb.sections) {
        const head = rows.length, first = head + 2;
        rows.push([s.sec]);
        for (const l of s.lines) {
          const r = rows.length + 1;
          rows.push([l.i, l.name, l.unit, l.q, l.waste, { f: `D${r}*(1+E${r}/100)`, v: l.qw }, l.mat, { f: `ROUND(F${r}*G${r},0)`, v: l.matT }, l.lab, { f: `ROUND(F${r}*I${r},0)`, v: l.labT }, l.eq, { f: `ROUND(F${r}*K${r},0)`, v: l.eqT }, { f: `H${r}+J${r}+L${r}`, v: l.total }, l.note]);
        }
        const last = rows.length;
        rows[head] = [s.sec, '', '', '', '', '', '', { f: `SUM(H${first}:H${last})`, v: s.mat }, '', { f: `SUM(J${first}:J${last})`, v: s.lab }, '', { f: `SUM(L${first}:L${last})`, v: s.eq }, { f: `SUM(M${first}:M${last})`, v: s.total }, '小計'];
        subtotalRows.push(head + 1);
      }
      rows.push([]);
      const sumOf = (col: string) => subtotalRows.map(r => `${col}${r}`).join('+') || '0';
      const at = rows.length + 1;
      rows.push(['', '材料費', '', '', '', '', '', '', '', '', '', '', { f: sumOf('H'), v: pb.mat }]);
      rows.push(['', '工資', '', '', '', '', '', '', '', '', '', '', { f: sumOf('J'), v: pb.lab }]);
      rows.push(['', '機具費', '', '', '', '', '', '', '', '', '', '', { f: sumOf('L'), v: pb.eq }]);
      rows.push(['', '直接工程費 小計', '', '', '', '', '', '', '', '', '', '', { f: `M${at}+M${at + 1}+M${at + 2}`, v: pb.direct }]);
      rows.push(['', '管理費', '', '', P.fees.mgmt, '%', '', '', '', '', '', '', { f: `ROUND(M${at + 3}*E${at + 4}/100,0)`, v: pb.mgmt }]);
      rows.push(['', '利潤', '', '', P.fees.profit, '%', '', '', '', '', '', '', { f: `ROUND(M${at + 3}*E${at + 5}/100,0)`, v: pb.profit }]);
      rows.push(['', '營業稅', '', '', P.fees.tax, '%', '', '', '', '', '', '', { f: `ROUND((M${at + 3}+M${at + 4}+M${at + 5})*E${at + 6}/100,0)`, v: pb.tax }]);
      rows.push(['', '總計（含稅）', '', '', '', '', '', '', '', '', '', '', { f: `M${at + 3}+M${at + 4}+M${at + 5}+M${at + 6}`, v: pb.grand }]);
      if (q.terms) rows.push([], ['附註', q.terms]);
      ws = sheet(rows, [6, 40, 6, 10, 7, 10, 10, 12, 10, 12, 10, 12, 14, 30]);
    } else if (k === 'boq') {
      ws = sheet([[`${c.project}  工程數量表`], [], ['項次', '名稱及規格', '單位', '數量', '計算依據'], ...boqRows(c.pb)], [6, 48, 6, 12, 36]);
    } else if (k === 'floor' || k === 'member' || k === 'area') {
      const rows: Cell[][] = [[`${c.project}  ${title}`], [], [GROUP_TITLE[k], '工程項目', '數量', '單位', '筆數']];
      for (const g of groupQuantities(t.calc, k)) for (const r of g.rows) rows.push([g.key, r.item, r.q, r.unit, r.n]);
      ws = sheet(rows, [24, 40, 12, 6, 6]);
    } else if (k === 'calc') {
      const rows: Cell[][] = [[`${c.project}  數量計算式`], [], ['工程項目', '樓層', '位置／構件', '計算式', '數量', '單位']];
      for (const key of [...new Set(t.calc.map(x => `${x.item}|${x.unit}`))]) {
        const [item, unit] = key.split('|'), list = t.calc.filter(x => x.item === item && x.unit === unit);
        for (const x of list) rows.push([x.item, x.fl, x.where, x.expr, x.q, x.unit]);
        rows.push(['', '', '', `${item} 小計`, r2(list.reduce((a, x) => a + x.q, 0)), unit], []);
      }
      ws = sheet(rows, [36, 6, 30, 70, 10, 6]);
    } else if (k === 'rebar') {
      const rows: Cell[][] = [[`${c.project}  鋼筋料單`], [], ['樓層', '構件', '編號', '鋼筋位置', '號數', '單支長(m)', '支數', '總長(m)', '單位重(kg/m)', '重量(kg)', '計算式']];
      for (const r of t.rebar?.rows || []) rows.push([r.fl, r.kind, r.mark, r.part, `#${r.s}`, r.len / 100, r.n, Math.round(r.len * r.n) / 100, REBAR_STD.kg[r.s], r.kg, r.expr]);
      ws = sheet(rows, [6, 7, 12, 18, 5, 9, 6, 9, 9, 10, 90]);
    } else if (k === 'formwork') {
      const f = t.formwork!;
      const rows: Cell[][] = [[`${c.project}  模板報表`], [], ['棟別', '樓層', '版編號', '版內編', '版　明　細'], FORMWORK_HEAD, ...formworkCells(f).map(r => r.map((v, i) => i >= 4 && ![5, 7, 9, 11].includes(i) && v !== '' ? +v : v)), [], [f.note.join(' ')]];
      ws = sheet(rows, [6, 6, 9, 7, 10, 28, 8, 34, 11, 30, 9, 26, 11, 10]);
      ws['!merges'] = [{ s: { r: 2, c: 4 }, e: { r: 2, c: 13 } }];
    } else if (k === 'rebarSum') {
      const rb = t.rebar?.rows || [], { byFloor, bySize } = rebarSummary(rb);
      const rows: Cell[][] = [[`${c.project}  鋼筋統計（kg）`], [], ['樓層', ...REBAR_KINDS, '合計', '噸']];
      for (const [f, v] of byFloor) rows.push([f, ...REBAR_KINDS.map(x => Math.round(v[x] * 10) / 10), Math.round(v.合計 * 10) / 10, Math.round(v.合計) / 1000]);
      rows.push([], ['號數', '材質', '總長(m)', '單位重(kg/m)', '重量(kg)']);
      for (const [z, v] of bySize) rows.push([`#${z}`, z >= 6 ? 'SD420' : 'SD280', r2(v.len), REBAR_STD.kg[z], Math.round(v.kg * 10) / 10]);
      ws = sheet(rows, [8, ...REBAR_KINDS.map(() => 10), 10, 8]);
    } else if (k === 'finish') {
      const rows: Cell[][] = [[`${c.project}  材料別分層分類統計`]];
      for (const g of t.groups) { rows.push([], [g.title], ['樓層', '空間名稱', '合計', '單位']); for (const r of g.rows) rows.push([r.fl, r.name, r.q, g.unit]); rows.push([`以上項目總計 = ${g.total} ${g.unit}`]); }
      ws = sheet(rows, [8, 28, 10, 6]);
    } else {
      ws = sheet([['空間', '面積㎡', '坪', '周長 m', '地坪', '天花', '牆面'], ...t.rooms.map(r => [r.name, r2(r.area), r2(r.area / PING), Math.round(r.perim * 10) / 10, r.fin.f, r.fin.c, r.fin.w])], [20, 10, 8, 8, 8, 8, 8]);
    }
    XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}
