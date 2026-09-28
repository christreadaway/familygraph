'use strict';

// Identity matching primitives — vendored from the upstream identity engine's resolver, restated
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
// Default thresholds (matching the upstream identity engine's calibration): autoMerge=0.85,
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

// Optimal-string-alignment distance: an adjacent swap costs one edit.
function _osaDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function transposedSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  return 1 - _osaDistance(na, nb) / Math.max(na.length, nb.length);
}

function nameSimilarityIgnoringSuffix(a, b) {
  return similarity(stripSuffix(a).baseName, stripSuffix(b).baseName);
}

// The parts of an address that make it a different place however similar
// the rest reads: the house number (and a letter on it), the unit, the
// building, the floor, the PO box, and any other number in the line - a
// rural route, a highway contract, a county road, a numbered street.
//
// Fixed 2026-09-28 (second pass): the first version compared only the house
// number, the last unit token and the PO box, so 'RR 2 Box 15' / 'RR 3 Box
// 15', 'County Road 12' / 'County Road 21' and 'Bldg 3 Apt 12' / 'Bldg 4
// Apt 12' still read as one place. It also compared units as raw text, so
// 'Apt 4-B' and 'Apt 4B' read as two places.
const _DESIGNATOR = /(^|\s)(apartment|unit|suite|apt|ste|lot|space|spc|room|rm|trailer|trlr|#|bldg|building|floor|fl)\s*#?\s*([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s([a-z])(?=\s|$))?/g;
const _DESIGNATOR_KIND = { bldg: 'bldg', building: 'bldg', floor: 'floor', fl: 'floor' };

function _addressParts(n) {
  const parts = { house: null, houseLetter: null, unit: null, bldg: null, floor: null, box: null, other: '' };
  let rest = ` ${n} `;
  const house = n.match(/^(\d+(?:-\d+)?)(?:-?([a-z]))?(?=\s|$)/);
  if (house) {
    parts.house = house[1];
    parts.houseLetter = house[2] || null;
    rest = ' ' + n.slice(house[0].length) + ' ';
  }
  rest = rest.replace(_DESIGNATOR, (all, lead, word, value, letter) => {
    const kind = _DESIGNATOR_KIND[word] || 'unit';
    // '4-B', '4 B' and '4B' are one unit.
    const v = (value + (letter || '')).replace(/-/g, '');
    parts[kind] = parts[kind] ? `${parts[kind]},${v}` : v;
    return ' ';
  });
  rest = rest.replace(/\bbox\s+(\d+)\b/g, (all, box) => { parts.box = box; return ' '; });
  // Every other number, in order, ordinals folded ('5th' -> 5).
  parts.other = (rest.match(/\d+/g) || []).map(Number).join(' ');
  return parts;
}

// 'different' (two places), 'unsure' (maybe one place written two ways),
// or 'same' (nothing that tells them apart). A part present on one side
// only is left alone - forms often drop the unit.
function _addressPartsVerdict(na, nb) {
  const a = _addressParts(na);
  const b = _addressParts(nb);
  let verdict = 'same';
  if (a.house && b.house && a.house !== b.house) return 'different';
  let unitA = a.unit;
  let unitB = b.unit;
  if (a.house && b.house && a.houseLetter !== b.houseLetter) {
    // '123A Main St' against '123 Main St Apt A' is probably one place,
    // but 123 and 123A are also two houses on one lot: not different, not
    // proof. Any other letter mismatch ('123A' / '123', '123A' / '123B')
    // is two house numbers, as before.
    const letter = a.houseLetter || b.houseLetter;
    const otherUnit = a.houseLetter ? b.unit : a.unit;
    const ownUnit = a.houseLetter ? a.unit : b.unit;
    if (a.houseLetter && b.houseLetter) return 'different';
    if (ownUnit || !otherUnit) return 'different';
    if (otherUnit !== letter) return 'different';
    verdict = 'unsure';
    unitA = unitB = null;
  }
  for (const [pa, pb] of [[unitA, unitB], [a.bldg, b.bldg], [a.floor, b.floor], [a.box, b.box], [a.other, b.other]]) {
    if (pa && pb && pa !== pb) return 'different';
  }
  return verdict;
}

// Ceiling for 'unsure': counts as a similar address (review, never proof)
// and is never read as a different one.
const _ADDRESS_UNSURE_CAP = 0.8;

function addressSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;

  const verdict = _addressPartsVerdict(na, nb);
  // Fixed 2026-09-28: "134 Pine St" and "106 Pine St" read as 90% alike, so
  // two namesakes on one street scored the same address and merged. Two
  // different numbers anywhere that matters are two different places.
  if (verdict === 'different') return Math.min(_rawAddressSimilarity(na, nb), 0.5);
  const sim = _rawAddressSimilarity(_canonAddress(na), _canonAddress(nb));
  return verdict === 'unsure' ? Math.min(sim, _ADDRESS_UNSURE_CAP) : sim;
}

