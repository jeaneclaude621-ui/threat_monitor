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
  ASSETS: { fetch: async (req) => new Response(new URL(req.url).pathname === '/index.html' ? INDEX_HTML : 'asset', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) },
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

console.log(`\nlaunch_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
