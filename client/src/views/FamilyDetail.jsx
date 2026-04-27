import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function FamilyDetail() {
  const { code } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null);
  const [newAddress, setNewAddress] = useState({ line1: '', city: '', region: '', postal: '' });
  const [mergeWinner, setMergeWinner] = useState('');
  const [splitPicks, setSplitPicks] = useState({});

  function load() {
    api.getFamily(code).then(d => { setData(d); setEdit({ display_name: d.family.display_name || '', notes: d.family.notes || '' }); }).catch(e => setError(e.message));
  }

  useEffect(load, [code]);

  if (error) return <div className="panel error">Error: {error}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const fam = data.family;

  async function save() {
    await api.updateFamily(code, edit);
    load();
  }
  async function addAddr(e) {
    e.preventDefault();
    if (!newAddress.line1 && !newAddress.city) return;
    await api.addAddress(code, { address: newAddress, label: 'home', is_primary: true });
    setNewAddress({ line1: '', city: '', region: '', postal: '' });
    load();
  }
  async function endMember(membership) {
    if (!confirm('End this membership?')) return;
    await api.endMembership(code, membership, { reason: 'edit' });
    load();
  }
  async function doMerge(e) {
    e.preventDefault();
    if (!mergeWinner) return;
    await api.mergeFamily(code, mergeWinner);
    nav(`/families/${mergeWinner}`);
  }
  async function doSplit(e) {
    e.preventDefault();
    const persons = Object.entries(splitPicks).filter(([, v]) => v).map(([k]) => k);
    if (persons.length === 0) return;
    const res = await api.splitFamily(code, { person_codes: persons });
    nav(`/families/${res.code}`);
  }

  return (
    <>
      <h2>Family <code>{fam.code}</code></h2>
      <div className="panel">
        <h3>Edit</h3>
        <div className="col" style={{ gap: 12 }}>
          <div>
            <label>Display name</label>
            <input value={edit.display_name} onChange={e => setEdit({ ...edit, display_name: e.target.value })} />
          </div>
          <div>
            <label>Notes</label>
            <textarea rows={3} value={edit.notes || ''} onChange={e => setEdit({ ...edit, notes: e.target.value })} />
          </div>
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <span className="muted">Created {new Date(fam.created_at).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Members ({data.members.length})</h3>
        <table>
          <thead>
            <tr><th>Person</th><th>Role</th><th>Custody</th><th>Started</th><th></th></tr>
          </thead>
          <tbody>
            {data.members.map(m => (
              <tr key={m.membership_code}>
                <td>
                  <Link to={`/people/${m.person_code}`}><code>{m.person_code}</code></Link>
                  {m.person.display_name && <> · {m.person.display_name}</>}
                </td>
                <td>{m.role}</td>
                <td>{m.custody || <span className="muted">—</span>}</td>
                <td className="muted">{new Date(m.started_at).toLocaleString()}</td>
                <td><button className="danger" onClick={() => endMember(m.membership_code)}>end</button></td>
              </tr>
            ))}
            {data.members.length === 0 && <tr><td colSpan={5} className="muted">No active members.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>Addresses</h3>
        <div className="col">
          {data.contacts.addresses.map(a => (
            <div key={a.code} className="row">
              <span className="tag">{a.label}{a.is_primary ? ' · primary' : ''}</span>
              <span>{[a.line1, a.line2, a.city, a.region, a.postal].filter(Boolean).join(', ') || <span className="muted">[address unavailable]</span>}</span>
            </div>
          ))}
        </div>
        <form className="row" onSubmit={addAddr} style={{ marginTop: 12 }}>
          <input placeholder="Line 1" value={newAddress.line1} onChange={e => setNewAddress({ ...newAddress, line1: e.target.value })} />
          <input placeholder="City" value={newAddress.city} onChange={e => setNewAddress({ ...newAddress, city: e.target.value })} />
          <input placeholder="State" value={newAddress.region} onChange={e => setNewAddress({ ...newAddress, region: e.target.value })} style={{ width: 80 }} />
          <input placeholder="Postal" value={newAddress.postal} onChange={e => setNewAddress({ ...newAddress, postal: e.target.value })} style={{ width: 100 }} />
          <button>Add</button>
        </form>
      </div>

      <div className="split">
        <div className="panel">
          <h3>Merge into another family</h3>
          <form onSubmit={doMerge} className="col">
            <input placeholder="winner family code (f_…)" value={mergeWinner} onChange={e => setMergeWinner(e.target.value)} />
            <button className="danger">Merge this family into the other</button>
            <span className="muted" style={{ fontSize: 12 }}>This family becomes a permanent alias.</span>
          </form>
        </div>
        <div className="panel">
          <h3>Split off into a new family</h3>
          <form onSubmit={doSplit} className="col">
            {data.members.map(m => (
              <label key={m.membership_code} style={{ display: 'flex', gap: 8, alignItems: 'center', textTransform: 'none', letterSpacing: 0 }}>
                <input
                  type="checkbox"
                  checked={!!splitPicks[m.person_code]}
                  onChange={e => setSplitPicks({ ...splitPicks, [m.person_code]: e.target.checked })}
                />
                <code>{m.person_code}</code>
                {m.person.display_name && <span className="muted">{m.person.display_name}</span>}
              </label>
            ))}
            <button>Split selected into new family</button>
          </form>
        </div>
      </div>
    </>
  );
}
