'use strict';

// Permanent operations journal. Every upload, download, deletion and failed
// upload is appended as one JSON line to UPLOAD_DIR/journal/YYYY-MM.jsonl.
// Files are deleted after their TTL, but their journal entries stay (for
// JOURNAL_RETENTION_DAYS), so the admin can review the service's history
// and performance. File contents are never kept here, only metadata.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cfg = require('./config');

const DIR = path.join(cfg.UPLOAD_DIR, 'journal');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

const monthOf = (ts) => new Date(ts).toISOString().slice(0, 7); // UTC "2026-11"
const fileFor = (ts) => path.join(DIR, `${monthOf(ts)}.jsonl`);

// Appends are chained so lines never interleave.
let chain = Promise.resolve();
function log(ev, fields = {}) {
  const t = Date.now();
  const line = JSON.stringify({ t, ev, ...fields }) + '\n';
  chain = chain
    .then(() => fsp.appendFile(fileFor(t), line, { mode: 0o600 }))
    .catch((e) => console.error('journal write failed', e.message));
  return chain;
}

const newUid = () => crypto.randomBytes(6).toString('hex');
// Old files uploaded before the journal existed have no uid.
const uidOf = (code, meta) => (meta && meta.uid) || `${code}-${meta && meta.createdAt}`;

// Keep enough of the IP to spot abuse patterns, not to identify a person:
// IPv4 -> 1.2.3.x, IPv6 -> first 3 groups.
function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  const v4 = s.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (v4) return `${v4[1]}.x`;
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}::/48`;
  return '';
}

async function monthFiles() {
  const names = (await fsp.readdir(DIR).catch(() => [])).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f));
  return names.sort();
}

async function readAll() {
  const out = [];
  for (const f of await monthFiles()) {
    const text = await fsp.readFile(path.join(DIR, f), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line after a crash */ }
    }
  }
  return out;
}

// Folds the event stream into one record per upload, plus failed uploads.
async function records() {
  const events = await readAll();
  const byUid = new Map();
  const failures = [];
  const downloads = { completed: 0, aborted: 0, ms: [] };
  for (const e of events) {
    if (e.ev === 'upload') {
      byUid.set(e.uid, {
        uid: e.uid, code: e.code, name: e.name, size: e.size, ip: e.ip || '',
        uploadedAt: e.t, uploadMs: e.ms, downloads: 0, abortedDownloads: 0,
        lastDownloadAt: null, deletedAt: null, deleteReason: null,
      });
    } else if (e.ev === 'download') {
      const r = byUid.get(e.uid);
      if (e.ok) {
        downloads.completed++; downloads.ms.push(e.ms);
        if (r) { r.downloads++; r.lastDownloadAt = e.t; }
      } else {
        downloads.aborted++;
        if (r) r.abortedDownloads++;
      }
    } else if (e.ev === 'delete') {
      const r = byUid.get(e.uid);
      if (r && !r.deletedAt) { r.deletedAt = e.t; r.deleteReason = e.reason; }
    } else if (e.ev === 'upload_fail') {
      failures.push({ t: e.t, reason: e.reason, size: e.size || 0, ms: e.ms || 0, ip: e.ip || '' });
    }
  }
  const recs = [...byUid.values()].sort((a, b) => b.uploadedAt - a.uploadedAt);
  failures.sort((a, b) => b.t - a.t);
  return { records: recs, failures, downloads, firstAt: events.length ? events[0].t : null };
}

// Drop whole months older than the retention period.
async function prune() {
  const days = cfg.JOURNAL_RETENTION_DAYS;
  if (!days) return;
  const cutoff = monthOf(Date.now() - days * 24 * 3600 * 1000);
  for (const f of await monthFiles()) {
    if (f.slice(0, 7) < cutoff) await fsp.unlink(path.join(DIR, f)).catch(() => {});
  }
}

module.exports = { log, newUid, uidOf, maskIp, records, prune, DIR, flushed: () => chain };
