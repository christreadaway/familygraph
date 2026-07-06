import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Pill from '../components/Pill.jsx';

// Partner-app outbound pairings (Option A — "no open doors").
//
// FamilyGraph is the sole initiator: once a pairing is enabled, FG dials the
// paired partner app over outbound HTTPS on the configured interval. FG opens
// no inbound port; the partner app never calls FG. This screen configures the
// dial-out target + shared secrets and toggles each pairing. Secrets are
// WRITE-ONLY — stored encrypted server-side and never returned, so the inputs
// always start blank.

const FIELD_DEFS = [
  { key: 'partner_base_url', label: 'Partner App Base URL', placeholder: 'https://app.partner.example' },
  { key: 'partner_bearer_credential', label: 'Partner App Bearer Credential', secret: true },
  { key: 'shared_webhook_secret', label: 'Shared Webhook/HMAC Secret', secret: true },
  { key: 'envelope_key', label: 'Envelope Key (64 hex)', secret: true, placeholder: '64 hex chars' },
  { key: 'check_in_interval_s', label: 'Check-in Interval (seconds)', placeholder: '20' },
];

function PairingCard({ pairing, onChange }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const sid = pairing.schoolId;

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const body = {};
      for (const f of FIELD_DEFS) {
        if (form[f.key] != null && form[f.key] !== '') body[f.key] = form[f.key];
      }
      await api.setPartnerPairing(sid, body);
      setForm({});
      setMsg('Saved.');
      onChange();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function toggle() {
    setBusy(true); setMsg(null);
    try {
      await api.patchPartnerPairing(sid, { enabled: !pairing.enabled });
      onChange();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Remove pairing for ${sid}? This clears its secrets.`)) return;
    setBusy(true);
    try { await api.deletePartnerPairing(sid); onChange(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{sid}</h3>
        <Pill state={pairing.enabled ? 'consented' : 'muted'}>{pairing.enabled ? 'Enabled' : 'Disabled'}</Pill>
      </div>
      <div style={{ fontSize: 13, color: '#666', margin: '6px 0' }}>
        Interval: {pairing.check_in_interval_s}s ·
        Last check-in: {pairing.last_check_in_at ? new Date(Number(pairing.last_check_in_at)).toLocaleString() : 'never'} ·
        Cursor: {pairing.last_acked_cursor || 'none'}
      </div>
      {FIELD_DEFS.map(f => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#444' }}>
            {f.label}{' '}
            {f.secret && pairing.fields[f.key]?.set ? <Pill state="muted">set</Pill> : null}
          </label>
          <input
            type={f.secret ? 'password' : 'text'}
            value={form[f.key] || ''}
            placeholder={f.placeholder || (f.secret ? '•••••••• (leave blank to keep)' : '')}
            onChange={e => setForm({ ...form, [f.key]: e.target.value })}
            style={{ width: '100%', padding: 6 }}
            autoComplete="off"
          />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button disabled={busy} onClick={save}>Save</button>
        <button disabled={busy} onClick={toggle}>{pairing.enabled ? 'Disable' : 'Enable'}</button>
        <button disabled={busy} onClick={remove} style={{ marginLeft: 'auto', color: '#a00' }}>Remove</button>
      </div>
      {msg ? <div style={{ marginTop: 8, fontSize: 13 }}>{msg}</div> : null}
    </div>
  );
}

export default function PartnerPairings() {
  const [items, setItems] = useState([]);
  const [newId, setNewId] = useState('');
  const [err, setErr] = useState(null);

  async function load() {
    try { const r = await api.listPartnerPairings(); setItems(r.items || []); setErr(null); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!newId.trim()) return;
    try { await api.setPartnerPairing(newId.trim(), {}); setNewId(''); load(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h2>Partner App Pairings</h2>
      <p style={{ color: '#555', fontSize: 14 }}>
        FamilyGraph is the only initiator. Once enabled, FG dials the partner app
        over outbound HTTPS on the interval below. FamilyGraph opens no inbound
        port; the partner app never calls FamilyGraph. Secrets are write-only.
      </p>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input
          placeholder="new school/tenant id (e.g. st-marys)"
          value={newId}
          onChange={e => setNewId(e.target.value)}
          style={{ flex: 1, padding: 6 }}
        />
        <button onClick={add}>Add pairing</button>
      </div>
      {err ? <div style={{ color: '#a00', marginBottom: 12 }}>{err}</div> : null}
      {items.length === 0 ? <p>No pairings configured.</p> : null}
      {items.map(p => <PairingCard key={p.schoolId} pairing={p} onChange={load} />)}
    </div>
  );
}
