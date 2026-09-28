'use strict';

// Roster API - community identifiers for school rosters and parishioner lists.
//
//   POST /api/identity/roster/plan    (roster)  dry run: what would happen,
//                                               every item that needs a human
//   POST /api/identity/roster/commit  (roster)  write it; refused (409, no
//                                               writes) while anything is
//                                               undecided
//   GET  /api/identity/roster/lookup/:id (roster) I…/F… (or p_/f_) ->
//                                               current record, following merges
//
// Body for plan and commit:
//   { sheets: [{ name?, headers: [..], rows: [[..], ..], mapping? }],
//     decisions?: { "<sheet>:<row>:<slot>": {action, target?},
//                   "<sheet>:<row>:family": {action, target?} },
//     source?, source_ref?, category?: 'school'|'church'|'other', tags?,
//     idempotency_key? }
//
// idempotency_key (commit, 8-200 of [A-Za-z0-9._:-]): a retry with the same
// key and the same request returns the first result (200, "replayed": true)
// and writes nothing; the same key with a different request is 409
// idempotency_conflict. Keys are per caller and kept 7 days. A commit refused
// for open reviews or stale decisions is not stored.
//
// source_ref names ONE upload (Doc Anonymizer sends one per file, the
// MissionIQ import one per run). A later commit with the same source and
// source_ref is read as the same upload sent again, so a 'create' whose
// review offers someone it already wrote is refused as stale. Never reuse a
// source_ref across uploads.
//
// Crosswalk: a roster key may not send refs or code hints - those read and
// relink another app's records - and may not use another app's source once
// that source has crosswalk links. The master token and the in-process
// MissionIQ import keep full use.
//
// Scope: all three need `roster`, and a key for Doc Anonymizer carries only
// that (`family-graph issue-key docanonymizer roster`). It sees the people a
// roster matches - that is the point - but cannot list the directory
// (pii.read) or touch connector settings (import). The master token works too.
// (Changed 2026-09-28 from pii.read + import, which reached /api/connectors.)

const express = require('express');
const roster = require('../identity/roster');
const profiles = require('../identity/profiles');
const log = require('../log');

function build({ db, secrets, thresholds, auth, rate }) {
  const effective = () => profiles.thresholdsFor(db, thresholds);
  const r = express.Router();

  function handle(mode) {
    return (req, res) => {
      const actor = (req.auth && req.auth.actor) || 'roster';
      const a = req.auth || {};
      const caller = {
        master: a.kind === 'master',
        id: a.kind === 'master' ? 'master' : a.kind === 'staff' ? `staff:${a.account_code}` : (a.key_code || a.actor || 'caller'),
        name: a.kind === 'scoped' ? a.actor : null,
      };
      let result;
      try {
        result = roster.run(db, secrets, effective(), req.body || {}, { mode, actor, caller });
      } catch (e) {
        if (e instanceof roster.RosterError) {
          const error = (e.extra && e.extra.code) || 'roster_invalid';
          log.warn(`roster.${mode}.refused`, { actor, status: e.status, error, reason: e.message });
          return res.status(e.status).json({ error, detail: e.message });
        }
        log.error(`roster.${mode}.failed`, { actor, message: e && e.message, stack: e && e.stack });
        return res.status(500).json({ error: 'roster_failed', detail: 'internal error' });
      }
      if (mode === 'commit' && !result.committed) {
        const stale = (result.stale_decisions || []).length;
        return res.status(409).json({
          error: 'review_incomplete',
          detail: `${result.pending.length} item(s) still need a decision` +
            (stale ? `, ${stale} decision(s) no longer apply (re-plan)` : '') + '; nothing was written',
          plan: result,
        });
      }
      if (result.replayed) return res.status(200).json(result);
      return res.status(mode === 'commit' ? 201 : 200).json(result);
    };
  }

  // A plan does the same work as a commit (the whole import, rolled back),
  // so both sit behind the same tight roster bucket.
  // The 20 MB body is parsed only after the bearer check (server/index.js
  // marks it handled so the small global parser skips it).
  const body = [(req, _res, next) => { req._body = false; next(); }, express.json({ limit: '20mb' })];
  r.post('/plan', auth.read, rate.roster || rate.import, ...body, handle('plan'));
  r.post('/commit', auth.import, rate.roster || rate.import, ...body, handle('commit'));
  r.get('/lookup/:id', auth.read, rate.pii, (req, res) => {
    const found = roster.lookup(db, req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found' });
    return res.json(found);
  });
  return r;
}

module.exports = build;
