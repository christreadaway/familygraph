import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { api, getToken, setToken, validateToken } from './api.js';
import Families from './views/Families.jsx';
import FamilyDetail from './views/FamilyDetail.jsx';
import People from './views/People.jsx';
import PersonDetail from './views/PersonDetail.jsx';
import Conflicts from './views/Conflicts.jsx';
import ImportView from './views/Import.jsx';
import { ImportsList, ImportDetail } from './views/Imports.jsx';
import AuditLog from './views/AuditLog.jsx';
import SanitizeView from './views/Sanitize.jsx';
import Rules from './views/Rules.jsx';
import Keys from './views/Keys.jsx';
import Profiles from './views/Profiles.jsx';
import Settings from './views/Settings.jsx';
import Search from './views/Search.jsx';
import ExportView from './views/Export.jsx';
import Notifications from './views/Notifications.jsx';

const REASON_HINT = {
  no_bearer: 'No token sent. Paste your Bearer token below.',
  token_mismatch: 'The token saved in this browser does not match the server. Run `node bin/family-graph.js show-token` and paste the value below.',
  unknown_or_revoked_scoped_token: 'This scoped key is unknown or has been revoked.',
  missing_scope: 'The current token is valid but lacks the required scope.',
  non_loopback_origin: 'The safe surface only accepts requests from this machine.',
};

function TokenBanner({ ok, onSetToken, busy, lastReason, lastError }) {
  const [val, setVal] = useState('');
  if (ok) return null;
  return (
    <div className="token-banner">
      Family Graph needs your local Bearer token to talk to the PII surface. Run{' '}
      <code>node bin/family-graph.js show-token</code> in the Family Graph
      directory and paste it here:
      <div className="row" style={{ marginTop: 8 }}>
        <input
          style={{ flex: 1, fontFamily: 'var(--mono)' }}
          value={val}
          onChange={e => setVal(e.target.value)}
          placeholder="paste 64-character hex token"
          autoFocus
        />
        <button
          className="primary"
          disabled={busy || !val.trim()}
          onClick={() => { onSetToken(val.trim()); setVal(''); }}
        >
          {busy ? 'Verifying…' : 'Save'}
        </button>
      </div>
      {lastReason && (
        <div style={{ marginTop: 8, color: 'var(--error)', fontSize: 13 }}>
          {REASON_HINT[lastReason] || `Server rejected the request (${lastReason}).`}
        </div>
      )}
      {!lastReason && lastError && (
        <div style={{ marginTop: 8, color: 'var(--error)', fontSize: 13 }}>{lastError}</div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
        Tip: the token is verified against the server before being saved. A
        bad paste is rejected immediately instead of silently failing later.
      </div>
    </div>
  );
}

export default function App() {
  const [tokenOk, setTokenOk] = useState(false);
  const [health, setHealth] = useState(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [lastReason, setLastReason] = useState(null);
  const [lastError, setLastError] = useState(null);

  useEffect(() => {
    let alive = true;
    function poll() {
      api.health().then(h => { if (alive) setHealth(h); }).catch(() => {});
    }
    poll();
    const int = setInterval(poll, 15_000);
    return () => { alive = false; clearInterval(int); };
  }, []);

  // Initial validation: if we already have a token in localStorage, prove it
  // works. If the server rejects, drop the stale value and force the banner.
  useEffect(() => {
    if (!getToken()) { setTokenOk(false); return; }
    validateToken()
      .then(() => setTokenOk(true))
      .catch(e => {
        setTokenOk(false);
        setLastReason(e.data?.reason || null);
        setLastError(e.message);
        // Clear the stale token immediately so subsequent navigation doesn't
        // keep sending a known-bad value.
        setToken('');
      });
  }, []);

  // Any 401/403 anywhere in the app dispatches `family-graph:auth-failed`.
  // We surface the reason in the banner and drop the token so the operator
  // is forced to re-paste.
  useEffect(() => {
    function onAuthFailed(e) {
      setTokenOk(false);
      setLastReason(e.detail?.reason || null);
      setLastError(e.detail?.detail || null);
      setToken('');
    }
    window.addEventListener('family-graph:auth-failed', onAuthFailed);
    return () => window.removeEventListener('family-graph:auth-failed', onAuthFailed);
  }, []);

  // Save handler: persist the token, then validate by hitting a Bearer-only
  // endpoint. Reject the paste if the server says no.
  async function handleSaveToken(t) {
    if (!t) return;
    setTokenBusy(true);
    setLastReason(null);
    setLastError(null);
    setToken(t);
    try {
      await validateToken();
      setTokenOk(true);
    } catch (e) {
      setTokenOk(false);
      setLastReason(e.data?.reason || null);
      setLastError(e.message);
      setToken('');
    } finally {
      setTokenBusy(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Family Graph</h1>
        <nav className="col">
          <NavLink to="/search">Search</NavLink>
          <NavLink to="/families">Families</NavLink>
          <NavLink to="/people">People</NavLink>
          <NavLink to="/conflicts">
            Conflict queue
            {health?.pending_conflicts > 0 && (
              <span style={{ marginLeft: 6, padding: '1px 8px', borderRadius: 999, background: 'var(--warn)', color: '#1c1300', fontSize: 11 }}>
                {health.pending_conflicts}
              </span>
            )}
          </NavLink>
          <NavLink to="/rules">Resolution rules</NavLink>
          <NavLink to="/import">Import</NavLink>
          <NavLink to="/imports">Imports log</NavLink>
          <NavLink to="/export">Export</NavLink>
          <NavLink to="/sanitize">Sanitize / desanitize</NavLink>
          <NavLink to="/audit">Audit log</NavLink>
          <NavLink to="/notifications">Notifications</NavLink>
          <NavLink to="/profiles">Profiles</NavLink>
          <NavLink to="/keys">API keys</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="footer">
          {health ? (
            <>
              Schema v{health.schema} · {health.status}
              {health.active_profile && <div>Profile: <code>{health.active_profile}</code></div>}
              {health.counts && (
                <div style={{ marginTop: 4 }}>
                  {health.counts.families} families · {health.counts.persons} persons
                </div>
              )}
              {health.folder_watch && (
                <div style={{ marginTop: 4 }}>
                  watch: {health.folder_watch.enabled ? `${health.folder_watch.processed_since_boot} processed` : <span className="error">off</span>}
                </div>
              )}
            </>
          ) : <span className="error">backend unreachable</span>}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => { setToken(''); setTokenOk(false); setLastReason(null); setLastError(null); }}>Clear token</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <TokenBanner
          ok={tokenOk}
          busy={tokenBusy}
          lastReason={lastReason}
          lastError={lastError}
          onSetToken={handleSaveToken}
        />
        <Routes>
          <Route path="/" element={<Navigate to="/families" replace />} />
          <Route path="/search" element={<Search />} />
          <Route path="/families" element={<Families />} />
          <Route path="/families/:code" element={<FamilyDetail />} />
          <Route path="/people" element={<People />} />
          <Route path="/people/:code" element={<PersonDetail />} />
          <Route path="/conflicts" element={<Conflicts />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/import" element={<ImportView />} />
          <Route path="/imports" element={<ImportsList />} />
          <Route path="/imports/:code" element={<ImportDetail />} />
          <Route path="/export" element={<ExportView />} />
          <Route path="/sanitize" element={<SanitizeView />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
