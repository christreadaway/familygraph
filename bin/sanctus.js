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
  default: {
    // eslint-disable-next-line no-console
    console.error(`unknown command: ${cmd}`);
    // eslint-disable-next-line no-console
    console.error('commands: start | rotate-secret | backup [passphrase] | restore <passphrase> <src> <dest> | show-token');
    process.exit(2);
  }
}
