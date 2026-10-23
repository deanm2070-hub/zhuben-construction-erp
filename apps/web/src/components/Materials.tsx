import { MATERIAL_LOOKS, MATERIAL_USES, materialsOf, needsBase, SEC, type Material, type MaterialLook, type MaterialUse } from '@cloud-modeler/core';
import { useState } from 'react';

const UNITS = ['㎡', 'M', '式', '樘', '支', '組', '個', '才', 'M3', '坪'];

/**
 * 建材項目: every material the project can use. Built-in items (exterior finishes, finish codes F1, W1A …) can be
 * priced, given a look or hidden; new ones are added here and then appear in the 3D 材質 tool, the room finish
 * pickers, the exterior finish setting and the budget.
 */
export function Materials({ own, readOnly, onChange }: { own: Material[] | undefined; readOnly: boolean; onChange: (list: Material[]) => void }) {
  const list = materialsOf(own);
  const [use, setUse] = useState<MaterialUse | 'all'>('all');
  const [draft, setDraft] = useState<Material>({ name: '', use: 'ext', unit: '㎡', look: 'paint', color: '#d8d2c4' });
  // the stored list holds the project's own items and the changed fields of built-in ones
  const save = (name: string, patch: Partial<Material> | null) => {
    const cur = own || [];
    const base = list.find(m => m.name === name);
    if (patch === null) return onChange(cur.filter(m => m.name !== name));
    const next = { ...(cur.find(m => m.name === name) || { name, use: base!.use, unit: base!.unit }), ...patch };
    onChange(cur.some(m => m.name === name) ? cur.map(m => m.name === name ? next : m) : [...cur, next]);
  };
  const add = () => {
    const name = draft.name.trim();
    if (!name || list.some(m => m.name === name)) return;
    onChange([...(own || []), { ...draft, name }]);
    setDraft({ ...draft, name: '' });
  };
  const shown = list.filter(m => use === 'all' || m.use === use);
  const num = (m: Material, k: 'mat' | 'lab') => (
    <input type="number" min={0} disabled={readOnly} value={m[k] ?? ''} style={{ width: 76 }} placeholder="—"
      onChange={e => save(m.name, { [k]: e.target.value === '' ? undefined : +e.target.value })} />
  );
  return (
    <>
      <p className="note">在這裡定義所有建材項次。新增的外牆面、內牆面材質會出現在 3D「材質」工具和「外牆做法」；地坪、天花、內牆面會出現在「空間做法設定」；「其他項目」直接列在預算書的指定章節，數量可在預算報價填寫。外牆面材質勾「需 1:3 打底」的面積才算進「外牆1:3水泥砂漿打底」（石材乾掛、金屬板預設不勾）。單價填了會自動帶入預算（預算報價裡另填的單價優先）。清單隨專案存檔，也會記在這台電腦，新專案自動帶入。</p>
      <div className="kv tabs">
        {([['all', '全部'], ...Object.entries(MATERIAL_USES)] as [MaterialUse | 'all', string][]).map(([k, l]) =>
          <button key={k} className={`chip ${use === k ? 'on' : ''}`} onClick={() => setUse(k)}>{l}</button>)}
      </div>
      {!readOnly && <div className="kv conds">
        <b>新增建材</b>
        <select aria-label="用途" value={draft.use} onChange={e => setDraft({ ...draft, use: e.target.value as MaterialUse })}>
          {Object.entries(MATERIAL_USES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input id="mat-name" placeholder="品名規格，例：外牆1:3水泥砂漿打底+石材乾掛" value={draft.name} style={{ minWidth: 260, flex: 1 }} onChange={e => setDraft({ ...draft, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        <select aria-label="單位" value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value })}>{UNITS.map(u => <option key={u}>{u}</option>)}</select>
        {draft.use === 'item'
          ? <select aria-label="章節" value={draft.sec || SEC.other} onChange={e => setDraft({ ...draft, sec: e.target.value })}>{Object.values(SEC).map(s => <option key={s}>{s}</option>)}</select>
          : <><select aria-label="外觀" value={draft.look} onChange={e => setDraft({ ...draft, look: e.target.value as MaterialLook })}>{Object.entries(MATERIAL_LOOKS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input type="color" aria-label="顏色" value={draft.color || '#d8d2c4'} onChange={e => setDraft({ ...draft, color: e.target.value })} /></>}
        <button className="chip on" disabled={!draft.name.trim() || list.some(m => m.name === draft.name.trim())} onClick={add}>＋ 新增</button>
      </div>}
      <div className="tbl"><table>
        <thead><tr><th>用途</th><th>名稱及規格</th><th>單位</th><th>預算章節</th><th>外牆打底</th><th>3D 外觀</th><th className="num">材料單價</th><th className="num">工資單價</th><th /></tr></thead>
        <tbody>{shown.map(m => (
          <tr key={m.name} style={m.hidden ? { opacity: 0.45 } : undefined}>
            <td>{MATERIAL_USES[m.use]}</td>
            <td>{m.name}{m.builtin && <small className="note">（內建）</small>}</td>
            <td>{m.builtin ? m.unit : <select disabled={readOnly} value={m.unit} onChange={e => save(m.name, { unit: e.target.value })}>{UNITS.map(u => <option key={u}>{u}</option>)}</select>}</td>
            <td><select disabled={readOnly} style={{ maxWidth: 150 }} value={m.sec || (m.use === 'item' ? SEC.other : SEC.finish)} onChange={e => save(m.name, { sec: e.target.value })}>{Object.values(SEC).map(s => <option key={s}>{s}</option>)}</select></td>
            <td>{m.use === 'ext' ? <label><input type="checkbox" disabled={readOnly} checked={needsBase(m.name, [m])} onChange={e => save(m.name, { base: e.target.checked })} /> 需 1:3 打底</label> : '—'}</td>
            <td>{m.use === 'item' ? '—' : <>
              <select disabled={readOnly} value={m.look || 'paint'} onChange={e => save(m.name, { look: e.target.value as MaterialLook })}>{Object.entries(MATERIAL_LOOKS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input type="color" disabled={readOnly} aria-label="顏色" value={m.color || '#d8d2c4'} onChange={e => save(m.name, { color: e.target.value })} /></>}</td>
            <td className="num">{num(m, 'mat')}</td>
            <td className="num">{num(m, 'lab')}</td>
            <td>{readOnly ? null : m.builtin
              ? <button className="chip" onClick={() => save(m.name, { hidden: !m.hidden })}>{m.hidden ? '恢復' : '隱藏'}</button>
              : <button className="chip" onClick={() => save(m.name, null)}>刪除</button>}</td>
          </tr>))}</tbody>
      </table></div>
    </>
  );
}
