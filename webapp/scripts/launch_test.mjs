#!/usr/bin/env node
// Launch features (CONTRACT.md, Version 3.22), no server, no network:
// the guest cache key, share links with Open Graph tags, /feed.xml,
// /sitemap.xml, access requests and push in batches.
//
//   node scripts/launch_test.mjs
import worker, { _test } from '../src/worker.js';

let pass = 0, fail = 0;
function expect(name, got, want) {
  if (got === want) { pass++; console.log(`  ok    ${name} (${String(got).slice(0, 80)})`); }
  else { fail++; console.log(`  FAIL  ${name}: expected ${want}, got ${got}`); }
}

// --- Guest cache key ------------------------------------------------------
const { guestKey, guestCache } = _test;
expect('unknown parameters dropped', guestKey('/api/reports', '?x=1&y=2'), '/api/reports');
expect('known parameters kept, in a fixed order', guestKey('/api/trends', '?since=2026-11-01&zz=1&side=ru'),
  '/api/trends?side=ru&since=2026-11-01');
expect('p kept', guestKey('/api/updates', '?p=2'), '/api/updates?p=2');
expect('empty value dropped', guestKey('/api/trends', '?side='), '/api/trends');

// --- A small D1: reports, meta, users, access_requests, push_subscriptions ---
class MockD1 {
  constructor() {
    this.reports = new Map(); this.meta = new Map(); this.users = new Map();
    this.requests = []; this.subs = []; this.audit = []; this.reads = 0;
  }
  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async first() {
        if (/FROM reports WHERE date = \?/.test(sql)) { db.reads++; return db.reports.get(args[0]) || null; }
        if (/FROM meta WHERE key = \?/.test(sql)) return db.meta.has(args[0]) ? { value: db.meta.get(args[0]) } : null;
        if (/FROM meta WHERE key = '(\w+)'/.test(sql)) { const k = sql.match(/key = '(\w+)'/)[1]; return db.meta.has(k) ? { value: db.meta.get(k) } : null; }
        if (/^SELECT COUNT\(\*\) AS n FROM users/.test(sql)) return { n: db.users.size };
        if (/FROM users WHERE email = \?/.test(sql)) { const u = db.users.get(args[0]); return u ? { email: args[0], ...u } : null; }
        if (/WHERE u\.email = \?/.test(sql)) { const u = db.users.get(args[0]); return u ? { email: args[0], role: u.role, active: u.active } : null; }
        if (/FROM access_requests WHERE email = \? ORDER BY/.test(sql)) return db.requests.filter((r) => r.email === args[0]).at(-1) || null;
        if (/COUNT\(\*\) AS n FROM access_requests WHERE email/.test(sql)) return { n: db.requests.filter((r) => r.email === args[0] && r.ts > args[1]).length };
        if (/FROM access_requests WHERE email = \? AND status = 'requested'/.test(sql)) return db.requests.find((r) => r.email === args[0] && r.status === 'requested') || null;
        if (/FROM access_requests WHERE id = \?/.test(sql)) return db.requests.find((r) => r.id === args[0]) || null;
        if (/COUNT\(\*\) AS n FROM access_requests/.test(sql)) return { n: db.requests.filter((r) => r.status === 'requested').length };
        return null;
      },
      async run() {
        if (/^INSERT INTO meta/.test(sql)) db.meta.set(args[0], args[1]);
        else if (/^DELETE FROM meta WHERE key = '(\w+)'/.test(sql)) db.meta.delete(sql.match(/key = '(\w+)'/)[1]);
        else if (/^INSERT INTO users/.test(sql)) db.users.set(args[0], { role: args[1], active: 1, last_seen: null, prev_visit: null });
        else if (/^INSERT OR IGNORE INTO users/.test(sql) && !db.users.has(args[0])) db.users.set(args[0], { role: args[1], active: 1 });
        else if (/^INSERT INTO access_requests/.test(sql)) db.requests.push({ id: args[0], email: args[1], ts: args[2], status: 'requested', decided_at: null, decided_by: null });
        else if (/^UPDATE access_requests SET status/.test(sql)) { const r = db.requests.find((x) => x.id === args[3]); if (r) Object.assign(r, { status: args[0], decided_at: args[1], decided_by: args[2] }); }
        else if (/^DELETE FROM push_subscriptions/.test(sql)) db.subs = db.subs.filter((s) => s.endpoint !== args[0]);
        else if (/^INSERT INTO audit_log/.test(sql)) db.audit.push(args[2]);
        return { meta: { changes: 1 } };
      },
      async all() {
        if (/json_each/.test(sql)) {
          const rows = [];
          for (const r of [...db.reports.values()].sort((a, b) => (a.date < b.date ? 1 : -1))) {
            if (r.date < args[0]) continue;
            const d = JSON.parse(r.data);
            const base = { date: r.date, threat_index: r.threat_index, top_sv: r.top_sv, exec_top: d.executive_sv && d.executive_sv.top };
            if (!d.events || !d.events.length) rows.push({ ...base, id: null });
            for (const e of d.events || []) rows.push({ ...base, id: e.id, score: e.score, title_sv: e.title_sv, title: e.title, summary_sv: e.summary_sv });
          }
          return { results: rows };
        }
        if (/FROM reports/.test(sql)) {
          db.reads++;
          const rows = [...db.reports.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
          const since = args[0];
          return { results: since ? rows.filter((r) => r.date >= since) : rows };
        }
        if (/FROM access_requests/.test(sql)) return { results: [...db.requests].reverse() };
        if (/FROM push_subscriptions/.test(sql)) return { results: db.subs };
        return { results: [] };
      },
    };
    return stmt;
  }
}

