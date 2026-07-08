// Client-side structured log buffer for the dashboard.
//
// Mirrors the server logger's philosophy: the operator should be able to hit
// "Download log" (or "Copy log"), paste a few lines into a chat, and give a
// future debugging session a fighting chance. Entries live in an in-memory
// ring buffer (cap 1000), are mirrored to the browser console, and are
// persisted to sessionStorage best-effort so a reload doesn't wipe the trail.
//
// PII posture: every ctx object passes through the same key-based redactor
// the server uses (server/log/index.js `_redactKeys`) BEFORE it is buffered,
// so names/emails/tokens never sit in sessionStorage or a downloaded file.
//
// Line format (text()/download()/copy()):
//   [ISO timestamp] [level] [scope] message {json-context}
//
// This module is plain ESM JS (no JSX) and guards every window /
// sessionStorage / document touch so the pure parts run under node --test.

const MAX_ENTRIES = 1000;
const STORAGE_KEY = 'family-graph.client-log';

// Keep in lockstep with `_redactKeys` in server/log/index.js.
export const REDACT_KEYS = new Set([
  'authorization', 'token', 'master', 'secret', 'password',
  'client_id', 'client_secret', 'access_token', 'refresh_token', 'bearer',
  'name', 'first_name', 'last_name', 'given_name', 'family_name',
  'email', 'phone', 'address', 'line1', 'line2', 'dob', 'date_of_birth',
  'plaintext', 'value',
]);

export function redact(obj, _seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return obj;
  if (_seen.has(obj)) return '[circular]';
  _seen.add(obj);
  if (Array.isArray(obj)) return obj.map(v => redact(v, _seen));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(String(k).toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = redact(v, _seen);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function formatLine(entry) {
  // Null-guard: a poisoned sessionStorage restore (or any non-object slipping
  // into the buffer) must degrade to a visible placeholder line, never a
  // throw — text()/download()/copy() and the Diagnostics render all route
  // through here, and a throw here would take down the very surface the
  // operator needs to debug with.
  if (!entry || typeof entry !== 'object') {
    return `[unknown] [warn] [log] unrenderable log entry (${typeof entry})`;
  }
  let tail = '';
  if (entry.ctx !== undefined) {
    try { tail = ' ' + JSON.stringify(entry.ctx); }
    catch (_) { tail = ' {"_stringify_error":true}'; }
  }
  return `[${entry.ts}] [${entry.level}] [${entry.scope}] ${entry.msg}${tail}`;
}

// Shape check for entries restored from sessionStorage. Anything a prior
// page (or an extension, or a bug) left in storage that doesn't look like a
// real entry is dropped rather than allowed to poison the buffer.
function isValidEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && typeof e.ts === 'string' && typeof e.level === 'string'
    && typeof e.scope === 'string' && typeof e.msg === 'string';
}

function hasSessionStorage() {
  try { return typeof sessionStorage !== 'undefined' && !!sessionStorage; }
  catch (_) { return false; }
}

export function createLogBuffer(opts = {}) {
  const max = opts.max || MAX_ENTRIES;
  const mirror = opts.mirror !== false;
  const storageKey = opts.storageKey || STORAGE_KEY;
  const persist = opts.persist !== false && hasSessionStorage();

  let entries = [];
  let persistScheduled = false;
  let installed = false;

  // Restore prior entries from this browser session (best-effort).
  if (persist) {
    try {
      const raw = sessionStorage.getItem(storageKey);
      const prior = raw ? JSON.parse(raw) : null;
      // Validate element shape, not just array-ness: a stored `[null]` (or
      // any malformed element) would otherwise survive into the buffer and
      // crash every formatter downstream.
      if (Array.isArray(prior)) entries = prior.filter(isValidEntry).slice(-max);
    } catch (_) { /* corrupted or blocked storage — start clean */ }
  }

  function flushPersist() {
    if (!persist) return;
    // Only the most recent 400 entries — enough context, bounded write cost.
    try { sessionStorage.setItem(storageKey, JSON.stringify(entries.slice(-400))); }
    catch (_) { /* quota / private mode — logging never throws */ }
  }

  function schedulePersist() {
    if (!persist || persistScheduled) return;
    persistScheduled = true;
    // Coalesce bursts: one storage write per tickful of log calls.
    setTimeout(() => {
      persistScheduled = false;
      flushPersist();
    }, 250);
  }

  // The debounce above loses the final window before an unload — often the
  // very error that motivated the reload. Flush immediately on pagehide.
  if (persist && typeof window !== 'undefined'
      && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushPersist);
  }

  function push(level, scope, msg, ctx) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: String(msg),
      ...(ctx === undefined ? {} : { ctx: redact(ctx) }),
    };
    entries.push(entry);
    if (entries.length > max) entries.splice(0, entries.length - max);
    if (mirror && typeof console !== 'undefined') {
      const fn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : console.log;
      try { fn(`[fg:${scope}] ${entry.msg}`, entry.ctx !== undefined ? entry.ctx : ''); }
      catch (_) { /* console can be locked down; ignore */ }
    }
    // Errors are exactly the entries the operator reloads over — persist
    // them synchronously so they survive an immediate unload; everything
    // else takes the debounced path.
    if (level === 'error') flushPersist();
    else schedulePersist();
    return entry;
  }

  function text() {
    return entries.map(formatLine).join('\n');
  }

  const buf = {
    debug: (scope, msg, ctx) => push('debug', scope, msg, ctx),
    info: (scope, msg, ctx) => push('info', scope, msg, ctx),
    warn: (scope, msg, ctx) => push('warn', scope, msg, ctx),
    error: (scope, msg, ctx) => push('error', scope, msg, ctx),
    entries: () => entries.slice(),
    count: () => entries.length,
    text,
    clear() {
      entries = [];
      if (persist) {
        try { sessionStorage.removeItem(storageKey); } catch (_) { /* ignore */ }
      }
    },
    // Save the buffer as a .log file via a temporary anchor.
    download(filename = `family-graph-client-${new Date().toISOString().replace(/[:.]/g, '-')}.log`) {
      if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
      const blob = new Blob([text() + '\n'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    },
    // Copy the buffer to the clipboard. Returns a promise resolving true/false.
    async copy() {
      const t = text();
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(t);
          return true;
        }
      } catch (_) { /* fall through to legacy path */ }
      try {
        if (typeof document === 'undefined') return false;
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) { return false; }
    },
    // Wire window-level error capture into the buffer. Idempotent.
    install() {
      if (installed || typeof window === 'undefined') return;
      installed = true;
      window.addEventListener('error', (e) => {
        push('error', 'window', e.message || 'uncaught error', {
          source: e.filename || null,
          line: e.lineno || null,
          col: e.colno || null,
          stack: (e.error && e.error.stack) || null,
        });
      });
      window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        push('error', 'window', 'unhandled rejection', {
          message: r instanceof Error ? r.message : String(r),
          stack: r instanceof Error ? r.stack : null,
        });
      });
      push('info', 'app', 'client log buffer installed');
    },
  };
  return buf;
}

// App-wide singleton. Views import { log } and call log.info('scope', 'msg', ctx).
export const log = createLogBuffer();
export default log;
