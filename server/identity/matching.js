'use strict';

// Identity matching primitives — vendored from missionIQ's resolver, restated
// in pure-function form so they can be used both by our internal resolver and
// by the external /api/identity/match HTTP surface.
//
// Auto-merge vs. prompt-the-user is decided by `scoreMatch`:
//
//   1. Definitive signals (exact email, exact phone, exact address)
//        → confidence = 0.95, immediately auto-merge
//        → exception: a clearly conflicting address (different state, or
//          similarity < 0.5) stops the auto-merge even when email/phone match.
//   2. No definitive signal → additive scoring of softer signals:
//        last name (suffix-aware) + first name (compound/nickname/prefix
//        aware) + address similarity + zip + city. Capped at 1.0.
//   3. The caller decides:
//        confidence ≥ thresholds.autoMerge → attach (auto-merge)
//        confidence ≥ thresholds.review     → enqueue conflict
//        confidence <  thresholds.review     → create new
//
// Default thresholds (matching missionIQ's calibration): autoMerge=0.85,
// review=0.65. The Family Graph profiles system can override these per
// institution.

// ---------- normalization ----------

function normalize(str) {
  if (!str) return '';
  return String(str).toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/\s+/g, ' ');
}

const NAME_SUFFIXES = new Set([
  'jr', 'jr.', 'junior',
  'sr', 'sr.', 'senior',
  'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii',
  '2nd', '3rd', '4th', '5th',
  'esq', 'esq.',
  'phd', 'ph.d', 'ph.d.',
  'md', 'm.d', 'm.d.',
  'dds', 'd.d.s',
]);

// "Smith Jr." → { baseName: "Smith", suffix: "jr" }
function stripSuffix(nameStr) {
  if (!nameStr) return { baseName: '', suffix: null };
  const parts = String(nameStr).trim().split(/[\s,]+/);
  const suffix = [];
  const base = [];
  for (const part of parts) {
    const norm = part.toLowerCase().replace(/\./g, '');
    if (NAME_SUFFIXES.has(norm) || NAME_SUFFIXES.has(part.toLowerCase())) {
      suffix.push(part);
    } else {
      base.push(part);
    }
  }
  return {
    baseName: base.join(' '),
    suffix: suffix.length > 0 ? suffix.join(' ').toLowerCase().replace(/\./g, '') : null,
  };
}

const ADDRESS_ABBREVIATIONS = {
  'st': 'street', 'st.': 'street',
  'ave': 'avenue', 'ave.': 'avenue',
  'blvd': 'boulevard', 'blvd.': 'boulevard',
  'dr': 'drive', 'dr.': 'drive',
  'ln': 'lane', 'ln.': 'lane',
  'rd': 'road', 'rd.': 'road',
  'ct': 'court', 'ct.': 'court',
  'cir': 'circle', 'cir.': 'circle',
  'pl': 'place', 'pl.': 'place',
  'pkwy': 'parkway', 'pky': 'parkway',
  'hwy': 'highway', 'hwy.': 'highway',
  'trl': 'trail', 'trl.': 'trail',
  'n': 'north', 'n.': 'north',
  's': 'south', 's.': 'south',
  'e': 'east', 'e.': 'east',
  'w': 'west', 'w.': 'west',
  'ne': 'northeast', 'nw': 'northwest',
  'se': 'southeast', 'sw': 'southwest',
  'apt': 'apartment', 'apt.': 'apartment',
  'ste': 'suite', 'ste.': 'suite',
};

function normalizeAddress(str) {
  if (!str) return '';
  let addr = String(str).toLowerCase().trim().replace(/[.,]/g, '');
  addr = addr.split(/\s+/).map(w => ADDRESS_ABBREVIATIONS[w] || w).join(' ');
  return addr.replace(/\s+/g, ' ').trim();
}

