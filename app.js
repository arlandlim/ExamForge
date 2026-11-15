/* ExamForge v2.0 - personal MCQ question bank and examination system. No AI: every answer is confirmed by you. */
'use strict';

const VERSION = '2.0';
const KEY = 'examforge.db.v1';
const L = 'ABCDEFGH';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const qLabel = (n) => n + (n === 1 ? ' question' : ' questions');
const modeLabel = (m) => (m === 'exam' ? 'Examination Mode' : 'Practice Mode');
const pct = (a) => (a.total ? Math.round((a.score / a.total) * 100) : 0) + '%';

function fmt(sec) {
  const s = Math.max(0, sec | 0);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ------------------------------------------------------------------ data */
let db = null;
const store = { mode: 'local', rev: 0, queue: Promise.resolve(), ok: true, urls: [], info: null, locked: false, loginError: '' };

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    v: 1,
    banks: Array.isArray(d.banks) ? d.banks : [],
    questions: Array.isArray(d.questions) ? d.questions : [],
    attempts: Array.isArray(d.attempts) ? d.attempts : [],
    imports: Array.isArray(d.imports) ? d.imports : [],
    deleted: d.deleted && typeof d.deleted === 'object' && !Array.isArray(d.deleted) ? d.deleted : {}
  };
}

/* Merge two copies of the bank record by record. The newer edit of a record wins,
   a deletion wins over an older edit, and the result has one fixed order so that
   two devices that hold the same records produce exactly the same text. */
function mergeDb(x, y) {
  const a = normalize(x); const b = normalize(y);
  const del = {};
  [a.deleted, b.deleted].forEach((d) => Object.keys(d).forEach((k) => { if (!(del[k] >= d[k])) del[k] = d[k]; }));
  const out = { v: 1 };
  ['banks', 'questions', 'attempts', 'imports'].forEach((k) => {
    const map = new Map();
    a[k].concat(b[k]).forEach((r) => {
      if (!r || !r.id) return;
      const cur = map.get(r.id);
      if (!cur || (r.updated || 0) > (cur.updated || 0)) map.set(r.id, r);
    });
    out[k] = Array.from(map.values()).filter((r) => !(del[r.id] >= (r.updated || 0)));
  });
  const bankIds = {};
  out.banks.forEach((r) => { bankIds[r.id] = true; });
  out.questions = out.questions.filter((q) => bankIds[q.bankId]);
  const byId = (p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
  const asc = (p, q) => (p.created || 0) - (q.created || 0) || byId(p, q);
  out.banks.sort(asc); out.questions.sort(asc); out.imports.sort(asc);
  out.attempts.sort((p, q) => (q.at || 0) - (p.at || 0) || byId(q, p));
  out.deleted = {};
  Object.keys(del).sort().forEach((k) => { out.deleted[k] = del[k]; });
  return out;
}

async function fetchInfo() {
  try {
    const r = await fetch('api/info', { cache: 'no-store' });
    if (r.ok) { store.info = await r.json(); store.urls = store.info.urls || []; }
  } catch (e) { /* optional */ }
}

async function serverLogin(code) {
  try {
    const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) });
    return r.status;
  } catch (e) { return 0; }
}

async function loadDb() {
  if (location.protocol.indexOf('http') === 0) {
    try {
      let r = await fetch('api/db', { cache: 'no-store' });
      if (r.headers.get('X-ExamForge')) {
        const m = location.hash.match(/code=([A-Za-z0-9]+)/);
        if (r.status === 401 && m) { await serverLogin(m[1]); r = await fetch('api/db', { cache: 'no-store' }); }
        if (m) history.replaceState(null, '', location.pathname);
        if (r.status === 401) { store.mode = 'server'; store.locked = true; return normalize(null); }
        if (r.ok) {
          const j = await r.json();
          store.mode = 'server'; store.rev = j.rev || 0;
          await fetchInfo();
          return normalize(j.data);
        }
      }
    } catch (e) { /* not our server: fall back to browser storage */ }
  }
  try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return normalize(null); }
}

