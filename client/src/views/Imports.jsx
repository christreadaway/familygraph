import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';

function pillRow(totals) {
  const items = [
    ['Families +', totals.families_created, 'action'],
    ['Families attached', totals.families_attached],
    ['Persons +', totals.persons_created, 'action'],
    ['Persons attached', totals.persons_attached],
    ['Conflicts', totals.conflicts_opened, totals.conflicts_opened > 0 ? 'warn' : null],
    ['Addresses', totals.addresses_attached],
    ['Emails', totals.emails_attached],
    ['Phones', totals.phones_attached],
  ];
  return items.map(([label, value, kind]) => (
    <span key={label} className={`tag ${kind || ''}`} style={{ marginRight: 6 }}>
      {label}: {value}
    </span>
  ));
}

export function ImportsList() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState({ category: '' });
  const [error, setError] = useState(null);

  function load() {
    const params = {};
    if (filter.category) params.category = filter.category;
    api.listImports(params).then(d => setItems(d.items || [])).catch(e => setError(e.message));
  }
  useEffect(load, [filter.category]);

  return (
    <>
      <h2>Imports</h2>
      <p className="muted">Every file you bring into Family Graph is summarised here. Click a row to see exactly which families and people it touched.</p>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <div className="row">
          <label style={{ margin: 0 }}>Category</label>
          <select value={filter.category} onChange={e => setFilter({ ...filter, category: e.target.value })}>
            <option value="">any</option>
            <option value="church">church</option>
            <option value="school">school</option>
            <option value="other">other</option>
          </select>
        </div>
      </div>
      <div className="panel">
        <h3>{items.length} runs</h3>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Source</th>
              <th>Category</th>
              <th>Tags</th>
              <th>Rows</th>
              <th>Effects</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(r => (
              <tr key={r.code}>
                <td className="muted">{new Date(r.created_at).toLocaleString()}</td>
                <td><code>{r.source}</code></td>
                <td>{r.category ? <span className="tag">{r.category}</span> : <span className="muted">—</span>}</td>
                <td>{(r.tags || []).map(t => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)}</td>
                <td>{r.rows}</td>
                <td>{pillRow(r)}</td>
                <td><Link to={`/imports/${r.code}`}>open</Link></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7} className="muted">No imports yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ImportDetail() {
  const { code } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getImport(code).then(setData).catch(e => setError(e.message));
  }, [code]);
  if (error) return <div className="panel error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const { run, affected } = data;

  const byField = affected.reduce((acc, a) => {
    (acc[a.field] = acc[a.field] || []).push(a.entity_code);
    return acc;
  }, {});

  return (
    <>
      <h2>Import <code>{run.code}</code></h2>
      <div className="panel">
        <h3>Summary</h3>
        <dl className="kvp">
          <dt>When</dt><dd className="muted">{new Date(run.created_at).toLocaleString()}</dd>
          <dt>Source</dt><dd><code>{run.source}</code></dd>
          <dt>Source ref</dt><dd className="muted">{run.source_ref || '—'}</dd>
          <dt>Category</dt><dd>{run.category ? <span className="tag">{run.category}</span> : <span className="muted">—</span>}</dd>
          <dt>Tags</dt><dd>{(run.tags || []).map(t => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>) || '—'}</dd>
          <dt>Rows</dt><dd>{run.rows}</dd>
          <dt>Actor</dt><dd>{run.actor}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Effects</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{pillRow(run)}</div>
      </div>
      {Object.entries(byField).map(([field, codes]) => (
        <div key={field} className="panel">
          <h3>{codes.length} {field}{codes.length === 1 ? '' : 's'} touched</h3>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {codes.map(c => {
              const path = c.startsWith('f_') ? `/families/${c}`
                         : c.startsWith('p_') ? `/people/${c}`
                         : null;
              return path
                ? <Link key={c} to={path} style={{ marginRight: 6 }}><code>{c}</code></Link>
                : <code key={c} style={{ marginRight: 6 }}>{c}</code>;
            })}
          </div>
        </div>
      ))}
    </>
  );
}
