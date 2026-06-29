'use strict';

// Aggregator for the Integration contract helpers. The HTTP router in
// server/api/integration.js imports from here; tests that exercise the
// helper modules directly can do the same.

module.exports = {
  objects: require('./objects'),
  etag: require('./etag'),
  idempotency: require('./idempotency'),
  consents: require('./consents'),
  certifications: require('./certifications'),
  schoolContext: require('./schoolContext'),
  webhooks: require('./webhooks'),
  federation: require('./federation'),
  changes: require('./changes'),
  dioceses: require('./dioceses'),
  // Option A outbound dialer (FG → ParentPoint). No inbound surface.
  pairing: require('./pairing'),
  envelope: require('./envelope'),
  outboundAgent: require('./outbound-agent'),
  outboundScheduler: require('./outbound-scheduler'),
};
