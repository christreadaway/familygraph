'use strict';

// FamilyGraph Integration API router.
//
// Implements the read / write surface defined in FAMILYGRAPH_INTEGRATION.md
// v0.1. All routes live under /v1/... and require a bearer token with the
// `integration` scope (master token also works). Per-request middleware:
//
//   - X-FG-Contract-Version is recorded and logged; mismatches respond
//     with a 426 Upgrade Required (only for actively incompatible majors).
//   - X-Request-Id idempotency dedupe on POST/PATCH (24h cache).
//   - X-Source-App / X-Source-Tenant are recorded on writes for audit
//     attribution and to drive school-hint routing on outbound webhooks.
//   - GET responses set ETag + Cache-Control.
//   - PATCH responses honour If-Match (412 Precondition Failed on mismatch).
//
// Internally the router delegates to:
//   server/integration/objects.js       — FG row → API shape converters
//   server/integration/consents.js      — photo/directory consent CRUD
//   server/integration/certifications.js — EIM cert history
//   server/integration/schoolContext.js — enrichment snapshot upsert
//   server/integration/webhooks.js      — subscription mgmt + dispatcher
//   server/integration/changes.js       — incremental changed-since feeds
//   server/integration/etag.js          — ETag compute + If-Match match
//   server/integration/idempotency.js   — X-Request-Id cache

const express = require('express');
const log = require('../log');
const audit = require('../audit');
const people = require('../identity/people');
const families = require('../identity/families');
const contactsLib = require('../identity/contacts');
const aliases = require('../identity/aliases');
const { isValidCode } = require('../crypto/identifiers');

const { userFacingMessage } = require('./_errors');
const integration = require('../integration');
const objects = integration.objects;
const etag = integration.etag;
const idempotency = integration.idempotency;
const consents = integration.consents;
const certifications = integration.certifications;
const schoolContext = integration.schoolContext;
const webhooks = integration.webhooks;
const changes = integration.changes;
const dioceses = integration.dioceses;
const history = require('../identity/history');

const CONTRACT_VERSION = 'v0.1';
const ACCEPTED_VERSIONS = new Set([CONTRACT_VERSION]);
const READ_CACHE_SECONDS = 30;

// Helper: attach ETag + Cache-Control headers to a response body and send it.
function sendWithEtag(res, body, { cacheSeconds = READ_CACHE_SECONDS } = {}) {
  const tag = etag.compute(body);
  res.set('ETag', tag);
  res.set('Cache-Control', `private, max-age=${cacheSeconds}`);
  res.set('X-FG-Contract-Version', CONTRACT_VERSION);
  res.json(body);
}

// Helper: emit a webhook for an entity change. Best-effort; the webhook
// dispatcher will retry pending deliveries on its next tick. If no
// subscription matches the event/school combination, we silently no-op.
function emitWebhook(db, secrets, { event, personCode = null, familyCode = null, schoolHints = [], extra = null }) {
  try {
    webhooks.enqueue(db, secrets, { event, personCode, familyCode, schoolHints, extra });
  } catch (e) {
    log.warn('integration_webhook.enqueue_failed', { event, error: String(e && e.message || e) });
  }
}

// Build a 1-shot response capture that lets us cache the body alongside
// the status code for idempotency. Wraps both res.json and res.end so
// 204 No Content responses (e.g. DELETE endpoints) also dedupe on
// X-Request-Id retries.
function captureResponse(req, res, db) {
  const requestId = req.get('x-request-id') || null;
  if (!requestId) return; // Idempotency is opt-in per the contract.
  let captured = false;
  const doCapture = body => {
    if (captured) return;
    captured = true;
    try {
      idempotency.record(db, {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        body: body === undefined ? null : body,
      });
    } catch (e) {
      log.warn('integration_idempotency.record_failed', { request_id: requestId, error: String(e && e.message || e) });
    }
  };
  const origJson = res.json.bind(res);
  res.json = body => {
    doCapture(body);
    return origJson(body);
  };
  const origEnd = res.end.bind(res);
  res.end = function endWrapped(chunk, encoding, cb) {
    // res.end can be called bare for empty-body responses (e.g.
    // res.status(204).end()) — in that case body is null and we still
    // want the status code captured so a retry replays the 204.
    if (!captured) doCapture(null);
    return origEnd(chunk, encoding, cb);
  };
}

