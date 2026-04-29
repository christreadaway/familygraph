import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import IdCode from '../components/IdCode.jsx';
import TagEditor from '../components/TagEditor.jsx';

export default function PersonDetail() {
  const { code } = useParams();
  const nav = useNavigate();
  const [person, setPerson] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [mergeWinner, setMergeWinner] = useState('');

  function load() {
    api
      .getPerson(code)
      .then(d => { setPerson(d.person); setForm({ given_name: d.person.given_name || '', family_name: d.person.family_name || '', date_of_birth: d.person.date_of_birth || '', notes: d.person.notes || '' }); })
      .catch(e => setError(e.message));
  }
  useEffect(load, [code]);

  if (error) return <div className="panel error">Error: {error}</div>;
  if (!person) return <div className="muted">Loading…</div>;

  async function save() {
    await api.updatePerson(code, form);
    load();
  }
  async function addEmail(e) {
    e.preventDefault();
    if (!newEmail) return;
    await api.addEmail(code, { email: newEmail });
    setNewEmail('');
    load();
  }
  async function addPhone(e) {
    e.preventDefault();
    if (!newPhone) return;
    await api.addPhone(code, { phone: newPhone });
    setNewPhone('');
    load();
  }
  async function doMerge(e) {
    e.preventDefault();
    if (!mergeWinner) return;
    await api.mergePerson(code, mergeWinner);
    nav(`/people/${mergeWinner}`);
  }

  return (
    <>
      <h2>Person <IdCode type="person" code={person.code} /></h2>
      <div className="panel">
        <h3>Edit</h3>
        <div className="split">
          <div><label>First name</label><input value={form.given_name} onChange={e => setForm({ ...form, given_name: e.target.value })} /></div>
          <div><label>Last name</label><input value={form.family_name} onChange={e => setForm({ ...form, family_name: e.target.value })} /></div>
          <div><label>Date of birth</label><input value={form.date_of_birth} onChange={e => setForm({ ...form, date_of_birth: e.target.value })} /></div>
          <div><label>Notes</label><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 12 }}><button className="primary" onClick={save}>Save</button></div>
      </div>

      <div className="panel">
        <h3>Tags{person.grade ? ` · grade ${person.grade}` : ''}</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Tags slice the directory: parishioners, students, alumni-incoming. Imports apply tags
          automatically based on category — toggle here for one-offs.
        </p>
        <TagEditor
          tags={person.tags || []}
          onAdd={async next => { await api.setPersonTags(code, next); load(); }}
          onRemove={async t => { await api.removePersonTag(code, t); load(); }}
        />
      </div>

      <div className="split">
        <div className="panel">
          <h3>Emails</h3>
          <form onSubmit={addEmail} className="row">
            <input placeholder="email@example.org" value={newEmail} onChange={e => setNewEmail(e.target.value)} style={{ flex: 1 }} />
            <button>Add</button>
          </form>
        </div>
        <div className="panel">
          <h3>Phones</h3>
          <form onSubmit={addPhone} className="row">
            <input placeholder="+1 555 123 4567" value={newPhone} onChange={e => setNewPhone(e.target.value)} style={{ flex: 1 }} />
            <button>Add</button>
          </form>
        </div>
      </div>

      <div className="panel">
        <h3>Merge into another person</h3>
        <form onSubmit={doMerge} className="row">
          <input placeholder="winner code (p_…)" value={mergeWinner} onChange={e => setMergeWinner(e.target.value)} style={{ flex: 1 }} />
          <button className="danger">Merge this person into the other</button>
        </form>
      </div>
    </>
  );
}
