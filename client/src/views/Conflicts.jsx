import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import IdCode from '../components/IdCode.jsx';
import Pill from '../components/Pill.jsx';

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
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: 'open', assigned: '', assigned_to: '' });
  const [picked, setPicked] = useState({});
  const [assignee, setAssignee] = useState('');
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  // Per-row staged note. Operators jot a one-line WHY ("father and son,
  // confirmed via parish records") before clicking merge / reject / dismiss.
  // The note persists into conflicts.resolution_notes.
  const [notes, setNotes] = useState({});
  const [pendingDecision, setPendingDecision] = useState({});

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  function load() {
    const params = { status: filter.status };
    if (filter.assigned) params.assigned = filter.assigned;
    if (filter.assigned_to) params.assigned_to = filter.assigned_to;
    api.listConflicts(params)
      .then(d => { setItems(d.items || []); setPicked({}); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, [filter.status, filter.assigned, filter.assigned_to]);

  const selected = useMemo(() => Object.entries(picked).filter(([, v]) => v).map(([k]) => k), [picked]);
  const allChecked = items.length > 0 && items.every(i => picked[i.code]);

  function toggleAll() {
    if (allChecked) setPicked({});
    else { const next = {}; for (const i of items) next[i.code] = true; setPicked(next); }
  }

  async function resolve(c, decision, winner) {
    const note = (notes[c.code] || '').trim() || null;
    try {
      await api.resolveConflict(c.code, { decision, winner_code: winner, notes: note });
      const nextNotes = { ...notes }; delete nextNotes[c.code]; setNotes(nextNotes);
      const nextPending = { ...pendingDecision }; delete nextPending[c.code]; setPendingDecision(nextPending);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function assignSelected() {
    setError(null); setBusy(true);
    try {
      const r = await api.assignConflicts({ codes: selected, assignee, ttl_hours: ttl });
      setStatus(`Assigned ${r.assigned} conflict(s) to ${r.assignee}; expires ${new Date(r.expires_at).toLocaleString()}`);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function assignAllOpen() {
    setError(null); setBusy(true);
    try {
      const r = await api.assignConflicts({ all_open: true, assignee, ttl_hours: ttl });
      setStatus(`Assigned ${r.assigned} open conflict(s) to ${r.assignee}; expires ${new Date(r.expires_at).toLocaleString()}`);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function unassign(c) {
    await api.unassignConflict(c.code);
    load();
  }

  async function scanForDuplicates() {
    setError(null); setBusy(true);
    try {
      const r = await api.scanDuplicates({});
      setStatus(
        `Scanned ${r.scanned} active person${r.scanned === 1 ? '' : 's'}. ` +
        `Surfaced ${r.matches_found} potential duplicate match${r.matches_found === 1 ? '' : 'es'}. ` +
        `${r.new_conflicts_opened} new conflict${r.new_conflicts_opened === 1 ? '' : 's'} opened. ` +
        `Total open: ${r.open_person_conflicts}.`
      );
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <h2>Conflict queue</h2>
      {status && <div className="panel" style={{background: 'var(--c-surface-alt)', marginBottom: 12}}>{status} <button onClick={() => setStatus(null)} style={{marginLeft: 8}}>✕</button></div>}
      {error && <div className="panel error">{error}</div>}

      <div className="panel">
        <h3>Scan for duplicates</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Walk every active person in the directory and compare them against the candidate pool.
          Anything scoring at or above the review threshold lands here as an open conflict that
          you can merge, reject (these are different people — divorce, similar names, etc.), or
          dismiss.
        </p>
        <button onClick={scanForDuplicates} disabled={busy}>
          {busy ? 'Scanning…' : 'Scan whole directory'}
        </button>
      </div>

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
          <p className="muted" style={{ marginTop: 0 }}>
            Park open conflicts on a colleague's email for review. The assignment auto-expires
            after the TTL you choose; expired assignments fall back into the unassigned pool.
          </p>
          <div className="row">
            <input
              placeholder="colleague@example.org"
              value={assignee}
              onChange={e => setAssignee(e.target.value)}
              style={{ flex: 1 }}
            />
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
        {loading ? <div className="muted">Loading…</div> : <table>
          <thead>
            <tr>
              <th><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th>Code</th>
              <th>Kind</th>
              <th>Pair</th>
              <th>Score</th>
              <th>Why</th>
              <th>Assigned</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(c => {
              const exp = formatExpires(c.assignment_expires_at);
              const linkBase = c.kind === 'family' ? 'families' : 'people';
              const note = notes[c.code] || '';
              const reasons = Array.isArray(c.reasons) ? c.reasons : [];
              return (
                <React.Fragment key={c.code}>
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!picked[c.code]}
                        onChange={e => setPicked({ ...picked, [c.code]: e.target.checked })}
                      />
                    </td>
                    <td><IdCode code={c.code} /></td>
                    <td><Pill state="muted">{c.kind}</Pill></td>
                    <td>
                      <div className="col" style={{ gap: 2 }}>
                        <Link to={`/${linkBase}/${c.left_code}`}>
                          <IdCode type={c.kind} code={c.left_code} />
                        </Link>
                        <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>↕ vs</span>
                        <Link to={`/${linkBase}/${c.right_code}`}>
                          <IdCode type={c.kind} code={c.right_code} />
                        </Link>
                      </div>
                    </td>
                    <td className="mono tnum">{Math.round(c.score * 100)}%</td>
                    <td style={{ maxWidth: 220 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {reasons.length === 0 && <span className="muted" style={{ fontSize: 12 }}>—</span>}
                        {reasons.map(r => (
                          <span key={r} className="tag" style={{ fontSize: 11 }}>{r}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {c.assigned_to ? (
                        <>
                          <Pill state="muted">{c.assigned_to}</Pill>
                          {c.status === 'open' && (
                            <button onClick={() => unassign(c)} style={{ marginLeft: 6 }}>clear</button>
                          )}
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>
                      {exp
                        ? <Pill state={exp.warn ? 'pii' : 'muted'}>{exp.label}</Pill>
                        : <span className="muted">—</span>}
                    </td>
                    <td>
                      {c.status === 'open' ? (
                        <div className="col" style={{ gap: 6 }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="primary" title="Merge left" onClick={() => resolve(c, 'merge', c.left_code)}>← left</button>
                            <button className="primary" title="Merge right" onClick={() => resolve(c, 'merge', c.right_code)}>→ right</button>
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            <button onClick={() => resolve(c, 'reject')}>reject</button>
                            <button onClick={() => resolve(c, 'dismiss')}>✕ dismiss</button>
                          </div>
                        </div>
                      ) : (
                        <span className="muted">{c.status} {c.resolved_at ? new Date(c.resolved_at).toLocaleString() : ''}</span>
                      )}
                    </td>
                  </tr>
                  {/* Notes row — operator note for an open conflict, or the
                      stored resolution_notes for a closed one. */}
                  <tr>
                    <td></td>
                    <td colSpan={8} style={{ paddingTop: 0, paddingBottom: 12 }}>
                      {c.status === 'open' ? (
                        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                          <label
                            className="muted"
                            style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', minWidth: 60, paddingTop: 6 }}
                          >
                            Note
                          </label>
                          <textarea
                            value={note}
                            onChange={e => setNotes({ ...notes, [c.code]: e.target.value })}
                            placeholder="Optional: why are you making this decision? (e.g., 'father and son, confirmed via parish records')"
                            rows={1}
                            style={{ flex: 1, fontSize: 13, resize: 'vertical', minHeight: 28 }}
                            maxLength={2000}
                          />
                          <span className="muted" style={{ fontSize: 11, paddingTop: 8 }}>
                            {note.length > 0 ? `${note.length}/2000` : ''}
                          </span>
                        </div>
                      ) : c.resolution_notes ? (
                        <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                          <label
                            className="muted"
                            style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', minWidth: 60 }}
                          >
                            Note
                          </label>
                          <span style={{ flex: 1, fontStyle: 'italic', color: 'var(--text-muted)' }}>
                            "{c.resolution_notes}"
                            {c.resolved_by && <span className="muted"> — {c.resolved_by}</span>}
                          </span>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
            {items.length === 0 && <tr><td colSpan={9} className="muted">No conflicts.</td></tr>}
          </tbody>
        </table>}
      </div>
    </>
  );
}
