import React, { useState } from 'react';
import { api } from '../api.js';

export default function ExportView() {
  const [entity, setEntity] = useState('families');
  const [mode, setMode] = useState('safe');
  const [format, setFormat] = useState('csv');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);

  async function run() {
    setError(null); setOk(null);
    try {
      const body = { entity, mode, format };
      if (mode === 'pii') {
        if (!confirm(`Export ${entity} with real names to "${destination}"? This will be logged in the tier-2 audit trail.`)) return;
        body.consent = true;
        body.destination = destination;
        body.reason = reason;
      }
      const res = await api.exportData(body);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `family-graph-${entity}-${mode}.${format === 'json' ? 'json' : 'csv'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setOk(`Exported ${entity} (${mode}, ${format}).`);
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      <h2>Export</h2>
      <p className="muted">Default exports use codes only. PII exports require explicit consent and are logged to the tier-2 audit trail along with the destination and reason.</p>
      {error && <div className="panel error">{error}</div>}
      {ok && <div className="panel"><span className="tag action">{ok}</span></div>}
      <div className="panel">
        <div className="split">
          <div>
            <label>Entity</label>
            <select value={entity} onChange={e => setEntity(e.target.value)}>
              <option value="families">families</option>
              <option value="people">people</option>
              <option value="memberships">memberships</option>
            </select>
          </div>
          <div>
            <label>Mode</label>
            <select value={mode} onChange={e => setMode(e.target.value)}>
              <option value="safe">safe (codes only)</option>
              <option value="pii">PII (consent required)</option>
            </select>
          </div>
          <div>
            <label>Format</label>
            <select value={format} onChange={e => setFormat(e.target.value)}>
              <option value="csv">csv</option>
              <option value="json">json</option>
            </select>
          </div>
        </div>
        {mode === 'pii' && (
          <div className="split" style={{ marginTop: 12 }}>
            <div><label>Destination *</label><input value={destination} onChange={e => setDestination(e.target.value)} placeholder="e.g., board-report-2026-q2.csv" /></div>
            <div><label>Reason</label><input value={reason} onChange={e => setReason(e.target.value)} placeholder="quarterly board report" /></div>
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className={mode === 'pii' ? 'danger' : 'primary'} onClick={run} disabled={mode === 'pii' && !destination}>
            {mode === 'pii' ? 'Export PII (logs consent)' : 'Export'}
          </button>
        </div>
      </div>
    </>
  );
}
