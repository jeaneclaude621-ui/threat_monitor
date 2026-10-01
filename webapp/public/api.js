// Data layer: reports, the signed-in user and operator assessments, with an
// offline outbox so a swipe made without coverage is uploaded later.
// Shapes follow webapp/CONTRACT.md.

const ME_KEY = 'hm.me';
const OUTBOX_KEY = 'hm.outbox';
const READS_KEY = 'hm.readsOutbox';
const READ_CACHE_KEY = 'hm.reads';

export class AuthError extends Error {}
// The email is verified but the app does not let it in (removed or never added).
export class DeniedError extends AuthError {}
export class OfflineError extends Error {}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
}

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function getJSON(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...opts });
  } catch (e) {
    throw new OfflineError(String(e));
  }
  if (res.status === 401) throw new AuthError(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  // An expired Access session answers with a redirect to its login page.
  if (!type.includes('application/json')) throw new AuthError('not json');
  const body = await res.json();
  if (res.status === 403) {
    const reason = String((body && (body.reason || body.error)) || '');
    if (/not[_ ]allowed|not in users|inactive/i.test(reason) || String(url).startsWith('/api/me')) {
      throw new DeniedError(reason || 'not allowed');
    }
    throw new HttpError(403, reason || 'Åtgärden är inte tillåten');
  }
  if (res.status === 503 && body && body.error === 'offline') throw new OfflineError('offline');
  if (!res.ok) throw new HttpError(res.status, (body && body.error) || `HTTP ${res.status}`);
  return body;
}

export const store = {
  me: null,
  index: null,           // [{date, threat_index, threat_index_30d, top_sv}] newest first
  reports: new Map(),    // date -> normalized report
  assessments: [],       // all rows, plus local pending rows
  outbox: lsGet(OUTBOX_KEY, []),
  stale: false,          // true when showing cached data because the server was unreachable
  updates: [],           // live feed rows, newest first
  notices: [],           // active announcements from admins, newest first
  reads: new Set(lsGet(READ_CACHE_KEY, [])), // item ids I have read (events and updates)
  lastVisit: null,       // my previous visit, from the server
  readsOutbox: lsGet(READS_KEY, []),
  refreshedAt: null,
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(); }

export function isAdmin() { return !!store.me && store.me.role === 'admin'; }

export async function loadMe() {
  try {
    store.me = await getJSON('/api/me', { cache: 'no-store' });
    lsSet(ME_KEY, store.me);
    store.stale = false;
  } catch (e) {
    const cached = lsGet(ME_KEY, null);
    if (e instanceof OfflineError && cached) {
      store.me = cached;
      store.stale = true;
    } else if (e instanceof OfflineError && navigator.onLine) {
      throw new AuthError('unreachable');
    } else {
      throw e;
    }
  }
  emit();
  return store.me;
}

// Views ask for the same data at the same time; one request serves them
// all instead of each starting its own (startup made ~50 report fetches).
const inflight = new Map();
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

