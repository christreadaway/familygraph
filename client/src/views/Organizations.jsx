import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';

const VERIFY_METHODS = [
  'registration', 'sacrament', 'liturgy', 'ministry', 'giving',
  'communication', 'attestation', 'other',
];
const TRANSITION_ROLES = ['alumni', 'parishioner', 'registered', 'staff', 'volunteer', 'member', 'other'];
const TRANSITION_REASONS = ['graduated', 'transferred', 'moved', 'withdrew', 'inactive', 'other'];
const END_REASONS = ['graduated', 'transferred', 'moved', 'deceased', 'withdrew', 'inactive', 'other'];
const AFFILIATE_ROLES = ['member', 'registered', 'parishioner', 'student', 'alumni', 'staff', 'volunteer', 'clergy', 'other'];

// Dates may arrive as epoch ms or as a (possibly approximate) date string.
function fmtDate(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number' || /^\d{12,}$/.test(String(v))) {
    return new Date(Number(v)).toLocaleDateString();
  }
  return String(v);
}

function whoCell(a) {
  if (a.person_code) return <Link to={`/people/${a.person_code}`}>{a.person_code}</Link>;
  if (a.family_code) return <Link to={`/families/${a.family_code}`}>{a.family_code}</Link>;
  return <span className="muted">—</span>;
}