// "123 Main St Apt 4B" → "123 main street"
function stripUnit(normalized) {
  return normalized
    .replace(/\s+(apartment|unit|suite|apt|ste|#|lot|bldg|building|floor|fl)\s*.*$/i, '')
    .trim();
}

const STATE_ABBR_TO_FULL = {
  'al':'alabama','ak':'alaska','az':'arizona','ar':'arkansas','ca':'california',
  'co':'colorado','ct':'connecticut','de':'delaware','fl':'florida','ga':'georgia',
  'hi':'hawaii','id':'idaho','il':'illinois','in':'indiana','ia':'iowa',
  'ks':'kansas','ky':'kentucky','la':'louisiana','me':'maine','md':'maryland',
  'ma':'massachusetts','mi':'michigan','mn':'minnesota','ms':'mississippi','mo':'missouri',
  'mt':'montana','ne':'nebraska','nv':'nevada','nh':'new hampshire','nj':'new jersey',
  'nm':'new mexico','ny':'new york','nc':'north carolina','nd':'north dakota','oh':'ohio',
  'ok':'oklahoma','or':'oregon','pa':'pennsylvania','ri':'rhode island','sc':'south carolina',
  'sd':'south dakota','tn':'tennessee','tx':'texas','ut':'utah','vt':'vermont',
  'va':'virginia','wa':'washington','wv':'west virginia','wi':'wisconsin','wy':'wyoming',
  'dc':'district of columbia',
};

function normalizeState(st) {
  if (!st) return '';
  const lower = String(st).toLowerCase().trim().replace(/\./g, '');
  return STATE_ABBR_TO_FULL[lower] || lower;
}

// ---------- similarity ----------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (!na || !nb) return 0;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

function nameSimilarityIgnoringSuffix(a, b) {
  return similarity(stripSuffix(a).baseName, stripSuffix(b).baseName);
}

function addressSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;

  const fullSim = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const sa = stripUnit(na);
  const sb = stripUnit(nb);
  let strippedSim = 0;
  if (sa && sb) {
    strippedSim = sa === sb ? 1.0 : 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length);
  }
  return Math.max(fullSim, strippedSim);
}

// Two records have *conflicting* addresses if both have line1 AND:
//   - their states differ (strong signal — different city/state means a
//     different household, even if everything else matches), or
//   - the line1 similarity is below 0.5, or
//   - their zips differ AND line1 similarity is below 0.7.
function addressesConflict(a, b) {
  if (!a.address_line1 || !b.address_line1) return false;
  if (a.state && b.state) {
    const sa = normalizeState(a.state);
    const sb = normalizeState(b.state);
    if (sa && sb && sa !== sb) return true;
  }
  const sim = addressSimilarity(a.address_line1, b.address_line1);
  if (sim < 0.5) return true;
  if (a.zip && b.zip) {
    const za = String(a.zip).replace(/\D/g, '').slice(0, 5);
    const zb = String(b.zip).replace(/\D/g, '').slice(0, 5);
    if (za.length === 5 && zb.length === 5 && za !== zb && sim < 0.7) return true;
  }
  return false;
}

// ---------- nickname / compound name ----------

