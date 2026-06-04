import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFG } from '../store.js';
import IdCode from '../components/IdCode.jsx';
import Pill from '../components/Pill.jsx';

export default function Families() {
  const { view } = useFG();
  const pseudo = view === 'pseudonym';
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState({});
  const [loading, setLoading] = useState(true);
  const [flagging, setFlagging] = useState(null);   // famCode being flagged
  const [flagReason, setFlagReason] = useState('');

  function load() {
    // Always pull the PII surface here so the do-not-call quick-flag can
    // filter by last name. The view-toggle still gates rendering — we just
    // read the data either way. Pass the search string through to the
    // server so surname matching uses the indexed family_name_hash rather
    // than client-side string matching on display_name (which many
    // families don't have).
    const q = filter.trim();
    api.listFamilies({ safe: false, q: q || undefined })
      .then(d => setItems(d.items || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  // Re-fetch on pseudonym toggle AND when the operator finishes typing a
  // query (debounced by the input's onChange flow + a short timer).
  useEffect(() => {
    const t = setTimeout(load, filter ? 200 : 0);
    return () => clearTimeout(t);
  }, [pseudo, filter]);

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

  function startFlag(famCode) {
    setFlagging(famCode);
    setFlagReason('');
  }
  function cancelFlag() {
    setFlagging(null);
    setFlagReason('');
  }
  async function confirmFlag(famCode) {
    setBusy(b => ({ ...b, [famCode]: true }));
    try {
      const reason = flagReason.trim() || null;
      await api.setFamilyDoNotContact(famCode, true, reason);
      setFlagging(null);
      setFlagReason('');
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(b => { const n = { ...b }; delete n[famCode]; return n; });
    }
  }
  async function quickClear(famCode) {
    setBusy(b => ({ ...b, [famCode]: true }));
    try {
      await api.setFamilyDoNotContact(famCode, false, null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(b => { const n = { ...b }; delete n[famCode]; return n; });
    }
  }

  // Server filters via family_name_hash when ?q is set, so items[] is
  // already the right list. We do not double-filter on the client — a
  // family whose display_name is null would otherwise vanish even though
  // the surname hash matched.

  return (
    <>
      <h2>Families</h2>
      {error && <div className="panel error">Error: {error}</div>}

      <div className="panel">
        <h3>{items.length}{pseudo ? ' · pseudonym surface' : ''}</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            placeholder={pseudo ? 'Search by code (f_…)' : 'Search by family name (e.g., "Smith")'}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ flex: 1 }}
            data-testid="families-search"
            aria-label="Search families"
          />
          {filter && <button onClick={() => setFilter('')}>Clear</button>}
        </div>

        {loading ? (
          <div className="muted">Loading…</div>
        ) : items.length === 0 ? (
          filter ? (
            <p className="muted" style={{ margin: 0 }}>
              No families match &quot;{filter}&quot;. Try a shorter prefix or clear the search.
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No families yet. <Link to="/import">Import a roster</Link> to populate the directory,
              or add one manually below.
            </p>
          )
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Display name</th>
                <th>Tags</th>
                <th>Created</th>
                <th>Quick action</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(f => {
                const onDnc = !!f.do_not_contact_any;
                return (
                  <tr key={f.code}>
                    <td><IdCode type="family" code={f.code} /></td>
                    <td>
                      {pseudo
                        ? <span className="faint mono">[pseudonym surface]</span>
                        : (f.display_name || <span className="muted">—</span>)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(f.tags || []).map(t => <Pill key={t} state="muted">{t}</Pill>)}
                        {onDnc && <Pill state="pii">do-not-call</Pill>}
                      </div>
                    </td>
                    <td className="muted mono">{new Date(f.created_at).toLocaleString()}</td>
                    <td>
                      {onDnc ? (
                        <button
                          onClick={() => quickClear(f.code)}
                          disabled={busy[f.code]}
                          title="Clear do-not-call from every member"
                        >
                          Clear
                        </button>
                      ) : flagging === f.code ? (
                        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                          <input
                            placeholder='Reason (optional)'
                            value={flagReason}
                            onChange={e => setFlagReason(e.target.value)}
                            style={{ flex: 1, minWidth: 140 }}
                            autoFocus
                          />
                          <button
                            className="primary"
                            onClick={() => confirmFlag(f.code)}
                            disabled={busy[f.code]}
                          >
                            Confirm
                          </button>
                          <button onClick={cancelFlag}>Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startFlag(f.code)}
                          disabled={busy[f.code]}
                          title="Add household to do-not-call list (flags every member)"
                        >
                          Add to do-not-call
                        </button>
                      )}
                    </td>
                    <td><Link to={`/families/${f.code}`}>open →</Link></td>
                  </tr>
                );
              })}
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
