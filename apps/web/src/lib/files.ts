import type { Takeoff } from '@cloud-modeler/core';
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
  const rooms: (string | number)[][] = [['空間', '面積㎡', '坪', '周長 m', '地坪', '天花', '牆面']];
  for (const r of t.rooms) rooms.push([r.name, Math.round(r.area * 100) / 100, Math.round(r.area / 3.3058 * 100) / 100, Math.round(r.perim * 10) / 10, r.fin.f, r.fin.c, r.fin.w]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rooms), '空間做法');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}
