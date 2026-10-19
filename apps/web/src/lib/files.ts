import { REBAR_KINDS, REBAR_STD, rebarSummary, type Takeoff } from '@cloud-modeler/core';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import * as XLSX from 'xlsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders page 1 of a PDF to a canvas about 2400 px on its long side. */
export async function pdfFirstPage(file: File) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(1), v0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(4, 2400 / Math.max(v0.width, v0.height)) });
  const cv = document.createElement('canvas');
  cv.width = vp.width; cv.height = vp.height;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas: cv, pages: doc.numPages };
}

export function loadImage(file: File) {
  return new Promise<HTMLImageElement>((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('圖片讀取失敗'));
    img.src = URL.createObjectURL(file);
  });
}

export function download(name: string, data: BlobPart, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Workbook with the same three views as the takeoff dialog, columns matching the 工程預算書 template. */
export function takeoffWorkbook(t: Takeoff, project: string) {
  const wb = XLSX.utils.book_new();
  const budget: (string | number)[][] = [['工程預算書'], [`工程名稱：${project}`], ['項次', '名稱及規格', '單位', '數量', '單價', '總價', '備註'], ['Item', 'Description', 'Unit', 'Quantity', 'Unit Price', 'Total', 'Remarks']];
  for (const b of t.budget) {
    if (b.sec) { const [no, ...rest] = b.sec.split('、'); budget.push(rest.length ? [`${no}、`, rest.join('、')] : ['', b.sec]); }
    else budget.push([b.i!, b.name!, b.unit!, b.q!, '', '', b.note || '']);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(budget);
  // 總價 = 數量 × 單價, filled once prices are entered
  budget.forEach((row, r) => { if (r >= 4 && typeof row[3] === 'number') ws1[XLSX.utils.encode_cell({ r, c: 5 })] = { t: 'n', v: 0, f: `D${r + 1}*E${r + 1}` }; });
  ws1['!cols'] = [{ wch: 6 }, { wch: 48 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(wb, ws1, '工程預算書');
  const detail: (string | number)[][] = [['工程名稱:  ' + project + '  材料別分層分類統計']];
  for (const g of t.groups) {
    detail.push([], [g.title], ['樓層', '空間名稱', '合計', '單位']);
    for (const r of g.rows) detail.push([r.fl, r.name, r.q, g.unit]);
    detail.push([`以上項目總計 = ${g.total} ${g.unit}`]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(detail);
  ws2['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 10 }, { wch: 6 }];
  XLSX.utils.book_append_sheet(wb, ws2, '裝修細項');
  const calc: (string | number)[][] = [['工程名稱:  ' + project + '  數量計算式'], [], ['工程項目', '樓層', '位置／構件', '計算式', '數量', '單位']];
  for (const k of [...new Set(t.calc.map(c => `${c.item}|${c.unit}`))]) {
    const [item, unit] = k.split('|'), rows = t.calc.filter(c => c.item === item && c.unit === unit);
    for (const c of rows) calc.push([c.item, c.fl, c.where, c.expr, c.q, c.unit]);
    calc.push(['', '', '', `${item} 小計`, Math.round(rows.reduce((s, c) => s + c.q, 0) * 100) / 100, unit], []);
  }
  const ws4 = XLSX.utils.aoa_to_sheet(calc);
  ws4['!cols'] = [{ wch: 36 }, { wch: 6 }, { wch: 30 }, { wch: 70 }, { wch: 10 }, { wch: 6 }];
  XLSX.utils.book_append_sheet(wb, ws4, '數量計算式');
  if (t.rebar?.rows.length) {
    const rows = t.rebar.rows;
    const list: (string | number)[][] = [['工程名稱:  ' + project + '  鋼筋明細'], [], ['樓層', '構件', '編號', '鋼筋位置', '號數', '單支長(m)', '支數', '總長(m)', '單位重(kg/m)', '重量(kg)', '計算式']];
    for (const r of rows) list.push([r.fl, r.kind, r.mark, r.part, `#${r.s}`, r.len / 100, r.n, Math.round(r.len * r.n) / 100, REBAR_STD.kg[r.s], r.kg, r.expr]);
    const ws5 = XLSX.utils.aoa_to_sheet(list);
    ws5['!cols'] = [{ wch: 6 }, { wch: 7 }, { wch: 12 }, { wch: 18 }, { wch: 5 }, { wch: 9 }, { wch: 6 }, { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws5, '鋼筋明細');
    const { byFloor, bySize } = rebarSummary(rows);
    const sum: (string | number)[][] = [['工程名稱:  ' + project + '  鋼筋分層統計（kg）'], [], ['樓層', ...REBAR_KINDS, '合計', '噸']];
    for (const [f, v] of byFloor) sum.push([f, ...REBAR_KINDS.map(k => Math.round(v[k] * 10) / 10), Math.round(v.合計 * 10) / 10, Math.round(v.合計) / 1000]);
    const all = rows.reduce((a, r) => a + r.kg, 0);
    sum.push(['全棟', ...REBAR_KINDS.map(k => Math.round([...byFloor.values()].reduce((a, v) => a + v[k], 0) * 10) / 10), Math.round(all * 10) / 10, Math.round(all) / 1000]);
    sum.push([], ['號數', '材質', '總長(m)', '單位重(kg/m)', '重量(kg)']);
    for (const [z, v] of bySize) sum.push([`#${z}`, z >= 6 ? 'SD420' : 'SD280', Math.round(v.len * 100) / 100, REBAR_STD.kg[z], Math.round(v.kg * 10) / 10]);
    const ws6 = XLSX.utils.aoa_to_sheet(sum);
    ws6['!cols'] = [{ wch: 8 }, ...REBAR_KINDS.map(() => ({ wch: 10 })), { wch: 10 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws6, '鋼筋統計');
  }
  const rooms: (string | number)[][] = [['空間', '面積㎡', '坪', '周長 m', '地坪', '天花', '牆面']];
  for (const r of t.rooms) rooms.push([r.name, Math.round(r.area * 100) / 100, Math.round(r.area / 3.3058 * 100) / 100, Math.round(r.perim * 10) / 10, r.fin.f, r.fin.c, r.fin.w]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rooms), '空間做法');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}
