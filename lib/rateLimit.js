'use strict';

// Fixed-window counter per key. Each limiter has its own map, so limits on
// different routes never share (and corrupt) each other's counters.
// The map is capped so a flood of distinct IPs cannot exhaust memory.
const MAX_KEYS = 100000;

function createLimiter({ limit, windowMs }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
  }, Math.min(windowMs, 5 * 60 * 1000));
  sweep.unref();

  function entry(key) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.reset) {
      if (!h && hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value);
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    return h;
  }

  return {
    // Count one hit; true if the key is now over the limit.
    hit(key) {
      const h = entry(key);
      h.n++;
      return h.n > limit;
    },
    // True if the key is already over the limit (does not count).
    blocked(key) {
      const h = hits.get(key);
      return !!h && Date.now() <= h.reset && h.n >= limit;
    },
    // How many keys are over the limit right now.
    blockedCount() {
      const now = Date.now();
      let n = 0;
      for (const h of hits.values()) if (now <= h.reset && h.n >= limit) n++;
      return n;
    },
    retryAfter(key) {
      const h = hits.get(key);
      return h ? Math.max(1, Math.ceil((h.reset - Date.now()) / 1000)) : 1;
    },
  };
}

module.exports = { createLimiter };
