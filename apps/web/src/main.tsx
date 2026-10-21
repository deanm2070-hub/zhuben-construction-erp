import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// phone: the page never zooms (iPhone Safari ignores user-scalable=no). Pinches on the 3D view still reach it,
// because it reads pointer events, which these do not block.
const noZoom = (e: Event) => e.preventDefault();
document.addEventListener('gesturestart', noZoom, { passive: false });
document.addEventListener('gesturechange', noZoom, { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1 && !(e.target as Element)?.closest?.('canvas')) e.preventDefault(); }, { passive: false });

/** Shows the error text instead of an empty page if anything throws while rendering. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page"><div className="wrap">
        <h1>發生錯誤</h1>
        <p className="note">{this.state.error.message}</p>
        <button onClick={() => location.reload()}>重新載入</button>
      </div></div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);

// installable as a desktop / home-screen app (the worker caches nothing, so updates still wait for the user's tap)
if ('serviceWorker' in navigator && !import.meta.env.DEV) addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
