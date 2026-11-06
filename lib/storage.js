'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cfg = require('./config');
const stats = require('./stats');

const FILES_DIR = path.join(cfg.UPLOAD_DIR, 'files');
const META_DIR = path.join(cfg.UPLOAD_DIR, 'meta');
const TMP_DIR = path.join(cfg.UPLOAD_DIR, 'tmp');
for (const d of [FILES_DIR, META_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

const CODE_RE = new RegExp(`^[${cfg.ALPHABET}]{${cfg.CODE_LEN}}$`);

// ---------- codes ----------
function randomCode() {
  let out = '';
  for (let i = 0; i < cfg.CODE_LEN; i++) out += cfg.ALPHABET[crypto.randomInt(cfg.ALPHABET.length)];
  return out;
}

// Only strings that match the code alphabet ever reach the filesystem,
// so a code can never be a path like "../x".
function normalizeCode(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

const metaPath = (code) => path.join(META_DIR, `${code}.json`);
const filePath = (code) => path.join(FILES_DIR, code);

// ---------- file names ----------
// Strip control characters and the invisible bidi marks used to disguise
// extensions (e.g. "photo‮gpj.exe" displays as "photoexe.jpg").
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g;
function sanitizeName(raw) {
  const name = String(raw || '')
    .normalize('NFC')
    .replace(UNSAFE_CHARS, '')
    .replace(/[/\\]/g, '_')
    .trim();
  const chars = Array.from(name);
  if (chars.length > 200) {
    const ext = path.extname(name).slice(0, 20);
    return chars.slice(0, 200 - Array.from(ext).length).join('') + ext;
  }
  return name || 'file';
}

// ---------- metadata ----------
async function readMeta(code) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(code), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMeta(code, meta) {
  const tmp = `${metaPath(code)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, metaPath(code));
}

async function removeEntry(code) {
  await Promise.allSettled([fsp.unlink(filePath(code)), fsp.unlink(metaPath(code))]);
}

const isLive = (meta) => !!(meta && meta.name && Date.now() <= meta.expiresAt);

// Look up a code; expired entries are deleted on sight.
async function getLive(code) {
  const meta = await readMeta(code);
  if (isLive(meta)) return meta;
  if (meta && meta.name) { await removeEntry(code); stats.record('expired'); }
  return null;
}

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

// ---------- disk quota ----------
// usedBytes is recounted from disk every cleanup and adjusted in between;
// pendingBytes holds space promised to uploads still in flight.
let usedBytes = 0;
let pendingBytes = 0;

async function dirSize(dir) {
  let total = 0;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (st && st.isFile()) total += st.size;
  }
  return total;
}

async function freeDiskBytes() {
  try {
    const s = await fsp.statfs(cfg.UPLOAD_DIR);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

// Returns a release() function, or null if there is no room for `bytes`.
async function reserveSpace(bytes) {
  if (usedBytes + pendingBytes + bytes > cfg.MAX_STORAGE_BYTES) return null;
  if ((await freeDiskBytes()) - pendingBytes - bytes < cfg.MIN_FREE_BYTES) return null;
  pendingBytes += bytes;
  let done = false;
  return () => {
    if (!done) { done = true; pendingBytes -= bytes; }
  };
}

const addUsed = (bytes) => { usedBytes += bytes; };

// ---------- cleanup ----------
async function cleanup() {
  try {
    const now = Date.now();
    for (const f of await fsp.readdir(META_DIR)) {
      const full = path.join(META_DIR, f);
      // Leftover temp meta files from an interrupted write
      if (f.endsWith('.tmp')) {
        const st = await fsp.stat(full).catch(() => null);
        if (st && now - st.mtimeMs > 3600 * 1000) await fsp.unlink(full).catch(() => {});
        continue;
      }
      if (!f.endsWith('.json')) continue;
      const code = f.slice(0, -5);
      const meta = await readMeta(code);
      if (!meta) continue;
      // Empty "{}" = a reservation; drop it if stale (> 1 day).
      if (!meta.name) {
        const st = await fsp.stat(full).catch(() => null);
        if (st && now - st.mtimeMs > 24 * 3600 * 1000) await removeEntry(code);
        continue;
      }
      if (now > meta.expiresAt) { await removeEntry(code); stats.record('expired'); }
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
    usedBytes = (await dirSize(FILES_DIR)) + (await dirSize(TMP_DIR));
  } catch (e) {
    console.error('cleanup error', e);
  }
}

// ---------- admin views ----------
// Every live file, newest first (admin dashboard only).
async function listLive() {
  const out = [];
  for (const f of await fsp.readdir(META_DIR).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const code = f.slice(0, -5);
    if (!normalizeCode(code)) continue;
    const meta = await readMeta(code);
    if (isLive(meta)) out.push({ code, ...meta });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function usage() {
  return {
    usedBytes,
    pendingBytes,
    maxBytes: cfg.MAX_STORAGE_BYTES,
    freeDiskBytes: await freeDiskBytes(),
  };
}

async function deleteFile(code) {
  const meta = await readMeta(code);
  if (!meta || !meta.name) return false;
  await removeEntry(code);
  usedBytes = Math.max(0, usedBytes - (meta.size || 0));
  return true;
}

module.exports = {
  listLive, usage, deleteFile,
  FILES_DIR, META_DIR, TMP_DIR,
  normalizeCode, sanitizeName, filePath,
  readMeta, writeMeta, removeEntry, getLive, reserveCode,
  reserveSpace, addUsed, cleanup,
};
