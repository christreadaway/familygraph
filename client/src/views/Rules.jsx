import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const ACTIONS = ['auto_merge', 'never_merge', 'boost', 'penalize'];

export default function Rules() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [draft, setDraft] = useState({
    kind: 'person', action: 'never_merge', weight: 0.2,
    given_name: '', family_name: '', email_domain: '', postal: '',
  });

  function load() {
    api.listRules().then(d => setItems(d.items || [])).catch(e => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function create() {
    const match = {};
    if (draft.given_name) match.given_name = draft.given_name;
    if (draft.family_name) match.family_name = draft.family_name;
    if (draft.email_domain) match.email_domain = draft.email_domain;
    if (draft.postal) match.postal = draft.postal;
    const rule = { match, action: draft.action };
    if (draft.action === 'boost' || draft.action === 'penalize') rule.weight = Number(draft.weight);
    try {
      await api.createRule({ kind: draft.kind, rule });
      setDraft({ ...draft, given_name: '', family_name: '', email_domain: '', postal: '' });
      load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(c, enabled) { await api.updateRule(c, { enabled }); load(); }
  async function del(c) { await api.deleteRule(c); setConfirmingDelete(null); load(); }

  return (
    <>
      <h2>Resolution rules</h2>
      <p className="muted">Operator-curated overrides on top of the resolver's score. Rules describe pattern matches over normalized values; they never contain raw PII.</p>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <h3>New rule</h3>
        <div className="split">
          <div>
            <label>Entity kind</label>
            <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}>
              <option value="person">person</option>
              <option value="family">family</option>
            </select>
          </div>
          <div>
            <label>Action</label>
            <select value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })}>
              {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          {(draft.action === 'boost' || draft.action === 'penalize') && (
            <div>
              <label>Weight</label>
              <input type="number" step="0.05" min="0" max="1" value={draft.weight} onChange={e => setDraft({ ...draft, weight: e.target.value })} />
            </div>
          )}
          <div><label>given_name match</label><input value={draft.given_name} onChange={e => setDraft({ ...draft, given_name: e.target.value })} /></div>
          <div><label>family_name match</label><input value={draft.family_name} onChange={e => setDraft({ ...draft, family_name: e.target.value })} /></div>
          <div><label>email_domain match</label><input value={draft.email_domain} onChange={e => setDraft({ ...draft, email_domain: e.target.value })} placeholder="stmichaelparish.org" /></div>
          <div><label>postal match</label><input value={draft.postal} onChange={e => setDraft({ ...draft, postal: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={create}>Create rule</button>
        </div>
      </div>

      <div className="panel">
        <h3>{items.length} rules</h3>
        {loading ? <div className="muted">Loading…</div> : <table>
          <thead><tr><th>Code</th><th>Kind</th><th>Action</th><th>Match</th><th>Enabled</th><th></th></tr></thead>
          <tbody>
            {items.map(r => (
              <tr key={r.code}>
                <td><code>{r.code}</code></td>
                <td>{r.kind}</td>
                <td>
                  <span className="tag">{r.rule.action}</span>
                  {r.rule.weight != null && <span className="muted"> ±{r.rule.weight}</span>}
                </td>
                <td><pre className="mono" style={{ margin: 0, fontSize: 11 }}>{JSON.stringify(r.rule.match)}</pre></td>
                <td><input type="checkbox" checked={r.enabled} onChange={e => toggle(r.code, e.target.checked)} /></td>
                <td>{confirmingDelete === r.code ? (
                  <>
                    <span className="muted" style={{ fontSize: 'var(--t-small)' }}>Are you sure?</span>{' '}
                    <button className="danger" onClick={() => del(r.code)}>Confirm</button>
                    <button onClick={() => setConfirmingDelete(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="danger" onClick={() => setConfirmingDelete(r.code)}>delete</button>
                )}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="muted">No rules yet.</td></tr>}
          </tbody>
        </table>}
      </div>
    </>
  );
}
