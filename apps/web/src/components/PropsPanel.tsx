import { isDoor, memberOf, type BoxObject, type CadFloor, type ModelObject } from '@cloud-modeler/core';
import { useEffect, useState } from 'react';

type Kind = 'rc' | 'light' | 'column' | '';
const kindOf = (o: BoxObject): Kind => o.layer !== 'wall' ? '' : o.rc?.kind === 'column' || memberOf(o) === '柱' ? 'column' : o.wall === 'light' ? 'light' : o.wall === 'rc' || Math.min(o.w, o.d) >= 18 ? 'rc' : 'light';

/** Properties of the selected part, editable: the manual correction of what the import recognised. */
export function PropsPanel({ o, floors, readOnly, onApply, onDelete, onClose }: {
  o: ModelObject; floors: CadFloor[]; readOnly: boolean;
  onApply: (patch: Partial<ModelObject>) => void; onDelete: () => void; onClose: () => void;
}) {
  const box = !isDoor(o) ? o : null;
  const init = () => ({
    name: o.name,
    w: String(Math.round(box ? box.w : (o as { b: number; a: number }).b - (o as { a: number }).a)),
    d: String(Math.round(box ? box.d : 0)),
    h: String(Math.round(box ? box.h : (o.h || 210))),
    y: String(Math.round((box ? box.y : o.y) || 0) - (floors.find(f => f.key === o.floor)?.y || 0)),
    floor: o.floor || '',
    kind: box ? kindOf(box) : '' as Kind,
  });
  const [f, setF] = useState(init);
  useEffect(() => { setF(init()); }, [o]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (s: string, min = 0) => Math.max(min, parseFloat(s) || 0);
  const apply = () => {
    const base = floors.find(x => x.key === f.floor)?.y || 0;
    if (box) {
      const patch: Partial<BoxObject> = { name: f.name.trim() || box.name, w: num(f.w, 1), d: num(f.d, 1), h: num(f.h, 1), y: num(f.y, -1000) + base };
      if (f.floor) patch.floor = f.floor;
      if (box.layer === 'wall' && f.kind !== kindOf(box)) {
        if (f.kind === 'column') patch.rc = { kind: 'column', mark: f.name || '柱', fl: f.floor || '1F', b: Math.min(num(f.w, 1), num(f.d, 1)), h: Math.max(num(f.w, 1), num(f.d, 1)) };
        else { patch.rc = undefined; patch.wall = f.kind as 'rc' | 'light'; if (f.kind === 'rc' && !/RC|外牆/.test(patch.name!)) patch.name = `RC牆 ${patch.name}`; }
      }
      onApply(patch as Partial<ModelObject>);
    } else {
      const d = o as Extract<ModelObject, { layer: 'door' }>, mid = (d.a + d.b) / 2, w = num(f.w, 10);
      onApply({ name: f.name.trim() || d.name, a: mid - w / 2, b: mid + w / 2, h: num(f.h, 10), y: num(f.y, -1000) + base, ...(f.floor ? { floor: f.floor } : {}) } as Partial<ModelObject>);
    }
  };
  const field = (k: 'w' | 'd' | 'h' | 'y', label: string) => (
    <label>{label}<span><input id={`prop-${k}`} type="number" inputMode="decimal" value={f[k]} disabled={readOnly} onChange={e => setF({ ...f, [k]: e.target.value })} onKeyDown={e => e.key === 'Enter' && apply()} /> cm</span></label>
  );
  return (
    <aside className="props" aria-label="構件屬性">
      <div className="propsHead"><b>構件屬性</b><span className="badge">{memberOf(o)}</span><button className="x" aria-label="關閉" onClick={onClose}>×</button></div>
      <label>構件名稱<input id="prop-name" type="text" value={f.name} disabled={readOnly} placeholder="輸入新名稱" enterKeyHint="done"
        onChange={e => setF({ ...f, name: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onBlur={() => { const n = f.name.trim(); if (n && n !== o.name) apply(); }} /></label>
      {box?.layer === 'wall' && <label>類別<select id="prop-kind" value={f.kind} disabled={readOnly} onChange={e => setF({ ...f, kind: e.target.value as Kind })}>
        <option value="rc">RC 牆（算混凝土、模板）</option><option value="light">隔間牆（算隔間面積）</option><option value="column">柱</option></select></label>}
      {box ? <>{field('w', '寬')}{field('d', '深（厚）')}</> : field('w', '門窗寬')}
      {field('h', '高')}
      {field('y', '離樓板高')}
      {floors.length > 0 && <label>樓層<select id="prop-floor" value={f.floor} disabled={readOnly} onChange={e => setF({ ...f, floor: e.target.value })}>
        {!o.floor && <option value="">—</option>}{floors.map(x => <option key={x.key}>{x.key}</option>)}</select></label>}
      {!readOnly && <div className="kv"><button className="chip on" onClick={apply}>套用</button><button className="chip ghost danger" onClick={onDelete}>刪除</button></div>}
      <p className="note">名稱改完按 Enter 或點別處就存好；尺寸改完按「套用」（或 Enter），可用「復原」回到上一步；工程數量會依新尺寸重算。</p>
    </aside>
  );
}
