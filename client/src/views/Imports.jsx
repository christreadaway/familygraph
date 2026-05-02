import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import IdCode from '../components/IdCode.jsx';
import Pill from '../components/Pill.jsx';
import ProvDot from '../components/ProvDot.jsx';

function effectsRow(totals) {
  const items = [
    ['+fam',     totals.families_created,  'loopback'],
    ['fam·att',  totals.families_attached, 'muted'],
    ['+ppl',     totals.persons_created,   'loopback'],
    ['ppl·att',  totals.persons_attached,  'muted'],
    ['conf',     totals.conflicts_opened,  totals.conflicts_opened > 0 ? 'pii' : 'muted'],
    ['addr',     totals.addresses_attached,'muted'],
    ['em',       totals.emails_attached,   'muted'],
    ['ph',       totals.phones_attached,   'muted'],
  ];
  return (
    <span className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      {items.map(([label, value, state]) => (
        <Pill key={label} state={state}>{label} {value}</Pill>
      ))}
    </span>
  );
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
      <p className="muted">
        Every file you bring into Family Graph is summarised here. Click a row to see exactly which
        families and people it touched.
      </p>
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
              <th>Trigger</th>
              <th>Code</th>
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
                <td className="muted mono">{new Date(r.created_at).toLocaleString()}</td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    <ProvDot source={r.source} />
                    <span className="mono">{r.source}</span>
                  </span>
                </td>
                <td>
                  <Pill state={r.trigger === 'scheduled' ? 'encrypted' : r.trigger === 'manual' || r.trigger === 'cli' ? 'loopback' : 'muted'}>
                    {r.trigger || 'file'}
                  </Pill>
                </td>
                <td><IdCode code={r.code} type="family" /></td>
                <td>{r.category ? <Pill state="muted">{r.category}</Pill> : <span className="muted">—</span>}</td>
                <td>
                  <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {(r.tags || []).map(t => <Pill key={t} state="muted">{t}</Pill>)}
                  </span>
                </td>
                <td className="mono tnum">{r.rows}</td>
                <td>{effectsRow(r)}</td>
                <td><Link to={`/imports/${r.code}`}>open →</Link></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={9} className="muted">No imports yet.</td></tr>}
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
      <h2>Import <IdCode code={run.code} /></h2>
      <div className="panel">
        <h3>Summary</h3>
        <dl className="kvp">
          <dt>When</dt><dd className="mono muted">{new Date(run.created_at).toLocaleString()}</dd>
          <dt>Source</dt>
          <dd>
            <span className="row" style={{ gap: 6 }}>
              <ProvDot source={run.source} />
              <span className="mono">{run.source}</span>
            </span>
          </dd>
          <dt>Source ref</dt><dd className="mono muted">{run.source_ref || '—'}</dd>
          <dt>Category</dt>
          <dd>{run.category ? <Pill state="muted">{run.category}</Pill> : <span className="muted">—</span>}</dd>
          <dt>Tags</dt>
          <dd>
            {(run.tags || []).length === 0
              ? <span className="muted">—</span>
              : (run.tags || []).map(t => <Pill key={t} state="muted">{t}</Pill>)}
          </dd>
          <dt>Rows</dt><dd className="mono tnum">{run.rows}</dd>
          <dt>Actor</dt><dd className="mono">{run.actor}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Effects</h3>
        {effectsRow(run)}
      </div>
      {Object.entries(byField).map(([field, codes]) => (
        <div key={field} className="panel">
          <h3>{codes.length} {field}{codes.length === 1 ? '' : 's'} touched</h3>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {codes.map(c => {
              const path = c.startsWith('f_') ? `/families/${c}`
                         : c.startsWith('p_') ? `/people/${c}`
                         : null;
              return path
                ? <Link key={c} to={path}><IdCode code={c} /></Link>
                : <IdCode key={c} code={c} />;
            })}
          </div>
        </div>
      ))}
    </>
  );
}
