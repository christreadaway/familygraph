import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFG } from '../store.js';
import IdCode from '../components/IdCode.jsx';

export default function Families() {
  const { view } = useFG();
  const pseudo = view === 'pseudonym';
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  function load() {
    api.listFamilies({ safe: pseudo })
      .then(d => setItems(d.items || []))
      .catch(e => setError(e.message));
  }

  useEffect(load, [pseudo]);

  async function create(e) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.createFamily({ display_name: name || null });
      setName('');
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <h2>Families</h2>
      {error && <div className="panel error">Error: {error}</div>}
      <div className="panel">
        <h3>{items.length} active{pseudo ? ' · pseudonym surface' : ''}</h3>
        {items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No families yet. <Link to="/import">Import a roster</Link> to populate the directory,
            or add one manually below.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Display name</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(f => (
                <tr key={f.code}>
                  <td><IdCode type="family" code={f.code} /></td>
                  <td>
                    {pseudo
                      ? <span className="faint mono">[pseudonym surface]</span>
                      : (f.display_name || <span className="muted">—</span>)}
                  </td>
                  <td className="muted mono">{new Date(f.created_at).toLocaleString()}</td>
                  <td><Link to={`/families/${f.code}`}>open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <details>
          <summary><strong>Add a single family manually</strong></summary>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Most directories are built by <Link to="/import">importing a roster</Link>. Use this only
            for one-offs.
          </p>
          <form className="row" onSubmit={create}>
            <input
              placeholder="Display name (optional)"
              value={name}
              onChange={e => setName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={creating}>Create</button>
          </form>
        </details>
      </div>
    </>
  );
}
