'use strict';

const https = require('https');

// Postmark transport. Uses the Email API directly — no SDK dependency.
// Server token comes from the CUSTOS_POSTMARK_TOKEN env var (never stored
// in the database). The `from` address and message stream live in settings.
//
// Postmark response shape (success):
//   { ErrorCode: 0, Message: "OK", MessageID: "...", To: "...", SubmittedAt }
// Failure:
//   ErrorCode != 0 with a `Message` describing the cause.

const HOST = 'api.postmarkapp.com';
const PATH = '/email';

function send({ token, from, messageStream }, msg) {
  if (!token) return Promise.reject(new Error('postmark: missing CUSTOS_POSTMARK_TOKEN'));
  if (!from) return Promise.reject(new Error('postmark: missing postmark.from setting'));
  const payload = JSON.stringify({
    From: from,
    To: msg.to,
    Subject: msg.subject,
    TextBody: msg.text,
    HtmlBody: msg.html,
    MessageStream: messageStream || 'outbound',
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: HOST,
      path: PATH,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) { /* leave null */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed && parsed.ErrorCode === 0) {
          resolve({ provider_message_id: parsed.MessageID || null, raw: parsed });
          return;
        }
        const detail = parsed?.Message || `HTTP ${res.statusCode}`;
        const err = new Error(`postmark: ${detail}`);
        err.status = res.statusCode;
        err.body = parsed || buf;
        // 4xx (except 429) is not retryable; everything else is.
        err.retryable = !(res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429);
        reject(err);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('postmark: timeout')); });
    req.on('error', e => {
      const err = new Error(`postmark: ${e.message}`);
      err.retryable = true; // network errors are always retryable
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { send };
