import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getToken, setToken } from '../api.js';

export default function Login({ onSession }) {
  const navigate = useNavigate();
  const [redeeming, setRedeeming] = useState(false);
  const [session, setSession] = useState(null); // { account, expires_at } after a successful redeem
  const [redeemFailed, setRedeemFailed] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [hasToken, setHasToken] = useState(() => !!getToken());
  const redeemedOnce = useRef(false);

  // Redeem a magic-link token from the URL, exactly once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token || !token.startsWith('ml_') || redeemedOnce.current) return;
    redeemedOnce.current = true;
    setRedeeming(true);
    (async () => {
      try {
        const r = await api.authRedeem(token);
        setToken(r.token);
        setHasToken(true);
        setSession({ account: r.account, expires_at: r.expires_at });
        if (onSession) onSession();
      } catch (_) {
        setRedeemFailed(true);
      } finally {
        setRedeeming(false);
        // The link is single-use — get the token out of the address bar / history.
        navigate('/login', { replace: true });
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cooldown countdown after a send.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function requestLink(e) {
    e.preventDefault();
    if (!email.trim() || cooldown > 0) return;
    try {
      await api.authRequestLink(email.trim());
    } catch (_) {
      // Deliberately swallowed: the API never reveals account existence,
      // and the UI must not either.
    }
    setSent(true);
    setCooldown(30);
  }

  async function signOut() {
    try { await api.authLogout(); } catch (_) { /* best effort */ }
    setToken('');
    setHasToken(false);
    setSession(null);
    setSent(false);
  }

  if (redeeming) {
    return (
      <>
        <h2>Staff sign-in</h2>
        <div className="panel"><span className="muted">Checking your sign-in link…</span></div>
      </>
    );
  }

  if (session) {
    return (
      <>
        <h2>Staff sign-in</h2>
        <div className="panel" style={{ background: 'rgba(76,175,80,.08)', borderColor: '#4caf50' }}>
          <h3 style={{ marginTop: 0 }}>Signed in as {session.account?.display_name}</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            Your session lasts until {session.expires_at ? new Date(session.expires_at).toLocaleString() : 'it expires'}.
          </p>
          <Link to="/people">Open the directory</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h2>Staff sign-in</h2>

      {redeemFailed && (
        <div className="panel error">
          That sign-in link is invalid, already used, or expired. Links work once and expire
          in 15 minutes. Request a new one below.
        </div>
      )}

      {hasToken && (
        <div className="panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            You already have a session/token on this browser.
          </span>
          <button onClick={signOut}>Sign out</button>
        </div>
      )}

      <div className="panel">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Staff sign in with named accounts. Enter your work email; if an account exists, a
          one-time sign-in link arrives by email. The link works once and expires in 15 minutes.
        </p>
        {sent && (
          <div className="panel" style={{ background: 'rgba(76,175,80,.08)', borderColor: '#4caf50' }}>
            If an account exists for that address, a sign-in link is on its way. Check your inbox.
          </div>
        )}
        <form onSubmit={requestLink}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="[you@example.org]"
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={!email.trim() || cooldown > 0}>
              {cooldown > 0 ? `Sent — retry in ${cooldown}s` : 'Email me a sign-in link'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
