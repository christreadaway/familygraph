import React from 'react';
import { useFG, setView } from '../store.js';

// Segmented PII ↔ Pseudonym toggle. Default = pseudonym.
export default function ViewToggle() {
  const { view } = useFG();
  return (
    <div className="fg-seg" role="group" aria-label="Identity view">
      <button
        className={view === 'pii' ? 'on pii' : ''}
        onClick={() => setView('pii')}
        aria-pressed={view === 'pii'}
      >
        <span
          aria-hidden
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--c-pii)', display: 'inline-block',
          }}
        />
        PII
      </button>
      <button
        className={view === 'pseudonym' ? 'on pseudo' : ''}
        onClick={() => setView('pseudonym')}
        aria-pressed={view === 'pseudonym'}
      >
        <span
          aria-hidden
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--c-pseudonym)', display: 'inline-block',
          }}
        />
        Pseudonym
      </button>
    </div>
  );
}
