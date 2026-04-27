'use strict';

const express = require('express');
const { SCHEMA_VERSION } = require('../db');

function build({ db }) {
  const r = express.Router();
  r.get('/', (req, res) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch (_) {
      dbOk = false;
    }
    res.json({
      status: dbOk ? 'ok' : 'degraded',
      schema: SCHEMA_VERSION,
      time: new Date().toISOString(),
    });
  });
  return r;
}

module.exports = build;
