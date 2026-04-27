import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Search() {
  const [q, setQ] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [out, setOut] = useState(null);
  const [error, setError] = useState(null);

  async function go(e) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.search({ q, email, phone });
      setOut(r);
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      <h2>Search</h2>
      <p className="muted">Exact normalized lookup. Names match by HMAC of normalized given_name OR family_name. Emails and phones match by normalized canonical form. Substring scan of encrypted PII is intentionally not supported.</p>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <form className="row" onSubmit={go}>
          <input placeholder="name (Smith, Mary, etc.)" value={q} onChange={e => setQ(e.target.value)} />
          <input placeholder="email@example.org" value={email} onChange={e => setEmail(e.target.value)} />
          <input placeholder="phone (any format)" value={phone} onChange={e => setPhone(e.target.value)} />
          <button className="primary">Search</button>
        </form>
      </div>
      {out && (
        <>
          <div className="panel">
            <h3>{out.persons?.length || 0} persons</h3>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th></th></tr></thead>
              <tbody>
                {(out.persons || []).map(p => (
                  <tr key={p.code}>
                    <td><code>{p.code}</code></td>
                    <td>{p.display_name || `${p.given_name || ''} ${p.family_name || ''}`}</td>
                    <td><Link to={`/people/${p.code}`}>open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>{out.families?.length || 0} families</h3>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th></th></tr></thead>
              <tbody>
                {(out.families || []).map(f => (
                  <tr key={f.code}>
                    <td><code>{f.code}</code></td>
                    <td>{f.display_name || <span className="muted">—</span>}</td>
                    <td><Link to={`/families/${f.code}`}>open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(out.emails?.length > 0 || out.phones?.length > 0) && (
            <div className="panel">
              <h3>Contacts</h3>
              <ul>
                {out.emails.map(e => <li key={e.code}><code>{e.code}</code> · {e.value}</li>)}
                {out.phones.map(p => <li key={p.code}><code>{p.code}</code> · {p.value}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}