function build({ db, secrets }) {
  const r = express.Router();

  // ---- Per-request middleware ----
  r.use((req, res, next) => {
    // Record incoming contract version. We don't reject on missing version
    // (some early Integration clients may not set it); we log it.
    const v = req.get('x-fg-contract-version') || null;
    req.fgContract = {
      version: v,
      sourceApp: req.get('x-source-app') || 'integration',
      sourceTenant: req.get('x-source-tenant') || null,
      requestId: req.get('x-request-id') || null,
    };
    if (v && !ACCEPTED_VERSIONS.has(v)) {
      // Major-version mismatch: reject. Minor compatibility is on the
      // honor system until the contract document codifies it.
      log.warn('integration_contract_version.mismatch', { version: v, path: req.path, method: req.method });
      return res.status(426).json({
        error: 'upgrade_required',
        detail: `unsupported X-FG-Contract-Version: ${v}`,
        supported: [...ACCEPTED_VERSIONS],
      });
    }
    res.set('X-FG-Contract-Version', CONTRACT_VERSION);
    next();
  });

  // ---- Idempotency replay middleware ----
  // Applies to every write method (POST/PATCH/DELETE). DELETE is
  // included because §7.2 of the contract says "retries on flaky
  // networks don't double-create" — and an over-eager DELETE retry
  // can double-affect state just as easily as a POST (e.g. clearing
  // a consent override that the operator re-set in between attempts).
  r.use((req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return next();
    const requestId = req.get('x-request-id');
    if (!requestId) return next();
    const cached = idempotency.lookup(db, { requestId, method: req.method, path: req.path });
    if (cached) {
      log.debug('integration_idempotency.replay', { request_id: requestId, path: req.path, status: cached.status });
      res.set('X-FG-Idempotent-Replay', 'true');
      // A cached null body indicates the original response was an empty
      // 204 (or other no-body status). Replay with `.end()` rather than
      // `.json(null)` so the app receives the same wire shape as the first call.
      if (cached.body == null) return res.status(cached.status).end();
      return res.status(cached.status).json(cached.body);
    }
    captureResponse(req, res, db);
    next();
  });

  // ===========================================================================
  // PERSONS — read
  // ===========================================================================

  // GET /v1/persons?email=...
  // GET /v1/persons/changed?since=...
  r.get('/persons', (req, res) => {
    const email = req.query.email;
    if (email) {
      const code = objects.personByEmail(db, secrets, email);
      // Audit BOTH the hit and the miss so an enumeration campaign is
      // visible. The miss audit records a stable HMAC of the queried
      // email so a distinct-miss count is observable per actor — but
      // never the email itself.
      const enc = require('../crypto/encryption');
      const queryHash = enc.hmac(secrets, enc.normalizeEmail(email));
      audit.record(db, {
        action: code ? 'integration_person_lookup_email' : 'integration_person_lookup_email_miss',
        actor: req.auth?.actor || 'integration',
        entityCode: code || null,
        entityKind: 'person',
        metadata: code
          ? { query_hash: queryHash ? queryHash.slice(0, 16) : null }
          : { hit: false, query_hash: queryHash ? queryHash.slice(0, 16) : null },
      });
      if (!code) return res.status(404).json({ error: 'not_found' });
      const obj = objects.personObject(db, secrets, code);
      if (!obj) return res.status(404).json({ error: 'not_found' });
      return sendWithEtag(res, { person: obj });
    }
    return res.status(400).json({ error: 'email_or_changed_required' });
  });

  r.get('/persons/changed', (req, res) => {
    try {
      const result = changes.listChangedPersons(db, secrets, req.query.since, {
        limit: Number(req.query.limit) || 200,
      });
      return sendWithEtag(res, result, { cacheSeconds: 5 });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/persons/:personId', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const obj = objects.personObject(db, secrets, req.params.personId);
    if (!obj) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_person_read',
      actor: req.auth?.actor || 'integration',
      entityCode: obj.personId,
      entityKind: 'person',
    });
    return sendWithEtag(res, { person: obj });
  });

  // GET /v1/persons/:id/schoolContext — the read side of §7.3.
  r.get('/persons/:personId/schoolContext', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const target = aliases.resolveAlias(db, req.params.personId);
    const schoolId = req.query.schoolId || req.query.school_id;
    if (schoolId) {
      const one = schoolContext.getOne(db, target, schoolId);
      if (!one) return res.status(404).json({ error: 'not_found' });
      return sendWithEtag(res, { schoolContext: one });
    }
    return sendWithEtag(res, { items: schoolContext.listForPerson(db, target) });
  });

  // ===========================================================================
  // PERSONS — write
  // ===========================================================================

  // POST /v1/persons — suggest a new identity.
  r.post('/persons', (req, res) => {
    const body = req.body || {};
    if (!body.firstName && !body.given_name && !body.lastName && !body.family_name) {
      return res.status(400).json({ error: 'firstName or lastName required' });
    }
    const createPatch = {
      given_name: body.firstName || body.given_name,
      family_name: body.lastName || body.family_name,
      middle_name: body.middleName || body.middle_name || null,
      preferred_name: body.preferredName || body.preferred_name || null,
      display_name: body.displayName || body.display_name || null,
      date_of_birth: body.dateOfBirth || body.date_of_birth || null,
      kind: body.kind || null,
    };
    let code;
    try {
      code = people.create(db, secrets, createPatch);
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    // Attach contact rows. We accept either primaryEmail (string) or
    // emails (array) plus phones (array) so the app client can hydrate as
    // much or as little as it has.
    const emailsIn = []
      .concat(body.primaryEmail ? [{ value: body.primaryEmail, is_primary: true }] : [])
      .concat(Array.isArray(body.additionalEmails) ? body.additionalEmails.map(v => ({ value: v, is_primary: false })) : [])
      .concat(Array.isArray(body.emails) ? body.emails.map(e => typeof e === 'string' ? { value: e } : e) : []);
    for (const e of emailsIn) {
      if (!e.value) continue;
      const ec = contactsLib.upsertEmail(db, secrets, e.value);
      if (ec) contactsLib.attachEmailToPerson(db, code, ec, { isPrimary: !!e.is_primary });
    }
    if (Array.isArray(body.phones)) {
      for (const p of body.phones) {
        const val = (p && (p.value || p.raw || p.e164)) || null;
        if (!val) continue;
        const ph = contactsLib.upsertPhone(db, secrets, val, {
          kind: p.type || p.kind || 'other',
          smsConsent: !!p.smsConsent,
        });
        if (ph) contactsLib.attachPhoneToPerson(db, code, ph, { isPrimary: !!p.is_primary });
      }
    }
    // Optional mailing address attached at the person level.
    if (body.mailingAddress && typeof body.mailingAddress === 'object') {
      const a = body.mailingAddress;
      const ac = contactsLib.upsertAddress(db, secrets, {
        line1: a.line1, line2: a.line2,
        city: a.city, region: a.state || a.region,
        postal: a.postal, country: a.country || 'US',
      });
      if (ac) contactsLib.attachAddressToPerson(db, code, ac, { label: 'home', isPrimary: true });
    }
    audit.record(db, {
      action: 'integration_person_create',
      actor: req.auth?.actor || 'integration',
      entityCode: code,
      entityKind: 'person',
      metadata: { source_app: req.fgContract.sourceApp, source_tenant: req.fgContract.sourceTenant },
    });
    const obj = objects.personObject(db, secrets, code);
    const tag = etag.compute({ person: obj });
    res.set('ETag', tag);
    res.set('X-FG-Contract-Version', CONTRACT_VERSION);
    emitWebhook(db, secrets, {
      event: 'person.updated',
      personCode: code,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return res.status(201).json({ person: obj });
  });

  // PATCH /v1/persons/:id — update contact fields. Honors If-Match.
  r.patch('/persons/:personId', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const current = objects.personObject(db, secrets, req.params.personId);
    if (!current) return res.status(404).json({ error: 'not_found' });
    const ifMatch = req.get('if-match');
    if (ifMatch) {
      const currentTag = etag.compute({ person: current });
      if (!etag.matches(ifMatch, currentTag)) {
        log.warn('integration_etag.mismatch', { person: current.personId, provided: ifMatch });
        return res.status(412).json({ error: 'precondition_failed', detail: 'ETag mismatch — re-fetch and retry' });
      }
    }
    const body = req.body || {};
    const patch = {};
    if ('firstName' in body) patch.given_name = body.firstName;
    if ('lastName' in body) patch.family_name = body.lastName;
    if ('middleName' in body) patch.middle_name = body.middleName;
    if ('preferredName' in body) patch.preferred_name = body.preferredName;
    if ('displayName' in body) patch.display_name = body.displayName;
    if ('dateOfBirth' in body) patch.date_of_birth = body.dateOfBirth;
    if ('kind' in body) patch.kind = body.kind;
    try {
      people.update(db, secrets, current.personId, patch);
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    // Email / phone updates.
    if (Array.isArray(body.additionalEmails)) {
      for (const v of body.additionalEmails) {
        const ec = contactsLib.upsertEmail(db, secrets, v);
        if (ec) contactsLib.attachEmailToPerson(db, current.personId, ec, { isPrimary: false });
      }
    }
    if (body.primaryEmail) {
      const ec = contactsLib.upsertEmail(db, secrets, body.primaryEmail);
      if (ec) contactsLib.attachEmailToPerson(db, current.personId, ec, { isPrimary: true });
    }
    if (Array.isArray(body.phones)) {
      for (const p of body.phones) {
        const val = (p && (p.value || p.raw || p.e164)) || null;
        if (!val) continue;
        const ph = contactsLib.upsertPhone(db, secrets, val, {
          kind: p.type || p.kind || 'other',
          smsConsent: !!p.smsConsent,
        });
        if (ph) contactsLib.attachPhoneToPerson(db, current.personId, ph, { isPrimary: !!p.is_primary });
      }
    }
    if (body.mailingAddress && typeof body.mailingAddress === 'object') {
      const a = body.mailingAddress;
      const ac = contactsLib.upsertAddress(db, secrets, {
        line1: a.line1, line2: a.line2,
        city: a.city, region: a.state || a.region,
        postal: a.postal, country: a.country || 'US',
      });
      if (ac) contactsLib.attachAddressToPerson(db, current.personId, ac, { label: 'home', isPrimary: true });
    }
    audit.record(db, {
      action: 'integration_person_update',
      actor: req.auth?.actor || 'integration',
      entityCode: current.personId,
      entityKind: 'person',
      metadata: { fields: Object.keys(body || {}), source_app: req.fgContract.sourceApp },
    });
    const obj = objects.personObject(db, secrets, current.personId);
    emitWebhook(db, secrets, {
      event: 'person.updated',
      personCode: obj.personId,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return sendWithEtag(res, { person: obj });
  });

  // POST /v1/persons/:id/photoConsent — update consent.
  // When the body or query carries a `schoolId`, the write targets the
  // per-school override row (migration 0013). When `schoolId` is absent,
  // the identity-level base is updated as before.
  r.post('/persons/:personId/photoConsent', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const body = req.body || {};
    const schoolId = body.schoolId || body.school_id || req.query.schoolId || null;
    const auditMeta = {
      photo_consent: body.photoConsent || null,
      directory_listing: body.directoryListing || null,
    };
    const audCtx = {
      actor: req.auth?.actor || 'integration',
      actorKind: req.auth?.kind || null,
      requestId: req.fgContract.requestId || null,
    };
    try {
      if (schoolId) {
        consents.setOverride(db, req.params.personId, schoolId, {
          photoConsent: body.photoConsent || body.photo_consent,
          directoryListing: body.directoryListing || body.directory_listing,
        }, audCtx);
        auditMeta.school_id = schoolId;
        auditMeta.scope = 'school_override';
      } else {
        consents.set(db, req.params.personId, {
          photoConsent: body.photoConsent || body.photo_consent,
          directoryListing: body.directoryListing || body.directory_listing,
        }, audCtx);
        auditMeta.scope = 'identity_base';
      }
    } catch (e) {
      const m = userFacingMessage(e);
      if (/not found/.test(m)) return res.status(404).json({ error: 'not_found' });
      return res.status(400).json({ error: m });
    }
    audit.record(db, {
      action: 'integration_consent_update',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.personId,
      entityKind: 'person',
      metadata: auditMeta,
    });
    emitWebhook(db, secrets, {
      event: 'consent.updated',
      personCode: req.params.personId,
      schoolHints: schoolId ? [schoolId]
        : (req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : []),
      extra: schoolId ? { schoolId } : null,
    });
    const responseConsent = objects.consentObject(db, req.params.personId, schoolId || null);
    return res.json({ consent: responseConsent });
  });

  // DELETE /v1/persons/:id/photoConsent?schoolId=... — clear a per-school override.
  r.delete('/persons/:personId/photoConsent', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const schoolId = req.query.schoolId || req.query.school_id;
    if (!schoolId) return res.status(400).json({ error: 'schoolId required to clear an override' });
    try {
      consents.clearOverride(db, req.params.personId, schoolId, {
        actor: req.auth?.actor || 'integration',
        actorKind: req.auth?.kind || null,
        requestId: req.fgContract.requestId || null,
      });
    } catch (e) {
      const m = userFacingMessage(e);
      if (/not found/.test(m)) return res.status(404).json({ error: 'not_found' });
      return res.status(400).json({ error: m });
    }
    audit.record(db, {
      action: 'integration_consent_override_clear',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.personId, entityKind: 'person',
      metadata: { school_id: schoolId },
    });
    emitWebhook(db, secrets, {
      event: 'consent.updated', personCode: req.params.personId,
      schoolHints: [schoolId], extra: { schoolId },
    });
    return res.status(204).end();
  });

  // GET /v1/persons/:id/consent/overrides — list every per-school override
  // that's active for this person. Useful for the operator UI that wants
  // to render "Annie has 2 overrides — at St Theresa and St John's".
  r.get('/persons/:personId/consent/overrides', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const items = consents.listOverridesForPerson(db, req.params.personId);
    return sendWithEtag(res, { items });
  });

  // POST /v1/persons/:id/eimCertifications — add/extend EIM cert.
  r.post('/persons/:personId/eimCertifications', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    let code;
    try {
      code = certifications.add(db, secrets, req.params.personId, req.body || {});
    } catch (e) {
      const m = userFacingMessage(e);
      if (/not found/.test(m)) return res.status(404).json({ error: 'not_found' });
      return res.status(400).json({ error: m });
    }
    audit.record(db, {
      action: 'integration_eim_cert_add',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.personId,
      entityKind: 'person',
      metadata: { cert: code, source_app: req.fgContract.sourceApp },
    });
    emitWebhook(db, secrets, {
      event: 'person.updated',
      personCode: req.params.personId,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return res.status(201).json({
      code,
      certifications: certifications.listForPerson(db, secrets, req.params.personId, { includePii: false }),
    });
  });

  // POST /v1/persons/:id/schoolContext — enrichment snapshot upsert.
  r.post('/persons/:personId/schoolContext', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const body = req.body || {};
    body.source_app = req.fgContract.sourceApp;
    try {
      schoolContext.upsert(db, req.params.personId, body);
    } catch (e) {
      const m = userFacingMessage(e);
      if (/not found/.test(m)) return res.status(404).json({ error: 'not_found' });
      return res.status(400).json({ error: m });
    }
    audit.record(db, {
      action: 'integration_school_context_upsert',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.personId,
      entityKind: 'person',
      metadata: {
        school_id: body.schoolId || body.school_id,
        school_year: body.schoolYear || body.school_year || null,
        grade: body.grade || null,
      },
    });
    const stored = schoolContext.getOne(db, req.params.personId, body.schoolId || body.school_id);
    return res.status(201).json({ schoolContext: stored });
  });

  // POST /v1/persons/:id/archive — soft-delete. Status flips to
  // 'archived'; the row stays in place and the entity_changes log
  // captures the pre-archive snapshot. Fires a `person.deleted` webhook.
  r.post('/persons/:personId/archive', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    let result;
    try {
      result = people.archive(db, req.params.personId, {
        actor: req.auth?.actor || 'integration',
        actorKind: req.auth?.kind || null,
        reason: req.body?.reason || null,
        requestId: req.fgContract.requestId || null,
      });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    if (!result) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_person_archive',
      actor: req.auth?.actor || 'integration',
      entityCode: result.code, entityKind: 'person',
      metadata: { noop: !!result.noop, reason: req.body?.reason || null },
    });
    emitWebhook(db, secrets, {
      event: 'person.deleted',
      personCode: result.code,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return res.json({ person: objects.personObject(db, secrets, result.code), noop: !!result.noop });
  });

  // POST /v1/persons/:id/reinstate — reverse an archive. Fires a
  // `person.updated` webhook so app caches reload the (now active) record.
  r.post('/persons/:personId/reinstate', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    let result;
    try {
      result = people.reinstate(db, req.params.personId, {
        actor: req.auth?.actor || 'integration',
        actorKind: req.auth?.kind || null,
        reason: req.body?.reason || null,
        requestId: req.fgContract.requestId || null,
      });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    if (!result) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_person_reinstate',
      actor: req.auth?.actor || 'integration',
      entityCode: result.code, entityKind: 'person',
      metadata: { noop: !!result.noop, reason: req.body?.reason || null },
    });
    emitWebhook(db, secrets, {
      event: 'person.updated',
      personCode: result.code,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return res.json({ person: objects.personObject(db, secrets, result.code), noop: !!result.noop });
  });

  // GET /v1/persons/:id/history — entity_changes log scoped to this person.
  // Returns full snapshot rows so the caller can render a timeline of
  // changes (and ask "show me what this person looked like before May 1").
  r.get('/persons/:personId/history', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const items = history.listFor(db, 'person', req.params.personId, {
      limit: Number(req.query.limit) || 100,
    });
    return sendWithEtag(res, { items }, { cacheSeconds: 5 });
  });

  // ===========================================================================
  // HOUSEHOLDS
  // ===========================================================================

  r.get('/households', (req, res) => {
    const personId = req.query.personId;
    if (!personId) return res.status(400).json({ error: 'personId required' });
    if (!isValidCode(personId, 'person')) return res.status(400).json({ error: 'invalid_person_id' });
    const fc = objects.householdForPerson(db, personId);
    if (!fc) return res.status(404).json({ error: 'not_found' });
    const obj = objects.householdObject(db, secrets, fc);
    return sendWithEtag(res, { household: obj });
  });

  r.get('/households/changed', (req, res) => {
    try {
      const result = changes.listChangedHouseholds(db, secrets, req.query.since, {
        limit: Number(req.query.limit) || 200,
      });
      return sendWithEtag(res, result, { cacheSeconds: 5 });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/households/:householdId', (req, res) => {
    if (!isValidCode(req.params.householdId, 'family')) {
      return res.status(400).json({ error: 'invalid_household_id' });
    }
    const obj = objects.householdObject(db, secrets, req.params.householdId);
    if (!obj) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_household_read',
      actor: req.auth?.actor || 'integration',
      entityCode: obj.householdId,
      entityKind: 'family',
    });
    return sendWithEtag(res, { household: obj });
  });

  r.post('/households', (req, res) => {
    const body = req.body || {};
    const code = families.create(db, secrets, {
      display_name: body.displayName || body.display_name || null,
    });
    if (body.communicationLanguage || body.primaryContactPersonId) {
      families.update(db, secrets, code, {
        communication_language: body.communicationLanguage || body.communication_language || 'en',
        primary_contact_person_code: body.primaryContactPersonId || body.primary_contact_person_code || null,
      });
    }
    // Optional members[] supplied at create time.
    if (Array.isArray(body.members)) {
      for (const m of body.members) {
        const role = objects.roleToInternal(m.role) || 'member';
        const personId = m.personId || m.person_id;
        if (!personId || !isValidCode(personId, 'person')) continue;
        families.addMember(db, secrets, code, personId, {
          role,
          relationLabel: m.role || null,
          custody: m.custodial ? 'joint' : 'other_guardian',
        });
      }
    }
    audit.record(db, {
      action: 'integration_household_create',
      actor: req.auth?.actor || 'integration',
      entityCode: code,
      entityKind: 'family',
      metadata: { source_app: req.fgContract.sourceApp, source_tenant: req.fgContract.sourceTenant },
    });
    const obj = objects.householdObject(db, secrets, code);
    emitWebhook(db, secrets, {
      event: 'household.updated',
      familyCode: code,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    res.status(201).json({ household: obj });
  });

  r.post('/households/:householdId/members', (req, res) => {
    if (!isValidCode(req.params.householdId, 'family')) {
      return res.status(400).json({ error: 'invalid_household_id' });
    }
    const body = req.body || {};
    const personId = body.personId || body.person_id;
    if (!isValidCode(personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const internalRole = objects.roleToInternal(body.role) || 'member';
    const custody = body.custodial ? 'joint' : 'other_guardian';
    let mc;
    try {
      mc = families.addMember(db, secrets, req.params.householdId, personId, {
        role: internalRole,
        relationLabel: body.role || null,
        custody,
      });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    // Bump the family's updated_at so the changed-households feed sees the
    // new membership.
    families.touchUpdatedAt(db, req.params.householdId);
    audit.record(db, {
      action: 'integration_household_add_member',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.householdId,
      entityKind: 'family',
      metadata: { person: personId, role: body.role, custodial: !!body.custodial },
    });
    emitWebhook(db, secrets, {
      event: 'household.updated',
      familyCode: req.params.householdId,
      personCode: personId,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    const obj = objects.householdObject(db, secrets, req.params.householdId);
    res.status(201).json({ household: obj, membership_code: mc });
  });

  // POST /v1/households/:id/archive — soft-delete the household.
  r.post('/households/:householdId/archive', (req, res) => {
    if (!isValidCode(req.params.householdId, 'family')) {
      return res.status(400).json({ error: 'invalid_household_id' });
    }
    let result;
    try {
      result = families.archive(db, req.params.householdId, {
        actor: req.auth?.actor || 'integration',
        actorKind: req.auth?.kind || null,
        reason: req.body?.reason || null,
        requestId: req.fgContract.requestId || null,
      });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    if (!result) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_household_archive',
      actor: req.auth?.actor || 'integration',
      entityCode: result.code, entityKind: 'family',
      metadata: { noop: !!result.noop, reason: req.body?.reason || null },
    });
    emitWebhook(db, secrets, {
      event: 'household.deleted', familyCode: result.code,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return res.json({ household: objects.householdObject(db, secrets, result.code), noop: !!result.noop });
  });

  r.post('/households/:householdId/reinstate', (req, res) => {
    if (!isValidCode(req.params.householdId, 'family')) {
      return res.status(400).json({ error: 'invalid_household_id' });
    }
    let result;
    try {
      result = families.reinstate(db, req.params.householdId, {
        actor: req.auth?.actor || 'integration',
        actorKind: req.auth?.kind || null,
        reason: req.body?.reason || null,
        requestId: req.fgContract.requestId || null,
      });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    if (!result) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_household_reinstate',
      actor: req.auth?.actor || 'integration',
      entityCode: result.code, entityKind: 'family',
      metadata: { noop: !!result.noop, reason: req.body?.reason || null },
    });
    emitWebhook(db, secrets, {
      event: 'household.updated', familyCode: result.code,
      schoolHints: req.fgContract.sourceTenant ? [req.fgContract.sourceTenant] : [],
    });
    return res.json({ household: objects.householdObject(db, secrets, result.code), noop: !!result.noop });
  });

  r.get('/households/:householdId/history', (req, res) => {
    if (!isValidCode(req.params.householdId, 'family')) {
      return res.status(400).json({ error: 'invalid_household_id' });
    }
    const items = history.listFor(db, 'family', req.params.householdId, {
      limit: Number(req.query.limit) || 100,
    });
    return sendWithEtag(res, { items }, { cacheSeconds: 5 });
  });

  // ===========================================================================
  // DIOCESES — system-of-record for EIM
  // ===========================================================================

  r.get('/dioceses', (req, res) => {
    const status = req.query.status || 'active';
    const items = dioceses.list(db, secrets, {
      status,
      includeNotes: req.query.includeNotes === '1' || req.query.include_notes === '1',
    });
    return sendWithEtag(res, { items });
  });

  r.post('/dioceses', (req, res) => {
    let code;
    try {
      code = dioceses.create(db, secrets, req.body || {}, {
        actor: req.auth?.actor || 'integration',
        actorKind: req.auth?.kind || null,
        requestId: req.fgContract.requestId || null,
      });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    audit.record(db, {
      action: 'integration_diocese_create',
      actor: req.auth?.actor || 'integration',
      entityCode: code, entityKind: 'diocese',
    });
    res.status(201).json({ diocese: dioceses.get(db, secrets, code, { includeNotes: true }) });
  });

  r.get('/dioceses/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'diocese')) {
      return res.status(400).json({ error: 'invalid_diocese_code' });
    }
    const obj = dioceses.get(db, secrets, req.params.code, {
      includeNotes: req.query.includeNotes === '1' || req.query.include_notes === '1',
    });
    if (!obj) return res.status(404).json({ error: 'not_found' });
    return sendWithEtag(res, { diocese: obj });
  });

  r.patch('/dioceses/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'diocese')) {
      return res.status(400).json({ error: 'invalid_diocese_code' });
    }
    const result = dioceses.update(db, secrets, req.params.code, req.body || {}, {
      actor: req.auth?.actor || 'integration',
      actorKind: req.auth?.kind || null,
      requestId: req.fgContract.requestId || null,
      ifMatch: req.get('if-match') || null,
    });
    if (result === null) return res.status(404).json({ error: 'not_found' });
    if (result === dioceses.ETAG_MISMATCH) {
      return res.status(412).json({ error: 'precondition_failed', detail: 'ETag mismatch — re-fetch and retry' });
    }
    audit.record(db, {
      action: 'integration_diocese_update',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.code, entityKind: 'diocese',
    });
    return res.json({ diocese: dioceses.get(db, secrets, req.params.code, { includeNotes: true }) });
  });

  r.post('/dioceses/:code/archive', (req, res) => {
    if (!isValidCode(req.params.code, 'diocese')) {
      return res.status(400).json({ error: 'invalid_diocese_code' });
    }
    const result = dioceses.archive(db, req.params.code, {
      actor: req.auth?.actor || 'integration',
      actorKind: req.auth?.kind || null,
      reason: req.body?.reason || null,
      requestId: req.fgContract.requestId || null,
    });
    if (!result) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_diocese_archive',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.code, entityKind: 'diocese',
    });
    return res.json({ diocese: dioceses.get(db, secrets, req.params.code, { includeNotes: true }), noop: !!result.noop });
  });

  r.post('/dioceses/:code/reinstate', (req, res) => {
    if (!isValidCode(req.params.code, 'diocese')) {
      return res.status(400).json({ error: 'invalid_diocese_code' });
    }
    const result = dioceses.reinstate(db, req.params.code, {
      actor: req.auth?.actor || 'integration',
      actorKind: req.auth?.kind || null,
      reason: req.body?.reason || null,
      requestId: req.fgContract.requestId || null,
    });
    if (!result) return res.status(404).json({ error: 'not_found' });
    audit.record(db, {
      action: 'integration_diocese_reinstate',
      actor: req.auth?.actor || 'integration',
      entityCode: req.params.code, entityKind: 'diocese',
    });
    return res.json({ diocese: dioceses.get(db, secrets, req.params.code, { includeNotes: true }), noop: !!result.noop });
  });

  // ===========================================================================
  // CONSENTS (read-side)
  // ===========================================================================

  // GET /v1/persons/:id/consent — identity-level base by default.
  // GET /v1/persons/:id/consent?schoolId=... — effective consent with
  // the per-school override merged in. The base values ride along under
  // `basePhotoConsent` / `baseDirectoryListing` so the caller knows
  // which fields were overridden.
  r.get('/persons/:personId/consent', (req, res) => {
    if (!isValidCode(req.params.personId, 'person')) {
      return res.status(400).json({ error: 'invalid_person_id' });
    }
    const schoolId = req.query.schoolId || req.query.school_id || null;
    const obj = objects.consentObject(db, req.params.personId, schoolId);
    return sendWithEtag(res, { consent: obj });
  });

  // ===========================================================================
  // WEBHOOKS — subscription management
  // ===========================================================================

  r.post('/webhooks', (req, res) => {
    try {
      const sub = webhooks.subscribe(db, secrets, req.body || {});
      res.status(201).json({ subscription: sub });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/webhooks', (req, res) => {
    res.json({ items: webhooks.list(db, secrets) });
  });

  r.get('/webhooks/:code', (req, res) => {
    const sub = webhooks.get(db, secrets, req.params.code);
    if (!sub) return res.status(404).json({ error: 'not_found' });
    res.json({ subscription: sub });
  });

  r.delete('/webhooks/:code', (req, res) => {
    const ok = webhooks.unsubscribe(db, req.params.code);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  r.get('/webhooks/:code/deliveries', (req, res) => {
    const items = webhooks.listDeliveries(db, {
      subscriptionCode: req.params.code,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 100,
    });
    res.json({ items });
  });

  return r;
}

module.exports = build;
module.exports.CONTRACT_VERSION = CONTRACT_VERSION;
