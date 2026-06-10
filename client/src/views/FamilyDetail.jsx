import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useFG } from '../store.js';
import IdCode from '../components/IdCode.jsx';
import Pill from '../components/Pill.jsx';
import TagEditor from '../components/TagEditor.jsx';

// Compute current age from an ISO YYYY-MM-DD date-of-birth string. Returns
// null when the input isn't a date we can parse — keeps the UI from showing
// "NaN years" on placeholder values.
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const before = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (before) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

// Format a person's grade for display. During the school year (Aug 16 -
// May 14) we render "grade N" — that's the kid's current grade. During
// the summer gap (May 15 - Aug 15) the previous-year grade is ambiguous,
// so we render "completed N · rising N+1" which is what schools actually
// say between school years.
function formatGrade(rawGrade, now = new Date()) {
  if (rawGrade == null || rawGrade === '') return null;
  const g = String(rawGrade).trim();
  // Non-numeric grades (PreK, K, etc.) just pass through verbatim because
  // the +1 increment is meaningless.
  const n = Number(g);
  const isInSummer = (() => {
    const m = now.getMonth(); // 0-based
    const d = now.getDate();
    // May 15 .. Aug 15 inclusive
    if (m === 4 && d >= 15) return true;          // May 15-31
    if (m === 5 || m === 6) return true;           // June, July
    if (m === 7 && d <= 15) return true;           // Aug 1-15
    return false;
  })();
  if (!isInSummer) return `grade ${g}`;
  if (Number.isFinite(n)) return `completed ${n} · rising ${n + 1}`;
  return `completed ${g}`;
}

// "Mary, 8" / "Mary, 8 · grade 3" / "Mary" depending on what's filled in.
function memberSubtitle(person, now = new Date()) {
  if (!person) return null;
  const bits = [];
  const age = ageFromDob(person.date_of_birth);
  if (age != null) bits.push(`age ${age}`);
  else if (person.date_of_birth) bits.push(person.date_of_birth);
  const g = formatGrade(person.grade, now);
  if (g) bits.push(g);
  return bits.length ? bits.join(' · ') : null;
}

