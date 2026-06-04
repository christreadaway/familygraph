import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFG } from '../store.js';
import IdCode from '../components/IdCode.jsx';
import Pill from '../components/Pill.jsx';

export default function Search() {
  const { view } = useFG();
  const pseudo = view === 'pseudonym';
  const [q, setQ] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [out, setOut] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function go(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await api.search({ q, email, phone });
      setOut(r);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  return (
    <>
      <h2>Search</h2>
      <p className="muted">
        Exact normalized lookup. Names match by HMAC of normalized given_name OR family_name.
        Emails and phones match by normalized canonical form. Substring scan of encrypted PII is
        intentionally not supported.
      </p>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <form className="row" onSubmit={go}>
          <input placeholder="name (Smith, Mary, etc.)" value={q} onChange={e => setQ(e.target.value)} />
          <input placeholder="email@example.org" value={email} onChange={e => setEmail(e.target.value)} />
          <input placeholder="phone (any format)" value={phone} onChange={e => setPhone(e.target.value)} />
          <button className="primary">Search</button>
        </form>
      </div>
      {loading && <div className="muted">Loading…</div>}
      {out && !loading && (
        <>
          <div className="panel">
            <h3>{out.persons?.length || 0} persons</h3>
            <table>
              <thead><tr><th>Code</th><th>Name</th><th></th></tr></thead>
              <tbody>
                {(out.persons || []).map(p => (
                  <tr key={p.code}>
                    <td><IdCode type="person" code={p.code} /></td>
                    <td>
                      {pseudo
                        ? <span className="faint mono">[pseudonym surface]</span>
                        : (p.display_name || `${p.given_name || ''} ${p.family_name || ''}`)}
                    </td>
                    <td><Link to={`/people/${p.code}`}>open →</Link></td>
                  </tr>
                ))}
                {(!out.persons || out.persons.length === 0) && (
                  <tr><td colSpan={3} className="muted">No persons matched.</td></tr>
                )}
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
                    <td><IdCode type="family" code={f.code} /></td>
                    <td>
                      {pseudo
                        ? <span className="faint mono">[pseudonym surface]</span>
                        : (f.display_name || <span className="muted">—</span>)}
                    </td>
                    <td><Link to={`/families/${f.code}`}>open →</Link></td>
                  </tr>
                ))}
                {(!out.families || out.families.length === 0) && (
                  <tr><td colSpan={3} className="muted">No families matched.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {(out.emails?.length > 0 || out.phones?.length > 0) && (
            <div className="panel">
              <h3>Contacts</h3>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                {(out.emails || []).map(e => (
                  <li key={e.code} className="row" style={{ gap: 8, padding: '4px 0' }}>
                    <IdCode type="email" code={e.code} />
                    <span className="mono">{e.value}</span>
                    {e.kind && <Pill state="muted">{e.kind}</Pill>}
                  </li>
                ))}
                {(out.phones || []).map(p => (
                  <li key={p.code} className="row" style={{ gap: 8, padding: '4px 0' }}>
                    <IdCode type="phone" code={p.code} />
                    <span className="mono">{p.value}</span>
                    {p.kind && <Pill state="muted">{p.kind}</Pill>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}
