import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Families() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  function load() {
    api.listFamilies().then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }

  useEffect(load, []);

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
        <h3>Create a family</h3>
        <form className="row" onSubmit={create}>
          <input
            placeholder="Display name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <button className="primary" disabled={creating}>Create</button>
        </form>
      </div>
      <div className="panel">
        <h3>{items.length} active</h3>
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
                <td><code>{f.code}</code></td>
                <td>{f.display_name || <span className="muted">—</span>}</td>
                <td className="muted">{new Date(f.created_at).toLocaleString()}</td>
                <td><Link to={`/families/${f.code}`}>open</Link></td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={4} className="muted">No families yet. Import a roster or create one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
