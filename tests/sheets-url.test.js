'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const events = require('node:events');
const https = require('node:https');
const http = require('node:http');

const sheetsUrl = require('../server/sources/sheets-url');
const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

// ---------- parser tests ----------

test('parseSheetUrl > accepts canonical /edit URL', () => {
  const r = sheetsUrl.parseSheetUrl('https://docs.google.com/spreadsheets/d/AAA111/edit');
  assert.equal(r.id, 'AAA111');
  assert.equal(r.gid, null);
  assert.equal(r.exportUrl, 'https://docs.google.com/spreadsheets/d/AAA111/export?format=csv');
});

test('parseSheetUrl > preserves gid from query and from fragment', () => {
  const a = sheetsUrl.parseSheetUrl('https://docs.google.com/spreadsheets/d/AAA111/edit?gid=42');
  assert.equal(a.gid, '42');
  assert.match(a.exportUrl, /[?&]gid=42$/);
  const b = sheetsUrl.parseSheetUrl('https://docs.google.com/spreadsheets/d/AAA111/edit#gid=99');
  assert.equal(b.gid, '99');
  const c = sheetsUrl.parseSheetUrl('https://docs.google.com/spreadsheets/d/AAA111/edit?foo=bar#gid=7');
  assert.equal(c.gid, '7');
});

test('parseSheetUrl > rejects non-google hosts', () => {
  for (const u of [
    'https://evil.example.com/spreadsheets/d/AAA111/edit',
    'https://docs.google.com.evil.com/spreadsheets/d/AAA111/edit',
    'https://www.docs.google.com/spreadsheets/d/AAA111/edit',
    'https://google.com/spreadsheets/d/AAA111/edit',
    'https://docs.google.co/spreadsheets/d/AAA111/edit',
  ]) {
    assert.throws(() => sheetsUrl.parseSheetUrl(u), /docs\.google\.com/, `should reject ${u}`);
  }
});

test('parseSheetUrl > rejects http and other schemes', () => {
  assert.throws(() => sheetsUrl.parseSheetUrl('http://docs.google.com/spreadsheets/d/AAA111/edit'), /https/);
  assert.throws(() => sheetsUrl.parseSheetUrl('javascript:alert(1)'), /https|valid/);
  assert.throws(() => sheetsUrl.parseSheetUrl('file:///etc/passwd'), /https/);
});

test('parseSheetUrl > rejects URLs that do not look like sheets', () => {
  assert.throws(() => sheetsUrl.parseSheetUrl('https://docs.google.com/document/d/AAA111/edit'), /Google Sheets/);
  assert.throws(() => sheetsUrl.parseSheetUrl('https://docs.google.com/'), /Google Sheets/);
  assert.throws(() => sheetsUrl.parseSheetUrl('not-even-a-url'), /valid URL/);
  assert.throws(() => sheetsUrl.parseSheetUrl(''), /valid URL/);
});

test('parseSheetUrl > rejects format!=csv', () => {
  assert.throws(
    () => sheetsUrl.parseSheetUrl('https://docs.google.com/spreadsheets/d/AAA111/export?format=xlsx'),
    /format=csv/,
  );
});

test('_hostAllowedForRedirect > accepts allowlist; rejects ip + arbitrary hosts', () => {
  const ok = sheetsUrl._hostAllowedForRedirect;
  assert.equal(ok('docs.google.com'), true);
  assert.equal(ok('foo.googleusercontent.com'), true);
  assert.equal(ok('whatever.google.com'), true);
  assert.equal(ok('Docs.Google.Com'), true); // case-insensitive
  assert.equal(ok('evil.com'), false);
  assert.equal(ok('docs.google.com.evil.com'), false);
  assert.equal(ok('1.2.3.4'), false);
  assert.equal(ok(''), false);
  assert.equal(ok(null), false);
});

// ---------- fetch tests (https.request mocked) ----------

// Helper: replace https.request for the duration of `fn` with a scripted
// mock that yields one response per call from the queue.
async function withMockedHttps(scripts, fn) {
  const original = https.request;
  let i = 0;
  https.request = (opts, cb) => {
    const script = scripts[i++];
    const req = new events.EventEmitter();
    req.write = () => {};
    req.end = () => {
      if (script.error) {
        process.nextTick(() => req.emit('error', script.error));
        return;
      }
      const res = new events.EventEmitter();
      res.statusCode = script.status;
      res.headers = script.headers || {};
      res.resume = () => {};
      res.destroy = (e) => { if (e) res.emit('error', e); };
      cb(res);
      process.nextTick(() => {
        if (script.body) res.emit('data', Buffer.from(script.body));
        res.emit('end');
      });
    };
    req.destroy = (e) => req.emit('error', e || new Error('destroyed'));
    return req;
  };
  try { await fn(); } finally { https.request = original; }
}

