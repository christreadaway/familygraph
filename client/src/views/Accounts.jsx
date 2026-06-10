import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const GRANTABLE_SCOPES = ['pii.read', 'pii.write', 'sanitize', 'audit.read', 'audit.write', 'import', 'rules.write', 'integration'];

function ScopeChecks({ picked, onChange }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      {GRANTABLE_SCOPES.map(s => (
        <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center', textTransform: 'none', letterSpacing: 0 }}>
          <input type="checkbox" checked={!!picked[s]} onChange={e => onChange({ ...picked, [s]: e.target.checked })} />
          <code>{s}</code>
        </label>
      ))}
    </div>
  );
}

export default function Accounts() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [invitePicked, setInvitePicked] = useState({ 'pii.read': true });
  const [inviteError, setInviteError] = useState(null);
  const [editing, setEditing] = useState(null); // account code being edited
  const [editPicked, setEditPicked] = useState({});
  const [confirmingDisable, setConfirmingDisable] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  function load() {
    api.listAccounts()
      .then(d => { setItems(d.items || []); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  function pickedToScopes(picked) {
    return Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
  }

  async function invite(e) {
    e.preventDefault();
    setInviteError(null);
    try {
      await api.inviteAccount({
        email: inviteEmail.trim(),
        display_name: inviteName.trim(),
        scopes: pickedToScopes(invitePicked),
      });
      setStatus(`Invited ${inviteEmail.trim()}`);
      setInviteEmail('');
      setInviteName('');
      setInvitePicked({ 'pii.read': true });
      load();
    } catch (err) { setInviteError(err.message); }
  }

  function startEdit(a) {
    const picked = {};
    (a.scopes || []).forEach(s => { picked[s] = true; });
    setEditPicked(picked);
    setEditing(a.code);
  }
  async function saveScopes(code) {
    try {
      await api.updateAccount(code, { scopes: pickedToScopes(editPicked) });
      setEditing(null);
      setStatus('Scopes updated');
      load();
    } catch (err) { setError(err.message); }
  }
  async function disable(code) {
    setConfirmingDisable(null);
    try {
      await api.disableAccount(code);
      setStatus('Account disabled');
      load();
    } catch (err) { setError(err.message); }
  }
  async function reEnable(code) {
    try {
      await api.updateAccount(code, { status: 'active' });
      setStatus('Account re-enabled');
      load();
    } catch (err) { setError(err.message); }
  }

  if (error) {
    return (
      <>
        <h2>Staff accounts</h2>
        <div className="panel error">
          <p style={{ margin: 0 }}>{error}</p>
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
            Account management requires the master token. If you are signed in with a staff
            session, paste the master token to manage staff accounts.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h2>Staff accounts</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Invited accounts only — the email's domain must match a verified organization domain
        (manage domains under Parishes &amp; schools). Login is a passwordless emailed link.
      </p>

      {status && (
        <div className="panel" style={{ background: 'rgba(76,175,80,.08)', borderColor: '#4caf50', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{status}</span>
          <button onClick={() => setStatus(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
        </div>
      )}

      <div className="panel">
        <h3>Invite a staff member</h3>
        <form onSubmit={invite}>
          <div className="split">
            <div>
              <label>Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="[staff@example.org]"
              />
            </div>
            <div>
              <label>Display name</label>
              <input
                value={inviteName}
                onChange={e => setInviteName(e.target.value)}
                placeholder="e.g., Front office"
              />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label>Scopes</label>
            <ScopeChecks picked={invitePicked} onChange={setInvitePicked} />
          </div>
          {inviteError && <p className="muted" style={{ color: 'var(--danger, #e53935)', fontSize: 13 }}>{inviteError}</p>}
          <div style={{ marginTop: 10 }}>
            <button className="primary" disabled={!inviteEmail.trim()}>Invite</button>
          </div>
        </form>
      </div>

      <div className="panel">
        <h3>{items.length} account{items.length === 1 ? '' : 's'}</h3>
        {loading ? <div className="muted">Loading…</div> : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Last login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(a => (
                <tr key={a.code}>
                  <td>{a.email}</td>
                  <td>{a.display_name}</td>
                  <td>{(a.scopes || []).join(', ')}</td>
                  <td>{a.status}</td>
                  <td className="muted">{a.last_login_at ? new Date(a.last_login_at).toLocaleString() : 'never'}</td>
                  <td>
                    {a.status === 'active' ? (
                      editing === a.code ? (
                        <div style={{ fontSize: 12 }}>
                          <ScopeChecks picked={editPicked} onChange={setEditPicked} />
                          <div className="row" style={{ gap: 4, marginTop: 6 }}>
                            <button className="primary" onClick={() => saveScopes(a.code)}>Save</button>
                            <button onClick={() => setEditing(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : confirmingDisable === a.code ? (
                        <span className="row" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
                          <span>Disabling revokes their sessions immediately.</span>
                          <button className="danger" onClick={() => disable(a.code)}>Confirm</button>
                          <button onClick={() => setConfirmingDisable(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          <button onClick={() => startEdit(a)}>Edit scopes</button>{' '}
                          <button className="danger" onClick={() => setConfirmingDisable(a.code)}>Disable</button>
                        </>
                      )
                    ) : (
                      <button onClick={() => reEnable(a.code)}>Re-enable</button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="muted">No staff accounts yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