// One spelling for every unit designator and value, so '#4B', 'Unit 4-B'
// and 'Apt 4 B' compare as the same text.
function _canonAddress(n) {
  return n.replace(_DESIGNATOR, (all, lead, word, value, letter) =>
    `${lead}${_DESIGNATOR_KIND[word] || 'unit'} ${(value + (letter || '')).replace(/-/g, '')}`);
}

function _rawAddressSimilarity(na, nb) {
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
  ['john', 'johnny', 'jon'],
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
  ['nicholas', 'nick', 'nicky', 'nico'],
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
  // Mary across English / French / Spanish / Latin and common diminutives —
  // very common in church/school data so we treat them as nickname-equivalent.
  ['mary', 'marie', 'maria', 'mariah', 'molly', 'polly', 'mae', 'mamie'],
  ['ann', 'anne', 'anna', 'annie', 'nan', 'nancy', 'ana', 'anita'],
  ['jose', 'pepe', 'chepe'],
  ['catherine', 'katherine', 'kate', 'katie', 'kathy', 'cathy', 'kat'],
  ['elizabeth', 'liz', 'lizzy', 'beth', 'betty', 'betsy', 'eliza', 'libby'],
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
  ['christine', 'chris', 'christy', 'christina', 'cristina', 'tina'],
  ['josephine', 'jo', 'josie'],
  ['teresa', 'theresa', 'terry', 'tere'],
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
  // More English short forms common on school and parish lists.
  ['albert', 'al', 'bert'],
  ['alfred', 'al', 'alfie'],
  ['gabriel', 'gabe'],
  ['gabriela', 'gabriella', 'gabby'],
  ['isabel', 'isabella', 'bella', 'izzy'],
  ['joshua', 'josh'],
  ['jacob', 'jake'],
  ['maximilian', 'max'],
  ['maxwell', 'max'],
  ['dominic', 'dom'],
  ['augustine', 'augustin', 'gus'],
  ['bernard', 'bernie'],
  ['eugene', 'gene'],
  ['louis', 'lou'],
  ['cynthia', 'cindy'],
  ['sandra', 'sandy'],
  ['pamela', 'pam'],
  ['melissa', 'missy'],
  ['amanda', 'mandy'],
  ['judith', 'judy'],
  ['angela', 'angie'],
  ['frances', 'fran', 'frannie'],
  ['emily', 'emmy'],
  ['olivia', 'liv', 'livvy'],
  ['sophia', 'sophie'],
  ['evelyn', 'evie'],
  ['cecilia', 'cece'],
  ['caroline', 'carrie'],
  // Spanish given names and their everyday forms (a parish list and a
  // school roster often disagree on exactly this). Diacritics are stripped
  // before lookup, so Jesús / Toño match jesus / tono.
  ['francisco', 'paco', 'pancho', 'kiko', 'cisco'],
  ['jesus', 'chuy', 'chucho'],
  ['guadalupe', 'lupe', 'lupita'],
  ['ignacio', 'nacho'],
  ['guillermo', 'memo'],
  ['alberto', 'beto'],
  ['roberto', 'beto'],
  ['humberto', 'beto'],
  ['antonio', 'tono', 'toni'],
  ['eduardo', 'lalo'],
  ['enrique', 'kike', 'quique'],
  ['manuel', 'manny', 'manolo'],
  ['salvador', 'chava', 'chavo'],
  ['ernesto', 'neto'],
  ['fernando', 'nando'],
  ['santiago', 'santi'],
  ['sebastian', 'sebas'],
  ['alejandro', 'alex', 'ale'],
  ['alejandra', 'alex', 'ale'],
  ['ricardo', 'rick', 'ricky'],
  ['gerardo', 'jerry'],
  ['rosario', 'chayo'],
  ['graciela', 'chela'],
  ['consuelo', 'chelo'],
  ['concepcion', 'conchita', 'concha', 'conchi'],
  ['dolores', 'lola'],
  ['mercedes', 'meche'],
  ['refugio', 'cuca', 'cuquita'],
  ['socorro', 'coco'],
];

