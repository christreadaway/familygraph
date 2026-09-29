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
  case 'partner-pairing': {
    // Configure / enable the partner app outbound pairing. FG is the sole
    // initiator (Option A — "no open doors"): this only stores the dial-out
    // target + shared secrets and toggles the pairing. It opens no port.
    //
    //   partner-pairing list
    //   partner-pairing show <schoolId>
    //   partner-pairing set  <schoolId> key=value [key=value ...]
    //   partner-pairing enable  <schoolId>
    //   partner-pairing disable <schoolId>
    //   partner-pairing check-in <schoolId>     (run one check-in now)
    //   partner-pairing remove  <schoolId>
    //
    // set keys: partner_base_url, partner_bearer_credential, shared_webhook_secret,
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
        if (!schoolId) { console.error('usage: family-graph partner-pairing show <schoolId>'); process.exit(2); }
        printOne(pairing.describe(db, secrets, schoolId));
      } else if (sub === 'set') {
        if (!schoolId) { console.error('usage: family-graph partner-pairing set <schoolId> key=value ...'); process.exit(2); }
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
        if (!schoolId) { console.error(`usage: family-graph partner-pairing ${sub} <schoolId>`); process.exit(2); }
        if (!pairing.exists(db, schoolId)) { console.error(`no pairing for ${schoolId}; run set first`); process.exit(2); }
        if (sub === 'enable' && !pairing.isComplete(db, secrets, schoolId)) {
          console.error(`pairing ${schoolId} is missing required fields; run partner-pairing show to see which`);
          process.exit(2);
        }
        const d = pairing.set(db, secrets, schoolId, { enabled: sub === 'enable' }, { actor: 'cli' });
        console.log(`[family-graph] pairing ${schoolId} ${sub}d`);
        printOne(d);
      } else if (sub === 'remove') {
        if (!schoolId) { console.error('usage: family-graph partner-pairing remove <schoolId>'); process.exit(2); }
        pairing.clear(db, secrets, schoolId, { actor: 'cli' });
        console.log(`[family-graph] pairing ${schoolId} removed`);
      } else if (sub === 'check-in') {
        if (!schoolId) { console.error('usage: family-graph partner-pairing check-in <schoolId>'); process.exit(2); }
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
        console.error('usage: family-graph partner-pairing <list|show|set|enable|disable|check-in|remove> [schoolId] [key=value ...]');
        process.exit(2);
      }
    } catch (e) {
      console.error(`error: ${e.message || e}`);
      process.exitCode = 1;
    }
    db.close();
    break;
  }
  case 'issue-key': {
    // Provision a scoped API key for a consuming app and print the token once.
    //   family-graph issue-key <name> [scope,scope,...]
    // Scopes default to the standard consuming-app set (read/write PII,
    // sanitize for AI pseudonyms, audit.write for PII-export consent logging).
    const name = process.argv[3];
    const scopesArg = process.argv[4];
    if (!name) {
      // eslint-disable-next-line no-console
      console.error('usage: family-graph issue-key <name> [scope,scope,...]');
      console.error('  default scopes: pii.read,pii.write,sanitize,audit.write');
      console.error('  valid scopes:   pii.read, pii.write, sanitize, audit.read, audit.write, import, roster, rules.write, integration, *');
      console.error('  Doc Anonymizer: family-graph issue-key docanonymizer roster');
      console.error('  MissionIQ:      family-graph issue-key missioniq   (the name must equal the sync source to read its crosswalk)');
      process.exit(2);
    }
    const config = require('../server/config');
    const dbm = require('../server/db');
    const apiKeys = require('../server/auth/api-keys');
    const scopes = (scopesArg || 'pii.read,pii.write,sanitize,audit.write')
      .split(',').map(s => s.trim()).filter(Boolean);
    const db = dbm.init(config.dbPath);
    try {
      const { code, token } = apiKeys.provision(db, { name, scopes });
      // eslint-disable-next-line no-console
      console.log(`[family-graph] issued scoped key for "${name}"`);
      console.log(`  key code: ${code}`);
      console.log(`  scopes:   ${scopes.join(', ')}`);
      console.log('');
      console.log('  TOKEN (shown once — copy it now; only its hash is stored):');
      console.log(`  ${token}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`error: ${e.message || e}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
    break;
  }
  case 'import-missioniq': {
    // Bring everyone MissionIQ already knows into Family Graph, each with one
    // lifelong id, before any roster is anonymized.
    //   family-graph import-missioniq <missioniq.db> [--dry-run] [--category church|school|other] [--include-deceased]
    // Reads the MissionIQ file READ-ONLY. Every uncertain match is asked here;
    // nothing is written until every question is answered and YES is typed.
    // Safe to re-run: records imported before are recognized by their
    // MissionIQ id, so only new or changed records are matched again.
    const args = process.argv.slice(3);
    const usage = 'usage: family-graph import-missioniq <path-to-missioniq.db> [--dry-run] [--category church|school|other] [--include-deceased]';
    let dbArg = null;
    let category = null;
    let dryRun = false;
    let includeDeceased = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--dry-run') dryRun = true;
      else if (a === '--include-deceased') includeDeceased = true;
      else if (a === '--category') category = args[++i];
      else if (a.startsWith('--category=')) category = a.slice('--category='.length);
      else if (!a.startsWith('--') && !dbArg) dbArg = a;
      else { console.error(`unknown option: ${a}`); console.error(usage); process.exit(2); }
    }
    if (!dbArg) { console.error(usage); process.exit(2); }
    if (category !== null && !['church', 'school', 'other'].includes(category)) {
      console.error('--category must be church, school, or other'); process.exit(2);
    }
    const path = require('path');
    const readline = require('readline');
    const config = require('../server/config');
    const dbm = require('../server/db');
    const secret = require('../server/crypto/secret');
    const profiles = require('../server/identity/profiles');
    const missioniq = require('../server/identity/missioniq');
    const mpath = path.resolve(dbArg);
    if (mpath === path.resolve(config.dbPath)) {
      console.error('that is the Family Graph database, not MissionIQ\'s'); process.exit(2);
    }
    // Log lines (counts only - never names) go to <home>/logs/cli.log, not
    // into the middle of the prompts. Paste its tail into a chat when
    // something goes wrong.
    const log = require('../server/log');
    const logFile = process.env.FAMILY_GRAPH_LOG_FILE || path.join(config.home, 'logs', 'cli.log');
    log.configure({ file: logFile, stderr: false });
    log.info('cli.import_missioniq.start', { dry_run: dryRun, category, include_deceased: includeDeceased });
    const db = dbm.init(config.dbPath);
    const secrets = secret.load(config.secretPath);
    const thresholds = profiles.thresholdsFor(db, config.resolverThresholds);
    // A line queue rather than rl.question: answers piped in ahead of time
    // (or typed quickly) are never dropped. End of input counts as "stop".
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const lines = [];
    const waiters = [];
    let inputClosed = false;
    rl.on('line', l => (waiters.length ? waiters.shift()(l) : lines.push(l)));
    rl.on('close', () => { inputClosed = true; while (waiters.length) waiters.shift()(null); });
    const ask = prompt => {
      process.stdout.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift());
      if (inputClosed) return Promise.resolve(null);
      return new Promise(res => waiters.push(res));
    };
    const out = s => console.log(s);
    const fmtSummary = s => [
      `  people:     ${s.persons.matched} already in Family Graph, ${s.persons.new} new, ${s.persons.review} need you${s.persons.skipped ? `, ${s.persons.skipped} left out` : ''}`,
      `  households: ${s.families.matched} already in Family Graph, ${s.families.new} new, ${s.families.review} need you`,
    ].join('\n');

    (async () => {
      try {
        const r = await missioniq.runImport({
          db, secrets, thresholds, dbPath: mpath, category, dryRun, includeDeceased,
          actor: 'cli:import-missioniq',
          say: ev => {
            if (ev.type === 'read') {
              const st = ev.stats;
              out(`MissionIQ: ${st.families} households, ${st.contacts} adults, ${st.children} students` +
                (st.children_not_enrolled ? ` (${st.children_not_enrolled} not currently enrolled)` : ''));
              const skipped = [
                st.skipped_deceased_families ? `${st.skipped_deceased_families} deceased households (add --include-deceased to import them)` : null,
                st.skipped_pseudo_families ? `the "Unmatched Donations" holding family (${st.skipped_pseudo_family_contacts} contacts)` : null,
                st.skipped_emergency_contacts ? `${st.skipped_emergency_contacts} emergency contacts` : null,
                st.skipped_empty_families ? `${st.skipped_empty_families} empty households` : null,
              ].filter(Boolean);
              if (skipped.length) out(`  left out on purpose: ${skipped.join('; ')}`);
              if (st.contacts_without_family || st.children_without_family) {
                out(`  ${st.contacts_without_family + st.children_without_family} people have no household in MissionIQ; each is imported as their own household`);
              }
              if (st.prior_person_codes || st.prior_family_codes) {
                out(`  MissionIQ already stored ${st.prior_person_codes} person ids and ${st.prior_family_codes} household ids from earlier syncs; each is checked before it is trusted`);
              }
            } else if (ev.type === 'stale') {
              out('');
              out(`  ${ev.count} of your answers no longer apply (someone else imported those people meanwhile); they were dropped and anything still unsure will be asked again.`);
              log.warn('cli.import_missioniq.stale_decisions', { count: ev.count });
            } else if (ev.type === 'contradiction') {
              // Names go to the terminal only, never the log (key only).
              const it = ev.item || {};
              const who = it.kind === 'family'
                ? (it.display_name || it.household || 'a household')
                : ([it.given_name, it.family_name].filter(Boolean).join(' ') || 'a person');
              out('');
              out(`  Your answer for ${who}${it.household && it.kind !== 'family' ? ` in ${it.household}` : ''} conflicts with another answer: ${ev.message}.`);
              out('  That one item will be asked again; your other answers are kept.');
              log.warn('cli.import_missioniq.contradiction', { key: ev.key });
            } else if (ev.type === 'plan') {
              out('');
              out('Plan (nothing written yet):');
              out(fmtSummary(ev.summary));
            }
          },
          decide: async (item, pos) => {
            out('');
            for (const line of missioniq.describeItem(item, pos)) out(line);
            for (;;) {
              const ans = await ask('  > ');
              if (ans === null) return 'quit';
              const d = missioniq.parseAnswer(item, ans);
              if (d) return d;
              out(`  type a number from the list, n${item.kind === 'person' ? ', s' : ''}, or q`);
            }
          },
          confirm: async summary => {
            out('');
            out('Ready to write:');
            out(fmtSummary(summary));
            const ans = await ask('Type YES to write this to Family Graph (anything else stops): ');
            return ans !== null && ans.trim() === 'YES';
          },
        });
        out('');
        if (r.status === 'empty') out('MissionIQ has no households to import.');
        else if (r.status === 'dry_run') out(`Dry run: nothing written. ${r.plan.pending.length} items would need your decision.`);
        else if (r.status === 'aborted') out('Stopped. Nothing was written.');
        else if (r.status === 'unresolved') { out(`Stopped: ${r.pending} items still need a decision. Nothing was written.`); process.exitCode = 1; }
        else if (r.status === 'committed') {
          const s = r.result.summary;
          out('Done. Written to Family Graph:');
          out(fmtSummary(s).replace(/need you/g, 'decided by you'));
          out(`  MissionIQ records linked: ${r.crosswalk.person} people, ${r.crosswalk.family} households (${s.crosswalk.created} new links, ${s.crosswalk.relinked} changed)`);
          out(`  import run: ${(r.result.import_runs || []).join(', ') || '-'}`);
          const x = r.extras;
          out(`  tags: ${x.tags_grandparent} grandparent, ${x.tags_school_alumni} school-alumni households; grandparent links: ${x.grandparent_links_created} new, ${x.grandparent_links_existing} already there, ${r.stats.extended_family_links_undirected} skipped (direction unknown), ${x.grandparent_links_unlinked} not linked`);
          if (r.stale.length) {
            out('');
            out(`${r.stale.length} MissionIQ records still carry an old Family Graph id. Correct ids:`);
            for (const x of r.stale) out(`  ${x.kind === 'family' ? 'household' : 'person   '}  ${x.name || '-'}  stored ${x.stored}  ->  ${x.correct}`);
            out('MissionIQ\'s "Sync now" keeps a stored id, so fix these in MissionIQ (see README, "Importing MissionIQ").');
          }
        }
        log.info('cli.import_missioniq.done', { status: r.status, stale: r.stale ? r.stale.length : 0 });
      } catch (e) {
        log.error('cli.import_missioniq.failed', { error: String(e.message || e), stack: e.stack });
        console.error(`error: ${e.message || e}`);
        console.error(`details: ${logFile}`);
        process.exitCode = 1;
      } finally {
        rl.close();
        db.close();
      }
    })();
    break;
  }
  default: {
    // eslint-disable-next-line no-console
    console.error(`unknown command: ${cmd}`);
    // eslint-disable-next-line no-console
    console.error('commands: start | status | rotate-secret | backup [passphrase] | restore <passphrase> <src> <dest> | show-token | issue-key <name> [scopes] | list-backups | prune-backups [keep=10] | connector <test|sync|status> [name] | partner-pairing <list|show|set|enable|disable|check-in|remove> [schoolId] | import-missioniq <missioniq.db> [--dry-run] [--category church|school|other] [--include-deceased]');
    process.exit(2);
  }
}
