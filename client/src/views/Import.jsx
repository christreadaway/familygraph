import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const CATEGORY_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'church', label: 'Church · tag people as parishioners' },
  { value: 'school', label: 'School · tag families as school parents' },
  { value: 'other', label: 'Other' },
];

function ScanThisImport({ importRunCode }) {
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function run() {
    setBusy(true); setErr(null);
    try { const r = await api.scanDuplicates({ import_run_code: importRunCode }); setScan(r); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div>
      <button onClick={run} disabled={busy}>
        {busy ? 'Scanning…' : 'Scan this import for duplicates'}
      </button>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      {scan && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          Scanned {scan.scanned} new person{scan.scanned === 1 ? '' : 's'} ·
          {' '}{scan.matches_found} potential match{scan.matches_found === 1 ? '' : 'es'} ·
          {' '}{scan.new_conflicts_opened} conflict{scan.new_conflicts_opened === 1 ? '' : 's'} opened.
          {' '}<Link to="/conflicts">Open the conflict queue →</Link>
        </div>
      )}
    </div>
  );
}

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

function FieldChip({ label, present }) {
  return (
    <span
      className="tag"
      style={{
        marginRight: 6,
        marginBottom: 6,
        opacity: present ? 1 : 0.35,
        background: present ? 'var(--accent-2-soft, rgba(80,160,200,.15))' : 'transparent',
        border: '1px solid var(--rule)',
      }}
      title={present ? `mapped to "${present}"` : 'not detected'}
    >
      {label}{present ? ` · ${present}` : ''}
    </span>
  );
}

function MappingSummary({ mapping }) {
  const fam = mapping?.family || {};
  const addr = mapping?.address || {};
  const person = (mapping?.persons && mapping.persons[0]) || {};
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>People</div>
        <FieldChip label="given_name" present={person.given_name} />
        <FieldChip label="family_name" present={person.family_name} />
        <FieldChip label="email" present={person.email} />
        <FieldChip label="phone" present={person.phone} />
        <FieldChip label="dob" present={person.date_of_birth} />
        <FieldChip label="gender" present={person.gender} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Family</div>
        <FieldChip label="display_name" present={fam.display_name} />
      </div>
      <div>
        <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Address</div>
        <FieldChip label="line1" present={addr.line1} />
        <FieldChip label="city" present={addr.city} />
        <FieldChip label="region" present={addr.region} />
        <FieldChip label="postal" present={addr.postal} />
      </div>
    </div>
  );
}