// Names that are the same name in origin but are also given to two people
// in one family: John and Jack are brothers as often as one man, and Joseph
// and Jose are father and son. These rows still score as a nickname (the
// pair reaches review) but never prove identity, in any mode that asks for
// proof. Fixed 2026-09-28 (third pass): they used to sit in the proof table,
// so John/Jack and Joseph/Jose at one address auto-fused.
const REVIEW_ONLY_NICKNAME_GROUPS = [
  ['john', 'jack', 'johnny', 'jon'],
  ['john', 'juan', 'sean', 'shawn'],   // cross-language Johns
  ['joseph', 'jose', 'pepe', 'chepe'],
];

const NICKNAME_MAP = new Map();
for (const group of NICKNAME_GROUPS.concat(REVIEW_ONLY_NICKNAME_GROUPS)) {
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

// How many different full names a name can stand for. "Chris" is
// Christopher OR Christine; "Pat" is Patrick OR Patricia; "Jon" is John OR
// Jonathan. A nickname match through an ambiguous name is not proof of
// identity - twins named Christopher and Christine share a surname, a
// birthday, and "Chris".
//
// Fixed 2026-09-28: this used to count table rows, so Joseph (listed with
// Joe and again with Jose) and John (Jack, and again Juan) read as ambiguous
// and Joseph/Joe never auto-matched. A row is keyed by its full name (the
// first entry); ambiguity is the number of distinct full names a name maps
// to, so a full name that heads two rows is still one name.
const NICKNAME_HEADS = new Map();
for (const group of NICKNAME_GROUPS) {
  for (const name of group) {
    if (!NICKNAME_HEADS.has(name)) NICKNAME_HEADS.set(name, new Set());
    NICKNAME_HEADS.get(name).add(group[0]);
  }
}

function nicknameAmbiguous(name) {
  const heads = NICKNAME_HEADS.get(normalize(name));
  return !!heads && heads.size > 1;
}

// A nickname pair proves identity only when both names sit in one row of
// the proof table (not only in a review-only row) and neither stands for
// more than one full name.
function nicknameProves(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (nicknameAmbiguous(na) || nicknameAmbiguous(nb)) return false;
  return NICKNAME_GROUPS.some(g => g.includes(na) && g.includes(nb));
}

// Generational suffixes only. Professional ones (MD, PhD, Esq) say nothing
// about which generation a record belongs to.
const GENERATIONAL_SUFFIX = {
  jr: 'jr', junior: 'jr',
  sr: 'sr', senior: 'sr',
  ii: 'ii', '2nd': 'ii',
  iii: 'iii', '3rd': 'iii',
  iv: 'iv', '4th': 'iv',
  v: 'v', '5th': 'v',
  vi: 'vi', vii: 'vii', viii: 'viii',
};

function _genSuffixIn(str) {
  if (!str) return null;
  for (const part of String(str).split(/[\s,]+/)) {
    const k = part.toLowerCase().replace(/\./g, '');
    if (GENERATIONAL_SUFFIX[k]) return GENERATIONAL_SUFFIX[k];
  }
  return null;
}

// The generational suffix a record carries, from an explicit suffix field or
// folded into the family name ("Smith Jr."). Null when none.
function generationalSuffix(rec) {
  if (!rec) return null;
  return _genSuffixIn(rec.suffix) || _genSuffixIn(stripSuffix(rec.family_name).suffix);
}

// ISO date for comparison, or null when the value can't be read as a date.
// Lazy require keeps this module free of load-order coupling.
function normalizeDob(v) {
  if (v == null || v === '') return null;
  const { normalizeDate } = require('../sources/normalize');
  return normalizeDate(v);
}

// Two readable birthdates that differ only the way a misread date differs:
// month and day swapped, or the same day a whole number of centuries apart
// (a two-digit year). Neither is proof of two people.
function _dobMisreading(isoA, isoB) {
  const [ya, ma, da] = isoA.split('-');
  const [yb, mb, db] = isoB.split('-');
  if (ya === yb && ma === db && da === mb) return true;
  if (ma === mb && da === db && (Number(ya) - Number(yb)) % 100 === 0) return true;
  return false;
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
// similarity score in [0, 1]: 1.0 exact, 0.95 nickname table, 0.90 prefix,
// else plain similarity.
//
// Fixed 2026-09-28: the per-part loop ran on every name, so a name with no
// separator was compared with itself and any similarity above 0.85 scored
// 1.0 - Antonio/Antonia and Francisco/Francisca read as the same first name
// and a brother and sister got one id. Parts are split only when a name
// really is a compound, and only an exact part scores 1.0.
const COMPOUND_SPLIT = /\s*(?:&|\band\b|\/)\s*/i;

// { score, kind }: kind is 'exact', 'nickname' (a table entry), 'prefix'
// (Dan/Daniel, but also Luis/Luisa) or 'similar' (plain edit distance).
function _firstNameMatch(a, b) {
  if (!a || !b) return { score: 0, kind: 'similar' };
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return { score: 1.0, kind: 'exact' };
  if (areNicknames(na, nb)) return { score: 0.95, kind: 'nickname', proves: nicknameProves(na, nb) };

  let best = isPrefixMatch(na, nb) ? { score: 0.90, kind: 'prefix' } : { score: similarity(na, nb), kind: 'similar' };
  const pairs = [];
  if (COMPOUND_SPLIT.test(nb)) for (const t of nb.split(COMPOUND_SPLIT)) pairs.push([na, t.trim()]);
  if (COMPOUND_SPLIT.test(na)) for (const t of na.split(COMPOUND_SPLIT)) pairs.push([t.trim(), nb]);
  for (const [x, y] of pairs) {
    if (!x || !y) continue;
    if (x === y) return { score: 1.0, kind: 'exact' };
    if (areNicknames(x, y)) return { score: 0.95, kind: 'nickname', proves: nicknameProves(x, y) };
    const part = isPrefixMatch(x, y) ? { score: 0.90, kind: 'prefix' } : { score: similarity(x, y), kind: 'similar' };
    if (part.score > best.score) best = part;
  }
  return best;
}

function firstNameMatchesCompound(a, b) {
  return _firstNameMatch(a, b).score;
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

// Confidence ceiling for a pair that carries a hard contradiction (different
// birthdates, Jr vs Sr, conflicting address on a contact match). Below every
// built-in autoMerge threshold (0.80 / 0.85 / 0.90), so the pair can only
// ever reach a human, never an automatic merge.
const VETO_CAP = 0.7;

// Score how likely two records are the same person, using only the fields
// the caller chose to provide. Returns { confidence: 0..1, reasons: [] }.
//
// Record shape (loose — only the keys we read):
//   { given_name, family_name, suffix, email, emails[], phone, phones[],
//     date_of_birth, address_line1, city, state, zip }
//
// Hard vetoes (always on, 2026-09-28): two different birthdates, or two
// different generational suffixes (Jr / Sr / III), can never be definitive -
// a shared family email or a shared address is exactly what a father and son
// have in common.
//
// opts.strict (roster imports that mint community identifiers, where a wrong
// merge gives two humans one id and nobody finds out):
//   - a first name "lines up" only when it is exact or a nickname-table
//     entry; a bare prefix or a near spelling (Luis/Luisa, Antonio/Antonia)
//     is a sibling as often as a typo, so it can reach review but never
//     decides
//   - an email/phone match needs the first name to line up, or (when one
//     side has no first name) the birthdate to match; spouses share a family
//     inbox, a child is often listed under a parent's email, and twins share
//     both the inbox and the birthday
//   - a suffix present on only one side ("John Smith" vs "John Smith Jr")
//     blocks a definitive match
//   - a nickname that stands for more than one full name (Chris, Pat,
//     Alex, Sam, Kate) does not count as a first-name match for definitive
//     contact, name+birthdate or name+address matches
function scoreMatch(a, b, opts = {}) {
  const strict = !!(opts && opts.strict);
  const reasons = [];
  let confidence = 0;
  let definitive = false;

  // Signals every path needs, computed once.
  const fm = (a.given_name && b.given_name) ? _firstNameMatch(a.given_name, b.given_name) : null;
  const fs = fm ? fm.score : null;
  const nickAmbiguous = !!fm && fm.kind !== 'exact' && fs >= 0.90 &&
    (nicknameAmbiguous(a.given_name) || nicknameAmbiguous(b.given_name));
  // Fixed 2026-09-28: in strict mode a bare prefix (Luis/Luisa, Daniel/
  // Daniela, Paul/Paula) or a one-letter difference (Antonio/Antonia) no
  // longer lines a first name up. Those are the brother-and-sister pairs of
  // every Spanish-speaking parish; only the exact name or a nickname-table
  // entry that stands for one full name proves it is the same person. The
  // pair still reaches review through 'similar_first_name'.
  const strictProves = !!fm && (fm.kind === 'exact' || (fm.kind === 'nickname' && fm.proves && !nickAmbiguous));
  const givenAligned = strict ? strictProves : (fs !== null && fs >= 0.90);
  const dobA = a.date_of_birth ? (normalizeDob(a.date_of_birth) || null) : null;
  const dobB = b.date_of_birth ? (normalizeDob(b.date_of_birth) || null) : null;
  let dobExact = false;
  let dobConflict = false;
  let dobMisread = false;
  if (a.date_of_birth && b.date_of_birth) {
    if (dobA && dobB) {
      dobExact = dobA === dobB;
      // Fixed 2026-09-28: a differing birthdate vetoes, and in roster
      // imports tells two records apart with nobody asked, so it must be a
      // real difference - not a day/month swap (05/01 read US-style against
      // a day-first sheet) or a two-digit year read in the wrong century.
      // Third pass: a possible misreading is not proof of one person either,
      // so it still vetoes every definitive path (review), it just no longer
      // tells the pair apart on its own.
      dobMisread = dobA !== dobB && _dobMisreading(dobA, dobB);
      dobConflict = dobA !== dobB && !dobMisread;
    } else {
      // Unreadable on one side: equal raw text still counts, but a mismatch
      // proves nothing.
      dobExact = String(a.date_of_birth).trim() === String(b.date_of_birth).trim();
    }
  }
  const sfxA = generationalSuffix(a);
  const sfxB = generationalSuffix(b);
  const suffixConflict = !!(sfxA && sfxB && sfxA !== sfxB);
  const suffixOneSided = !!sfxA !== !!sfxB;

  function vetoes() {
    const v = [];
    if (dobConflict) v.push('dob_conflict');
    if (dobMisread) v.push('dob_possible_misreading');
    if (suffixConflict) v.push('suffix_conflict');
    if (strict && suffixOneSided) v.push('suffix_one_sided');
    return v;
  }

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
    const v = vetoes();
    // A birthdate stands in for the first name only when a first name is
    // missing: twins share a birthday AND the family inbox.
    if (strict && !givenAligned && !(dobExact && fm === null)) v.push('contact_match_name_unaligned');
    if (addressesConflict(a, b)) {
      // the upstream identity engine allows this through (alternate address); we surface the
      // conflict to the operator by capping the confidence below auto-merge.
      // The caller's autoMerge threshold (default 0.85) is still met by
      // 0.95-0.10=0.85, so without further conflict signals we still merge.
      // With the cap below auto-merge we'd never auto-merge cross-state —
      // which we want, because cross-state same-name/email is often two
      // generations sharing one inherited address-book email.
      v.unshift('address_conflict_present');
    }
    if (v.length) {
      reasons.push(...v);
      return { confidence: Math.min(confidence, VETO_CAP), reasons, definitive: false };
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

  // ---- First name (compound + nickname + prefix). Graduated bands: exact
  // and nickname matches are strong; below 0.85 still contributes a softer
  // signal so phonetic variants like Pio/Pia surface for review.
  if (fs !== null) {
    if (fs === 1.0 && fm.kind === 'exact') { confidence += 0.20; reasons.push('exact_first_name'); }
    else if (fs >= 0.90 && (fm.kind === 'nickname' || !strict)) { confidence += 0.18; reasons.push('nickname_or_short_form'); }
    else if (fs > 0.85) { confidence += 0.10; reasons.push('similar_first_name'); }
    else if (fs > 0.60) { confidence += 0.05; reasons.push('phonetic_first_name'); }
    else if (strict && transposedSimilarity(a.given_name, b.given_name) >= 0.75) {
      // "Jonh" / "John": plain edit distance counts a swap as two edits.
      confidence += 0.05;
      reasons.push('first_name_typo');
    }
  }

  // ---- DOB
  if (dobExact) {
    confidence += 0.20;
    reasons.push('exact_date_of_birth');
  }

  // A first name that proves identity for the definitive paths below: exact,
  // or a nickname / short form - except, in strict mode, a nickname shared by
  // two name families.
  const firstProves = strict ? strictProves :
    (reasons.includes('exact_first_name') || reasons.includes('nickname_or_short_form'));
  const blocked = dobConflict || dobMisread || suffixConflict || (strict && suffixOneSided);

  // Person-level definitive: exact first + exact last + exact DOB. Two people
  // sharing all three are vanishingly unlikely to be different humans, and
  // child rosters frequently lack email/phone, so this fills the gap left by
  // the email/phone-centric definitive path.
  if (dobExact && reasons.includes('exact_last_name') && firstProves && !blocked) {
    confidence = Math.max(confidence, 0.95);
    definitive = true;
    reasons.push('exact_name_plus_dob');
  }

  // ---- Address. Address is a strong signal for FAMILY attachment but on
  // its own is NOT enough to merge two distinct persons (different first
  // names at the same household are usually a spouse/parent/child triplet,
  // not duplicates). the upstream identity engine collapses these — Family Graph keeps them as
  // separate persons under the same family, which the family resolver
  // handles. So address contributes a soft additive only, and only becomes
  // definitive when paired with a name match.
  //
  // Fixed 2026-09-28: "name match" used to mean ANY of last name or first
  // name, so Mary Smith and John Smith at one address scored definitive and
  // a re-import fused the spouses into one person - the exact case this
  // comment says must not happen. Both names must now line up.
  let addressMatched = false;
  if (a.address_line1 && b.address_line1) {
    const sim = addressSimilarity(a.address_line1, b.address_line1);
    if (sim > 0.85) {
      addressMatched = true;
      confidence += 0.20;
      reasons.push('address_match_household');
      // Promote to definitive only if the names also align — without that,
      // address-alone is a household signal, not a person-identity signal.
      const lastAligned =
        reasons.includes('exact_last_name') || reasons.includes('similar_last_name');
      if (lastAligned && firstProves && !blocked) {
        confidence = Math.max(confidence, 0.90);
        definitive = true;
      }
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

  const v = vetoes();
  if (v.length) {
    reasons.push(...v);
    return { confidence: Math.min(confidence, VETO_CAP), reasons, definitive: false };
  }
  return { confidence: Math.min(confidence, 1.0), reasons, definitive };
}

// Convenience: classify a confidence number into an action given thresholds.
function classify(confidence, thresholds) {
  const auto = thresholds && typeof thresholds.autoMerge === 'number' ? thresholds.autoMerge : 0.85;
  // 0.30 default review threshold — calibrated against the new additive
  // scoring so even surname-only or phonetic-variant first-name matches
  // surface for operator decision. Family Graph errs on the side of asking;
  // the upstream identity engine's single 0.75 gate just dropped weak matches on the floor.
  //   exact_last (0.30)                                  = 0.30  → review
  //   exact_last + phonetic_first (0.05)                 = 0.35  → review
  //   exact_last + nickname (0.18)                       = 0.48  → review
  //   exact_last + exact_first (0.20)                    = 0.50  → review
  //   exact_last + exact_first + dob                     = 0.95  → auto_merge (definitive)
  //   exact email or phone                               = 0.95  → auto_merge
  //   address > 0.85                                     = 0.90  → auto_merge
  const review = thresholds && typeof thresholds.review === 'number' ? thresholds.review : 0.30;
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
  nicknameAmbiguous, nicknameProves, generationalSuffix, normalizeDob, transposedSimilarity,
  NICKNAME_GROUPS, REVIEW_ONLY_NICKNAME_GROUPS, VETO_CAP,
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