const NICKNAME_GROUPS = [
  ['robert', 'bob', 'bobby', 'rob', 'robbie', 'robby'],
  ['william', 'bill', 'billy', 'will', 'willy', 'liam'],
  ['richard', 'rich', 'rick', 'ricky', 'dick'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny', 'jon'],
  ['thomas', 'tom', 'tommy'],
  ['michael', 'mike', 'mikey'],
  ['christopher', 'chris'],
  ['timothy', 'tim', 'timmy'],
  ['joseph', 'joe', 'joey'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy'],
  ['matthew', 'matt'],
  ['patrick', 'pat', 'paddy'],
  ['daniel', 'dan', 'danny'],
  ['stephen', 'steve', 'steven'],
  ['andrew', 'andy', 'drew'],
  ['anthony', 'tony'],
  ['benjamin', 'ben', 'benny'],
  ['charles', 'charlie', 'chuck'],
  ['david', 'dave', 'davy'],
  ['donald', 'don', 'donnie', 'donny'],
  ['douglas', 'doug'],
  ['francis', 'frank', 'fran'],
  ['frederick', 'fred', 'freddy', 'freddie'],
  ['gerald', 'jerry', 'gerry'],
  ['gregory', 'greg'],
  ['harold', 'harry', 'hal'],
  ['henry', 'hank'],
  ['jeffrey', 'jeff'],
  ['jonathan', 'jon', 'jonny'],
  ['kenneth', 'ken', 'kenny'],
  ['lawrence', 'larry'],
  ['leonard', 'leo', 'lenny'],
  ['nicholas', 'nick', 'nicky'],
  ['peter', 'pete'],
  ['philip', 'phil'],
  ['raymond', 'ray'],
  ['ronald', 'ron', 'ronnie', 'ronny'],
  ['samuel', 'sam', 'sammy'],
  ['theodore', 'ted', 'teddy', 'theo'],
  ['vincent', 'vince', 'vinny'],
  ['walter', 'walt'],
  ['alexander', 'alex'],
  ['nathaniel', 'nate', 'nathan'],
  ['zachary', 'zach', 'zack'],
  ['catherine', 'katherine', 'kate', 'katie', 'kathy', 'cathy', 'kat'],
  ['elizabeth', 'liz', 'lizzy', 'beth', 'betty', 'betsy', 'eliza'],
  ['jennifer', 'jenny', 'jen'],
  ['jessica', 'jess', 'jessie'],
  ['margaret', 'maggie', 'meg', 'peggy', 'marge', 'margie'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['rebecca', 'becky', 'becca'],
  ['susan', 'sue', 'susie', 'suzy'],
  ['barbara', 'barb', 'barbie'],
  ['deborah', 'debbie', 'deb', 'debra'],
  ['dorothy', 'dot', 'dotty', 'dottie'],
  ['victoria', 'vicky', 'vicki', 'tori'],
  ['christine', 'chris', 'christy', 'christina', 'tina'],
  ['josephine', 'jo', 'josie'],
  ['teresa', 'theresa', 'terry'],
  ['veronica', 'ronnie'],
  ['virginia', 'ginny', 'ginger'],
  ['stephanie', 'steph'],
  ['nicole', 'nikki'],
  ['alexandra', 'alex', 'lexi'],
  ['samantha', 'sam'],
  ['abigail', 'abby'],
  ['madeline', 'maddie', 'madeleine'],
  ['kimberly', 'kim'],
  ['kathleen', 'kathy', 'kate'],
  ['carolyn', 'carol'],
  ['jacqueline', 'jackie'],
];

const NICKNAME_MAP = new Map();
for (const group of NICKNAME_GROUPS) {
  for (const name of group) {
    if (!NICKNAME_MAP.has(name)) NICKNAME_MAP.set(name, new Set());
    for (const equiv of group) {
      if (equiv !== name) NICKNAME_MAP.get(name).add(equiv);
    }
  }
}

function areNicknames(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const eq = NICKNAME_MAP.get(na);
  return !!(eq && eq.has(nb));
}

function isPrefixMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 3 || nb.length < 3 || na.length === nb.length) return false;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  return longer.startsWith(shorter);
}

// "Timothy & Mary" matches "Timothy" or "Mary" individually. Returns a
// similarity score in [0, 1].
function firstNameMatchesCompound(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (areNicknames(na, nb)) return 0.95;
  if (isPrefixMatch(na, nb)) return 0.90;

  const splitPattern = /\s*(?:&|\band\b|\/)\s*/i;
  for (const part of nb.split(splitPattern)) {
    const t = part.trim();
    if (!t) continue;
    if (similarity(na, t) > 0.85) return 1.0;
    if (areNicknames(na, t)) return 0.95;
    if (isPrefixMatch(na, t)) return 0.90;
  }
  for (const part of na.split(splitPattern)) {
    const t = part.trim();
    if (!t) continue;
    if (similarity(t, nb) > 0.85) return 1.0;
    if (areNicknames(t, nb)) return 0.95;
    if (isPrefixMatch(t, nb)) return 0.90;
  }
  return similarity(na, nb);
}

// ---------- multi-value email/phone ----------

function splitEmails(field) {
  if (field == null) return [];
  return String(field)
    .split(/[,;]\s*|\s+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e && e.includes('@'));
}

function splitPhones(field) {
  if (field == null) return [];
  const raw = String(field);
  const digitsOnly = raw.replace(/[^\d]/g, '');
  const phones = [];
  if (digitsOnly.length > 10) {
    const parts = raw.split(/[,;]\s*/);
    if (parts.length > 1) {
      for (const part of parts) {
        const d = part.replace(/[^\d]/g, '').slice(-10);
        if (d.length >= 10) phones.push(d);
      }
    } else {
      let r = digitsOnly;
      while (r.length >= 10) {
        if (r.length >= 11 && r[0] === '1') {
          phones.push(r.slice(1, 11));
          r = r.slice(11);
        } else {
          phones.push(r.slice(0, 10));
          r = r.slice(10);
        }
      }
    }
  } else {
    const d = digitsOnly.slice(-10);
    if (d.length >= 10) phones.push(d);
  }
  return phones;
}

// ---------- the matcher ----------

// Score how likely two records are the same person, using only the fields
// the caller chose to provide. Returns { confidence: 0..1, reasons: [] }.
//
// Record shape (loose — only the keys we read):
//   { given_name, family_name, email, emails[], phone, phones[],
//     date_of_birth, address_line1, city, state, zip }
function scoreMatch(a, b) {
  const reasons = [];
  let confidence = 0;
  let definitive = false;

  // ---- Email (DEFINITIVE)
  const emailsA = a.emails && a.emails.length ? a.emails : splitEmails(a.email);
  const emailsB = b.emails && b.emails.length ? b.emails : splitEmails(b.email);
  if (emailsA.length && emailsB.length) {
    if (emailsA.some(ea => emailsB.includes(ea))) {
      confidence = 0.95;
      definitive = true;
      reasons.push('exact_email_match');
    } else {
      for (const ea of emailsA) {
        for (const eb of emailsB) {
          if (similarity(ea, eb) > 0.9) {
            confidence = Math.max(confidence, 0.4);
            reasons.push('similar_email');
          }
        }
      }
    }
  }

  // ---- Phone (DEFINITIVE)
  const phonesA = a.phones && a.phones.length ? a.phones : splitPhones(a.phone);
  const phonesB = b.phones && b.phones.length ? b.phones : splitPhones(b.phone);
  if (phonesA.length && phonesB.length) {
    if (phonesA.some(pa => phonesB.includes(pa))) {
      if (!definitive) confidence = 0.95;
      definitive = true;
      reasons.push('exact_phone_match');
    }
  }

  // Definitive signal: trust it. A different address doesn't invalidate, just
  // gets noted as an alternate address. But explicitly-conflicting addresses
  // (different state or sim<0.5) DO veto the match.
  if (definitive) {
    if (addressesConflict(a, b)) {
      reasons.push('address_conflict_present');
      // missionIQ allows this through (alternate address); we surface the
      // conflict to the operator by capping the confidence below auto-merge.
      // The caller's autoMerge threshold (default 0.85) is still met by
      // 0.95-0.10=0.85, so without further conflict signals we still merge.
      // With the cap below auto-merge we'd never auto-merge cross-state —
      // which we want, because cross-state same-name/email is often two
      // generations sharing one inherited address-book email.
      confidence = Math.min(confidence, 0.7);
      return { confidence, reasons, definitive: false };
    }
    return { confidence: Math.min(confidence, 1.0), reasons, definitive: true };
  }

  // ---- Last name (suffix-aware)
  if (a.family_name && b.family_name) {
    const ns = nameSimilarityIgnoringSuffix(a.family_name, b.family_name);
    if (ns === 1.0) {
      confidence += 0.30;
      reasons.push('exact_last_name');
    } else if (ns > 0.85) {
      confidence += 0.20;
      reasons.push('similar_last_name');
    }
  }

  // ---- First name (compound + nickname + prefix)
  if (a.given_name && b.given_name) {
    const fs = firstNameMatchesCompound(a.given_name, b.given_name);
    if (fs === 1.0) { confidence += 0.20; reasons.push('exact_first_name'); }
    else if (fs >= 0.90) { confidence += 0.18; reasons.push('nickname_or_short_form'); }
    else if (fs > 0.85) { confidence += 0.10; reasons.push('similar_first_name'); }
  }

  // ---- DOB
  if (a.date_of_birth && b.date_of_birth) {
    if (String(a.date_of_birth) === String(b.date_of_birth)) {
      confidence += 0.20;
      reasons.push('exact_date_of_birth');
    }
  }

  // ---- Address (DEFINITIVE if very close — same household even with different
  // last names, e.g. blended families, married couples keeping their names)
  let addressMatched = false;
  if (a.address_line1 && b.address_line1) {
    const sim = addressSimilarity(a.address_line1, b.address_line1);
    if (sim > 0.85) {
      addressMatched = true;
      confidence = Math.max(confidence, 0.90);
      definitive = true;
      reasons.push('address_match_household');
    } else if (sim > 0.65) {
      confidence += 0.15;
      reasons.push('similar_address');
    }
  }

  // ---- Zip
  if (a.zip && b.zip) {
    const za = String(a.zip).replace(/\D/g, '').slice(0, 5);
    const zb = String(b.zip).replace(/\D/g, '').slice(0, 5);
    if (za.length === 5 && za === zb) {
      confidence += addressMatched ? 0.05 : 0.10;
      reasons.push('zip_match');
    }
  }

  // ---- City
  if (a.city && b.city && normalize(a.city) === normalize(b.city)) {
    confidence += 0.05;
    reasons.push('city_match');
  }

  return { confidence: Math.min(confidence, 1.0), reasons, definitive };
}

// Convenience: classify a confidence number into an action given thresholds.
function classify(confidence, thresholds) {
  const auto = thresholds && typeof thresholds.autoMerge === 'number' ? thresholds.autoMerge : 0.85;
  const review = thresholds && typeof thresholds.review === 'number' ? thresholds.review : 0.65;
  if (confidence >= auto) return 'auto_merge';
  if (confidence >= review) return 'review';
  return 'no_match';
}

module.exports = {
  // string helpers
  normalize, similarity, levenshtein,
  // names
  stripSuffix, nameSimilarityIgnoringSuffix,
  areNicknames, isPrefixMatch, firstNameMatchesCompound,
  NICKNAME_GROUPS,
  // addresses
  normalizeAddress, addressSimilarity, addressesConflict,
  normalizeState, STATE_ABBR_TO_FULL, ADDRESS_ABBREVIATIONS,
  // multi-value
  splitEmails, splitPhones,
  // the matcher
  scoreMatch, classify,
  // for tests
  NAME_SUFFIXES,
};
