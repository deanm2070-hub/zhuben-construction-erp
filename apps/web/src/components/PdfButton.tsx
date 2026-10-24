import { useState } from 'react';
import { download, isPhone } from '../lib/files';
import { printReports } from '../lib/report';

/**
 * Computers: the print dialog (print, or 「另存為 PDF」). Phones: the dialog cannot be opened from the installed
 * app, so the report is made into a PDF file first; the file is then saved with a second tap, because the
 * phone only lets a tap that just happened open its share sheet.
 */
export function PdfButton({ html: src, name, className = 'chip', disabled }: { html: string | (() => string); name: string; className?: string; disabled?: boolean }) {
  const html = () => typeof src === 'function' ? src() : src;
  const [state, setState] = useState<{ busy?: string; file?: Blob; err?: string }>({});
  if (!isPhone()) return <button className={className} disabled={disabled} onClick={() => printReports(html())}>PDF／列印</button>;
  const make = async () => {
    setState({ busy: '製作 PDF…' });
    try {
      const { reportPdf } = await import('../lib/pdfReport');
      const file = await reportPdf(html(), (i, n) => setState({ busy: `製作 PDF ${i}/${n} 頁` }));
      setState({ file });
    } catch (e) {
      setState({ err: `PDF 製作失敗：${(e as Error).message || e}` });
    }
  };
  const save = async () => { if (state.file) { await download(`${name}.pdf`, state.file, 'application/pdf'); setState({}); } };
  return <>
    {state.file
      ? <button className={`${className} on`} onClick={save}>✓ PDF 完成，點這裡儲存</button>
      : <button className={className} disabled={disabled || !!state.busy} onClick={make}>{state.busy || '下載 PDF'}</button>}
    {state.err && <span className="err">{state.err}</span>}
  </>;
}
