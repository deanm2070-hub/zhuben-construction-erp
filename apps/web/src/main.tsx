import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

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
