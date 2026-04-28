import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const TTL_OPTIONS = [4, 12, 24, 48, 72];

function formatExpires(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = Date.now();
  const ms = d.getTime() - now;
  if (ms <= 0) return { label: 'expired', warn: true };
  const hours = ms / 3_600_000;
  if (hours < 1) return { label: `${Math.round(ms / 60_000)} min`, warn: true };
  if (hours < 4) return { label: `${hours.toFixed(1)} h`, warn: true };
  return { label: `${Math.round(hours)} h`, warn: false };
}

export default function Conflicts() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ status: 'open', assigned: '', assigned_to: '' });
  const [picked, setPicked] = useState({}); // code -> bool
  const [assignee, setAssignee] = useState('');
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);

  function load() {
    const params = { status: filter.status };
    if (filter.assigned) params.assigned = filter.assigned;
    if (filter.assigned_to) params.assigned_to = filter.assigned_to;
    api.listConflicts(params)
      .then(d => { setItems(d.items || []); setPicked({}); })
      .catch(e => setError(e.message));
  }
  useEffect(load, [filter.status, filter.assigned, filter.assigned_to]);

  const selected = useMemo(() => Object.entries(picked).filter(([, v]) => v).map(([k]) => k), [picked]);
  const allChecked = items.length > 0 && items.every(i => picked[i.code]);

  function toggleAll() {
    if (allChecked) setPicked({});
    else { const next = {}; for (const i of items) next[i.code] = true; setPicked(next); }
  }

  async function resolve(c, decision, winner) {
    await api.resolveConflict(c.code, { decision, winner_code: winner });
    load();
  }

  async function assignSelected() {
    setError(null); setBusy(true);
    try {
      const r = await api.assignConflicts({ codes: selected, assignee, ttl_hours: ttl });
      alert(`Assigned ${r.assigned} conflict(s) to ${r.assignee}; expires ${new Date(r.expires_at).toLocaleString()}`);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function assignAllOpen() {
    setError(null); setBusy(true);
    try {
      const r = await api.assignConflicts({ all_open: true, assignee, ttl_hours: ttl });
      alert(`Assigned ${r.assigned} open conflict(s) to ${r.assignee}; expires ${new Date(r.expires_at).toLocaleString()}`);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function unassign(c) {
    await api.unassignConflict(c.code);
    load();
  }

  return (
    <>
      <h2>Conflict queue</h2>
      {error && <div className="panel error">{error}</div>}

      <div className="panel">
        <h3>Filters</h3>
        <div className="row">
          <label style={{ margin: 0 }}>Status</label>
          <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
            <option value="open">open</option>
            <option value="merged">merged</option>
            <option value="rejected">rejected</option>
            <option value="dismissed">dismissed</option>
          </select>
          <label style={{ margin: 0 }}>Assignment</label>
          <select value={filter.assigned} onChange={e => setFilter({ ...filter, assigned: e.target.value })}>
            <option value="">any</option>
            <option value="unassigned">unassigned</option>
            <option value="assigned">assigned</option>
          </select>
          <input
            placeholder="filter by assignee email"
            value={filter.assigned_to}
            onChange={e => setFilter({ ...filter, assigned_to: e.target.value })}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {filter.status === 'open' && (
        <div className="panel">
          <h3>Assign to a colleague</h3>
          <p className="muted" style={{ marginTop: 0 }}>Park open conflicts on a colleague's email for review. The assignment auto-expires after the TTL you choose; expired assignments fall back into the unassigned pool.</p>
          <div className="row">
            <input placeholder="colleague@example.org" value={assignee} onChange={e => setAssignee(e.target.value)} style={{ flex: 1 }} />
            <label style={{ margin: 0 }}>Expires in</label>
            <select value={ttl} onChange={e => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map(h => <option key={h} value={h}>{h} hours</option>)}
            </select>
            <button onClick={assignSelected} disabled={!assignee || selected.length === 0 || busy}>
              Assign {selected.length} selected
            </button>
            <button className="primary" onClick={assignAllOpen} disabled={!assignee || busy}>
              Assign ALL open
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>{items.length} {filter.status}</h3>
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th>Code</th>
              <th>Kind</th>
              <th>Pair</th>
              <th>Score</th>
              <th>Assigned</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(c => {
              const exp = formatExpires(c.assignment_expires_at);
              return (
                <tr key={c.code}>
                  <td><input type="checkbox" checked={!!picked[c.code]} onChange={e => setPicked({ ...picked, [c.code]: e.target.checked })} /></td>
                  <td><code>{c.code}</code></td>
                  <td>{c.kind}</td>
                  <td>
                    <Link to={`/${c.kind === 'family' ? 'families' : 'people'}/${c.left_code}`}><code>{c.left_code}</code></Link><br />
                    <Link to={`/${c.kind === 'family' ? 'families' : 'people'}/${c.right_code}`}><code>{c.right_code}</code></Link>
                  </td>
                  <td>{Math.round(c.score * 100)}%</td>
                  <td>
                    {c.assigned_to
                      ? <><span className="tag">{c.assigned_to}</span>{c.status === 'open' && <button onClick={() => unassign(c)} style={{ marginLeft: 6 }}>clear</button>}</>
                      : <span className="muted">—</span>}
                  </td>
                  <td>{exp ? <span className={exp.warn ? 'tag warn' : 'tag'}>{exp.label}</span> : <span className="muted">—</span>}</td>
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
                      <span className="muted">{c.status} {c.resolved_at ? new Date(c.resolved_at).toLocaleString() : ''}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && <tr><td colSpan={8} className="muted">No conflicts.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
