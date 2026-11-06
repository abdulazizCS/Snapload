(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const KEY = 'snapload-admin-token';
  const HOUR = 3600 * 1000;
  const REFRESH_MS = 30 * 1000;
  const SVGNS = 'http://www.w3.org/2000/svg';

  let token = '';
  let data = null;
  let range = '24h';
  let timer = null;

  // ---------- formatting ----------
  const nf = new Intl.NumberFormat('ar-EG-u-nu-latn');
  const fmtN = (n) => nf.format(n || 0);
  const fmtSize = (b) => {
    const u = ['بايت', 'ك.ب', 'م.ب', 'ج.ب', 'ت.ب'];
    let i = 0; b = b || 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i && b < 10 ? 1 : 0)} ${u[i]}`;
  };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short' });
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtLeft = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${m} د`;
  };
  const fmtUptime = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d} يوم ${h} س` : h ? `${h} س ${m} د` : `${m} د`;
  };

  const toast = (msg) => {
    const t = $('toast'); t.textContent = msg; show(t);
    clearTimeout(toast._t); toast._t = setTimeout(() => show(t, false), 2000);
  };

  // ---------- auth ----------
  function readToken() {
    // Private link: /admin#<token>. Take it, then drop it from the address bar.
    const h = decodeURIComponent(location.hash.slice(1));
    if (h) {
      history.replaceState(null, '', location.pathname);
      return h;
    }
    try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; }
  }
  function saveToken(t) { try { sessionStorage.setItem(KEY, t); } catch { /* private mode */ } }
  function clearToken() { token = ''; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

  function showLogin(msg) {
    clearInterval(timer);
    show($('app'), false); show($('login'));
    show($('loginError'), !!msg); $('loginError').textContent = msg || '';
    $('tokenIn').focus();
  }

  async function api(method, url) {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (r.status === 401) { clearToken(); showLogin('رمز الدخول غير صحيح'); throw new Error('auth'); }
    if (r.status === 429) { clearToken(); showLogin('محاولات كثيرة، حاول بعد 15 دقيقة'); throw new Error('rate'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'خطأ');
    return r.json();
  }

  async function load() {
    try {
      data = await api('GET', '/api/admin/stats');
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'rate') $('updated').textContent = 'تعذّر التحديث، سيُعاد المحاولة';
      return;
    }
    saveToken(token);
    show($('login'), false); show($('app'));
    render();
  }

  function start() {
    load();
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('tokenIn').value.trim();
    $('tokenIn').value = '';
    if (token) start();
  });
  $('logout').addEventListener('click', () => { clearToken(); data = null; showLogin(); });
  $('refresh').addEventListener('click', () => load().then(() => toast('تم التحديث')));
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.range;
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    if (data) renderCharts();
  }));

  // ---------- aggregation ----------
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // Returns [{t, label, up, dl, fail, upB, dlB}] for the chosen range.
  function series() {
    const now = data.now;
    const byHour = new Map(data.hours.map((h) => [h.t, h]));
    const slots = [];
    if (range === '24h') {
      const cur = Math.floor(now / HOUR) * HOUR;
      for (let i = 23; i >= 0; i--) {
        const t = cur - i * HOUR;
        const h = byHour.get(t) || {};
        slots.push({ t, end: t + HOUR, up: h.up || 0, dl: h.dl || 0, fail: h.fail || 0, upB: h.upB || 0, dlB: h.dlB || 0 });
      }
      return { slots, hourly: true };
    }
    const days = range === '7d' ? 7 : 30;
    const today = startOfDay(now);
    const index = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const s = { t: d.getTime(), up: 0, dl: 0, fail: 0, upB: 0, dlB: 0 };
      index.set(s.t, s); slots.push(s);
    }
    for (const h of data.hours) {
      const s = index.get(startOfDay(h.t));
      if (!s) continue;
      s.up += h.up || 0; s.dl += h.dl || 0; s.fail += h.fail || 0; s.upB += h.upB || 0; s.dlB += h.dlB || 0;
    }
    return { slots, hourly: false };
  }

  function todayTotals() {
    const t0 = startOfDay(data.now);
    const out = { up: 0, dl: 0, fail: 0, upB: 0, dlB: 0, rl: 0 };
    for (const h of data.hours) {
      if (h.t + HOUR <= t0) continue;
      for (const k of Object.keys(out)) out[k] += h[k] || 0;
    }
    return out;
  }

  // ---------- render ----------
  function render() {
    $('updated').textContent = `آخر تحديث ${fmtTime(data.now)} · يعمل منذ ${fmtUptime(data.uptimeSec)} · يتحدث تلقائياً كل 30 ثانية`;
    const today = todayTotals();

    $('kActive').textContent = fmtN(data.live.count);
    $('kActiveSub').textContent = fmtSize(data.live.bytes);
    $('kUpToday').textContent = fmtN(today.up);
    $('kUpTodaySub').textContent = fmtSize(today.upB);
    $('kDlToday').textContent = fmtN(today.dl);
    $('kDlTodaySub').textContent = fmtSize(today.dlB);
    $('kFailToday').textContent = fmtN(today.fail);
    const blocked = data.security.blockedIps;
    $('kBlocked').textContent = blocked ? `⚠ ${fmtN(blocked)} IP محظور الآن` : 'لا يوجد IP محظور';
    $('kBlocked').classList.toggle('warn', blocked > 0);

    // storage
    const st = data.storage;
    const used = st.usedBytes + st.pendingBytes;
    const pct = st.maxBytes ? Math.min(100, (used / st.maxBytes) * 100) : 0;
    $('storageText').textContent = `${fmtSize(used)} من ${fmtSize(st.maxBytes)} (${pct.toFixed(pct < 10 ? 1 : 0)}%)`;
    $('meterFill').style.width = `${pct}%`;
    $('meter').setAttribute('aria-valuenow', pct.toFixed(0));
    $('meter').classList.toggle('high', pct >= 75 && pct < 95);
    $('meter').classList.toggle('full', pct >= 95);
    $('diskText').textContent = Number.isFinite(st.freeDiskBytes) && st.freeDiskBytes !== null
      ? `المساحة الفارغة على القرص: ${fmtSize(st.freeDiskBytes)}${st.pendingBytes ? ` · قيد الرفع: ${fmtSize(st.pendingBytes)}` : ''}`
      : '';

    renderCharts();
    renderTotals();
    renderFiles();
  }

  function renderTotals() {
    const t = data.totals;
    $('sinceText').textContent = `(${fmtDate(data.since)})`;
    const rows = [
      ['ملفات مرفوعة', fmtN(t.up)],
      ['حجم المرفوع', fmtSize(t.upB)],
      ['عمليات تحميل', fmtN(t.dl)],
      ['حجم المُحمَّل', fmtSize(t.dlB)],
      ['ملفات حُذفت تلقائياً', fmtN(t.exp)],
      ['أكواد خاطئة', fmtN(t.fail)],
      ['طلبات أوقفها حد المحاولات', fmtN(t.rl)],
      ['رفع رُفض لكبر الحجم', fmtN(t.big)],
      ['رفع رُفض لامتلاء المساحة', fmtN(t.full)],
      ['دخول خاطئ للوحة التحكم', fmtN(t.adm)],
    ];
    const dl = $('totals');
    dl.replaceChildren(...rows.map(([k, v]) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      d.append(dt, dd); return d;
    }));
  }

  function renderFiles() {
    const tb = $('files');
    const files = data.live.files;
    show($('noFiles'), files.length === 0);
    $('filesNote').textContent = data.live.count > files.length ? `يُعرض أحدث ${fmtN(files.length)} من ${fmtN(data.live.count)}` : '';
    tb.replaceChildren(...files.map((f) => {
      const tr = document.createElement('tr');
      const td = (text, cls) => { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; };
      const name = td(f.name, 'name'); name.title = f.name;
      const del = document.createElement('button');
      del.className = 'btn danger'; del.textContent = 'حذف';
      del.addEventListener('click', () => removeFile(f.code, del));
      const act = document.createElement('td'); act.append(del);
      tr.append(
        td(f.code, 'code'), name, td(fmtSize(f.size), 'num'), td(fmtN(f.downloads), 'num'),
        td(fmtDateTime(f.createdAt), 'num'), td(fmtLeft(f.expiresAt - data.now), 'num'), act,
      );
      return tr;
    }));
  }

  // Two clicks to delete, no browser dialog.
  async function removeFile(code, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1'; btn.textContent = 'تأكيد الحذف؟';
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'حذف'; } }, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await api('DELETE', `/api/admin/file/${encodeURIComponent(code)}`);
      toast(`تم حذف ${code}`);
      load();
    } catch (e) {
      btn.disabled = false;
      if (e.message !== 'auth' && e.message !== 'rate') toast(e.message);
    }
  }

  // ---------- charts (plain SVG, one series each) ----------
  function renderCharts() {
    const { slots, hourly } = series();
    const sum = (k) => slots.reduce((n, s) => n + s[k], 0);
    $('cUpSum').textContent = fmtN(sum('up'));
    $('cDlSum').textContent = fmtN(sum('dl'));
    $('cFailSum').textContent = fmtN(sum('fail'));
    barChart($('cUp').querySelector('.plot'), slots, 'up', 'bar-up', hourly, (s) => `${fmtN(s.up)} رفع · ${fmtSize(s.upB)}`);
    barChart($('cDl').querySelector('.plot'), slots, 'dl', 'bar-dl', hourly, (s) => `${fmtN(s.dl)} تحميل · ${fmtSize(s.dlB)}`);
    barChart($('cFail').querySelector('.plot'), slots, 'fail', 'bar-fail', hourly, (s) => `${fmtN(s.fail)} كود خاطئ`);
  }

  const niceMax = (v) => {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  };
  const el = (name, attrs) => {
    const e = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  function barChart(host, slots, key, cls, hourly, tipText) {
    const W = 320, H = 150, L = 28, R = 4, T = 8, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const max = niceMax(Math.max(...slots.map((s) => s[key])));
    const step = pw / slots.length;
    const bw = Math.max(2, step - 2); // 2px surface gap between bars
    const y = (v) => T + ph - (v / max) * ph;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    svg.setAttribute('aria-label', `${host.parentElement.querySelector('figcaption').textContent}: الأعلى ${fmtN(max)}`);

    for (const g of [0, 0.5, 1]) {
      const v = max * g;
      svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: g === 0 ? 'base' : 'grid' }));
      const t = el('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end' });
      t.textContent = fmtN(Math.round(v * 10) / 10);
      svg.append(t);
    }

    const labelEvery = hourly ? 6 : slots.length > 10 ? 7 : 1;
    slots.forEach((s, i) => {
      const x = L + i * step + 1;
      const v = s[key];
      if (v > 0) {
        const top = y(v), h = Math.max(1.5, T + ph - top);
        const r = Math.min(3, bw / 2, h);
        // Rounded data end, square at the baseline.
        svg.append(el('path', {
          class: cls,
          d: `M${x},${T + ph} V${T + ph - h + r} Q${x},${T + ph - h} ${x + r},${T + ph - h} H${x + bw - r} Q${x + bw},${T + ph - h} ${x + bw},${T + ph - h + r} V${T + ph} Z`,
        }));
      }
      if (i % labelEvery === 0 || i === slots.length - 1 && !hourly && slots.length <= 10) {
        const t = el('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' });
        t.textContent = hourly ? fmtTime(s.t) : fmtDate(s.t);
        svg.append(t);
      }
      const hit = el('rect', { class: 'hit', x: L + i * step, y: T, width: step, height: ph });
      const label = hourly ? `${fmtTime(s.t)} – ${fmtTime(s.t + HOUR)}` : new Date(s.t).toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'short' });
      hit.addEventListener('mousemove', (e) => tip(e, `${label}\n${tipText(s)}`));
      hit.addEventListener('mouseleave', hideTip);
      svg.append(hit);
    });
    host.replaceChildren(svg);
  }

  function tip(e, text) {
    const t = $('tip');
    t.replaceChildren(...text.split('\n').map((line, i) => {
      const d = document.createElement('div'); d.textContent = line;
      if (i === 0) d.className = 'muted';
      return d;
    }));
    show(t);
    const r = t.getBoundingClientRect();
    let x = e.clientX + 12, yy = e.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
    if (yy < 8) yy = e.clientY + 16;
    t.style.left = `${x}px`; t.style.top = `${yy}px`;
  }
  function hideTip() { show($('tip'), false); }

  // ---------- boot ----------
  token = readToken();
  if (token) start(); else showLogin();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token && data) load(); });
})();
