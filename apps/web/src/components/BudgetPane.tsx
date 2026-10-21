import { carryRates, SEC, type PricedBudget, type PriceRate, type Pricing, type Takeoff } from '@cloud-modeler/core';
import { useEffect, useState } from 'react';
import { download } from '../lib/files';
import { money, printReports, reportHtml, reportWorkbook } from '../lib/report';
import { store, type ProjectMeta } from '../lib/store';

const f2 = (v: number) => v.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const f0 = (v: number) => v ? Math.round(v).toLocaleString('zh-TW') : '–';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A number box that lets the field be cleared while typing and commits numbers only. */
function Num({ id, value, onChange, disabled, w = 76, cls = '' }: { id: string; value?: number; onChange: (v: number | undefined) => void; disabled?: boolean; w?: number; cls?: string }) {
  const [s, setS] = useState(value ? String(value) : '');
  useEffect(() => { setS(value ? String(value) : ''); }, [value]);
  return <input id={id} className={`numin ${cls}`} type="number" inputMode="decimal" min={0} step="any" style={{ width: w }} value={s} disabled={disabled} placeholder="0"
    onChange={e => { setS(e.target.value); const v = parseFloat(e.target.value); onChange(Number.isFinite(v) && v > 0 ? v : undefined); }} />;
}

