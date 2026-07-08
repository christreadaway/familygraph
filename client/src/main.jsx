import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { log } from './log.js';
import './styles/tokens.css';
import './styles/shared.css';
import './styles/app.css';

document.documentElement.setAttribute('data-theme', 'institutional');

// Capture window.onerror + unhandledrejection into the client log buffer
// before anything else runs, so even a crash during first render is caught.
log.install();

// Last-resort React error boundary. A render crash used to white-screen the
// dashboard with nothing to paste into a debugging session; now the operator
// gets the error message and a Download log button (the buffer already holds
// the redacted trail that led up to the crash).
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    log.error('react', 'render crash', {
      message: error && error.message,
      stack: error && error.stack,
      componentStack: info && info.componentStack,
    });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 640, margin: '80px auto', padding: '0 24px' }}>
        <div className="panel error">
          <h2 style={{ marginTop: 0 }}>The dashboard hit an unexpected error.</h2>
          <p>
            Your data is untouched — this is a display crash. The client log
            below has a redacted trace of what led here; download it and paste
            it into a debugging session.
          </p>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String((this.state.error && this.state.error.message) || this.state.error)}
          </pre>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="primary" onClick={() => log.download()}>
              Download log
            </button>
            <button onClick={() => log.copy()}>Copy log</button>
            <button onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