test('fetchSheetCsv > 200 OK returns CSV body', async () => {
  await withMockedHttps([
    { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' }, body: 'a,b\n1,2\n' },
  ], async () => {
    const r = await sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit');
    assert.equal(r.content, 'a,b\n1,2\n');
    assert.match(r.contentType, /text\/csv/);
    assert.ok(r.byteLen > 0);
  });
});

test('fetchSheetCsv > follows allowlisted redirect', async () => {
  await withMockedHttps([
    { status: 302, headers: { location: 'https://doc-0c-AB-sheets.googleusercontent.com/export?id=foo' } },
    { status: 200, headers: { 'content-type': 'text/csv' }, body: 'a,b\n1,2\n' },
  ], async () => {
    const r = await sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit');
    assert.equal(r.content, 'a,b\n1,2\n');
    assert.match(r.finalUrl, /googleusercontent\.com/);
  });
});

test('fetchSheetCsv > rejects redirect to non-google host', async () => {
  await withMockedHttps([
    { status: 302, headers: { location: 'https://attacker.example.com/leak' } },
  ], async () => {
    await assert.rejects(
      () => sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit'),
      /disallowed host/,
    );
  });
});

test('fetchSheetCsv > rejects redirect to http (downgrade)', async () => {
  await withMockedHttps([
    { status: 302, headers: { location: 'http://docs.google.com/spreadsheets/d/AAA/export' } },
  ], async () => {
    await assert.rejects(
      () => sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit'),
      /non-https/,
    );
  });
});

test('fetchSheetCsv > 401/403 surfaces a clear "share with anyone with the link" message', async () => {
  await withMockedHttps([
    { status: 401, headers: { 'content-type': 'text/html' } },
  ], async () => {
    await assert.rejects(
      () => sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit'),
      /publicly readable|Anyone with the link/i,
    );
  });
});

test('fetchSheetCsv > 200 with HTML body (private sheet → login page) is rejected', async () => {
  await withMockedHttps([
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html>Sign in</html>' },
  ], async () => {
    await assert.rejects(
      () => sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit'),
      /did not return CSV|Anyone with the link/i,
    );
  });
});

test('fetchSheetCsv > too many redirects aborts', async () => {
  // 6 redirects in a row, all to allowed hosts
  const scripts = [];
  for (let i = 0; i < 6; i++) {
    scripts.push({
      status: 302,
      headers: { location: `https://docs.google.com/redirect-${i}?next` },
    });
  }
  await withMockedHttps(scripts, async () => {
    await assert.rejects(
      () => sheetsUrl.fetchSheetCsv('https://docs.google.com/spreadsheets/d/AAA/edit'),
      /too many redirects/,
    );
  });
});

// ---------- API integration ----------

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function apiReq(port, opts) {
  return new Promise((resolve, reject) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const h = { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...(opts.headers || {}) };
    const r = http.request({ method: opts.method || 'GET', hostname: '127.0.0.1', port, path: opts.path, headers: h }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        let p = buf; try { p = JSON.parse(buf); } catch { /* ok */ }
        resolve({ status: res.statusCode, body: p });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  return listen(app).then(({ server, port }) => {
    t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
    return { server, port, db, secrets };
  });
}

test('api > /api/import/fetch-sheet returns CSV content + audits the fetch', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await withMockedHttps([
    { status: 200, headers: { 'content-type': 'text/csv' }, body: 'first_name,last_name\nMary,Smith\n' },
  ], async () => {
    const r = await apiReq(port, {
      method: 'POST', path: '/api/import/fetch-sheet', headers: auth,
      body: { url: 'https://docs.google.com/spreadsheets/d/SHEETID/edit' },
    });
    assert.equal(r.status, 200);
    assert.match(r.body.content, /Mary,Smith/);
    assert.equal(r.body.source_ref, 'sheet:SHEETID');
  });
  const audits = db.prepare(`SELECT * FROM audit_events WHERE action = 'sheet_fetch'`).all();
  assert.equal(audits.length, 1);
  assert.match(audits[0].metadata, /SHEETID/);
});

test('api > /api/import/fetch-sheet rejects bad URL with 400', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await apiReq(port, {
    method: 'POST', path: '/api/import/fetch-sheet', headers: auth,
    body: { url: 'https://attacker.example.com/spreadsheets/d/X/edit' },
  });
  assert.equal(r.status, 400);
});

test('api > fetch-sheet → run end-to-end import path', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const csv = 'first_name,last_name,email\nMary,Smith,m@x.org\nJohn,Doe,j@x.org\n';
  await withMockedHttps([
    { status: 200, headers: { 'content-type': 'text/csv' }, body: csv },
  ], async () => {
    const fetched = await apiReq(port, {
      method: 'POST', path: '/api/import/fetch-sheet', headers: auth,
      body: { url: 'https://docs.google.com/spreadsheets/d/SHEETID/edit?gid=0' },
    });
    assert.equal(fetched.status, 200);
    const run = await apiReq(port, {
      method: 'POST', path: '/api/import/run', headers: auth,
      body: {
        content: fetched.body.content,
        source: 'sheets',
        source_ref: fetched.body.source_ref,
        category: 'church',
        tags: ['from-sheet'],
      },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.totals.persons_created, 2);
    assert.equal(run.body.totals.families_created, 2);
  });
});
