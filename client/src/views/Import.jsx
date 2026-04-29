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
        <FieldChip label="full_name" present={person.full_name} />
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

// Editable per-field column picker. Lets the operator point a canonical field
// at a different CSV column when the heuristic missed.
function HeaderSelect({ value, headers, onChange }) {
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">— not mapped —</option>
      {headers.map(h => (
        <option key={h} value={h}>{h}</option>
      ))}
    </select>
  );
}

const PERSON_FIELDS = [
  ['given_name', 'First name'],
  ['family_name', 'Last name'],
  ['full_name', 'Full name (split into first/last)'],
  ['middle_name', 'Middle'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['date_of_birth', 'Date of birth'],
  ['gender', 'Gender'],
  ['grade', 'Grade'],
];

function PersonTemplateEditor({ tmpl, idx, headers, onChange, onRemove }) {
  function patch(field, value) {
    onChange({ ...tmpl, [field]: value });
  }
  return (
    <div className="panel" style={{ padding: 12, margin: '8px 0' }}>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Person #{idx + 1}</strong>
        <div className="row" style={{ gap: 8 }}>
          <label style={{ fontSize: 12 }}>Role:&nbsp;</label>
          <select value={tmpl.role || 'member'} onChange={e => patch('role', e.target.value)}>
            <option value="member">member</option>
            <option value="parent">parent</option>
            <option value="child">child</option>
            <option value="spouse">spouse</option>
            <option value="other">other</option>
          </select>
          <button onClick={onRemove} style={{ fontSize: 12 }}>Remove</button>
        </div>
      </div>
      <table style={{ width: '100%', fontSize: 13 }}>
        <tbody>
          {PERSON_FIELDS.map(([f, label]) => (
            <tr key={f}>
              <td style={{ width: 220, padding: '4px 8px 4px 0' }}>{label}</td>
              <td><HeaderSelect value={tmpl[f]} headers={headers} onChange={v => patch(f, v)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MappingEditor({ mapping, headers, onChange }) {
  const persons = mapping.persons || [];
  function setPersons(next) {
    onChange({ ...mapping, persons: next });
  }
  function setFamily(field, v) {
    onChange({ ...mapping, family: { ...(mapping.family || {}), [field]: v } });
  }
  function setAddress(field, v) {
    onChange({ ...mapping, address: { ...(mapping.address || { label: 'home' }), [field]: v } });
  }
  return (
    <div>
      <h4 style={{ marginTop: 0 }}>Family fields</h4>
      <table style={{ fontSize: 13 }}>
        <tbody>
          <tr>
            <td style={{ width: 220, padding: '4px 8px 4px 0' }}>Family display name</td>
            <td><HeaderSelect value={mapping.family?.display_name} headers={headers} onChange={v => setFamily('display_name', v)} /></td>
          </tr>
        </tbody>
      </table>

      <h4>Address fields</h4>
      <table style={{ fontSize: 13 }}>
        <tbody>
          {[
            ['line1', 'Street line 1'],
            ['line2', 'Street line 2'],
            ['city', 'City'],
            ['region', 'State / Region'],
            ['postal', 'Zip / Postal'],
            ['country', 'Country'],
          ].map(([f, label]) => (
            <tr key={f}>
              <td style={{ width: 220, padding: '4px 8px 4px 0' }}>{label}</td>
              <td><HeaderSelect value={mapping.address?.[f]} headers={headers} onChange={v => setAddress(f, v)} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>People in each row</h4>
      {persons.map((tmpl, i) => (
        <PersonTemplateEditor
          key={i}
          tmpl={tmpl}
          idx={i}
          headers={headers}
          onChange={t => { const next = persons.slice(); next[i] = t; setPersons(next); }}
          onRemove={() => setPersons(persons.filter((_, j) => j !== i))}
        />
      ))}
      <button onClick={() => setPersons([...persons, { role: 'member' }])} style={{ marginTop: 8 }}>
        + Add another person template
      </button>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Each "person template" produces one person per row. A school roster typically has three
        templates: the student, parent 1, and parent 2. A donor list usually has one.
      </p>
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

  async function runPreview(rawContent, src, mappingOverride) {
    if (!rawContent) return;
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.importPreview({
        content: rawContent,
        source: src || null,
        mapping: mappingOverride || null,
      });
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

  async function applyMappingChange(nextMapping) {
    setPreview(p => p ? { ...p, mapping: nextMapping } : p);
    await runPreview(content, source || null, nextMapping);
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

          {preview.diagnostic && (
            <div
              className={`panel ${preview.diagnostic.rows_with_persons === 0 ? 'error' : preview.diagnostic.rows_skipped_blank > 0 ? 'warn' : ''}`}
              style={{
                margin: '0 0 12px 0',
                padding: 12,
                background: preview.diagnostic.rows_with_persons === 0
                  ? 'rgba(220,80,80,.08)'
                  : preview.diagnostic.rows_blank > 0 ? 'rgba(240,181,81,.08)' : 'transparent',
                borderColor: preview.diagnostic.rows_with_persons === 0 ? 'var(--error, #c33)' : 'var(--warn)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {preview.diagnostic.rows_with_persons} of {preview.row_count} rows will produce people
                {preview.diagnostic.total_persons > 0 && ` (${preview.diagnostic.total_persons} total persons)`}.
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                Family-named: {preview.diagnostic.rows_with_family_name} ·
                Addresses: {preview.diagnostic.rows_with_address} ·
                Blank rows: {preview.diagnostic.rows_blank}
              </div>
              {preview.diagnostic.rows_with_persons === 0 && (
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <strong>None of your rows produced a person.</strong> The column-name heuristics
                  didn't match anything in this sheet — open the column mapper below and point
                  the right columns at first/last name (or a single full-name column).
                </div>
              )}
              {preview.diagnostic.unmapped_columns && preview.diagnostic.unmapped_columns.length > 0 && (
                <details style={{ marginTop: 8, fontSize: 12 }}>
                  <summary>Unmapped columns ({preview.diagnostic.unmapped_columns.length})</summary>
                  <div style={{ marginTop: 6 }}>
                    {preview.diagnostic.unmapped_columns.map(c => (
                      <span key={c} className="tag" style={{ marginRight: 6, marginBottom: 4 }}>{c}</span>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          <MappingSummary mapping={preview.mapping} />
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>
              First {Math.min(5, preview.canonical_preview.length)} rows
            </div>
            <PreviewTable canonical={preview.canonical_preview} />
          </div>

          <details style={{ marginTop: 16 }} open={preview.diagnostic && preview.diagnostic.rows_with_persons === 0}>
            <summary><strong>Column mapping</strong> — point each canonical field at one of your CSV columns</summary>
            <div style={{ marginTop: 12 }}>
              <MappingEditor
                mapping={preview.mapping}
                headers={preview.headers || []}
                onChange={applyMappingChange}
              />
            </div>
          </details>

          <div className="row" style={{ marginTop: 16, gap: 12 }}>
            <button
              className="primary"
              onClick={doRun}
              disabled={busy || (preview.diagnostic && preview.diagnostic.rows_with_persons === 0)}
              title={preview.diagnostic && preview.diagnostic.rows_with_persons === 0 ? 'Fix the column mapping first — no rows would produce people.' : ''}
            >
              {busy
                ? 'Importing…'
                : preview.diagnostic
                  ? `Import ${preview.diagnostic.rows_with_persons} rows into directory${preview.diagnostic.rows_blank ? ` (${preview.diagnostic.rows_blank} blank skipped)` : ''}`
                  : `Import ${preview.row_count} rows into directory`}
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
              {result.totals.rows_skipped_blank > 0 && (
                <StatPill label="Rows skipped (blank)" value={result.totals.rows_skipped_blank} kind="warn" />
              )}
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
                  <tr key={i} style={r.skipped ? { opacity: 0.55 } : null}>
                    <td>{i + 1}</td>
                    <td>
                      {r.skipped
                        ? <span className="muted">skipped · {r.reason || 'blank'}</span>
                        : r.family
                          ? <span><code>{r.family.code}</code> <span className="tag action">{r.family.action}</span></span>
                          : <span className="muted">—</span>}
                    </td>
                    <td>
                      {(r.persons || []).map(p => (
                        <span key={p.code} style={{ display: 'inline-flex', gap: 4, marginRight: 8 }}>
                          <code>{p.code}</code><span className="tag action">{p.action}</span>
                        </span>
                      ))}
                    </td>
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
