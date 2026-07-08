'use strict';

// Structured JSON logger. Every line is one JSON object with a stable shape:
//   { t: ISO-8601, level, msg, ...extra-fields }
//
// Output goes to stderr by default (so stdout stays clean for piping). When
// FAMILY_GRAPH_LOG_FILE is set, a copy is appended to that file as well — handy
// for service deployments where stderr isn't captured by anything.
//
// Levels (low → high): debug · info · warn · error. Only entries at or above
// `FAMILY_GRAPH_LOG_LEVEL` are emitted (default: info). The dispatcher writes
// every request, every auth failure (with a reason code), and every unhandled
// error with its stack — so when the operator says "I keep getting
// unauthorized", we look at the log and see exactly which middleware
// rejected the call and why.

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function _resolveLevel(name) {
  const k = String(name || 'info').toLowerCase();
  return LEVELS[k] != null ? LEVELS[k] : LEVELS.info;
}

let minLevel = _resolveLevel(process.env.FAMILY_GRAPH_LOG_LEVEL);
// We use synchronous appendFileSync rather than a write stream so that file
// output is observable immediately — tests can read the file right after
// emitting, and an operator tailing the file sees lines in real time without
// stream-buffer latency. At our log volume (~hundreds of lines/min) the
// per-line syscall is well within budget.
let _logFilePath = null;
// Size-based rotation cap. When the log file would grow past this, it is
// renamed to `<file>.1` (clobbering any previous .1) and a fresh file starts.
// One generation of history is enough for "paste the tail into a chat"
// debugging while guaranteeing disk usage stays bounded at ~2× the cap.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
let _maxBytes = _resolveMaxBytes(process.env.FAMILY_GRAPH_LOG_MAX_BYTES);

function _resolveMaxBytes(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

function _rotateIfNeeded() {
  // Synchronous and best-effort: a rotation failure must never take the
  // logger (let alone the app) down — worst case the file keeps growing
  // until the next append retries the rename.
  try {
    const st = fs.statSync(_logFilePath);
    if (st.size < _maxBytes) return;
    fs.renameSync(_logFilePath, `${_logFilePath}.1`);
  } catch (_) { /* ENOENT (fresh file) or rename failure — carry on */ }
}

let _redactKeys = new Set([
  'authorization', 'token', 'master', 'secret', 'password',
  // Connector OAuth credentials. Per PRD §11.2 — connector logs must
  // never leak vendor credentials even when caller explicitly passes them.
  'client_id', 'client_secret', 'access_token', 'refresh_token', 'bearer',
  'name', 'first_name', 'last_name', 'given_name', 'family_name',
  'email', 'phone', 'address', 'line1', 'line2', 'dob', 'date_of_birth',
  'plaintext', 'value',
]);

function _maybeRedact(obj, _seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return obj;
  if (_seen.has(obj)) return '[circular]';
  _seen.add(obj);
  if (Array.isArray(obj)) return obj.map(v => _maybeRedact(v, _seen));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (_redactKeys.has(String(k).toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = _maybeRedact(v, _seen);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function _emit(level, levelNum, msg, fields) {
  if (levelNum < minLevel) return;
  const entry = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(_maybeRedact(fields) || {}),
  };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch (e) {
    line = JSON.stringify({ t: entry.t, level, msg, _stringify_error: String(e.message || e) });
  }
  process.stderr.write(line + '\n');
  if (_logFilePath) {
    try {
      _rotateIfNeeded();
      fs.appendFileSync(_logFilePath, line + '\n', { mode: 0o600 });
    }
    catch (_) { /* swallow file errors so logging never crashes the app */ }
  }
}

function configure(opts = {}) {
  if (opts.level != null) minLevel = _resolveLevel(opts.level);
  if (opts.maxBytes != null) _maxBytes = _resolveMaxBytes(opts.maxBytes);
  if (opts.file !== undefined) {
    if (opts.file) {
      const dir = path.dirname(opts.file);
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
      _logFilePath = opts.file;
    } else {
      _logFilePath = null;
    }
  }
}

// Boot-time auto-configure from env. The server entry point can call
// configure() again later (e.g., to pick up a setting from the database).
function autoConfigureFromEnv() {
  if (process.env.FAMILY_GRAPH_LOG_FILE) {
    configure({ file: process.env.FAMILY_GRAPH_LOG_FILE });
  }
}

module.exports = {
  debug: (m, f) => _emit('debug', LEVELS.debug, m, f),
  info:  (m, f) => _emit('info',  LEVELS.info,  m, f),
  warn:  (m, f) => _emit('warn',  LEVELS.warn,  m, f),
  error: (m, f) => _emit('error', LEVELS.error, m, f),
  configure,
  autoConfigureFromEnv,
  LEVELS,
  // Exposed for tests:
  _redact: _maybeRedact,
};
