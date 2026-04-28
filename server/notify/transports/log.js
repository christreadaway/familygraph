'use strict';

const fs = require('fs');
const path = require('path');

// Log transport. Appends a JSONL line per message to a file under
// $SANCTUS_HOME. Used in tests and as the default when no Postmark token is
// configured — the operator can verify what *would* have been sent before
// flipping the transport to postmark.

function send({ logPath }, msg) {
  if (!logPath) return Promise.reject(new Error('log transport: logPath required'));
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
  }) + '\n';
  fs.appendFileSync(logPath, line, { mode: 0o600 });
  return Promise.resolve({ provider_message_id: null });
}

module.exports = { send };
