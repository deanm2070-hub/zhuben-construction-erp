import { EXT_FINISHES, FINISH_SHORT, FINISHES, groupQuantities, materialsOf, PING, REBAR_KINDS, REBAR_STD, rebarSummary, type FinishChoice, type GroupBy, type PricedBudget, type Pricing, type Takeoff as T, type PriceRate, type TakeoffSettings } from '@cloud-modeler/core';
import { Deleted } from './BudgetPane';
import { Materials } from './Materials';
import { saveMaterials } from '../lib/materials';
import { useState } from 'react';
import { download } from '../lib/files';
import { formworkCells, reportWorkbook } from '../lib/report';

const f2 = (v: number | string | undefined) => typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v ?? '';
const r2 = (v: number) => Math.round(v * 100) / 100;

const GROUPS: Record<string, [GroupBy, string]> = { floor: ['floor', '樓層'], member: ['member', '構件'], area: ['area', '施工區域'] };

function toTsv(t: T, tab: string) {
  if (GROUPS[tab]) return [`${GROUPS[tab][1]}\t工程項目\t數量\t單位`, ...groupQuantities(t.calc, GROUPS[tab][0]).flatMap(g => g.rows.map(r => `${g.key}\t${r.item}\t${r.q}\t${r.unit}`))].join('\n');
  if (tab === 'budget') return ['項次\t名稱及規格\t單位\t數量\t單價\t總價\t備註', ...t.budget.map(b => b.sec ? (b.sec.includes('、') ? b.sec.replace('、', '、\t') : `\t${b.sec}`) : `${b.i}\t${b.name}\t${b.unit}\t${b.tpl ? '' : b.q}\t\t\t${b.note || ''}`)].join('\n');
  if (tab === 'detail') return t.groups.map(g => [g.title, '樓層\t空間名稱\t合計\t單位', ...g.rows.map(r => `${r.fl}\t${r.name}\t${r.q}\t${g.unit}`), `以上項目總計 = ${g.total} ${g.unit}`].join('\n')).join('\n\n');
  if (tab === 'rebar') return ['樓層\t構件\t編號\t鋼筋位置\t號數\t單支長(m)\t支數\t總長(m)\t重量(kg)\t計算式', ...(t.rebar?.rows || []).map(r => `${r.fl}\t${r.kind}\t${r.mark}\t${r.part}\t#${r.s}\t${r.len / 100}\t${r.n}\t${r2(r.len * r.n / 100)}\t${r.kg}\t${r.expr}`)].join('\n');
  if (tab === 'rebarSum') {
    const { byFloor, bySize } = rebarSummary(t.rebar?.rows || []);
    return [['樓層', ...REBAR_KINDS, '合計'].join('\t'), ...[...byFloor].map(([f, v]) => [f, ...REBAR_KINDS.map(k => r2(v[k])), r2(v.合計)].join('\t')), '', '號數\t總長(m)\t單位重(kg/m)\t重量(kg)', ...bySize.map(([z, v]) => `#${z}\t${r2(v.len)}\t${REBAR_STD.kg[z]}\t${r2(v.kg)}`)].join('\n');
  }
  if (tab === 'formwork' && t.formwork) return ['棟別\t樓層\t版編號\t版內編\t原始模板\t計算式\t封模\t計算式\t扣版牆接頭\t計算式\t扣柱頭\t計算式\t扣接頭合計\t真實模板', ...formworkCells(t.formwork).map(r => r.join('\t'))].join('\n');
  if (tab === 'calc') return ['工程項目\t樓層\t位置\t計算式\t數量\t單位', ...t.calc.map(c => `${c.item}\t${c.fl}\t${c.where}\t${c.expr}\t${c.q}\t${c.unit}`)].join('\n');
  return ['空間\t面積㎡\t坪\t地坪\t天花\t牆面', ...t.rooms.map(r => `${r.name}\t${r2(r.area)}\t${r2(r.area / PING)}\t${r.fin.f}\t${r.fin.c}\t${r.fin.w}`)].join('\n');
}

