import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Pill from '../components/Pill.jsx';
import IdCode from '../components/IdCode.jsx';
import ConnectorCard from '../components/ConnectorCard.jsx';
import StatPill, { StatPillGrid } from '../components/StatPill.jsx';

const LABELS = {
  facts: 'FACTS SIS',
  ministry_platform: 'Ministry Platform',
};

const SCHEDULES = [
  { value: 'off', label: 'Off (manual only)' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily_2am', label: 'Daily at 02:00 UTC' },
  { value: 'weekly_sun_2am', label: 'Weekly · Sunday 02:00 UTC' },
];

const FIELD_DEFS = {
  facts: [
    { key: 'api_base_url', label: 'API Base URL', placeholder: 'https://schoolname.client.renweb.com/api/v3' },
    { key: 'access_token_url', label: 'Access Token URL', placeholder: '<base>/oauth2/token' },
    { key: 'client_id', label: 'Client ID', secret: true },
    { key: 'client_secret', label: 'Client Secret', secret: true },
  ],
  ministry_platform: [
    { key: 'api_base_url', label: 'API Base URL', placeholder: 'https://my.parish.org/ministryplatformapi/' },
    { key: 'oauth_discovery_url', label: 'OAuth Token URL (optional — auto-derived if blank)', placeholder: '<base>/oauth/connect/token' },
    { key: 'client_id', label: 'Client ID', secret: true },
    { key: 'client_secret', label: 'Client Secret', secret: true },
  ],
};

// Human-readable phase labels driven by the metadata.phase string the
// server writes as the sync moves through stages.
const PHASE_LABELS = {
  starting: 'Starting…',
  authenticating: 'Authenticating with vendor…',
  pulling_students: 'Fetching students…',
  pulling_parents: 'Fetching parents/guardians…',
  pulling_households: 'Fetching households…',
  pulling_contacts: 'Fetching contacts…',
  pulling_addresses: 'Fetching addresses…',
  canonicalizing: 'Joining and canonicalizing…',
  importing: 'Matching and importing into the directory…',
  done: 'Done.',
  failed: 'Failed.',
};

function describeProgress(metadata) {
  if (!metadata) return null;
  const phase = metadata.phase;
  const bits = [];
  // FACTS counters
  if (metadata.students_pulled != null) bits.push(`${metadata.students_pulled} student${metadata.students_pulled === 1 ? '' : 's'}`);
  if (metadata.parents_pulled != null) bits.push(`${metadata.parents_pulled} parent${metadata.parents_pulled === 1 ? '' : 's'}`);
  // MP counters
  if (metadata.households_pulled != null) bits.push(`${metadata.households_pulled} household${metadata.households_pulled === 1 ? '' : 's'}`);
  if (metadata.contacts_pulled != null) bits.push(`${metadata.contacts_pulled} contact${metadata.contacts_pulled === 1 ? '' : 's'}`);
  if (metadata.addresses_pulled != null) bits.push(`${metadata.addresses_pulled} address${metadata.addresses_pulled === 1 ? 'es' : 'es'}`);
  if (metadata.rows_pulled != null && metadata.phase === 'importing') {
    bits.push(`${metadata.rows_pulled} canonical rows`);
  }
  return { phase, label: PHASE_LABELS[phase] || phase, counters: bits };
}

export function ConnectorsList() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);

  function load() {
    api.listConnectors().then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }
  useEffect(() => {
    load();
    // Poll every 5s so the cards reflect a sync that's running on
    // another tab or via the CLI. Cheap call.
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <h2>Connectors</h2>
      <p className="muted">
        Live API ingest from FACTS (school) and Ministry Platform (parish).
        These run on the schedule you set; the same data path also accepts
        CSV uploads, Google Sheets links, and folder-watch drops, so a
        broken connector is never a blocker — it's a fallback.
      </p>
      {error && <div className="panel error">{error}</div>}
      {items.map(c => <ConnectorCard key={c.name} connector={c} />)}
      {items.length === 0 && <div className="panel muted">No connectors registered.</div>}
    </>
  );
}

