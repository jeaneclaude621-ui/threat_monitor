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
        if (/^SELECT email FROM push_subscriptions WHERE endpoint = \?/.test(sql)) return db.subs.find((x) => x.endpoint === args[0]) || null;
        if (/COUNT\(\*\) AS n FROM push_subscriptions WHERE email IS NULL/.test(sql)) return { n: db.subs.filter((x) => x.email == null).length };
        if (/COUNT\(\*\) AS n FROM push_subscriptions WHERE email = \?/.test(sql)) return { n: db.subs.filter((x) => x.email === args[0]).length };
        if (/SELECT topics, countries FROM push_subscriptions WHERE endpoint = \? AND email IS NULL/.test(sql)) return db.subs.find((x) => x.endpoint === args[0] && x.email == null) || null;
        if (/SELECT topics, countries FROM push_subscriptions WHERE endpoint = \? AND email = \?/.test(sql)) return db.subs.find((x) => x.endpoint === args[0] && x.email === args[1]) || null;
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
        else if (/^DELETE FROM push_subscriptions WHERE endpoint = \? AND email IS NULL/.test(sql)) {
          const n = db.subs.length; db.subs = db.subs.filter((x) => !(x.endpoint === args[0] && x.email == null));
          return { meta: { changes: n - db.subs.length } };
        } else if (/^DELETE FROM push_subscriptions WHERE endpoint = \? AND email = \?/.test(sql)) {
          const n = db.subs.length; db.subs = db.subs.filter((x) => !(x.endpoint === args[0] && x.email === args[1]));
          return { meta: { changes: n - db.subs.length } };
        } else if (/^DELETE FROM push_subscriptions/.test(sql)) db.subs = db.subs.filter((x) => x.endpoint !== args[0]);
        else if (/^INSERT INTO push_subscriptions/.test(sql)) {
          const [endpoint, email, p256dh, auth, created_at, prefs, topics, countries] = args;
          const old = db.subs.find((x) => x.endpoint === endpoint);
          const row = { endpoint, email, p256dh, auth, created_at, prefs, topics: topics ?? (old && old.topics) ?? null, countries: countries ?? (old && old.countries) ?? null };
          db.subs = db.subs.filter((x) => x.endpoint !== endpoint); db.subs.push(row);
        } else if (/^UPDATE push_subscriptions SET topics/.test(sql)) {
          const r = db.subs.find((x) => x.endpoint === args[2]); if (r) { r.topics = args[0]; r.countries = args[1]; }
        }
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
        if (/WHERE endpoint IN/.test(sql)) return { results: db.subs.filter((x) => args.includes(x.endpoint)) };
        if (/FROM push_subscriptions/.test(sql)) return { results: db.subs.filter((x) => x.email != null || /email IS NULL/.test(sql)) };
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
  + '<meta name="description" content="Daglig bedömning."></head><body><main id="view"><p>Laddar…</p></main></body></html>';
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
        } else if (sel === 'main#view') {
          h.element({ setInnerContent(t) { html = html.replace(/(<main id="view">)[\s\S]*?(<\/main>)/, `$1${t}$2`); } });
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

const ssr = (h) => (h.match(/<article id="ssr"[\s\S]*?<\/article>/) || [''])[0];
expect('event text in the page (SSR)', ssr(html).includes('En kabel mellan Finland och Estland skadades i natt. Polisen utreder.'), true);
expect('SSR is AI-labelled', ssr(html).includes('AI-sammanfattning'), true);
expect('SSR replaces the loading text', html.includes('Laddar…'), false);
expect('SSR links to the day', ssr(html).includes(`href="/d/${today}"`), true);
r = await get(`/h/${today}/${today}-e2`);
html = await r.text();
expect('SSR escapes markup', ssr(html).includes('&lt;script&gt;') && !ssr(html).includes('<script>'), true);
expect('markup in a title is escaped', html.includes('<script>'), false);
expect('empty summary: the title is the description', metaOf(html, 'og:description').startsWith('Desinformation om val &lt;script&gt;'), true);

r = await get(`/d/${today}`);
html = await r.text();
expect('day page 200', r.status, 200);
expect('day og:title has the index', metaOf(html, 'og:title').endsWith('· hotindex 6,4'), true);
expect('day og:description', metaOf(html, 'og:description'), 'Sabotage mot en kabel i Östersjön. · AI-sammanfattning · Hotmonitor');
expect('day og:url', metaOf(html, 'og:url'), `${ORIGIN}/d/${today}`);
expect('day SSR lists the events, highest first', ssr(html).indexOf(`${today}-e1`) > 0 && ssr(html).indexOf(`${today}-e1`) < ssr(html).indexOf(`${today}-e2`), true);
expect('day SSR has the top line', ssr(html).includes('Sabotage mot en kabel i Östersjön.'), true);

for (const bad of [`/h/${today}/nope`, '/h/2026-13-40/x-e1', '/d/1999-01-01', '/d/not-a-date', `/h/${today}/a%20b`, `/h/${today}/%E0%A4%A`, `/h/${today}/x/extra`]) {
  r = await get(bad);
  html = await r.text();
  expect(`404 for ${bad}`, r.status, 404);
  expect(`no OG tags on ${bad}`, html.includes('og:title'), false);
  expect(`no SSR on ${bad}`, html.includes('id="ssr"'), false);
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

// --- Push in batches of 40 --------------------------------------------------------
{
  const { b64uEncode } = await import('../src/webpush.js');
  const { pushTo, drainPushQueue } = _test;
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-05T12:00:00Z');   // 13:00 Stockholm, not quiet hours
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = b64uEncode(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pushEnv = { ...env, OWNER: 'owner@example.org',
    VAPID_PUBLIC_KEY: b64uEncode(await crypto.subtle.exportKey('raw', vk.publicKey)),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vk.privateKey)).d };
  db.subs = Array.from({ length: 100 }, (_, n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/s${n}`, email: 'owner@example.org', p256dh, auth, prefs: null }));
  db.subs[5].prefs = JSON.stringify({ report: false });
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { hits.push(String(u)); return new Response(null, { status: String(u).endsWith('/s7') ? 410 : 201 }); };

  let p = await pushTo(pushEnv, { adminsOnly: false, pref: 'report' }, { title: 'Test', body: 'x', url: '/#/' });
  expect('first batch: 40 requests, no more', hits.length, 40);
  expect('the rest is queued', p.queued, 59);
  expect('a dead subscription is removed', db.subs.some((x) => x.endpoint.endsWith('/s7')), false);
  expect('an opted-out subscription is skipped', hits.some((u) => u.endsWith('/s5')), false);
  p = await drainPushQueue(pushEnv);
  expect('next cron run: 40 more', hits.length, 80);
  p = await drainPushQueue(pushEnv);
  expect('then the last 19', hits.length, 99);
  expect('queue empty', p.queued, 0);
  expect('every subscriber once', new Set(hits).size, 99);
  const last = JSON.parse(db.meta.get('last_push'));
  expect('summary counts the whole push', last.sent + last.failed, 99);
  p = await drainPushQueue(pushEnv);
  expect('nothing left to send', hits.length, 99);

  // Two pushes in one invocation share the 40.
  hits.length = 0;
  const budget = { left: 40 };
  await pushTo(pushEnv, { adminsOnly: false, pref: 'report' }, { title: 'A' }, 'normal', budget);
  await pushTo(pushEnv, { adminsOnly: false, pref: 'report' }, { title: 'B' }, 'normal', budget);
  expect('one invocation stays at 40', hits.length, 40);
  while ((await drainPushQueue(pushEnv)).queued) { /* the cron, again and again */ }
  expect('both pushes reach everyone in the end', hits.length, 98 * 2);

  Date.now = () => Date.parse('2026-11-05T23:00:00Z');   // 00:00 Stockholm: quiet
  hits.length = 0;
  p = await pushTo(pushEnv, { adminsOnly: false, pref: 'report' }, { title: 'Natt' });
  expect('quiet hours: held, nothing sent', hits.length, 0);
  Date.now = () => Date.parse('2026-11-05T12:00:00Z');

  // --- Guest push (Version 3.23) ---
  db.subs = [{ endpoint: 'https://fcm.googleapis.com/fcm/send/user1', email: 'owner@example.org', p256dh, auth, prefs: null }];
  db.meta.delete('push_queue');
  const guestEp = 'https://fcm.googleapis.com/fcm/send/guest1';
  const gpost = (path, body, { origin = ORIGIN, ip = '198.51.100.1' } = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
  }), pushEnv, { waitUntil: () => {} });
  let res = await gpost('/api/push/subscribe', { endpoint: guestEp, keys: { p256dh, auth } }, { origin: null });
  expect('guest subscribe needs the app\'s Origin', res.status, 403);
  res = await gpost('/api/push/subscribe', { endpoint: 'https://evil.example/push', keys: { p256dh, auth } });
  expect('guest: unknown push service refused', res.status, 400);
  res = await gpost('/api/push/subscribe', { endpoint: guestEp, keys: { p256dh, auth }, prefs: { report: true, alarm: true } });
  expect('guest subscribes', res.status, 201);
  const gsub = db.subs.find((x) => x.endpoint === guestEp);
  expect('guest subscription has no email', gsub && gsub.email, null);
  expect('guest prefs keep only public flags', gsub && gsub.prefs, JSON.stringify({ report: true }));
  res = await gpost('/api/push/prefs', { endpoint: guestEp, topics: ['Nonsens'] });
  expect('unknown topic refused', res.status, 400);
  res = await gpost('/api/push/prefs', { endpoint: 'https://fcm.googleapis.com/fcm/send/nobody', topics: [] });
  expect('prefs for an unknown subscription: 404', res.status, 404);
  res = await gpost('/api/push/prefs', { endpoint: guestEp, topics: ['Sabotage'], countries: ['EE'] });
  expect('guest follows Sabotage and EE', res.status, 200);
  expect('stored', gsub.topics, JSON.stringify(['Sabotage']));
  res = await gpost('/api/push/prefs', { endpoint: 'https://fcm.googleapis.com/fcm/send/user1', topics: [] });
  expect('a guest cannot touch a user\'s subscription', res.status, 404);

  hits.length = 0;
  await pushTo(pushEnv, { adminsOnly: true, pref: 'alarm' }, { title: 'Larm' });
  expect('alarm: never to guests', hits.includes(guestEp), false);
  await pushTo(pushEnv, { adminsOnly: false, pref: 'notice' }, { title: 'Notis' });
  expect('admin notice: not to guests', hits.includes(guestEp), false);
  await pushTo(pushEnv, { adminsOnly: false, pref: 'report', guests: true, match: null }, { title: 'Index' });
  expect('index move: reaches the guest', hits.includes(guestEp), true);
  hits.length = 0;
  await pushTo(pushEnv, { adminsOnly: false, pref: 'report', guests: true, match: { topics: ['Drönare'], countries: ['PL'] } }, { title: 'Drönare' });
  expect('event outside what the guest follows: not sent to it', hits.includes(guestEp), false);
  expect('...but sent to who follows everything', hits.length, 1);
  hits.length = 0;
  await pushTo(pushEnv, { adminsOnly: false, pref: 'report', guests: true, match: { topics: ['Drönare'], countries: ['EE'] } }, { title: 'EE' });
  expect('event in a followed country: sent', hits.includes(guestEp), true);
  hits.length = 0;
  await _test.reportPush(pushEnv, { threat_index: null, events: [{ id: '2026-11-05-e9', score: 9.4, title_sv: 'Sabotage', topics: ['Sabotage'], countries: ['SE'] }] }, '2026-11-05');
  expect('reportPush: a 9+ event in a followed topic reaches the guest', hits.includes(guestEp), true);

  res = await gpost('/api/push/unsubscribe', { endpoint: guestEp });
  expect('guest unsubscribes', (await res.json()).removed, 1);
  const n0 = db.subs.length;
  for (let k = 0; k < 5000; k++) db.subs.push({ endpoint: `g${k}`, email: null });
  res = await gpost('/api/push/subscribe', { endpoint: guestEp, keys: { p256dh, auth } }, { ip: '198.51.100.2' });
  expect('guest cap: 503 at 5000', res.status, 503);
  db.subs.length = n0;
  let last429 = 0;
  for (let k = 0; k < 21; k++) last429 = (await gpost('/api/push/unsubscribe', { endpoint: guestEp }, { ip: '198.51.100.3' })).status;
  expect('guest writes: 20 an hour per IP', last429, 429);

  Date.now = realNow;
  globalThis.fetch = realFetch;
}

console.log(`\nlaunch_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
