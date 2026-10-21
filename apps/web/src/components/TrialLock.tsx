import { LINE_ADD, LINE_ID, TRIAL_LOCK } from '../lib/account';
import { Modal } from './Modal';

/** Shown when a trial account reaches for a paid feature (importing drawings, own projects). */
export function TrialLock({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={TRIAL_LOCK} onClose={onClose} actions={<>
      <button className="chip" onClick={onClose}>知道了</button>
      <a className="chip key" href={LINE_ADD} target="_blank" rel="noopener" style={{ textDecoration: 'none' }}>LINE 聯絡管理員 {LINE_ID}</a>
    </>}>
      <p>試用帳號可以用「範例平面」體驗 3D 模型、工程數量、預算報價與報表匯出。</p>
      <p>匯入自己的圖檔（DWG、DXF、SketchUp）、建立空白專案、開啟專案檔，需要正式訂閱後開通。請聯絡管理員開通訂閱。</p>
    </Modal>
  );
}
