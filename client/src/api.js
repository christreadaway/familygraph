// Lightweight API client. The Bearer token is read from localStorage. The
// dashboard prompts the operator for it on first load and links to the CLI
// command that prints it.

const TOKEN_KEY = 'sanctus.bearer';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-sanctus-actor': 'dashboard' };
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
    throw err;
  }
  return data;
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

  audit: params => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/api/audit${qs ? `?${qs}` : ''}`);
  },
  exportConsent: body => request('POST', '/api/audit/external-export', body),

  importPreview: body => request('POST', '/api/import/preview', body),
  importRun: body => request('POST', '/api/import/run', body),

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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}`, 'x-sanctus-actor': 'dashboard' },
    body: JSON.stringify(body),
  }),
  addRelationship: body => request('POST', '/api/relationships', body),
  listRelationships: code => request('GET', `/api/relationships/${code}`),
  removeRelationship: code => request('DELETE', `/api/relationships/${code}`),
};