const today = new Date().toISOString().slice(0, 10);
const db = new MockD1();
const report = {
  date: today, threat_index: 6.4,
  executive_sv: { top: 'Sabotage mot en kabel i Östersjön. Fler detaljer följer.' },
  events: [
    { id: `${today}-e1`, score: 9, title_sv: 'Kabel skadad i Östersjön', summary_sv: 'En kabel mellan Finland och Estland skadades i natt. Polisen utreder.' },
    { id: `${today}-e2`, score: 5, title_sv: 'Desinformation om val <script>', summary_sv: '' },
  ],
};
db.reports.set(today, { date: today, threat_index: 6.4, threat_index_30d: 6.0, top_sv: report.executive_sv.top, data: JSON.stringify(report) });

const INDEX_HTML = '<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Hotmonitor</title>'
  + '<meta name="description" content="Daglig bedömning."></head><body><main id="view"></main></body></html>';
const env = {
  PUBLIC_READ: '1', TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud', DB: db,
  ASSETS: { fetch: async (req) => new Response(new URL(req.url).pathname === '/' ? INDEX_HTML
    : new URL(req.url).pathname === '/robots.txt' ? (await import('node:fs')).readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8') : 'asset', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) },
};

// caches.default, as on a custom domain.
const edgeStore = new Map();
globalThis.caches = { default: {
  async match(req) { const r = edgeStore.get(typeof req === 'string' ? req : req.url); return r ? r.clone() : undefined; },
  async put(req, res) { edgeStore.set(typeof req === 'string' ? req : req.url, res.clone()); },
} };

const ORIGIN = 'https://hotmonitor.example.org';
async function get(path, init = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil: () => {} });
}

