import { useEffect, useMemo, useState } from 'react';
import { APP_EN, APP_NAME } from '../lib/brand';

const STEP = 59; // the dot grid's spacing (.splash-dots background-size)

/** some of the grid's dots, picked at random, light up and fade one after another */
function twinkles() {
  const nx = Math.ceil(innerWidth / STEP / 2) + 1, ny = Math.ceil(innerHeight / STEP / 2) + 1;
  const n = Math.min(60, Math.round((2 * nx + 1) * (2 * ny + 1) * 0.18));
  const out: { k: number; x: number; y: number; delay: number; dur: number }[] = [];
  for (let k = 0; out.length < n && k < n * 4; k++) {
    const x = Math.round((Math.random() * 2 - 1) * nx) * STEP, y = Math.round((Math.random() * 2 - 1) * ny) * STEP;
    // none behind the logo and the name, so they stay easy to read
    if (Math.abs(x) < Math.min(innerWidth / 2, 360) && y > -130 && y < 150) continue;
    out.push({ k, x, y, delay: Math.random() * 2.4, dur: 1.1 + Math.random() * 1.5 });
  }
  return out;
}

/** Start screen each time the app opens: the logo and name on deep blue, fading out on its own or at a tap. */
export function Splash() {
  const [stage, setStage] = useState<'show' | 'fade' | 'gone'>('show');
  useEffect(() => {
    const a = setTimeout(() => setStage('fade'), 2200), b = setTimeout(() => setStage('gone'), 2800);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  const stars = useMemo(twinkles, []);
  if (stage === 'gone') return null;
  const skip = () => { setStage('fade'); setTimeout(() => setStage('gone'), 500); };
  return (
    <div className={`splash ${stage === 'fade' ? 'out' : ''}`} onClick={skip} role="presentation">
      <div className="splash-dots">
        {stars.map(t => <i key={t.k} style={{ left: `calc(50% + ${t.x}px)`, top: `calc(50% + ${t.y}px)`, animationDelay: `${t.delay}s`, animationDuration: `${t.dur}s` }} />)}
      </div>
      <div className="splash-mid">
        <img className="splash-logo" src="/logo-mark.png" alt="" width={150} height={150} />
        <h1>{APP_NAME}</h1>
        <p>{APP_EN}</p>
      </div>
    </div>
  );
}
