import type { Tool } from '../engine/Viewer';

const I: Record<string, JSX.Element> = {
  orbit: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></>,
  pan: <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
  select: <path d="M5 3l14 8-6 2-2 6z" />,
  measure: <><rect x="3" y="8" width="18" height="8" rx="1.5" /><path d="M7 8v3M11 8v4M15 8v3M19 8v4" /></>,
  push: <><path d="M12 20V6M7 10l5-5 5 5" /><path d="M4 20h16" /></>,
  move: <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />,
  draw: <><rect x="4" y="7" width="16" height="10" rx="1" /><path d="M4 12h16" /></>,
  paint: <><path d="M5 11l7-7 7 7-7 7z" /><path d="M19 15c1 1.6 1.5 2.6 1.5 3.3a1.5 1.5 0 0 1-3 0c0-.7.5-1.7 1.5-3.3z" /></>,
  flip: <><path d="M6 21V3h8v18" /><path d="M14 21a8 8 0 0 0-8-8" /></>,
  del: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  walk: <><circle cx="13" cy="4" r="2" /><path d="M10 22l2-7 3 3v4M8 12l3-4 4 1 2 4M12 15l-1-5" /></>,
  section: <><path d="M3 14h18" /><path d="M6 14V6h12v8" strokeDasharray="2 2" /><path d="M6 14v5h12v-5" /></>,
  home: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
};
const Icon = ({ k }: { k: string }) => <svg viewBox="0 0 24 24" aria-hidden="true">{I[k]}</svg>;

const GROUPS: [string, string, string, string][][] = [
  [['orbit', '旋轉', '旋轉視角', ''], ['pan', '平移', '平移視角', ''], ['select', '構件', '選取構件，查看尺寸', ''], ['measure', '捲尺', '捲尺：點兩點量距離', '']],
  [['push', '推拉', '推拉：上下拖曳改變高度', 'edit'], ['move', '移動', '移動構件', 'edit'], ['draw', '畫牆/櫃', '拖曳畫出牆或櫃', 'edit'], ['paint', '油漆桶', '點構件換顏色', 'edit'], ['flip', '改門向', '點門片切換開門方向', 'edit'], ['del', '刪除', '點構件刪除', 'danger']],
];

export function Dock({ tool, section, onTool, onUndo, onSection, onHome }: { tool: Tool; section: boolean; onTool: (t: Tool) => void; onUndo: () => void; onSection: () => void; onHome: () => void }) {
  const btn = (k: string, label: string, title: string, cls: string, on: boolean, click: () => void) => (
    <button key={k} className={`tool ${cls} ${on ? 'on' : ''}`} title={title} onClick={click}><Icon k={k} />{label}</button>
  );
  return (
    <nav className="dock" aria-label="工具">
      <h6>DOCK</h6>
      {GROUPS.map((g, i) => (
        <div className="dgrid" key={i}>{g.map(([k, label, title, cls]) => btn(k, label, title, cls, tool === k, () => onTool(tool === k && k !== 'orbit' ? 'orbit' : k as Tool)))}</div>
      ))}
      <div className="dgrid">
        {btn('undo', '復原', '復原 (Ctrl+Z)', '', false, onUndo)}
        {btn('walk', '漫遊', '第一人稱漫遊', '', tool === 'walk', () => onTool(tool === 'walk' ? 'orbit' : 'walk'))}
        {btn('section', '剖面', '水平剖面', '', section, onSection)}
        {btn('home', '歸位', '回到預設視角', '', false, onHome)}
      </div>
    </nav>
  );
}
