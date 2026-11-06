'use strict';

// Private admin dashboard: /admin (page) and /api/admin/* (data).
//
// Access needs ADMIN_TOKEN (24+ chars). The private link is
//   https://<site>/admin#<ADMIN_TOKEN>
// The part after "#" never leaves the browser (not sent to the server,
// proxies or logs); the page sends it as a Bearer header instead.
// Without ADMIN_TOKEN every admin URL is a plain 404.

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const cfg = require('./config');
const store = require('./storage');
const stats = require('./stats');
const journal = require('./journal');
const { createLimiter } = require('./rateLimit');
const { sameOrigin } = require('./security');

const UI_DIR = path.join(__dirname, '..', 'admin-ui');
const NOT_FOUND_PAGE = path.join(__dirname, '..', 'public', 'notfound.html');
const MAX_LISTED = 500;

// Wrong tokens: 10 tries per IP per 15 minutes.
const denyLimiter = createLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

// Constant-time compare that does not leak the token's length.
function tokenOk(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(cfg.ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function noStore(_req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  next();
}

function enabled(req, res, next) {
  if (cfg.ADMIN_TOKEN) return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'غير موجود' });
  return res.status(404).sendFile(NOT_FOUND_PAGE);
}

function auth(req, res, next) {
  const ip = req.ip;
  if (denyLimiter.blocked(ip)) {
    res.set('Retry-After', String(denyLimiter.retryAfter(ip)));
    return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد قليل' });
  }
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token || !tokenOk(token)) {
    denyLimiter.hit(ip);
    stats.record('adminDenied');
    return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
  }
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function router({ failLimiter, lookupLimiter, uploadLimiter }) {
  const r = express.Router();
  const page = (file) => [enabled, noStore, (_req, res) => res.sendFile(path.join(UI_DIR, file))];

  r.get(['/admin', '/admin/'], ...page('index.html'));
  r.get('/admin/admin.js', ...page('admin.js'));
  r.get('/admin/admin.css', ...page('admin.css'));

  r.use('/api/admin', enabled, noStore, auth);

  r.get('/api/admin/stats', wrap(async (_req, res) => {
    const live = await store.listLive();
    const s = stats.snapshot();
    res.json({
      now: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      since: s.since,
      totals: s.totals,
      hours: s.hours,
      storage: await store.usage(),
      live: {
        count: live.length,
        bytes: live.reduce((n, f) => n + (f.size || 0), 0),
        files: live.slice(0, MAX_LISTED).map((f) => ({
          code: f.code,
          name: f.name,
          size: f.size,
          createdAt: f.createdAt,
          expiresAt: f.expiresAt,
          downloads: f.downloads || 0,
          lastDownloadAt: f.lastDownloadAt || null,
        })),
      },
      security: {
        blockedIps: failLimiter.blockedCount(),
        busyLookupIps: lookupLimiter.blockedCount(),
        busyUploadIps: uploadLimiter.blockedCount(),
      },
      config: {
        ttlMinutes: cfg.TTL_MS / 60000,
        maxFileMb: cfg.MAX_FILE_MB,
        uploadsPer10Min: cfg.UPLOADS_PER_10MIN,
        lookupsPerMin: cfg.LOOKUPS_PER_MIN,
        failedLookupsPer15Min: cfg.FAILED_LOOKUPS_PER_15MIN,
      },
    });
  }));

  // Permanent operations log + service performance.
  r.get('/api/admin/journal', wrap(async (_req, res) => {
    const { records, failures, downloads, firstAt } = await journal.records();
    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    // Upload speed only means something for files big enough to time.
    const timed = records.filter((x) => x.size >= 256 * 1024 && x.uploadMs > 0);
    const speeds = timed.map((x) => x.size / (x.uploadMs / 1000));
    // Rate-limit refusals are the protection working, not the service failing.
    const realFailures = failures.filter((f) => f.reason !== 'rate_limited');
    const attempts = records.length + realFailures.length;
    res.json({
      firstAt,
      records,
      failures: failures.slice(0, 1000),
      perf: {
        uploads: records.length,
        failedUploads: realFailures.length,
        successRate: attempts ? records.length / attempts : null,
        medianUploadMs: median(records.map((x) => x.uploadMs).filter((n) => n >= 0)),
        medianSpeedBps: median(speeds),
        downloadsCompleted: downloads.completed,
        downloadsAborted: downloads.aborted,
        medianDownloadMs: median(downloads.ms),
        neverDownloaded: records.filter((x) => x.deletedAt && x.downloads === 0).length,
        retentionDays: cfg.JOURNAL_RETENTION_DAYS,
      },
    });
  }));

  // Remove a file now (e.g. abusive content).
  r.delete('/api/admin/file/:code', sameOrigin, wrap(async (req, res) => {
    const code = store.normalizeCode(req.params.code);
    if (!code || !(await store.deleteFile(code))) return res.status(404).json({ error: 'الملف غير موجود' });
    res.json({ ok: true });
  }));

  return r;
}

module.exports = { router };
