import React, { useState } from 'react';
import { api } from '../api.js';

export default function SanitizeView() {
  const [text, setText] = useState('');
  const [tokenSet, setTokenSet] = useState(null);
  const [sanitized, setSanitized] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [restored, setRestored] = useState('');
  const [error, setError] = useState(null);

  async function doSanitize() {
    setError(null);
    try {
      const r = await api.sanitize({ text });
      setSanitized(r.sanitized);
      setTokenSet(r.token_set);
      setAiResponse(r.sanitized);
    } catch (e) {
      setError(e.message);
    }
  }
  async function doDesanitize() {
    setError(null);
    try {
      const r = await api.desanitize({ text: aiResponse, token_set: tokenSet });
      setRestored(r.text);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <h2>Sanitize · Desanitize</h2>
      {error && <div className="panel error">{error}</div>}
      <div className="panel">
        <h3>1. Paste text containing names/emails/phones</h3>
        <textarea rows={5} style={{ width: '100%' }} value={text} onChange={e => setText(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" onClick={doSanitize} disabled={!text}>Sanitize</button>
        </div>
      </div>
      {tokenSet && (
        <div className="panel">
          <h3>2. Sanitized output (token set <code>{tokenSet}</code>)</h3>
          <textarea rows={5} style={{ width: '100%' }} value={sanitized} readOnly />
          <h3 style={{ marginTop: 16 }}>3. Paste an AI response and restore real names</h3>
          <textarea rows={5} style={{ width: '100%' }} value={aiResponse} onChange={e => setAiResponse(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={doDesanitize}>Desanitize</button>
          </div>
        </div>
      )}
      {restored && (
        <div className="panel">
          <h3>4. Restored text</h3>
          <textarea rows={5} style={{ width: '100%' }} value={restored} readOnly />
        </div>
      )}
    </>
  );
}
