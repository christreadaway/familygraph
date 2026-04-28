'use strict';

// Alias table is the permanent record of merges. The loser code redirects to
// the winner. Calls that pass an alias get transparently followed.

function resolveAlias(db, code) {
  if (!code) return null;
  // Walk up the alias chain; defensive against accidental cycles.
  const seen = new Set();
  let cur = code;
  while (!seen.has(cur)) {
    seen.add(cur);
    const row = db.prepare('SELECT target_code FROM aliases WHERE alias_code = ?').get(cur);
    if (!row) break;
    cur = row.target_code;
  }
  return cur;
}

function recordAlias(db, aliasCode, targetCode, kind) {
  // If aliasCode itself was already an alias for something else, that something
  // else also redirects to target.
  const existing = db.prepare('SELECT target_code FROM aliases WHERE alias_code = ?').get(aliasCode);
  if (existing) {
    if (existing.target_code !== targetCode) {
      db.prepare('UPDATE aliases SET target_code = ? WHERE alias_code = ?').run(targetCode, aliasCode);
    }
    return;
  }
  db.prepare(
    'INSERT INTO aliases (alias_code, target_code, kind) VALUES (?, ?, ?)'
  ).run(aliasCode, targetCode, kind);

  // Re-point any prior aliases that targeted aliasCode to target.
  db.prepare('UPDATE aliases SET target_code = ? WHERE target_code = ?').run(targetCode, aliasCode);
}

module.exports = { resolveAlias, recordAlias };
