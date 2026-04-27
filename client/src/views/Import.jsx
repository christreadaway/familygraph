import React, { useState } from 'react';
import { api } from '../api.js';

export default function ImportView() {
  const [content, setContent] = useState('');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function readFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setContent(reader.result);
    reader.readAsText(f);
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
    try {
      const res = await api.importRun({
        content,
        source: source || null,
        mapping: preview ? preview.mapping : null,
        source_ref: 'dashboard-import',
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
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={doPreview} disabled={!content || busy}>Preview</button>
          <button className="primary" onClick={doRun} disabled={!content || busy}>Run import</button>
        </div>
      </div>

      {preview && (
        <div className="panel">
          <h3>Preview · {preview.row_count} rows ({preview.source})</h3>
          <details>
            <summary>Detected mapping</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview.mapping, null, 2)}</pre>
          </details>
          <details open>
            <summary>First 10 canonical rows</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview.canonical_preview, null, 2)}</pre>
          </details>
        </div>
      )}

      {result && (
        <div className="panel">
          <h3>Imported {result.rows} rows</h3>
          <table>
            <thead><tr><th>Row</th><th>Family</th><th>Persons</th></tr></thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{r.family ? <span><code>{r.family.code}</code> <span className="tag action">{r.family.action}</span></span> : <span className="muted">—</span>}</td>
                  <td>{r.persons.map(p => <span key={p.code} className="row" style={{ display: 'inline-flex', marginRight: 8 }}><code>{p.code}</code><span className="tag action">{p.action}</span></span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
