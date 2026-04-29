'use strict';

// Shared fixtures for the dashboard end-to-end suite. The Playwright
// webServer (see ../playwright.config.js) boots a fresh Family Graph
// against a temp $FAMILY_GRAPH_HOME, so each test run starts with an
// empty database. We seed the API directly via fetch (faster + more
// deterministic than driving the UI for set-up data).

const fs = require('fs');
const path = require('path');
const { test: base, expect } = require('@playwright/test');

function readMasterToken() {
  // Walk every /tmp/fg-pw-<pid>/secret.key — the webServer process is the
  // most recent.
  const candidates = fs.readdirSync('/tmp')
    .filter(d => d.startsWith('fg-pw-'))
    .map(d => path.join('/tmp', d, 'secret.key'))
    .filter(p => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) throw new Error('no fg-pw secret.key found');
  const j = JSON.parse(fs.readFileSync(candidates[0], 'utf8'));
  return j.master;
}

// Pre-seed the dashboard with a verified Bearer token so the TokenBanner
// doesn't gate every test. The dashboard validates by hitting /api/families
// on first read, so we POST it once via fetch before the page loads.
async function authedPage(context) {
  const token = readMasterToken();
  await context.addInitScript(t => {
    window.localStorage.setItem('family-graph.bearer', t);
    // Default to PII view in tests so the rendered DOM contains the human
    // names + DOBs we assert on. The product default is pseudonym, which
    // redacts these in the surface.
    window.localStorage.setItem('fg-state', JSON.stringify({ view: 'pii' }));
  }, token);
  return token;
}

// API helper bound to a context's baseURL — handy for seeding rows the
// browser then reads.
function makeApi(request, token) {
  const headers = {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'x-family-graph-actor': 'e2e',
  };
  return {
    headers,
    async post(path, body) {
      const r = await request.post(path, { headers, data: body });
      if (!r.ok()) throw new Error(`POST ${path} → ${r.status()} ${await r.text()}`);
      return r.json();
    },
    async get(path) {
      const r = await request.get(path, { headers });
      if (!r.ok()) throw new Error(`GET ${path} → ${r.status()} ${await r.text()}`);
      return r.json();
    },
    async patch(path, body) {
      const r = await request.fetch(path, { method: 'PATCH', headers, data: body });
      if (!r.ok()) throw new Error(`PATCH ${path} → ${r.status()} ${await r.text()}`);
      return r.json();
    },
  };
}

const test = base.extend({
  // Provides each test a context with the token already in localStorage and
  // a small `api` helper for direct REST seeding.
  fg: async ({ context, request }, use) => {
    const token = await authedPage(context);
    const api = makeApi(request, token);
    await use({ token, api });
  },
});

module.exports = { test, expect, readMasterToken, makeApi };
