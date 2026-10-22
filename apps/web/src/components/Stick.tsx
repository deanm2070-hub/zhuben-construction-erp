import { useRef, useState } from 'react';

const R = 46;
/** Walk joystick: drag the knob; up walks forward, sideways steps left / right, further is faster. */
export function Stick({ onMove }: { onMove: (x: number, y: number) => void }) {
  const base = useRef<HTMLDivElement>(null);
  const [k, setK] = useState({ x: 0, y: 0 });
  const move = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect();
    let x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    const l = Math.hypot(x, y);
    if (l > R) { x *= R / l; y *= R / l; }
    setK({ x, y });
    onMove(x / R, -y / R);
  };
  const stop = () => { setK({ x: 0, y: 0 }); onMove(0, 0); };
  return (
    <div className="stick" ref={base} role="application" aria-label="漫遊搖桿：往上拖前進，左右拖橫移"
      onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); move(e); }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e); }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
      <span className="knob" style={{ transform: `translate(${k.x}px, ${k.y}px)` }} />
    </div>
  );
}
