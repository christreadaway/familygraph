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

  listFamilies: () => request('GET', '/api/families'),
  getFamily: code => request('GET', `/api/families/${code}`),
  createFamily: body => request('POST', '/api/families', body),
  updateFamily: (code, body) => request('PATCH', `/api/families/${code}`, body),
  addMember: (code, body) => request('POST', `/api/families/${code}/members`, body),
  endMembership: (code, mc, body) => request('DELETE', `/api/families/${code}/members/${mc}`, body),
  mergeFamily: (code, winner) => request('POST', `/api/families/${code}/merge`, { winner_code: winner }),
  splitFamily: (code, body) => request('POST', `/api/families/${code}/split`, body),
  addAddress: (code, body) => request('POST', `/api/families/${code}/addresses`, body),

  listPeople: () => request('GET', '/api/people'),
  getPerson: code => request('GET', `/api/people/${code}`),
  createPerson: body => request('POST', '/api/people', body),
  updatePerson: (code, body) => request('PATCH', `/api/people/${code}`, body),
  mergePerson: (code, winner) => request('POST', `/api/people/${code}/merge`, { winner_code: winner }),
  addEmail: (code, body) => request('POST', `/api/people/${code}/emails`, body),
  addPhone: (code, body) => request('POST', `/api/people/${code}/phones`, body),

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
};
