'use strict';

// Audit context forwarded from the HTTP layer into the entity_changes
// snapshot log, so every before/after row names the human or app that
// made the change ("any change must have an audit trail — with
// attribution"). One definition; every router uses it. When staff
// sessions grow new attribution fields (session_code, org_code already
// ride on req.auth), they get added here once.
function auditCtx(req) {
  return {
    actor: req.auth?.actor || 'unknown',
    actorKind: req.auth?.kind || null,
    requestId: req.get('x-request-id') || null,
  };
}

module.exports = { auditCtx };
