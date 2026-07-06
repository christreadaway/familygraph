// Lightweight API client. The Bearer token is read from localStorage. The
// dashboard prompts the operator for it on first load and links to the CLI
// command that prints it.
//
// On any 401/403 response from the server we fire a `family-graph:auth-failed`
// CustomEvent with the server-provided reason ('no_bearer', 'token_mismatch',
// 'missing_scope', 'unknown_or_revoked_scoped_token', etc.). The App listens
// for this and re-shows the token banner with the reason — so a stale token
// in localStorage can no longer silently override a fresh paste.

const TOKEN_KEY = 'family-graph.bearer';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function emitAuthFailed(detail) {
  try {
    window.dispatchEvent(new CustomEvent('family-graph:auth-failed', { detail }));
  } catch (_) { /* non-browser context (tests) */ }
}

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-family-graph-actor': 'dashboard' };
  const t = getToken();
  if (t) headers['authorization'] = `Bearer ${t}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 || res.status === 403) {
      emitAuthFailed({
        status: res.status,
        reason: data && data.reason,
        detail: data && data.detail,
        path,
      });
    }
    throw err;
  }
  return data;
}

// Validate the current token by calling an endpoint that requires it. Used
// when the operator pastes a token in the banner so we can reject a bad
// paste immediately rather than silently storing it.
export async function validateToken() {
  return request('GET', '/api/families');
}

export const api = {
  health: () => request('GET', '/api/health'),

  listFamilies: (opts) => {
    if (opts?.safe) return request('GET', '/api/safe/families');
    const qs = opts?.q ? `?q=${encodeURIComponent(opts.q)}` : '';
    return request('GET', `/api/families${qs}`);
  },
  getFamily: (code, opts) => request('GET', opts?.safe ? `/api/safe/families/${code}` : `/api/families/${code}`),
  createFamily: body => request('POST', '/api/families', body),
  updateFamily: (code, body) => request('PATCH', `/api/families/${code}`, body),
  addMember: (code, body) => request('POST', `/api/families/${code}/members`, body),
  endMembership: (code, mc, body) => request('DELETE', `/api/families/${code}/members/${mc}`, body),
  mergeFamily: (code, winner) => request('POST', `/api/families/${code}/merge`, { winner_code: winner }),
  splitFamily: (code, body) => request('POST', `/api/families/${code}/split`, body),
  addAddress: (code, body) => request('POST', `/api/families/${code}/addresses`, body),
  setFamilyTags: (code, tags) => request('PUT', `/api/families/${code}/tags`, { tags }),
  removeFamilyTag: (code, tag) => request('DELETE', `/api/families/${code}/tags/${encodeURIComponent(tag)}`),
  setFamilyDoNotContact: (code, value, reason = null) =>
    request('POST', `/api/families/${code}/do-not-contact`, { value, reason }),

  listPeople: (opts) => request('GET', opts?.safe ? '/api/safe/people' : '/api/people'),
  getPerson: (code, opts) => request('GET', opts?.safe ? `/api/safe/people/${code}` : `/api/people/${code}`),
  createPerson: body => request('POST', '/api/people', body),
  updatePerson: (code, body) => request('PATCH', `/api/people/${code}`, body),
  mergePerson: (code, winner) => request('POST', `/api/people/${code}/merge`, { winner_code: winner }),
  addEmail: (code, body) => request('POST', `/api/people/${code}/emails`, body),
  addPhone: (code, body) => request('POST', `/api/people/${code}/phones`, body),
  setPersonTags: (code, tags) => request('PUT', `/api/people/${code}/tags`, { tags }),
  removePersonTag: (code, tag) => request('DELETE', `/api/people/${code}/tags/${encodeURIComponent(tag)}`),

  listConflicts: params => {
    const qs = new URLSearchParams(params || { status: 'open' }).toString();
    return request('GET', `/api/conflicts?${qs}`);
  },
  getConflict: code => request('GET', `/api/conflicts/${code}`),
  resolveConflict: (code, body) => request('POST', `/api/conflicts/${code}/resolve`, body),
  assignConflicts: body => request('POST', '/api/conflicts/assign', body),
  assignConflict: (code, body) => request('POST', `/api/conflicts/${code}/assign`, body),
  unassignConflict: code => request('DELETE', `/api/conflicts/${code}/assignment`),
  listNotifications: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/notifications${qs ? `?${qs}` : ''}`);
  },
  dispatchNotifications: () => request('POST', '/api/notifications/dispatch'),
  retryNotification: code => request('POST', `/api/notifications/${code}/retry`),
  cancelNotification: code => request('POST', `/api/notifications/${code}/cancel`),
  testNotification: to => request('POST', '/api/notifications/test', { to }),

  audit: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/audit${qs ? `?${qs}` : ''}`);
  },
  exportConsent: body => request('POST', '/api/audit/external-export', body),

  importPreview: body => request('POST', '/api/import/preview', body),
  importRun: body => request('POST', '/api/import/run', body),
  fetchSheet: url => request('POST', '/api/import/fetch-sheet', { url }),
  scanDuplicates: body => request('POST', '/api/scan/duplicates', body || {}),
  listImports: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/imports${qs ? `?${qs}` : ''}`);
  },
  getImport: code => request('GET', `/api/imports/${code}`),

  sanitize: body => request('POST', '/api/sanitize', body),
  desanitize: body => request('POST', '/api/desanitize', body),

  // v1.x extensions
  search: params => {
    const qs = new URLSearchParams(params).toString();
    return request('GET', `/api/search?${qs}`);
  },
  membershipHistoryPerson: code => request('GET', `/api/membership-history/person/${code}`),
  membershipHistoryFamily: code => request('GET', `/api/membership-history/family/${code}`),
  listRules: kind => request('GET', `/api/rules${kind ? `?kind=${kind}` : ''}`),
  createRule: body => request('POST', '/api/rules', body),
  updateRule: (code, body) => request('PATCH', `/api/rules/${code}`, body),
  deleteRule: code => request('DELETE', `/api/rules/${code}`),
  listKeys: () => request('GET', '/api/keys'),
  provisionKey: body => request('POST', '/api/keys', body),
  revokeKey: code => request('DELETE', `/api/keys/${code}`),
  listProfiles: () => request('GET', '/api/profiles'),
  activateProfile: name => request('POST', '/api/profiles/activate', { name }),
  listSettings: () => request('GET', '/api/settings'),
  putSetting: (key, value) => request('PUT', `/api/settings/${key}`, { value }),
  deleteSetting: key => request('DELETE', `/api/settings/${key}`),
  exportData: body => fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}`, 'x-family-graph-actor': 'dashboard' },
    body: JSON.stringify(body),
  }),
  addRelationship: body => request('POST', '/api/relationships', body),
  listRelationships: code => request('GET', `/api/relationships/${code}`),
  removeRelationship: code => request('DELETE', `/api/relationships/${code}`),

  // Live API connectors (FACTS, Ministry Platform).
  // Volunteer ministries and EIM (Ethics and Integrity in Ministry) cert.
  listMinistries: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/ministries${qs ? `?${qs}` : ''}`);
  },
  getMinistry: code => request('GET', `/api/ministries/${code}`),
  createMinistry: body => request('POST', '/api/ministries', body),
  updateMinistry: (code, body) => request('PATCH', `/api/ministries/${code}`, body),
  archiveMinistry: code => request('DELETE', `/api/ministries/${code}`),
  assignMinistry: (code, body) => request('POST', `/api/ministries/${code}/assignments`, body),
  endMinistryAssignment: (code, body) => request('DELETE', `/api/ministries/assignments/${code}`, body),
  ministriesForPerson: (code, params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/ministries/by-person/${code}${qs ? `?${qs}` : ''}`);
  },
  ministriesForFamily: (code, params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/ministries/by-family/${code}${qs ? `?${qs}` : ''}`);
  },
  eimExpiring: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/ministries/eim/expiring${qs ? `?${qs}` : ''}`);
  },
  eimRecompute: () => request('POST', '/api/ministries/eim/recompute'),

  listConnectors: () => request('GET', '/api/connectors'),
  getConnector: name => request('GET', `/api/connectors/${name}`),
  setConnectorCredentials: (name, body) => request('POST', `/api/connectors/${name}/credentials`, body),
  deleteConnectorCredentials: name => request('DELETE', `/api/connectors/${name}/credentials`),
  patchConnector: (name, body) => request('PATCH', `/api/connectors/${name}`, body),
  testConnector: name => request('POST', `/api/connectors/${name}/test`),
  syncConnector: name => request('POST', `/api/connectors/${name}/sync`),
  listConnectorRuns: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/connector-runs${qs ? `?${qs}` : ''}`);
  },
  getConnectorRun: code => request('GET', `/api/connector-runs/${code}`),

  // The partner app outbound pairings (Option A dialer). Secrets are write-only.
  listPartnerPairings: () => request('GET', '/api/partner-pairings'),
  getPartnerPairing: schoolId => request('GET', `/api/partner-pairings/${encodeURIComponent(schoolId)}`),
  setPartnerPairing: (schoolId, body) => request('PUT', `/api/partner-pairings/${encodeURIComponent(schoolId)}`, body),
  patchPartnerPairing: (schoolId, body) => request('PATCH', `/api/partner-pairings/${encodeURIComponent(schoolId)}`, body),
  deletePartnerPairing: schoolId => request('DELETE', `/api/partner-pairings/${encodeURIComponent(schoolId)}`),

  // Organizations (parish / school) + dated affiliations + verification.
  listOrganizations: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/organizations${qs ? `?${qs}` : ''}`);
  },
  getOrganization: code => request('GET', `/api/organizations/${code}`),
  createOrganization: body => request('POST', '/api/organizations', body),
  updateOrganization: (code, body) => request('PATCH', `/api/organizations/${code}`, body),
  archiveOrganization: code => request('DELETE', `/api/organizations/${code}`),
  setOrganizationDomain: (code, domain) => request('POST', `/api/organizations/${code}/domain`, { domain }),
  verifyOrganizationDomain: (code, method) => request('POST', `/api/organizations/${code}/domain/verify`, { method }),
  staleAffiliations: (code, days) =>
    request('GET', `/api/organizations/${code}/stale${days ? `?days=${days}` : ''}`),
  affiliate: (orgCode, body) => request('POST', `/api/organizations/${orgCode}/affiliations`, body),
  endAffiliation: (code, body) => request('DELETE', `/api/organizations/affiliations/${code}`, body),
  transitionAffiliation: (code, body) => request('POST', `/api/organizations/affiliations/${code}/transition`, body),
  verifyAffiliation: (code, body) => request('POST', `/api/organizations/affiliations/${code}/verify`, body),
  affiliationVerifications: code => request('GET', `/api/organizations/affiliations/${code}/verifications`),
  affiliationsForPerson: (code, params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/organizations/by-person/${code}${qs ? `?${qs}` : ''}`);
  },
  affiliationsForFamily: (code, params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/organizations/by-family/${code}${qs ? `?${qs}` : ''}`);
  },

  // Staff accounts (master-only management) + magic-link login.
  listAccounts: () => request('GET', '/api/accounts'),
  inviteAccount: body => request('POST', '/api/accounts', body),
  updateAccount: (code, body) => request('PATCH', `/api/accounts/${code}`, body),
  disableAccount: code => request('DELETE', `/api/accounts/${code}`),
  authRequestLink: email => request('POST', '/api/auth/request-link', { email }),
  authRedeem: token => request('POST', '/api/auth/redeem', { token }),
  authMe: () => request('GET', '/api/auth/me'),
  authLogout: () => request('POST', '/api/auth/logout'),
};
