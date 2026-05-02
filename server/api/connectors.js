'use strict';

const express = require('express');

const credentials = require('../connectors/credentials');
const runs = require('../connectors/runs');
const registry = require('../connectors');

function _summary(db, secrets, name) {
  const desc = credentials.describe(db, secrets, name);
  const last = runs.lastRun(db, name);
  const lastOk = runs.lastSuccessful(db, name);
  const failures = runs.consecutiveFailures(db, name);
  let status = 'untested';
  if (last) status = last.status;
  return {
    ...desc,
    status,
    last_run: last,
    last_successful_run: lastOk,
    consecutive_failures: failures,
  };
}

function build({ db, secrets, thresholds }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const items = registry.names().map(n => _summary(db, secrets, n));
    res.json({ items });
  });

  r.get('/:name', (req, res) => {
    if (!credentials.isValidName(req.params.name)) {
      return res.status(404).json({ error: `unknown connector: ${req.params.name}` });
    }
    res.json({ connector: _summary(db, secrets, req.params.name) });
  });

  r.post('/:name/credentials', (req, res) => {
    if (!credentials.isValidName(req.params.name)) {
      return res.status(404).json({ error: `unknown connector: ${req.params.name}` });
    }
    try {
      const out = credentials.set(db, secrets, req.params.name, req.body || {}, {
        actor: req.auth?.actor || 'operator',
      });
      res.status(200).json({ connector: out });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/:name/credentials', (req, res) => {
    if (!credentials.isValidName(req.params.name)) {
      return res.status(404).json({ error: `unknown connector: ${req.params.name}` });
    }
    credentials.clear(db, secrets, req.params.name, { actor: req.auth?.actor || 'operator' });
    res.status(204).end();
  });

  r.patch('/:name', (req, res) => {
    if (!credentials.isValidName(req.params.name)) {
      return res.status(404).json({ error: `unknown connector: ${req.params.name}` });
    }
    try {
      const body = req.body || {};
      const allowed = {};
      if ('enabled' in body) allowed.enabled = !!body.enabled;
      if ('schedule' in body) allowed.schedule = body.schedule;
      const out = credentials.set(db, secrets, req.params.name, allowed, {
        actor: req.auth?.actor || 'operator',
      });
      res.json({ connector: out });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.post('/:name/test', async (req, res) => {
    if (!credentials.isValidName(req.params.name)) {
      return res.status(404).json({ error: `unknown connector: ${req.params.name}` });
    }
    try {
      const out = await registry.testConnection(db, secrets, req.params.name, {
        actor: req.auth?.actor || 'operator',
      });
      res.json({ ok: true, sample_count: out.sample_count || 0 });
    } catch (e) {
      const reason = e.reason || 'http_error';
      const code = reason === 'auth_failed' ? 401 : reason === 'config_error' ? 400 : 502;
      res.status(code).json({ ok: false, reason, error: String(e.message || e) });
    }
  });

  // POST /api/connectors/:name/sync — kicks off a sync in the background
  // and returns 202 immediately with the run code. The dashboard polls
  // /api/connector-runs/:code for live progress and the eventual final
  // state. Pre-flight failures (bad name, missing credentials, already-
  // running) are surfaced inline; everything else lives on the
  // connector_runs row.
  r.post('/:name/sync', (req, res) => {
    if (!credentials.isValidName(req.params.name)) {
      return res.status(404).json({ error: `unknown connector: ${req.params.name}` });
    }
    try {
      const { run_code } = registry.startSyncBackground(db, secrets, thresholds, req.params.name, {
        trigger: 'manual',
        actor: req.auth?.actor || 'operator',
      });
      res.status(202).json({ ok: true, run_code, status: 'running' });
    } catch (e) {
      const reason = e.reason || 'http_error';
      const code = reason === 'config_error' ? 400
                 : reason === 'already_running' ? 409
                 : reason === 'unknown_connector' ? 404
                 : 400;
      res.status(code).json({ ok: false, reason, error: String(e.message || e) });
    }
  });

  return r;
}

function buildRunsRouter({ db }) {
  const r = express.Router();
  r.get('/', (req, res) => {
    const items = runs.list(db, {
      connector: req.query.connector || null,
      status: req.query.status || null,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    res.json({ items });
  });
  r.get('/:code', (req, res) => {
    const row = runs.get(db, req.params.code);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ run: row });
  });
  return r;
}

module.exports = build;
module.exports.buildRunsRouter = buildRunsRouter;