let r = await get('/api/reports?cachebust=1');
expect('guest reads the list', r.status, 200);
const readsAfterFirst = db.reads;
r = await get('/api/reports?cachebust=2');
expect('a new junk parameter is a cache hit', db.reads, readsAfterFirst);
expect('stored in caches.default', edgeStore.has(`${ORIGIN}/__guest-cache/api/reports`), true);
guestCache.clear();
r = await get('/api/reports?cachebust=3');
expect('another isolate finds it in caches.default', db.reads, readsAfterFirst);
const ts = (i) => `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
for (let i = 0; i < 205; i++) await get(`/api/updates?since=${ts(i)}`);
expect('the cache is bounded', guestCache.size, 200);
expect('the oldest entry went first', guestCache.has('/api/reports'), false);
expect('recent entries stay', guestCache.has(`/api/updates?${new URLSearchParams({ since: ts(204) })}`), true);

// --- Share links (/h/<date>/<id>, /d/<date>) --------------------------------
// Node has no HTMLRewriter: a stand-in for the three selectors the Worker uses.
globalThis.HTMLRewriter = class {
  constructor() { this.handlers = []; }
  on(sel, h) { this.handlers.push([sel, h]); return this; }
  transform(res) {
    const handlers = this.handlers;
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = res.text().then((html) => {
      for (const [sel, h] of handlers) {
        if (sel === 'title') {
          h.element({ setInnerContent(t) { html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(t)}</title>`); } });
        } else if (sel === 'meta[name="description"]') {
          h.element({ setAttribute(_k, v) { html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(v).replace(/"/g, '&quot;')}$2`); } });
        } else if (sel === 'head') {
          h.element({ append(t) { html = html.replace('</head>', `${t}</head>`); } });
        }
      }
      return html;
    });
    const stream = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await body)); c.close(); } });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
};
const metaOf = (html, prop) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`));
  return m ? m[1] : null;
};

r = await get(`/h/${today}/${today}-e1`);
let html = await r.text();
expect('event page 200', r.status, 200);
expect('event <title>', html.match(/<title>([^<]*)<\/title>/)[1], 'Kabel skadad i Östersjön · Hotmonitor');
expect('og:title', metaOf(html, 'og:title'), 'Kabel skadad i Östersjön');
expect('og:description is the first sentence, AI-labelled', metaOf(html, 'og:description'),
  'En kabel mellan Finland och Estland skadades i natt. · AI-sammanfattning · Hotmonitor');
expect('description meta too', metaOf(html, 'description'), metaOf(html, 'og:description'));
expect('og:type', metaOf(html, 'og:type'), 'article');
expect('og:url', metaOf(html, 'og:url'), `${ORIGIN}/h/${today}/${today}-e1`);
expect('og:image falls back to the default', metaOf(html, 'og:image'), `${ORIGIN}/og/default.png`);
expect('twitter:card', metaOf(html, 'twitter:card'), 'summary_large_image');
expect('canonical', (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1], `${ORIGIN}/h/${today}/${today}-e1`);
expect('page cached in caches.default', edgeStore.has(`${ORIGIN}/h/${today}/${today}-e1`), true);
expect('page may be cached', r.headers.get('cache-control'), 'public, max-age=600');
db.reads = 0;
r = await get(`/h/${today}/${today}-e1`);
expect('second view from the cache, OG intact', metaOf(await r.text(), 'og:title'), 'Kabel skadad i Östersjön');
expect('second view reads no D1', db.reads, 0);

r = await get(`/h/${today}/${today}-e2`);
html = await r.text();
expect('markup in a title is escaped', html.includes('<script>'), false);
expect('empty summary: the title is the description', metaOf(html, 'og:description').startsWith('Desinformation om val &lt;script&gt;'), true);

r = await get(`/d/${today}`);
html = await r.text();
expect('day page 200', r.status, 200);
expect('day og:title has the index', metaOf(html, 'og:title').endsWith('· hotindex 6,4'), true);
expect('day og:description', metaOf(html, 'og:description'), 'Sabotage mot en kabel i Östersjön. · AI-sammanfattning · Hotmonitor');
expect('day og:url', metaOf(html, 'og:url'), `${ORIGIN}/d/${today}`);

for (const bad of [`/h/${today}/nope`, '/h/2026-13-40/x-e1', '/d/1999-01-01', '/d/not-a-date', `/h/${today}/a%20b`]) {
  r = await get(bad);
  html = await r.text();
  expect(`404 for ${bad}`, r.status, 404);
  expect(`no OG tags on ${bad}`, html.includes('og:title'), false);
}
r = await worker.fetch(new Request(`${ORIGIN}/d/${today}`), { ...env, PUBLIC_READ: '0' }, { waitUntil: () => {} });
html = await r.text();
expect('PUBLIC_READ off: the plain app, no OG tags', html.includes('og:title'), false);

// --- /feed.xml ----------------------------------------------------------------
const old = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
db.reports.set(old, { date: old, threat_index: 5, top_sv: 'Gammal.', data: JSON.stringify({ date: old, events: [{ id: `${old}-e1`, score: 9, title_sv: 'För gammal' }] }) });
r = await get('/feed.xml');
const feed = await r.text();
expect('feed 200', r.status, 200);
expect('feed is RSS', r.headers.get('content-type'), 'application/rss+xml; charset=utf-8');
expect('feed may be cached', r.headers.get('cache-control'), 'public, max-age=900');
expect('feed is RSS 2.0', feed.includes('<rss version="2.0"'), true);
expect('report item: index and top event', feed.includes('<title>Hotindex 6,4 · Kabel skadad i Östersjön</title>'), true);
expect('report item links to /d/', feed.includes(`<link>${ORIGIN}/d/${today}</link>`), true);
expect('event 9 is in', feed.includes(`<link>${ORIGIN}/h/${today}/${today}-e1</link>`), true);
expect('event 5 is not', feed.includes(`${today}-e2`), false);
expect('descriptions say AI-sammanfattning', (feed.match(/<description>AI-sammanfattning: /g) || []).length, 2);
expect('markup escaped', feed.includes('<script>'), false);
expect('older than 14 days left out', feed.includes(old), false);
expect('well-formed item count', (feed.match(/<item>/g) || []).length, (feed.match(/<\/item>/g) || []).length);

// --- robots.txt and /sitemap.xml ------------------------------------------------
r = await get('/robots.txt');
const robots = await r.text();
expect('robots.txt names this host\'s sitemap', robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`), true);
expect('robots.txt allows the pages', robots.includes('Allow: /'), true);
const old2 = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
db.reports.set(old2, { date: old2, threat_index: 5, top_sv: '', data: JSON.stringify({ date: old2, events: [{ id: `${old2}-e1`, score: 9 }] }) });
r = await get('/sitemap.xml');
const sitemap = await r.text();
expect('sitemap 200', r.status, 200);
expect('sitemap is XML', r.headers.get('content-type'), 'application/xml; charset=utf-8');
expect('sitemap lists the day', sitemap.includes(`<loc>${ORIGIN}/d/${today}</loc>`), true);
expect('sitemap lists every event', sitemap.includes(`<loc>${ORIGIN}/h/${today}/${today}-e2</loc>`), true);
expect('sitemap keeps 20 days back', sitemap.includes(`/d/${old}<`), true);
expect('sitemap stops at 90 days', sitemap.includes(old2), false);

