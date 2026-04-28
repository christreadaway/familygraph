'use strict';

const log = require('./index');

// Express middleware: log every request once it finishes. Captures method,
// path, query (without body), status, latency, the auth actor (if the
// downstream auth middleware populated req.auth), and the client IP. We
// don't log the request body — bodies can contain PII. Headers are not
// logged either; the Authorization header is sensitive.
function requestLogger() {
  return function requestLoggerMw(req, res, next) {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        actor: (req.auth && req.auth.actor) || null,
        ip: req.socket && req.socket.remoteAddress,
      };
      const level = res.statusCode >= 500 ? 'error'
                  : res.statusCode >= 400 ? 'warn'
                  : 'info';
      log[level]('http', fields);
    });
    next();
  };
}

// Express error-handler. Logs the stack (always, regardless of HTTP status)
// and forwards the original error so other handlers can render the response.
function errorLogger() {
  return function errorLoggerMw(err, req, res, next) {
    log.error('unhandled', {
      method: req.method,
      path: req.path,
      message: String(err && err.message ? err.message : err),
      stack: err && err.stack ? err.stack : null,
    });
    next(err);
  };
}

module.exports = { requestLogger, errorLogger };
