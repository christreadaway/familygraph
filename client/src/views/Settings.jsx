import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const KNOWN = [
  { key: 'institution_name', label: 'Institution name', placeholder: 'St. Theresa Catholic School' },
  { key: 'operator_name', label: 'Operator name', placeholder: 'Jane Doe' },
  { key: 'audit_retention_days', label: 'Audit retention (days, tier 1 only)', placeholder: '365', kind: 'number' },
  { key: 'dashboard_url', label: 'Dashboard URL (used in outgoing emails)', placeholder: 'https://family-graph.example.org' },
  { key: 'notifications.enabled', label: 'Notifications enabled (true/false)', placeholder: 'false', kind: 'bool' },
  { key: 'notifications.transport', label: 'Transport (postmark | log)', placeholder: 'postmark' },
  { key: 'notifications.reminder_hours', label: 'Reminder lead-time (hours before expiry)', placeholder: '1', kind: 'number' },
  { key: 'postmark.from', label: 'Postmark verified sender (From: address)', placeholder: 'no-reply@yourdomain.org' },
  { key: 'postmark.message_stream', label: 'Postmark message stream', placeholder: 'outbound' },
];

export default function Settings() {
  const [items, setItems] = useState([]);
  const [vals, setVals] = useState({});
  const [error, setError] = useState(null);

  function load() {
    api.listSettings().then(d => {
      setItems(d.items || []);
      const v = {};
      for (const it of d.items || []) v[it.key] = it.value;
      setVals(v);
    }).catch(e => setError(e.message));
  }
  useEffect(load, []);

  async function save(k) {
    let v = vals[k];
    const def = KNOWN.find(x => x.key === k);
    if (def?.kind === 'number') v = Number(v);
    if (def?.kind === 'bool') v = String(v).toLowerCase() === 'true';
    await api.putSetting(k, v);
    load();
  }
  async function clear(k) {
    await api.deleteSetting(k);
    setVals({ ...vals, [k]: '' });
    load();
  }

  return (
    <>
      <h2>Settings</h2>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        {KNOWN.map(def => (
          <div key={def.key} style={{ marginBottom: 12 }}>
            <label>{def.label}</label>
            <div className="row">
              <input
                style={{ flex: 1 }}
                placeholder={def.placeholder}
                value={vals[def.key] ?? ''}
                onChange={e => setVals({ ...vals, [def.key]: e.target.value })}
              />
              <button className="primary" onClick={() => save(def.key)}>Save</button>
              <button onClick={() => clear(def.key)}>Clear</button>
            </div>
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>Stored settings</h3>
        <table>
          <thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
          <tbody>
            {items.map(it => (
              <tr key={it.key}>
                <td><code>{it.key}</code></td>
                <td><pre className="mono" style={{ margin: 0 }}>{JSON.stringify(it.value)}</pre></td>
                <td className="muted">{new Date(it.updated_at).toLocaleString()}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={3} className="muted">No settings stored.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
