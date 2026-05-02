import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Status rail — pinned, top of every screen, never collapsed.
// Subscribes to /api/health every 5s. If loopback is lost, the rail goes red.
export default function StatusRail() {
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    function tick() {
      api.health()
        .then(h => { if (alive) { setHealth(h); setErr(false); } })
        .catch(() => { if (alive) setErr(true); });
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const lostLoopback = err || (health && health.loopback === false);
  const railStyle = lostLoopback
    ? { background: 'var(--c-pii-bg)', borderBottomColor: 'var(--c-pii)' }
    : undefined;

  if (lostLoopback) {
    return (
      <div className="fg-rail" style={railStyle}>
        <span className="fg-rail-item">
          <span className="dot" style={{ background: 'var(--c-pii)' }} />
          <span style={{ color: 'var(--c-pii)' }}>LOOPBACK LOST</span>
          <span>backend unreachable — local-only safety check failed</span>
        </span>
      </div>
    );
  }

  const schema = health?.schema ?? '—';
  const profile = health?.active_profile;
  const counts = health?.counts;
  const watch = health?.folder_watch;

  return (
    <div className="fg-rail" role="status" aria-live="polite">
      <span className="fg-rail-item">
        <span className="dot" style={{ background: 'var(--c-loopback)' }} />
        <span style={{ color: 'var(--c-loopback)' }}>LOOPBACK</span>
        <span>127.0.0.1:3500</span>
      </span>
      <span style={{ color: 'var(--rule-strong)' }}>│</span>
      <span className="fg-rail-item">
        <span className="dot" style={{ background: 'var(--c-encrypted)' }} />
        <span style={{ color: 'var(--c-encrypted)' }}>ENCRYPTED</span>
        <span>AES-256-GCM</span>
      </span>
      <span style={{ color: 'var(--rule-strong)' }}>│</span>
      <span className="fg-rail-item">
        <span className="dot" style={{ background: 'var(--c-pseudonym)' }} />
        <span style={{ color: 'var(--c-pseudonym)' }}>AUDIT LIVE</span>
        <span>actor=<span style={{ color: 'var(--ink)' }}>dashboard</span></span>
      </span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12, alignItems: 'center' }}>
        {(health?.connectors || []).map(c => {
          // PRD §4.3: green dot if last sync succeeded, red dot if it
          // errored. Only render connectors that are configured at all
          // (the API only includes those — see api/health.js).
          const colorVar = c.last_status === 'ok' ? 'var(--c-loopback)'
                         : c.last_status === 'untested' ? 'var(--c-encrypted)'
                         : 'var(--c-pii)';
          const tip = c.last_reason
            ? `${c.name}: ${c.last_status} — ${c.last_reason}`
            : `${c.name}: ${c.last_status}`;
          return (
            <span key={c.name} className="faint" title={tip} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span className="dot" style={{ background: colorVar }} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{c.name === 'ministry_platform' ? 'mp' : c.name}</span>
            </span>
          );
        })}
        {profile && <span className="faint">profile={profile}</span>}
        {counts && (
          <span className="faint tnum">
            {counts.families} fam · {counts.persons} ppl
          </span>
        )}
        {watch?.enabled && (
          <span className="faint tnum">watch · {watch.processed_since_boot}</span>
        )}
        <span>schema {schema}</span>
      </span>
    </div>
  );
}
