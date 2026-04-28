import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import Families from './views/Families.jsx';
import FamilyDetail from './views/FamilyDetail.jsx';
import People from './views/People.jsx';
import PersonDetail from './views/PersonDetail.jsx';
import Conflicts from './views/Conflicts.jsx';
import ImportView from './views/Import.jsx';
import AuditLog from './views/AuditLog.jsx';
import SanitizeView from './views/Sanitize.jsx';
import Rules from './views/Rules.jsx';
import Keys from './views/Keys.jsx';
import Profiles from './views/Profiles.jsx';
import Settings from './views/Settings.jsx';
import Search from './views/Search.jsx';
import ExportView from './views/Export.jsx';
import Notifications from './views/Notifications.jsx';

function TokenBanner({ ok, onSetToken }) {
  const [val, setVal] = useState('');
  if (ok) return null;
  return (
    <div className="token-banner">
      Custos needs your local Bearer token to talk to the PII surface. Run{' '}
      <code>npx custos show-token</code> in the Custos directory and paste it here:
      <div className="row" style={{ marginTop: 8 }}>
        <input
          style={{ flex: 1, fontFamily: 'var(--mono)' }}
          value={val}
          onChange={e => setVal(e.target.value)}
          placeholder="paste 64-character hex token"
        />
        <button className="primary" onClick={() => { onSetToken(val.trim()); setVal(''); }}>
          Save
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [tokenOk, setTokenOk] = useState(false);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let alive = true;
    function poll() {
      api.health().then(h => { if (alive) setHealth(h); }).catch(() => {});
    }
    poll();
    const int = setInterval(poll, 15_000);
    return () => { alive = false; clearInterval(int); };
  }, []);

  useEffect(() => {
    if (!getToken()) { setTokenOk(false); return; }
    api.listFamilies().then(() => setTokenOk(true)).catch(() => setTokenOk(false));
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Custos</h1>
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
            <button onClick={() => { setToken(''); setTokenOk(false); }}>Clear token</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <TokenBanner ok={tokenOk} onSetToken={t => { setToken(t); setTokenOk(!!t); }} />
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
