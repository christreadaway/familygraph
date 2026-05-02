import React from 'react';
import { Link } from 'react-router-dom';
import Pill from './Pill.jsx';

const LABELS = {
  facts: 'FACTS SIS',
  ministry_platform: 'Ministry Platform',
};

function formatTime(t) {
  if (!t) return '—';
  if (typeof t === 'number') return new Date(t).toLocaleString();
  return t;
}

function statusPill(status, reason) {
  if (status === 'ok') return <Pill state="loopback">ok</Pill>;
  if (status === 'error') return <Pill state="pii">error{reason ? `: ${reason}` : ''}</Pill>;
  if (status === 'timeout') return <Pill state="pii">timeout</Pill>;
  if (status === 'running') return <Pill state="encrypted">syncing…</Pill>;
  return <Pill state="muted">untested</Pill>;
}

function progressLine(metadata) {
  if (!metadata || !metadata.phase) return null;
  const bits = [];
  if (metadata.students_pulled != null) bits.push(`${metadata.students_pulled} students`);
  if (metadata.parents_pulled != null) bits.push(`${metadata.parents_pulled} parents`);
  if (metadata.households_pulled != null) bits.push(`${metadata.households_pulled} households`);
  if (metadata.contacts_pulled != null) bits.push(`${metadata.contacts_pulled} contacts`);
  if (metadata.rows_pulled != null && metadata.phase === 'importing') bits.push(`${metadata.rows_pulled} rows → ledger`);
  return bits.join(' · ') || metadata.phase;
}

// ConnectorCard — surfaces the at-a-glance status block the operator
// sees in /settings/connectors. The detail screen is rendered by the
// dedicated ConnectorDetail view; this card just shows status + the
// most recent sync.
export default function ConnectorCard({ connector }) {
  const c = connector;
  const fields = c.fields || {};
  const last = c.last_run;
  const ok = c.last_successful_run;
  const isRunning = last && last.status === 'running';
  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{LABELS[c.name] || c.name}</h3>
        <span className="row" style={{ gap: 8 }}>
          {c.enabled ? <Pill state="loopback">enabled</Pill> : <Pill state="muted">disabled</Pill>}
          <Pill state="muted">{c.schedule}</Pill>
          {statusPill(isRunning ? 'running' : c.status, last && last.reason)}
        </span>
      </div>
      {isRunning && (
        <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
          <span className="dot" style={{ background: 'var(--c-encrypted)' }} />
          <span className="muted mono" style={{ fontSize: 'var(--t-small)' }}>
            {progressLine(last.metadata) || 'syncing…'}
          </span>
        </div>
      )}
      <dl className="kvp" style={{ marginTop: 12 }}>
        <dt>Credentials</dt>
        <dd>
          {Object.entries(fields).map(([k, v]) => (
            <span key={k} className="row" style={{ gap: 6, marginRight: 12 }}>
              <span className="muted mono">{k}</span>
              {v.set
                ? <Pill state="loopback">set</Pill>
                : <Pill state="pii">missing</Pill>}
            </span>
          ))}
        </dd>
        <dt>Last sync</dt>
        <dd className="mono muted">
          {last ? `${formatTime(last.started_at)} (${last.status})` : '(none)'}
        </dd>
        <dt>Last successful</dt>
        <dd className="mono muted">{ok ? formatTime(ok.started_at) : '(none)'}</dd>
        {c.last_modified_cursor && (
          <>
            <dt>Cursor</dt>
            <dd className="mono muted">{c.last_modified_cursor}</dd>
          </>
        )}
        {c.consecutive_failures > 0 && (
          <>
            <dt>Failures in a row</dt>
            <dd><Pill state="pii">{c.consecutive_failures}</Pill></dd>
          </>
        )}
      </dl>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <Link to={`/settings/connectors/${c.name}`} className="primary" style={{
          textDecoration: 'none', display: 'inline-block', padding: '6px 12px',
        }}>Configure</Link>
      </div>
    </div>
  );
}