export function OrganizationsList() {
  const [orgs, setOrgs] = useState([]);
  const [error, setError] = useState(null);
  const [createError, setCreateError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('parish');

  function load() {
    api
      .listOrganizations({ status: showArchived ? 'all' : 'active' })
      .then(d => setOrgs(d.items || []))
      .catch(e => setError(e.message));
  }
  useEffect(load, [showArchived]);

  async function create(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreateError(null);
    try {
      await api.createOrganization({ name: newName.trim(), kind: newKind });
      setNewName('');
      setNewKind('parish');
      load();
    } catch (err) {
      setCreateError(err.message);
    }
  }

  function domainCell(o) {
    if (!('domain' in o) && !('domain_verified_at' in o)) return '—';
    if (!o.domain) return '—';
    return (
      <>
        {o.domain}{' '}
        {o.domain_verified_at
          ? <span style={{ color: '#4caf50' }}>✓ verified</span>
          : <span className="muted">unverified</span>}
      </>
    );
  }

  if (error) return <div className="panel error">Error: {error}</div>;

  return (
    <>
      <h2>Parishes &amp; schools</h2>

      <div className="panel">
        <h3>Add an organization</h3>
        <form onSubmit={create}>
          <div className="split">
            <div>
              <label>Name</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g., [Parish Name]" />
            </div>
            <div>
              <label>Kind</label>
              <select value={newKind} onChange={e => setNewKind(e.target.value)}>
                <option value="parish">parish</option>
                <option value="school">school</option>
                <option value="other">other</option>
              </select>
            </div>
          </div>
          {createError && (
            <div style={{ color: '#e25555', marginTop: 8, fontSize: 13 }}>{createError}</div>
          )}
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
        {orgs.length === 0 ? (
          <p className="muted">No organizations yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Domain</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orgs.map(o => (
                <tr key={o.code}>
                  <td><strong>{o.name}</strong></td>
                  <td>{o.kind}</td>
                  <td>{domainCell(o)}</td>
                  <td>{o.status}</td>
                  <td><Link to={`/organizations/${o.code}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function OrganizationDetail() {
  const { code } = useParams();
  const [org, setOrg] = useState(null);
  const [affiliations, setAffiliations] = useState([]);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  // Domain panel state.
  const [domainInput, setDomainInput] = useState('');
  const [domainError, setDomainError] = useState(null);
  const [domainSetResult, setDomainSetResult] = useState(null);
  const [domainVerifyResult, setDomainVerifyResult] = useState(null);
  const [confirmingClearDomain, setConfirmingClearDomain] = useState(false);

  // Roster inline forms: { affCode, kind: 'verify' | 'transition' | 'end' }.
  const [openForm, setOpenForm] = useState(null);
  const [form, setForm] = useState({});

  // Add affiliation panel.
  const [affTarget, setAffTarget] = useState('person');
  const [affCode, setAffCode] = useState('');
  const [affRole, setAffRole] = useState('member');
  const [affError, setAffError] = useState(null);

  // Stale report panel.
  const [staleDays, setStaleDays] = useState(365);
  const [stale, setStale] = useState(null);
  const [staleError, setStaleError] = useState(null);

  // Verification trail.
  const [trailFor, setTrailFor] = useState(null);
  const [trail, setTrail] = useState(null);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  function load() {
    return api
      .getOrganization(code)
      .then(d => {
        setOrg(d.organization);
        setAffiliations(d.affiliations || []);
      })
      .catch(e => setError(e.message));
  }
  useEffect(() => {
    setOrg(null);
    setAffiliations([]);
    setStale(null);
    setTrailFor(null);
    setTrail(null);
    setOpenForm(null);
    load();
  }, [code]);

  async function setDomain(value) {
    setDomainError(null);
    setDomainSetResult(null);
    setDomainVerifyResult(null);
    try {
      const r = await api.setOrganizationDomain(code, value);
      setDomainSetResult(value ? r : null);
      setDomainInput('');
      setConfirmingClearDomain(false);
      setStatus(value ? `Domain set to ${value}. Complete verification below.` : 'Domain cleared.');
      await load();
    } catch (e) {
      setDomainError(e.message);
      setConfirmingClearDomain(false);
    }
  }

  async function verifyDomain(method) {
    setDomainError(null);
    setDomainVerifyResult(null);
    try {
      const r = await api.verifyOrganizationDomain(code, method);
      setDomainVerifyResult({ method, ...r });
      await load();
    } catch (e) {
      setDomainError(e.message);
    }
  }

  function openInlineForm(aff, kind) {
    setOpenForm({ affCode: aff.code, kind });
    if (kind === 'verify') {
      setForm({ method: 'registration', period: '', source: '' });
    } else if (kind === 'transition') {
      setForm({ to_role: 'alumni', reason: 'graduated', reason_detail: '', ended_at: '' });
    } else {
      setForm({ reason: 'graduated', reason_detail: '', ended_at: '' });
    }
  }

  async function submitInline(e) {
    e.preventDefault();
    if (!openForm) return;
    const { affCode: ac, kind } = openForm;
    try {
      if (kind === 'verify') {
        const body = { method: form.method };
        if (form.period.trim()) body.period = form.period.trim();
        if (form.source.trim()) body.source = form.source.trim();
        await api.verifyAffiliation(ac, body);
        setStatus('Affiliation verified.');
      } else if (kind === 'transition') {
        const body = { to_role: form.to_role, reason: form.reason };
        if (form.reason_detail.trim()) body.reason_detail = form.reason_detail.trim();
        if (form.ended_at.trim()) body.ended_at = form.ended_at.trim();
        await api.transitionAffiliation(ac, body);
        setStatus(`Transitioned to ${form.to_role}.`);
      } else {
        const body = { reason: form.reason };
        if (form.reason_detail.trim()) body.reason_detail = form.reason_detail.trim();
        if (form.ended_at.trim()) body.ended_at = form.ended_at.trim();
        await api.endAffiliation(ac, body);
        setStatus('Affiliation ended.');
      }
      setOpenForm(null);
      await load();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  async function addAffiliation(e) {
    e.preventDefault();
    if (!affCode.trim()) return;
    setAffError(null);
    try {
      const body = { role: affRole };
      if (affTarget === 'person') body.person_code = affCode.trim();
      else body.family_code = affCode.trim();
      await api.affiliate(code, body);
      setAffCode('');
      setStatus('Affiliation added.');
      await load();
    } catch (err) {
      setAffError(err.message);
    }
  }

  async function runStale() {
    setStaleError(null);
    try {
      const r = await api.staleAffiliations(code, staleDays);
      setStale(r);
    } catch (e) {
      setStaleError(e.message);
    }
  }

  async function loadTrail(ac) {
    if (trailFor === ac) {
      setTrailFor(null);
      setTrail(null);
      return;
    }
    try {
      const r = await api.affiliationVerifications(ac);
      setTrailFor(ac);
      setTrail(r);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }
  }

  if (error) return <div className="panel error">Error: {error}</div>;
  if (!org) return <div className="muted">Loading organization…</div>;

  const inlineFormFor = aff =>
    openForm && openForm.affCode === aff.code ? openForm.kind : null;

  return (
    <>
      <h2>{org.name} <span className="muted" style={{ fontWeight: 'normal', fontSize: 16 }}>({org.kind})</span></h2>
      <p className="muted">
        <Link to="/organizations">← Back to parishes &amp; schools</Link>
      </p>
      {org.status !== 'active' && (
        <p className="muted">This organization is archived. Existing affiliations are kept; no new activity expected.</p>
      )}

      {status && (
        <div className="panel" style={{ background: 'rgba(76,175,80,.08)', borderColor: '#4caf50', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{status}</span>
          <button onClick={() => setStatus(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
        </div>
      )}

      <div className="panel">
        <h3>Domain</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Master token only. Prove control of the org's domain via a DNS TXT record or a well-known file.
        </p>
        <p>
          Current domain:{' '}
          {org.domain ? (
            <>
              <strong>{org.domain}</strong>{' '}
              {org.domain_verified_at
                ? <span style={{ color: '#4caf50' }}>✓ verified</span>
                : <span className="muted">unverified</span>}
            </>
          ) : (
            <span className="muted">none</span>
          )}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            placeholder="example.org"
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={() => domainInput.trim() && setDomain(domainInput.trim())}>
            Set domain
          </button>
          {org.domain && (
            confirmingClearDomain ? (
              <span className="row" style={{ gap: 4, alignItems: 'center', fontSize: 12 }}>
                <span>Clear the domain and its verification?</span>
                <button className="danger" onClick={() => setDomain(null)}>Confirm</button>
                <button onClick={() => setConfirmingClearDomain(false)}>Cancel</button>
              </span>
            ) : (
              <button onClick={() => setConfirmingClearDomain(true)}>Clear domain</button>
            )
          )}
        </div>
        {domainError && (
          <div style={{ color: '#e25555', marginTop: 8, fontSize: 13 }}>{domainError}</div>
        )}
        {domainSetResult && (
          <div style={{ marginTop: 10 }}>
            <p style={{ marginBottom: 4 }}>Verification token:</p>
            <pre style={{ whiteSpace: 'pre-wrap' }}><code>{domainSetResult.verification_token}</code></pre>
            {domainSetResult.instructions && (
              <pre style={{ whiteSpace: 'pre-wrap' }}>
                {domainSetResult.instructions.dns}
                {'\n\n'}
                {domainSetResult.instructions.http}
              </pre>
            )}
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button onClick={() => verifyDomain('dns')} disabled={!org.domain}>Verify via DNS</button>
          <button onClick={() => verifyDomain('http')} disabled={!org.domain}>Verify via well-known file</button>
        </div>
        {domainVerifyResult && (
          <p style={{ marginTop: 8, fontSize: 13 }}>
            {domainVerifyResult.verified
              ? <span style={{ color: '#4caf50' }}>Verified via {domainVerifyResult.method}.</span>
              : <span style={{ color: '#e25555' }}>Not verified{domainVerifyResult.reason ? `: ${domainVerifyResult.reason}` : '.'}</span>}
          </p>
        )}
      </div>

      <div className="panel">
        <h3>Affiliations</h3>
        {affiliations.length === 0 ? (
          <p className="muted">No active affiliations.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Role</th>
                <th>Started</th>
                <th>Last verified</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {affiliations.map(a => (
                <React.Fragment key={a.code}>
                  <tr>
                    <td>{whoCell(a)}</td>
                    <td>{a.role}</td>
                    <td>{fmtDate(a.started_at)}</td>
                    <td>{fmtDate(a.last_verified_at)}</td>
                    <td>
                      <span className="row" style={{ gap: 4 }}>
                        <button onClick={() => openInlineForm(a, 'verify')}>Verify</button>
                        {a.role !== 'alumni' && (
                          <button onClick={() => openInlineForm(a, 'transition')}>Transition</button>
                        )}
                        <button className="danger" onClick={() => openInlineForm(a, 'end')}>End</button>
                        <button onClick={() => loadTrail(a.code)}>History</button>
                      </span>
                    </td>
                  </tr>
                  {inlineFormFor(a) === 'verify' && (
                    <tr>
                      <td colSpan={5}>
                        <form onSubmit={submitInline} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>
                            {VERIFY_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                          <input
                            value={form.period}
                            onChange={e => setForm({ ...form, period: e.target.value })}
                            placeholder="2025-2026"
                          />
                          <input
                            value={form.source}
                            onChange={e => setForm({ ...form, source: e.target.value })}
                            placeholder="source (optional)"
                          />
                          <button className="primary">Record verification</button>
                          <button type="button" onClick={() => setOpenForm(null)}>Cancel</button>
                        </form>
                      </td>
                    </tr>
                  )}
                  {inlineFormFor(a) === 'transition' && (
                    <tr>
                      <td colSpan={5}>
                        <form onSubmit={submitInline} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={form.to_role} onChange={e => setForm({ ...form, to_role: e.target.value })}>
                            {TRANSITION_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <select value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}>
                            {TRANSITION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <input
                            value={form.reason_detail}
                            onChange={e => setForm({ ...form, reason_detail: e.target.value })}
                            placeholder="detail (optional)"
                          />
                          <input
                            value={form.ended_at}
                            onChange={e => setForm({ ...form, ended_at: e.target.value })}
                            placeholder="YYYY-MM-DD, may be approximate"
                          />
                          <button className="primary">Transition</button>
                          <button type="button" onClick={() => setOpenForm(null)}>Cancel</button>
                        </form>
                      </td>
                    </tr>
                  )}
                  {inlineFormFor(a) === 'end' && (
                    <tr>
                      <td colSpan={5}>
                        <form onSubmit={submitInline} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}>
                            {END_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <input
                            value={form.reason_detail}
                            onChange={e => setForm({ ...form, reason_detail: e.target.value })}
                            placeholder="detail (optional)"
                          />
                          <input
                            value={form.ended_at}
                            onChange={e => setForm({ ...form, ended_at: e.target.value })}
                            placeholder="YYYY-MM-DD, may be approximate"
                          />
                          <button className="danger">End affiliation</button>
                          <button type="button" onClick={() => setOpenForm(null)}>Cancel</button>
                        </form>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}

        {trailFor && trail && (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ marginBottom: 4 }}>Verification trail for {trailFor}</h3>
            {trail.periods && trail.periods.length > 0 && (
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                Years: {trail.periods.join(', ')}
              </p>
            )}
            {trail.items && trail.items.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Period</th>
                    <th>Source</th>
                    <th>Verified at</th>
                  </tr>
                </thead>
                <tbody>
                  {trail.items.map((v, i) => (
                    <tr key={v.code || i}>
                      <td>{v.method}</td>
                      <td>{v.period || '—'}</td>
                      <td>{v.source || '—'}</td>
                      <td>{fmtDate(v.verified_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>No verifications recorded yet.</p>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Add affiliation</h3>
        <form onSubmit={addAffiliation}>
          <div className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
              <input
                type="radio"
                name="aff-target"
                checked={affTarget === 'person'}
                onChange={() => setAffTarget('person')}
              />
              Person
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
              <input
                type="radio"
                name="aff-target"
                checked={affTarget === 'family'}
                onChange={() => setAffTarget('family')}
              />
              Family
            </label>
          </div>
          <div className="split">
            <div>
              <label>{affTarget === 'person' ? 'Person code' : 'Family code'}</label>
              <input
                value={affCode}
                onChange={e => setAffCode(e.target.value)}
                placeholder={affTarget === 'person' ? 'p_…' : 'f_…'}
              />
            </div>
            <div>
              <label>Role</label>
              <select value={affRole} onChange={e => setAffRole(e.target.value)}>
                {AFFILIATE_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          {affError && (
            <div style={{ color: '#e25555', marginTop: 8, fontSize: 13 }}>{affError}</div>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="primary">Affiliate</button>
          </div>
        </form>
      </div>

      <div className="panel">
        <h3>Stale affiliations</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Active affiliations nothing has confirmed in the window. Staleness is a signal for a human — nothing here auto-expires.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            value={staleDays}
            onChange={e => setStaleDays(Number(e.target.value) || 365)}
            style={{ width: 100 }}
          />
          <span className="muted" style={{ fontSize: 13 }}>days</span>
          <button className="primary" onClick={runStale}>Run</button>
        </div>
        {staleError && (
          <div style={{ color: '#e25555', marginTop: 8, fontSize: 13 }}>{staleError}</div>
        )}
        {stale && (
          stale.items && stale.items.length > 0 ? (
            <table style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Started</th>
                  <th>Last verified</th>
                </tr>
              </thead>
              <tbody>
                {stale.items.map(a => (
                  <tr key={a.code}>
                    <td>{whoCell(a)}</td>
                    <td>{a.role}</td>
                    <td>{fmtDate(a.started_at)}</td>
                    <td>{fmtDate(a.last_verified_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Nothing stale inside {stale.stale_days} days.
            </p>
          )
        )}
      </div>
    </>
  );
}
