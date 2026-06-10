import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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
  const [ministryAssignments, setMinistryAssignments] = useState([]);
  const [ministryCatalog, setMinistryCatalog] = useState([]);
  const [newAssignmentMinistry, setNewAssignmentMinistry] = useState('');
  const [newAssignmentRole, setNewAssignmentRole] = useState('member');
  const [affiliations, setAffiliations] = useState([]);
  const [affiliationsError, setAffiliationsError] = useState(null);
  const [orgIndex, setOrgIndex] = useState({});

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
          eim_status: d.person.eim_status || '',
          eim_completed_on: d.person.eim_completed_on || '',
          eim_expires_on: d.person.eim_expires_on || '',
          eim_notes: d.person.eim_notes || '',
        });
      })
      .catch(e => setError(e.message));
    api.ministriesForPerson(code).then(d => setMinistryAssignments(d.items || [])).catch(() => {});
    api.listMinistries().then(d => setMinistryCatalog(d.items || [])).catch(() => {});
  }
  useEffect(load, [code]);

  useEffect(() => {
    setAffiliationsError(null);
    api
      .affiliationsForPerson(code, { status: 'all' })
      .then(d => setAffiliations(d.items || []))
      .catch(e => setAffiliationsError(e.message));
    api
      .listOrganizations({ status: 'all' })
      .then(d => {
        const idx = {};
        (d.items || []).forEach(o => { idx[o.code] = o; });
        setOrgIndex(idx);
      })
      .catch(() => {});
  }, [code]);

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
  async function addMinistryAssignment(e) {
    e.preventDefault();
    if (!newAssignmentMinistry) return;
    await api.assignMinistry(newAssignmentMinistry, { person_code: code, role: newAssignmentRole });
    setNewAssignmentMinistry('');
    setNewAssignmentRole('member');
    load();
  }
  async function endMinistryAssignment(assignmentCode) {
    await api.endMinistryAssignment(assignmentCode);
    load();
  }
  function ministryName(mc) {
    const found = ministryCatalog.find(m => m.code === mc);
    return found ? found.name : mc;
  }
  function eimBadge() {
    const s = person.eim_status;
    if (!s) return <span className="muted" style={{ fontSize: 12 }}>not on file</span>;
    const colorMap = { certified: '#1f7a1f', pending: '#a07000', expired: '#a01010' };
    return (
      <span style={{ background: colorMap[s] || '#555', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
        {s.toUpperCase()}
      </span>
    );
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
        <h3>EIM (Ethics & Integrity in Ministry) {eimBadge()}</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
          Catholic safe-environment cert, required for adults serving on most ministries. Set the
          completion date and the dashboard auto-fills the expiration using the diocesan renewal
          interval (default 3 years; configurable in Settings as <code>eim.renewal_years</code>).
        </p>
        <div className="split">
          <div>
            <label>Status</label>
            <select
              value={form.eim_status}
              onChange={e => setForm({ ...form, eim_status: e.target.value })}
            >
              <option value="">— not on file —</option>
              <option value="pending">pending</option>
              <option value="certified">certified</option>
              <option value="expired">expired</option>
            </select>
          </div>
          <div>
            <label>Completed on</label>
            <input
              value={form.eim_completed_on}
              onChange={e => setForm({ ...form, eim_completed_on: e.target.value })}
              placeholder="YYYY-MM-DD"
            />
          </div>
          <div>
            <label>Expires on</label>
            <input
              value={form.eim_expires_on}
              onChange={e => setForm({ ...form, eim_expires_on: e.target.value })}
              placeholder="YYYY-MM-DD (auto-filled)"
            />
          </div>
          <div>
            <label>Notes</label>
            <input
              value={form.eim_notes}
              onChange={e => setForm({ ...form, eim_notes: e.target.value })}
              placeholder="e.g., diocese, vendor, waiver"
            />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={save}>Save EIM</button>
        </div>
      </div>

      <div className="panel">
        <h3>Ministries</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
          Volunteer or staff rosters this person is currently on. Whole-family rosters
          (e.g., Coffee &amp; Donuts) live on the family detail page instead.
        </p>
        {ministryAssignments.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>Not on any active rosters.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {ministryAssignments.map(a => (
              <li key={a.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                <span>
                  <strong>{ministryName(a.ministry_code)}</strong>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>· {a.role}</span>
                </span>
                <button onClick={() => endMinistryAssignment(a.code)}>End</button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addMinistryAssignment} className="row" style={{ marginTop: 10 }}>
          <select
            value={newAssignmentMinistry}
            onChange={e => setNewAssignmentMinistry(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">— pick a ministry —</option>
            {ministryCatalog.map(m => (
              <option key={m.code} value={m.code}>
                {m.name}{m.requires_eim ? ' (EIM required)' : ''}
              </option>
            ))}
          </select>
          <select
            value={newAssignmentRole}
            onChange={e => setNewAssignmentRole(e.target.value)}
          >
            <option value="member">member</option>
            <option value="coordinator">coordinator</option>
            <option value="lead">lead</option>
          </select>
          <button>Add</button>
        </form>
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
        <h3>Communities</h3>
        {affiliationsError ? (
          <p className="muted" style={{ fontSize: 13 }}>Could not load affiliations: {affiliationsError}</p>
        ) : affiliations.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No parish or school affiliations recorded.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Organization</th><th>Role</th><th>Started</th><th>Ended</th><th>Reason</th><th>Last verified</th></tr>
            </thead>
            <tbody>
              {affiliations
                .slice()
                .sort((a, b) => {
                  const activeDiff = (a.ended_at ? 1 : 0) - (b.ended_at ? 1 : 0);
                  if (activeDiff !== 0) return activeDiff;
                  return (b.started_at || '').localeCompare(a.started_at || '');
                })
                .map(a => {
                  const org = orgIndex[a.org_code];
                  return (
                    <tr key={a.code}>
                      <td>
                        <Link to={`/organizations/${a.org_code}`}>{org ? org.name : a.org_code}</Link>
                        {org && org.kind && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>({org.kind})</span>}
                      </td>
                      <td>{a.role || <span className="muted">—</span>}</td>
                      <td className="muted">{a.started_at ? a.started_at.slice(0, 10) : '—'}</td>
                      <td className="muted">
                        {a.ended_at
                          ? a.ended_at.slice(0, 10)
                          : <span style={{ background: 'rgba(31,122,31,.12)', color: '#1f7a1f', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>active</span>}
                      </td>
                      <td>
                        {a.reason || <span className="muted">—</span>}
                        {a.reason_detail && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{a.reason_detail}</span>}
                      </td>
                      <td className="muted">{a.last_verified_at ? a.last_verified_at.slice(0, 10) : '—'}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
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
