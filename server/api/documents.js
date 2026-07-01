'use strict';

// Operator-facing Document Vault API.
//
// Mounted under /api/documents with the MASTER bearer (operator-only) — the
// vault holds children's sacramental / accommodation / health records, the
// most sensitive data in the system, so it lives behind the same gate as
// /api/settings and /api/partner-pairings, not a per-app scope. This route opens
// NO inbound surface to the partner app; the partner app reaches documents ONLY through the
// outbound agent's document.store / document.fetch transport. This is the
// operator's local management surface.
//
// Endpoints:
//   POST   /api/documents                  store a document (JSON, base64 body)
//   GET    /api/documents/person/:code     list a person's documents (metadata)
//   GET    /api/documents/:docRef          one document's metadata + title
//   GET    /api/documents/:docRef/content  decrypted bytes (operator download)
//   DELETE /api/documents/:docRef          archive (soft)
//   PUT    /api/documents/safety/:code     set health safety flags
//   GET    /api/documents/safety/:code     read health safety flags
//   DELETE /api/documents/safety/:code     clear health safety flags

const express = require('express');
const { userFacingMessage } = require('./_errors');
const documents = require('../integration/documents');

function _status(e) {
  switch (e && e.reason) {
    case 'not_found': return 404;
    case 'too_large': return 413;
    case 'bad_request': return 400;
    default: return 400;
  }
}

function build({ db, secrets }) {
  const r = express.Router();

  // Store a document. Body: { personCode, kind, subtype, title, contentType,
  // contentBase64, source }. Result: { docRef, policyKey, byteSize }.
  r.post('/', (req, res) => {
    try {
      const out = documents.store(db, secrets, req.body || {}, {
        actor: req.auth?.actor || 'operator',
      });
      res.status(201).json(out);
    } catch (e) {
      res.status(_status(e)).json({ error: userFacingMessage(e) });
    }
  });

  // List a person's documents (metadata + titles; never bytes).
  r.get('/person/:code', (req, res) => {
    const status = req.query.status === 'all' ? 'all'
      : (req.query.status === 'archived' ? 'archived' : 'active');
    res.json({ items: documents.listForPerson(db, secrets, req.params.code, { status, withTitles: true }) });
  });

  // Health safety flags. PUT/GET/DELETE keyed by person code. Routed BEFORE
  // the /:docRef handlers so 'safety' isn't swallowed as a docRef.
  r.put('/safety/:code', (req, res) => {
    try {
      const out = documents.setSafetyFlags(db, secrets, req.params.code, req.body || {}, {
        actor: req.auth?.actor || 'operator',
      });
      res.json({ safetyFlags: out });
    } catch (e) {
      res.status(_status(e)).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/safety/:code', (req, res) => {
    const out = documents.getSafetyFlags(db, secrets, req.params.code);
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json({ safetyFlags: out });
  });

  r.delete('/safety/:code', (req, res) => {
    const ok = documents.clearSafetyFlags(db, req.params.code, { actor: req.auth?.actor || 'operator' });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  // One document's metadata + decrypted title (no bytes).
  r.get('/:docRef', (req, res) => {
    const meta = documents.getMeta(db, req.params.docRef);
    if (!meta) return res.status(404).json({ error: 'not_found' });
    const title = documents.getTitle(db, secrets, req.params.docRef);
    res.json({ document: { ...meta, title: title || null } });
  });

  // Operator download of the decrypted bytes. Master-only; bypasses the partner app
  // access matrix because this is the operator's own console, not the partner app viewer.
  r.get('/:docRef/content', (req, res) => {
    const full = documents.getWithBytes(db, secrets, req.params.docRef);
    if (!full) return res.status(404).json({ error: 'not_found' });
    const buf = Buffer.from(full.contentBase64, 'base64');
    res.setHeader('content-type', full.contentType || 'application/octet-stream');
    res.setHeader('content-length', String(buf.length));
    res.send(buf);
  });

  // Archive (soft).
  r.delete('/:docRef', (req, res) => {
    const out = documents.archive(db, req.params.docRef, { actor: req.auth?.actor || 'operator' });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json({ document: out });
  });

  return r;
}

module.exports = build;
