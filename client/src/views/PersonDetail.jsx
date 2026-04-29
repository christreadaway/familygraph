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
      .then(d => {
        setPerson(d.person);
        setForm({
          given_name: d.person.given_name || '',
          family_name: d.person.family_name || '',
          date_of_birth: d.person.date_of_birth || '',
          notes: d.person.notes || '',
          employer: d.person.employer || '',
          title: d.person.title || '',
          do_not_contact: !!d.person.do_not_contact,
          do_not_contact_reason: d.person.do_not_contact_reason || '',
          not_living_together: !!d.person.not_living_together,
        });
      })
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
          <div><label>Date of birth</label><input value={form.date_of_birth} onChange={e => setForm({ ...form, date_of_birth: e.target.value })} placeholder="YYYY-MM-DD" /></div>
          <div><label>Notes</label><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
        </div>

        <h4 style={{ marginTop: 18, marginBottom: 8 }}>Profile</h4>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
          Employer / title power donor research and parish directory listings. Do-not-contact and
          not-living-together drive how outbound channels (email, mail merges) address this person.
        </p>
        <div className="split">
          <div>
            <label>Employer</label>
            <input value={form.employer} onChange={e => setForm({ ...form, employer: e.target.value })} placeholder="e.g., St. Joseph Hospital" />
          </div>
          <div>
            <label>Title / role</label>
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g., Director of Development" />
          </div>
        </div>
        <div className="split" style={{ marginTop: 12 }}>
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={form.do_not_contact}
                onChange={e => setForm({ ...form, do_not_contact: e.target.checked })}
              />
              Do not contact
            </label>
            {form.do_not_contact && (
              <input
                value={form.do_not_contact_reason}
                onChange={e => setForm({ ...form, do_not_contact_reason: e.target.value })}
                placeholder="Reason (e.g., 'unsubscribed Q1 2026')"
                style={{ marginTop: 6 }}
              />
            )}
          </div>
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={form.not_living_together}
                onChange={e => setForm({ ...form, not_living_together: e.target.checked })}
              />
              Not living together at family address
            </label>
            <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
              Suppresses "Mom and Dad"-style joint salutations on shared-address mail when parents
              are separated.
            </p>
          </div>
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
