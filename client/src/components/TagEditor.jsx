import React, { useEffect, useState } from 'react';

const SUGGESTED_TAGS = [
  'parishioner',
  'school-parent',
  'school-alumni',
  'school-alumni-incoming',
  'donor',
  'volunteer',
  'staff',
];

export default function TagEditor({ tags = [], onAdd, onRemove, suggestions = SUGGESTED_TAGS }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  function norm(t) {
    return String(t || '').trim().toLowerCase().replace(/\s+/g, '-');
  }

  async function handleAdd(value) {
    const v = norm(value);
    if (!v) return;
    if (tags.map(norm).includes(v)) { setDraft(''); return; }
    setBusy(true);
    try {
      await onAdd([...tags, v]);
      setDraft('');
    } finally { setBusy(false); }
  }

  async function handleRemove(tag) {
    setBusy(true);
    try {
      await onRemove(tag);
    } finally { setBusy(false); }
  }

  const remaining = suggestions.filter(s => !tags.map(norm).includes(norm(s)));

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {tags.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No tags yet.</span>}
        {tags.map(t => (
          <span
            key={t}
            className="tag"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}
          >
            {t}
            <button
              onClick={() => handleRemove(t)}
              disabled={busy}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 14, lineHeight: 1 }}
              aria-label={`remove ${t}`}
              title="remove"
            >×</button>
          </span>
        ))}
      </div>
      <form
        className="row"
        onSubmit={e => { e.preventDefault(); handleAdd(draft); }}
        style={{ gap: 6 }}
      >
        <input
          placeholder="Add tag (e.g. parishioner, donor)"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ flex: 1 }}
        />
        <button disabled={busy || !draft.trim()}>Add</button>
      </form>
      {remaining.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>Quick add:</span>
          {remaining.map(s => (
            <button
              key={s}
              onClick={() => handleAdd(s)}
              disabled={busy}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >+ {s}</button>
          ))}
        </div>
      )}
    </div>
  );
}
