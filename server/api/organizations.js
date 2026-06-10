'use strict';

const { userFacingMessage } = require('./_errors');
const express = require('express');
const organizations = require('../identity/organizations');
const domains = require('../auth/domains');
const audit = require('../audit');
const { isValidCode } = require('../crypto/identifiers');

function build({ db, secrets, includePii }) {
  const r = express.Router();

  // Audit context forwarded into the entity_changes snapshot log so every
  // write records who did it (any change must have an audit trail).
  const ctx = req => ({
    actor: req.auth?.actor || 'unknown',
    actorKind: req.auth?.kind || null,
    requestId: req.get('x-request-id') || null,
  });

  // ---------------------------------------------------------------------------
  // Organization catalog (parishes / schools)
  // ---------------------------------------------------------------------------

  r.get('/', (req, res) => {
    res.json({
      items: organizations.listOrganizations(db, {
        status: req.query.status || 'active',
        kind: req.query.kind || null,
      }),
    });
  });

  r.post('/', (req, res) => {
    try {
      const code = organizations.createOrganization(db, secrets, req.body || {}, ctx(req));
      audit.record(db, {
        action: 'organization_create',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'organization',
        metadata: { name: req.body?.name, kind: req.body?.kind },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    const org = organizations.getOrganization(db, req.params.code);
    if (!org) return res.status(404).json({ error: 'not found' });
    const items = organizations.listAffiliations(db, secrets, {
      org_code: req.params.code,
      status: 'active',
      includePii,
    });
    res.json({ organization: org, affiliations: items });
  });

  r.patch('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    try {
      const code = organizations.updateOrganization(db, secrets, req.params.code, req.body || {}, ctx(req));
      if (!code) return res.status(404).json({ error: 'not found' });
      audit.record(db, {
        action: 'organization_update',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'organization',
      });
      res.json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.delete('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    const code = organizations.archiveOrganization(db, secrets, req.params.code, ctx(req));
    if (!code) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'organization_archive',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'organization',
    });
    res.status(204).end();
  });

  // The rolling-verification work queue: active affiliations nothing has
  // confirmed within the window (default one year). The operator works
  // this list down on their own rhythm; nothing here auto-expires.
  r.get('/:code/stale', (req, res) => {
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    const org = organizations.getOrganization(db, req.params.code);
    if (!org) return res.status(404).json({ error: 'not found' });
    const days = req.query.days ? Number(req.query.days) : 365;
    res.json({
      stale_days: Math.max(1, days || 365),
      items: organizations.listAffiliations(db, secrets, {
        org_code: req.params.code,
        status: 'active',
        stale_days: days,
        includePii,
      }),
    });
  });

  // ---------------------------------------------------------------------------
  // Domain verification (STAFF_ACCOUNTS_PRD.md) — master-only. Verified
  // domains are what make staff-account invitations trustworthy, so
  // only the operator's master token may set or verify one.
  // ---------------------------------------------------------------------------

  r.post('/:code/domain', (req, res) => {
    if (req.auth?.kind !== 'master') {
      return res.status(403).json({ error: 'forbidden', detail: 'domain management requires the master token' });
    }
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    try {
      const result = domains.setDomain(db, req.params.code, req.body?.domain ?? null, ctx(req));
      if (!result) return res.status(404).json({ error: 'not found' });
      audit.record(db, {
        action: 'organization_domain_set',
        actor: req.auth?.actor || 'unknown',
        entityCode: req.params.code,
        entityKind: 'organization',
        metadata: { domain: req.body?.domain || null },
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.post('/:code/domain/verify', async (req, res) => {
    if (req.auth?.kind !== 'master') {
      return res.status(403).json({ error: 'forbidden', detail: 'domain management requires the master token' });
    }
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    try {
      const result = await domains.verifyDomain(db, req.params.code, { method: req.body?.method }, ctx(req));
      if (!result) return res.status(404).json({ error: 'not found' });
      audit.record(db, {
        action: 'organization_domain_verify',
        actor: req.auth?.actor || 'unknown',
        entityCode: req.params.code,
        entityKind: 'organization',
        metadata: { method: req.body?.method, verified: result.verified },
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Affiliations
  // ---------------------------------------------------------------------------

  r.post('/:code/affiliations', (req, res) => {
    if (!isValidCode(req.params.code, 'organization')) {
      return res.status(400).json({ error: 'invalid organization code' });
    }
    try {
      const code = organizations.affiliate(db, secrets, req.params.code, req.body || {}, ctx(req));
      audit.record(db, {
        action: 'affiliation_create',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'affiliation',
        metadata: {
          org_code: req.params.code,
          person_code: req.body?.person_code,
          family_code: req.body?.family_code,
          role: req.body?.role,
        },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.delete('/affiliations/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'affiliation')) {
      return res.status(400).json({ error: 'invalid affiliation code' });
    }
    const code = organizations.endAffiliation(db, req.params.code, { reason: req.body?.reason, ...ctx(req) });
    if (!code) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'affiliation_end',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'affiliation',
      metadata: { reason: req.body?.reason || null },
    });
    res.status(204).end();
  });

  r.post('/affiliations/:code/verify', (req, res) => {
    if (!isValidCode(req.params.code, 'affiliation')) {
      return res.status(400).json({ error: 'invalid affiliation code' });
    }
    try {
      const code = organizations.verify(db, secrets, req.params.code, req.body || {}, ctx(req));
      if (!code) return res.status(404).json({ error: 'not found' });
      audit.record(db, {
        action: 'affiliation_verify',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'affiliation_verification',
        metadata: {
          affiliation_code: req.params.code,
          method: req.body?.method,
          source: req.body?.source,
        },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/affiliations/:code/verifications', (req, res) => {
    if (!isValidCode(req.params.code, 'affiliation')) {
      return res.status(400).json({ error: 'invalid affiliation code' });
    }
    res.json({
      items: organizations.listVerifications(db, secrets, req.params.code, {
        includePii,
        limit: req.query.limit,
      }),
    });
  });

  // ---------------------------------------------------------------------------
  // Convenience: the "parish, school, or both?" answer for one person or
  // family — computed from active affiliations, never stored.
  // ---------------------------------------------------------------------------

  r.get('/by-person/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    res.json({
      items: organizations.listAffiliations(db, secrets, {
        person_code: req.params.code,
        status: req.query.status || 'active',
        includePii,
      }),
    });
  });

  r.get('/by-family/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    res.json({
      items: organizations.listAffiliations(db, secrets, {
        family_code: req.params.code,
        status: req.query.status || 'active',
        includePii,
      }),
    });
  });

  return r;
}

module.exports = build;
