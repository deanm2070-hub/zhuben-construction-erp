import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

const A4W = 210, A4H = 297, MARGIN = 12;     // mm
const PX = 704;                              // CSS width of the printed area (A4 less margins at 96 dpi)
const PAGE = Math.floor(PX * (A4H - 2 * MARGIN) / (A4W - 2 * MARGIN));

/**
 * The report as a real PDF file, page by page, for phones: the print dialog cannot be opened from the installed
 * iPhone app (and often not from the phone browsers either). Each A4 page is a picture of the same HTML the
 * print view uses, cut between table rows so no row is split, and every report starts on a new page.
 */
export async function reportPdf(html: string, progress: (done: number, total: number) => void): Promise<Blob> {
  const f = document.createElement('iframe');
  f.style.cssText = `position:fixed;left:-${PX + 200}px;top:0;width:${PX}px;height:${PAGE}px;border:0;visibility:hidden`;
  document.body.appendChild(f);
  try {
    const d = f.contentDocument!;
    d.open(); d.write(html); d.close();
    const extra = d.createElement('style');
    extra.textContent = 'body{padding:0!important;width:' + PX + 'px}section+section{margin-top:0!important}';
    d.head.appendChild(extra);
    await d.fonts?.ready;
    await new Promise(r => setTimeout(r, 50));
    const body = d.body, top = body.getBoundingClientRect().top;
    const y = (e: Element) => e.getBoundingClientRect();
    const total = Math.ceil(body.scrollHeight);
    // where a page may end (after a row, heading or paragraph) and where a page must end (before each report)
    const ends = [...body.querySelectorAll('tr,h2,h3,p,.qhead,.sign,table')].map(e => y(e).bottom - top).sort((a, b) => a - b);
    const starts = [...body.querySelectorAll('section')].slice(1).map(e => y(e).top - top);
    const cuts: [number, number][] = [];
    for (let s = 0; s < total - 1;) {
      const lim = s + PAGE;
      const forced = starts.find(v => v > s + 1 && v <= lim);
      let e = forced ?? (lim >= total ? total : Math.max(...ends.filter(v => v > s + PAGE * 0.3 && v <= lim), -1));
      if (e < 0) e = lim;
      cuts.push([s, e]);
      s = forced ?? e;
    }
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const k = (A4W - 2 * MARGIN) / PX;
    for (let i = 0; i < cuts.length; i++) {
      progress(i, cuts.length);
      const [s, e] = cuts[i];
      const c = await html2canvas(body, { x: 0, y: s, width: PX, height: e - s, scale: 2, backgroundColor: '#ffffff', windowWidth: PX, logging: false });
      if (i) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.8), 'JPEG', MARGIN, MARGIN, PX * k, (e - s) * k);
      pdf.setFontSize(8); pdf.setTextColor(120);
      pdf.text(`${i + 1} / ${cuts.length}`, A4W / 2, A4H - 6, { align: 'center' });
      c.width = c.height = 0;
    }
    progress(cuts.length, cuts.length);
    return pdf.output('blob');
  } finally {
    f.remove();
  }
}
