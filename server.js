'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

const cfg = require('./lib/config');
const store = require('./lib/storage');
const stats = require('./lib/stats');
const admin = require('./lib/admin');
const journal = require('./lib/journal');
const { createLimiter } = require('./lib/rateLimit');
const { securityHeaders, sameOrigin, DOWNLOAD_CSP, PAGES_CSP } = require('./lib/security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGES_DIR = path.join(__dirname, 'pages');
const NOT_FOUND_PAGE = path.join(PUBLIC_DIR, 'notfound.html');
const MSG_NOT_FOUND = 'الكود غير صحيح أو انتهت صلاحية الملف';
const MSG_TOO_MANY = 'محاولات كثيرة، حاول بعد قليل';

// Express 4 does not catch rejected promises; route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- rate limits ----------
const uploadLimiter = createLimiter({ limit: cfg.UPLOADS_PER_10MIN, windowMs: 10 * 60 * 1000 });
const lookupLimiter = createLimiter({ limit: cfg.LOOKUPS_PER_MIN, windowMs: 60 * 1000 });
// Wrong codes are what a brute-force attack produces, so they get a much
// tighter budget than normal traffic. 31^5 ≈ 28.6M possible codes.
const failLimiter = createLimiter({ limit: cfg.FAILED_LOOKUPS_PER_15MIN, windowMs: 15 * 60 * 1000 });

function tooMany(res, limiter, key, html) {
  stats.record('rateLimited');
  res.set('Retry-After', String(limiter.retryAfter(key)));
  if (html) return res.status(429).type('text/plain; charset=utf-8').send(MSG_TOO_MANY);
  return res.status(429).json({ error: MSG_TOO_MANY });
}

// Shared by the info and download routes. Resolves to the live meta, or
// sends the error response itself and resolves to null.
async function findOr404(req, res, { html }) {
  const ip = req.ip;
  if (failLimiter.blocked(ip)) { tooMany(res, failLimiter, ip, html); return null; }
  if (lookupLimiter.hit(ip)) { tooMany(res, lookupLimiter, ip, html); return null; }

  const code = store.normalizeCode(req.params.code);
  const meta = code && (await store.getLive(code));
  if (meta) return { code, meta };

  failLimiter.hit(ip);
  stats.record('failedLookup');
  if (html) res.status(404).sendFile(NOT_FOUND_PAGE);
  else res.status(404).json({ error: MSG_NOT_FOUND });
  return null;
}

// ---------- app ----------
const app = express();
app.set('trust proxy', cfg.TRUST_PROXY);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const upload = multer({
  storage: multer.diskStorage({
    destination: store.TMP_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: {
    fileSize: cfg.MAX_FILE_BYTES,
    files: 1,
    fields: 5,
    fieldSize: 1024,
    parts: 6,
    headerPairs: 50,
  },
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/api/config', (_req, res) => {
  res.json({ maxFileMb: cfg.MAX_FILE_MB, ttlMinutes: cfg.TTL_MS / 60000, codeLength: cfg.CODE_LEN });
});

// Failed uploads go to the journal too, so problems show up in the dashboard.
function logUploadFail(req, reason) {
  journal.log('upload_fail', {
    reason,
    size: parseInt(req.get('content-length'), 10) || 0,
    ms: Date.now() - req._t0,
    ip: journal.maskIp(req.ip),
  });
}

app.post('/api/upload', sameOrigin, wrap(async (req, res) => {
  req._t0 = Date.now();
  const ip = req.ip;
  if (uploadLimiter.hit(ip)) { logUploadFail(req, 'rate_limited'); return tooMany(res, uploadLimiter, ip, false); }

  // Refuse oversized or unsized bodies before reading a single byte.
  const len = parseInt(req.get('content-length'), 10);
  if (!Number.isFinite(len)) logUploadFail(req, 'no_length');
  if (!Number.isFinite(len)) return res.status(411).json({ error: 'حجم الطلب غير معروف' });
  if (len > cfg.MAX_FILE_BYTES + 64 * 1024) {
    stats.record('tooLarge');
    logUploadFail(req, 'too_large');
    return res.status(413).json({ error: `الحد الأقصى لحجم الملف ${cfg.MAX_FILE_MB} ميجابايت` });
  }

  const release = await store.reserveSpace(len);
  if (!release) { stats.record('storageFull'); logUploadFail(req, 'storage_full'); }
  if (!release) return res.status(507).json({ error: 'الخادم ممتلئ حالياً، حاول لاحقاً' });
  res.on('close', release);

  upload.single('file')(req, res, (err) => handleUpload(err, req, res).catch((e) => {
    console.error('upload failed', e);
    if (!res.headersSent) res.status(500).json({ error: 'خطأ في الخادم' });
  }).finally(release));
}));

async function handleUpload(err, req, res) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') stats.record('tooLarge');
    logUploadFail(req, err.code === 'LIMIT_FILE_SIZE' ? 'too_large' : req.destroyed || req.aborted ? 'aborted' : 'bad_request');
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `الحد الأقصى لحجم الملف ${cfg.MAX_FILE_MB} ميجابايت`
      : 'فشل الرفع';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
  }
  if (!req.file) { logUploadFail(req, 'no_file'); return res.status(400).json({ error: 'لم يتم اختيار ملف' }); }

  let code;
  try {
    code = await store.reserveCode();
    await fsp.rename(req.file.path, store.filePath(code));
    // multer decodes the name as latin1; restore UTF-8 (Arabic names etc.)
    const name = store.sanitizeName(Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
    const now = Date.now();
    const meta = { uid: journal.newUid(), name, size: req.file.size, createdAt: now, expiresAt: now + cfg.TTL_MS, downloads: 0 };
    await store.writeMeta(code, meta);
    store.addUsed(meta.size);
    stats.record('upload', meta.size);
    journal.log('upload', {
      uid: meta.uid, code, name, size: meta.size, ms: now - req._t0, ip: journal.maskIp(req.ip),
    });
    res.json({ code, name, size: meta.size, expiresAt: meta.expiresAt });
  } catch (e) {
    console.error('upload failed', e);
    logUploadFail(req, 'server_error');
    fsp.unlink(req.file.path).catch(() => {});
    if (code) await store.removeEntry(code);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

// Look up info without downloading
app.get('/api/file/:code', wrap(async (req, res) => {
  const found = await findOr404(req, res, { html: false });
  if (!found) return;
  const { code, meta } = found;
  res.json({ code, name: meta.name, size: meta.size, expiresAt: meta.expiresAt });
}));

// Download. Each download resets the inactivity timer.
app.get('/d/:code', wrap(async (req, res) => {
  const found = await findOr404(req, res, { html: true });
  if (!found) return;
  const { code, meta } = found;
  meta.downloads += 1;
  meta.lastDownloadAt = Date.now();
  meta.expiresAt = Date.now() + cfg.TTL_MS;
  await store.writeMeta(code, meta).catch(() => {});
  stats.record('download', meta.size);
  // Record whether the whole file was delivered, and how long it took.
  const t0 = Date.now();
  const uid = journal.uidOf(code, meta);
  let logged = false;
  const logDownload = (ok) => {
    if (logged) return;
    logged = true;
    journal.log('download', { uid, code, ok, ms: Date.now() - t0 });
  };
  res.on('finish', () => logDownload(true));
  res.on('close', () => logDownload(res.writableFinished));
  // Always an opaque attachment: an uploaded .html/.svg must never render
  // (and run script) on this site's origin.
  res.download(store.filePath(code), meta.name, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Security-Policy': DOWNLOAD_CSP,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}));

// Private admin dashboard (404 unless ADMIN_TOKEN is set).
app.use(admin.router({ failLimiter, lookupLimiter, uploadLimiter }));

// Hosted pages: pages/<name>.html is served at /k/<name> (short permanent links).
// These are our own self-contained pages with inline CSS/JS, so they get
// their own CSP that allows inline code but still no outside scripts.
app.get('/k/:name', (req, res, next) => {
  const name = req.params.name;
  if (!/^[a-z0-9-]{1,40}$/.test(name)) return next();
  res.set('Content-Security-Policy', PAGES_CSP);
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PAGES_DIR, `${name}.html`), (err) => { if (err) next(); });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

app.use((_req, res) => res.status(404).sendFile(NOT_FOUND_PAGE));

// Never leak stack traces or internals to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && err.code !== 'ENOENT') console.error(err);
  if (res.headersSent) return res.destroy();
  if (err && (err.code === 'ENOENT' || err.status === 404)) {
    return req.path.startsWith('/api/')
      ? res.status(404).json({ error: MSG_NOT_FOUND })
      : res.status(404).sendFile(NOT_FOUND_PAGE);
  }
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: 'خطأ في الخادم' });
  res.status(status).type('text/plain; charset=utf-8').send('خطأ في الخادم');
});

// ---------- start ----------
store.cleanup();
setInterval(store.cleanup, cfg.CLEANUP_INTERVAL_MS).unref();

const server = app.listen(cfg.PORT, '0.0.0.0', () => {
  console.log(`Snapload listening on 0.0.0.0:${cfg.PORT}, storage at ${cfg.UPLOAD_DIR}`);
});
// Drop connections that dribble headers to tie up sockets (slowloris).
server.headersTimeout = 20 * 1000;
// Large uploads on slow links need time; cap a single request at 1 hour.
server.requestTimeout = 60 * 60 * 1000;

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