export async function loadIndex(force = false) {
  if (store.index && !force) return store.index;
  return once('index', async () => {
    const list = await getJSON('/api/reports');
    store.index = [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
    return store.index;
  });
}

const arr = (v) => (Array.isArray(v) ? v : []);

function normalize(r) {
  const events = arr(r.events).map((e, i) => ({
    ...e,
    id: e.id || `${r.date}-e${i + 1}`,
    topics: arr(e.topics),
    countries: arr(e.countries),
    articles: arr(e.articles),
  }));
  return { ...r, events };
}

export async function loadReport(date) {
  if (store.reports.has(date)) return store.reports.get(date);
  return once(`report:${date}`, async () => {
    const r = normalize(await getJSON(`/api/reports/${encodeURIComponent(date)}`));
    store.reports.set(date, r);
    return r;
  });
}

export async function loadAllReports() {
  const index = await loadIndex();
  const out = [];
  const queue = [...index];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try { out.push(await loadReport(item.date)); } catch (e) {
        if (e instanceof AuthError) throw e;
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function loadAssessments() {
  const rows = await getJSON('/api/assessments');
  const serverClientIds = new Set(rows.map((r) => r.client_id).filter(Boolean));
  // Anything the server already has was uploaded before a reload: drop it.
  store.outbox = store.outbox.filter((o) => !serverClientIds.has(o.client_id));
  lsSet(OUTBOX_KEY, store.outbox);
  const pending = store.outbox.map(pendingRow);
  store.assessments = [...rows, ...pending];
  emit();
  flush();
  return store.assessments;
}

function pendingRow(item) {
  return {
    ...item,
    id: `pending:${item.client_id}`,
    ts: item.queued_at || new Date().toISOString(),
    operator: store.me ? store.me.email : '',
    pending: true,
  };
}

// --- The current user's verdicts --------------------------------------------

export function myRows() {
  const me = store.me && store.me.email;
  return store.assessments.filter((a) => a.operator === me);
}

// article_id -> the latest row of each of my chains (value 0 = withdrawn).
export function currentByArticle() {
  const rows = myRows();
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const current = new Map();
  for (const r of rows) {
    if (superseded.has(r.id)) continue;
    const prev = current.get(r.article_id);
    if (!prev || r.ts > prev.ts) current.set(r.article_id, r);
  }
  return current;
}

export function chainOf(row) {
  const byId = new Map(store.assessments.map((a) => [a.id, a]));
  const out = [];
  const seen = new Set();
  let r = row;
  while (r && !seen.has(r.id)) {
    out.push(r);
    seen.add(r.id);
    r = r.supersedes ? byId.get(r.supersedes) : null;
  }
  return out;
}

// target = { article, event, date }. Returns the local (pending) row.
export function assess(target, value, supersedesRow) {
  const item = {
    client_id: uuid(),
    article_id: target.article.id,
    report_date: target.date,
    event_id: target.event.id,
    outlet: target.article.outlet || '',
    value,
    supersedes: supersedesRow ? supersedesRow.id : null,
    queued_at: new Date().toISOString(),
  };
  const local = pendingRow(item);
  store.assessments.push(local);
  store.outbox.push(item);
  lsSet(OUTBOX_KEY, store.outbox);
  emit();
  flush();
  return local;
}

// Take back a row: drop it if it never left the phone, otherwise record a
// withdrawal (value 0) that supersedes it, keeping the history intact.
const undoRequested = new Set();
export function undo(row, target) {
  if (row.pending) {
    const cid = row.client_id;
    if (inFlight === cid) { undoRequested.add(cid); return; }
    store.outbox = store.outbox.filter((o) => o.client_id !== cid);
    store.assessments = store.assessments.filter((a) => a.id !== row.id);
    lsSet(OUTBOX_KEY, store.outbox);
    emit();
    return;
  }
  assess(target, 0, row);
}

let flushing = false;
let inFlight = null;
export async function flush() {
  if (flushing || !store.outbox.length) return;
  flushing = true;
  try {
    while (store.outbox.length) {
      const item = store.outbox[0];
      const body = { ...item };
      delete body.queued_at;
      if (body.supersedes && body.supersedes.startsWith('pending:')) break; // predecessor not uploaded yet
      inFlight = item.client_id;
      let row;
      try {
        row = await getJSON('/api/assessments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
          // The server rejected this row; retrying will not help.
          store.outbox.shift();
          store.assessments = store.assessments.filter((a) => a.id !== `pending:${item.client_id}`);
          store.lastError = e.message;
          lsSet(OUTBOX_KEY, store.outbox);
          emit();
          continue;
        }
        throw e;
      } finally {
        inFlight = null;
      }
      const pid = `pending:${item.client_id}`;
      store.assessments = store.assessments.map((a) => (a.id === pid ? row : a.supersedes === pid ? { ...a, supersedes: row.id } : a));
      store.outbox = store.outbox.filter((o) => o.client_id !== item.client_id)
        .map((o) => (o.supersedes === pid ? { ...o, supersedes: row.id } : o));
      lsSet(OUTBOX_KEY, store.outbox);
      if (undoRequested.delete(item.client_id)) {
        const target = { article: { id: row.article_id, outlet: row.outlet }, event: { id: row.event_id }, date: row.report_date };
        assess(target, 0, row);
      }
      emit();
    }
  } catch (e) {
    store.lastError = e.message;
    if (e instanceof AuthError) store.authLost = true;
    emit();
  } finally {
    flushing = false;
  }
}

window.addEventListener('online', () => flush());

// --- Live feed and read marks -------------------------------------------------

export async function loadUpdates() {
  const rows = await getJSON('/api/updates');
  store.updates = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  emit();
  return store.updates;
}

export async function loadNotices() {
  const rows = await getJSON('/api/notices', { cache: 'no-store' });
  store.notices = Array.isArray(rows) ? rows : [];
  emit();
  return store.notices;
}

export async function loadReads() {
  const body = await getJSON('/api/reads', { cache: 'no-store' });
  const ids = Array.isArray(body && body.item_ids) ? body.item_ids : [];
  // Marks still waiting in the outbox stay read locally.
  store.reads = new Set([...ids, ...store.readsOutbox.flatMap((o) => o.item_ids || [])]);
  if (body && body.last_visit) store.lastVisit = body.last_visit;
  lsSet(READ_CACHE_KEY, [...store.reads]);
  emit();
  flushReads();
  return store.reads;
}

export function isRead(id) { return store.reads.has(id); }

export function markRead(ids) {
  const fresh = [...new Set(ids)].filter((id) => id && !store.reads.has(id));
  if (!fresh.length) return;
  for (const id of fresh) store.reads.add(id);
  lsSet(READ_CACHE_KEY, [...store.reads]);
  // Batches of 200 keep each request small.
  for (let i = 0; i < fresh.length; i += 200) store.readsOutbox.push({ item_ids: fresh.slice(i, i + 200) });
  lsSet(READS_KEY, store.readsOutbox);
  emit();
  flushReads();
}

let flushingReads = false;
export async function flushReads() {
  if (flushingReads || !store.readsOutbox.length) return;
  flushingReads = true;
  try {
    while (store.readsOutbox.length) {
      try {
        await getJSON('/api/reads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(store.readsOutbox[0]),
        });
      } catch (e) {
        // A rejected mark (4xx) will never succeed; drop it and go on.
        if (!(e instanceof HttpError && e.status >= 400 && e.status < 500)) throw e;
      }
      store.readsOutbox.shift();
      lsSet(READS_KEY, store.readsOutbox);
    }
  } catch (e) {
    if (e instanceof AuthError) store.authLost = true;
  } finally {
    flushingReads = false;
  }
}

// Everything that can change on the server: the report list (a new morning
// report), the newest report itself (a same-day rerun), the live feed, my
// read marks and the assessments.
export async function refreshAll() {
  const before = store.index && store.index[0] && store.index[0].date;
  const index = await loadIndex(true);
  if (index.length) {
    store.reports.delete(index[0].date);
    if (before && before !== index[0].date) store.reports.delete(before);
  }
  await Promise.all([
    // /api/me also carries the missing-report alarm, so refresh it too.
    loadMe().catch((e) => { if (e instanceof AuthError) throw e; }),
    loadUpdates().catch((e) => { if (e instanceof AuthError) throw e; }),
    loadNotices().catch((e) => { if (e instanceof AuthError) throw e; }),
    loadReads().catch((e) => { if (e instanceof AuthError) throw e; }),
    loadAssessments().catch((e) => { if (e instanceof AuthError) throw e; }),
  ]);
  store.refreshedAt = new Date().toISOString();
  store.stale = false;
  emit();
}

// --- Admin --------------------------------------------------------------------

export function adminGet(path) { return getJSON(path, { cache: 'no-store' }); }

export function adminSend(method, path, body) { return sendJSON(method, path, body); }

// --- Device, notifications ------------------------------------------------------

// Once per session: whether the app runs from the home screen, and on what.
export async function reportDevice(info) {
  try {
    if (sessionStorage.getItem('hm.deviceSent') === JSON.stringify(info)) return;
  } catch { /* ignore */ }
  try {
    await sendJSON('POST', '/api/me/device', info);
    try { sessionStorage.setItem('hm.deviceSent', JSON.stringify(info)); } catch { /* ignore */ }
  } catch (e) {
    console.warn('device report', e);
  }
}

export async function pushKey() {
  const body = await getJSON('/api/push/key', { cache: 'no-store' });
  return body && body.publicKey;
}
export const pushSubscribe = (sub) => sendJSON('POST', '/api/push/subscribe', sub);
export const pushUnsubscribe = (endpoint) => sendJSON('POST', '/api/push/unsubscribe', { endpoint });

function sendJSON(method, path, body) {
  return getJSON(path, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

window.addEventListener('online', () => flushReads());
