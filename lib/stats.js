'use strict';

// Usage counters for the admin dashboard. No IPs, codes or file names are
// stored here: only counts and byte totals, per hour, for the last 31 days.
// Saved to UPLOAD_DIR/stats.json so they survive restarts (the volume).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.UPLOAD_DIR, 'stats.json');
const HOUR = 3600 * 1000;
const KEEP_HOURS = 31 * 24;
const FLUSH_MS = 30 * 1000;

// Event name -> [count field, bytes field?]
const EVENTS = {
  upload: ['up', 'upB'],
  download: ['dl', 'dlB'],
  expired: ['exp'],
  failedLookup: ['fail'], // wrong code entered
  rateLimited: ['rl'], // any 429 answered to a visitor
  storageFull: ['full'], // upload refused because the quota was reached
  tooLarge: ['big'], // upload refused for size
  adminDenied: ['adm'], // wrong admin token
};
const FIELDS = [...new Set(Object.values(EVENTS).flat())];

const blank = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));

let state = load();
let dirty = false;

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (s && s.totals && Array.isArray(s.hours)) {
      s.totals = { ...blank(), ...s.totals };
      return s;
    }
  } catch { /* first run or unreadable: start fresh */ }
  return { since: Date.now(), totals: blank(), hours: [] };
}

function bucket(now) {
  const t = Math.floor(now / HOUR) * HOUR;
  const hours = state.hours;
  let b = hours[hours.length - 1];
  if (!b || b.t !== t) {
    b = { t, ...blank() };
    hours.push(b);
    const cutoff = t - KEEP_HOURS * HOUR;
    while (hours.length && hours[0].t < cutoff) hours.shift();
  }
  return b;
}

function record(event, bytes = 0) {
  const spec = EVENTS[event];
  if (!spec) return;
  const [countField, bytesField] = spec;
  const b = bucket(Date.now());
  b[countField] += 1;
  state.totals[countField] += 1;
  if (bytesField && bytes > 0) {
    b[bytesField] += bytes;
    state.totals[bytesField] += bytes;
  }
  dirty = true;
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  const tmp = `${FILE}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(state));
    await fsp.rename(tmp, FILE);
  } catch (e) {
    dirty = true;
    console.error('stats flush failed', e.message);
  }
}

function flushSync() {
  if (!dirty) return;
  try { fs.writeFileSync(FILE, JSON.stringify(state)); dirty = false; } catch { /* ignore */ }
}

setInterval(flush, FLUSH_MS).unref();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { flushSync(); process.exit(0); });
}

const snapshot = () => ({
  since: state.since,
  totals: { ...state.totals },
  hours: state.hours.map((h) => ({ ...h })),
});

module.exports = { record, snapshot, flush, FIELDS };
