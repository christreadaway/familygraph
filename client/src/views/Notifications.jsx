import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Notifications() {
  const [data, setData] = useState({ items: [], config: null });
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ status: '', kind: '' });
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    const params = {};
    if (filter.status) params.status = filter.status;
    if (filter.kind) params.kind = filter.kind;
    api.listNotifications(params).then(setData).catch(e => setError(e.message));
  }
  useEffect(load, [filter.status, filter.kind]);

  async function dispatch() { setBusy(true); try { await api.dispatchNotifications(); load(); } finally { setBusy(false); } }
  async function retry(code) { await api.retryNotification(code); load(); }
  async function cancel(code) { await api.cancelNotification(code); load(); }
  async function sendTest() {
    if (!testTo) return;
    try { const r = await api.testNotification(testTo); alert(`Test queued (${r.code}). Click "Run dispatch now" to send.`); load(); }
    catch (e) { setError(e.message); }
  }

  const cfg = data.config || {};
  const ready = cfg.enabled && cfg.transport === 'postmark' ? cfg.postmark?.token_configured && cfg.postmark?.from : true;

  return (
    <>
      <h2>Notifications</h2>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <h3>Configuration</h3>
        <dl className="kvp">
          <dt>Enabled</dt><dd>{cfg.enabled ? <span className="tag action">on</span> : <span className="tag warn">off</span>} <span className="muted">(toggle in Settings → notifications.enabled)</span></dd>
          <dt>Transport</dt><dd><code>{cfg.transport}</code></dd>
          <dt>Dashboard URL</dt><dd><code>{cfg.dashboardUrl}</code></dd>
          <dt>From address</dt><dd>{cfg.postmark?.from ? <code>{cfg.postmark.from}</code> : <span className="muted">(not set in Settings → postmark.from)</span>}</dd>
          <dt>Postmark token</dt><dd>{cfg.postmark?.token_configured ? <span className="tag action">configured</span> : <span className="tag warn">missing — set SANCTUS_POSTMARK_TOKEN env var</span>}</dd>
          <dt>Reminder lead-time</dt><dd>{cfg.reminderHours} hour(s) before expiry</dd>
        </dl>
        {!ready && cfg.enabled && cfg.transport === 'postmark' && (
          <div className="panel error" style={{ marginTop: 12, marginBottom: 0 }}>
            Postmark is selected but missing a server token (env var <code>SANCTUS_POSTMARK_TOKEN</code>) or a verified sender (<code>postmark.from</code>). Notifications will queue but not deliver until that's fixed.
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Send a test</h3>
        <form className="row" onSubmit={e => { e.preventDefault(); sendTest(); }}>
          <input placeholder="recipient@example.org" value={testTo} onChange={e => setTestTo(e.target.value)} style={{ flex: 1 }} />
          <button className="primary">Queue test</button>
          <button onClick={dispatch} disabled={busy}>Run dispatch now</button>
        </form>
      </div>

      <div className="panel">
        <h3>Filters</h3>
        <div className="row">
          <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
            <option value="">any status</option>
            <option value="pending">pending</option>
            <option value="sent">sent</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
          <select value={filter.kind} onChange={e => setFilter({ ...filter, kind: e.target.value })}>
            <option value="">any kind</option>
            <option value="assign">assign</option>
            <option value="reminder">reminder</option>
            <option value="expired">expired</option>
            <option value="test">test</option>
          </select>
        </div>
      </div>

      <div className="panel">
        <h3>{data.items.length} notifications</h3>
        <table>
          <thead>
            <tr><th>When</th><th>Kind</th><th>To</th><th>Subject</th><th>Status</th><th>Attempts</th><th>Last error</th><th></th></tr>
          </thead>
          <tbody>
            {data.items.map(n => (
              <tr key={n.code}>
                <td className="muted">{new Date(n.created_at).toLocaleString()}</td>
                <td><span className="tag">{n.kind}</span></td>
                <td><code>{n.to_email}</code></td>
                <td>{n.subject}</td>
                <td>
                  {n.status === 'sent' && <span className="tag action">sent</span>}
                  {n.status === 'pending' && <span className="tag warn">pending</span>}
                  {n.status === 'failed' && <span className="tag error">failed</span>}
                  {n.status === 'cancelled' && <span className="tag">cancelled</span>}
                  {n.sent_at && <div className="muted" style={{ fontSize: 11 }}>{new Date(n.sent_at).toLocaleString()}</div>}
                </td>
                <td>{n.attempts}</td>
                <td className="muted" style={{ fontSize: 11, maxWidth: 280, whiteSpace: 'pre-wrap' }}>{n.last_error || '—'}</td>
                <td>
                  {n.status === 'failed' && <button onClick={() => retry(n.code)}>retry</button>}
                  {n.status === 'pending' && <button className="danger" onClick={() => cancel(n.code)}>cancel</button>}
                </td>
              </tr>
            ))}
            {data.items.length === 0 && <tr><td colSpan={8} className="muted">No notifications.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
