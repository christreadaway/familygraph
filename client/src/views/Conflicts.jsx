import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Conflicts() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('open');

  function load() {
    api.listConflicts(filter).then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }
  useEffect(load, [filter]);

  async function resolve(c, decision, winner) {
    await api.resolveConflict(c.code, { decision, winner_code: winner });
    load();
  }

  return (
    <>
      <h2>Conflict queue</h2>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <div className="row">
          <label style={{ margin: 0 }}>Status</label>
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="open">open</option>
            <option value="merged">merged</option>
            <option value="rejected">rejected</option>
            <option value="dismissed">dismissed</option>
          </select>
        </div>
      </div>
      <div className="panel">
        <h3>{items.length} {filter}</h3>
        <table>
          <thead>
            <tr><th>Code</th><th>Kind</th><th>Pair</th><th>Score</th><th>Reasons</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {items.map(c => (
              <tr key={c.code}>
                <td><code>{c.code}</code></td>
                <td>{c.kind}</td>
                <td>
                  <Link to={`/${c.kind === 'family' ? 'families' : 'people'}/${c.left_code}`}><code>{c.left_code}</code></Link>
                  <br />
                  <Link to={`/${c.kind === 'family' ? 'families' : 'people'}/${c.right_code}`}><code>{c.right_code}</code></Link>
                </td>
                <td>{Math.round(c.score * 100)}%</td>
                <td>{c.reasons.map(r => <span key={r} className="tag">{r}</span>)}</td>
                <td>
                  {c.status === 'open' ? (
                    <div className="col">
                      <div className="row">
                        <button className="primary" onClick={() => resolve(c, 'merge', c.left_code)}>merge → left</button>
                        <button className="primary" onClick={() => resolve(c, 'merge', c.right_code)}>merge → right</button>
                      </div>
                      <div className="row">
                        <button onClick={() => resolve(c, 'reject')}>reject (different)</button>
                        <button onClick={() => resolve(c, 'dismiss')}>dismiss</button>
                      </div>
                    </div>
                  ) : (
                    <span className="muted">{c.status} {c.resolved_at}</span>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="muted">No conflicts.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
