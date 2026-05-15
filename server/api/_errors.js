'use strict';

// HTTP response helpers shared across the API surface.
//
// The original handlers tended to do `res.status(400).json({ error: String(e.message || e) })`.
// That pattern leaks internal detail when the error came from a layer below — SQLite
// constraint messages, file-system error codes, network stack traces. This module
// centralises the "what's safe to send back to the caller" decision.
//
// Two helpers:
//   userFacingMessage(err) — coerce ANY thrown error into a string we're willing
//     to return on the wire. Library throws (e.g. `throw new Error('invalid kind')`)
//     pass through; SQLite / OS errors are normalised to a generic shape.
//   safeError(log, res, status, code, err, extra?) — log the full detail
//     server-side, send a sanitised body to the caller.

// Patterns that indicate a low-level error worth hiding from the caller.
const _GENERIC_PATTERNS = [
  { re: /^SQLITE_/,                            replace: 'database error' },
  { re: /^UNIQUE constraint failed/i,          replace: 'already exists or conflicts with existing record' },
  { re: /^CHECK constraint failed/i,           replace: 'value not allowed' },
  { re: /^FOREIGN KEY constraint failed/i,     replace: 'referenced record not found' },
  { re: /^NOT NULL constraint failed/i,        replace: 'required field missing' },
  { re: /^E[A-Z]+: /,                          replace: 'file system error' },
  { re: /^getaddrinfo /,                       replace: 'upstream not reachable' },
  { re: /^connect /,                           replace: 'upstream not reachable' },
  // Node.js TypeErrors/ReferenceErrors don't include the class prefix in
  // .message — match the canonical message bodies instead.
  { re: /^Cannot read prop(erty|erties) /,     replace: 'internal error' },
  { re: /^Cannot destructure /,                replace: 'internal error' },
  { re: /^undefined is not /,                  replace: 'internal error' },
  { re: /is not defined$/,                     replace: 'internal error' },
  { re: /^Unexpected token /,                  replace: 'invalid syntax' },
];

function userFacingMessage(err) {
  const raw = err && err.message ? String(err.message) : String(err || 'error');
  // Strip stack trace if present (defensive — Error.message normally doesn't include it).
  const oneLine = raw.split('\n')[0];
  for (const { re, replace } of _GENERIC_PATTERNS) {
    if (re.test(oneLine)) return replace;
  }
  // Cap length so a runaway library doesn't return a 4KB string.
  if (oneLine.length > 240) return oneLine.slice(0, 240);
  return oneLine;
}

// Helper for the common pattern:
//   catch (e) { return safeError(log, res, 400, 'invalid_input', e); }
// Logs the full error context server-side; returns a sanitised body on the wire.
function safeError(log, res, status, code, err, extra = {}) {
  try {
    log.error(`handler.${code}`, {
      status,
      message: err && err.message,
      stack: err && err.stack,
      ...extra,
    });
  } catch (_) { /* logger failure must not break the response path */ }
  return res.status(status).json({
    error: code,
    detail: userFacingMessage(err),
  });
}

module.exports = { userFacingMessage, safeError };