// --- U7 and access requests ------------------------------------------------------
// The local dev identity stands in for a verified Access address.
const LOCAL = 'http://localhost:8787';
const devEnv = { ...env, OWNER: 'owner@example.org', DEV_AUTH_EMAIL: 'owner@example.org' };
async function as(email, path, { method = 'GET', body, origin = LOCAL } = {}) {
  const headers = { 'X-Dev-Email': email };
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`${LOCAL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), devEnv, { waitUntil: () => {} });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : null, res };
}
const stranger = 'new.person@example.net';
r = await as(stranger, '/api/me');
expect('verified, no account: guest', r.body.role, 'guest');
expect('verified, no account: flagged', r.body.verified_no_account, true);
expect('verified, no account: no address echoed', r.body.email, null);
expect('verified, no account: not cached', r.res.headers.get('cache-control'), 'no-store');
expect('no request yet', r.body.access_request, null);
r = await as(stranger, '/api/access-request', { method: 'POST', origin: 'https://evil.example' });
expect('access request from another origin refused', r.status, 403);
r = await as(stranger, '/api/access-request', { method: 'POST' });
expect('access request created', r.status, 201);
expect('access request is requested', r.body.status, 'requested');
const reqId = r.body.id;
r = await as(stranger, '/api/access-request', { method: 'POST' });
expect('asking again returns the same request', r.body.id, reqId);
r = await as(stranger, '/api/me');
expect('/api/me shows the open request', r.body.access_request && r.body.access_request.status, 'requested');
r = await get('/api/access-request', { method: 'POST' });
expect('a guest cannot ask', r.status, 401);
r = await as('owner@example.org', '/api/access-request', { method: 'POST' });
expect('someone with an account cannot ask', r.status, 409);
r = await as(stranger, '/api/admin/access-requests');
expect('a stranger cannot list requests', r.status, 403);
r = await as('owner@example.org', '/api/admin/access-requests');
expect('admin lists requests', r.status, 200);
expect('admin sees the address', r.body[0] && r.body[0].email, stranger);
r = await as('owner@example.org', `/api/admin/access-requests/${reqId}`, { method: 'POST', body: { decision: 'maybe' } });
expect('a bad decision is refused', r.status, 400);
r = await as('owner@example.org', `/api/admin/access-requests/${reqId}`, { method: 'POST', body: { decision: 'approve', invite: false } });
expect('approve', r.status, 200);
expect('approved', r.body.request.status, 'approved');
expect('a reader account was made', db.users.get(stranger) && db.users.get(stranger).role, 'reader');
r = await as(stranger, '/api/me');
expect('the new reader is a reader', r.body.role, 'reader');
r = await as('owner@example.org', `/api/admin/access-requests/${reqId}`, { method: 'POST', body: { decision: 'deny' } });
expect('decided once only', r.status, 409);
const other = 'someone.else@example.net';
r = await as(other, '/api/access-request', { method: 'POST' });
r = await as('owner@example.org', `/api/admin/access-requests/${r.body.id}`, { method: 'POST', body: { decision: 'deny' } });
expect('deny', r.body.request.status, 'denied');
expect('no account on deny', db.users.has(other), false);
await as(other, '/api/access-request', { method: 'POST' });
db.requests.filter((x) => x.email === other).forEach((x) => { x.status = 'denied'; });
await as(other, '/api/access-request', { method: 'POST' });
db.requests.filter((x) => x.email === other).forEach((x) => { x.status = 'denied'; });
r = await as(other, '/api/access-request', { method: 'POST' });
expect('at most three requests a day', r.status, 429);

console.log(`\nlaunch_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
