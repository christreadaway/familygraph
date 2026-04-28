import React, { useEffect, useState } from 'react';
import ViewToggle from './ViewToggle.jsx';
import { api } from '../api.js';

// Institution header — eyebrow + display name + meta + view toggle.
export default function Header() {
  const [info, setInfo] = useState({
    name: 'Family Graph — Local Registry',
    profile: '—',
    operator: 'operator',
  });

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listSettings().catch(() => ({ items: [] })),
      api.listProfiles().catch(() => ({ active: null })),
    ]).then(([settings, profiles]) => {
      if (!alive) return;
      const map = {};
      for (const s of settings.items || []) map[s.key] = s.value;
      setInfo({
        name: map.institution_name || 'Family Graph — Local Registry',
        operator: map.operator_name || 'operator',
        profile: profiles.active?.name || '—',
      });
    });
    return () => { alive = false; };
  }, []);

  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        gap: 16,
        padding: '22px 28px 18px',
        borderBottom: '0.5px solid var(--rule)',
        background: 'var(--bg)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div className="fg-eyebrow">FAMILY GRAPH · LOCAL REGISTRY</div>
        <h1
          className="fg-h-display"
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            margin: 0,
          }}
        >
          {info.name}
        </h1>
        <div className="mute mono" style={{ fontSize: 'var(--t-small)' }}>
          profile=<span style={{ color: 'var(--ink)' }}>{info.profile}</span>
          <span style={{ margin: '0 10px' }}>·</span>
          operator=<span style={{ color: 'var(--ink)' }}>{info.operator}</span>
        </div>
      </div>
      <ViewToggle />
    </header>
  );
}
