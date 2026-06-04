import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Ministries() {
  const [ministries, setMinistries] = useState([]);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newRequiresEim, setNewRequiresEim] = useState(false);
  const [expiring, setExpiring] = useState(null);
  const [confirmingArchive, setConfirmingArchive] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  function load() {
    api
      .listMinistries({ status: showArchived ? 'all' : 'active' })
      .then(d => setMinistries(d.items || []))
      .catch(e => setError(e.message));
    api.eimExpiring().then(setExpiring).catch(() => {});
  }
  useEffect(load, [showArchived]);

  async function create(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    await api.createMinistry({
      name: newName.trim(),
      description: newDesc.trim() || null,
      requires_eim: newRequiresEim,
    });
    setNewName('');
    setNewDesc('');
    setNewRequiresEim(false);
    load();
  }
  async function archive(ministryCode) {
    setConfirmingArchive(null);
    await api.archiveMinistry(ministryCode);
    load();
  }
  async function recompute() {
    const r = await api.eimRecompute();
    setStatus(`EIM recompute: ${r.changed} row(s) flipped to expired.`);
    load();
  }

  if (error) return <div className="panel error">Error: {error}</div>;

  return (
    <>
      <h2>Ministries &amp; volunteer rosters</h2>

      {status && (
        <div className="panel" style={{ background: 'rgba(76,175,80,.08)', borderColor: '#4caf50', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{status}</span>
          <button onClick={() => setStatus(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
        </div>
      )}

      <div className="panel">
        <h3>EIM expiring soon</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Ethics &amp; Integrity in Ministry certs that lapse inside the dashboard's window. Tune
          the window in Settings as <code>eim.expiring_soon_days</code> (default 60).
        </p>
        {expiring && expiring.items && expiring.items.length > 0 ? (
          <table>
            <thead>
              <tr><th>Person</th><th>Status</th><th>Completed</th><th>Expires</th></tr>
            </thead>
            <tbody>
              {expiring.items.map(it => (
                <tr key={it.code}>
                  <td><a href={`/people/${it.code}`}>{it.code}</a></td>
                  <td>{it.eim_status || ''}</td>
                  <td>{it.eim_completed_on || ''}</td>
                  <td>{it.eim_expires_on || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            No certs expiring inside the next {expiring?.window_days || 60} days.
          </p>
        )}
        <div style={{ marginTop: 8 }}>
          <button onClick={recompute}>Recompute statuses</button>
        </div>
      </div>

      <div className="panel">
        <h3>Add a ministry</h3>
        <form onSubmit={create}>
          <div className="split">
            <div>
              <label>Name</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g., Lectors" />
            </div>
            <div>
              <label>Description</label>
              <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="optional" />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input type="checkbox" checked={newRequiresEim} onChange={e => setNewRequiresEim(e.target.checked)} />
            Requires EIM certification
          </label>
          <div style={{ marginTop: 10 }}>
            <button className="primary">Create</button>
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Catalog</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
        {ministries.length === 0 ? (
          <p className="muted">No ministries yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>EIM</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ministries.map(m => (
                <tr key={m.code}>
                  <td><strong>{m.name}</strong></td>
                  <td>{m.description || ''}</td>
                  <td>{m.requires_eim ? 'required' : ''}</td>
                  <td>{m.status}</td>
                  <td>
                    {m.status === 'active' && (
                      confirmingArchive === m.code ? (
                        <span className="row" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
                          <span>Archive? Existing assignments kept, no new ones.</span>
                          <button className="danger" onClick={() => archive(m.code)}>Confirm</button>
                          <button onClick={() => setConfirmingArchive(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmingArchive(m.code)}>Archive</button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
