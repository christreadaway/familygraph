'use strict';

const { newCode } = require('../crypto/identifiers');
const audit = require('../audit');

// Profiles bundle resolver thresholds + a default rule set + dashboard-visible
// preferences for a particular institutional segment. They are operator-set,
// not derived; on first run a built-in catalog is offered.
//
// config_json shape:
//   {
//     thresholds: { autoMerge, review },
//     custody: { default: 'joint' | 'sole' | 'unspecified' },
//     surfaces: { ai: 'pseudonyms_only' },         // never written, documented only
//     description: string
//   }

const BUILTIN_PROFILES = [
  {
    name: 'catholic_school',
    config: {
      description: 'A K-12 Catholic school. Families resolve by surname + address. Joint custody is the default.',
      thresholds: { autoMerge: 0.92, review: 0.7 },
      custody: { default: 'joint' },
    },
  },
  {
    name: 'parish_donor',
    config: {
      description: 'A parish development office. Donor giving history attaches by Custos codes; resolver tolerates more variance because donor records are messier.',
      thresholds: { autoMerge: 0.94, review: 0.65 },
      custody: { default: 'unspecified' },
    },
  },
  {
    name: 'diocese',
    config: {
      description: 'A diocesan office combining school, parish, and HR data. Resolver thresholds err on the side of conflict-queue review.',
      thresholds: { autoMerge: 0.95, review: 0.6 },
      custody: { default: 'unspecified' },
    },
  },
];

function ensureBuiltins(db) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO profiles (code, name, config_json) VALUES (?, ?, ?)`
  );
  for (const p of BUILTIN_PROFILES) {
    stmt.run(newCode('profile'), p.name, JSON.stringify(p.config));
  }
}

function list(db) {
  return db
    .prepare('SELECT * FROM profiles ORDER BY name ASC')
    .all()
    .map(r => ({ ...r, config: JSON.parse(r.config_json) }));
}

function get(db, name) {
  const row = db.prepare('SELECT * FROM profiles WHERE name = ?').get(name);
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config_json) };
}

function activate(db, name) {
  const p = get(db, name);
  if (!p) throw new Error(`unknown profile: ${name}`);
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value_json) VALUES ('active_profile', ?)`
  ).run(JSON.stringify(name));
  audit.record(db, { action: 'profile_activate', actor: 'operator', metadata: { name } });
  return p;
}

function active(db) {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = 'active_profile'").get();
  if (!row) return null;
  const name = JSON.parse(row.value_json);
  return get(db, name);
}

// thresholdsFor: returns the resolver thresholds to use, taking into account
// the active profile if any.
function thresholdsFor(db, fallback) {
  const p = active(db);
  if (p && p.config && p.config.thresholds) {
    return { ...fallback, ...p.config.thresholds };
  }
  return fallback;
}

module.exports = { ensureBuiltins, list, get, activate, active, thresholdsFor, BUILTIN_PROFILES };
