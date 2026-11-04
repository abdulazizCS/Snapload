(() => {
  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let cfg = { maxFileMb: 500, ttlMinutes: 60 };
  let currentCode = null;

  const fmtSize = (b) => {
    const u = ['بايت', 'ك.ب', 'م.ب', 'ج.ب'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg; show(t);
    clearTimeout(toast._t); toast._t = setTimeout(() => show(t, false), 1800);
  };
  const copy = async (text, msg) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(msg);
  };

  fetch('/api/config').then((r) => r.json()).then((c) => {
    cfg = c;
    $('limitHint').textContent = `الحد الأقصى ${c.maxFileMb} ميجابايت`;
    $('ttl').textContent = c.ttlMinutes;
  }).catch(() => {});

  // ---------- upload ----------
  const drop = $('drop');
  const fileInput = $('fileInput');
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (f) uploadFile(f); });
  fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) uploadFile(f); });

  function resetUpload() {
    show(drop); show($('progress'), false); show($('result'), false); show($('uploadError'), false);
    fileInput.value = ''; currentCode = null;
  }

  function uploadFile(file) {
    show($('uploadError'), false);
    if (file.size > cfg.maxFileMb * 1024 * 1024) {
      $('uploadError').textContent = `الملف أكبر من الحد المسموح (${cfg.maxFileMb} ميجابايت)`;
      return show($('uploadError'));
    }
    show(drop, false); show($('progress'));
    $('fileName').textContent = `${file.name} (${fmtSize(file.size)})`;
    $('barFill').style.width = '0%';

    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    const started = Date.now();
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      $('barFill').style.width = pct + '%';
      const speed = e.loaded / Math.max((Date.now() - started) / 1000, 0.1);
      $('progressText').textContent = `${pct.toFixed(0)}% · ${fmtSize(speed)}/ث`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200) return fail(data.error || 'فشل الرفع');
      currentCode = data.code;
      show($('progress'), false); show($('result'));
      $('codeOut').textContent = data.code;
      $('expiryText').textContent = `يُحذف الملف الساعة ${fmtTime(data.expiresAt)} إذا لم يُحمّل.`;
    };
    xhr.onerror = () => fail('انقطع الاتصال أثناء الرفع');
    xhr.send(fd);

    function fail(msg) {
      show($('progress'), false); show(drop);
      $('uploadError').textContent = msg; show($('uploadError'));
      fileInput.value = '';
    }
  }

  $('copyCode').onclick = () => copy(currentCode, 'تم نسخ الكود');
  $('copyLink').onclick = () => copy(`${location.origin}/?c=${currentCode}`, 'تم نسخ الرابط');
  $('another').onclick = resetUpload;

  // ---------- download ----------
  const codeIn = $('codeIn');
  codeIn.addEventListener('input', () => {
    const clean = codeIn.value.toUpperCase().split('')
      .filter((ch) => ALPHABET.includes(ch)).join('').slice(0, 5);
    codeIn.value = clean;
    show($('getError'), false);
    $('fileInfo').textContent = '';
    if (clean.length === 5) lookup(clean);
  });

  async function lookup(code) {
    try {
      const r = await fetch(`/api/file/${code}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'خطأ');
      $('fileInfo').textContent = `📄 ${d.name} · ${fmtSize(d.size)}`;
      return true;
    } catch (e) {
      $('getError').textContent = e.message; show($('getError'));
      return false;
    }
  }

  $('getForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = codeIn.value;
    if (code.length !== 5) {
      $('getError').textContent = 'الكود يتكون من 5 خانات'; return show($('getError'));
    }
    if (await lookup(code)) location.href = `/d/${code}`;
  });

  // Shared link: /?c=CODE
  const pre = new URLSearchParams(location.search).get('c');
  if (pre) { codeIn.value = pre; codeIn.dispatchEvent(new Event('input')); codeIn.focus(); }
})();
