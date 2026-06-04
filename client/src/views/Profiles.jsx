import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Profiles() {
  const [data, setData] = useState({ items: [], active: null });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    api.listProfiles().then(setData).catch(e => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function activate(name) {
    try { await api.activateProfile(name); load(); } catch (e) { setError(e.message); }
  }

  return (
    <>
      <h2>Profiles</h2>
      <p className="muted">Profiles bundle resolver thresholds and dashboard preferences for an institutional segment. The active profile influences the import resolver's auto-merge / review thresholds.</p>
      {error && <div className="panel error">{error}</div>}
      {loading ? <div className="muted">Loading…</div> : <>
      <div className="panel">
        <h3>Active</h3>
        {data.active ? (
          <div>
            <span className="tag action">{data.active.name}</span>
            <p className="muted" style={{ marginTop: 8 }}>{data.active.config?.description}</p>
          </div>
        ) : <span className="muted">no profile activated; resolver uses environment defaults</span>}
      </div>
      <div className="panel">
        <h3>Catalog</h3>
        <table>
          <thead><tr><th>Name</th><th>Description</th><th>Thresholds</th><th></th></tr></thead>
          <tbody>
            {data.items.map(p => (
              <tr key={p.code}>
                <td><code>{p.name}</code></td>
                <td className="muted">{p.config?.description}</td>
                <td>auto-merge {p.config?.thresholds?.autoMerge} · review {p.config?.thresholds?.review}</td>
                <td>{data.active?.name === p.name ? <span className="tag action">active</span> : <button onClick={() => activate(p.name)}>activate</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>}
    </>
  );
}