export default function FamilyDetail() {
  const { code } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null);
  const [newAddress, setNewAddress] = useState({ line1: '', city: '', region: '', postal: '' });
  const [mergeWinner, setMergeWinner] = useState('');
  const [splitPicks, setSplitPicks] = useState({});
  const [history, setHistory] = useState([]);
  const [rels, setRels] = useState([]);
  const [newRel, setNewRel] = useState({ to: '', kind: 'related_household', detail: '' });
  const [dncReason, setDncReason] = useState('');
  const [familyMinistries, setFamilyMinistries] = useState([]);
  const [ministryCatalog, setMinistryCatalog] = useState([]);
  const [newAssignmentMinistry, setNewAssignmentMinistry] = useState('');
  const [newAssignmentRole, setNewAssignmentRole] = useState('member');
  const [confirmingEndMember, setConfirmingEndMember] = useState(null);
  const [confirmingClearDnc, setConfirmingClearDnc] = useState(false);
  const [affiliations, setAffiliations] = useState([]);
  const [affiliationsError, setAffiliationsError] = useState(null);
  const [orgIndex, setOrgIndex] = useState({});

  const { view } = useFG();
  const pseudo = view === 'pseudonym';

  function load() {
    api.getFamily(code).then(d => {
      setData(d);
      setEdit({ display_name: d.family.display_name || '', notes: d.family.notes || '' });
    }).catch(e => setError(e.message));
    api.membershipHistoryFamily(code).then(d => setHistory(d.items || [])).catch(() => {});
    api.listRelationships(code).then(d => setRels(d.items || [])).catch(() => {});
    api.ministriesForFamily(code).then(d => setFamilyMinistries(d.items || [])).catch(() => {});
    api.listMinistries().then(d => setMinistryCatalog(d.items || [])).catch(() => {});
  }

  useEffect(load, [code]);

  useEffect(() => {
    setAffiliationsError(null);
    api.affiliationsForFamily(code, { status: 'all' })
      .then(d => setAffiliations(d.items || []))
      .catch(e => setAffiliationsError(e.message));
    api.listOrganizations({ status: 'all' })
      .then(d => {
        const idx = {};
        (d.items || []).forEach(o => { idx[o.code] = o; });
        setOrgIndex(idx);
      })
      .catch(() => {});
  }, [code]);

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
    setConfirmingEndMember(null);
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
      <h2>Family <IdCode type="family" code={fam.code} /></h2>
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
        <h3>Tags</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Tags slice the directory: school parents, parishioners, alumni households. Imports apply
          tags automatically based on category — toggle here for one-offs.
        </p>
        <TagEditor
          tags={fam.tags || []}
          onAdd={async next => { await api.setFamilyTags(code, next); load(); }}
          onRemove={async t => { await api.removeFamilyTag(code, t); load(); }}
        />
      </div>

      {(() => {
        // Aggregate do-not-contact state across the family. If at least one
        // member is flagged, the panel surfaces "applied to N of M". The
        // toggle bulk-applies (or clears) for every active member at once —
        // that's the school-side do-not-call workflow.
        const total = data.members.length;
        const flagged = data.members.filter(m => m.person && m.person.do_not_contact).length;
        const allFlagged = total > 0 && flagged === total;
        const someFlagged = flagged > 0 && !allFlagged;
        return (
          <div className="panel">
            <h3>
              Do-not-call list
              {flagged > 0 && (
                <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
                  · applied to {flagged} of {total} member{total === 1 ? '' : 's'}
                </span>
              )}
            </h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              Flag every active member of this household so outbound channels (mail merges, phone
              banks, parish-school mass-text) skip them. Each member's per-person flag and reason
              are written individually so callers that pull one person still see the audit
              attribution.
            </p>
            {someFlagged && (
              <div className="panel warn" style={{ marginTop: 0, marginBottom: 12, padding: '8px 12px', background: 'rgba(240,181,81,.08)', borderColor: 'var(--warn)' }}>
                Mixed state — {flagged} flagged, {total - flagged} not. Use one of the buttons below
                to bring the household into a single state, or open each member's profile to
                disagree on purpose.
              </div>
            )}
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="Reason (e.g., 'requested no phone solicitation')"
                value={dncReason}
                onChange={e => setDncReason(e.target.value)}
                style={{ flex: 1, minWidth: 240 }}
              />
              <button
                onClick={async () => {
                  await api.setFamilyDoNotContact(code, true, dncReason || null);
                  setDncReason('');
                  load();
                }}
                disabled={allFlagged && !someFlagged}
              >
                {allFlagged ? 'Already on the do-not-call list' : 'Add household to do-not-call list'}
              </button>
              {confirmingClearDnc ? (
                <span className="row" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
                  <span>Clear do-not-call from every member?</span>
                  <button className="danger" onClick={async () => {
                    setConfirmingClearDnc(false);
                    await api.setFamilyDoNotContact(code, false);
                    load();
                  }}>Confirm</button>
                  <button onClick={() => setConfirmingClearDnc(false)}>Cancel</button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmingClearDnc(true)}
                  disabled={flagged === 0}
                >
                  Clear from household
                </button>
              )}
            </div>
          </div>
        );
      })()}

      <div className="panel">
        <h3>
          Members ({data.members.length})
          {(() => {
            const kids = data.members.filter(m => m.role === 'child').length;
            const adults = data.members.filter(m => m.role === 'parent' || m.role === 'guardian' || m.role === 'spouse' || m.role === 'other_adult').length;
            const parts = [];
            if (adults) parts.push(`${adults} adult${adults === 1 ? '' : 's'}`);
            if (kids) parts.push(`${kids} kid${kids === 1 ? '' : 's'}`);
            return parts.length
              ? <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>· {parts.join(' · ')}</span>
              : null;
          })()}
        </h3>
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>DOB · age · grade</th>
              <th>Profile</th>
              <th>Custody</th>
              <th>Started</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.members.map(m => {
              const subtitle = memberSubtitle(m.person);
              return (
                <tr key={m.membership_code}>
                  <td>
                    <Link to={`/people/${m.person_code}`}><IdCode type="person" code={m.person_code} /></Link>
                    {!pseudo && m.person.display_name && <> · {m.person.display_name}</>}
                  </td>
                  <td>{m.role}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {pseudo
                      ? <span className="faint">[redacted]</span>
                      : (subtitle || <span className="muted">—</span>)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {m.person.do_not_contact && (
                        <Pill state="pii" title={!pseudo && m.person.do_not_contact_reason ? m.person.do_not_contact_reason : 'do not contact'}>
                          do not contact
                        </Pill>
                      )}
                      {m.person.not_living_together && (
                        <Pill state="muted" title="Not living together at family address">
                          separate residence
                        </Pill>
                      )}
                      {!pseudo && m.person.employer && (
                        <span className="tag" style={{ fontSize: 11 }}>
                          {m.person.title ? `${m.person.title} · ` : ''}{m.person.employer}
                        </span>
                      )}
                      {!m.person.do_not_contact && !m.person.not_living_together && !(m.person && m.person.employer) && (
                        <span className="muted" style={{ fontSize: 12 }}>—</span>
                      )}
                    </div>
                  </td>
                  <td>{m.custody || <span className="muted">—</span>}</td>
                  <td className="muted">{new Date(m.started_at).toLocaleString()}</td>
                  <td>
                    {confirmingEndMember === m.membership_code ? (
                      <span className="row" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
                        <span>End membership?</span>
                        <button className="danger" onClick={() => endMember(m.membership_code)}>Confirm</button>
                        <button onClick={() => setConfirmingEndMember(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="danger" onClick={() => setConfirmingEndMember(m.membership_code)}>end</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {data.members.length === 0 && <tr><td colSpan={7} className="muted">No active members.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>
          Contact channels
          <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
            · {data.contacts.emails.length} email{data.contacts.emails.length === 1 ? '' : 's'}
            · {data.contacts.phones.length} phone{data.contacts.phones.length === 1 ? '' : 's'}
          </span>
        </h3>
        <div className="split" style={{ alignItems: 'flex-start' }}>
          <div>
            <h4 style={{ margin: '4px 0' }}>Emails</h4>
            {data.contacts.emails.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>No emails attached.</span>
            )}
            <div className="col" style={{ gap: 4 }}>
              {data.contacts.emails.map(e => {
                const member = data.members.find(m => m.person_code === e.person_code);
                const memberName = member && member.person && member.person.display_name;
                return (
                  <div key={e.code + ':' + e.person_code} className="row" style={{ gap: 6, alignItems: 'center' }}>
                    {e.is_primary && <Pill state="loopback">primary</Pill>}
                    {e.is_verified && <Pill state="muted">verified</Pill>}
                    <span style={{ fontSize: 13 }}>
                      {pseudo ? <span className="faint mono">[redacted]</span> : (e.value || <span className="muted">—</span>)}
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      → <Link to={`/people/${e.person_code}`}><IdCode type="person" code={e.person_code} /></Link>
                      {!pseudo && memberName && ` · ${memberName}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <h4 style={{ margin: '4px 0' }}>Phones</h4>
            {data.contacts.phones.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>No phones attached.</span>
            )}
            <div className="col" style={{ gap: 4 }}>
              {data.contacts.phones.map(p => {
                const member = data.members.find(m => m.person_code === p.person_code);
                const memberName = member && member.person && member.person.display_name;
                return (
                  <div key={p.code + ':' + p.person_code} className="row" style={{ gap: 6, alignItems: 'center' }}>
                    {p.is_primary && <Pill state="loopback">primary</Pill>}
                    {p.kind && p.kind !== 'other' && <Pill state="muted">{p.kind}</Pill>}
                    <span style={{ fontSize: 13 }}>
                      {pseudo ? <span className="faint mono">[redacted]</span> : (p.value || <span className="muted">—</span>)}
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      → <Link to={`/people/${p.person_code}`}><IdCode type="person" code={p.person_code} /></Link>
                      {!pseudo && memberName && ` · ${memberName}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Addresses</h3>
        <div className="col">
          {data.contacts.addresses.map(a => (
            <div key={a.code} className="row">
              <Pill state={a.is_primary ? 'loopback' : 'muted'}>{a.label}{a.is_primary ? ' · primary' : ''}</Pill>
              <span>{pseudo
                ? <span className="faint mono">[address redacted in pseudonym view]</span>
                : ([a.line1, a.line2, a.city, a.region, a.postal].filter(Boolean).join(', ') || <span className="muted">[address unavailable]</span>)}</span>
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

      <div className="panel">
        <h3>Family-to-family relationships</h3>
        <p className="muted" style={{ marginTop: 0 }}>Used for divorced parents, joint custody across households, or related-household links between branches of the same family.</p>
        <table>
          <thead><tr><th>Other family</th><th>Kind</th><th>Detail</th><th></th></tr></thead>
          <tbody>
            {rels.map(r => (
              <tr key={r.code}>
                <td><Link to={`/families/${r.from_code === code ? r.to_code : r.from_code}`}><IdCode type="family" code={r.from_code === code ? r.to_code : r.from_code} /></Link></td>
                <td>{r.kind}</td>
                <td className="muted">{r.detail || '—'}</td>
                <td><button className="danger" onClick={async () => { await api.removeRelationship(r.code); load(); }}>remove</button></td>
              </tr>
            ))}
            {rels.length === 0 && <tr><td colSpan={4} className="muted">No related families.</td></tr>}
          </tbody>
        </table>
        <form className="row" style={{ marginTop: 12 }} onSubmit={async e => {
          e.preventDefault();
          if (!newRel.to) return;
          await api.addRelationship({ from: code, to: newRel.to, kind: newRel.kind, detail: newRel.detail || null });
          setNewRel({ to: '', kind: 'related_household', detail: '' });
          load();
        }}>
          <input placeholder="other family code (f_…)" value={newRel.to} onChange={e => setNewRel({ ...newRel, to: e.target.value })} />
          <select value={newRel.kind} onChange={e => setNewRel({ ...newRel, kind: e.target.value })}>
            <option>related_household</option>
            <option>custody_of</option>
            <option>guardian_of</option>
            <option>other</option>
          </select>
          <input placeholder="optional note" value={newRel.detail} onChange={e => setNewRel({ ...newRel, detail: e.target.value })} />
          <button>Link</button>
        </form>
      </div>

      <div className="panel">
        <h3>Volunteer ministries</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Whole-family rotations like Coffee &amp; Donuts or hospitality. Per-individual rosters
          (Lectors, Cantors) live on each person's detail page.
        </p>
        {familyMinistries.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No active family rotations.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {familyMinistries.map(a => {
              const m = ministryCatalog.find(x => x.code === a.ministry_code);
              return (
                <li key={a.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                  <span>
                    <strong>{m ? m.name : a.ministry_code}</strong>
                    <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>· {a.role}</span>
                  </span>
                  <button onClick={async () => { await api.endMinistryAssignment(a.code); load(); }}>End</button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={async e => {
            e.preventDefault();
            if (!newAssignmentMinistry) return;
            await api.assignMinistry(newAssignmentMinistry, { family_code: code, role: newAssignmentRole });
            setNewAssignmentMinistry('');
            setNewAssignmentRole('member');
            load();
          }}
        >
          <select value={newAssignmentMinistry} onChange={e => setNewAssignmentMinistry(e.target.value)} style={{ flex: 1 }}>
            <option value="">— pick a ministry —</option>
            {ministryCatalog.map(m => (
              <option key={m.code} value={m.code}>{m.name}</option>
            ))}
          </select>
          <select value={newAssignmentRole} onChange={e => setNewAssignmentRole(e.target.value)}>
            <option value="member">member</option>
            <option value="coordinator">coordinator</option>
            <option value="lead">lead</option>
          </select>
          <button>Add</button>
        </form>
      </div>

      <div className="panel">
        <h3>Membership history ({history.length})</h3>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Custody</th><th>Started</th><th>Ended</th><th>Reason</th></tr></thead>
          <tbody>
            {history.map(h => (
              <tr key={h.membership_code}>
                <td><Link to={`/people/${h.person_code}`}><IdCode type="person" code={h.person_code} /></Link>{!pseudo && h.person_display_name && <> · {h.person_display_name}</>}</td>
                <td>{h.role}</td>
                <td>{h.custody || <span className="muted">—</span>}</td>
                <td className="muted">{new Date(h.started_at).toLocaleString()}</td>
                <td className="muted">{h.ended_at ? new Date(h.ended_at).toLocaleString() : <Pill state="loopback">active</Pill>}</td>
                <td>{h.reason || <span className="muted">—</span>}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td colSpan={6} className="muted">No membership history.</td></tr>}
          </tbody>
        </table>
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
                      <td className="muted">{a.ended_at ? a.ended_at.slice(0, 10) : <Pill state="loopback">active</Pill>}</td>
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
                <IdCode type="person" code={m.person_code} />
                {!pseudo && m.person.display_name && <span className="muted">{m.person.display_name}</span>}
              </label>
            ))}
            <button>Split selected into new family</button>
          </form>
        </div>
      </div>
    </>
  );
}