type Tab = 'budget' | 'formwork' | 'calc' | 'floor' | 'member' | 'area' | 'rebar' | 'rebarSum' | 'detail' | 'spaces' | 'mats';

export function Takeoff({ takeoff: t, pb, pricing, project, subtitle, settings, readOnly, onSettings, onPricing, onFinish, toast }: {
  takeoff: T; pb: PricedBudget; pricing: Pricing; project: string; subtitle: string; settings: TakeoffSettings; readOnly: boolean;
  onSettings: (s: TakeoffSettings) => void;
  onPricing: (p: Pricing) => void;
  onFinish: (room: string, patch: Partial<FinishChoice>) => void;
  toast: (s: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('budget');
  const set = (p: Partial<TakeoffSettings>) => onSettings({ ...settings, ...p });
  const grouped = GROUPS[tab] ? groupQuantities(t.calc, GROUPS[tab][0]) : [];
  const [rbFloor, setRbFloor] = useState('全部');
  const [rbKind, setRbKind] = useState('全部');
  const rb = t.rebar?.rows || [];
  const rbRows = rb.filter(r => (rbFloor === '全部' || r.fl === rbFloor) && (rbKind === '全部' || r.kind === rbKind));
  const rbSum = rebarSummary(rb);
  const [calcFloor, setCalcFloor] = useState('全部');
  const calcFloors = ['全部', ...new Set(t.calc.map(c => c.fl))];
  const calcRows = t.calc.filter(c => calcFloor === '全部' || c.fl === calcFloor);
  // item headers with subtotals, in budget order
  const calcItems = [...new Set(calcRows.map(c => `${c.item}|${c.unit}`))];
  // the item list is shared with 預算報價: deleting or adding an item here does the same there
  const P = pricing;
  const setRate = (key: string, patch: Partial<PriceRate> & { name?: string; unit?: string; q?: number }) => key.startsWith('custom|')
    ? onPricing({ ...P, custom: P.custom.map(c => `custom|${c.id}` === key ? { ...c, ...patch } : c) })
    : onPricing({ ...P, rates: { ...P.rates, [key]: { ...(P.rates[key] || {}), ...patch } } });
  const del = (key: string) => key.startsWith('custom|') ? onPricing({ ...P, custom: P.custom.filter(c => `custom|${c.id}` !== key) }) : setRate(key, { hidden: true });
  const addCustom = (sec: string) => onPricing({ ...P, custom: [...P.custom, { id: Math.random().toString(36).slice(2, 10), sec, name: '新工項', unit: '式', q: 1 }] });
  const copy = async () => {
    try { await navigator.clipboard.writeText(toTsv(t, tab)); toast('已複製，可直接貼進 Excel'); }
    catch { toast('瀏覽器不允許寫入剪貼簿，請改用「下載 Excel」'); }
  };
  const mats = materialsOf(settings.materials);
  const USE = { f: 'floor', c: 'ceil', w: 'wall' } as const;
  const sel = (k: 'f' | 'c' | 'w', room: string, cur: string) => (
    <select id={`fin-${k}-${room}`} value={cur} disabled={readOnly} onChange={e => onFinish(room, { [k]: e.target.value })}>
      {Object.keys(FINISHES[k]).filter(c => c === '-' || c === cur || !mats.find(m => m.builtin && m.name.startsWith(`${c}-`))?.hidden).map(c => <option key={c} value={c}>{c === '-' ? '不施作' : `${c} ${FINISH_SHORT[c]}`}</option>)}
      {mats.filter(m => !m.builtin && m.use === USE[k] && (!m.hidden || m.name === cur)).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
    </select>
  );
  const extCur = settings.extName || EXT_FINISHES[settings.ext] || EXT_FINISHES[0];
  return (
    <div className="pane">
      <div className="paneHead">
        <div><h2>工程數量</h2><p className="note">{subtitle}</p></div>
        <div className="kv">
          <button className="chip" onClick={copy}>複製目前分頁</button>
          <button className="chip on" onClick={() => download(`${project}-工程數量.xlsx`, reportWorkbook(['boq', 'floor', 'member', 'area', 'calc', ...(t.formwork ? ['formwork'] as const : []), ...(rb.length ? ['rebar', 'rebarSum'] as const : []), 'finish', 'rooms'], { project, t, pb, pricing }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>下載 Excel</button>
        </div>
      </div>
      <details className="conds" open>
        <summary>算量條件（本案）</summary>
        <div className="kv">
          <label>外牆做法 <select id="q-ext" disabled={readOnly} value={extCur} onChange={e => { const i = EXT_FINISHES.indexOf(e.target.value); set({ extName: e.target.value, ext: i >= 0 ? i : settings.ext }); }}>
            {mats.filter(m => m.use === 'ext' && (!m.hidden || m.name === extCur)).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select></label>
          <label>樓板厚 <input id="q-slab" disabled={readOnly} type="number" min={0} max={50} value={settings.slab} style={{ width: 64 }} onChange={e => set({ slab: +e.target.value || 0 })} /> cm</label>
          <label>開挖深 <input id="q-dig" disabled={readOnly} type="number" min={0} max={1000} value={settings.dig ?? 150} style={{ width: 70 }} onChange={e => set({ dig: +e.target.value || 0 })} /> cm</label>
        </div>
        <div className="kv">
          <label><input type="checkbox" disabled={readOnly} checked={settings.beamDry !== false} onChange={e => set({ beamDry: e.target.checked })} /> 室內粉刷油漆含梁底、梁側</label>
          <label><input type="checkbox" disabled={readOnly} checked={settings.beamWet !== false} onChange={e => set({ beamWet: e.target.checked })} /> 廁所浴室粉刷含梁底、梁側</label>
          <label>壁磚貼到 <select disabled={readOnly} value={settings.tileTo || 'beam'} onChange={e => set({ tileTo: e.target.value as TakeoffSettings['tileTo'] })}>
            <option value="beam">梁底</option><option value="slab">樓板底</option><option value="h">指定高度</option>
          </select></label>
          {settings.tileTo === 'h' && <label>壁磚高 <input type="number" disabled={readOnly} min={0} max={600} value={settings.tileH ?? 240} style={{ width: 64 }} onChange={e => set({ tileH: +e.target.value || 0 })} /> cm</label>}
          <label>廁所浴室防水高 <input type="number" disabled={readOnly} min={0} max={600} value={settings.wetH ?? 200} style={{ width: 64 }} onChange={e => set({ wetH: +e.target.value || 0 })} /> cm</label>
          <label>外牆防水算法 <select disabled={readOnly} value={settings.extWater || 'joint'} onChange={e => set({ extWater: e.target.value as TakeoffSettings['extWater'] })}>
            <option value="joint">門窗框長＋樓層接縫長（M）</option><option value="area">外牆面積（㎡）</option>
          </select></label>
        </div>
      </details>
      <div className="stats">
        {t.floorArea > 0 || !t.slabArea
          ? <div><span>樓地板面積（室內空間）</span><b>{f2(r2(t.floorArea))} ㎡</b><small>{f2(r2(t.floorArea / PING))} 坪{t.slabArea ? `・樓板 ${f2(t.slabArea)} ㎡` : ''}</small></div>
          : <div><span>樓地板面積（依樓板）</span><b>{f2(t.slabArea)} ㎡</b><small>{f2(r2(t.slabArea / PING))} 坪・空間未標示做法</small></div>}
        {([['混凝土', /混凝土/, 'M3'], ['模板', /模板/, '㎡'], ['鋼筋', /^鋼筋（/, '噸']] as const).map(([l, re, u]) => {
          const q = t.calc.filter(c => re.test(c.item) && c.unit === u).reduce((a, c) => a + c.q, 0);
          return <div key={l}><span>{l}</span><b>{f2(r2(q))} {u}</b></div>;
        })}
        <div><span>牆面（內＋外）</span><b>{f2(r2(t.calc.filter(c => /牆面|外牆|內牆/.test(c.item) && c.unit === '㎡' && !/防水|^外牆1:3水泥砂漿打底$|^W2C/.test(c.item)).reduce((a, c) => a + c.q, 0)))} ㎡</b></div>
        <div><span>工項</span><b>{pb.count}</b><small>{t.calc.length} 筆計算</small></div>
      </div>
      <div className="kv tabs">
        {([['budget', '依工項（預算書）'], ['floor', '依樓層'], ['member', '依構件'], ['area', '依施工區域'], ['calc', '數量計算式'], ...(t.formwork ? [['formwork', '模板報表']] as const : []), ...(rb.length ? [['rebar', '鋼筋料單'], ['rebarSum', '鋼筋統計']] as const : []), ['detail', '裝修細項'], ['spaces', '空間做法設定'], ['mats', '建材項目']] as const).map(([k, l]) => (
          <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {GROUPS[tab] && grouped.map(g => (
        <div className="tbl" key={g.key}><table>
          <thead><tr><th colSpan={4}>{GROUPS[tab][1]}：{g.key}</th></tr><tr><th>工程項目</th><th className="num">數量</th><th>單位</th><th className="num">計算筆數</th></tr></thead>
          <tbody>{g.rows.map((r, i) => <tr key={i}><td>{r.item}</td><td className="num">{f2(r.q)}</td><td>{r.unit}</td><td className="num">{r.n}</td></tr>)}</tbody>
        </table></div>
      ))}
      {tab === 'budget' && <><div className="tbl"><table>
        <thead><tr><th>項次</th><th>名稱及規格</th><th>單位</th><th className="num">數量</th><th>計算依據</th>{!readOnly && <th></th>}</tr></thead>
        <tbody>{pb.sections.map(s => [
          <tr className="total" key={s.sec}><td colSpan={5}>{s.sec}</td>{!readOnly && <td><button className="chip ghost sm" onClick={() => addCustom(s.sec)}>＋ 工項</button></td>}</tr>,
          ...s.lines.map(l => {
            const c = l.custom, blank = l.tpl && !l.manual && l.q0 == null;
            return <tr key={l.key} className={blank ? 'tplRow' : ''}>
              <td className="num">{l.i}</td>
              <td>{c && !readOnly ? <input id={`tn-${c.id}`} type="text" value={c.name} onChange={e => setRate(l.key, { name: e.target.value })} /> : l.name}</td>
              <td>{c && !readOnly ? <input id={`tu-${c.id}`} type="text" value={c.unit} style={{ width: 44 }} onChange={e => setRate(l.key, { unit: e.target.value })} /> : l.unit}</td>
              <td className="num">{c && !readOnly ? <input id={`tq-${c.id}`} type="number" min={0} step="any" value={c.q || ''} style={{ width: 80 }} onChange={e => setRate(l.key, { q: parseFloat(e.target.value) || 0 })} /> : blank ? '' : f2(l.q)}</td>
              <td className="note">{c ? '自訂工項' : l.note}</td>
              {!readOnly && <td><button className="chip ghost danger sm" title="從清單刪除這一項（可在表格下方還原）" onClick={() => del(l.key)}>刪除</button></td>}
            </tr>;
          }),
        ])}</tbody>
      </table></div>
      <Deleted pb={pb} readOnly={readOnly} onRestore={keys => { const rates = { ...P.rates }; for (const k of keys) rates[k] = { ...rates[k], hidden: false }; onPricing({ ...P, rates }); }} />
      </>}
      {tab === 'calc' && <>
        <div className="kv">
          <label>樓層 <select id="calc-floor" value={calcFloor} onChange={e => setCalcFloor(e.target.value)}>
            {calcFloors.map(f => <option key={f} value={f}>{f}</option>)}
          </select></label>
        </div>
        <div className="tbl"><table>
          <thead><tr><th>樓層</th><th>位置／構件</th><th>計算式</th><th className="num">數量</th><th>單位</th></tr></thead>
          <tbody>{calcItems.map(k => {
            const [item, unit] = k.split('|'), rows = calcRows.filter(c => c.item === item && c.unit === unit);
            return [
              <tr className="total" key={k}><td colSpan={3}>{item}</td><td className="num">{f2(r2(rows.reduce((s, c) => s + c.q, 0)))}</td><td>{unit}</td></tr>,
              ...rows.map((c, i) => <tr key={k + i}><td>{c.fl}</td><td>{c.where}</td><td className="note">{c.expr}</td><td className="num">{f2(c.q)}</td><td>{c.unit}</td></tr>),
            ];
          })}</tbody>
        </table></div>
      </>}
      {tab === 'rebar' && <>
        <div className="kv">
          <label>樓層 <select id="rb-floor" value={rbFloor} onChange={e => setRbFloor(e.target.value)}>
            {['全部', ...rbSum.byFloor.keys()].map(f => <option key={f} value={f}>{f}</option>)}
          </select></label>
          <label>構件 <select id="rb-kind" value={rbKind} onChange={e => setRbKind(e.target.value)}>
            {['全部', ...REBAR_KINDS.filter(k => rb.some(r => r.kind === k))].map(k => <option key={k} value={k}>{k}</option>)}
          </select></label>
          <span className="note">{rbRows.length} 筆，合計 {f2(r2(rbRows.reduce((a, r) => a + r.kg, 0)))} kg</span>
        </div>
        <div className="tbl"><table>
          <thead><tr><th>樓層</th><th>構件</th><th>編號</th><th>鋼筋位置</th><th>號數</th><th className="num">單支長 m</th><th className="num">支數</th><th className="num">總長 m</th><th className="num">重量 kg</th><th>計算式</th></tr></thead>
          <tbody>{rbRows.map((r, i) => <tr key={i}><td>{r.fl}</td><td>{r.kind}</td><td>{r.mark}</td><td>{r.part}</td><td>#{r.s}</td><td className="num">{f2(r.len / 100)}</td><td className="num">{r.n}</td><td className="num">{f2(r2(r.len * r.n / 100))}</td><td className="num">{f2(r.kg)}</td><td className="note">{r.expr}</td></tr>)}</tbody>
        </table></div>
        {(t.rebar!.standard?.length ?? 0) > 0 && <p className="note">沒有配筋圖的構件：{t.rebar!.standard!.join('、')}；依標準圖（樓梯、樓板、S0-07 牆）與規範最少配筋（梁 As,min、柱 1%）逐支計算，含搭接、彎鉤、錨定。匯入結構配筋圖後會自動改用圖上配筋。</p>}
      </>}
      {tab === 'formwork' && t.formwork && <>
        <div className="tbl"><table>
          <thead><tr><th rowSpan={2}>棟別</th><th rowSpan={2}>樓層</th><th rowSpan={2}>版編號</th><th rowSpan={2}>版內編</th><th colSpan={10} style={{ textAlign: 'center' }}>版　明　細</th></tr>
            <tr><th className="num">原始模板</th><th>計算式</th><th className="num">封模</th><th>計算式</th><th className="num">扣版牆接頭</th><th>計算式</th><th className="num">扣柱頭</th><th>計算式</th><th className="num">扣接頭合計</th><th className="num">真實模板</th></tr></thead>
          <tbody>{formworkCells(t.formwork).map((r, i) => <tr key={i} className={r[2] === '樓層小計' || r[0] === '合計' ? 'total' : ''}>{r.map((v, j) => <td key={j} className={j >= 4 && ![5, 7, 9, 11].includes(j) ? 'num' : ''}>{v}</td>)}</tr>)}</tbody>
        </table></div>
        <p className="note">{t.formwork.note.join(' ')}</p>
      </>}
      {tab === 'rebarSum' && <>
        <div className="tbl"><table>
          <thead><tr><th>樓層</th>{REBAR_KINDS.map(k => <th key={k} className="num">{k} kg</th>)}<th className="num">合計 kg</th><th className="num">噸</th></tr></thead>
          <tbody>
            {[...rbSum.byFloor].map(([f, v]) => <tr key={f}><td>{f}</td>{REBAR_KINDS.map(k => <td key={k} className="num">{f2(r2(v[k]))}</td>)}<td className="num">{f2(r2(v.合計))}</td><td className="num">{f2(Math.round(v.合計) / 1000)}</td></tr>)}
            <tr className="total"><td>全棟</td>{REBAR_KINDS.map(k => <td key={k} className="num">{f2(r2([...rbSum.byFloor.values()].reduce((a, v) => a + v[k], 0)))}</td>)}<td className="num">{f2(r2(rb.reduce((a, r) => a + r.kg, 0)))}</td><td className="num">{f2(Math.round(rb.reduce((a, r) => a + r.kg, 0)) / 1000)}</td></tr>
          </tbody>
        </table></div>
        <div className="tbl"><table>
          <thead><tr><th>號數</th><th>材質</th><th className="num">總長 m</th><th className="num">單位重 kg/m</th><th className="num">重量 kg</th></tr></thead>
          <tbody>{rbSum.bySize.map(([z, v]) => <tr key={z}><td>#{z}</td><td>{z >= 6 ? 'SD420' : 'SD280'}</td><td className="num">{f2(r2(v.len))}</td><td className="num">{REBAR_STD.kg[z]}</td><td className="num">{f2(r2(v.kg))}</td></tr>)}</tbody>
        </table></div>
        <p className="note">依結構配筋圖與鋼筋標準圖（fc'=280；#5 以下 SD280、#6 以上 SD420）計算：伸展長度 ld、搭接長度 lst（乙級）、90° 彎鉤延伸、135° 箍筋彎鉤 6d≧7.5cm、柱隔層錯開搭接、超過 12m 的鋼筋加計搭接。未含損耗。牆依 S0-07 非結構牆配筋標準（厚 15 以上雙層），女兒牆依雜項配筋圖。</p>
      </>}
      {tab === 'detail' && t.groups.map(g => (
        <div className="tbl" key={g.title}><table>
          <thead><tr><th colSpan={4}>{g.title}</th></tr><tr><th>樓層</th><th>空間名稱</th><th className="num">合計</th><th>單位</th></tr></thead>
          <tbody>
            {g.rows.map((r, i) => <tr key={i}><td>{r.fl}</td><td>{r.name}</td><td className="num">{f2(r.q)}</td><td>{g.unit}</td></tr>)}
            <tr className="total"><td colSpan={2}>以上項目總計</td><td className="num">{f2(g.total)}</td><td>{g.unit}</td></tr>
          </tbody>
        </table></div>
      ))}
      {tab === 'mats' && <Materials own={settings.materials} readOnly={readOnly} onChange={list => { set({ materials: list }); saveMaterials(list); }} />}
      {tab === 'spaces' && <>
        <div className="kv">
          <label>樓層 <input id="q-floor" disabled={readOnly} type="text" value={settings.floor} style={{ width: 56 }} onChange={e => onSettings({ ...settings, floor: e.target.value || '1F' })} /></label>
        </div>
        <div className="tbl"><table>
          <thead><tr><th>空間</th><th className="num">面積 ㎡</th><th className="num">坪</th><th>地坪</th><th>天花</th><th>牆面</th></tr></thead>
          <tbody>
            {t.rooms.map(r => <tr key={r.name}><td>{r.name}</td><td className="num">{f2(r2(r.area))}</td><td className="num">{f2(r2(r.area / PING))}</td>
              <td>{sel('f', r.name, r.fin.f)}</td><td>{sel('c', r.name, r.fin.c)}</td><td>{sel('w', r.name, r.fin.w)}</td></tr>)}
            <tr className="total"><td>合計</td><td className="num">{f2(r2(t.floorArea))}</td><td className="num">{f2(r2(t.floorArea / PING))}</td><td colSpan={3} /></tr>
          </tbody>
        </table></div>
      </>}
      <p className="note">數量依 3D 模型自動計算，每一項的算法列在「數量計算式」。空間依牆體與房名自動分區，門洞已從牆面與踢腳扣除，窗戶從所在空間的牆面扣除。梁、挖土、水電弱電消防為估算，取得結構圖與設備圖後請調整。做法依房名自動帶入，可在「空間做法設定」修改。模型不對的地方，在「3D 模型」選取構件直接修改尺寸或類別，數量會跟著重算。</p>
    </div>
  );
}
