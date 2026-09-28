'use strict';

// Import MissionIQ's people into Family Graph (owner decision 2026-09-28).
//
// MissionIQ (the donor platform) already holds the parish/school community:
// families, their adults (contacts), and their students (children). Before
// any roster is anonymized, Family Graph must know all of them - otherwise a
// roster would mint a new id for someone MissionIQ already knows.
//
// This reads MissionIQ's SQLite file READ-ONLY (never writes to it) and runs
// every household through the strict roster engine (roster.js):
//   - each MissionIQ record is linked in the crosswalk (external_refs) by its
//     own id: contact:<uuid>, child:<id>, family:<uuid>. From then on it IS
//     that Family Graph person - MissionIQ's "Sync now" gets the exact id
//     back through /api/identity/resolve, no matching involved;
//   - a Family Graph code MissionIQ already stored is kept, unless the
//     record no longer agrees with it (then a human decides);
//   - students are included (MissionIQ's own sync never sent them);
//   - anything uncertain waits for a human; nothing is written until every
//     item is decided and the operator confirms.
//
// Skipped on purpose: the "Unmatched Donations" pseudo-family, households
// with no people, emergency contacts (not members of the household), and -
// unless the operator asks for them - households MissionIQ marks deceased,
// so no downstream app ever starts contacting them. A do-not-contact flag on
// a MissionIQ contact is carried over (set, never cleared).
//
// Never logs names or contact details: roster.js logs counts only.

const Database = require('better-sqlite3');
const roster = require('./roster');
const crosswalk = require('./crosswalk');
const ids = require('../crypto/identifiers');

const SOURCE = 'missioniq';
const PSEUDO_FAMILIES = new Set(['unmatched donations']);
const ROLE_MAP = {
  parent: 'parent', stepparent: 'parent', noncustodial_parent: 'parent', mother: 'parent', father: 'parent',
  guardian: 'guardian', grandparent: 'grandparent',
  in_law: 'other_adult', aunt_uncle: 'other_adult', aunt: 'other_adult', uncle: 'other_adult',
  other: 'member', family_member: 'member', spouse: 'spouse',
};
const SKIP_ROLES = new Set(['emergency_contact']);

