import { useEffect, useState } from 'react';
import { APP_EN, APP_NAME } from '../lib/brand';

/** Start screen each time the app opens: the logo and name on deep blue, fading out on its own or at a tap. */
export function Splash() {
  const [stage, setStage] = useState<'show' | 'fade' | 'gone'>('show');
  useEffect(() => {
    const a = setTimeout(() => setStage('fade'), 2200), b = setTimeout(() => setStage('gone'), 2800);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  if (stage === 'gone') return null;
  const skip = () => { setStage('fade'); setTimeout(() => setStage('gone'), 500); };
  return (
    <div className={`splash ${stage === 'fade' ? 'out' : ''}`} onClick={skip} role="presentation">
      <div className="splash-dots" />
      <div className="splash-mid">
        <div className="splash-logo"><img src="/logo.png" alt="" width={84} height={84} /></div>
        <h1>{APP_NAME}</h1>
        <p>{APP_EN}</p>
      </div>
    </div>
  );
}