function persist(fromSync) {
  if (!fromSync) cloudDirty();
  if (store.mode === 'server') {
    store.queue = store.queue.then(async () => {
      try {
        const r = await fetch('api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rev: store.rev, data: db }) });
        if (r.status === 401) { store.locked = true; render(); return; }
        const j = await r.json();
        if (r.status === 409) {
          db = normalize(j.data); store.rev = j.rev;
          ui.toast = 'The question bank was changed on another device. The latest version is now loaded; please repeat your last change.';
          ui.toastErr = true;
          render();
        } else if (r.ok) { store.rev = j.rev; setSync(true); } else { setSync(false); }
      } catch (e) { setSync(false); }
    });
  } else {
    try { localStorage.setItem(KEY, JSON.stringify(db)); setSync(true); } catch (e) { setSync(false); }
  }
}

function setSync(ok) {
  if (typeof ok === 'boolean') store.ok = ok;
  const el = $('#sync');
  if (!el) return;
  let t;
  if (!store.ok) t = 'Not saved. Check that ExamForge is still running, then export a backup.';
  else t = store.mode === 'server' ? 'Saved in the ExamForge folder on your PC.' : 'Saved on this device.';
  el.textContent = t + ' ' + cloudLine();
  const el2 = $('#cloudline');
  if (el2) el2.textContent = cloudLine();
}

/* ------------------------------------------------------- cloud sync (GitHub) */
const SYNC_KEY = 'examforge.sync.v1';
const DATA_FILE = 'examforge-bank.json';
const cloud = { cfg: null, state: 'off', last: 0, msg: '', busy: false, dirty: false, timer: null, showQr: false, form: { owner: '', repo: 'examforge-data', token: '', app: '', code: '' }, formError: '' };

function loadCloudCfg() {
  try { cloud.cfg = JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) { cloud.cfg = null; }
  if (cloud.cfg && !(cloud.cfg.owner && cloud.cfg.repo && cloud.cfg.token)) cloud.cfg = null;
  if (cloud.cfg) { cloud.last = cloud.cfg.last || 0; cloud.state = 'idle'; }
}

function saveCloudCfg() {
  try {
    if (cloud.cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(Object.assign({}, cloud.cfg, { last: cloud.last })));
    else localStorage.removeItem(SYNC_KEY);
  } catch (e) { /* storage blocked */ }
}

function cloudLine() {
  if (!cloud.cfg) return 'Cloud sync is not set up.';
  if (cloud.state === 'busy') return 'Syncing…';
  if (cloud.state === 'error') return 'Sync problem: ' + cloud.msg;
  const when = cloud.last ? 'Last synced ' + new Date(cloud.last).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.' : 'Not synced yet.';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'Offline. Changes are kept on this device and sync when you are back online. ' + when;
  return (cloud.dirty ? 'Changes waiting to sync. ' : '') + when;
}

const ghBase = () => (cloud.cfg.api || 'https://api.github.com') + '/repos/' + encodeURIComponent(cloud.cfg.owner) + '/' + encodeURIComponent(cloud.cfg.repo);
const ghHeaders = (raw) => ({ Authorization: 'Bearer ' + cloud.cfg.token, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghError(status) {
  const e = new Error(status === 401 ? 'GitHub did not accept the access token. It may have expired; create a new one and connect again.'
    : status === 403 ? 'GitHub refused the request. Check that the token has “Contents: Read and write” for the data repository.'
    : status === 404 ? 'The data repository was not found, or the token cannot see it.'
    : 'GitHub answered with error ' + status + '.');
  e.status = status;
  return e;
}

async function ghCheckRepo() {
  const r = await fetch(ghBase(), { headers: ghHeaders(false), cache: 'no-store' });
  if (!r.ok) throw ghError(r.status);
  const j = await r.json();
  if (j.permissions && j.permissions.push === false) throw ghError(403);
  return j;
}

async function ghRead() {
  const url = ghBase() + '/contents/' + DATA_FILE;
  const r = await fetch(url, { headers: ghHeaders(false), cache: 'no-store' });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw ghError(r.status);
  const j = await r.json();
  let text;
  if (j.content) text = b64dec(j.content);
  else {
    const r2 = await fetch(url, { headers: ghHeaders(true), cache: 'no-store' });
    if (!r2.ok) throw ghError(r2.status);
    text = await r2.text();
  }
  let data = null;
  try { const parsed = JSON.parse(text); data = parsed && parsed.data ? parsed.data : parsed; } catch (e) { data = null; }
  return { sha: j.sha, data: data };
}

async function ghWrite(data, sha) {
  const body = { message: 'ExamForge sync ' + new Date().toISOString(), content: b64enc(JSON.stringify({ app: 'ExamForge', saved: new Date().toISOString(), data: data })) };
  if (sha) body.sha = sha;
  const r = await fetch(ghBase() + '/contents/' + DATA_FILE, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(false)), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) return false; /* another device saved first: read again */
  if (!r.ok) throw ghError(r.status);
  return true;
}

function cloudDirty() {
  if (!cloud.cfg) return;
  cloud.dirty = true;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(() => cloudSync(false), 5000);
}

const quietScreen = () => !(ui.exam.stage === 'run' || ui.screen === 'add' || (ui.screen === 'import' && ui.imp.stage === 'review'));

async function cloudSync(manual) {
  if (!cloud.cfg || cloud.busy || !db) return;
  if (!manual && ui.exam.stage === 'run') { cloudDirty(); return; }
  if (navigator.onLine === false) { cloud.state = 'idle'; setSync(); if (manual && ui.screen === 'dash') render(); return; }
  cloud.busy = true; cloud.state = 'busy'; setSync();
  try {
    let done = false;
    for (let i = 0; i < 4 && !done; i++) {
      const remote = await ghRead();
      const merged = mergeDb(db, remote.data);
      const text = JSON.stringify(merged);
      if (!remote.data || text !== JSON.stringify(mergeDb(remote.data, null))) {
        if (!(await ghWrite(merged, remote.sha))) continue;
      }
      const before = JSON.stringify(mergeDb(db, null));
      const fin = mergeDb(db, merged); /* keeps anything typed while the request was running */
      const finText = JSON.stringify(fin);
      cloud.dirty = finText !== text;
      db = fin;
      if (finText !== before) { persist(true); fixBankIds(); if (quietScreen()) render(); }
      done = true;
    }
    if (!done) throw new Error('Another device kept saving at the same time. Try again in a moment.');
    cloud.state = 'idle'; cloud.msg = ''; cloud.last = Date.now(); saveCloudCfg();
    if (cloud.dirty) cloudDirty();
  } catch (e) {
    if (e && e.status) { cloud.state = 'error'; cloud.msg = e.message; }
    else if (e && /Another device/.test(e.message)) { cloud.state = 'error'; cloud.msg = e.message; }
    else { cloud.state = 'idle'; cloud.dirty = true; } /* network problem: treated as offline, retried later */
  }
  cloud.busy = false;
  setSync();
  if (manual && ui.screen === 'dash') render();
}

function b64url(str) { return b64enc(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDec(str) { return b64dec(str.replace(/-/g, '+').replace(/_/g, '/')); }

/* A phone set up by QR code arrives with #sync=... in the address. */
function takeSyncFromHash() {
  const m = location.hash.match(/sync=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const j = JSON.parse(b64urlDec(m[1]));
    if (j.o && j.r && j.t) { cloud.cfg = { owner: j.o, repo: j.r, token: j.t }; if (j.a) cloud.cfg.api = j.a; cloud.state = 'idle'; cloud.last = 0; saveCloudCfg(); }
  } catch (e) { /* ignore a damaged link */ }
  history.replaceState(null, '', location.pathname);
  return !!cloud.cfg;
}

function cloudHtml() {
  if (!cloud.cfg) {
    const f = cloud.form;
    return '<h3>Cloud sync between PC and phone</h3><p>Each device keeps its own copy and works with no internet. When a device is online it syncs through a private GitHub repository that only you can open. Follow <b>PHONE-AND-SYNC-SETUP.txt</b> in the ExamForge folder once, then fill this in.</p>' +
      '<div class="grid"><div class="field"><label for="ghowner">GitHub user name</label><input id="ghowner" type="text" data-in="ghOwner" autocomplete="off" autocapitalize="none" value="' + esc(f.owner) + '"></div>' +
      '<div class="field"><label for="ghrepo">Data repository (private)</label><input id="ghrepo" type="text" data-in="ghRepo" autocomplete="off" autocapitalize="none" value="' + esc(f.repo) + '"></div></div>' +
      '<div class="field"><label for="ghtoken">Access token (starts with github_pat_)</label><input id="ghtoken" type="text" data-in="ghToken" data-enter="cloudConnect" autocomplete="off" autocapitalize="none" spellcheck="false" value="' + esc(f.token) + '"></div>' +
      '<div class="field"><label for="ghcode">Or paste a setup code copied from a device that is already connected</label><input id="ghcode" type="text" data-in="ghCode" data-enter="cloudConnect" autocomplete="off" autocapitalize="none" spellcheck="false" value="' + esc(f.code) + '"></div>' +
      (cloud.formError ? '<div class="note err" role="alert">' + esc(cloud.formError) + '</div>' : '') +
      '<div><button class="btn primary" data-act="cloudConnect">' + (cloud.busy ? 'Connecting…' : 'Connect and sync') + '</button></div>';
  }
  const c = cloud.cfg;
  const appUrl = cloud.form.app || (/\.github\.io$/.test(location.hostname) ? location.origin + location.pathname : 'https://' + c.owner + '.github.io/examforge/');
  let h = '<h3>Cloud sync between PC and phone</h3><p>Connected to <code>' + esc(c.owner + '/' + c.repo) + '</code>. <span id="cloudline">' + esc(cloudLine()) + '</span></p>' +
    '<div class="row"><button class="btn primary" data-act="cloudNow">Sync now</button><button class="btn" data-act="cloudQr">' + (cloud.showQr ? 'Hide phone setup code' : 'Set up a phone') + '</button><button class="btn danger" data-act="cloudOff">Disconnect</button></div>';
  if (cloud.showQr) {
    const payload = b64url(JSON.stringify(c.api ? { o: c.owner, r: c.repo, t: c.token, a: c.api } : { o: c.owner, r: c.repo, t: c.token }));
    h += '<div class="field"><label for="ghapp">Address of your phone app (GitHub Pages)</label><input id="ghapp" type="text" data-in="ghApp" data-enter="cloudQrRefresh" autocapitalize="none" value="' + esc(appUrl) + '"></div>' +
      '<div class="row" style="align-items:flex-start;gap:16px"><div class="qr"><div class="qrbox big" data-qr="' + esc(appUrl.replace(/#.*$/, '') + '#sync=' + payload) + '" data-qr-level="L" role="img" aria-label="QR code that opens ExamForge on the phone and connects it to your cloud sync"></div></div>' +
      '<div class="stack xs grow small"><p>1. Scan this code with the phone camera. ExamForge opens and connects itself.</p><p>2. In the phone browser menu choose <b>Add to Home Screen</b>. From then on it opens like an app and works with no internet.</p><p>3. Keep this code private. It contains your access token, which lets a device read and change your question bank.</p><p>iPhone: the Home Screen app starts separately from Safari. After adding it, open it, go to Dashboard and paste the setup code there.</p><div><button class="btn" data-act="cloudCopy" data-id="' + esc('sync=' + payload) + '">Copy setup code</button></div></div></div>';
  }
  return h;
}

async function refreshFromServer() {
  if (store.mode !== 'server') return;
  if (ui.exam.stage === 'run' || ui.screen === 'add' || (ui.screen === 'import' && ui.imp.stage === 'review')) return;
  try {
    const r = await fetch('api/db', { cache: 'no-store' });
    if (r.status === 401) { store.locked = true; render(); return; }
    if (!r.ok) return;
    const j = await r.json();
    if ((j.rev || 0) !== store.rev) { db = normalize(j.data); store.rev = j.rev || 0; render(); }
  } catch (e) { /* offline */ }
}

const tomb = (id) => { db.deleted[id] = Date.now(); };
const countIn = (id) => db.questions.filter((q) => q.bankId === id).length;
const bankName = (id) => { const b = db.banks.find((x) => x.id === id); return b ? b.name : 'No bank selected'; };

/* -------------------------------------------------------------- ui state */
const blankDraft = (bankId) => ({ editingId: null, bankId: bankId, text: '', options: [0, 1, 2, 3].map(() => ({ id: uid(), text: '' })), correctIds: [], multi: false, explanation: '', topic: '', difficulty: 'Medium', reference: '', source: 'manual' });
const blankImport = (bankId) => ({ stage: 'upload', bankId: bankId, paste: '', fileName: '', items: [], idx: 0, error: '', busy: '', pages: 0 });
const blankExam = (cfg) => Object.assign({ stage: 'setup', bankId: null, count: 10, mode: 'practice', shuffleQ: true, shuffleA: true, minutes: 10, items: [], idx: 0, answers: {}, flags: {}, revealed: {}, elapsed: 0, limit: 0 }, cfg || {});

const ui = { screen: 'dash', bankId: null, search: '', newBank: '', draft: blankDraft(null), draftError: '', toast: '', toastErr: false, imp: blankImport(null), exam: blankExam(), viewAttempt: null, wrongOnly: false };
const lastOrder = {};

const NAV = [
  { id: 'dash', label: 'Dashboard', short: 'Home', sub: 'Overview and recent activity', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { id: 'banks', label: 'Question Banks', short: 'Banks', sub: 'Create and manage MCQs', icon: 'M5 4v16M9 4v16M13 4v16M16.5 5.5l3.5 14' },
  { id: 'import', label: 'Import Questions', short: 'Import', sub: 'Upload PDF question papers', icon: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 17v-6M9.5 13.5L12 11l2.5 2.5' },
  { id: 'exam', label: 'Take Examination', short: 'Exam', sub: 'Practice or timed exams', icon: 'M9 4h6v3H9zM7 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-1M9 12h6M9 16h6' },
  { id: 'results', label: 'Results & History', short: 'Results', sub: 'Scores, incorrect answers and progress', icon: 'M5 20V11M12 20V4M19 20v-6' }
];
const icon = (d, size) => '<svg aria-hidden="true" width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
const CHECK = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* ------------------------------------------------------------ PDF import */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

async function ensurePdf() {
  if (window.pdfjsLib) return;
  await loadScript('lib/pdf.worker.min.js'); /* loaded on the page itself so it also works when opened as a file */
  await loadScript('lib/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
}

/* Rebuild text lines from positioned PDF text items. */
function itemsToLines(items, page) {
  const rows = [];
  items.forEach((it) => {
    if (!it.str || !it.str.trim()) return;
    const x = it.transform[4], y = it.transform[5];
    const tol = Math.max(2, (it.height || 10) * 0.4);
    let row = rows.find((r) => Math.abs(r.y - y) <= tol);
    if (!row) { row = { y: y, parts: [] }; rows.push(row); }
    row.parts.push({ x: x, str: it.str, w: it.width || 0 });
  });
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let s = ''; let endX = null;
    r.parts.forEach((p) => {
      if (endX !== null && p.x - endX > 1 && !/\s$/.test(s) && !/^\s/.test(p.str)) s += ' ';
      s += p.str; endX = p.x + p.w;
    });
    return { text: s.replace(/\s+/g, ' ').trim(), page: page };
  }).filter((l) => l.text);
}

async function pdfToLines(file) {
  await ensurePdf();
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    lines = lines.concat(itemsToLines(tc.items, p));
  }
  return { lines: lines, pages: doc.numPages };
}

/* Split numbered questions and lettered choices. Never marks an answer. */
function parseLines(lines) {
  const expanded = [];
  lines.forEach((ln) => {
    const t = (ln.text || '').trim();
    if (!t) return;
    if (/^\(?[Aa][.)]\s+/.test(t) && /\s\(?[Bb][.)]\s+/.test(t)) {
      t.split(/\s+(?=\(?[B-Hb-h][.)]\s)/).forEach((part) => expanded.push({ text: part.trim(), page: ln.page }));
    } else expanded.push({ text: t, page: ln.page });
  });
  const items = [];
  let cur = null; let last = null;
  expanded.forEach((ln) => {
    const line = ln.text;
    const am = line.match(/^(?:correct\s+answer|answer|ans|key)\s*[:.\-]?\s*\(?([A-Ha-h])\)?(?![A-Za-z])/i);
    if (am && cur) { cur.hint = am[1].toUpperCase(); last = null; return; }
    const xm = line.match(/^(?:explanation|rationale|reason)\s*[:.\-]\s*(.*)$/i);
    if (xm && cur) { cur.explanation = xm[1]; last = { obj: cur, key: 'explanation' }; return; }
    const om = line.match(/^\(?([A-Ha-h])[.)]\s+(.+)$/);
    const qm = line.match(/^(?:Q(?:uestion)?\.?\s*)?(\d{1,4})\s*[.):]\s+(\S.*)$/i);
    if (om && cur && L.indexOf(om[1].toUpperCase()) === cur.options.length) {
      const o = { id: uid(), text: om[2] };
      cur.options.push(o); last = { obj: o, key: 'text' };
    } else if (qm) {
      cur = { key: uid(), num: qm[1], text: qm[2], options: [], correctIds: [], explanation: '', hint: '', page: ln.page || 0, status: 'pending', savedId: null };
      items.push(cur); last = { obj: cur, key: 'text' };
    } else if (last) {
      last.obj[last.key] = (last.obj[last.key] + ' ' + line).trim();
    }
  });
  return items.filter((it) => it.options.length >= 2);
}

async function importPdf(file) {
  if (!file) return;
  if (!ui.imp.bankId) { ui.imp.error = 'Create a question bank first, then import into it.'; render(); return; }
  ui.imp.error = ''; ui.imp.busy = 'Reading ' + file.name + '…'; render();
  try {
    const res = await pdfToLines(file);
    const items = parseLines(res.lines);
    ui.imp.busy = '';
    if (!res.lines.length) {
      ui.imp.error = 'This PDF has no selectable text (it is probably a scan). OCR is not part of this version, so type these questions manually or paste the text.';
    } else if (!items.length) {
      ui.imp.error = 'Text was found, but no numbered questions with lettered choices (1. … A. … B. …). You can copy the text from the PDF, tidy it in the box below and extract it from there.';
      ui.imp.paste = res.lines.map((l) => l.text).join('\n');
    } else {
      const raw = {};
      res.lines.forEach((l) => { raw[l.page] = (raw[l.page] || '') + l.text + '\n'; });
      Object.assign(ui.imp, { stage: 'review', items: items, idx: 0, fileName: file.name, pages: res.pages, raw: raw });
    }
  } catch (e) {
    ui.imp.busy = '';
    ui.imp.error = 'The PDF could not be read (' + (e && e.message ? e.message : 'unknown error') + '). If it is password-protected, remove the password first.';
  }
  render();
}

/* ---------------------------------------------------------------- views */
function toastHtml() {
  if (!ui.toast) return '';
  return '<div class="note row between' + (ui.toastErr ? ' err' : '') + '" role="status"><span>' + esc(ui.toast) + '</span><button class="btn" data-act="toastOff">Dismiss</button></div>';
}

function attRow(a) {
  return '<button class="listbtn" data-act="openAttempt" data-id="' + a.id + '"><b>' + esc(a.bankName) + '</b><span class="muted">' + modeLabel(a.mode) + ' · ' + esc(a.date) + '</span><b>' + a.score + ' / ' + a.total + ' · ' + pct(a) + '</b></button>';
}

function bankChips(act, selected, withCount) {
  if (!db.banks.length) return '<p class="muted">No question banks yet. Create one under Question Banks.</p>';
  return '<div class="row">' + db.banks.map((b) => '<button class="chip' + (b.id === selected ? ' on' : '') + '" aria-pressed="' + (b.id === selected) + '" data-act="' + act + '" data-id="' + b.id + '">' + esc(b.name) + (withCount ? '<small>' + qLabel(countIn(b.id)) + '</small>' : '') + '</button>').join('') + '</div>';
}

const sw = (act, on, label, desc) => '<button class="switch" role="switch" aria-checked="' + !!on + '" data-act="' + act + '"><span>' + label + (desc ? '<small>' + desc + '</small>' : '') + '</span><span class="track"><i></i></span></button>';

const views = {};

views.dash = () => {
  const last = db.attempts[0];
  const stats = [['Question banks', db.banks.length], ['Questions saved', db.questions.length], ['Examinations taken', db.attempts.length], ['Last score', last ? pct(last) : '–']];
  let devices;
  if (store.mode === 'server') {
    devices = devicesHtml();
  } else {
    devices = '<p>Your question bank is stored on this device, in this browser. It works with no internet. Export a backup now and then.</p>';
  }
  return '<div class="stack">' +
    '<div class="stack xs"><h1>Dashboard</h1><p class="muted">Prepare the question bank once, then use it for self-paced or timed examinations.</p></div>' +
    '<div class="grid" style="--min:150px">' + stats.map((s) => '<div class="stat"><span class="label">' + s[0] + '</span><b>' + s[1] + '</b></div>').join('') + '</div>' +
    (db.banks.length ? '' : '<div class="card"><span class="pill green" style="align-self:flex-start">Start here</span><h2>Create your first question bank</h2>' + newBankForm() + '</div>') +
    '<div class="grid" style="--min:260px">' + NAV.slice(1).map((n) => '<button class="menu" data-act="go" data-id="' + n.id + '">' + icon(n.icon, 22) + '<b>' + esc(n.label) + '</b><span class="muted small">' + n.sub + '</span></button>').join('') + '</div>' +
    '<div class="card"><h2>Recent activity</h2>' + (db.attempts.length ? db.attempts.slice(0, 3).map(attRow).join('') : '<p class="muted">No examinations taken yet. Your scores will appear here.</p>') + '</div>' +
    '<div class="card"><h2>Backup and devices</h2>' + devices + cloudHtml() + '<h3>Backup file</h3>' +
    '<div class="row"><button class="btn" data-act="exportDb">Export backup</button><label class="btn filebtn">Import backup<input type="file" accept="application/json,.json" data-file="backup"></label></div>' +
    '<p class="muted small">Import adds banks, questions and results that are not already here. Nothing is overwritten. ExamForge v' + VERSION + '</p></div>' +
    '</div>';
};

function devicesHtml() {
  const info = store.info || { local: true, urls: [], tunnel: {} };
  if (!info.local) return '<p>This device is connected to ExamForge on your PC and uses the same question bank. Keep the “ExamForge server” window open on the PC.</p>';
  const t = info.tunnel || {};
  const entries = [];
  if (t.url) entries.push({ u: t.url, label: 'Internet address', note: 'Works from any network, also through a company firewall' });
  (info.urls || []).forEach((u) => entries.push({ u: u, label: 'Same Wi-Fi address', note: t.url ? 'Only if the PC firewall allows it' : 'Phone and PC on the same Wi-Fi' }));
  let h = '<p>Your question bank is stored in the <b>data</b> folder inside the ExamForge folder on your PC.</p><details' + (t.enabled ? ' open' : '') + '><summary>Other way: connect a phone directly to this PC (needs the PC switched on)</summary><div class="stack tight" style="padding-top:8px">';
  if (t.enabled && !t.url && !t.error) h += '<div class="note plain" role="status">Opening the internet address for your phone… this takes a few seconds.</div>';
  if (t.error) h += '<div class="note err" role="alert">' + esc(t.error) + '</div>';
  if (entries.length) {
    h += '<p>Scan a code with the phone camera. The code signs the phone in. If you type the address instead, the phone asks for the access code: <code>' + esc(info.code) + '</code></p>' +
      '<div class="row" style="align-items:flex-start;gap:16px">' + entries.map((e) => '<div class="qr"><b class="small">' + e.label + '</b><div class="qrbox" data-qr="' + esc(e.u + '/#code=' + info.code) + '" role="img" aria-label="QR code for ' + esc(e.u) + '"></div><code>' + esc(e.u) + '</code><span class="muted small" style="max-width:200px;text-align:center">' + e.note + '</span></div>').join('') + '</div>';
  }
  if (t.url) h += '<p class="muted small">The internet address is public and temporary: it changes every time and stops when the server window is closed. Only someone with the access code can open your bank. Do not share the QR code.</p>';
  else if (!t.enabled) h += '<details><summary>The phone says the site cannot be reached</summary><div class="stack xs small" style="padding-top:6px">' +
    '<p>The Wi-Fi address only works when Windows Firewall on this PC allows incoming connections. On a company PC it is usually blocked by policy and cannot be changed.</p>' +
    '<p>In that case close ExamForge and start it with <b>Start ExamForge (phone via internet).bat</b>. It gives the phone an internet address that does not need the firewall to be opened.</p>' +
    '<p><b>Phone access check.bat</b> creates a report showing what is blocked.</p></div></details>';
  return h + '</div></details>';
}

function loginHtml() {
  return '<div class="card" style="max-width:420px"><h1>Enter access code</h1><p class="muted">This is the 8-character code shown on the ExamForge Dashboard on your PC, under “Backup and devices”. Scanning the QR code there enters it for you.</p>' +
    '<div class="field"><label for="code">Access code</label><input id="code" type="text" data-in="code" data-enter="unlock" autocomplete="off" autocapitalize="characters" style="font-size:20px;letter-spacing:0.15em;text-transform:uppercase"></div>' +
    (store.loginError ? '<div class="note err" role="alert">' + esc(store.loginError) + '</div>' : '') +
    '<button class="btn primary big" data-act="unlock">Open ExamForge</button></div>';
}

function newBankForm() {
  return '<div class="row end"><div class="field grow"><label for="newbank">New question bank</label><input id="newbank" type="text" data-in="newBank" data-enter="addBank" value="' + esc(ui.newBank) + '" placeholder="Subject or category name"></div><button class="btn" data-act="addBank">Create bank</button></div>';
}

function rowsHtml() {
  const inBank = db.questions.filter((q) => q.bankId === ui.bankId);
  const term = ui.search.trim().toLowerCase();
  const rows = inBank.filter((q) => !term || q.text.toLowerCase().indexOf(term) >= 0 || (q.topic || '').toLowerCase().indexOf(term) >= 0);
  if (!rows.length) return '<p class="muted">' + (inBank.length ? 'No questions match your search.' : 'This bank is empty. Add a question or import a PDF.') + '</p>';
  return rows.map((q) => {
    const ans = q.options.map((o, i) => (q.correctIds.indexOf(o.id) >= 0 ? L[i] : '')).filter(Boolean).join(', ');
    const meta = [q.topic, q.difficulty, q.source === 'pdf' ? 'PDF import' : 'Manual entry', q.reference].filter(Boolean).join(' · ');
    return '<div class="qrow"><div class="qtext stack xs"><b>' + (inBank.indexOf(q) + 1) + '. ' + esc(q.text) + '</b><span class="muted small">' + esc(meta) + '</span></div><span class="pill green">Correct: ' + ans + '</span><div class="row"><button class="btn" data-act="editQ" data-id="' + q.id + '">Edit</button><button class="btn danger" data-act="delQ" data-id="' + q.id + '">Delete</button></div></div>';
  }).join('');
}

views.banks = () => {
  const has = db.banks.some((b) => b.id === ui.bankId);
  return '<div class="stack">' +
    '<div class="stack xs"><h1>Question Banks</h1><p class="muted">Your permanent master database. Examinations never change it.</p></div>' +
    '<div class="card">' + (db.banks.length ? '<div class="row">' + db.banks.map((b) => '<button class="chip' + (b.id === ui.bankId ? ' on' : '') + '" aria-pressed="' + (b.id === ui.bankId) + '" data-act="openBank" data-id="' + b.id + '">' + esc(b.name) + '<small>' + qLabel(countIn(b.id)) + '</small></button>').join('') + '</div>' : '') + newBankForm() + '</div>' +
    (has ? '<div class="card"><div class="row between"><h2>' + esc(bankName(ui.bankId)) + ' · ' + qLabel(countIn(ui.bankId)) + '</h2><div class="row"><button class="btn" data-act="renameBank">Rename</button><button class="btn danger" data-act="delBank">Delete bank</button><button class="btn" data-act="goImportBank">Import PDF</button><button class="btn primary" data-act="newQ">Add question</button></div></div>' +
      '<div class="field"><label for="search">Search this bank</label><input id="search" type="search" data-in="search" value="' + esc(ui.search) + '" placeholder="Question text or topic"></div>' +
      '<div class="stack tight" id="rows">' + rowsHtml() + '</div></div>' : '') +
    '</div>';
};

function choiceRows(options, correctIds, prefix, removable) {
  return options.map((o, i) => {
    const on = correctIds.indexOf(o.id) >= 0;
    return '<div class="choice' + (on ? ' on' : '') + '"><span class="letter">' + L[i] + '</span><input type="text" data-in="' + prefix + 'Opt" data-id="' + o.id + '" value="' + esc(o.text) + '" aria-label="Choice ' + L[i] + '" placeholder="Answer choice">' +
      (removable ? '<button class="iconbtn" data-act="' + prefix + 'Remove" data-id="' + o.id + '" aria-label="Remove choice ' + L[i] + '">' + CROSS + '</button>' : '') +
      '<button class="iconbtn' + (on ? ' on' : '') + '" data-act="' + prefix + 'Mark" data-id="' + o.id + '" aria-pressed="' + on + '" aria-label="Mark ' + L[i] + ' as the correct answer"><span class="markdot">' + (on ? CHECK : '') + '</span></button></div>';
  }).join('');
}

views.add = () => {
  const d = ui.draft;
  const letters = d.options.map((o, i) => (d.correctIds.indexOf(o.id) >= 0 ? L[i] : '')).filter(Boolean).join(', ');
  return '<div class="card">' +
    '<div class="row between"><h1>' + (d.editingId ? 'Edit Question' : 'Add New Question') + '</h1><span class="pill">Manual Entry</span></div>' +
    '<div class="field"><span class="label">Question Bank</span>' + bankChips('dBank', d.bankId) + '</div>' +
    '<div class="field"><label for="dtext">Question</label><textarea id="dtext" rows="3" data-in="dText" placeholder="Type the question">' + esc(d.text) + '</textarea></div>' +
    '<div class="stack tight"><div class="row between"><div><h2>Answer Choices</h2><span class="muted small">Select the mark beside ' + (d.multi ? 'every correct answer.' : 'the correct answer.') + '</span></div>' + sw('dMulti', d.multi, 'More than one correct answer') + '</div>' +
    choiceRows(d.options, d.correctIds, 'd', d.options.length > 2) +
    (d.options.length < 8 ? '<div><button class="btn dashed" data-act="dAddOpt">Add another choice</button></div>' : '') + '</div>' +
    '<div class="field"><label for="dexpl">Explanation</label><textarea id="dexpl" rows="3" data-in="dExpl" placeholder="Explain why the answer is correct">' + esc(d.explanation) + '</textarea></div>' +
    '<div class="grid"><div class="field"><label for="dtopic">Topic / Chapter (optional)</label><input id="dtopic" type="text" data-in="dTopic" value="' + esc(d.topic) + '"></div>' +
    '<div class="field"><label for="dref">Reference (optional)</label><input id="dref" type="text" data-in="dRef" value="' + esc(d.reference) + '" placeholder="Source or page number"></div>' +
    '<div class="field"><span class="label">Difficulty</span><div class="row">' + ['Easy', 'Medium', 'Hard'].map((x) => '<button class="chip' + (d.difficulty === x ? ' on' : '') + '" style="flex:1 1 0;align-items:center" aria-pressed="' + (d.difficulty === x) + '" data-act="dDiff" data-id="' + x + '">' + x + '</button>').join('') + '</div></div></div>' +
    '<div class="row between"><span class="muted small">Question status: ' + (d.editingId ? 'Saved, editing' : 'Draft') + '</span><span class="pill' + (letters ? ' green' : '') + '">Correct answer: ' + (letters || 'not marked') + '</span></div>' +
    (ui.draftError ? '<div class="note err" role="alert">' + esc(ui.draftError) + '</div>' : '') +
    '<div class="grid" style="--min:180px"><button class="btn" data-act="dCancel">Cancel</button><button class="btn outline" data-act="dSaveNext">Save &amp; Add Next</button><button class="btn primary" data-act="dSave">Save Question</button></div>' +
    '</div>';
};

views.import = () => {
  const im = ui.imp;
  const head = '<div class="stack xs"><h1>Import Questions from PDF</h1><p class="muted">Text is extracted for you. You confirm every question and mark its answer before it is saved.</p></div>';
  if (im.stage === 'upload') {
    return '<div class="stack">' + head + '<div class="card">' +
      '<div class="field"><span class="label">Destination Question Bank</span>' + bankChips('iBank', im.bankId) + '</div>' +
      '<div class="drop" id="drop">' + icon(NAV[2].icon, 32) + '<h2>Upload PDF Question Paper</h2><p class="muted small">Select a PDF containing multiple-choice questions, or drop it here</p>' +
      (im.busy ? '<p role="status"><b>' + esc(im.busy) + '</b></p>' : '<label class="btn primary filebtn">Choose PDF<input type="file" accept="application/pdf,.pdf" data-file="pdf"></label>') +
      '<span class="pill">PDF with selectable text</span></div>' +
      (im.error ? '<div class="note err" role="alert">' + esc(im.error) + '</div>' : '') +
      '<div class="field"><label for="paste">Or paste text copied from a PDF</label><textarea id="paste" rows="6" data-in="iPaste" placeholder="1. Question text&#10;A. First choice&#10;B. Second choice">' + esc(im.paste) + '</textarea></div>' +
      '<div><button class="btn outline" data-act="iParse">Extract questions from text</button></div>' +
      '<p class="muted small">Works best with papers laid out as “1. Question” followed by “A.”, “B.”, “C.” choices in a single column. The PDF is read on this device and is not uploaded anywhere.</p>' +
      '</div></div>';
  }
  if (im.stage === 'done') {
    const nC = im.items.filter((x) => x.status === 'confirmed').length;
    const nS = im.items.length - nC;
    return '<div class="stack">' + head + '<div class="card"><h2>Import complete</h2><p>' + qLabel(nC) + ' saved to ' + esc(bankName(im.bankId)) + (nS ? ' · ' + nS + ' not saved' : '') + '.</p><div class="row"><button class="btn primary" data-act="iViewBank">View question bank</button><button class="btn" data-act="iReset">Import another PDF</button></div></div></div>';
  }
  const cur = im.items[im.idx];
  const n = im.items.length;
  const nC = im.items.filter((x) => x.status === 'confirmed').length;
  const status = cur.status === 'confirmed' ? '<span class="pill green">Confirmed and saved</span>' : cur.status === 'skipped' ? '<span class="pill">Skipped</span>' : '<span class="pill green">Question ' + esc(cur.num || im.idx + 1) + ' extracted</span>';
  const raw = im.raw && im.raw[cur.page] ? '<details><summary>Show the text read from page ' + cur.page + '</summary><pre class="raw">' + esc(im.raw[cur.page]) + '</pre></details>' : '';
  return '<div class="stack">' + head + '<div class="card">' +
    '<div class="row between"><h2>Extracted Question Preview</h2><span class="muted small">' + esc(im.fileName) + ' → ' + esc(bankName(im.bankId)) + '</span></div>' +
    '<div class="bar"><i style="width:' + Math.round(((im.idx + 1) / n) * 100) + '%"></i></div>' +
    '<div class="row">' + status + (cur.hint ? '<span class="pill orange">The PDF lists “' + cur.hint + '” as the answer. Not marked: confirm it yourself.</span>' : '') + '</div>' +
    '<div class="field"><label for="itext">Question (correct the extracted text if needed)</label><textarea id="itext" rows="2" data-in="iText" style="font-weight:600;font-size:15px">' + esc(cur.text) + '</textarea></div>' +
    '<div class="stack tight"><h3>Mark the correct answer</h3>' + choiceRows(cur.options, cur.correctIds, 'i', cur.options.length > 2) + '</div>' +
    '<div class="field"><label for="iexpl">Explanation</label><textarea id="iexpl" rows="2" data-in="iExpl" placeholder="Enter your explanation here">' + esc(cur.explanation) + '</textarea></div>' +
    raw +
    '<div class="row between muted small"><span>Question ' + (im.idx + 1) + ' of ' + n + ' · ' + nC + ' confirmed</span><span>' + (cur.page ? 'Page ' + cur.page + ' of PDF' : 'From pasted text') + '</span></div>' +
    (im.error ? '<div class="note err" role="alert">' + esc(im.error) + '</div>' : '') +
    '<div class="grid" style="--min:150px"><button class="btn" data-act="iPrev">Previous</button><button class="btn" data-act="iSkip">Skip</button><button class="btn primary" data-act="iConfirm">' + (im.idx >= n - 1 ? 'Confirm &amp; Finish' : 'Confirm &amp; Next') + '</button></div>' +
    '<div><button class="btn" data-act="iFinish">Finish import now</button></div>' +
    '</div></div>';
};

views.exam = () => {
  const e = ui.exam;
  if (e.stage === 'setup') {
    const poolN = countIn(e.bankId);
    const eff = Math.max(poolN ? 1 : 0, Math.min(e.count, poolN));
    const isP = e.mode !== 'exam';
    const stepper = (label, value, down, up) => '<div class="field"><span class="label">' + label + '</span><div class="row"><button class="btn sq" data-act="' + down + '" aria-label="Decrease ' + label + '">−</button><b style="min-width:84px;text-align:center;font-size:18px">' + value + '</b><button class="btn sq" data-act="' + up + '" aria-label="Increase ' + label + '">+</button></div></div>';
    return '<div class="stack"><div class="stack xs"><h1>Take Examination</h1><p class="muted">Each attempt is saved separately. Your question bank is never modified.</p></div><div class="card">' +
      '<div class="field"><span class="label">Question Bank</span>' + bankChips('eBank', e.bankId, true) + '</div>' +
      '<div class="field"><span class="label">Examination mode</span><div class="grid" style="--min:240px">' +
      '<button class="chip' + (isP ? ' on' : '') + '" aria-pressed="' + isP + '" data-act="eMode" data-id="practice">Practice Mode<small>Check each answer and read its explanation as you go. Timer counts up.</small></button>' +
      '<button class="chip' + (!isP ? ' on' : '') + '" aria-pressed="' + !isP + '" data-act="eMode" data-id="exam">Examination Mode<small>Answers and explanations stay hidden until you submit. Timed.</small></button></div></div>' +
      '<div class="grid">' + stepper('Number of questions', eff + ' of ' + poolN, 'eCountDown', 'eCountUp') + (isP ? '' : stepper('Time limit', e.minutes + ' min', 'eMinDown', 'eMinUp')) + '</div>' +
      '<div class="stack xs">' + sw('eShufQ', e.shuffleQ, 'Shuffle questions', 'A new question order on every attempt.') + sw('eShufA', e.shuffleA, 'Shuffle answer choices', 'Correct answers follow the choice, not its letter.') + '</div>' +
      (poolN ? '<button class="btn primary big" data-act="eStart">Start examination</button>' : '<div class="note err" role="alert">This bank has no questions yet. Add or import questions first.</div>') +
      '</div></div>';
  }
  const it = e.items[e.idx];
  const q = it.q;
  const sel = e.answers[q.id] || [];
  const revealed = !!e.revealed[q.id];
  const isP = e.mode !== 'exam';
  const right = isRight(q, sel);
  const flagged = !!e.flags[q.id];
  const isLast = e.idx === e.items.length - 1;
  const answeredN = e.items.filter((x) => (e.answers[x.q.id] || []).length > 0).length;
  const opts = it.order.map((id, i) => {
    const o = q.options.find((x) => x.id === id) || { text: '' };
    const chosen = sel.indexOf(id) >= 0;
    const correct = q.correctIds.indexOf(id) >= 0;
    let cls = chosen ? ' sel' : ''; let tag = '';
    if (revealed) {
      if (correct) { cls = ' ok'; tag = chosen ? 'Your answer · correct' : 'Correct answer'; }
      else if (chosen) { cls = ' bad'; tag = 'Your answer · incorrect'; }
      else cls = '';
      cls += ' locked';
    }
    return '<button class="opt' + cls + '" data-act="ePick" data-id="' + id + '" aria-pressed="' + chosen + '"><span class="dot">' + L[i] + '</span><span class="t">' + esc(o.text) + '</span><span class="tag">' + tag + '</span></button>';
  }).join('');
  return '<div class="card">' +
    '<div class="row between"><h1 style="font-size:20px">' + esc(bankName(e.bankId)) + '</h1><span class="pill' + (isP ? ' orange' : '') + '">' + modeLabel(e.mode) + '</span></div>' +
    '<div class="row between"><span class="muted small">Question ' + (e.idx + 1) + ' of ' + e.items.length + '</span><span class="timer" id="timer" aria-label="' + (e.limit ? 'Time remaining' : 'Time elapsed') + '">' + fmt(e.limit ? e.limit - e.elapsed : e.elapsed) + '</span></div>' +
    '<div class="bar"><i style="width:' + Math.round(((e.idx + 1) / e.items.length) * 100) + '%"></i></div>' +
    '<div class="stack xs"><div style="font-size:17px;font-weight:600">' + esc(q.text) + '</div>' + (q.correctIds.length > 1 ? '<span class="muted small">Select all that apply.</span>' : '') + '</div>' +
    '<div class="stack tight">' + opts + '</div>' +
    (isP && sel.length && !revealed ? '<div><button class="btn outline" data-act="eReveal">Check answer</button></div>' : '') +
    (revealed ? '<div class="note' + (right ? '' : ' err') + '"><div>' + (right ? 'Correct' : 'Incorrect') + '</div><div style="font-weight:400;color:var(--ink)">' + esc(q.explanation || 'No explanation was entered for this question.') + '</div></div>' : '') +
    '<div class="row between" style="padding-top:12px;border-top:1px solid var(--line)"><button class="btn" data-act="ePrev">Previous</button><button class="btn' + (flagged ? ' danger' : '') + '" aria-pressed="' + flagged + '" data-act="eFlag">' + (flagged ? 'Flagged ⚑' : 'Flag for Review') + '</button><button class="btn primary" data-act="eNext">' + (isLast ? 'Submit' : 'Next') + '</button></div>' +
    '<div class="stack xs"><span class="label">Question navigator: ' + answeredN + ' of ' + e.items.length + ' answered</span><div class="row">' +
    e.items.map((x, i) => { const a = (e.answers[x.q.id] || []).length > 0; const f = !!e.flags[x.q.id]; return '<button class="pal' + (a ? ' ans' : '') + (f ? ' flag' : '') + (i === e.idx ? ' cur' : '') + '" data-act="eJump" data-id="' + i + '" aria-label="Question ' + (i + 1) + (a ? ', answered' : ', not answered') + (f ? ', flagged' : '') + '">' + (i + 1) + (f ? ' ⚑' : '') + '</button>'; }).join('') +
    '</div><span class="muted small">Filled = answered · ⚑ = flagged for review</span></div>' +
    '<div class="row between"><button class="btn danger" data-act="eQuit">Quit without saving</button><button class="btn" data-act="eSubmit">Submit examination now</button></div>' +
    '</div>';
};

views.results = () => {
  const att = db.attempts.find((a) => a.id === ui.viewAttempt);
  if (!att) {
    return '<div class="stack"><h1>Results &amp; History</h1><div class="card">' + (db.attempts.length ? db.attempts.map(attRow).join('') : '<p class="muted">No attempts yet. Take an examination to see your scores, incorrect answers and explanations here.</p><div><button class="btn primary" data-act="go" data-id="exam">Take examination</button></div>') + '</div></div>';
  }
  const list = att.detail.map((d, i) => Object.assign({ n: i + 1 }, d)).filter((d) => !ui.wrongOnly || !d.right);
  return '<div class="stack"><h1>Results &amp; History</h1>' +
    '<div class="card"><div class="row between"><div class="stack xs"><span class="label">' + esc(att.bankName) + ' · ' + modeLabel(att.mode) + ' · ' + esc(att.date) + '</span><div class="score">' + pct(att) + '</div><span>' + att.score + ' of ' + att.total + ' correct · time ' + fmt(att.seconds) + '</span></div>' +
    '<div class="row"><button class="btn" data-act="rBack">All attempts</button><button class="btn danger" data-act="rDelete">Delete attempt</button><button class="btn primary" data-act="rRetake">Retake with new shuffle</button></div></div></div>' +
    sw('rWrong', ui.wrongOnly, 'Show incorrect answers only') +
    (list.length ? list.map((d) => '<div class="card"><div class="row between" style="align-items:flex-start"><b class="grow">' + d.n + '. ' + esc(d.text) + '</b><span class="pill ' + (d.right ? 'green' : 'rust') + '">' + (d.right ? 'Correct' : d.answered ? 'Incorrect' : 'Not answered') + '</span></div><div class="stack xs">' +
      d.options.map((o) => '<div class="opt' + (o.correct ? ' ok' : o.chosen ? ' bad' : '') + '"><b class="small">' + o.letter + '</b><span class="t">' + esc(o.text) + '</span><span class="tag">' + (o.correct ? (o.chosen ? 'Your answer · correct' : 'Correct answer') : o.chosen ? 'Your answer · incorrect' : '') + '</span></div>').join('') +
      '</div>' + (d.explanation ? '<p class="small"><b>Explanation:</b> ' + esc(d.explanation) + '</p>' : '') + '</div>').join('') : '<p class="muted">Nothing to show. Every answer in this attempt was correct.</p>') +
    '</div>';
};

function render() {
  if (store.locked) { $('#nav').innerHTML = ''; $('#tabs').innerHTML = ''; $('#view').innerHTML = loginHtml(); return; }
  const navScreen = ui.screen === 'add' ? 'banks' : ui.screen;
  $('#nav').innerHTML = NAV.map((n) => '<button class="navbtn' + (n.id === navScreen ? ' on' : '') + '"' + (n.id === navScreen ? ' aria-current="page"' : '') + ' data-act="go" data-id="' + n.id + '">' + icon(n.icon) + '<span>' + esc(n.label) + '</span></button>').join('');
  $('#tabs').innerHTML = NAV.map((n) => '<button class="tabbtn' + (n.id === navScreen ? ' on' : '') + '"' + (n.id === navScreen ? ' aria-current="page"' : '') + ' data-act="go" data-id="' + n.id + '">' + icon(n.icon, 22) + '<span>' + n.short + '</span></button>').join('');
  $('#view').innerHTML = '<div class="stack">' + toastHtml() + views[ui.screen]() + '</div>';
  drawQrs();
}

async function drawQrs() {
  const boxes = document.querySelectorAll('[data-qr]');
  if (!boxes.length) return;
  try {
    if (!window.qrcode) await loadScript('lib/qrcode.js');
    boxes.forEach((el) => {
      const qr = window.qrcode(0, el.dataset.qrLevel || 'M');
      qr.addData(el.dataset.qr);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    });
  } catch (e) { /* the typed address still works */ }
}

/* -------------------------------------------------------------- actions */
function isRight(q, sel) {
  return (sel || []).slice().sort().join('|') === q.correctIds.slice().sort().join('|');
}

function fixBankIds() {
  const ok = (id) => db.banks.some((b) => b.id === id);
  const first = db.banks[0] ? db.banks[0].id : null;
  if (!ok(ui.bankId)) ui.bankId = first;
  if (!ok(ui.draft.bankId)) ui.draft.bankId = ui.bankId;
  if (!ok(ui.imp.bankId)) ui.imp.bankId = ui.bankId;
  if (ui.exam.stage === 'setup' && !ok(ui.exam.bankId)) ui.exam.bankId = ui.bankId;
}

function saveDraft(next) {
  const d = ui.draft;
  const text = d.text.trim();
  const opts = d.options.filter((o) => o.text.trim()).map((o) => ({ id: o.id, text: o.text.trim() }));
  const correct = d.correctIds.filter((id) => opts.some((o) => o.id === id));
  let err = '';
  if (!d.bankId) err = 'Create a question bank first.';
  else if (!text) err = 'Enter the question text.';
  else if (opts.length < 2) err = 'Enter at least two answer choices.';
  else if (!correct.length) err = 'Mark the correct answer.';
  if (err) { ui.draftError = err; render(); return; }
  const q = { id: d.editingId || uid(), bankId: d.bankId, text: text, options: opts, correctIds: correct, explanation: d.explanation.trim(), topic: d.topic.trim(), difficulty: d.difficulty, reference: d.reference.trim(), source: d.source || 'manual' };
  const prev = db.questions.find((x) => x.id === q.id);
  q.updated = Date.now(); q.created = prev && prev.created ? prev.created : q.updated;
  if (d.editingId) db.questions = db.questions.map((x) => (x.id === q.id ? q : x)); else db.questions.push(q);
  persist();
  ui.draftError = ''; ui.toastErr = false;
  if (next) {
    ui.draft = blankDraft(q.bankId); ui.draft.topic = q.topic; ui.draft.difficulty = q.difficulty;
    ui.toast = 'Saved to ' + bankName(q.bankId) + '. Ready for the next question.';
    render();
    const el = $('#dtext'); if (el) el.focus();
  } else {
    ui.draft = blankDraft(q.bankId); ui.screen = 'banks'; ui.bankId = q.bankId; ui.search = '';
    ui.toast = 'Question saved to ' + bankName(q.bankId) + '.';
    render();
  }
}

function impAdvance() {
  const im = ui.imp;
  im.error = '';
  if (im.idx >= im.items.length - 1) impFinish(); else { im.idx++; render(); }
}

function impFinish() {
  const im = ui.imp;
  const nC = im.items.filter((x) => x.status === 'confirmed').length;
  if (nC) { db.imports.push({ id: uid(), fileName: im.fileName, date: new Date().toISOString(), bankId: im.bankId, saved: nC, extracted: im.items.length, created: Date.now(), updated: Date.now() }); persist(); }
  im.stage = 'done'; im.error = '';
  render();
}

function impConfirm() {
  const im = ui.imp;
  const it = im.items[im.idx];
  const opts = it.options.filter((o) => o.text.trim()).map((o) => ({ id: o.id, text: o.text.trim() }));
  const correct = it.correctIds.filter((id) => opts.some((o) => o.id === id));
  if (!it.text.trim() || opts.length < 2) { im.error = 'The question needs its text and at least two choices.'; render(); return; }
  if (!correct.length) { im.error = 'Mark the correct answer before confirming. Extracted answers are never assumed.'; render(); return; }
  const id = it.savedId || uid();
  const q = { id: id, bankId: im.bankId, text: it.text.trim(), options: opts, correctIds: correct, explanation: (it.explanation || '').trim(), topic: '', difficulty: 'Medium', reference: im.fileName + (it.page ? ', page ' + it.page : ''), source: 'pdf' };
  const prev = db.questions.find((x) => x.id === id);
  q.updated = Date.now(); q.created = prev && prev.created ? prev.created : q.updated;
  if (it.savedId) db.questions = db.questions.map((x) => (x.id === id ? q : x)); else db.questions.push(q);
  it.status = 'confirmed'; it.savedId = id;
  persist();
  impAdvance();
}

function startExam() {
  const e = ui.exam;
  const pool = db.questions.filter((q) => q.bankId === e.bankId);
  if (!pool.length) return;
  let order = pool.slice();
  if (e.shuffleQ && pool.length > 1) {
    for (let n = 0; n < 6; n++) {
      order = shuffle(pool);
      if (order.map((q) => q.id).join('|') !== lastOrder[e.bankId]) break;
    }
  }
  lastOrder[e.bankId] = order.map((q) => q.id).join('|');
  const count = Math.max(1, Math.min(e.count, pool.length));
  e.items = order.slice(0, count).map((q) => {
    const ids = q.options.map((o) => o.id);
    return { q: JSON.parse(JSON.stringify(q)), order: e.shuffleA ? shuffle(ids) : ids };
  });
  Object.assign(e, { stage: 'run', idx: 0, answers: {}, flags: {}, revealed: {}, elapsed: 0, limit: e.mode === 'exam' ? e.minutes * 60 : 0 });
  render();
  window.scrollTo(0, 0);
}

function submitExam(timeUp) {
  const e = ui.exam;
  if (e.stage !== 'run') return;
  if (!timeUp) {
    const open = e.items.filter((x) => !(e.answers[x.q.id] || []).length).length;
    if (open && !confirm(open + (open === 1 ? ' question is' : ' questions are') + ' not answered. Submit anyway?')) return;
  }
  let score = 0;
  const detail = e.items.map((it) => {
    const sel = e.answers[it.q.id] || [];
    const right = isRight(it.q, sel);
    if (right) score++;
    return {
      text: it.q.text, right: right, answered: sel.length > 0, flagged: !!e.flags[it.q.id], explanation: it.q.explanation || '',
      options: it.order.map((id, i) => {
        const o = it.q.options.find((x) => x.id === id);
        return { letter: L[i], text: o ? o.text : '', correct: it.q.correctIds.indexOf(id) >= 0, chosen: sel.indexOf(id) >= 0 };
      })
    };
  });
  const now = new Date();
  const att = {
    id: uid(), at: now.getTime(), updated: now.getTime(), bankName: bankName(e.bankId), mode: e.mode,
    date: now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    score: score, total: e.items.length, seconds: timeUp ? e.limit : e.elapsed, detail: detail,
    config: { bankId: e.bankId, count: e.count, mode: e.mode, shuffleQ: e.shuffleQ, shuffleA: e.shuffleA, minutes: e.minutes }
  };
  db.attempts.unshift(att);
  persist();
  ui.exam = blankExam(att.config);
  ui.screen = 'results'; ui.viewAttempt = att.id; ui.wrongOnly = false;
  ui.toast = timeUp ? 'Time is up. Your examination was submitted automatically.' : ''; ui.toastErr = false;
  render();
  window.scrollTo(0, 0);
}

function exportDb() {
  const blob = new Blob([JSON.stringify({ app: 'ExamForge', exported: new Date().toISOString(), data: db }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ExamForge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importBackup(file) {
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const src = normalize(j && j.data ? j.data : j);
    const beforeN = db.questions.length;
    db = mergeDb(db, src);
    const added = db.questions.length - beforeN;
    persist(); fixBankIds();
    ui.toast = 'Backup imported: ' + qLabel(Math.max(0, added)) + ' added.'; ui.toastErr = false;
  } catch (e) {
    ui.toast = 'That file is not an ExamForge backup.'; ui.toastErr = true;
  }
  render();
}

const curItem = () => ui.imp.items[ui.imp.idx];

let codeInput = '';
const actions = {
  cloudConnect: async () => {
    const f = cloud.form;
    const cm = f.code.trim().match(/(?:sync=)?([A-Za-z0-9_-]{20,})$/);
    if (cm) {
      try { const j = JSON.parse(b64urlDec(cm[1])); f.owner = j.o || ''; f.repo = j.r || ''; f.token = j.t || ''; f.api = j.a || ''; }
      catch (e) { cloud.formError = 'That setup code is not complete. Copy it again and paste the whole code.'; render(); return; }
    }
    const owner = f.owner.trim().replace(/^@/, ''); const repo = f.repo.trim(); const token = f.token.trim();
    if (!owner || !repo || !token) { cloud.formError = 'Fill in the user name, the data repository and the access token.'; render(); return; }
    cloud.cfg = { owner: owner, repo: repo, token: token }; if (f.api) cloud.cfg.api = f.api;
    cloud.busy = true; cloud.formError = ''; render();
    try {
      const info = await ghCheckRepo();
      if (info.private === false && !confirm('The repository “' + repo + '” is PUBLIC, so anyone could read your question bank. Use it anyway?')) throw new Error('Choose a private repository for your data.');
      cloud.busy = false; cloud.state = 'idle'; cloud.last = 0; saveCloudCfg();
      f.token = ''; f.code = '';
      await cloudSync(true);
    } catch (e) {
      cloud.busy = false; cloud.cfg = null;
      cloud.formError = e && e.status ? e.message : (e && /Choose a private/.test(e.message) ? e.message : 'GitHub could not be reached. Check the internet connection and try again.');
    }
    render();
  },
  cloudNow: () => cloudSync(true),
  cloudCopy: async (d) => {
    try { await navigator.clipboard.writeText(d.id); ui.toast = 'Setup code copied. Keep it private.'; ui.toastErr = false; render(); }
    catch (e) { prompt('Copy this setup code and keep it private:', d.id); }
  },
  cloudQr: () => { cloud.showQr = !cloud.showQr; render(); },
  cloudQrRefresh: () => render(),
  cloudOff: () => {
    if (!confirm('Disconnect cloud sync on this device? Your questions stay on this device and in the cloud.')) return;
    cloud.cfg = null; cloud.state = 'off'; cloud.showQr = false; saveCloudCfg(); render(); setSync();
  },
  unlock: async () => {
    const st = await serverLogin(codeInput);
    if (st === 200) { location.reload(); return; }
    store.loginError = st === 429 ? 'Too many wrong codes. Wait 10 minutes, then try again.' : st === 403 ? 'That code is not correct.' : 'ExamForge on the PC could not be reached.';
    render();
  },
  go: (d) => { ui.screen = d.id; ui.toast = ''; ui.viewAttempt = null; fixBankIds(); render(); window.scrollTo(0, 0); },
  toastOff: () => { ui.toast = ''; render(); },
  exportDb: exportDb,
  openAttempt: (d) => { ui.screen = 'results'; ui.viewAttempt = d.id; ui.wrongOnly = false; ui.toast = ''; render(); window.scrollTo(0, 0); },

  addBank: () => {
    const name = ui.newBank.trim();
    if (!name) return;
    const now = Date.now();
    const b = { id: uid(), name: name, created: now, updated: now };
    db.banks.push(b); persist();
    ui.bankId = b.id; ui.newBank = ''; ui.search = ''; ui.screen = 'banks'; ui.toast = 'Question bank “' + name + '” created.'; ui.toastErr = false;
    fixBankIds(); render();
  },
  openBank: (d) => { ui.bankId = d.id; ui.search = ''; ui.toast = ''; render(); },
  renameBank: () => {
    const b = db.banks.find((x) => x.id === ui.bankId);
    const name = b && prompt('Rename question bank', b.name);
    if (name && name.trim()) { b.name = name.trim(); b.updated = Date.now(); persist(); render(); }
  },
  delBank: () => {
    const n = countIn(ui.bankId);
    if (!confirm('Delete “' + bankName(ui.bankId) + '”' + (n ? ' and its ' + qLabel(n) : '') + '? Past results are kept. This cannot be undone.')) return;
    db.questions.filter((q) => q.bankId === ui.bankId).forEach((q) => tomb(q.id));
    tomb(ui.bankId);
    db.questions = db.questions.filter((q) => q.bankId !== ui.bankId);
    db.banks = db.banks.filter((b) => b.id !== ui.bankId);
    persist(); fixBankIds(); ui.toast = 'Question bank deleted.'; ui.toastErr = false; render();
  },
  newQ: () => { ui.draft = blankDraft(ui.bankId); ui.draftError = ''; ui.toast = ''; ui.screen = 'add'; render(); window.scrollTo(0, 0); },
  goImportBank: () => { ui.imp = blankImport(ui.bankId); ui.toast = ''; ui.screen = 'import'; render(); },
  editQ: (d) => {
    const q = db.questions.find((x) => x.id === d.id);
    if (!q) return;
    ui.draft = { editingId: q.id, bankId: q.bankId, text: q.text, options: q.options.map((o) => ({ id: o.id, text: o.text })), correctIds: q.correctIds.slice(), multi: q.correctIds.length > 1, explanation: q.explanation || '', topic: q.topic || '', difficulty: q.difficulty || 'Medium', reference: q.reference || '', source: q.source || 'manual' };
    ui.draftError = ''; ui.toast = ''; ui.screen = 'add'; render(); window.scrollTo(0, 0);
  },
  delQ: (d) => {
    if (!confirm('Delete this question? This cannot be undone.')) return;
    tomb(d.id);
    db.questions = db.questions.filter((x) => x.id !== d.id); persist();
    ui.toast = 'Question deleted.'; ui.toastErr = false; render();
  },

  dBank: (d) => { ui.draft.bankId = d.id; render(); },
  dMark: (d) => {
    const dr = ui.draft;
    if (dr.multi) dr.correctIds = dr.correctIds.indexOf(d.id) >= 0 ? dr.correctIds.filter((x) => x !== d.id) : dr.correctIds.concat([d.id]);
    else dr.correctIds = [d.id];
    ui.draftError = ''; render();
  },
  dRemove: (d) => { ui.draft.options = ui.draft.options.filter((o) => o.id !== d.id); ui.draft.correctIds = ui.draft.correctIds.filter((x) => x !== d.id); render(); },
  dAddOpt: () => { ui.draft.options.push({ id: uid(), text: '' }); render(); const all = document.querySelectorAll('[data-in=dOpt]'); if (all.length) all[all.length - 1].focus(); },
  dMulti: () => { const dr = ui.draft; dr.multi = !dr.multi; if (!dr.multi) dr.correctIds = dr.correctIds.slice(0, 1); render(); },
  dDiff: (d) => { ui.draft.difficulty = d.id; render(); },
  dCancel: () => { ui.screen = 'banks'; ui.draftError = ''; ui.toast = ''; render(); },
  dSave: () => saveDraft(false),
  dSaveNext: () => saveDraft(true),

  iBank: (d) => { ui.imp.bankId = d.id; render(); },
  iParse: () => {
    const im = ui.imp;
    if (!im.bankId) { im.error = 'Create a question bank first, then import into it.'; render(); return; }
    const items = parseLines(im.paste.split(/\r?\n/).map((t) => ({ text: t, page: 0 })));
    if (!items.length) { im.error = 'No numbered questions found. Expected lines such as “1. Question” followed by “A. Choice”.'; render(); return; }
    Object.assign(im, { stage: 'review', items: items, idx: 0, fileName: 'Pasted text', error: '', raw: null });
    render();
  },
  iMark: (d) => { const it = curItem(); it.correctIds = it.correctIds.indexOf(d.id) >= 0 ? it.correctIds.filter((x) => x !== d.id) : it.correctIds.concat([d.id]); ui.imp.error = ''; render(); },
  iRemove: (d) => { const it = curItem(); it.options = it.options.filter((o) => o.id !== d.id); it.correctIds = it.correctIds.filter((x) => x !== d.id); render(); },
  iPrev: () => { ui.imp.idx = Math.max(0, ui.imp.idx - 1); ui.imp.error = ''; render(); },
  iSkip: () => { const it = curItem(); if (it.status !== 'confirmed') it.status = 'skipped'; impAdvance(); },
  iConfirm: impConfirm,
  iFinish: impFinish,
  iViewBank: () => { ui.bankId = ui.imp.bankId; ui.search = ''; ui.imp = blankImport(ui.bankId); ui.screen = 'banks'; render(); },
  iReset: () => { ui.imp = blankImport(ui.imp.bankId); render(); },

  eBank: (d) => { ui.exam.bankId = d.id; render(); },
  eMode: (d) => { ui.exam.mode = d.id; render(); },
  eCountDown: () => { const n = countIn(ui.exam.bankId); ui.exam.count = Math.max(1, Math.min(ui.exam.count, n) - 1); render(); },
  eCountUp: () => { const n = countIn(ui.exam.bankId); ui.exam.count = Math.min(Math.max(n, 1), Math.min(ui.exam.count, n) + 1); render(); },
  eMinDown: () => { const m = ui.exam.minutes; ui.exam.minutes = Math.max(1, m - (m > 10 ? 5 : 1)); render(); },
  eMinUp: () => { const m = ui.exam.minutes; ui.exam.minutes = Math.min(300, m + (m >= 10 ? 5 : 1)); render(); },
  eShufQ: () => { ui.exam.shuffleQ = !ui.exam.shuffleQ; render(); },
  eShufA: () => { ui.exam.shuffleA = !ui.exam.shuffleA; render(); },
  eStart: startExam,
  ePick: (d) => {
    const e = ui.exam; const q = e.items[e.idx].q;
    if (e.revealed[q.id]) return;
    const cur = e.answers[q.id] || [];
    e.answers[q.id] = q.correctIds.length > 1 ? (cur.indexOf(d.id) >= 0 ? cur.filter((x) => x !== d.id) : cur.concat([d.id])) : [d.id];
    render();
  },
  eReveal: () => { const e = ui.exam; e.revealed[e.items[e.idx].q.id] = true; render(); },
  ePrev: () => { ui.exam.idx = Math.max(0, ui.exam.idx - 1); render(); },
  eNext: () => { const e = ui.exam; if (e.idx === e.items.length - 1) submitExam(false); else { e.idx++; render(); } },
  eJump: (d) => { ui.exam.idx = +d.id; render(); },
  eFlag: () => { const e = ui.exam; const id = e.items[e.idx].q.id; e.flags[id] = !e.flags[id]; render(); },
  eSubmit: () => submitExam(false),
  eQuit: () => { if (confirm('Quit this examination? It will not be saved.')) { ui.exam = blankExam({ bankId: ui.exam.bankId, count: ui.exam.count, mode: ui.exam.mode, shuffleQ: ui.exam.shuffleQ, shuffleA: ui.exam.shuffleA, minutes: ui.exam.minutes }); render(); } },

  rBack: () => { ui.viewAttempt = null; render(); },
  rWrong: () => { ui.wrongOnly = !ui.wrongOnly; render(); },
  rDelete: () => { if (!confirm('Delete this attempt from your history?')) return; tomb(ui.viewAttempt); db.attempts = db.attempts.filter((a) => a.id !== ui.viewAttempt); persist(); ui.viewAttempt = null; render(); },
  rRetake: () => { const att = db.attempts.find((a) => a.id === ui.viewAttempt); if (!att) return; ui.exam = blankExam(att.config); ui.viewAttempt = null; ui.screen = 'exam'; fixBankIds(); render(); }
};

const inputs = {
  code: (v) => { codeInput = v; },
  ghOwner: (v) => { cloud.form.owner = v; },
  ghRepo: (v) => { cloud.form.repo = v; },
  ghToken: (v) => { cloud.form.token = v; },
  ghApp: (v) => { cloud.form.app = v; },
  ghCode: (v) => { cloud.form.code = v; },
  newBank: (v) => { ui.newBank = v; },
  search: (v) => { ui.search = v; const el = $('#rows'); if (el) el.innerHTML = rowsHtml(); },
  dText: (v) => { ui.draft.text = v; },
  dExpl: (v) => { ui.draft.explanation = v; },
  dTopic: (v) => { ui.draft.topic = v; },
  dRef: (v) => { ui.draft.reference = v; },
  dOpt: (v, d) => { const o = ui.draft.options.find((x) => x.id === d.id); if (o) o.text = v; },
  iPaste: (v) => { ui.imp.paste = v; },
  iText: (v) => { curItem().text = v; },
  iExpl: (v) => { curItem().explanation = v; },
  iOpt: (v, d) => { const o = curItem().options.find((x) => x.id === d.id); if (o) o.text = v; }
};

function wire() {
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) actions[el.dataset.act](el.dataset);
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.in && inputs[el.dataset.in]) inputs[el.dataset.in](el.value, el.dataset);
  });
  document.addEventListener('keydown', (ev) => {
    const el = ev.target;
    if (ev.key === 'Enter' && el.dataset && el.dataset.enter && actions[el.dataset.enter]) { ev.preventDefault(); actions[el.dataset.enter](el.dataset); }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el.dataset || !el.dataset.file) return;
    const f = el.files && el.files[0];
    if (el.dataset.file === 'pdf') importPdf(f); else importBackup(f);
    el.value = '';
  });
  document.addEventListener('dragover', (ev) => { const z = ev.target.closest && ev.target.closest('#drop'); if (z) { ev.preventDefault(); z.classList.add('over'); } });
  document.addEventListener('dragleave', (ev) => { const z = ev.target.closest && ev.target.closest('#drop'); if (z) z.classList.remove('over'); });
  document.addEventListener('drop', (ev) => {
    const z = ev.target.closest && ev.target.closest('#drop');
    if (!z) return;
    ev.preventDefault();
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) importPdf(f);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromServer(); });
  window.addEventListener('beforeunload', (ev) => { if (ui.exam.stage === 'run') { ev.preventDefault(); ev.returnValue = ''; } });
  setInterval(async () => {
    const info = store.info;
    if (store.mode !== 'server' || store.locked || !info || !info.local || !info.tunnel || !info.tunnel.enabled || ui.screen !== 'dash') return;
    const before = JSON.stringify(info.tunnel);
    await fetchInfo();
    if (ui.screen === 'dash' && JSON.stringify(store.info.tunnel) !== before) render();
  }, 4000);
  setInterval(() => {
    const e = ui.exam;
    if (e.stage !== 'run') return;
    e.elapsed++;
    if (e.limit && e.elapsed >= e.limit) { submitExam(true); return; }
    const el = $('#timer');
    if (el) { el.textContent = fmt(e.limit ? e.limit - e.elapsed : e.elapsed); el.classList.toggle('low', !!e.limit && e.limit - e.elapsed <= 60); }
  }, 1000);
}

if (typeof document !== 'undefined') {
  loadCloudCfg();
  const fromQr = takeSyncFromHash();
  loadDb().then((d) => {
    db = d; fixBankIds(); wire(); render(); setSync(true);
    if (fromQr) { ui.toast = 'This phone is now connected to your cloud sync.'; ui.toastErr = false; render(); }
    if (cloud.cfg && !store.locked) cloudSync(false);
    window.addEventListener('online', () => { setSync(); cloudSync(false); });
    window.addEventListener('offline', () => setSync());
    document.addEventListener('visibilitychange', () => { if (!document.hidden && cloud.cfg && Date.now() - cloud.last > 60000) cloudSync(false); });
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
if (typeof module !== 'undefined') module.exports = { parseLines: parseLines, itemsToLines: itemsToLines, mergeDb: mergeDb };
