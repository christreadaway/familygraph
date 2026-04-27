import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

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
        <table>
          <thead>
            <tr><th>When</th><th>Tier</th><th>Action</th><th>Actor</th><th>Entity</th><th>Destination</th><th>Metadata</th></tr>
          </thead>
          <tbody>
            {items.map(e => (
              <tr key={e.code}>
                <td className="muted">{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.tier === 2 ? <span className="tag warn">tier 2</span> : <span className="tag">tier 1</span>}</td>
                <td>{e.action}</td>
                <td>{e.actor}</td>
                <td>{e.entity_code ? <code>{e.entity_code}</code> : <span className="muted">—</span>}</td>
                <td>{e.destination || <span className="muted">—</span>}</td>
                <td><pre className="mono" style={{ margin: 0, fontSize: 11 }}>{e.metadata ? JSON.stringify(e.metadata) : '—'}</pre></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7} className="muted">No events.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
