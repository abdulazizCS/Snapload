'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '500', 10);
const TTL_MS = parseFloat(process.env.TTL_MINUTES || '60') * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

// No 0/O/1/I/L so codes are easy to read and type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`);

const FILES_DIR = path.join(UPLOAD_DIR, 'files');
const META_DIR = path.join(UPLOAD_DIR, 'meta');
const TMP_DIR = path.join(UPLOAD_DIR, 'tmp');
for (const d of [FILES_DIR, META_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- helpers ----------
function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function normalizeCode(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

const metaPath = (code) => path.join(META_DIR, `${code}.json`);
const filePath = (code) => path.join(FILES_DIR, code);

async function readMeta(code) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(code), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMeta(code, meta) {
  const tmp = metaPath(code) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, metaPath(code));
}

async function removeEntry(code) {
  await Promise.allSettled([fsp.unlink(filePath(code)), fsp.unlink(metaPath(code))]);
}

const isExpired = (meta) => Date.now() > meta.expiresAt;

// Reserve a code atomically by creating its meta file exclusively.
async function reserveCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    try {
      await fsp.writeFile(metaPath(code), '{}', { flag: 'wx' });
      return code;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Could not allocate a code');
}

// ---------- simple per-IP rate limit for code lookups (anti brute force) ----------
const hits = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let h = hits.get(key);
    if (!h || now > h.reset) h = { n: 0, reset: now + windowMs };
    h.n++;
    hits.set(key, h);
    if (h.n > limit) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد قليل' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/api/config', (_req, res) => {
  res.json({ maxFileMb: MAX_FILE_MB, ttlMinutes: TTL_MS / 60000, codeLength: CODE_LEN });
});

app.post('/api/upload', rateLimit(30, 60 * 1000), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `الحد الأقصى لحجم الملف ${MAX_FILE_MB} ميجابايت` : 'فشل الرفع';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم اختيار ملف' });

    let code;
    try {
      code = await reserveCode();
      await fsp.rename(req.file.path, filePath(code));
      // multer decodes the name as latin1; restore UTF-8 (Arabic names etc.)
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const now = Date.now();
      const meta = {
        name,
        size: req.file.size,
        type: req.file.mimetype || 'application/octet-stream',
        createdAt: now,
        expiresAt: now + TTL_MS,
        downloads: 0,
      };
      await writeMeta(code, meta);
      res.json({ code, name, size: meta.size, expiresAt: meta.expiresAt });
    } catch (e) {
      console.error(e);
      if (req.file) fsp.unlink(req.file.path).catch(() => {});
      if (code) removeEntry(code);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });
});

// Look up info without downloading
app.get('/api/file/:code', rateLimit(60, 60 * 1000), async (req, res) => {
  const code = normalizeCode(req.params.code);
  const meta = code && (await readMeta(code));
  if (!meta || !meta.name || isExpired(meta)) {
    if (meta && meta.name) removeEntry(code);
    return res.status(404).json({ error: 'الكود غير صحيح أو انتهت صلاحية الملف' });
  }
  res.json({ code, name: meta.name, size: meta.size, expiresAt: meta.expiresAt });
});

// Download. Each download resets the 1-hour inactivity timer.
app.get('/d/:code', rateLimit(60, 60 * 1000), async (req, res) => {
  const code = normalizeCode(req.params.code);
  const meta = code && (await readMeta(code));
  if (!meta || !meta.name || isExpired(meta)) {
    if (meta && meta.name) removeEntry(code);
    return res.status(404).sendFile(path.join(__dirname, 'public', 'notfound.html'));
  }
  meta.downloads += 1;
  meta.lastDownloadAt = Date.now();
  meta.expiresAt = Date.now() + TTL_MS;
  await writeMeta(code, meta).catch(() => {});
  res.download(filePath(code), meta.name, {
    headers: { 'Content-Type': meta.type, 'Cache-Control': 'no-store' },
  });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- cleanup ----------
async function cleanup() {
  try {
    const now = Date.now();
    for (const f of await fsp.readdir(META_DIR)) {
      if (!f.endsWith('.json')) continue;
      const code = f.slice(0, -5);
      const meta = await readMeta(code);
      if (!meta) continue;
      // Empty "{}" = a reservation; drop it if stale (> 1 day).
      if (!meta.name) {
        const st = await fsp.stat(metaPath(code)).catch(() => null);
        if (st && now - st.mtimeMs > 24 * 3600 * 1000) await removeEntry(code);
        continue;
      }
      if (now > meta.expiresAt) await removeEntry(code);
    }
    // Orphan files (no meta) and stale temp uploads
    for (const f of await fsp.readdir(FILES_DIR)) {
      try { await fsp.access(metaPath(f)); } catch { await fsp.unlink(path.join(FILES_DIR, f)).catch(() => {}); }
    }
    for (const f of await fsp.readdir(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > 6 * 3600 * 1000) await fsp.unlink(p).catch(() => {});
    }
  } catch (e) {
    console.error('cleanup error', e);
  }
}
cleanup();
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Snapload listening on 0.0.0.0:${PORT}, storage at ${UPLOAD_DIR}`);
});
