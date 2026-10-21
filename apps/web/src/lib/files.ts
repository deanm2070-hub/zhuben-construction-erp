import type { ProjectModel } from '@cloud-modeler/core';
import { REBAR_KINDS, REBAR_STD, rebarSummary, type Takeoff } from '@cloud-modeler/core';
import * as XLSX from 'xlsx';

type SavePicker = (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ name: string; createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
export const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

/** a notice at the bottom of the screen saying where the file went */
function saved(html: string) {
  document.querySelector('.saveNote')?.remove();
  const d = document.createElement('div');
  d.className = 'saveNote';
  d.setAttribute('role', 'status');
  d.innerHTML = `<span>${html}</span><button type="button" aria-label="關閉">✕</button>`;
  d.querySelector('button')!.onclick = () => d.remove();
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 12000);
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Saves a file and tells where it went. Computers with a save dialog (Chrome, Edge, the installed app) ask
 * where to save; phones open the share sheet (「儲存到檔案」 on iPhone, a folder or app on Android); otherwise
 * the browser downloads it to its download folder. data may be a function that makes the file, so the save
 * dialog opens right away (while the tap still counts) and the file is made after a place is chosen.
 */
export async function download(name: string, data: BlobPart | (() => Promise<BlobPart>), type: string): Promise<boolean> {
  const make = async () => new Blob([typeof data === 'function' ? await data() : data], { type });
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker && !isPhone()) {
    try {
      const h = await picker({ suggestedName: name, types: ext ? [{ description: `${ext.slice(1).toUpperCase()} 檔`, accept: { [type || 'application/octet-stream']: [ext] } }] : undefined });
      const w = await h.createWritable();
      await w.write(await make());
      await w.close();
      saved(`✓ 已存成 <b>${esc(h.name)}</b>，在你剛才選的資料夾`);
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;  // closed the dialog: nothing saved
      // no permission or no user gesture any more: fall through to a plain download
    }
  }
  const blob = await make();
  if (isPhone() && navigator.canShare) {
    const file = new File([blob], name, { type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        saved(isIOS() ? `✓ 已送出 <b>${esc(name)}</b>：選「儲存到檔案」的，可在「檔案」App 你選的資料夾找到` : `✓ 已送出 <b>${esc(name)}</b> 到你選的位置`);
        return true;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return false;
      }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  saved(isIOS() ? `✓ 已下載 <b>${esc(name)}</b>：在「檔案」App →「下載項目」`
    : /Android/i.test(navigator.userAgent) ? `✓ 已下載 <b>${esc(name)}</b>：在「檔案」→「下載」(Download) 資料夾`
    : `✓ 已下載 <b>${esc(name)}</b>：在瀏覽器的「下載」資料夾（按 Ctrl+J／⌘⇧J 可打開下載清單）`);
  return true;
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

/** Project file: the whole model with its name, as JSON. */
export const PROJECT_EXT = '.zhuben.json';
export function projectFile(name: string, model: unknown): string {
  return JSON.stringify({ format: 'zhuben-project', version: 1, name, savedAt: new Date().toISOString(), model });
}
export async function readProjectFile(f: File): Promise<{ name: string; model: ProjectModel }> {
  let j: { format?: string; name?: string; model?: ProjectModel };
  try { j = JSON.parse(await f.text()); } catch { throw new Error('這不是築本算圖的專案檔'); }
  // files saved before the rename are still read
  if ((j.format !== 'zhuben-project' && j.format !== 'zhuliang-project') || !j.model || !Array.isArray(j.model.objects)) throw new Error('這不是築本算圖的專案檔');
  return { name: j.name || f.name.replace(/\.(zhuben|zhuliang)\.json$|\.json$/i, ''), model: j.model };
}
