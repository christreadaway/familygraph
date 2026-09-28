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
//     source?, source_ref?, category?: 'school'|'church'|'other', tags? }
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
      let result;
      try {
        result = roster.run(db, secrets, effective(), req.body || {}, { mode, actor });
      } catch (e) {
        if (e instanceof roster.RosterError) {
          log.warn(`roster.${mode}.refused`, { actor, status: e.status, reason: e.message });
          return res.status(e.status).json({ error: 'roster_invalid', detail: e.message });
        }
        log.error(`roster.${mode}.failed`, { actor, message: e && e.message, stack: e && e.stack });
        return res.status(500).json({ error: 'roster_failed', detail: 'internal error' });
      }
      if (mode === 'commit' && !result.committed) {
        return res.status(409).json({
          error: 'review_incomplete',
          detail: `${result.pending.length} item(s) still need a decision; nothing was written`,
          plan: result,
        });
      }
      return res.status(mode === 'commit' ? 201 : 200).json(result);
    };
  }

  r.post('/plan', auth.read, rate.pii, handle('plan'));
  r.post('/commit', auth.import, rate.import, handle('commit'));
  r.get('/lookup/:id', auth.read, rate.pii, (req, res) => {
    const found = roster.lookup(db, req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found' });
    return res.json(found);
  });
  return r;
}

module.exports = build;
