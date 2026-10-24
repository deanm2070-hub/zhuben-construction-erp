import type { Issue } from '@cloud-modeler/core';
import { useState } from 'react';
import { reportProblem } from '../lib/account';
import { store } from '../lib/store';
import { VERSION } from '../lib/version';
import { Modal } from './Modal';

/**
 * 回報問題: one press sends the project (its model as saved in the cloud), the sanity-check list, the list of the original
 * drawings and the user's note to the administrators, who get an e-mail and see it on the 管理員後台.
 */
export function ReportProblem({ projectId, project, issues, onSave, onClose, toast }: {
  projectId: string; project: string; issues: Issue[]; onSave: () => Promise<void>; onClose: () => void; toast: (s: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const warn = issues.filter(i => i.sev === 'warn').length, fixed = issues.filter(i => i.sev === 'fixed').length;
  const send = async () => {
    if (!store.cloud) { setErr('回報需要登入雲端帳號（本機模式沒有雲端專案可以送出）'); return; }
    if (text.trim().length < 2) { setErr('請先寫一下哪裡不對（例如：2F 左側少了一支梁、1F 多了一根柱）'); return; }
    setBusy(true); setErr('');
    try {
      await onSave();
      await reportProblem(projectId, text.trim(), issues, VERSION);
      toast('已送出回報，謝謝！我們會依這份圖和模型改進辨識');
      onClose();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <Modal title="回報問題" desc={<>把這個專案的 3D 模型、自檢清單和匯入的原始圖面一起送給管理員，我們用它來改進辨識。送出的內容：專案「{project}」目前存在雲端的模型、自檢 {warn} 項要看／{fixed} 項自動補、原始圖面檔、軟體版本 {VERSION}。</>}
      onClose={onClose} actions={<>
        <button className="chip" onClick={onClose} disabled={busy}>取消</button>
        <button className="chip key" onClick={send} disabled={busy}>{busy ? '送出中…' : '送出回報'}</button>
      </>}>
      <label className="note" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><b>哪裡不對？</b>
        <textarea rows={5} value={text} onChange={e => setText(e.target.value)} placeholder="例如：2F 左側（X1–X3 之間）圖上有 B2 梁，3D 沒有建出；1F 右下角多了一根柱…" autoFocus />
      </label>
      {err && <p className="err">{err}</p>}
    </Modal>
  );
}
