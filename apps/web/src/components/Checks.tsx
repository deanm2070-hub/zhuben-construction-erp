import { sortIssues, type CadFloor, type Issue } from '@cloud-modeler/core';

const ICON = { warn: '⚠', fixed: '✎', info: 'ℹ' } as const;

/**
 * The structural sanity check of the model (合理性自檢): what does not add up, what the software filled in on its
 * own, and what is worth a look. Each line can jump to the part in the 3D view.
 */
export function Checks({ issues, floors, onGo, onRecheck, onClose }: {
  issues: Issue[]; floors: CadFloor[] | undefined;
  onGo: (i: Issue) => void; onRecheck: () => void; onClose: () => void;
}) {
  const list = sortIssues(issues, floors);
  const n = (s: Issue['sev']) => list.filter(i => i.sev === s).length;
  return (
    <div className="checks" role="region" aria-label="合理性自檢">
      <div className="head">
        <b>合理性自檢</b>
        <span className="note">{list.length ? `${n('warn')} 項要看、${n('fixed')} 項已自動補、${n('info')} 項參考` : '沒有發現問題'}</span>
        <button className="chip sm" onClick={onRecheck} title="依目前的模型重新檢查（修正之後按一下）">重新檢查</button>
        <button className="chip sm ghost" onClick={onClose} aria-label="關閉">✕</button>
      </div>
      <p className="note">檢查柱頂有沒有梁或樓板、柱下有沒有支承、梁端有沒有柱牆、柱有沒有重疊、牆有沒有浮空、結構圖上每個梁柱編號有沒有建出。⚠ 要看、✎ 軟體已自動補上、ℹ 參考。</p>
      {list.length > 0 && <ul>
        {list.map((i, k) => <li key={k} className={`sev-${i.sev}`}>
          <span className="ico" aria-hidden>{ICON[i.sev]}</span>
          <span className="txt">{i.floor && <b>{i.floor}</b>} {i.text}</span>
          {(i.ids?.length || i.at) && <button className="chip sm" onClick={() => onGo(i)}>前往</button>}
        </li>)}
      </ul>}
    </div>
  );
}
