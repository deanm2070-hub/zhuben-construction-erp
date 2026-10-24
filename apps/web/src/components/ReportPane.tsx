import { useMemo, useState } from 'react';
import { download } from '../lib/files';
import { PdfButton } from './PdfButton';
import { REPORTS, reportHtml, reportWorkbook, type ReportCtx, type ReportKey } from '../lib/report';

const PRESETS: [string, ReportKey[]][] = [
  ['報價給業主', ['quote']],
  ['完整工程數量', ['boq', 'floor', 'member', 'calc']],
  ['鋼筋料單', ['rebar', 'rebarSum']],
  ['模板報表', ['formwork']],
  ['泥作報表', ['mason']],
  ['全部', REPORTS.map(r => r[0])],
];

export function ReportPane({ ctx, toast }: { ctx: ReportCtx; toast: (s: string) => void }) {
  const hasRebar = !!ctx.t.rebar?.rows.length;
  const avail = REPORTS.filter(r => (hasRebar || (r[0] !== 'rebar' && r[0] !== 'rebarSum')) && (ctx.t.formwork || r[0] !== 'formwork'));
  const [sel, setSel] = useState<Set<ReportKey>>(new Set(['quote', 'boq', 'calc']));
  const keys = avail.map(r => r[0]).filter(k => sel.has(k));
  const html = useMemo(() => keys.length ? reportHtml(keys, ctx) : '', [keys.join(), ctx]);
  const toggle = (k: ReportKey) => { const n = new Set(sel); if (n.has(k)) n.delete(k); else n.add(k); setSel(n); };
  return (
    <div className="pane">
      <div className="paneHead">
        <div><h2>報表匯出</h2><p className="note">勾選要輸出的報表：Excel 每份報表一個工作表（報價單保留公式）；PDF 在電腦用列印視窗「另存為 PDF」或直接列印，在手機直接做成 PDF 檔儲存或分享。</p></div>
        <div className="kv">
          <button className="chip on" disabled={!keys.length} onClick={() => { download(`${ctx.project}-報表.xlsx`, reportWorkbook(keys, ctx), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); toast(`已下載 Excel（${keys.length} 個工作表）`); }}>下載 Excel</button>
          <PdfButton className="chip key" disabled={!keys.length} html={html} name={`${ctx.project}-報表`} />
        </div>
      </div>
      <div className="kv"><span className="lbl">快速選擇</span>{PRESETS.map(([l, ks]) => <button key={l} className="chip" onClick={() => setSel(new Set(ks))}>{l}</button>)}</div>
      <div className="reportSel">
        {avail.map(([k, l, d]) => <label key={k} className={`pick ${sel.has(k) ? 'on' : ''}`}>
          <input type="checkbox" checked={sel.has(k)} onChange={() => toggle(k)} />
          <span><b>{l}</b><small>{d}</small></span>
        </label>)}
      </div>
      <h3 className="lbl">預覽</h3>
      {keys.length ? <iframe className="preview" title="報表預覽" srcDoc={html} /> : <p className="note">請至少勾選一份報表。</p>}
    </div>
  );
}
