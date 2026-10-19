import { EXT_FINISHES, FINISH_SHORT, FINISHES, PING, type FinishChoice, type Takeoff as T, type TakeoffSettings } from '@cloud-modeler/core';
import { useState } from 'react';
import { download, takeoffWorkbook } from '../lib/files';
import { Modal } from './Modal';

const f2 = (v: number | string | undefined) => typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v ?? '';
const r2 = (v: number) => Math.round(v * 100) / 100;

function toTsv(t: T, tab: string) {
  if (tab === 'budget') return ['項次\t名稱及規格\t單位\t數量\t單價\t總價\t備註', ...t.budget.map(b => b.sec ? (b.sec.includes('、') ? b.sec.replace('、', '、\t') : `\t${b.sec}`) : `${b.i}\t${b.name}\t${b.unit}\t${b.q}\t\t\t${b.note || ''}`)].join('\n');
  if (tab === 'detail') return t.groups.map(g => [g.title, '樓層\t空間名稱\t合計\t單位', ...g.rows.map(r => `${r.fl}\t${r.name}\t${r.q}\t${g.unit}`), `以上項目總計 = ${g.total} ${g.unit}`].join('\n')).join('\n\n');
  return ['空間\t面積㎡\t坪\t地坪\t天花\t牆面', ...t.rooms.map(r => `${r.name}\t${r2(r.area)}\t${r2(r.area / PING)}\t${r.fin.f}\t${r.fin.c}\t${r.fin.w}`)].join('\n');
}

export function Takeoff({ takeoff: t, project, subtitle, settings, onSettings, onFinish, onClose, toast }: {
  takeoff: T; project: string; subtitle: string; settings: TakeoffSettings;
  onSettings: (s: TakeoffSettings) => void;
  onFinish: (room: string, patch: Partial<FinishChoice>) => void;
  onClose: () => void; toast: (s: string) => void;
}) {
  const [tab, setTab] = useState<'budget' | 'detail' | 'spaces'>('budget');
  const copy = async () => {
    try { await navigator.clipboard.writeText(toTsv(t, tab)); toast('已複製，可直接貼進 Excel'); }
    catch { toast('瀏覽器不允許寫入剪貼簿，請改用「下載 Excel」'); }
  };
  const sel = (k: 'f' | 'c' | 'w', room: string, cur: string) => (
    <select id={`fin-${k}-${room}`} value={cur} onChange={e => onFinish(room, { [k]: e.target.value })}>
      {Object.keys(FINISHES[k]).map(c => <option key={c} value={c}>{c === '-' ? '不施作' : `${c} ${FINISH_SHORT[c]}`}</option>)}
    </select>
  );
  return (
    <Modal title="工程數量統計" desc={subtitle} onClose={onClose} actions={<>
      <button className="chip" onClick={onClose}>關閉</button>
      <button className="chip" onClick={copy}>複製目前分頁</button>
      <button className="chip on" onClick={() => download(`${project}-工程數量.xlsx`, takeoffWorkbook(t, project), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>下載 Excel</button>
    </>}>
      <div className="kv">
        {([['budget', '預算書數量'], ['detail', '裝修細項'], ['spaces', '空間做法設定']] as const).map(([k, l]) => (
          <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'budget' && <div className="tbl"><table>
        <thead><tr><th>項次</th><th>名稱及規格</th><th>單位</th><th className="num">數量</th><th>計算依據</th></tr></thead>
        <tbody>{t.budget.map((b, i) => b.sec
          ? <tr className="total" key={i}><td colSpan={5}>{b.sec}</td></tr>
          : <tr key={i}><td className="num">{b.i}</td><td>{b.name}</td><td>{b.unit}</td><td className="num">{f2(b.q)}</td><td className="note">{b.note}</td></tr>)}</tbody>
      </table></div>}
      {tab === 'detail' && t.groups.map(g => (
        <div className="tbl" key={g.title}><table>
          <thead><tr><th colSpan={4}>{g.title}</th></tr><tr><th>樓層</th><th>空間名稱</th><th className="num">合計</th><th>單位</th></tr></thead>
          <tbody>
            {g.rows.map((r, i) => <tr key={i}><td>{r.fl}</td><td>{r.name}</td><td className="num">{f2(r.q)}</td><td>{g.unit}</td></tr>)}
            <tr className="total"><td colSpan={2}>以上項目總計</td><td className="num">{f2(g.total)}</td><td>{g.unit}</td></tr>
          </tbody>
        </table></div>
      ))}
      {tab === 'spaces' && <>
        <div className="kv">
          <label>樓層 <input id="q-floor" type="text" value={settings.floor} style={{ width: 56 }} onChange={e => onSettings({ ...settings, floor: e.target.value || '1F' })} /></label>
          <label>外牆做法 <select id="q-ext" value={settings.ext} onChange={e => onSettings({ ...settings, ext: +e.target.value })}>
            {EXT_FINISHES.map((x, i) => <option key={i} value={i}>{x}</option>)}
          </select></label>
          <label>樓板厚 <input id="q-slab" type="number" min={0} max={50} value={settings.slab} style={{ width: 64 }} onChange={e => onSettings({ ...settings, slab: +e.target.value || 0 })} /> cm</label>
          <label>鋼筋 <input id="q-rebar" type="number" min={0} max={300} value={settings.rebar} style={{ width: 70 }} onChange={e => onSettings({ ...settings, rebar: +e.target.value || 0 })} /> kg/M3</label>
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
      <p className="note">數量依 3D 模型自動計算，牆高 {t.wallH} cm。空間依牆體與房名自動分區，門洞已從牆面與踢腳扣除，窗戶只從外牆扣除。做法依房名自動帶入，可在「空間做法設定」修改。正式報價前請現場丈量確認。</p>
    </Modal>
  );
}
