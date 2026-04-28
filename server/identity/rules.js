'use strict';

// Resolution-rule engine. Operator-curated overrides on top of the resolver's
// statistical scoring. Rules are stored encrypted-free as JSON in
// `resolution_rules.rule_json` because they describe *patterns over normalized
// values* and never contain raw PII themselves.
//
// Rule shape:
//   {
//     match: {
//       given_name?:    string (normalized, exact match on HMAC)
//       family_name?:   string
//       email_domain?:  string  e.g. "stmichaelparish.org"
//       postal?:        string
//     },
//     action: 'auto_merge' | 'never_merge' | 'boost' | 'penalize',
//     weight: number    // 0..1 boost/penalize, ignored for auto_merge/never_merge
//   }
//
// Match semantics:
//   - all keys present in `match` must satisfy.
//   - missing keys mean "any value acceptable".
//
// Application of rules during resolution:
//   - any rule with action 'never_merge' that matches BOTH the incoming and
//     candidate suppresses the pair regardless of score.
//   - any 'auto_merge' rule that matches both forces score = 1.
//   - 'boost' / 'penalize' rules adjust the score by ±weight, clamped to [0,1].

const { newCode } = require('../crypto/identifiers');
const enc = require('../crypto/encryption');
const audit = require('../audit');

const VALID_ACTIONS = new Set(['auto_merge', 'never_merge', 'boost', 'penalize']);

function _validate(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('rule must be an object');
  if (!VALID_ACTIONS.has(rule.action)) throw new Error(`unknown rule.action: ${rule.action}`);
  if (rule.action === 'boost' || rule.action === 'penalize') {
    if (typeof rule.weight !== 'number' || rule.weight < 0 || rule.weight > 1) {
      throw new Error('rule.weight must be in [0,1] for boost/penalize');
    }
  }
  if (!rule.match || typeof rule.match !== 'object') throw new Error('rule.match required');
}

function create(db, { kind, rule, enabled = true }) {
  if (kind !== 'family' && kind !== 'person') throw new Error('kind must be family or person');
  _validate(rule);
  const code = newCode('rule');
  db.prepare(
    `INSERT INTO resolution_rules (code, kind, rule_json, enabled) VALUES (?, ?, ?, ?)`
  ).run(code, kind, JSON.stringify(rule), enabled ? 1 : 0);
  audit.record(db, { action: 'rule_create', actor: 'operator', metadata: { rule_code: code, kind } });
  return code;
}

function update(db, code, patch) {
  const row = db.prepare('SELECT * FROM resolution_rules WHERE code = ?').get(code);
  if (!row) return null;
  const cur = JSON.parse(row.rule_json);
  const next = { ...cur, ...(patch.rule || {}) };
  if (patch.rule) _validate(next);
  const enabled = 'enabled' in patch ? (patch.enabled ? 1 : 0) : row.enabled;
  db.prepare('UPDATE resolution_rules SET rule_json = ?, enabled = ? WHERE code = ?')
    .run(JSON.stringify(next), enabled, code);
  audit.record(db, { action: 'rule_update', actor: 'operator', metadata: { rule_code: code } });
  return code;
}

function remove(db, code) {
  audit.record(db, { action: 'rule_delete', actor: 'operator', metadata: { rule_code: code } });
  return db.prepare('DELETE FROM resolution_rules WHERE code = ?').run(code).changes;
}

function list(db, { kind = null, enabledOnly = false } = {}) {
  const filters = [];
  const params = [];
  if (kind) { filters.push('kind = ?'); params.push(kind); }
  if (enabledOnly) filters.push('enabled = 1');
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM resolution_rules ${where} ORDER BY created_at DESC`)
    .all(...params)
    .map(r => ({ ...r, rule: JSON.parse(r.rule_json), enabled: !!r.enabled }));
}

function loadActive(db, kind) {
  return list(db, { kind, enabledOnly: true });
}

// matchSide(rule, person, secrets, context):
//   does this rule match the given side (incoming OR candidate)?
function matchSide(rule, person, _secrets, context = {}) {
  const m = rule.match || {};
  const norm = (v) => enc.normalizeName(v);
  if (m.given_name && norm(m.given_name) !== norm(person.given_name)) return false;
  if (m.family_name && norm(m.family_name) !== norm(person.family_name)) return false;
  if (m.postal && context.postal && String(m.postal).toLowerCase() !== String(context.postal).toLowerCase()) {
    return false;
  }
  if (m.email_domain) {
    const domain = (context.email || '').split('@')[1] || '';
    if (domain.toLowerCase() !== String(m.email_domain).toLowerCase()) return false;
  }
  return true;
}

// applyToScore: given the raw score and reasons, return the rule-adjusted
// score + appended reasons + a possible override.
//   override: 'never' | 'force' | null
function applyToScore(rules, scoreInfo, incoming, candidate, contexts = {}) {
  let score = scoreInfo.score;
  const reasons = [...(scoreInfo.reasons || [])];
  let override = null;
  for (const r of rules) {
    const incomingCtx = contexts.incoming || {};
    const candidateCtx = contexts.candidate || {};
    if (!matchSide(r.rule, incoming, null, incomingCtx)) continue;
    if (!matchSide(r.rule, candidate, null, candidateCtx)) continue;
    switch (r.rule.action) {
      case 'never_merge':
        override = 'never';
        reasons.push(`rule:${r.code}:never_merge`);
        break;
      case 'auto_merge':
        override = override === 'never' ? override : 'force';
        reasons.push(`rule:${r.code}:auto_merge`);
        break;
      case 'boost':
        score = Math.min(1, score + r.rule.weight);
        reasons.push(`rule:${r.code}:boost+${r.rule.weight}`);
        break;
      case 'penalize':
        score = Math.max(0, score - r.rule.weight);
        reasons.push(`rule:${r.code}:penalize-${r.rule.weight}`);
        break;
    }
  }
  if (override === 'never') score = 0;
  if (override === 'force') score = 1;
  return { score, reasons, override };
}

module.exports = { create, update, remove, list, loadActive, applyToScore };