export function ConnectorDetail() {
  const { name } = useParams();
  const [connector, setConnector] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [activeRunCode, setActiveRunCode] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [finalRun, setFinalRun] = useState(null);
  const [finalImport, setFinalImport] = useState(null);
  const [runs, setRuns] = useState([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Refs let interval callbacks see the latest activeRunCode without
  // capturing a stale closure.
  const runCodeRef = useRef(null);

  function loadConnector() {
    return api.getConnector(name).then(d => {
      setConnector(d.connector);
      setDraft(prev => ({ ...prev, schedule: d.connector.schedule, enabled: d.connector.enabled }));
    });
  }
  function loadRuns() {
    return api.listConnectorRuns({ connector: name, limit: 20 })
      .then(d => setRuns(d.items || []))
      .catch(() => setRuns([]));
  }

  useEffect(() => {
    setActiveRunCode(null); setActiveRun(null); setFinalRun(null); setFinalImport(null);
    loadConnector().catch(e => setError(e.message));
    loadRuns();
  }, [name]);

  // If we land on the page and a sync is already running (started from
  // another tab, the CLI, or the scheduler), pick it up automatically.
  useEffect(() => {
    if (!connector) return;
    if (connector.last_run && connector.last_run.status === 'running' && !activeRunCode) {
      setActiveRunCode(connector.last_run.code);
    }
  }, [connector]);

  // Poll the active run every 1.5s while it's in flight.
  useEffect(() => {
    runCodeRef.current = activeRunCode;
    if (!activeRunCode) return;
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled || runCodeRef.current !== activeRunCode) return;
      try {
        const d = await api.getConnectorRun(activeRunCode);
        if (cancelled) return;
        setActiveRun(d.run);
        if (d.run && d.run.status !== 'running') {
          setFinalRun(d.run);
          setActiveRunCode(null);
          // After the run lands, also reload connector summary + run list.
          loadConnector().catch(() => {});
          loadRuns();
          // If the sync produced an import_run, fetch it for the per-row link.
          if (d.run.import_run) {
            api.getImport(d.run.import_run).then(im => setFinalImport(im)).catch(() => {});
          }
          return;
        }
      } catch (e) { /* ignore transient poll error; retry next tick */ }
      timer = setTimeout(tick, 1500);
    }
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeRunCode]);

  async function handleSaveCreds() {
    setBusy(true); setError(null);
    try {
      const payload = {};
      for (const f of FIELD_DEFS[name] || []) {
        if (draft[f.key] && String(draft[f.key]).trim()) payload[f.key] = draft[f.key].trim();
      }
      await api.setConnectorCredentials(name, payload);
      setDraft(d => {
        const out = { ...d };
        for (const f of FIELD_DEFS[name] || []) delete out[f.key];
        return out;
      });
      await loadConnector();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleTest() {
    setBusy(true); setError(null); setTestResult(null);
    try {
      const r = await api.testConnector(name);
      setTestResult({ ok: true, sample_count: r.sample_count });
    } catch (e) {
      setTestResult({ ok: false, reason: e.data?.reason, message: e.message });
    } finally { setBusy(false); }
  }

  async function handleSync() {
    setError(null);
    setFinalRun(null); setFinalImport(null); setActiveRun(null);
    try {
      const r = await api.syncConnector(name);
      setActiveRunCode(r.run_code);
    } catch (e) {
      setError(`${e.data?.reason || 'error'}: ${e.message}`);
    }
  }

  async function handlePatch(patch) {
    setBusy(true); setError(null);
    try {
      await api.patchConnector(name, patch);
      await loadConnector();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete() {
    setBusy(true); setError(null);
    try {
      await api.deleteConnectorCredentials(name);
      setConfirmingDelete(false);
      await loadConnector();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!connector) return <div className="muted">Loading {LABELS[name] || name}…</div>;

  const fields = FIELD_DEFS[name] || [];
  const allRequiredSet = fields
    .filter(f => f.secret || f.key === 'api_base_url' || f.key === 'access_token_url')
    .every(f => connector.fields && connector.fields[f.key] && connector.fields[f.key].set);

  const isRunning = !!activeRunCode;
  const progress = describeProgress(activeRun?.metadata);

  return (
    <>
      <h2>{LABELS[name] || name}</h2>
      <p className="muted">
        <Link to="/settings/connectors">← Back to connectors</Link>
      </p>
      {error && <div className="panel error">{error}</div>}

      <div className="panel">
        <h3>Credentials</h3>
        <p className="muted" style={{ fontSize: 'var(--t-small)' }}>
          Plaintext is encrypted with the data key (AES-256-GCM) before it lands on disk.
          GET /api/settings only reports a `_set: true` flag; this dashboard never displays
          the values you entered. Re-enter to update.
        </p>
        {fields.map(f => (
          <div key={f.key} style={{ marginBottom: 10 }}>
            <label>{f.label}</label>
            <div className="row">
              <input
                type={f.secret ? 'password' : 'text'}
                style={{ flex: 1 }}
                placeholder={connector.fields?.[f.key]?.set ? '••••••••' : (f.placeholder || '')}
                value={draft[f.key] || ''}
                onChange={e => setDraft({ ...draft, [f.key]: e.target.value })}
                autoComplete="off"
              />
              <Pill state={connector.fields?.[f.key]?.set ? 'loopback' : 'pii'}>
                {connector.fields?.[f.key]?.set ? 'set' : 'missing'}
              </Pill>
            </div>
          </div>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" disabled={busy} onClick={handleSaveCreds}>Save credentials</button>
          {confirmingDelete ? (
            <>
              <span className="muted" style={{ fontSize: 'var(--t-small)' }}>
                Delete credentials and disable this connector? Existing data is not removed.
              </span>
              <button className="danger" disabled={busy} onClick={handleDelete}>Confirm</button>
              <button disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</button>
            </>
          ) : (
            <button disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete credentials</button>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>Schedule and toggle</h3>
        <div className="row" style={{ gap: 16, alignItems: 'center' }}>
          <label style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={!!connector.enabled}
              disabled={busy || !allRequiredSet}
              onChange={e => handlePatch({ enabled: e.target.checked })}
            />{' '}
            Enabled
          </label>
          <select
            value={connector.schedule}
            disabled={busy}
            onChange={e => handlePatch({ schedule: e.target.value })}
          >
            {SCHEDULES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {!allRequiredSet && (
          <div className="muted" style={{ marginTop: 8, fontSize: 'var(--t-small)' }}>
            Set all required credentials before enabling the schedule.
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Test connection</h3>
        <p className="muted" style={{ fontSize: 'var(--t-small)' }}>
          Issues a single read to confirm the credentials work and the endpoint is reachable.
          Writes nothing.
        </p>
        <button className="primary" disabled={busy || !allRequiredSet} onClick={handleTest}>Test connection</button>
        {testResult && (
          <div className="row" style={{ marginTop: 10 }}>
            {testResult.ok
              ? <Pill state="loopback">ok · sample_count={testResult.sample_count}</Pill>
              : <Pill state="pii">{testResult.reason || 'error'}: {testResult.message}</Pill>}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Run sync now</h3>
        <p className="muted" style={{ fontSize: 'var(--t-small)' }}>
          Pulls all currently-enrolled records and runs them through the same import pipeline
          file uploads use. Resolved auto-merges happen silently; ambiguous matches open
          conflicts you'll see in <Link to="/conflicts">Conflict queue</Link>.
        </p>
        <button
          className="primary"
          disabled={busy || isRunning || !allRequiredSet}
          onClick={handleSync}
        >
          {isRunning ? 'Syncing…' : 'Run sync now'}
        </button>

        {/* Live progress while a sync is in flight. */}
        {isRunning && progress && (
          <div className="panel" style={{ marginTop: 12, background: 'rgba(80,160,200,.06)', borderColor: 'var(--accent-2, #50a0c8)' }}>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <span className="dot" style={{ background: 'var(--c-encrypted)', animation: 'fg-pulse 1.2s infinite' }} />
              <strong>{progress.label}</strong>
              <span className="muted mono" style={{ fontSize: 'var(--t-small)' }}>
                run <IdCode code={activeRunCode} />
              </span>
            </div>
            {progress.counters.length > 0 && (
              <div className="muted" style={{ marginTop: 6, fontFamily: 'var(--font-mono)' }}>
                {progress.counters.join(' · ')}
              </div>
            )}
          </div>
        )}

        {/* Final result — same StatPill grid + yellow conflict warn the file
            import view uses, so the operator gets identical feedback regardless
            of how the data arrived. */}
        {finalRun && finalRun.status === 'ok' && (
          <>
            <div className="panel" style={{ marginTop: 12 }}>
              <h4 style={{ marginTop: 0 }}>Sync complete</h4>
              <div className="muted" style={{ marginBottom: 8 }}>
                run <IdCode code={finalRun.code} />
                {finalRun.import_run && <> · import <Link to={`/imports/${finalRun.import_run}`}><IdCode code={finalRun.import_run} /></Link></>}
                {' · '} duration {finalRun.ended_at && finalRun.started_at ? `${Math.round((finalRun.ended_at - finalRun.started_at) / 1000)}s` : '—'}
              </div>
              <StatPillGrid
                totals={finalImport?.run || finalRun.metadata}
                extras={
                  <StatPill
                    label="Rows pulled"
                    value={(finalRun.metadata && finalRun.metadata.rows_pulled) ?? 0}
                    kind="action"
                  />
                }
              />
              {(finalImport?.run?.conflicts_opened || finalRun.metadata?.conflicts_opened || 0) > 0 && (
                <div
                  className="panel warn"
                  style={{
                    marginTop: 12, marginBottom: 0,
                    background: 'rgba(240,181,81,.08)', borderColor: 'var(--warn)',
                  }}
                >
                  <strong>
                    {finalImport?.run?.conflicts_opened ?? finalRun.metadata?.conflicts_opened} new
                    {' '}conflict{(finalImport?.run?.conflicts_opened ?? finalRun.metadata?.conflicts_opened) === 1 ? '' : 's'} need
                    {(finalImport?.run?.conflicts_opened ?? finalRun.metadata?.conflicts_opened) === 1 ? 's' : ''} resolution.
                  </strong>{' '}
                  Soft-similarity matches were surfaced for operator review rather than auto-merged.
                  {' '}<Link to="/conflicts">Open the conflict queue →</Link>
                </div>
              )}
              {finalRun.import_run && (
                <div style={{ marginTop: 12 }}>
                  <Link to={`/imports/${finalRun.import_run}`}>view full report →</Link>
                </div>
              )}
            </div>
          </>
        )}

        {finalRun && finalRun.status !== 'ok' && (
          <div className="panel error" style={{ marginTop: 12 }}>
            <h4 style={{ marginTop: 0 }}>Sync {finalRun.status === 'timeout' ? 'timed out' : 'failed'}</h4>
            <div>
              <Pill state="pii">{finalRun.reason || 'error'}</Pill>{' '}
              <span className="mono">{finalRun.metadata?.error_message || ''}</span>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              No partial data was written — the import was wrapped in a transaction.
              {finalRun.reason === 'auth_failed' && ' Check the credentials in the panel above.'}
              {finalRun.reason === 'network_error' && ' Confirm the API base URL is reachable from this machine.'}
              {finalRun.reason === 'rate_limited' && ' The vendor returned 429. The next scheduled sync will run normally.'}
            </p>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Recent runs</h3>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Rows pulled</th>
              <th>Import run</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.code}>
                <td className="muted mono">{r.started_at ? new Date(Number(r.started_at)).toLocaleString() : '—'}</td>
                <td><Pill state="muted">{r.trigger}</Pill></td>
                <td>
                  {r.status === 'ok' && <Pill state="loopback">ok</Pill>}
                  {r.status === 'error' && <Pill state="pii">error</Pill>}
                  {r.status === 'running' && <Pill state="encrypted">running</Pill>}
                  {r.status === 'timeout' && <Pill state="pii">timeout</Pill>}
                </td>
                <td className="mono tnum">{r.metadata && r.metadata.rows_pulled != null ? r.metadata.rows_pulled : '—'}</td>
                <td>{r.import_run ? <Link to={`/imports/${r.import_run}`}><IdCode code={r.import_run} /></Link> : <span className="muted">—</span>}</td>
                <td className="mono muted">{r.reason || ''}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={6} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
