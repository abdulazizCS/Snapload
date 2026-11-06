'use strict';

const path = require('path');

const num = (name, def) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

// TRUST_PROXY: number of reverse proxies in front of the app (CranL = 1).
// Never "true": that lets any client spoof its IP via X-Forwarded-For
// and walk straight past the rate limits.
function trustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 1;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === 'true') return 1;
  if (raw === 'false') return 0;
  return raw; // e.g. "loopback, 10.0.0.0/8"
}

const MB = 1024 * 1024;

module.exports = Object.freeze({
  PORT: parseInt(process.env.PORT || '3000', 10),
  UPLOAD_DIR: path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')),
  MAX_FILE_BYTES: num('MAX_FILE_MB', 500) * MB,
  MAX_FILE_MB: num('MAX_FILE_MB', 500),
  // Total space all live files may use, and space always left free on the disk.
  MAX_STORAGE_BYTES: num('MAX_STORAGE_MB', 5120) * MB,
  MIN_FREE_BYTES: num('MIN_FREE_MB', 512) * MB,
  TTL_MS: num('TTL_MINUTES', 60) * 60 * 1000,
  CLEANUP_INTERVAL_MS: 60 * 1000,
  TRUST_PROXY: trustProxy(),
  // Rate limits (per client IP)
  UPLOADS_PER_10MIN: num('UPLOADS_PER_10MIN', 20),
  LOOKUPS_PER_MIN: num('LOOKUPS_PER_MIN', 60),
  FAILED_LOOKUPS_PER_15MIN: num('FAILED_LOOKUPS_PER_15MIN', 20),
  // Admin dashboard at /admin. Disabled (404) unless a token of 24+ chars is set.
  ADMIN_TOKEN: (process.env.ADMIN_TOKEN || '').length >= 24 ? process.env.ADMIN_TOKEN : '',
  // How long upload/download records are kept after the files are gone (0 = forever).
  JOURNAL_RETENTION_DAYS: num('JOURNAL_RETENTION_DAYS', 365),
  // No 0/O/1/I/L so codes are easy to read and type.
  ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  CODE_LEN: 5,
});
