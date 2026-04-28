import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const CATEGORY_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'church', label: 'Church' },
  { value: 'school', label: 'School' },
  { value: 'other', label: 'Other' },
];

function StatPill({ label, value, kind }) {
  return (
    <div className="panel" style={{ padding: '12px 16px', margin: 0, minWidth: 120 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: kind === 'warn' ? 'var(--warn)' : kind === 'action' ? 'var(--accent-2)' : 'inherit' }}>
        {value}
      </div>
    </div>
  );
}

export default function ImportView() {
  const [content, setContent] = useState('');
  const [source, setSource] = useState('');
  const [sourceRef, setSourceRef] = useState('dashboard-import');
  const [category, setCategory] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [fetched, setFetched] = useState(null);

  async function readFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setContent(reader.result); setSourceRef(f.name || 'dashboard-import'); setFetched(null); };
    reader.readAsText(f);
  }

  async function fetchSheet() {
    setError(null); setBusy(true); setFetched(null);
    try {
      const r = await api.fetchSheet(sheetUrl);
      setContent(r.content);
      setSourceRef(r.source_ref || 'sheet');
      setSource('sheets');
      setFetched({ byte_len: r.byte_len, final_url: r.final_url });
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function doPreview() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.importPreview({ content, source: source || null });
      setPreview(res);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function doRun() {
    setError(null);
    setBusy(true);
    setResult(null);
    try {
      const res = await api.importRun({
        content,
        source: source || null,
        mapping: preview ? preview.mapping : null,
        source_ref: sourceRef || 'dashboard-import',
        category: category || null,
        tags: tagsRaw,
      });
      setResult(res);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <h2>Bulk import</h2>
      {error && <div className="panel error">{error}</div>}

      <div className="panel">
        <h3>Pull from a Google Sheets URL</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Paste a link like <code>https://docs.google.com/spreadsheets/d/&lt;ID&gt;/edit?gid=0</code>.
          The sheet must be shared "Anyone with the link can view." Family Graph fetches the
          published CSV, populates the box below, and then you preview / run as normal.
        </p>
        <div className="row">
          <input
            placeholder="https://docs.google.com/spreadsheets/d/.../edit"
            value={sheetUrl}
            onChange={e => setSheetUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={fetchSheet} disabled={!sheetUrl || busy}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        {fetched && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            Fetched {Math.round(fetched.byte_len / 1024)} KB from <code>{fetched.final_url}</code>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Step 1 · Choose source</h3>
        <div className="row">
          <select value={source} onChange={e => setSource(e.target.value)}>
            <option value="">auto-detect</option>
            <option value="csv">Generic CSV</option>
            <option value="facts">FACTS</option>
            <option value="renweb">RenWeb</option>
            <option value="ministry_platform">Ministry Platform</option>
            <option value="sheets">Google Sheets export (CSV)</option>
          </select>
          <input type="file" accept=".csv,.tsv,.txt" onChange={readFile} />
        </div>
        <textarea
          rows={8}
          style={{ width: '100%', marginTop: 12 }}
          placeholder="Paste CSV content here, or load a file above"
          value={content}
          onChange={e => setContent(e.target.value)}
        />
        <div className="split" style={{ marginTop: 12 }}>
          <div>
            <label>Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label>Tags (comma-separated)</label>
            <input value={tagsRaw} onChange={e => setTagsRaw(e.target.value)} placeholder="e.g. q1-2026, donor-list, fr-mike" />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Family Graph stays narrow: only identity (families, people, addresses, contacts) is recorded. If
          this file contains donation amounts or other financial columns, those columns are ignored — the
          file's <code>category</code> and <code>tags</code> survive on the source-record so you can later
          see "this directory entry first appeared in our church donor list."
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={doPreview} disabled={!content || busy}>Preview</button>
          <button className="primary" onClick={doRun} disabled={!content || busy}>Run import</button>
        </div>
      </div>

      {preview && (
        <div className="panel">
          <h3>Preview · {preview.row_count} rows ({preview.source})</h3>
          <details open>
            <summary>Detected mapping (edit JSON to override before running import)</summary>
            <textarea
              rows={12}
              style={{ width: '100%', marginTop: 8 }}
              value={JSON.stringify(preview.mapping, null, 2)}
              onChange={e => {
                try { setPreview({ ...preview, mapping: JSON.parse(e.target.value) }); }
                catch (_) { /* accept the keystroke; ignore parse error */ }
              }}
            />
          </details>
          <details open>
            <summary>First 10 canonical rows</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview.canonical_preview, null, 2)}</pre>
          </details>
        </div>
      )}

      {result && (
        <>
          <div className="panel">
            <h3>Import summary</h3>
            <div className="muted" style={{ marginBottom: 8 }}>
              <code>{result.import_run}</code>
              {' · '} {result.rows} rows
              {' · '} <Link to={`/imports/${result.import_run}`}>view full report</Link>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <StatPill label="Families created" value={result.totals.families_created} kind="action" />
              <StatPill label="Families attached" value={result.totals.families_attached} />
              <StatPill label="Persons created" value={result.totals.persons_created} kind="action" />
              <StatPill label="Persons attached" value={result.totals.persons_attached} />
              <StatPill label="New conflicts" value={result.totals.conflicts_opened} kind={result.totals.conflicts_opened > 0 ? 'warn' : null} />
              <StatPill label="Addresses attached" value={result.totals.addresses_attached} />
              <StatPill label="Emails attached" value={result.totals.emails_attached} />
              <StatPill label="Phones attached" value={result.totals.phones_attached} />
              <StatPill label="Memberships opened" value={result.totals.memberships_opened} />
            </div>
            {result.totals.conflicts_opened > 0 && (
              <div className="panel warn" style={{ marginTop: 12, marginBottom: 0, background: 'rgba(240,181,81,.08)', borderColor: 'var(--warn)' }}>
                {result.totals.conflicts_opened} new conflict{result.totals.conflicts_opened === 1 ? '' : 's'} need{result.totals.conflicts_opened === 1 ? 's' : ''} resolution.
                {' '}<Link to="/conflicts">Open the conflict queue →</Link>
              </div>
            )}
          </div>
          <div className="panel">
            <h3>Per-row outcome</h3>
            <table>
              <thead><tr><th>Row</th><th>Family</th><th>Persons</th></tr></thead>
              <tbody>
                {result.results.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{r.family ? <span><code>{r.family.code}</code> <span className="tag action">{r.family.action}</span></span> : <span className="muted">—</span>}</td>
                    <td>{r.persons.map(p => <span key={p.code} style={{ display: 'inline-flex', gap: 4, marginRight: 8 }}><code>{p.code}</code><span className="tag action">{p.action}</span></span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
