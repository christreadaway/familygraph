import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const SCOPES = ['pii.read', 'pii.write', 'sanitize', 'audit.read', 'audit.write', 'import', 'rules.write', '*'];

export default function Keys() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState({ 'pii.read': true });
  const [issued, setIssued] = useState(null);

  function load() {
    api.listKeys().then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }
  useEffect(load, []);

  async function provision() {
    setError(null);
    setIssued(null);
    const scopes = Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
    try {
      const r = await api.provisionKey({ name, scopes });
      setIssued(r);
      setName('');
      setPicked({ 'pii.read': true });
      load();
    } catch (e) { setError(e.message); }
  }
  async function revoke(c) { if (confirm('Revoke this key? Apps using it will stop working.')) { await api.revokeKey(c); load(); } }

  return (
    <>
      <h2>Per-app API keys</h2>
      <p className="muted">Issue a scoped key per consuming app instead of sharing the master token. Tokens are shown exactly once at provisioning time.</p>
      {error && <div className="panel error">{error}</div>}
      {issued && (
        <div className="panel" style={{ borderColor: 'var(--accent-2)' }}>
          <h3>New key — copy it now</h3>
          <p>Code: <code>{issued.code}</code></p>
          <p>Scopes: {issued.scopes.join(', ')}</p>
          <textarea readOnly rows={2} style={{ width: '100%', fontFamily: 'var(--mono)' }} value={issued.token} />
          <p className="muted" style={{ marginTop: 8 }}>This is the only time the token will be visible. Store it in the consuming app's secret config.</p>
        </div>
      )}
      <div className="panel">
        <h3>Provision</h3>
        <div className="row">
          <input placeholder="App name (e.g., donor_app)" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
        </div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
          {SCOPES.map(s => (
            <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center', textTransform: 'none', letterSpacing: 0 }}>
              <input type="checkbox" checked={!!picked[s]} onChange={e => setPicked({ ...picked, [s]: e.target.checked })} />
              <code>{s}</code>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={!name} onClick={provision}>Provision key</button>
        </div>
      </div>
      <div className="panel">
        <h3>{items.length} keys</h3>
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Scopes</th><th>Last used</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {items.map(k => (
              <tr key={k.code}>
                <td><code>{k.code}</code></td>
                <td>{k.name}</td>
                <td>{k.scopes.map(s => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}</td>
                <td className="muted">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td>
                <td>{k.revoked ? <span className="tag error">revoked</span> : <span className="tag action">active</span>}</td>
                <td>{!k.revoked && <button className="danger" onClick={() => revoke(k.code)}>revoke</button>}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="muted">No keys yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