export function BudgetPane({ t, pb, pricing: P, project, projectId, readOnly, onPricing, toast }: {
  t: Takeoff; pb: PricedBudget; pricing: Pricing; project: string; projectId: string; readOnly: boolean;
  onPricing: (p: Pricing) => void; toast: (s: string) => void;
}) {
  const [fold, setFold] = useState<Set<string>>(new Set());
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [others, setOthers] = useState<ProjectMeta[] | null>(null);
  const setRate = (key: string, patch: Partial<PriceRate>) => {
    if (key.startsWith('custom|')) {
      const id = key.slice(7);
      onPricing({ ...P, custom: P.custom.map(c => c.id === id ? { ...c, ...patch } : c) });
    } else onPricing({ ...P, rates: { ...P.rates, [key]: { ...(P.rates[key] || {}), ...patch } } });
  };
  const sectionWaste = (sec: string, waste: number) => {
    const s = pb.sections.find(x => x.sec === sec);
    if (!s) return;
    const rates = { ...P.rates };
    for (const l of s.lines) if (!l.custom) rates[l.key] = { ...(rates[l.key] || {}), waste };
    onPricing({ ...P, rates, custom: P.custom.map(c => c.sec === sec ? { ...c, waste } : c) });
  };
  const addCustom = (sec: string) => onPricing({ ...P, custom: [...P.custom, { id: Math.random().toString(36).slice(2, 10), sec, name: '新工項', unit: '式', q: 1 }] });
  const carry = async (id: string) => {
    try {
      const p = await store.load(id);
      if (!p.model.pricing) { toast('那個專案還沒有填單價'); return; }
      const r = carryRates({ ...p.model.pricing, rates: p.model.pricing.rates || {} } as Pricing, t.budget);
      const n = Object.keys(r).length;
      onPricing({ ...P, rates: { ...P.rates, ...r } });
      toast(n ? `已從「${p.name}」帶入 ${n} 項單價（同名稱、同單位的工項）` : '沒有相同名稱的工項可以帶入');
    } catch (e) { toast(`讀取失敗：${(e as Error).message}`); }
  };
  const ctx = { project, t, pb, pricing: P };
  const pct = pb.count ? Math.round(pb.priced / pb.count * 100) : 0;
  const q = P.quote;
  const setQuote = (k: keyof typeof q, v: string) => onPricing({ ...P, quote: { ...q, [k]: v } });

  return (
    <div className="pane">
      <div className="paneHead">
        <div><h2>預算報價</h2><p className="note">數量由模型自動帶入；填入材料、工資、機具單價後自動計算複價、管理費、利潤與稅金。單價只要填一次，可帶到其他專案。</p></div>
        <div className="kv">
          <button className="chip" onClick={() => { download(`${project}-預算報價單.xlsx`, reportWorkbook(['quote', 'boq', 'calc'], ctx), XLSX_TYPE); toast('已下載 Excel：報價單保留公式，可在 Excel 改單價'); }}>Excel</button>
          <button className="chip" onClick={() => printReports(reportHtml(['quote'], ctx))}>PDF／列印</button>
        </div>
      </div>

      <div className="sumCard">
        <div className="prog">
          <span className="lbl">填價進度</span>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
          <span><b>{pb.priced}</b> / {pb.count} 項已填單價</span>
        </div>
        <div className="totals">
          <div><span>材料</span><b className="c-mat">{money(pb.mat)}</b></div>
          <div><span>工資</span><b className="c-lab">{money(pb.lab)}</b></div>
          <div><span>機具</span><b className="c-eq">{money(pb.eq)}</b></div>
          <div><span>直接工程費</span><b>{money(pb.direct)}</b></div>
        </div>
        <div className="fees">
          <label>管理費 <Num id="fee-mgmt" value={P.fees.mgmt} w={56} disabled={readOnly} onChange={v => onPricing({ ...P, fees: { ...P.fees, mgmt: v || 0 } })} /> % <small>{money(pb.mgmt)}</small></label>
          <label>利潤 <Num id="fee-profit" value={P.fees.profit} w={56} disabled={readOnly} onChange={v => onPricing({ ...P, fees: { ...P.fees, profit: v || 0 } })} /> % <small>{money(pb.profit)}</small></label>
          <label>營業稅 <Num id="fee-tax" value={P.fees.tax} w={56} disabled={readOnly} onChange={v => onPricing({ ...P, fees: { ...P.fees, tax: v || 0 } })} /> % <small>{money(pb.tax)}</small></label>
          <div className="grand">總計（含稅）<b>{money(pb.grand)}</b></div>
        </div>
      </div>

      <div className="kv">
        <button className={`chip ${showQuote ? 'on' : ''}`} onClick={() => setShowQuote(!showQuote)}>報價單抬頭資訊</button>
        {!readOnly && <>
          {others === null
            ? <button className="chip" onClick={() => store.list().then(l => setOthers(l.filter(p => p.id !== projectId))).catch(() => setOthers([]))}>從其他專案帶入單價</button>
            : <select id="carry-from" defaultValue="" onChange={e => e.target.value && carry(e.target.value)}>
              <option value="">選擇要帶入單價的專案…</option>
              {others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>}
          <button className="chip" onClick={() => addCustom(SEC.other)}>＋ 自訂工項</button>
        </>}
        <label className="note"><input type="checkbox" checked={onlyEmpty} onChange={e => setOnlyEmpty(e.target.checked)} /> 只看還沒填單價的</label>
        {readOnly && <span className="badge">唯讀</span>}
      </div>

      {showQuote && <div className="formGrid">
        {([['company', '報價公司'], ['client', '業主'], ['site', '工程地點'], ['date', '報價日期'], ['valid', '有效期限'], ['contact', '聯絡人／電話']] as const).map(([k, l]) =>
          <label key={k}>{l}<input id={`quote-${k}`} type="text" value={q[k] || ''} disabled={readOnly} placeholder={k === 'date' ? new Date().toISOString().slice(0, 10) : ''} onChange={e => setQuote(k, e.target.value)} /></label>)}
        <label className="wide">附註／付款條件<textarea id="quote-terms" rows={3} value={q.terms || ''} disabled={readOnly} onChange={e => setQuote('terms', e.target.value)} /></label>
      </div>}

      <div className="tbl boq"><table>
        <thead><tr>
          <th></th><th>項次</th><th>名稱及規格</th><th className="num">數量</th><th className="num">損耗%</th><th className="num">含損數量</th><th>單位</th>
          <th className="h-mat num">材料單價</th><th className="num">材料複價</th><th className="h-lab num">工資單價</th><th className="num">工資複價</th><th className="h-eq num">機具單價</th><th className="num">機具複價</th><th className="h-tot num">複價</th><th>備註</th>
        </tr></thead>
        <tbody>{pb.sections.map(s => {
          const open = !fold.has(s.sec), lines = onlyEmpty ? s.lines.filter(l => !l.up) : s.lines;
          return [
            <tr className="secRow" key={s.sec}>
              <td><button className="fold" aria-expanded={open} onClick={() => { const n = new Set(fold); if (open) n.add(s.sec); else n.delete(s.sec); setFold(n); }}>{open ? '▾' : '▸'}</button></td>
              <td colSpan={3}><b>{s.sec}</b> <small className="note">（{s.lines.length} 項）</small></td>
              <td colSpan={3}>{!readOnly && <span className="note">全段損耗 <Num id={`waste-${s.sec}`} w={50} onChange={v => sectionWaste(s.sec, v || 0)} /> %</span>}</td>
              <td colSpan={2} className="num c-mat">{f0(s.mat)}</td><td colSpan={2} className="num c-lab">{f0(s.lab)}</td><td colSpan={2} className="num c-eq">{f0(s.eq)}</td>
              <td className="num"><b>{f0(s.total)}</b></td>
              <td>{!readOnly && <button className="chip ghost sm" onClick={() => addCustom(s.sec)}>＋ 工項</button>}</td>
            </tr>,
            ...(open ? lines.map(l => {
              const c = l.custom;
              return <tr key={l.key} className={l.up ? '' : 'unpriced'}>
                <td className="st">{l.up ? '✓' : '○'}</td>
                <td className="num">{l.i}</td>
                <td className="desc">{c && !readOnly
                  ? <input id={`cn-${c.id}`} type="text" value={c.name} onChange={e => setRate(l.key, { name: e.target.value } as Partial<PriceRate>)} />
                  : l.name}</td>
                <td className="num">{c && !readOnly ? <Num id={`cq-${c.id}`} value={c.q} w={70} onChange={v => setRate(l.key, { q: v || 0 } as Partial<PriceRate>)} /> : l.lump ? '1 式' : f2(l.q)}</td>
                <td className="num"><Num id={`w-${l.key}`} value={l.waste} w={50} disabled={readOnly} onChange={v => setRate(l.key, { waste: v })} /></td>
                <td className="num qw">{f2(l.qw)}</td>
                <td>{c && !readOnly ? <input id={`cu-${c.id}`} type="text" value={c.unit} style={{ width: 44 }} onChange={e => setRate(l.key, { unit: e.target.value } as Partial<PriceRate>)} /> : l.unit}</td>
                <td className="num"><Num id={`m-${l.key}`} cls="in-mat" value={l.mat} disabled={readOnly} onChange={v => setRate(l.key, { mat: v })} /></td>
                <td className="num">{f0(l.matT)}</td>
                <td className="num"><Num id={`l-${l.key}`} cls="in-lab" value={l.lab} disabled={readOnly} onChange={v => setRate(l.key, { lab: v })} /></td>
                <td className="num">{f0(l.labT)}</td>
                <td className="num"><Num id={`e-${l.key}`} cls="in-eq" value={l.eq} disabled={readOnly} onChange={v => setRate(l.key, { eq: v })} /></td>
                <td className="num">{f0(l.eqT)}</td>
                <td className="num tot">{f0(l.total)}</td>
                <td className="note">{c && !readOnly ? <button className="chip ghost danger sm" onClick={() => onPricing({ ...P, custom: P.custom.filter(x => x.id !== c.id) })}>刪除</button> : l.note}</td>
              </tr>;
            }) : []),
          ];
        })}</tbody>
      </table></div>
      <p className="note">複價 = 含損數量 × 單價（四捨五入到元）。管理費、利潤以直接工程費計，營業稅以（直接工程費＋管理費＋利潤）計。「另計」項目以 1 式計價。工程數量改變時（重新匯入、修改模型），已填的單價會自動套用到同名稱的工項。</p>
    </div>
  );
}
