'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Backup format (single file):
//   [magic:8 'SANCTUS1'][iv:12][tag:16][ciphertext: gzip(<sqlite-bytes>)]
// The ciphertext is encrypted under a key derived from PBKDF2(passphrase, salt).
//
// For convenience, we also support an unencrypted backup (no passphrase) that
// just copies the .sqlite file to the backups directory. Apps that don't
// require encrypted backups (for example, when the OS already provides
// volume-level encryption) can use this path.

const MAGIC = Buffer.from('SANCTUS1', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF_ITER = 200_000;
const KEY_LEN = 32;

function encryptedBackup(dbPath, outPath, passphrase) {
  const dbBytes = fs.readFileSync(dbPath);
  const zlib = require('zlib');
  const compressed = zlib.gzipSync(dbBytes);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF_ITER, KEY_LEN, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([MAGIC, salt, iv, tag, ct]);
  fs.writeFileSync(outPath, blob, { mode: 0o600 });
  return outPath;
}

function decryptedRestore(backupPath, dbOutPath, passphrase) {
  const blob = fs.readFileSync(backupPath);
  if (!blob.slice(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Sanctus backup file');
  let offset = MAGIC.length;
  const salt = blob.subarray(offset, offset + SALT_LEN); offset += SALT_LEN;
  const iv = blob.subarray(offset, offset + IV_LEN); offset += IV_LEN;
  const tag = blob.subarray(offset, offset + TAG_LEN); offset += TAG_LEN;
  const ct = blob.subarray(offset);
  const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF_ITER, KEY_LEN, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ct), decipher.final()]);
  const zlib = require('zlib');
  const sqliteBytes = zlib.gunzipSync(compressed);
  fs.writeFileSync(dbOutPath, sqliteBytes, { mode: 0o600 });
  return dbOutPath;
}

function plainCopyBackup(dbPath, backupsDir) {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  const out = path.join(backupsDir, `sanctus-${stamp}.sqlite`);
  fs.copyFileSync(dbPath, out);
  fs.chmodSync(out, 0o600);
  return out;
}

// Use better-sqlite3's built-in backup API for a hot, consistent snapshot.
async function hotBackup(db, backupsDir, { passphrase = null } = {}) {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  const tmp = path.join(backupsDir, `.tmp-sanctus-${stamp}.sqlite`);
  await db.backup(tmp);
  if (passphrase) {
    const out = path.join(backupsDir, `sanctus-${stamp}.sanctus-backup`);
    encryptedBackup(tmp, out, passphrase);
    fs.unlinkSync(tmp);
    return out;
  }
  const out = path.join(backupsDir, `sanctus-${stamp}.sqlite`);
  fs.renameSync(tmp, out);
  fs.chmodSync(out, 0o600);
  return out;
}

module.exports = { hotBackup, plainCopyBackup, encryptedBackup, decryptedRestore };
