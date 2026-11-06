// End-to-end test: node test.js
// Starts the server with a tiny TTL and checks upload, lookup, download,
// expiry, and the security protections.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapload-'));
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The test talks to the server directly, standing in for the one trusted
// proxy: the last X-Forwarded-For entry is treated as the client IP.
let ipSeq = 0;
const freshIp = () => `10.0.0.${++ipSeq}`;
const get = (p, ip = freshIp(), headers = {}) =>
  fetch(BASE + p, { headers: { 'X-Forwarded-For': ip, ...headers }, redirect: 'manual' });

function uploadForm(content, name) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  return fd;
}
const post = (fd, ip = freshIp(), headers = {}) =>
  fetch(BASE + '/api/upload', { method: 'POST', body: fd, headers: { 'X-Forwarded-For': ip, ...headers } });

// Raw request, for paths fetch() would normalise away.
function rawGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { 'X-Forwarded-For': freshIp() } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

(async () => {
  // TTL_MINUTES=0.05 -> 3 seconds
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env, PORT: String(PORT), UPLOAD_DIR: dir,
      TTL_MINUTES: '0.05', MAX_FILE_MB: '1', MAX_STORAGE_MB: '3', MIN_FREE_MB: '0',
      FAILED_LOOKUPS_PER_15MIN: '5', UPLOADS_PER_10MIN: '8',
      ADMIN_TOKEN,
    },
    stdio: 'inherit',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }

    // ---- basic flow ----
    const content = 'مرحبا Snapload ' + Date.now();
    let r = await post(uploadForm(content, 'ملف تجربة.txt'));
    assert.strictEqual(r.status, 200);
    const up = await r.json();
    assert.match(up.code, /^[A-Z2-9]{5}$/);
    assert.strictEqual(up.name, 'ملف تجربة.txt');
    console.log('upload ok, code', up.code);

    r = await get(`/api/file/${up.code.toLowerCase()}`);
    assert.strictEqual(r.status, 200, 'lookup is case-insensitive');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');

    r = await get(`/d/${up.code}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), content);
    assert.match(r.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
    console.log('download ok');

    r = await get('/api/file/ZZZZZ');
    assert.strictEqual(r.status, 404);

    // ---- size limit ----
    r = await post(uploadForm(Buffer.alloc(2 * 1024 * 1024), 'big.bin'));
    assert.strictEqual(r.status, 413);
    console.log('size limit ok');

    // ---- security headers ----
    r = await get('/');
    assert.strictEqual(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-powered-by'), null);
    assert.strictEqual(r.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
    r = await get('/', freshIp(), { 'X-Forwarded-Proto': 'https' });
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
    console.log('security headers ok');

    // ---- stored XSS: an uploaded HTML file must never render on our origin ----
    r = await post(uploadForm('<script>alert(1)</script>', 'evil.html'));
    const evil = await r.json();
    r = await get(`/d/${evil.code}`);
    assert.strictEqual(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('content-disposition'), /^attachment/);
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    console.log('html upload served inert ok');

    // ---- file name sanitising (bidi spoofing, control chars, paths) ----
    r = await post(uploadForm('x', 'photo‮gpj.exe'));
    assert.strictEqual((await r.json()).name, 'photogpj.exe');
    r = await post(uploadForm('x', 'a\u0007b.txt'));
    // The multipart parser may reject it outright; either way it is never stored raw.
    if (r.status === 200) assert.strictEqual((await r.json()).name, 'ab.txt');
    else assert.strictEqual(r.status, 400);
    console.log('file name sanitising ok');

    // ---- path traversal ----
    for (const p of ['/d/..%2F..%2Fserver.js', '/api/file/..%2Fmeta', '/../server.js', '/%2e%2e/server.js', '/lib/config.js']) {
      const s = await rawGet(p);
      assert.ok(s === 404 || s === 400, `${p} -> ${s}`);
    }
    console.log('path traversal ok');

    // ---- cross-site upload blocked ----
    r = await post(uploadForm('x', 'a.txt'), freshIp(), { 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(r.status, 403);
    r = await post(uploadForm('x', 'a.txt'), freshIp(), { 'Sec-Fetch-Site': 'same-origin' });
    assert.strictEqual(r.status, 200);
    console.log('cross-site upload blocked ok');

    // ---- brute force: wrong codes lock the IP out, even for valid codes ----
    const attacker = '10.9.9.9';
    for (let i = 0; i < 5; i++) assert.strictEqual((await get('/api/file/ZZZZZ', attacker)).status, 404);
    r = await get('/api/file/ZZZZZ', attacker);
    assert.strictEqual(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
    assert.strictEqual((await get(`/api/file/${up.code}`, attacker)).status, 429, 'locked out of real codes too');
    assert.strictEqual((await get(`/d/${up.code}`, attacker)).status, 429, 'download route shares the lockout');
    // Prepending a fake X-Forwarded-For entry must not reset the counter.
    assert.strictEqual((await get('/api/file/ZZZZZ', `1.2.3.4, ${attacker}`)).status, 429, 'XFF spoofing does not bypass');
    // Another visitor is unaffected.
    assert.strictEqual((await get(`/api/file/${up.code}`)).status, 200);
    console.log('brute-force lockout ok');

    // ---- upload rate limit ----
    const uploader = '10.8.8.8';
    let last;
    for (let i = 0; i < 9; i++) last = await post(uploadForm('x', 'r.txt'), uploader);
    assert.strictEqual(last.status, 429);
    console.log('upload rate limit ok');

    // ---- storage quota (3 MB total) ----
    let full = null;
    for (let i = 0; i < 6; i++) {
      r = await post(uploadForm(Buffer.alloc(900 * 1024), 'q.bin'));
      if (r.status === 507) { full = r; break; }
      assert.strictEqual(r.status, 200);
    }
    assert.ok(full, 'quota eventually refuses uploads');
    console.log('storage quota ok');

    // ---- admin dashboard ----
    const adminGet = (p, tok, ip = freshIp()) => get(p, ip, tok ? { Authorization: `Bearer ${tok}` } : {});
    r = await get('/admin');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
    assert.strictEqual((await adminGet('/api/admin/stats')).status, 401, 'no token');
    assert.strictEqual((await adminGet('/api/admin/stats', 'wrong')).status, 401, 'wrong token');
    const adminIp = '10.7.7.7';
    for (let i = 0; i < 10; i++) await adminGet('/api/admin/stats', 'nope', adminIp);
    assert.strictEqual((await adminGet('/api/admin/stats', ADMIN_TOKEN, adminIp)).status, 429, 'admin brute force locked');
    r = await adminGet('/api/admin/stats', ADMIN_TOKEN);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const st = await r.json();
    assert.ok(st.totals.up >= 5, 'uploads counted');
    assert.ok(st.totals.dl >= 2, 'downloads counted');
    assert.ok(st.totals.fail >= 6, 'wrong codes counted');
    assert.ok(st.totals.rl >= 1 && st.totals.full >= 1 && st.totals.big >= 1 && st.totals.adm >= 12);
    assert.ok(st.live.count >= 1 && st.live.files.some((f) => f.code === up.code));
    assert.ok(st.security.blockedIps >= 1, 'attacker IP shown as blocked');
    assert.ok(st.storage.usedBytes > 0 && st.storage.maxBytes === 3 * 1024 * 1024);
    assert.ok(st.hours.length >= 1);
    // delete a file from the dashboard
    const del = (code, headers = {}) => fetch(`${BASE}/api/admin/file/${code}`, {
      method: 'DELETE', headers: { 'X-Forwarded-For': freshIp(), Authorization: `Bearer ${ADMIN_TOKEN}`, ...headers },
    });
    assert.strictEqual((await del(evil.code, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.strictEqual((await del(evil.code)).status, 200);
    assert.strictEqual((await get(`/api/file/${evil.code}`)).status, 404, 'deleted file is gone');
    assert.strictEqual((await del('ZZZZZ')).status, 404);
    console.log('admin dashboard ok');

    // ---- expiry: wait past TTL; lookup must 404 and files removed ----
    await sleep(3500);
    r = await get(`/d/${up.code}`);
    assert.strictEqual(r.status, 404);
    assert.ok(!fs.existsSync(path.join(dir, 'files', up.code)), 'file deleted');
    console.log('expiry ok');
    console.log('\nALL TESTS PASSED');
  } catch (e) {
    console.error('TEST FAILED', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
