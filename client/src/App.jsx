import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { api, getToken, setToken, validateToken } from './api.js';
import StatusRail from './components/StatusRail.jsx';
import Header from './components/Header.jsx';
import Pill from './components/Pill.jsx';
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
import { ConnectorsList, ConnectorDetail } from './views/Connectors.jsx';

const REASON_HINT = {
  no_bearer: 'No token sent. Paste your Bearer token below.',
  token_mismatch:
    'The token saved in this browser does not match the server. Run `node bin/family-graph.js show-token` and paste the value below.',
  unknown_or_revoked_scoped_token: 'This scoped key is unknown or has been revoked.',
  missing_scope: 'The current token is valid but lacks the required scope.',
  non_loopback_origin: 'The safe surface only accepts requests from this machine.',
};

function TokenBanner({ ok, onSetToken, busy, lastReason, lastError }) {
  const [val, setVal] = useState('');
  if (ok) return null;
  return (
    <div className="token-banner">
      <strong style={{ color: 'var(--c-pii)' }}>Token required.</strong>{' '}
      Family Graph needs your local Bearer token to talk to the PII surface. Run{' '}
      <code>node bin/family-graph.js show-token</code> in the Family Graph
      directory and paste it here:
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <input
          style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
          value={val}
          onChange={(e) => setVal(e.target.value)}
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
        <div style={{ marginTop: 10, color: 'var(--c-consented)', fontSize: 'var(--t-small)' }}>
          {REASON_HINT[lastReason] || `Server rejected the request (${lastReason}).`}
        </div>
      )}
      {!lastReason && lastError && (
        <div style={{ marginTop: 10, color: 'var(--c-consented)', fontSize: 'var(--t-small)' }}>
          {lastError}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 'var(--t-micro)', color: 'var(--ink-faint)' }}>
        The token is verified against the server before being saved. A bad paste is rejected
        immediately instead of silently failing later.
      </div>
    </div>
  );
}

function NavItem({ to, children, badge }) {
  return (
    <NavLink to={to}>
      <span>{children}</span>
      {badge != null && badge > 0 && (
        <Pill state="pii">{badge}</Pill>
      )}
    </NavLink>
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
      api.health().then((h) => { if (alive) setHealth(h); }).catch(() => {});
    }
    poll();
    const int = setInterval(poll, 15_000);
    return () => { alive = false; clearInterval(int); };
  }, []);

  useEffect(() => {
    if (!getToken()) { setTokenOk(false); return; }
    validateToken()
      .then(() => setTokenOk(true))
      .catch((e) => {
        setTokenOk(false);
        setLastReason(e.data?.reason || null);
        setLastError(e.message);
        setToken('');
      });
  }, []);

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
      <StatusRail />
      <Header />
      <div className="resize-guard">
        Family Graph is built for ≥1280px windows. Resize to continue.
      </div>
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-eyebrow">Build directory</div>
          <nav>
            <NavItem to="/import">Import</NavItem>
            <NavItem to="/imports">Imports log</NavItem>
          </nav>
          <div className="sidebar-eyebrow" style={{ marginTop: 12 }}>Directory</div>
          <nav>
            <NavItem to="/families">Families</NavItem>
            <NavItem to="/people">People</NavItem>
            <NavItem to="/search">Search</NavItem>
            <NavItem to="/conflicts" badge={health?.pending_conflicts}>
              Conflict queue
            </NavItem>
            <NavItem to="/rules">Resolution rules</NavItem>
          </nav>
          <div className="sidebar-eyebrow" style={{ marginTop: 12 }}>Egress</div>
          <nav>
            <NavItem to="/export">Export</NavItem>
            <NavItem to="/sanitize">Sanitize</NavItem>
          </nav>
          <div className="sidebar-eyebrow" style={{ marginTop: 12 }}>Posture</div>
          <nav>
            <NavItem to="/audit">Audit log</NavItem>
            <NavItem to="/notifications">Notifications</NavItem>
            <NavItem to="/profiles">Profiles</NavItem>
            <NavItem to="/keys">API keys</NavItem>
            <NavItem to="/settings">Settings</NavItem>
            <NavItem to="/settings/connectors">Connectors</NavItem>
          </nav>
          <div className="sidebar-footer">
            {health ? (
              <>
                <div>schema v{health.schema} · {health.status}</div>
                {health.active_profile && (
                  <div>profile=<code>{health.active_profile}</code></div>
                )}
                {health.counts && (
                  <div>
                    {health.counts.families} fam · {health.counts.persons} ppl
                  </div>
                )}
                {health.folder_watch && (
                  <div>
                    watch:{' '}
                    {health.folder_watch.enabled
                      ? `${health.folder_watch.processed_since_boot} processed`
                      : <span style={{ color: 'var(--c-consented)' }}>off</span>}
                  </div>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--c-consented)' }}>backend unreachable</span>
            )}
            <div style={{ marginTop: 10 }}>
              <button
                onClick={() => {
                  setToken('');
                  setTokenOk(false);
                  setLastReason(null);
                  setLastError(null);
                }}
              >
                Clear token
              </button>
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
            <Route path="/" element={<Navigate to="/import" replace />} />
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
            <Route path="/settings/connectors" element={<ConnectorsList />} />
            <Route path="/settings/connectors/:name" element={<ConnectorDetail />} />
          </Routes>
          <footer
            style={{
              marginTop: 32,
              paddingTop: 14,
              borderTop: '0.5px solid var(--rule)',
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--t-micro)',
              color: 'var(--ink-faint)',
            }}
          >
            <span>family-graph · v1 · ~/.family-graph/ · sqlite (encrypted columns)</span>
            <span>no telemetry · no analytics · no phone-home</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
