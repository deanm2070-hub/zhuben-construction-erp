import type { ReactNode } from 'react';

export function Modal({ title, desc, children, actions, onClose }: { title: string; desc?: ReactNode; children?: ReactNode; actions: ReactNode; onClose: () => void }) {
  return (
    <div className="modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="box" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {desc && <p className="desc">{desc}</p>}
        {children && <div className="body">{children}</div>}
        <div className="acts">{actions}</div>
      </div>
    </div>
  );
}
