'use strict';

// Encrypted credential storage for connectors. Backed by the existing
// settings table, encrypted with the existing dataKey. Plaintext values are
// never returned by GET /api/settings — the read path here is only for the
// scheduler and the test/sync handlers that actually need to call the
// vendor API.
//
// Keys live under `connector.<name>.<field>`. The plain-text fields
// (api_base_url, access_token_url, schedule, enabled) are stored as raw
// JSON in settings; the secret fields (client_id, client_secret) are
// stored as a `_ct` ciphertext blob alongside, with the JSON value being
// the base64 of the ciphertext buffer so it round-trips through the
// existing settings table without schema changes.

const enc = require('../crypto/encryption');
const audit = require('../audit');

// Connectors recognised by the registry. Anything else is rejected at the
// API boundary. Adding a connector means: register here, add a module under
// server/connectors/<name>.js, and add the dashboard fields.
const CONNECTORS = new Set(['facts', 'ministry_platform']);

// Field map per connector. `secret: true` means encrypt-at-rest.
const FIELDS = {
  facts: [
    { name: 'api_base_url',     secret: false, required: true  },
    { name: 'access_token_url', secret: false, required: true  },
    { name: 'client_id',        secret: true,  required: true  },
    { name: 'client_secret',    secret: true,  required: true  },
  ],
  ministry_platform: [
    { name: 'api_base_url',          secret: false, required: true  },
    { name: 'oauth_discovery_url',   secret: false, required: false },
    { name: 'client_id',             secret: true,  required: true  },
    { name: 'client_secret',         secret: true,  required: true  },
  ],
};

const ALLOWED_SCHEDULES = new Set(['off', 'hourly', 'daily_2am', 'weekly_sun_2am']);

function isValidName(name) { return CONNECTORS.has(name); }
function fieldsFor(name) { return FIELDS[name] || []; }

function _put(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value));
}

function _get(db, key) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value_json); } catch (_) { return undefined; }
}

function _del(db, key) { db.prepare('DELETE FROM settings WHERE key = ?').run(key); }

function _settingKey(name, field) {
  return `connector.${name}.${field}`;
}

// Returns the plaintext credential bundle. Internal use only — never serve
// over HTTP. Any field that has not been set returns null.
function load(db, secrets, name) {
  if (!isValidName(name)) throw new Error(`unknown connector: ${name}`);
  const out = {
    name,
    enabled: _get(db, `connector.${name}.enabled`) === true,
    schedule: _get(db, `connector.${name}.schedule`) || 'off',
  };
  for (const f of fieldsFor(name)) {
    if (f.secret) {
      const b64 = _get(db, _settingKey(name, `${f.name}_ct`));
      if (b64) {
        try {
          const buf = Buffer.from(String(b64), 'base64');
          out[f.name] = enc.decrypt(secrets, buf);
        } catch (_) {
          out[f.name] = null;
        }
      } else {
        out[f.name] = null;
      }
    } else {
      const v = _get(db, _settingKey(name, f.name));
      out[f.name] = (v === undefined ? null : v);
    }
  }
  return out;
}

// Public-safe view: never includes plaintext secrets. The dashboard renders
// `••••••••` for any field marked `set: true`.
function describe(db, secrets, name) {
  if (!isValidName(name)) throw new Error(`unknown connector: ${name}`);
  const enabled = _get(db, `connector.${name}.enabled`) === true;
  const schedule = _get(db, `connector.${name}.schedule`) || 'off';
  const lastSyncAt = _get(db, `connector.${name}.last_sync_at`) || null;
  const lastModifiedCursor = _get(db, `connector.${name}.last_modified_cursor`) || null;
  const fields = {};
  for (const f of fieldsFor(name)) {
    if (f.secret) {
      const b64 = _get(db, _settingKey(name, `${f.name}_ct`));
      fields[f.name] = { set: !!b64 };
    } else {
      const v = _get(db, _settingKey(name, f.name));
      fields[f.name] = { set: v !== undefined && v !== null && v !== '', value: (v === undefined ? null : v) };
    }
  }
  return {
    name,
    enabled,
    schedule,
    last_sync_at: lastSyncAt,
    last_modified_cursor: lastModifiedCursor,
    fields,
  };
}

// Persist a partial update. Plaintext-only at the API boundary; the
// caller (the routes layer) has already authenticated. Empty / undefined
// values are ignored, so the dashboard can PATCH a single field without
// resending the others.
function set(db, secrets, name, payload, opts = {}) {
  if (!isValidName(name)) throw new Error(`unknown connector: ${name}`);
  const actor = opts.actor || 'operator';
  const updated = [];
  for (const f of fieldsFor(name)) {
    if (!Object.prototype.hasOwnProperty.call(payload, f.name)) continue;
    const v = payload[f.name];
    if (v == null || v === '') continue;
    if (f.secret) {
      const ct = enc.encrypt(secrets, String(v));
      _put(db, _settingKey(name, `${f.name}_ct`), Buffer.from(ct).toString('base64'));
    } else {
      _put(db, _settingKey(name, f.name), String(v));
    }
    updated.push(f.name);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
    _put(db, `connector.${name}.enabled`, !!payload.enabled);
    updated.push('enabled');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'schedule')) {
    if (!ALLOWED_SCHEDULES.has(payload.schedule)) {
      throw new Error(`schedule must be one of ${[...ALLOWED_SCHEDULES].join(', ')}`);
    }
    _put(db, `connector.${name}.schedule`, payload.schedule);
    updated.push('schedule');
  }
  if (updated.length) {
    audit.record(db, {
      action: 'connector_credential_set',
      actor,
      metadata: { connector: name, fields: updated },
    });
  }
  return describe(db, secrets, name);
}

function clear(db, secrets, name, opts = {}) {
  if (!isValidName(name)) throw new Error(`unknown connector: ${name}`);
  for (const f of fieldsFor(name)) {
    _del(db, _settingKey(name, f.name));
    _del(db, _settingKey(name, `${f.name}_ct`));
  }
  _del(db, `connector.${name}.enabled`);
  _del(db, `connector.${name}.schedule`);
  _del(db, `connector.${name}.last_sync_at`);
  _del(db, `connector.${name}.last_modified_cursor`);
  audit.record(db, {
    action: 'connector_credential_deleted',
    actor: opts.actor || 'operator',
    metadata: { connector: name },
  });
  return true;
}

function setLastSyncAt(db, name, unixMs) {
  _put(db, `connector.${name}.last_sync_at`, Number(unixMs));
}

function setLastModifiedCursor(db, name, isoString) {
  if (isoString) _put(db, `connector.${name}.last_modified_cursor`, String(isoString));
  else _del(db, `connector.${name}.last_modified_cursor`);
}

function isComplete(db, secrets, name) {
  const c = load(db, secrets, name);
  for (const f of fieldsFor(name)) {
    if (f.required && !c[f.name]) return false;
  }
  return true;
}

module.exports = {
  CONNECTORS,
  FIELDS,
  ALLOWED_SCHEDULES,
  isValidName,
  fieldsFor,
  load,
  describe,
  set,
  clear,
  setLastSyncAt,
  setLastModifiedCursor,
  isComplete,
};