function PreviewTable({ canonical }) {
  if (!canonical || canonical.length === 0) {
    return <div className="muted">No rows detected.</div>;
  }
  const sample = canonical.slice(0, 5);
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Family</th>
          <th>People</th>
          <th>Address</th>
        </tr>
      </thead>
      <tbody>
        {sample.map((row, i) => {
          const persons = row.persons || [];
          const addr = row.address || {};
          const addrParts = [addr.line1, addr.city, addr.region, addr.postal].filter(Boolean).join(', ');
          return (
            <tr key={i}>
              <td className="muted mono">{i + 1}</td>
              <td>{row.family?.display_name || <span className="muted">—</span>}</td>
              <td>
                {persons.length === 0 && <span className="muted">—</span>}
                {persons.map((p, j) => (
                  <div key={j}>
                    {[p.given_name, p.family_name].filter(Boolean).join(' ') || <span className="muted">(unnamed)</span>}
                    {p.email && <span className="muted mono" style={{ marginLeft: 6, fontSize: 11 }}>{p.email}</span>}
                  </div>
                ))}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{addrParts || '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
  const [previewing, setPreviewing] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [fetched, setFetched] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const previewRef = useRef(null);

  async function readFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = reader.result;
      setContent(text);
      setSourceRef(f.name || 'dashboard-import');
      setFetched(null);
      setResult(null);
      await runPreview(text, source || null);
    };
    reader.readAsText(f);
  }

  async function fetchSheet() {
    setError(null); setBusy(true); setFetched(null); setResult(null);
    try {
      const r = await api.fetchSheet(sheetUrl);
      setContent(r.content);
      setSourceRef(r.source_ref || 'sheet');
      setSource('sheets');
      setFetched({ byte_len: r.byte_len, final_url: r.final_url });
      await runPreview(r.content, 'sheets');
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function runPreview(rawContent, src) {
    if (!rawContent) return;
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.importPreview({ content: rawContent, source: src || null });
      setPreview(res);
      setTimeout(() => {
        if (previewRef.current) previewRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    } catch (e) {
      setError(e.message);
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
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
      <h2>Build your directory</h2>
      <p className="muted" style={{ marginTop: -6, marginBottom: 16 }}>
        Start by importing a roster — a CSV file, a Google Sheet, or paste a list. Family Graph
        organizes the data into families and people, then carries the source's category and tags
        forward so you can find them later.
      </p>
      {error && <div className="panel error">{error}</div>}

      <div className="panel">
        <h3>1 · Pick a source</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Google Sheet</label>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              Paste a link like <code>https://docs.google.com/spreadsheets/d/&lt;ID&gt;/edit?gid=0</code>.
              The sheet must be shared "Anyone with the link can view." We fetch it and parse it
              right here.
            </p>
            <div className="row">
              <input
                placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                value={sheetUrl}
                onChange={e => setSheetUrl(e.target.value)}
                style={{ flex: 1 }}
              />
              <button onClick={fetchSheet} disabled={!sheetUrl || busy}>
                {busy ? 'Fetching…' : 'Fetch & parse'}
              </button>
            </div>
            {fetched && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                Fetched {Math.round(fetched.byte_len / 1024)} KB from <code>{fetched.final_url}</code>
              </div>
            )}
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Upload a file</label>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              CSV, TSV, or text export from FACTS, RenWeb, or Ministry Platform — we auto-detect the
              format and parse on selection.
            </p>
            <input type="file" accept=".csv,.tsv,.txt" onChange={readFile} />
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>2 · Tell us what this list represents</h3>
        <div className="split">
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
          A <strong>church</strong> import auto-tags people as <code>parishioner</code>.
          A <strong>school</strong> import auto-tags families as <code>school-parent</code>; any
          person with grade 8 also gets <code>school-alumni-incoming</code>. Custom tags above are
          applied on top, so you can always slice the directory later.
        </p>
      </div>

      <div ref={previewRef} />

      {previewing && (
        <div className="panel"><span className="muted">Parsing…</span></div>
      )}

      {preview && !previewing && (
        <div className="panel">
          <h3>3 · Review what we found ({preview.row_count} rows · detected source: {preview.source})</h3>
          <MappingSummary mapping={preview.mapping} />
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>
              First {Math.min(5, preview.canonical_preview.length)} rows
            </div>
            <PreviewTable canonical={preview.canonical_preview} />
          </div>
          <div className="row" style={{ marginTop: 16, gap: 12 }}>
            <button className="primary" onClick={doRun} disabled={busy}>
              {busy ? 'Importing…' : `Import ${preview.row_count} rows into directory`}
            </button>
            <button onClick={() => setShowAdvanced(v => !v)}>
              {showAdvanced ? 'Hide' : 'Show'} advanced (raw mapping, paste box)
            </button>
          </div>
          {showAdvanced && (
            <div style={{ marginTop: 16 }}>
              <details>
                <summary>Override source / mapping</summary>
                <div className="row" style={{ marginTop: 8 }}>
                  <select value={source} onChange={async e => { setSource(e.target.value); await runPreview(content, e.target.value || null); }}>
                    <option value="">auto-detect</option>
                    <option value="csv">Generic CSV</option>
                    <option value="facts">FACTS</option>
                    <option value="renweb">RenWeb</option>
                    <option value="ministry_platform">Ministry Platform</option>
                    <option value="sheets">Google Sheets export (CSV)</option>
                  </select>
                </div>
                <textarea
                  rows={10}
                  style={{ width: '100%', marginTop: 8 }}
                  value={JSON.stringify(preview.mapping, null, 2)}
                  onChange={e => {
                    try { setPreview({ ...preview, mapping: JSON.parse(e.target.value) }); }
                    catch (_) { /* accept the keystroke */ }
                  }}
                />
              </details>
              <details style={{ marginTop: 8 }}>
                <summary>Paste raw content</summary>
                <textarea
                  rows={8}
                  style={{ width: '100%', marginTop: 8 }}
                  placeholder="Paste CSV content here"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onBlur={() => content && runPreview(content, source || null)}
                />
              </details>
            </div>
          )}
        </div>
      )}

      {!preview && !previewing && !content && (
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Pick a source above. Once you do, we'll parse the data and show you exactly what will
            land in the directory before you commit.
          </p>
        </div>
      )}

      {result && (
        <>
          <div className="panel">
            <h3>Imported · review for duplicates?</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              The import-time resolver caught matches inside this batch. Run a sweep to find
              duplicates between these new rows and existing people in the directory.
            </p>
            <ScanThisImport importRunCode={result.import_run} />
          </div>
          <div className="panel">
            <h3>Imported</h3>
            <div className="muted" style={{ marginBottom: 8 }}>
              <code>{result.import_run}</code>
              {' · '} {result.rows} rows
              {' · '} <Link to={`/imports/${result.import_run}`}>view full report</Link>
              {' · '} <Link to="/families">browse families →</Link>
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
