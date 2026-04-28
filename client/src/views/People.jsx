import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFG } from '../store.js';
import IdCode from '../components/IdCode.jsx';

export default function People() {
  const { view } = useFG();
  const pseudo = view === 'pseudonym';
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ given_name: '', family_name: '', date_of_birth: '' });

  function load() {
    api.listPeople({ safe: pseudo })
      .then(d => setItems(d.items || []))
      .catch(e => setError(e.message));
  }
  useEffect(load, [pseudo]);

  async function create(e) {
    e.preventDefault();
    if (!form.given_name && !form.family_name) return;
    await api.createPerson(form);
    setForm({ given_name: '', family_name: '', date_of_birth: '' });
    load();
  }

  return (
    <>
      <h2>People</h2>
      {error && <div className="panel error">Error: {error}</div>}
      <div className="panel">
        <h3>Create a person</h3>
        <form className="row" onSubmit={create}>
          <input placeholder="First name" value={form.given_name} onChange={e => setForm({ ...form, given_name: e.target.value })} />
          <input placeholder="Last name" value={form.family_name} onChange={e => setForm({ ...form, family_name: e.target.value })} />
          <input placeholder="DOB (optional)" value={form.date_of_birth} onChange={e => setForm({ ...form, date_of_birth: e.target.value })} />
          <button className="primary">Create</button>
        </form>
      </div>
      <div className="panel">
        <h3>{items.length} active{pseudo ? ' · pseudonym surface' : ''}</h3>
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {items.map(p => (
              <tr key={p.code}>
                <td><IdCode type="person" code={p.code} /></td>
                <td>
                  {pseudo
                    ? <span className="faint mono">[pseudonym surface]</span>
                    : (p.display_name || <span className="muted">—</span>)}
                </td>
                <td className="muted mono">{new Date(p.created_at).toLocaleString()}</td>
                <td><Link to={`/people/${p.code}`}>open →</Link></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="muted">No people yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
