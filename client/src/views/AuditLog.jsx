import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import IdCode from '../components/IdCode.jsx';
import Pill from '../components/Pill.jsx';

// Map an action string to a posture state. Per handoff §3.3:
//   external_export → consented (PII left the machine)
//   read_pii        → pii (real names visible)
//   sanitize        → pseudonym (AI-safe)
//   bulk_import / boot / system → muted
function actionState(action = '') {
  if (action.includes('external_export')) return 'consented';
  if (action.includes('read_pii')) return 'pii';
  if (action.includes('sanitize') || action.includes('desanitize')) return 'pseudonym';
  if (action.includes('encrypt') || action.includes('decrypt')) return 'encrypted';
  if (action.includes('boot') || action.includes('login') || action.includes('health')) return 'loopback';
  return 'muted';
}

export default function AuditLog() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ action: '', actor: '' });

  function load() {
    const params = {};
    if (filter.action) params.action = filter.action;
    if (filter.actor) params.actor = filter.actor;
    api.audit(params).then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }
  useEffect(load, [filter.action, filter.actor]);

  return (
    <>
      <h2>Audit log</h2>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <div className="row">
          <input placeholder="action filter" value={filter.action} onChange={e => setFilter({ ...filter, action: e.target.value })} />
          <input placeholder="actor filter" value={filter.actor} onChange={e => setFilter({ ...filter, actor: e.target.value })} />
        </div>
      </div>
      <div className="panel">
        <h3>{items.length} events</h3>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Tier</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>Destination</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {items.map(e => (
              <tr key={e.code}>
                <td className="muted mono tnum">{new Date(e.created_at).toLocaleString()}</td>
                <td>
                  {e.tier === 2
                    ? <Pill state="consented">tier-2</Pill>
                    : <Pill state="muted">tier-1</Pill>}
                </td>
                <td><Pill state={actionState(e.action)}>{e.action}</Pill></td>
                <td className="mono">{e.actor}</td>
                <td>{e.entity_code ? <IdCode code={e.entity_code} /> : <span className="muted">—</span>}</td>
                <td className="mono">{e.destination || <span className="muted">—</span>}</td>
                <td>
                  <pre className="mono faint" style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                    {e.metadata ? JSON.stringify(e.metadata) : '—'}
                  </pre>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7} className="muted">No events.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
