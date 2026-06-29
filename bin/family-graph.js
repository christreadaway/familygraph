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
    console.log(`[family-graph] rotated master token (length=${next.master.length}). Apps must restart to re-fetch.`);
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
        console.log(`[family-graph] backup written to ${p}`);
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
      console.error('usage: family-graph restore <passphrase> <backup-file> <db-out>');
      process.exit(2);
    }
    const path = require('path');
    const config = require('../server/config');
    const backup = require('../server/backup');
    // Restrict the destination to paths under FAMILY_GRAPH_HOME so a
    // wrapped invocation (cron, supervisor, dropped-in shell hook)
    // can't be tricked into clobbering /etc/cron.d/ or a system path.
    // Operators who genuinely need to restore elsewhere can `cp` after.
    const resolvedDest = path.resolve(dest);
    const resolvedHome = path.resolve(config.home);
    const homePrefix = resolvedHome.endsWith(path.sep) ? resolvedHome : resolvedHome + path.sep;
    if (resolvedDest !== resolvedHome && !resolvedDest.startsWith(homePrefix)) {
      // eslint-disable-next-line no-console
      console.error(`[family-graph] restore destination must be under FAMILY_GRAPH_HOME (${resolvedHome}); got ${resolvedDest}`);
      process.exit(2);
    }
    backup.decryptedRestore(src, dest, passphrase);
    // eslint-disable-next-line no-console
    console.log(`[family-graph] restored to ${dest}`);
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
      .filter(n => /\.(sqlite|family-graph-backup)$/i.test(n))
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
      .filter(n => /\.(sqlite|family-graph-backup)$/i.test(n))
      .map(n => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtime }))
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    const toDelete = items.slice(keep);
    for (const it of toDelete) fs.unlinkSync(path.join(dir, it.name));
    // eslint-disable-next-line no-console
    console.log(`[family-graph] kept ${Math.min(items.length, keep)} of ${items.length} backups; deleted ${toDelete.length}`);
    break;
  }
  case 'status': {
    const config = require('../server/config');
    const dbm = require('../server/db');
    const profiles = require('../server/identity/profiles');
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(config.dbPath)) {
      console.log(`[family-graph] no database at ${config.dbPath}; run 'family-graph start' once.`);
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
      ? fs.readdirSync(config.backupsDir).filter(n => /\.(sqlite|family-graph-backup)$/i.test(n)).length
      : 0;
    const schema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    db.close();
    // eslint-disable-next-line no-console
    console.log(`Family Graph status
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
  case 'connector': {
    const sub = process.argv[3];
    const target = process.argv[4];
    const config = require('../server/config');
    const dbm = require('../server/db');
    const secret = require('../server/crypto/secret');
    const credentials = require('../server/connectors/credentials');
    const runsMod = require('../server/connectors/runs');
    const registry = require('../server/connectors');

    if (!['test', 'sync', 'status'].includes(sub)) {
      // eslint-disable-next-line no-console
      console.error('usage: family-graph connector <test|sync|status> [name]');
      process.exit(2);
    }
    const db = dbm.init(config.dbPath);
    const secrets = secret.load(config.secretPath);

    function fmtMs(ms) {
      if (!ms) return '(never)';
      return new Date(Number(ms)).toISOString();
    }

    if (sub === 'status') {
      for (const name of registry.names()) {
        const c = credentials.describe(db, secrets, name);
        const last = runsMod.lastRun(db, name);
        const lastOk = runsMod.lastSuccessful(db, name);
        // eslint-disable-next-line no-console
        console.log(`${name}`);
        console.log(`  enabled:           ${c.enabled}`);
        console.log(`  schedule:          ${c.schedule}`);
        console.log(`  last attempt:      ${last ? `${fmtMs(last.started_at)} (${last.status}${last.reason ? ': ' + last.reason : ''})` : '(none)'}`);
        console.log(`  last successful:   ${lastOk ? fmtMs(lastOk.started_at) : '(none)'}`);
        if (last && last.metadata && typeof last.metadata === 'object') {
          if (last.metadata.rows_pulled != null) console.log(`  rows pulled:       ${last.metadata.rows_pulled}`);
          if (last.metadata.families_created != null) console.log(`  families created:  ${last.metadata.families_created}`);
          if (last.metadata.families_attached != null) console.log(`  families attached: ${last.metadata.families_attached}`);
          if (last.metadata.conflicts_opened != null) console.log(`  conflicts opened:  ${last.metadata.conflicts_opened}`);
        }
      }
      db.close();
      break;
    }

    if (!target || !credentials.isValidName(target)) {
      // eslint-disable-next-line no-console
      console.error(`invalid connector name: ${target || '(missing)'}`);
      console.error(`valid names: ${[...credentials.CONNECTORS].join(', ')}`);
      process.exit(2);
    }

    const thresholds = config.resolverThresholds;
    (async () => {
      try {
        if (sub === 'test') {
          const out = await registry.testConnection(db, secrets, target, { actor: 'cli' });
          // eslint-disable-next-line no-console
          console.log(`ok (sample_count=${out.sample_count || 0})`);
        } else if (sub === 'sync') {
          const out = await registry.runSync(db, secrets, thresholds, target, { trigger: 'cli', actor: 'cli' });
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(out, null, 2));
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`error: ${e.reason || ''} ${e.message || e}`);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    })();
    break;
  }
  case 'pp-pairing': {
    // Configure / enable a ParentPoint (PP) outbound pairing. FG is the sole
    // initiator (Option A — "no open doors"): this only stores the dial-out
    // target + shared secrets and toggles the pairing. It opens no port.
    //
    //   pp-pairing list
    //   pp-pairing show <schoolId>
    //   pp-pairing set  <schoolId> key=value [key=value ...]
    //   pp-pairing enable  <schoolId>
    //   pp-pairing disable <schoolId>
    //   pp-pairing check-in <schoolId>     (run one check-in now)
    //   pp-pairing remove  <schoolId>
    //
    // set keys: pp_base_url, pp_bearer_credential, shared_webhook_secret,
    //           envelope_key (64 hex), check_in_interval_s.
    // Secrets are stored encrypted and never echoed back.
    const sub = process.argv[3];
    const schoolId = process.argv[4];
    const config = require('../server/config');
    const dbm = require('../server/db');
    const secret = require('../server/crypto/secret');
    const pairing = require('../server/integration/pairing');
    const db = dbm.init(config.dbPath);
    const secrets = secret.load(config.secretPath);

    function printOne(d) {
      if (!d) { console.log('(no such pairing)'); return; }
      console.log(`${d.schoolId}`);
      console.log(`  enabled:             ${d.enabled}`);
      console.log(`  check_in_interval_s: ${d.check_in_interval_s}`);
      console.log(`  last_acked_cursor:   ${d.last_acked_cursor || '(none)'}`);
      console.log(`  last_check_in_at:    ${d.last_check_in_at ? new Date(Number(d.last_check_in_at)).toISOString() : '(never)'}`);
      for (const [name, f] of Object.entries(d.fields)) {
        const val = f.set ? (f.value !== undefined && f.value !== null && !pairing.FIELDS.find(ff => ff.name === name && ff.secret) ? f.value : '••••••••') : '(unset)';
        console.log(`  ${name}: ${val}`);
      }
    }

    try {
      if (sub === 'list') {
        const items = pairing.list(db, secrets);
        if (!items.length) { console.log('(no pairings configured)'); }
        else for (const d of items) printOne(d);
      } else if (sub === 'show') {
        if (!schoolId) { console.error('usage: family-graph pp-pairing show <schoolId>'); process.exit(2); }
        printOne(pairing.describe(db, secrets, schoolId));
      } else if (sub === 'set') {
        if (!schoolId) { console.error('usage: family-graph pp-pairing set <schoolId> key=value ...'); process.exit(2); }
        const payload = {};
        for (const arg of process.argv.slice(5)) {
          const eq = arg.indexOf('=');
          if (eq < 0) continue;
          payload[arg.slice(0, eq)] = arg.slice(eq + 1);
        }
        const d = pairing.set(db, secrets, schoolId, payload, { actor: 'cli' });
        console.log(`[family-graph] pairing ${schoolId} updated`);
        printOne(d);
      } else if (sub === 'enable' || sub === 'disable') {
        if (!schoolId) { console.error(`usage: family-graph pp-pairing ${sub} <schoolId>`); process.exit(2); }
        if (!pairing.exists(db, schoolId)) { console.error(`no pairing for ${schoolId}; run set first`); process.exit(2); }
        if (sub === 'enable' && !pairing.isComplete(db, secrets, schoolId)) {
          console.error(`pairing ${schoolId} is missing required fields; run pp-pairing show to see which`);
          process.exit(2);
        }
        const d = pairing.set(db, secrets, schoolId, { enabled: sub === 'enable' }, { actor: 'cli' });
        console.log(`[family-graph] pairing ${schoolId} ${sub}d`);
        printOne(d);
      } else if (sub === 'remove') {
        if (!schoolId) { console.error('usage: family-graph pp-pairing remove <schoolId>'); process.exit(2); }
        pairing.clear(db, secrets, schoolId, { actor: 'cli' });
        console.log(`[family-graph] pairing ${schoolId} removed`);
      } else if (sub === 'check-in') {
        if (!schoolId) { console.error('usage: family-graph pp-pairing check-in <schoolId>'); process.exit(2); }
        const agent = require('../server/integration/outbound-agent');
        agent.checkInOnce(db, secrets, schoolId).then(r => {
          console.log(JSON.stringify(r, null, 2));
          db.close();
        }).catch(e => {
          console.error(`error: ${e.reason || ''} ${e.message || e}`);
          process.exitCode = 1;
          db.close();
        });
        break;
      } else {
        console.error('usage: family-graph pp-pairing <list|show|set|enable|disable|check-in|remove> [schoolId] [key=value ...]');
        process.exit(2);
      }
    } catch (e) {
      console.error(`error: ${e.message || e}`);
      process.exitCode = 1;
    }
    db.close();
    break;
  }
  default: {
    // eslint-disable-next-line no-console
    console.error(`unknown command: ${cmd}`);
    // eslint-disable-next-line no-console
    console.error('commands: start | status | rotate-secret | backup [passphrase] | restore <passphrase> <src> <dest> | show-token | list-backups | prune-backups [keep=10] | connector <test|sync|status> [name] | pp-pairing <list|show|set|enable|disable|check-in|remove> [schoolId]');
    process.exit(2);
  }
}