function _cols(mdb, table) {
  return new Set(mdb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function _sel(cols, name) {
  return cols.has(name) ? `"${name}"` : `NULL AS "${name}"`;
}

function _hint(code, kind) {
  return typeof code === 'string' && ids.kindOf(code) === kind && ids.isValidCode(code) ? code : null;
}

// Read MissionIQ into roster households. Pure: opens the file read-only and
// returns plain data.
function readMissionIQ(dbPath, { includeDeceased = false } = {}) {
  let mdb;
  try {
    mdb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new Error(`cannot open MissionIQ database at ${dbPath}: ${e.message}`);
  }
  try {
    // One deferred read transaction = one WAL snapshot. MissionIQ is usually
    // running while this reads; separate SELECTs could see a family's contact
    // but not the family, and import that contact as an orphan household.
    const { families, contacts, children } = mdb.transaction(() => {
      const tables = new Set(mdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
      if (!tables.has('families') || !tables.has('contacts')) {
        throw new Error('this is not a MissionIQ database (no families / contacts tables)');
      }
      const fc = _cols(mdb, 'families');
      const cc = _cols(mdb, 'contacts');
      const kc = tables.has('children') ? _cols(mdb, 'children') : null;

      const families = mdb.prepare(
        `SELECT id, ${['family_name', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'fg_family_code', 'deceased'].map(c => _sel(fc, c)).join(', ')}
           FROM families ORDER BY ${fc.has('created_at') ? 'created_at, ' : ''}id`
      ).all();
      const contacts = mdb.prepare(
        `SELECT id, ${['family_id', 'first_name', 'last_name', 'email', 'secondary_email', 'phone', 'secondary_phone',
          'birthday', 'gender', 'role', 'relationship', 'fg_person_code', 'do_not_contact',
          'address_line1', 'address_line2', 'city', 'state', 'zip']
          .map(c => _sel(cc, c)).join(', ')}
           FROM contacts ORDER BY ${cc.has('created_at') ? 'created_at, ' : ''}id`
      ).all();
      const children = kc ? mdb.prepare(
        `SELECT id, ${['family_id', 'first_name', 'last_name', 'grade', 'birthday', 'enrolled'].map(c => _sel(kc, c)).join(', ')}
           FROM children ORDER BY id`
      ).all() : [];
      return { families, contacts, children };
    })();

    const byFamily = new Map();
    const bucket = fid => {
      if (!byFamily.has(fid)) byFamily.set(fid, { contacts: [], children: [] });
      return byFamily.get(fid);
    };
    for (const c of contacts) bucket(c.family_id || null).contacts.push(c);
    for (const k of children) bucket(k.family_id || null).children.push(k);

    const stats = {
      families: 0, contacts: 0, children: 0, children_not_enrolled: 0, do_not_contact: 0,
      skipped_pseudo_families: 0, skipped_pseudo_family_contacts: 0, skipped_deceased_families: 0, skipped_empty_families: 0,
      skipped_emergency_contacts: 0, contacts_without_family: 0, children_without_family: 0,
      prior_person_codes: 0, prior_family_codes: 0,
    };
    const households = [];

    const personFromContact = c => {
      // `relationship` is what the operator sets on the family page, but the
      // column defaults to 'parent' for every contact, so only a value other
      // than the default says anything. Otherwise `role` - the value the
      // contact was imported with (grandparent, aunt_uncle, ...) - decides.
      const rel = String(c.relationship || '').trim().toLowerCase();
      const role = rel && rel !== 'parent' ? rel : String(c.role || rel || 'parent').trim().toLowerCase();
      if (SKIP_ROLES.has(role)) {
        stats.skipped_emergency_contacts += 1;
        return null;
      }
      const hint = _hint(c.fg_person_code, 'person');
      if (hint) stats.prior_person_codes += 1;
      stats.contacts += 1;
      const dnc = Number(c.do_not_contact) === 1;
      if (dnc) stats.do_not_contact += 1;
      return {
        ref: `contact:${c.id}`,
        code_hint: hint,
        given_name: c.first_name,
        family_name: c.last_name,
        emails: [c.email, c.secondary_email].filter(Boolean),
        phones: [c.phone, c.secondary_phone].filter(Boolean),
        date_of_birth: c.birthday,
        gender: c.gender,
        role: ROLE_MAP[role] || 'member',
        ...(dnc ? { do_not_contact: true } : {}),
      };
    };
    const personFromChild = k => {
      stats.children += 1;
      if (k.enrolled !== null && k.enrolled !== undefined && Number(k.enrolled) === 0) stats.children_not_enrolled += 1;
      return {
        ref: `child:${k.id}`,
        given_name: k.first_name,
        family_name: k.last_name,
        grade: k.grade == null ? null : String(k.grade),
        date_of_birth: k.birthday,
        role: 'child',
      };
    };

    for (const f of families) {
      if (PSEUDO_FAMILIES.has(String(f.family_name || '').trim().toLowerCase())) {
        stats.skipped_pseudo_families += 1;
        stats.skipped_pseudo_family_contacts += (byFamily.get(f.id) || { contacts: [] }).contacts.length;
        byFamily.delete(f.id);
        continue;
      }
      const members = byFamily.get(f.id) || { contacts: [], children: [] };
      byFamily.delete(f.id);
      if (!includeDeceased && Number(f.deceased) === 1) {
        stats.skipped_deceased_families += 1;
        continue;
      }
      const persons = [
        ...members.contacts.map(personFromContact).filter(Boolean),
        ...members.children.map(personFromChild),
      ];
      if (!persons.length) {
        stats.skipped_empty_families += 1;
        continue;
      }
      const hint = _hint(f.fg_family_code, 'family');
      if (hint) stats.prior_family_codes += 1;
      stats.families += 1;
      const withAddr = f.address_line1 ? f : (members.contacts.find(c => c.address_line1) || {});
      households.push({
        ref: `family:${f.id}`,
        code_hint: hint,
        display_name: f.family_name,
        address: withAddr.address_line1 ? {
          line1: withAddr.address_line1, line2: withAddr.address_line2 || null,
          city: withAddr.city, region: withAddr.state, postal: withAddr.zip,
        } : null,
        persons,
      });
    }
    // Contacts/children whose family row is missing: each contact is its own
    // household so nobody is dropped.
    for (const [, left] of byFamily) {
      for (const c of left.contacts) {
        const p = personFromContact(c);
        if (!p) continue;
        stats.contacts_without_family += 1;
        households.push({ persons: [p] });
      }
      for (const k of left.children) {
        stats.children_without_family += 1;
        households.push({ persons: [personFromChild(k)] });
      }
    }
    return { households, stats };
  } finally {
    mdb.close();
  }
}

// Items that still need a human, in the order they appear.
function pendingItems(result, households) {
  const pend = new Set(result.pending || []);
  const out = [];
  for (const row of (result.sheets[0] || { rows: [] }).rows) {
    if (row.skipped) continue;
    const hh = households[row.index] || {};
    for (const p of row.persons || []) {
      if (pend.has(p.key)) out.push({ kind: 'person', household: hh.display_name || null, row: row.index, ...p });
    }
    if (row.family && pend.has(row.family.key)) {
      out.push({ kind: 'family', household: hh.display_name || null, row: row.index, ...row.family,
        members: (row.persons || []).map(p => [p.given_name, p.family_name].filter(Boolean).join(' ')) });
    }
  }
  return out;
}

// MissionIQ records whose stored Family Graph code is not the id this import
// settled on (an old sync matched them loosely, or the record was merged).
// MissionIQ's "Sync now" skips contacts that already carry a code and never
// re-stamps a family, so these must be corrected there.
function staleStamps(result, households) {
  const out = [];
  for (const row of (result.sheets[0] || { rows: [] }).rows) {
    if (row.skipped) continue;
    const household = (households[row.index] || {}).display_name || null;
    for (const p of row.persons || []) {
      if (!p.prior_community_id || !p.community_id || p.prior_community_id === p.community_id) continue;
      out.push({
        kind: 'person',
        missioniq_ref: p.ref,
        name: [p.given_name, p.family_name].filter(Boolean).join(' '),
        household,
        stored: p.prior_community_id,
        correct: p.community_id,
      });
    }
    const f = row.family;
    if (f && f.prior_community_id && f.community_id && f.prior_community_id !== f.community_id) {
      out.push({ kind: 'family', missioniq_ref: f.ref, name: household, household, stored: f.prior_community_id, correct: f.community_id });
    }
  }
  return out;
}

// Plain-English review reasons for the operator's terminal.
const REASON_TEXT = {
  same_person_as_another_record: 'another MissionIQ record is already this person',
  same_household_as_another_record: 'another MissionIQ household is already this household',
  linked_record_changed: 'imported before, but the name and birthdate no longer match that person',
  linked_record_used_twice: 'two people in this household point to the same person',
  prior_link_used_twice: 'two people in this household carry the same stored id',
  linked_record_archived: 'the linked person is archived in Family Graph',
  candidate_archived: 'the matching person is archived in Family Graph',
  prior_link_disagrees: "MissionIQ's stored id belongs to someone who does not match",
  prior_link_unconfirmed: "nobody in this household confirms MissionIQ's stored household id",
  linked_household_archived: 'the linked household is archived in Family Graph',
  linked_household_disagrees: 'the linked household no longer matches its people',
  household_archived: 'the matching household is archived in Family Graph',
  same_name_twice_in_household: 'the same name appears twice in this household',
  several_strong_candidates: 'more than one person matches',
  household_disagrees: 'the match is not in the household the others belong to',
  several_household_namesakes: 'more than one person in the household has this name',
  possible_match: 'a possible match, not a certain one',
  role_mismatch: 'the match is a child and this is an adult, or the reverse',
  no_first_name: 'no first name',
  placeholder_name: 'the name looks like a placeholder',
  initial_only: 'only an initial for a first name',
  looks_like_organization: 'the name looks like an organization',
  members_in_several_households: 'its people belong to more than one household',
  members_in_different_households: 'its people belong to different households',
  same_address_no_known_members: 'a household at this address exists, with none of these people in it',
  several_households_at_address: 'more than one household with this surname lives at this address',
  shared_contact_other_surname: 'shares an email or phone with a household of a different surname',
  several_households_share_contact: 'shares an email or phone with more than one household',
  new_adult_with_known_children: 'the children are known, but this adult is new and listed at a different address',
};

function _personLine(c) {
  const name = [c.given_name, c.family_name, c.suffix].filter(Boolean).join(' ') || '(no name)';
  const bits = [
    c.community_id || '(new in this import)',
    name,
    c.date_of_birth ? `born ${c.date_of_birth}` : null,
    c.role || null,
    c.grade ? `grade ${c.grade}` : null,
    c.family ? c.family.display_name : null,
    c.status && c.status !== 'active' ? c.status.toUpperCase() : null,
  ].filter(Boolean);
  return bits.join('  ');
}

// Lines that show one review item to the operator.
function describeItem(item, { index = 0, total = 1 } = {}) {
  const lines = [];
  const why = (item.review_reasons || []).map(r => REASON_TEXT[r] || r).join('; ') || 'needs a decision';
  if (item.kind === 'person') {
    const name = [item.given_name, item.family_name].filter(Boolean).join(' ') || '(no name)';
    lines.push(`[${index + 1}/${total}] PERSON  ${name}${item.date_of_birth ? `  born ${item.date_of_birth}` : ''}  ${item.role || ''}  in ${item.household || '(no household name)'}`);
    if (item.prior_community_id) lines.push(`        MissionIQ had stored: ${item.prior_community_id}`);
    lines.push(`        why: ${why}`);
    (item.candidates || []).forEach((c, i) => lines.push(`   ${i + 1}) same person as ${_personLine(c)}`));
    lines.push('   n) a different person - give them a new id');
    lines.push('   s) not a real person - leave them out');
  } else {
    lines.push(`[${index + 1}/${total}] HOUSEHOLD  ${item.display_name || item.household || '(no name)'}  members: ${(item.members || []).join(', ') || '-'}`);
    if (item.prior_community_id) lines.push(`        MissionIQ had stored: ${item.prior_community_id}`);
    lines.push(`        why: ${why}`);
    (item.candidates || []).forEach((c, i) => {
      const members = (c.members || []).map(m => m.name).filter(Boolean).join(', ') || 'no members';
      lines.push(`   ${i + 1}) same household as ${c.community_id || '(new in this import)'}  ${c.display_name || ''}  [${members}]${c.status && c.status !== 'active' ? '  ' + c.status.toUpperCase() : ''}`);
    });
    lines.push('   n) a different household - give it a new id');
  }
  lines.push('   q) stop now - nothing is written');
  return lines;
}

// Operator answer -> decision object, 'quit', or null (ask again).
function parseAnswer(item, answer) {
  const a = String(answer || '').trim().toLowerCase();
  if (a === 'q') return 'quit';
  if (a === 'n') return { action: 'create' };
  if (a === 's' && item.kind === 'person') return { action: 'skip' };
  if (/^\d+$/.test(a)) {
    const c = (item.candidates || [])[Number(a) - 1];
    const target = c && (c.community_id || c.sheet_ref);
    if (target) return { action: 'attach', target };
  }
  return null;
}

// Which operator answers a RosterError from a re-plan is about. Only 409s
// that name a decision or a decision target qualify; anything else (a bad
// shape, a caller bug) returns [] and stops the import as before.
function _contradictedKeys(err, decisions) {
  if (err.status !== 409) return [];
  const msg = String(err.message || '');
  let m = /^decision (\d+:\d+:(?:\d+|family)):/.exec(msg);
  if (m && decisions[m[1]]) return [m[1]];
  m = /^decision target (\S+) /.exec(msg);
  if (m) {
    return Object.keys(decisions).filter(k => decisions[k] && decisions[k].action === 'attach' && decisions[k].target === m[1]);
  }
  return [];
}

// The whole import. `decide(item)` returns a decision object or 'quit';
// `confirm(summary)` returns true to write. Both may be async (CLI prompts).
async function runImport({ db, secrets, thresholds, dbPath, category = null, actor = 'cli:import-missioniq',
  decide, confirm, say = () => {}, dryRun = false, includeDeceased = false, maxRounds = 10 }) {
  const { households, stats } = readMissionIQ(dbPath, { includeDeceased });
  say({ type: 'read', stats, households: households.length });
  if (!households.length) return { status: 'empty', stats };

  // One source_ref per import run. Family Graph reads (source, source_ref) as
  // "this same upload" and refuses a 'create' whose review offers someone it
  // already wrote, so a fixed ref made every later sync's new namesake
  // impossible to create (fixed 2026-09-28, third pass).
  const sourceRef = `missioniq-import:${new Date().toISOString()}:${require('node:crypto').randomBytes(4).toString('hex')}`;
  const body = { households, source: SOURCE, source_ref: sourceRef, category, decisions: {} };
  let result = roster.run(db, secrets, thresholds, body, { mode: 'plan', actor });
  say({ type: 'plan', summary: result.summary, pending: result.pending.length });
  if (dryRun) return { status: 'dry_run', stats, plan: result };

  const askedItems = new Map(); // decision key -> the item as shown
  // A decision the data overtook (someone imported the same person
  // meanwhile) is dropped: the item is then either matched outright or asked
  // again. Kept, it would be refused at commit on every round.
  const dropStale = r => {
    const stale = (r.stale_decisions || []).filter(k => body.decisions[k]);
    for (const k of stale) delete body.decisions[k];
    if (stale.length) say({ type: 'stale', count: stale.length });
    return stale.length;
  };
  for (let round = 0; round < maxRounds && result.pending.length; round++) {
    const items = pendingItems(result, households);
    for (let i = 0; i < items.length; i++) {
      const d = await decide(items[i], { index: i, total: items.length });
      if (d === 'quit') return { status: 'aborted', stats };
      body.decisions[items[i].key] = d;
      askedItems.set(items[i].key, items[i]);
    }
    // Answers can contradict each other (attach to someone already left
    // out). The engine refuses those; drop only the offending answer, tell
    // the operator, and ask that item again next round. The rest are kept.
    for (;;) {
      try {
        result = roster.run(db, secrets, thresholds, body, { mode: 'plan', actor });
        break;
      } catch (e) {
        const bad = e instanceof roster.RosterError ? _contradictedKeys(e, body.decisions) : [];
        if (!bad.length) throw e;
        for (const key of bad) {
          const target = body.decisions[key].target;
          delete body.decisions[key];
          const leftOut = target && body.decisions[target] && body.decisions[target].action === 'skip';
          say({
            type: 'contradiction',
            key,
            item: askedItems.get(key) || { key },
            message: leftOut
              ? 'you chose someone you had already left out'
              : 'the engine refused it: ' + e.message,
          });
        }
      }
    }
    if (dropStale(result)) result = roster.run(db, secrets, thresholds, body, { mode: 'plan', actor });
    say({ type: 'plan', summary: result.summary, pending: result.pending.length });
  }
  if (result.pending.length) return { status: 'unresolved', stats, pending: result.pending.length };

  if (!(await confirm(result.summary))) return { status: 'aborted', stats };
  const committed = roster.run(db, secrets, thresholds, body, { mode: 'commit', actor });
  if (!committed.committed) return { status: 'unresolved', stats, pending: committed.pending.length };
  return {
    status: 'committed',
    stats,
    result: committed,
    stale: staleStamps(committed, households),
    crosswalk: crosswalk.countBySource(db, SOURCE),
  };
}

module.exports = {
  readMissionIQ, runImport, pendingItems, staleStamps, describeItem, parseAnswer, REASON_TEXT, SOURCE,
};
