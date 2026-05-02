import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Pill from '../components/Pill.jsx';
import IdCode from '../components/IdCode.jsx';
import ConnectorCard from '../components/ConnectorCard.jsx';

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

export function ConnectorsList() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);

  function load() {
    api.listConnectors().then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }
  useEffect(load, []);

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
  const [syncResult, setSyncResult] = useState(null);
  const [runs, setRuns] = useState([]);

  function reload() {
    api.getConnector(name).then(d => {
      setConnector(d.connector);
      setDraft(prev => ({ ...prev, schedule: d.connector.schedule, enabled: d.connector.enabled }));
    }).catch(e => setError(e.message));
    api.listConnectorRuns({ connector: name, limit: 20 })
      .then(d => setRuns(d.items || []))
      .catch(() => setRuns([]));
  }
  useEffect(reload, [name]);

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
      reload();
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
    setBusy(true); setError(null); setSyncResult(null);
    try {
      const r = await api.syncConnector(name);
      setSyncResult(r);
      reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handlePatch(patch) {
    setBusy(true); setError(null);
    try {
      await api.patchConnector(name, patch);
      reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete() {
    if (!window.confirm('Delete credentials and disable this connector? Existing data is not removed.')) return;
    setBusy(true); setError(null);
    try {
      await api.deleteConnectorCredentials(name);
      reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!connector) return <div className="muted">Loading {LABELS[name] || name}…</div>;

  const fields = FIELD_DEFS[name] || [];
  const allRequiredSet = fields.filter(f => f.secret || f.key === 'api_base_url' || f.key === 'access_token_url')
    .every(f => connector.fields && connector.fields[f.key] && connector.fields[f.key].set);

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
          <button disabled={busy} onClick={handleDelete}>Delete credentials</button>
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
          conflicts you'll see at the top of <Link to="/conflicts">Conflict queue</Link>.
        </p>
        <button className="primary" disabled={busy || !allRequiredSet} onClick={handleSync}>Run sync now</button>
        {syncResult && (
          <div className="mono" style={{ marginTop: 10 }}>
            {syncResult.ok ? (
              <span>
                ok · pulled <b>{syncResult.rows_pulled}</b> rows · run <IdCode code={syncResult.run_code} />
                {syncResult.import_run && <> · import <IdCode code={syncResult.import_run} /></>}
                {syncResult.totals && (
                  <> · +fam {syncResult.totals.families_created} · fam·att {syncResult.totals.families_attached}
                     · +ppl {syncResult.totals.persons_created} · conf {syncResult.totals.conflicts_opened}</>
                )}
              </span>
            ) : (
              <span>
                error · <Pill state="pii">{syncResult.reason || 'failed'}</Pill> {syncResult.message || ''}
              </span>
            )}
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
