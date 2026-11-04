// End-to-end test: node test.js
// Starts the server with a tiny TTL and checks upload, lookup, download, and expiry.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapload-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // TTL_MINUTES=0.05 -> 3 seconds
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: dir, TTL_MINUTES: '0.05', MAX_FILE_MB: '1' },
    stdio: 'inherit',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }

    const content = 'مرحبا Snapload ' + Date.now();
    const fd = new FormData();
    fd.append('file', new Blob([content]), 'ملف تجربة.txt');
    let r = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
    assert.strictEqual(r.status, 200);
    const up = await r.json();
    assert.match(up.code, /^[A-Z2-9]{5}$/);
    assert.strictEqual(up.name, 'ملف تجربة.txt');
    console.log('upload ok, code', up.code);

    r = await fetch(`${BASE}/api/file/${up.code.toLowerCase()}`);
    assert.strictEqual(r.status, 200, 'lookup is case-insensitive');

    r = await fetch(`${BASE}/d/${up.code}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), content);
    assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''/);
    console.log('download ok');

    r = await fetch(`${BASE}/api/file/ZZZZZ`);
    assert.strictEqual(r.status, 404);

    // too big
    const big = new FormData();
    big.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024)]), 'big.bin');
    r = await fetch(BASE + '/api/upload', { method: 'POST', body: big });
    assert.strictEqual(r.status, 400);
    console.log('size limit ok');

    // expiry: wait past TTL; lookup must 404 and files removed
    await sleep(3500);
    r = await fetch(`${BASE}/d/${up.code}`);
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
