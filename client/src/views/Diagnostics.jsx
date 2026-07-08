import React, { useEffect, useState } from 'react';
import { log, formatLine } from '../log.js';

// Operator-facing surface for the client log buffer. The point of the whole
// pipeline: when something misbehaves in the dashboard, come here, hit
// Download (or Copy), and paste the lines into a debugging session. Entries
// are redacted before they ever reach the buffer, so the file is safe to share.

export default function Diagnostics() {
  const [entries, setEntries] = useState(log.entries());
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    const int = setInterval(() => setEntries(log.entries()), 2000);
    return () => clearInterval(int);
  }, []);

  const counts = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const e of entries) counts[e.level] = (counts[e.level] || 0) + 1;
  const recent = entries.slice(-100);

  async function handleCopy() {
    const ok = await log.copy();
    setCopied(ok ? 'Copied to clipboard.' : 'Copy failed — use Download instead.');
    setTimeout(() => setCopied(null), 3000);
  }

  return (
    <>
      <h2>Diagnostics</h2>
      <div className="panel">
        <p className="muted" style={{ fontSize: 'var(--t-small)', marginTop: 0 }}>
          The dashboard keeps a rolling client-side log (API calls, errors,
          crashes — capped at 1,000 entries, redacted before buffering, never
          sent anywhere). When something misbehaves, download or copy it and
          paste the tail into a Claude Code session alongside the matching
          <code> server.log</code> lines.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 'var(--t-small)' }}>
            {entries.length} entries · {counts.error} error · {counts.warn} warn · {counts.info} info
          </span>
          <span style={{ flex: 1 }} />
          <button className="primary" onClick={() => log.download()}>Download log</button>
          <button onClick={handleCopy}>Copy log</button>
          <button onClick={() => { log.clear(); setEntries(log.entries()); }}>Clear</button>
        </div>
        {copied && (
          <div className="muted" style={{ marginTop: 8, fontSize: 'var(--t-small)' }}>{copied}</div>
        )}
      </div>
      <div className="panel">
        <h3>Most recent {recent.length} entries</h3>
        {recent.length === 0 ? (
          <p className="muted">Nothing logged yet in this session.</p>
        ) : (
          <pre
            className="mono"
            style={{
              margin: 0,
              maxHeight: 420,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontSize: 'var(--t-small)',
            }}
          >
            {recent.map(formatLine).join('\n')}
          </pre>
        )}
      </div>
    </>
  );
}
