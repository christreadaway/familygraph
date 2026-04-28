#!/usr/bin/env node
'use strict';

const cmd = process.argv[2];

switch (cmd) {
  case 'start':
  case undefined: {
    require('../server').start();
    break;
  }
  case 'rotate-secret': {
    const config = require('../server/config');
    const secret = require('../server/crypto/secret');
    const next = secret.rotate(config.secretPath);
    // eslint-disable-next-line no-console
    console.log(`[sanctus] rotated master token (length=${next.master.length}). Apps must restart to re-fetch.`);
    break;
  }
  case 'backup': {
    const config = require('../server/config');
    const dbm = require('../server/db');
    const backup = require('../server/backup');
    const db = dbm.init(config.dbPath);
    backup
      .hotBackup(db, config.backupsDir, { passphrase: process.argv[3] || null })
      .then(p => {
        // eslint-disable-next-line no-console
        console.log(`[sanctus] backup written to ${p}`);
        db.close();
      });
    break;
  }
  case 'restore': {
    const passphrase = process.argv[3];
    const src = process.argv[4];
    const dest = process.argv[5];
    if (!src || !dest) {
      // eslint-disable-next-line no-console
      console.error('usage: sanctus restore <passphrase> <backup-file> <db-out>');
      process.exit(2);
    }
    const backup = require('../server/backup');
    backup.decryptedRestore(src, dest, passphrase);
    // eslint-disable-next-line no-console
    console.log(`[sanctus] restored to ${dest}`);
    break;
  }
  case 'show-token': {
    const config = require('../server/config');
    const secret = require('../server/crypto/secret');
    const s = secret.load(config.secretPath);
    // eslint-disable-next-line no-console
    console.log(s.master);
    break;
  }
  case 'list-backups': {
    const fs = require('fs');
    const path = require('path');
    const config = require('../server/config');
    const dir = config.backupsDir;
    if (!fs.existsSync(dir)) { console.log('(no backups directory)'); break; }
    const items = fs
      .readdirSync(dir)
      .filter(n => /\.(sqlite|sanctus-backup)$/i.test(n))
      .map(n => {
        const st = fs.statSync(path.join(dir, n));
        return { name: n, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    if (items.length === 0) { console.log('(no backup files)'); break; }
    for (const it of items) {
      // eslint-disable-next-line no-console
      console.log(`${it.mtime}  ${String(it.size).padStart(10)}  ${it.name}`);
    }
    break;
  }
  case 'prune-backups': {
    const fs = require('fs');
    const path = require('path');
    const config = require('../server/config');
    const keep = Math.max(1, Number(process.argv[3] || 10));
    const dir = config.backupsDir;
    if (!fs.existsSync(dir)) { console.log('(no backups directory)'); break; }
    const items = fs
      .readdirSync(dir)
      .filter(n => /\.(sqlite|sanctus-backup)$/i.test(n))
      .map(n => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtime }))
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    const toDelete = items.slice(keep);
    for (const it of toDelete) fs.unlinkSync(path.join(dir, it.name));
    // eslint-disable-next-line no-console
    console.log(`[sanctus] kept ${Math.min(items.length, keep)} of ${items.length} backups; deleted ${toDelete.length}`);
    break;
  }
  case 'status': {
    const config = require('../server/config');
    const dbm = require('../server/db');
    const profiles = require('../server/identity/profiles');
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(config.dbPath)) {
      console.log(`[sanctus] no database at ${config.dbPath}; run 'sanctus start' once.`);
      break;
    }
    const db = dbm.init(config.dbPath);
    const families = db.prepare("SELECT COUNT(*) AS c FROM families WHERE status = 'active'").get().c;
    const persons = db.prepare("SELECT COUNT(*) AS c FROM persons WHERE status = 'active'").get().c;
    const audit = db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c;
    const conflicts = db.prepare("SELECT COUNT(*) AS c FROM conflicts WHERE status = 'open'").get().c;
    const apiKeys = db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL").get().c;
    const active = profiles.active(db);
    const backups = fs.existsSync(config.backupsDir)
      ? fs.readdirSync(config.backupsDir).filter(n => /\.(sqlite|sanctus-backup)$/i.test(n)).length
      : 0;
    const schema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    db.close();
    // eslint-disable-next-line no-console
    console.log(`Sanctus status
  home:           ${config.home}
  db:             ${config.dbPath}
  schema version: ${schema}
  watch dir:      ${config.watchDir}
  out dir:        ${config.outDir}
  active profile: ${active ? active.name : '(none)'}
  active families: ${families}
  active persons:  ${persons}
  open conflicts:  ${conflicts}
  active api keys: ${apiKeys}
  audit events:    ${audit}
  backups on disk: ${backups}`);
    break;
  }
  default: {
    // eslint-disable-next-line no-console
    console.error(`unknown command: ${cmd}`);
    // eslint-disable-next-line no-console
    console.error('commands: start | status | rotate-secret | backup [passphrase] | restore <passphrase> <src> <dest> | show-token | list-backups | prune-backups [keep=10]');
    process.exit(2);
  }
}
