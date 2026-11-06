/**
 * Hotmonitor API - Cloudflare Worker.
 *
 * Serves /api/* (see ../CONTRACT.md); everything else is the static app in
 * ../public, served by Workers Static Assets before this code runs.
 *
 * Auth: Cloudflare Access sits in front of the hostname and proves the
 * visitor owns an email address (one-time PIN). This Worker verifies the
 * Access JWT itself and then decides who gets in, from the D1 `users`
 * table - so a misconfigured Access policy, or a request that reaches the
 * Worker some other way, is refused rather than trusted. Without
 * TEAM_DOMAIN and ACCESS_AUD every request is refused (fail closed).
 * OWNER is always an active admin: the key nobody can lock out.
 *
 * Also (Version 3): Web Push on notable reports, and a cron that raises
 * an alarm when the morning report has not arrived by 07:00 Stockholm time.
 * Version 3.3: invitation emails (queued here, sent by the Mac) and an
 * admin "update everyone" push that makes open apps reload.
 * Version 3.4: the scheduled runs report in (from the Mac or GitHub
 * Actions), and the admin status page shows whether they keep running.
 * Version 3.8: this cron starts the scheduled runs on GitHub Actions, whose
 * own schedule starts them hours late or not at all.
 * Version 3.9: the trends feed - what spreads, from open sources and,
 * apart, from the Russian side - which nothing else here reads.
 * Version 3.10: the Swedish authorities' brief, also read by nothing else.
 * Version 3.11: Russia's courses of action, updated daily after the report.
 * Version 3.12: the forces map - Russia's bases, units and their status, nightly.
 * Version 3.13: Russia's air attacks on Ukraine, per night, and a weekly survey of the bases.
 * Version 3.16: the Sources tab refuses Telegram and Russian state media.
 * Version 3.17: with PUBLIC_READ on, anyone reads the public views as a guest,
 *   without e-mail addresses; everything else still needs a login.
 */

import { sendPush, allowedEndpoint, b64uDecode, checkPoint } from './webpush.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

const RATE_LIMIT_PER_MIN = 120;
// Guests share addresses (an office, a school, a mobile carrier's NAT), so an
// address gets more than one person; their reads are cached a minute.
const RATE_LIMIT_PER_IP_MIN = 600;
const LAST_SEEN_EVERY_MS = 5 * 60 * 1000;
const NEW_VISIT_GAP_MS = 30 * 60 * 1000;   // a gap this long starts a new visit
const SECURITY_LOG_DAYS = 90;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ARTICLE_ID_RE = /^[0-9a-f]{16}$/;
const CLIENT_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const ITEM_ID_RE = /^[\w.:-]{1,128}$/;
const EMAIL_RE = /^[^\s@,;"'<>]{1,64}@[^\s@,;"'<>]{1,190}\.[a-z]{2,}$/i;

const ALARM_AFTER_MINUTES = 7 * 60;   // 07:00 Stockholm time, when quiet hours end
// No push sounds at night: pushes due 22:00-07:00 Stockholm time wait in
// meta 'push_deferred' and the cron sends them at 07:00.
const QUIET_FROM_MINUTES = 22 * 60;
const QUIET_UNTIL_MINUTES = 7 * 60;
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const INDEX_PUSH_DELTA = 0.5;
const HIGH_SCORE = 9;
const INVITE_MAX_ATTEMPTS = 3;
const REFRESH_MIN_GAP_MS = 30 * 1000;
const INVITE_ID_RE = /^[0-9a-f-]{36}$/;

// Scheduled runs (Version 3.4), in Stockholm hours. Mirrors the schedule in
// .github/workflows/scheduled-jobs.yml.
const RUN_JOBS = {
  daily: { label: 'Morgonrapport', hours: [4], maxMinutes: 45, workflow: 'scheduled-jobs.yml' },
  hourly: { label: 'Trådbevakning', hours: [12, 21], maxMinutes: 20, workflow: 'scheduled-jobs.yml' },
  // Version 3.26: half past, so it does not start with the thread check at 12 and 21.
  trends: { label: 'Narrativ', hours: [8, 12, 16, 21], minute: 30, maxMinutes: 25, workflow: 'trends.yml' },
  authorities: { label: 'Myndigheter', hours: [7, 17], maxMinutes: 15, workflow: 'authorities.yml' },
};
const RUN_START_GRACE_MIN = 75;   // GitHub's own cron, the fallback, can lag
const RUN_ID_RE = /^[0-9a-f]{32}$/;
const RUN_LOG_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;
const RUNS_KEEP_DAYS = 90;
const MAC_QUIET_MIN = 30;
// Version 3.8: the cron that starts the runs (wrangler.jsonc). It fires at
// both UTC hours that can be each Stockholm hour in RUN_JOBS, summer and
// winter time; startDueRuns starts only the jobs due at the Stockholm hour.
const DISPATCH_CRON = '0 2,3,5,6,7,10,11,14,15,16,19,20 * * *';
// The jobs due at half past (`minute: 30` in RUN_JOBS), same idea.
const DISPATCH_CRON_HALF = '30 6,7,10,11,14,15,19,20 * * *';          // the invitation job (GitHub Actions) polls every 5 min; its cron can lag

// Reasons written to security_log (CONTRACT.md, Version 2).
const R = {
  notAllowed: 'not_allowed',
  invalidJwt: 'invalid_jwt',
  forbidden: 'forbidden',
  badRequest: 'bad_request',
  rateLimited: 'rate_limited',
  badOrigin: 'bad_origin',
};

class HttpError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    // What to log in security_log; 400/413 and 403 get a default below.
    this.reason = reason;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Version 3.17: /login is behind Access; once Access has let the person
    // through (and set its cookie), back to the app.
    if (url.pathname === '/login') {
      return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } });
    }
    if (!url.pathname.startsWith('/api/')) {
      // Version 3.22: share links, the feed and the sitemap (run_worker_first).
      if (request.method === 'GET' || request.method === 'HEAD') {
        const page = await publicPage(request, env, ctx, url);
        if (page) return page;
      }
      return env.ASSETS.fetch(request);
    }
    const req = { request, env, ctx, url, who: null, email: null };
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) {
        const reason = err.reason || defaultReason(err.status);
        if (reason) await securityLog(req, reason, err.message);
        return json(reason ? { error: err.message, reason } : { error: err.message }, err.status);
      }
      console.error('Unhandled error', err && err.stack ? err.stack : err);
      return json({ error: 'internal error' }, 500);
    }
  },

  // Cron (wrangler.jsonc triggers): DISPATCH_CRON starts the scheduled
  // runs; PUSH_QUEUE_CRON sends the rest of large pushes; the other sends
  // pushes held over the night, then the missing-report alarm.
  async scheduled(event, env, ctx) {
    const now = event.scheduledTime || Date.now();
    if (event.cron === DISPATCH_CRON || event.cron === DISPATCH_CRON_HALF) {
      ctx.waitUntil(startDueRuns(env, now));
      return;
    }
    // Version 3.22: the rest of a large push, PUSH_BATCH at a time.
    if (event.cron === PUSH_QUEUE_CRON) {
      ctx.waitUntil(drainPushQueue(env).catch((err) => {
        console.error('push queue failed', err && err.stack ? err.stack : err);
      }));
      return;
    }
    const budget = newBudget();
    ctx.waitUntil(flushDeferredPushes(env, now, budget)
      .then(() => retryMissingReport(env, now))
      .then(() => checkMissingReport(env, now, budget))
      .then(() => drainPushQueue(env, budget))
      .catch((err) => {
        console.error('scheduled check failed', err && err.stack ? err.stack : err);
      }));
  },
};

function defaultReason(status) {
  if (status === 400 || status === 413) return R.badRequest;
  if (status === 403) return R.forbidden;
  return null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function route(req) {
  const { request, env, url } = req;
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  const id = await identify(request, env, url);
  if (id.kind === 'user') req.email = id.email;
  // Before the 401, so an unauthenticated flood is limited per IP too.
  rateLimit(req, id);
  // Version 3.23: one small, long-cached package for guests (K3, step one).
  if (path === '/api/public/latest' && env.PUBLIC_READ === '1') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return publicLatest(req);
  }
  // Version 3.17: with PUBLIC_READ on, anyone may read the public views as a
  // guest, without logging in. Everything else still needs a login.
  const guestOk = env.PUBLIC_READ === '1' && (method === 'GET' || method === 'HEAD') && isPublicPath(path);
  // Version 3.23: guests may also subscribe to push (the subscription is the key).
  const guestPost = env.PUBLIC_READ === '1' && method === 'POST' && GUEST_POST_PATHS.has(path);
  if (id.kind === 'invalid') {
    if (guestOk) return guestRead(req, path);
    if (guestPost) return guestWrite(req, path);
    throw new HttpError(401, 'not authenticated', throttledReason(req, R.invalidJwt));
  }

  // Mutating requests from people must come from the app's own pages.
  // The machine has no browser and no Origin; it is exempt.
  if (id.kind === 'user' && method !== 'GET' && method !== 'HEAD') {
    if (request.headers.get('Origin') !== url.origin) {
      throw new HttpError(403, 'bad origin', R.badOrigin);
    }
  }

  // Version 3.22: a verified address without an account may ask for one.
  if (path === '/api/access-request') {
    allow(method, 'POST');
    if (id.kind !== 'user') throw new HttpError(403, 'log in with your e-mail address to ask for access');
    return requestAccess(env, id.email).catch(notMigrated('0014_access_requests'));
  }

  let who;
  try {
    who = id.kind === 'user' ? await userFor(id.email, req) : id;
  } catch (e) {
    // A verified address without an account reads like everyone else,
    // and /api/me tells the app so (U7), never from the shared cache.
    if (guestOk && e instanceof HttpError && e.status === 403) {
      return path === '/api/me' ? meWithoutAccount(env, id.email) : guestRead(req, path);
    }
    if (guestPost && e instanceof HttpError && e.status === 403) return guestWrite(req, path);
    throw e;
  }
  req.who = who;
  return dispatch(req, path, method, who);
}

async function dispatch(req, path, method, who) {
  const { request, env, url } = req;
  const guest = who.kind === 'guest';

  if (path === '/api/me') {
    allow(method, 'GET');
    if (guest) return json({ email: null, role: 'guest', is_owner: false, alarm: null, refresh: null });
    requireUser(who);
    return json({
      email: who.email, role: who.role, is_owner: who.is_owner,
      alarm: await getAlarm(env), refresh: await getRefresh(env),
    });
  }

  if (path === '/api/me/device') {
    allow(method, 'POST');
    requireUser(who);
    return recordDevice(request, env, who);
  }

  if (path === '/api/push/key') {
    allow(method, 'GET');
    requireReader(who);   // Version 3.23: guests may subscribe too
    if (!env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'push is not configured');
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (path === '/api/push/subscribe') {
    allow(method, 'POST');
    if (guest) return subscribePush(request, env, null).catch(notMigrated('0015_guest_push'));
    requireUser(who);
    return subscribePush(request, env, who);
  }

  if (path === '/api/push/unsubscribe') {
    allow(method, 'POST');
    if (guest) return unsubscribePush(request, env, null).catch(notMigrated('0015_guest_push'));
    requireUser(who);
    return unsubscribePush(request, env, who);
  }

  if (path === '/api/push/prefs') {
    allow(method, 'POST');
    if (guest) return pushFollow(request, env, null).catch(notMigrated('0015_guest_push'));
    requireUser(who);
    return pushFollow(request, env, who).catch(notMigrated('0015_guest_push'));
  }

  if (path === '/api/reports') {
    allow(method, 'GET');
    requireReader(who);
    const { results } = await env.DB.prepare(
      'SELECT date, threat_index, threat_index_30d, top_sv FROM reports ORDER BY date DESC'
    ).all();
    return json(results);
  }

  let m = path.match(/^\/api\/reports\/([^/]+)$/);
  if (m) {
    allow(method, 'GET');
    requireReader(who);
    const date = m[1];
    if (!DATE_RE.test(date)) throw new HttpError(400, 'bad date');
    const row = await env.DB.prepare('SELECT data FROM reports WHERE date = ?').bind(date).first();
    if (!row) throw new HttpError(404, 'no report for that date');
    return new Response(row.data, { status: 200, headers: apiHeaders() });
  }

  if (path === '/api/assessments') {
    if (method === 'GET') {
      // Who judged what stays among the logged-in.
      if (guest) return json([]);
      requireUser(who);
      const { results } = await env.DB.prepare(
        'SELECT * FROM assessments ORDER BY ts, rowid'
      ).all();
      return json(results);
    }
    allow(method, 'POST');
    requireUser(who);
    if (who.role !== 'admin') throw new HttpError(403, 'only admins can record assessments');
    return createAssessment(request, env, who);
  }

  if (path === '/api/notices') {
    allow(method, 'GET');
    requireReader(who);
    const { results } = await env.DB.prepare(
      'SELECT id, ts, author, title, body, url, expires_at FROM notices WHERE active = 1 AND expires_at > ? ORDER BY ts DESC'
    ).bind(new Date().toISOString()).all();
    if (guest) for (const r of results) delete r.author;
    return json(results);
  }

  if (path === '/api/updates') {
    allow(method, 'GET');
    requireReader(who);
    return listUpdates(env, url);
  }

  if (path === '/api/courses') {
    allow(method, 'GET');
    requireReader(who);
    const row = await env.DB.prepare('SELECT data FROM course_assessments ORDER BY date DESC LIMIT 1').first();
    return row ? new Response(row.data, { status: 200, headers: apiHeaders() }) : json(null);
  }

  if (path === '/api/strikes') {
    allow(method, 'GET');
    requireReader(who);
    const row = await env.DB.prepare('SELECT data FROM strike_maps ORDER BY date DESC LIMIT 1').first();
    return row ? new Response(row.data, { status: 200, headers: apiHeaders() }) : json(null);
  }

  if (path === '/api/forces') {
    allow(method, 'GET');
    requireReader(who);
    const row = await env.DB.prepare('SELECT data FROM force_maps ORDER BY date DESC LIMIT 1').first();
    return row ? new Response(row.data, { status: 200, headers: apiHeaders() }) : json(null);
  }

  if (path === '/api/authorities') {
    allow(method, 'GET');
    requireReader(who);
    const row = await env.DB.prepare('SELECT data FROM authority_briefs ORDER BY generated_at DESC LIMIT 1').first();
    return row ? new Response(row.data, { status: 200, headers: apiHeaders() }) : json(null);
  }

  if (path === '/api/trends') {
    allow(method, 'GET');
    requireReader(who);
    return listTrends(env, url, guest);
  }

  if (path === '/api/reads') {
    requireUser(who);
    if (method === 'GET') return getReads(env, who);
    allow(method, 'POST');
    return markRead(request, env, who);
  }

  if (path.startsWith('/api/admin/')) {
    requireUser(who);
    if (who.role !== 'admin') throw new HttpError(403, 'admins only');
    return routeAdmin(req, path, method);
  }

  m = path.match(/^\/api\/ingest\/reports\/([^/]+)$/);
  if (m) {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestReport(req, m[1]);
  }

  if (path === '/api/ingest/updates') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestUpdates(request, env);
  }

  if (path === '/api/ingest/courses') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestCourses(request, env);
  }

  if (path === '/api/ingest/strikes') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestStrikes(request, env);
  }

  if (path === '/api/ingest/forces') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestForces(request, env);
  }

  if (path === '/api/ingest/authorities') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestAuthorities(request, env);
  }

  if (path === '/api/ingest/trends') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestTrends(request, env);
  }

  if (path === '/api/export/invites') {
    allow(method, 'GET');
    requireMachine(who);
    return pendingInvites(env);
  }

  m = path.match(/^\/api\/ingest\/invites\/([^/]+)$/);
  if (m) {
    allow(method, 'PUT');
    requireMachine(who);
    return reportInvite(request, env, m[1]);
  }

  m = path.match(/^\/api\/ingest\/runs\/([^/]+)$/);
  if (m) {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestRun(request, env, m[1]);
  }

  if (path === '/api/export/sources') {
    allow(method, 'GET');
    requireMachine(who);
    const { results } = await env.DB.prepare(
      'SELECT id, kind, url, title, added_at FROM sources WHERE active = 1 ORDER BY added_at'
    ).all();
    // A source added before Version 3.16 never reaches the analysis either.
    return json(results.filter((r) => !blockedSource(r.url)));
  }

  if (path === '/api/export/all') {
    allow(method, 'GET');
    requireMachine(who);
    return exportAll(env);
  }

  if (path === '/api/export/assessments') {
    allow(method, 'GET');
    requireMachine(who);
    const since = url.searchParams.get('since') || '';
    const { results } = await env.DB.prepare(
      'SELECT * FROM assessments WHERE ts > ? ORDER BY ts, rowid'
    ).bind(since).all();
    await setMeta(env, 'last_machine_pull_at', new Date().toISOString());
    return json(results);
  }

  throw new HttpError(404, 'not found');
}

async function routeAdmin(req, path, method) {
  const { request, env, url, who } = req;

  if (path === '/api/admin/users') {
    if (method === 'GET') return listUsers(env);
    allow(method, 'POST');
    return addUser(request, env, who);
  }

  const m = path.match(/^\/api\/admin\/users\/([^/]+?)(\/invite)?$/);
  if (m) {
    let target;
    try {
      target = decodeURIComponent(m[1]).trim().toLowerCase();
    } catch {
      throw new HttpError(400, 'bad email in path');
    }
    if (!EMAIL_RE.test(target)) throw new HttpError(400, 'bad email in path');
    if (m[2]) {
      allow(method, 'POST');
      return resendInvite(env, who, target);
    }
    if (method === 'PATCH') return patchUser(request, env, who, target);
    allow(method, 'DELETE');
    return changeUser(env, who, target, { active: false });
  }

  if (path === '/api/admin/access-requests') {
    allow(method, 'GET');
    return listAccessRequests(env, url).catch(notMigrated('0014_access_requests'));
  }

  const ar = path.match(/^\/api\/admin\/access-requests\/([^/]+)$/);
  if (ar) {
    allow(method, 'POST');
    return decideAccessRequest(request, env, who, ar[1]).catch(notMigrated('0014_access_requests'));
  }

  if (path === '/api/admin/security') {
    allow(method, 'GET');
    return securityReport(env, url);
  }

  if (path === '/api/admin/audit') {
    allow(method, 'GET');
    const { results } = await env.DB.prepare(
      'SELECT * FROM audit_log ORDER BY id DESC LIMIT 500'
    ).all();
    return json(results);
  }

  if (path === '/api/admin/status') {
    allow(method, 'GET');
    return status(env);
  }

  if (path === '/api/admin/notices') {
    allow(method, 'POST');
    return createNotice(request, env, who);
  }

  if (path === '/api/admin/sources') {
    if (method === 'GET') return listSources(env);
    allow(method, 'POST');
    return addSource(request, env, who);
  }

  const src = path.match(/^\/api\/admin\/sources\/([0-9a-f-]{36})$/);
  if (src) {
    allow(method, 'DELETE');
    return removeSource(env, who, src[1]);
  }

  if (path === '/api/admin/refresh') {
    allow(method, 'POST');
    return refreshEveryone(request, env, who);
  }

  const n = path.match(/^\/api\/admin\/notices\/([0-9a-f-]{36})$/);
  if (n) {
    allow(method, 'DELETE');
    return removeNotice(env, who, n[1]);
  }

  throw new HttpError(404, 'not found');
}

// A new table or column whose migration has not run yet (D1's messages):
// answer a clear 503 rather than a bare 500.
const SCHEMA_MISSING_RE = /no such (table|column)|has no column named|NOT NULL constraint failed: push_subscriptions\.email/i;
const schemaMissing = (err) => !!err && SCHEMA_MISSING_RE.test(String(err.message || err));
function notMigrated(migration) {
  return (err) => {
    if (!schemaMissing(err)) throw err;
    console.error(`migration ${migration} has not run:`, err.message);
    throw new HttpError(503, `Funktionen är inte i drift än: databasen saknar migrationen ${migration}.`);
  };
}

function allow(method, expected) {
  if (method !== expected) throw new HttpError(405, 'method not allowed');
}

// ---------------------------------------------------------------------------
// Guests (Version 3.17)
// ---------------------------------------------------------------------------
// What a guest may read with PUBLIC_READ on. Assessments answer [] and
// /api/me answers role 'guest'; reads, push, devices, admin, ingest and
// export always need a login or the machine.
const PUBLIC_PATHS = new Set(['/api/me', '/api/push/key', '/api/reports', '/api/assessments', '/api/notices', '/api/updates',
  '/api/courses', '/api/strikes', '/api/forces', '/api/authorities', '/api/trends']);
const GUEST = Object.freeze({ kind: 'guest' });
const GUEST_CACHE_MS = 60000;
const GUEST_CACHE_MAX = 200;
const guestCache = new Map();   // per isolate: normalized path+query -> {at, body}, oldest first
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function isPublicPath(path) {
  return PUBLIC_PATHS.has(path) || /^\/api\/reports\/[^/]+$/.test(path);
}

/**
 * Replaces every e-mail address, as a value or as a key, with "Bedömare N"
 * (the same N for the same address within one answer), and drops the
 * fields that only name who added something.
 */
function pseudonymize(data) {
  const names = new Map();
  const alias = (email) => {
    const k = email.toLowerCase();
    if (!names.has(k)) names.set(k, `Bedömare ${names.size + 1}`);
    return names.get(k);
  };
  const walk = (v) => {
    if (typeof v === 'string') return v.includes('@') ? v.replace(EMAIL_IN_TEXT, alias) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'author' || k === 'added_by' || k === 'created_by' || k === 'actor') continue;
        out[k.includes('@') ? k.replace(EMAIL_IN_TEXT, alias) : k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(data);
}

// Version 3.22: the cache key keeps only the parameters a public read uses,
// so /api/reports?x=1, ?x=2 ... cannot each miss and read D1.
const GUEST_PARAMS = ['side', 'since', 'p'];
function guestKey(path, search) {
  const q = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const k of GUEST_PARAMS) {
    const v = q.get(k);
    if (v !== null && v !== '') kept.set(k, v.slice(0, 64));
  }
  const s = kept.toString();
  return s ? `${path}?${s}` : path;
}

/** Least recently used first out; the whole map is never emptied at once. */
function guestCachePut(key, entry) {
  guestCache.delete(key);
  while (guestCache.size >= GUEST_CACHE_MAX) guestCache.delete(guestCache.keys().next().value);
  guestCache.set(key, entry);
}

// The Cache API (caches.default) is shared by every isolate in a data
// centre. It works on a custom domain; on workers.dev it is a no-op.
function edgeCache() {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}
const edgeCacheUrl = (origin, key) => `${origin}/__guest-cache${key}`;

/** A guest's read: the same answer as a user's, without names, cached a minute. */
async function guestRead(req, path) {
  const key = guestKey(path, req.url.search);
  const now = Date.now();
  const hit = guestCache.get(key);
  let body;
  if (hit && now - hit.at < GUEST_CACHE_MS) {
    body = hit.body;
    guestCache.delete(key);
    guestCache.set(key, hit);   // most recently used last
  } else {
    const edge = edgeCache();
    const edgeReq = edge ? new Request(edgeCacheUrl(req.url.origin, key)) : null;
    let cached = null;
    if (edge) {
      try { cached = await edge.match(edgeReq); } catch { cached = null; }
    }
    if (cached) {
      body = await cached.text();
    } else {
      const res = await dispatch(req, path, 'GET', GUEST);
      if (!res.ok) return res;
      const text = await res.text();
      body = text === 'null' ? text : JSON.stringify(pseudonymize(JSON.parse(text)));
      if (edge) {
        const put = edge.put(edgeReq, new Response(body, {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${GUEST_CACHE_MS / 1000}` },
        })).catch(() => {});
        if (req.ctx && req.ctx.waitUntil) req.ctx.waitUntil(put); else await put;
      }
    }
    guestCachePut(key, { at: now, body });
  }
  const headers = apiHeaders();
  headers['Cache-Control'] = 'public, max-age=60';
  headers.Vary = 'Cookie';
  return new Response(req.request.method === 'HEAD' ? null : body, { status: 200, headers });
}

// Version 3.23: what a guest may POST, from the app's own pages only and
// at most GUEST_WRITES_PER_HOUR an hour per IP (per isolate).
const GUEST_POST_PATHS = new Set(['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/prefs']);
const GUEST_WRITES_PER_HOUR = 20;
const guestWrites = new Map();   // ip -> {start, n}

async function guestWrite(req, path) {
  const { request, url } = req;
  if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'bad origin', R.badOrigin);
  const ip = clientIp(request);
  const now = Date.now();
  let w = guestWrites.get(ip);
  if (!w || now - w.start >= 3600000) {
    w = { start: now, n: 0 };
    guestWrites.set(ip, w);
    if (guestWrites.size > 10000) {
      for (const [k, v] of guestWrites) if (now - v.start >= 3600000) guestWrites.delete(k);
    }
  }
  w.n += 1;
  if (w.n > GUEST_WRITES_PER_HOUR) throw new HttpError(429, 'too many requests', throttledReason(req, R.rateLimited));
  return dispatch(req, path, 'POST', GUEST);
}

// ---------------------------------------------------------------------------
// GET /api/public/latest (Version 3.23)
// ---------------------------------------------------------------------------
// The report index and the newest report, without e-mail addresses, in one
// answer cached five minutes (per isolate, in caches.default and in the
// browser). The same for everyone, so a guest's first view needs one call.
const PUBLIC_LATEST_S = 300;
let publicLatestMemo = null;   // {at, body}

async function publicLatest(req) {
  const { request, env, url, ctx } = req;
  const now = Date.now();
  let body = publicLatestMemo && now - publicLatestMemo.at < PUBLIC_LATEST_S * 1000 ? publicLatestMemo.body : null;
  const edge = body ? null : edgeCache();
  const key = new Request(`${url.origin}/__public-cache/api/public/latest`);
  if (edge) {
    try { const hit = await edge.match(key); if (hit) body = await hit.text(); } catch { /* build it */ }
  }
  if (!body) {
    const { results } = await env.DB.prepare(
      'SELECT date, threat_index, threat_index_30d, top_sv FROM reports ORDER BY date DESC'
    ).all();
    let latest = null;
    if (results.length) {
      const row = await env.DB.prepare('SELECT data FROM reports WHERE date = ?').bind(results[0].date).first();
      if (row) {
        try { latest = JSON.parse(row.data); } catch { latest = null; }
      }
    }
    body = JSON.stringify(pseudonymize({ generated_at: new Date(now).toISOString(), index: results, latest }));
    if (edge) {
      const put = edge.put(key, new Response(body, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${PUBLIC_LATEST_S}` },
      })).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    }
  }
  publicLatestMemo = { at: now, body };
  const headers = apiHeaders();
  headers['Cache-Control'] = `public, max-age=${PUBLIC_LATEST_S}`;
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

function requireUser(who) {
  if (!who) throw new HttpError(401, 'not authenticated');
  if (who.kind !== 'user') throw new HttpError(403, 'forbidden');
}

/** The public read paths: a person, or a guest when PUBLIC_READ is on. */
function requireReader(who) {
  if (who && who.kind === 'guest') return;
  requireUser(who);
}

function requireMachine(who) {
  if (!who) throw new HttpError(401, 'not authenticated');
  if (who.kind !== 'machine') throw new HttpError(403, 'forbidden');
}

// ---------------------------------------------------------------------------
// Public pages (Version 3.22): share links with Open Graph tags
// ---------------------------------------------------------------------------
// /h/<date>/<event id> and /d/<date> serve index.html with the event's or
// the day's title and first sentence in <title> and the Open Graph tags, so
// a link shared in a chat or on social media shows what it is about. The
// app turns the path into its own hash route. Rendered pages are cached ten
// minutes in caches.default; a crawler's preview is one cheap D1 read at most.
const SITE_NAME = 'Hotmonitor';
const SITE_TAGLINE = 'AI-sammanställning av ryska hybridhot ur öppna källor';
const AI_LABEL = 'AI-sammanfattning';
const PAGE_CACHE_S = 600;
const HOME_CACHE_S = 60;   // the app's own page: a deploy shows within a minute
const FEED_CACHE_S = 900;
const FEED_DAYS = 14;
const FEED_MIN_SCORE = 8;
const SITEMAP_DAYS = 90;
const EVENT_ID_RE = /^[\w.:-]{1,64}$/;
const REPORT_CACHE_MAX = 30;
const reportCache = new Map();   // per isolate: date -> {at, data|null}, oldest first

/** The day's report, parsed, cached ten minutes per isolate; null if none. */
async function reportData(env, date) {
  const now = Date.now();
  const hit = reportCache.get(date);
  if (hit && now - hit.at < PAGE_CACHE_S * 1000) return hit.data;
  const row = await env.DB.prepare('SELECT data FROM reports WHERE date = ?').bind(date).first();
  let data = null;
  if (row) {
    try { data = pseudonymize(JSON.parse(row.data)); } catch { data = null; }
  }
  reportCache.delete(date);
  while (reportCache.size >= REPORT_CACHE_MAX) reportCache.delete(reportCache.keys().next().value);
  reportCache.set(date, { at: now, data });
  return data;
}

const clean = (v) => String(v ?? '').replace(EMAIL_IN_TEXT, 'Bedömare').replace(/\s+/g, ' ').trim();

/** The first sentence, at most ~200 characters. */
function firstSentence(text) {
  const t = clean(text);
  if (!t) return '';
  const m = t.match(/^.+?[.!?](?=\s|$)/);
  let out = m ? m[0] : t;
  if (out.length > 200) out = `${out.slice(0, 197).replace(/\s+\S*$/, '')}…`;
  return out;
}

const svIndex = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1).replace('.', ',') : null);
const svDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The event that matters most in a report: highest score first. */
function topEvent(data) {
  const events = Array.isArray(data && data.events) ? data.events.filter((e) => e && typeof e === 'object') : [];
  return events.reduce((best, e) => (typeof e.score === 'number' && (!best || e.score > best.score) ? e : best), null);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return ''; }
}

function realDate(date) {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Title, description and canonical path for a share path, or null (404). */
async function shareMeta(env, path) {
  let m = path.match(/^\/h\/([^/]+)\/([^/]+)$/);
  if (m) {
    const date = safeDecode(m[1]);
    const id = safeDecode(m[2]);
    if (!realDate(date) || !EVENT_ID_RE.test(id)) return null;
    const data = await reportData(env, date);
    const events = Array.isArray(data && data.events) ? data.events : [];
    const e = events.find((x) => x && x.id === id);
    if (!e) return null;
    const title = clean(e.title_sv || e.title).slice(0, 160) || `Händelse ${svDate(date)}`;
    const first = firstSentence(e.summary_sv) || firstSentence(e.title_sv || e.title);
    return {
      title, description: `${first} · ${AI_LABEL} · ${SITE_NAME}`, path: `/h/${date}/${encodeURIComponent(id)}`, date,
      article: eventArticle(date, e, title),
    };
  }
  m = path.match(/^\/d\/([^/]+)$/);
  if (m) {
    const date = safeDecode(m[1]);
    if (!realDate(date)) return null;
    const data = await reportData(env, date);
    if (!data) return null;
    const idx = svIndex(data.threat_index);
    const title = `Lägesbild ${svDate(date)}${idx ? ` · hotindex ${idx}` : ''}`;
    const top = topEvent(data);
    const first = firstSentence(data.executive_sv && data.executive_sv.top)
      || firstSentence(data.top_development) || firstSentence(top && (top.summary_sv || top.title_sv));
    return {
      title, description: `${first || SITE_TAGLINE} · ${AI_LABEL} · ${SITE_NAME}`, path: `/d/${date}`, date,
      article: dayArticle(date, data, title),
    };
  }
  return undefined;   // not a share path
}

// Version 3.23: the text itself as plain HTML in <main id="view">, for
// search engines and for readers without JavaScript. The app replaces it
// when it renders. Every string is escaped; links stay inside the app.
const AI_NOTE = 'AI-genererad sammanställning ur öppna källor. Kan innehålla fel. Hotmonitor är ett privat projekt och ingen myndighet.';
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const scoreText = (v) => (typeof v === 'number' ? `${Number.isInteger(v) ? v : svIndex(v)}/10` : '');

function eventArticle(date, e, title) {
  const parts = [`<article id="ssr" lang="sv">`, `<p class="ssr-label">${escHtml(AI_LABEL)} · ${escHtml(svDate(date))}${e.score !== undefined ? ` · trovärdighet ${escHtml(scoreText(e.score))}` : ''}</p>`,
    `<h1>${escHtml(title)}</h1>`];
  const summary = clean(e.summary_sv);
  if (summary) parts.push(`<p>${escHtml(summary)}</p>`);
  const tags = [...(Array.isArray(e.topics) ? e.topics : []), ...(Array.isArray(e.countries) ? e.countries : [])].filter((t) => typeof t === 'string').slice(0, 20);
  if (tags.length) parts.push(`<p>${escHtml(tags.join(' · '))}</p>`);
  const outlets = [...new Set((Array.isArray(e.articles) ? e.articles : []).map((a) => a && clean(a.outlet)).filter(Boolean))].slice(0, 20);
  if (outlets.length) parts.push(`<p>Källor: ${escHtml(outlets.join(', '))}</p>`);
  parts.push(`<p><a href="/d/${escHtml(date)}">Hela lägesbilden ${escHtml(svDate(date))}</a></p>`, `<p><small>${escHtml(AI_NOTE)}</small></p>`, '</article>');
  return parts.join('\n');
}

function dayArticle(date, data, title) {
  const parts = [`<article id="ssr" lang="sv">`, `<p class="ssr-label">${escHtml(AI_LABEL)}</p>`, `<h1>${escHtml(title)}</h1>`];
  const top = clean((data.executive_sv && data.executive_sv.top) || data.top_development);
  if (top) parts.push(`<p>${escHtml(top)}</p>`);
  const events = (Array.isArray(data.events) ? data.events : [])
    .filter((e) => e && typeof e.id === 'string' && EVENT_ID_RE.test(e.id) && (e.title_sv || e.title))
    .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 50);
  if (events.length) {
    parts.push('<h2>Händelser</h2>', '<ul>');
    for (const e of events) {
      parts.push(`<li><a href="/h/${escHtml(date)}/${escHtml(encodeURIComponent(e.id))}">${escHtml(clean(e.title_sv || e.title).slice(0, 160))}</a>${e.score !== undefined ? ` (${escHtml(scoreText(e.score))})` : ''}</li>`);
    }
    parts.push('</ul>');
  }
  parts.push(`<p><small>${escHtml(AI_NOTE)}</small></p>`, '</article>');
  return parts.join('\n');
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The day's own image when the deploy has one (public/og/<date>.png), else the default. */
// The morning run deploys public/og/<date>.png and og/latest.png. A missing
// file answers index.html (single-page fallback), hence the type check.
async function ogImage(env, origin, name) {
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}/og/${name}.png`, { method: 'HEAD' }));
    if (res.ok && (res.headers.get('Content-Type') || '').startsWith('image/')) return `${origin}/og/${name}.png`;
  } catch { /* the default below */ }
  return `${origin}/og/default.png`;
}

async function indexHtml(env, origin) {
  return env.ASSETS.fetch(new Request(`${origin}/`, { method: 'GET' }));
}

async function sharePage(request, env, url, meta) {
  const page = await indexHtml(env, url.origin);
  const headers = new Headers(page.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  if (!meta) {
    headers.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers });
  }
  headers.set('Cache-Control', `public, max-age=${meta.maxAge || PAGE_CACHE_S}`);
  const canonical = `${url.origin}${meta.path}`;
  const image = await ogImage(env, url.origin, meta.image || meta.date);
  const tags = [
    ['property', 'og:type', meta.type || 'article'], ['property', 'og:site_name', SITE_NAME], ['property', 'og:locale', 'sv_SE'],
    ['property', 'og:title', meta.title], ['property', 'og:description', meta.description],
    ['property', 'og:url', canonical], ['property', 'og:image', image],
    ['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630'],
    ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', meta.title],
    ['name', 'twitter:description', meta.description], ['name', 'twitter:image', image],
    ['name', 'ai-generated', 'true'],
  ].map(([k, n, v]) => `<meta ${k}="${n}" content="${escAttr(v)}">`).join('\n')
    + `\n<link rel="canonical" href="${escAttr(canonical)}">\n`;
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(meta.title === SITE_NAME ? SITE_NAME : `${meta.title} · ${SITE_NAME}`); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute('content', meta.description); } })
    .on('head', { element(el) { el.append(tags, { html: true }); } })
    .on('main#view', { element(el) { if (meta.article) el.setInnerContent(meta.article, { html: true }); } })
    .transform(new Response(page.body, { status: 200, headers }));
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers: out.headers }) : out;
}

/** Serves a public page from caches.default, or builds and stores it. */
async function cachedPage(request, ctx, url, build) {
  const edge = edgeCache();
  const key = `${url.origin}${url.pathname}`;
  if (edge) {
    try {
      const hit = await edge.match(new Request(key));
      if (hit) return request.method === 'HEAD' ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
    } catch { /* build it */ }
  }
  const res = await build();
  if (edge && res.status === 200 && request.method === 'GET') {
    const [a, b] = res.body ? res.body.tee() : [null, null];
    const put = edge.put(new Request(key), new Response(b, { status: 200, headers: res.headers })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    return new Response(a, { status: 200, headers: res.headers });
  }
  return res;
}

/** The Stockholm date `days` days before today. */
function daysAgo(days) {
  const today = stockholmClock(Date.now()).date;
  return new Date(Date.parse(`${today}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}

/** Reports since a date with their events, parsed by D1 (json_each), not here. */
async function reportsWithEvents(env, since) {
  const { results } = await env.DB.prepare(
    `SELECT r.date, r.threat_index, r.top_sv,
            json_extract(r.data, '$.executive_sv.top') AS exec_top,
            json_extract(e.value, '$.id') AS id, json_extract(e.value, '$.score') AS score,
            json_extract(e.value, '$.title_sv') AS title_sv, json_extract(e.value, '$.title') AS title,
            json_extract(e.value, '$.summary_sv') AS summary_sv
     FROM reports r LEFT JOIN json_each(r.data, '$.events') e
     WHERE r.date >= ? ORDER BY r.date DESC`
  ).bind(since).all();
  const days = new Map();
  for (const row of results) {
    if (!realDate(row.date)) continue;
    if (!days.has(row.date)) {
      days.set(row.date, { date: row.date, threat_index: row.threat_index, top: row.exec_top || row.top_sv, events: [] });
    }
    if (typeof row.id === 'string' && EVENT_ID_RE.test(row.id)) {
      days.get(row.date).events.push({ id: row.id, score: row.score, title_sv: row.title_sv, title: row.title, summary_sv: row.summary_sv });
    }
  }
  return [...days.values()];
}

const rfc822 = (date) => new Date(`${date}T05:00:00Z`).toUTCString();

/** RSS 2.0: the last 14 days' reports and their events scored 8 or more. */
async function feedXml(env, url) {
  const o = url.origin;
  const days = await reportsWithEvents(env, daysAgo(FEED_DAYS - 1));
  const items = [];
  const item = (title, link, description, date) => items.push(
    `<item><title>${escXml(title)}</title><link>${escXml(link)}</link>`
    + `<guid isPermaLink="true">${escXml(link)}</guid><pubDate>${rfc822(date)}</pubDate>`
    + `<description>${escXml(description)}</description></item>`);
  for (const d of days) {
    const top = topEvent(d);
    const idx = svIndex(d.threat_index);
    const headline = clean(top && (top.title_sv || top.title)) || firstSentence(d.top);
    item(`${idx ? `Hotindex ${idx}` : `Lägesbild ${svDate(d.date)}`}${headline ? ` · ${headline}` : ''}`,
      `${o}/d/${d.date}`, `${AI_LABEL}: ${firstSentence(d.top) || headline || SITE_TAGLINE}`, d.date);
    for (const e of d.events) {
      if (typeof e.score !== 'number' || e.score < FEED_MIN_SCORE) continue;
      const title = clean(e.title_sv || e.title).slice(0, 160);
      if (!title) continue;
      item(`${title} (${Number.isInteger(e.score) ? e.score : svIndex(e.score)}/10)`, `${o}/h/${d.date}/${encodeURIComponent(e.id)}`,
        `${AI_LABEL}: ${clean(e.summary_sv).slice(0, 1000) || title}`, d.date);
    }
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>\n'
    + `<title>${SITE_NAME}</title><link>${o}/</link>`
    + `<description>${escXml(`${SITE_TAGLINE}. Texterna är AI-genererade och kan innehålla fel.`)}</description>`
    + `<language>sv</language><ttl>60</ttl>`
    + `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`
    + `<atom:link href="${o}/feed.xml" rel="self" type="application/rss+xml"/>\n`
    + items.join('\n') + '\n</channel></rss>\n';
  return new Response(xml, { status: 200, headers: {
    'Content-Type': 'application/rss+xml; charset=utf-8',
    'Cache-Control': `public, max-age=${FEED_CACHE_S}`,
    'X-Content-Type-Options': 'nosniff',
  } });
}

/** Every /d/<date> and /h/<date>/<id> of the last 90 days. */
async function sitemapXml(env, url) {
  const o = url.origin;
  const days = await reportsWithEvents(env, daysAgo(SITEMAP_DAYS - 1));
  const urls = [`<url><loc>${o}/</loc><changefreq>daily</changefreq></url>`];
  for (const d of days) {
    urls.push(`<url><loc>${o}/d/${d.date}</loc><lastmod>${d.date}</lastmod></url>`);
    for (const e of d.events) urls.push(`<url><loc>${escXml(`${o}/h/${d.date}/${encodeURIComponent(e.id)}`)}</loc><lastmod>${d.date}</lastmod></url>`);
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.join('\n') + '\n</urlset>\n';
  return new Response(xml, { status: 200, headers: {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': `public, max-age=${FEED_CACHE_S}`,
    'X-Content-Type-Options': 'nosniff',
  } });
}

/** Share links, /feed.xml and /sitemap.xml; null for anything else. */
async function publicPage(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const isShare = /^\/[hd]\//.test(path);
  // Version 3.24: the start page shows the latest shareable image when shared.
  if (url.pathname === '/' && env.PUBLIC_READ === '1') {
    try {
      return await cachedPage(request, ctx, url, () => sharePage(request, env, url, {
        title: SITE_NAME, type: 'website', path: '/', image: 'latest', maxAge: HOME_CACHE_S,
        description: `${SITE_TAGLINE}, varje morgon. · ${AI_LABEL} · ${SITE_NAME}`,
      }));
    } catch (err) {
      console.error('start page failed', err && err.stack ? err.stack : err);
      return env.ASSETS.fetch(request);
    }
  }
  if (path === '/robots.txt') {
    // A Sitemap line must be absolute: this host, whatever the domain.
    const res = await env.ASSETS.fetch(request);
    if (!res.ok || request.method === 'HEAD') return res;
    const text = (await res.text()).replace(/^Sitemap: \/sitemap\.xml$/m, `Sitemap: ${url.origin}/sitemap.xml`);
    const headers = new Headers(res.headers);
    headers.delete('Content-Length');
    headers.delete('ETag');
    return new Response(text, { status: 200, headers });
  }
  if (!isShare && path !== '/feed.xml' && path !== '/sitemap.xml') return null;
  // With the public views off (PUBLIC_READ), nothing is told to the outside.
  if (env.PUBLIC_READ !== '1') {
    if (isShare) return sharePage(request, env, url, null).then((r) => new Response(r.body, { status: 200, headers: r.headers }));
    return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  try {
    if (isShare) {
      return await cachedPage(request, ctx, url, async () => sharePage(request, env, url, await shareMeta(env, path)));
    }
    if (path === '/feed.xml') return await cachedPage(request, ctx, url, () => feedXml(env, url));
    return await cachedPage(request, ctx, url, () => sitemapXml(env, url));
  } catch (err) {
    console.error('public page failed', err && err.stack ? err.stack : err);
    if (isShare) return env.ASSETS.fetch(new Request(`${url.origin}/`));
    return new Response('temporarily unavailable', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' } });
  }
}

// ---------------------------------------------------------------------------
// Assessments and reports
// ---------------------------------------------------------------------------
async function createAssessment(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  const { article_id, report_date, value } = body;
  const event_id = body.event_id ?? null;
  const outlet = body.outlet ?? null;
  const supersedes = body.supersedes ?? null;
  const client_id = body.client_id ?? null;

  if (typeof article_id !== 'string' || !ARTICLE_ID_RE.test(article_id)) {
    throw new HttpError(400, 'article_id must be 16 lowercase hex characters');
  }
  if (typeof report_date !== 'string' || !DATE_RE.test(report_date)) {
    throw new HttpError(400, 'report_date must be YYYY-MM-DD');
  }
  if (!Number.isInteger(value) || value < -2 || value > 2) {
    throw new HttpError(400, 'value must be an integer from -2 to 2');
  }
  if (event_id !== null && (typeof event_id !== 'string' || event_id.length > 64)) {
    throw new HttpError(400, 'event_id must be a string of at most 64 characters');
  }
  if (outlet !== null && (typeof outlet !== 'string' || outlet.length > 200)) {
    throw new HttpError(400, 'outlet must be a string of at most 200 characters');
  }
  if (supersedes !== null && (typeof supersedes !== 'string' || supersedes.length > 64)) {
    throw new HttpError(400, 'supersedes must be an assessment id');
  }
  if (client_id !== null && (typeof client_id !== 'string' || !CLIENT_ID_RE.test(client_id))) {
    throw new HttpError(400, 'client_id must be 8-64 characters of letters, digits and dashes');
  }

  // A repeated client_id is a retry from the phone's offline queue:
  // hand back the row it already created.
  if (client_id) {
    const existing = await env.DB.prepare('SELECT * FROM assessments WHERE client_id = ?').bind(client_id).first();
    if (existing) return json(existing, 200);
  }

  const report = await env.DB.prepare('SELECT 1 AS ok FROM reports WHERE date = ?').bind(report_date).first();
  if (!report) throw new HttpError(400, 'report_date has no report');

  if (supersedes) {
    const prev = await env.DB.prepare('SELECT article_id FROM assessments WHERE id = ?').bind(supersedes).first();
    if (!prev) throw new HttpError(400, 'supersedes names no assessment');
    if (prev.article_id !== article_id) throw new HttpError(400, 'supersedes names an assessment of another article');
  }

  const row = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    operator: who.email,
    article_id,
    report_date,
    event_id,
    outlet,
    value,
    supersedes,
    client_id,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO assessments (id, ts, operator, article_id, report_date, event_id, outlet, value, supersedes, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.ts, row.operator, row.article_id, row.report_date, row.event_id,
           row.outlet, row.value, row.supersedes, row.client_id).run();
  } catch (err) {
    // Two retries racing on the same client_id: the loser returns the winner's row.
    if (client_id && /UNIQUE/i.test(String(err && err.message))) {
      const existing = await env.DB.prepare('SELECT * FROM assessments WHERE client_id = ?').bind(client_id).first();
      if (existing) return json(existing, 200);
    }
    throw err;
  }
  return json(row, 201);
}

async function ingestReport(req, date) {
  const { request, env, ctx } = req;
  if (!DATE_RE.test(date)) throw new HttpError(400, 'bad date');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  if (body.date !== date) throw new HttpError(400, 'body.date does not match the URL');

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const topSv = (body.executive_sv && typeof body.executive_sv.top === 'string' && body.executive_sv.top)
    || (typeof body.top_development === 'string' ? body.top_development : null);

  await env.DB.prepare(
    `INSERT INTO reports (date, threat_index, threat_index_30d, top_sv, data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       threat_index = excluded.threat_index,
       threat_index_30d = excluded.threat_index_30d,
       top_sv = excluded.top_sv,
       data = excluded.data,
       updated_at = excluded.updated_at`
  ).bind(date, num(body.threat_index), num(body.threat_index_30d), topSv,
         JSON.stringify(body), new Date().toISOString()).run();

  // The report the alarm was waiting for has come.
  const alarm = await getAlarm(env);
  if (alarm.missing_report === date) {
    await env.DB.prepare("DELETE FROM meta WHERE key = 'alarm_missing_report'").run();
    await audit(env, 'system', 'alarm_cleared', null, { missing_report: date });
  }

  const push = reportPush(env, body, date).catch((err) => {
    console.error('report push failed', err && err.stack ? err.stack : err);
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(push); else await push;
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Live updates and read state
// ---------------------------------------------------------------------------
async function ingestUpdates(request, env) {
  const body = await readJson(request);
  if (!Array.isArray(body)) throw new HttpError(400, 'body must be a JSON array of updates');
  if (body.length > 500) throw new HttpError(400, 'at most 500 updates per request');

  const str = (v, max) => (v === undefined || v === null ? null
    : (typeof v === 'string' && v.length <= max ? v : undefined));
  const stmts = [];
  for (const u of body) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) throw new HttpError(400, 'each update must be an object');
    if (typeof u.id !== 'string' || !ITEM_ID_RE.test(u.id)) throw new HttpError(400, 'update id must be 1-128 of letters, digits, _ . : -');
    if (typeof u.ts !== 'string' || !TS_RE.test(u.ts)) throw new HttpError(400, `update ${u.id}: ts must be ISO 8601`);
    const fields = {
      thread_id: str(u.thread_id, 200), thread_label: str(u.thread_label, 1000),
      classification: str(u.classification, 64), title_sv: str(u.title_sv, 1000),
      summary_sv: str(u.summary_sv, 5000), report_date: str(u.report_date, 10),
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) throw new HttpError(400, `update ${u.id}: ${k} is not a string of allowed length`);
    }
    if (fields.report_date && !DATE_RE.test(fields.report_date)) throw new HttpError(400, `update ${u.id}: bad report_date`);
    const outlets = u.outlets ?? [];
    if (!Array.isArray(outlets) || outlets.length > 50 || outlets.some((o) => typeof o !== 'string' || o.length > 200)) {
      throw new HttpError(400, `update ${u.id}: outlets must be an array of strings`);
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO updates (id, ts, thread_id, thread_label, classification, title_sv, summary_sv, outlets, report_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ts = excluded.ts, thread_id = excluded.thread_id, thread_label = excluded.thread_label,
         classification = excluded.classification, title_sv = excluded.title_sv,
         summary_sv = excluded.summary_sv, outlets = excluded.outlets, report_date = excluded.report_date`
    ).bind(u.id, u.ts, fields.thread_id, fields.thread_label, fields.classification,
           fields.title_sv, fields.summary_sv, JSON.stringify(outlets), fields.report_date));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, count: stmts.length });
}

async function listUpdates(env, url) {
  let since = url.searchParams.get('since');
  if (since) {
    if (!TS_RE.test(since)) throw new HttpError(400, 'since must be ISO 8601');
  } else {
    since = new Date(Date.now() - 7 * 86400000).toISOString();
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM updates WHERE ts > ? ORDER BY ts DESC LIMIT 500'
  ).bind(since).all();
  for (const r of results) {
    try { r.outlets = JSON.parse(r.outlets || '[]'); } catch { r.outlets = []; }
  }
  return json(results);
}

async function getReads(env, who) {
  const { results } = await env.DB.prepare(
    'SELECT item_id FROM reads WHERE email = ? ORDER BY ts'
  ).bind(who.email).all();
  return json({ item_ids: results.map((r) => r.item_id), last_visit: who.last_visit || null });
}

async function markRead(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  const now = new Date().toISOString();

  if (body.all_before !== undefined) {
    if (typeof body.all_before !== 'string' || !TS_RE.test(body.all_before)) {
      throw new HttpError(400, 'all_before must be ISO 8601');
    }
    const day = body.all_before.slice(0, 10);
    const r1 = await env.DB.prepare(
      `INSERT OR IGNORE INTO reads (email, item_id, ts)
       SELECT ?, json_extract(e.value, '$.id'), ?
       FROM reports r, json_each(r.data, '$.events') e
       WHERE r.date <= ? AND json_extract(e.value, '$.id') IS NOT NULL`
    ).bind(who.email, now, day).run();
    const r2 = await env.DB.prepare(
      `INSERT OR IGNORE INTO reads (email, item_id, ts)
       SELECT ?, id, ? FROM updates WHERE ts <= ?`
    ).bind(who.email, now, body.all_before).run();
    return json({ ok: true, marked: (r1.meta?.changes || 0) + (r2.meta?.changes || 0) });
  }

  const ids = body.item_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500
      || ids.some((i) => typeof i !== 'string' || !ITEM_ID_RE.test(i))) {
    throw new HttpError(400, 'item_ids must be 1-500 ids of letters, digits, _ . : -');
  }
  await env.DB.batch(ids.map((i) => env.DB.prepare(
    'INSERT OR IGNORE INTO reads (email, item_id, ts) VALUES (?, ?, ?)'
  ).bind(who.email, i, now)));
  return json({ ok: true, marked: ids.length });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.role, u.active, u.created_at, u.created_by, u.last_seen,
            u.installed_at, u.platform,
            (SELECT COUNT(*) FROM assessments a WHERE a.operator = u.email) AS assessments,
            (SELECT COUNT(*) FROM push_subscriptions p WHERE p.email = u.email) AS push_devices,
            i.status AS invite_status, i.requested_at AS invite_requested_at,
            i.sent_at AS invite_sent_at, i.error AS invite_error
     FROM users u
     LEFT JOIN invites i ON i.id = (SELECT id FROM invites WHERE email = u.email ORDER BY requested_at DESC LIMIT 1)
     ORDER BY u.active DESC, u.role, u.email`
  ).all();
  const owner = ownerEmail(env);
  for (const r of results) {
    r.active = !!r.active;
    r.is_owner = r.email === owner;
    r.installed = !!r.installed_at;   // "Hemskärm: ja/nej"
    if (r.is_owner) { r.role = 'admin'; r.active = true; }
  }
  return json(results);
}

async function addUser(request, env, actor) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is not a valid address');
  if (body.role !== 'admin' && body.role !== 'reader') throw new HttpError(400, "role must be 'admin' or 'reader'");
  if (body.invite !== undefined && typeof body.invite !== 'boolean') throw new HttpError(400, 'invite must be true or false');

  return grantAccess(env, actor, email, body.role, body.invite);
}

/** Adds a user, or changes an existing one's role or reactivates them.
 *  invite: undefined mails a new user only, true always, false never. */
async function grantAccess(env, actor, email, role, invite) {
  const existing = await env.DB.prepare('SELECT role, active FROM users WHERE email = ?').bind(email).first();
  const now = new Date().toISOString();
  if (existing) {
    // Someone already in the list gets mail only when asked for explicitly.
    if (invite === true) await queueInvite(env, actor, email, role);
    if (existing.active && existing.role === role) return json(await userRow(env, email), 200);
    return changeUser(env, actor, email, { role, active: true });
  }
  await env.DB.prepare(
    'INSERT INTO users (email, role, active, created_at, created_by) VALUES (?, ?, 1, ?, ?)'
  ).bind(email, role, now, actor.email).run();
  await audit(env, actor.email, 'add', email, { role });
  if (invite !== false) await queueInvite(env, actor, email, role);
  return json(await userRow(env, email), 201);
}

// ---------------------------------------------------------------------------
// Access requests (Version 3.22)
// ---------------------------------------------------------------------------
// Someone who has proved an address through Access but has no account may
// ask for one. Only the address and the time are kept; an admin approves
// (a reader account, through grantAccess) or denies.
const ACCESS_REQUESTS_PER_DAY = 3;
const ACCESS_REQUESTS_OPEN_MAX = 500;
const ACCESS_REQUEST_ID_RE = /^[0-9a-f-]{36}$/;
const ACCESS_REQUEST_FIELDS = 'id, email, ts, status, decided_at, decided_by';

async function latestAccessRequest(env, email) {
  return env.DB.prepare(
    `SELECT ${ACCESS_REQUEST_FIELDS} FROM access_requests WHERE email = ? ORDER BY ts DESC LIMIT 1`
  ).bind(email).first();
}

/** /api/me for a verified address without an account: a guest who may ask. */
async function meWithoutAccount(env, email) {
  let request = null;
  try {
    const r = await latestAccessRequest(env, email);
    if (r) request = { status: r.status, ts: r.ts };
  } catch { /* the table may not be migrated yet */ }
  return json({
    email: null, role: 'guest', is_owner: false, alarm: null, refresh: null,
    verified_no_account: true, access_request: request,
  });
}

async function requestAccess(env, email) {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'the verified address is not a valid address');
  if (email === ownerEmail(env)) throw new HttpError(409, 'this account already has access');
  const user = await env.DB.prepare('SELECT active FROM users WHERE email = ?').bind(email).first();
  if (user && user.active) throw new HttpError(409, 'this account already has access');

  const open = await env.DB.prepare(
    `SELECT ${ACCESS_REQUEST_FIELDS} FROM access_requests WHERE email = ? AND status = 'requested' ORDER BY ts DESC LIMIT 1`
  ).bind(email).first();
  if (open) return json(open, 200);   // asked already: the same request

  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM access_requests WHERE email = ? AND ts > ?'
  ).bind(email, dayAgo).first();
  if (recent && recent.n >= ACCESS_REQUESTS_PER_DAY) throw new HttpError(429, 'too many access requests today', R.rateLimited);
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM access_requests WHERE status = 'requested'"
  ).first();
  if (waiting && waiting.n >= ACCESS_REQUESTS_OPEN_MAX) throw new HttpError(503, 'too many open access requests, try later');

  const row = { id: crypto.randomUUID(), email, ts: new Date().toISOString(), status: 'requested', decided_at: null, decided_by: null };
  await env.DB.prepare(
    "INSERT INTO access_requests (id, email, ts, status) VALUES (?, ?, ?, 'requested')"
  ).bind(row.id, row.email, row.ts).run();
  await audit(env, email, 'access_request', email, null);
  return json(row, 201);
}

async function listAccessRequests(env, url) {
  const status = url.searchParams.get('status');
  if (status && !['requested', 'approved', 'denied'].includes(status)) {
    throw new HttpError(400, "status must be 'requested', 'approved' or 'denied'");
  }
  const { results } = await (status
    ? env.DB.prepare(`SELECT ${ACCESS_REQUEST_FIELDS} FROM access_requests WHERE status = ? ORDER BY ts DESC LIMIT 500`).bind(status)
    : env.DB.prepare(`SELECT ${ACCESS_REQUEST_FIELDS} FROM access_requests ORDER BY ts DESC LIMIT 500`)
  ).all();
  return json(results);
}

async function decideAccessRequest(request, env, actor, id) {
  if (!ACCESS_REQUEST_ID_RE.test(id)) throw new HttpError(400, 'bad access request id');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  if (body.decision !== 'approve' && body.decision !== 'deny') throw new HttpError(400, "decision must be 'approve' or 'deny'");
  if (body.invite !== undefined && typeof body.invite !== 'boolean') throw new HttpError(400, 'invite must be true or false');
  const row = await env.DB.prepare(`SELECT ${ACCESS_REQUEST_FIELDS} FROM access_requests WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'no such access request');
  if (row.status !== 'requested') throw new HttpError(409, `already ${row.status}`);
  const status = body.decision === 'approve' ? 'approved' : 'denied';
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
    .bind(status, now, actor.email, id).run();
  await audit(env, actor.email, `access_${status}`, row.email, null);
  const decided = { ...row, status, decided_at: now, decided_by: actor.email };
  if (status === 'denied') return json({ request: decided, user: null });
  // The person proved the address when asking; they become a reader.
  const res = await grantAccess(env, actor, row.email, 'reader', body.invite);
  return json({ request: decided, user: await res.json() }, 200);
}

// ---------------------------------------------------------------------------
// Invitations (Version 3.3): queued here, mailed by the Mac
// ---------------------------------------------------------------------------
/** One open invite per person: an older pending one is replaced. */
async function queueInvite(env, actor, email, role) {
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE invites SET status = 'cancelled' WHERE email = ? AND status = 'pending'").bind(email).run();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO invites (id, email, role, requested_at, requested_by, status) VALUES (?, ?, ?, ?, ?, 'pending')"
  ).bind(id, email, role, now, actor.email).run();
  await audit(env, actor.email, 'invite', email, { role });
  // Mail it now rather than at the invitation job's next scheduled run.
  try {
    await dispatchWorkflow(env, 'invites.yml', {});
  } catch (err) {
    console.error('could not start the invitation job', err.message);
  }
  return id;
}

async function resendInvite(env, actor, email) {
  const row = await env.DB.prepare('SELECT role, active FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new HttpError(404, 'no such user');
  if (!row.active) throw new HttpError(409, 'reactivate the user before inviting them');
  const role = email === ownerEmail(env) ? 'admin' : row.role;
  await queueInvite(env, actor, email, role);
  return json(await userRow(env, email), 201);
}

/** For the Mac: invites still to send, for people who are still active. */
async function pendingInvites(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.email, u.role, i.requested_at, i.requested_by, i.attempts
     FROM invites i JOIN users u ON u.email = i.email
     WHERE i.status = 'pending' AND u.active = 1
     ORDER BY i.requested_at LIMIT 50`
  ).all();
  await setMeta(env, 'last_invite_pull_at', new Date().toISOString());
  return json(results);
}

async function reportInvite(request, env, id) {
  if (!INVITE_ID_RE.test(id)) throw new HttpError(400, 'bad invite id');
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  if (body.status !== 'sent' && body.status !== 'failed') throw new HttpError(400, "status must be 'sent' or 'failed'");
  const row = await env.DB.prepare('SELECT status, attempts, email FROM invites WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'no such invite');
  const now = new Date().toISOString();
  if (body.status === 'sent') {
    await env.DB.prepare("UPDATE invites SET status = 'sent', sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?")
      .bind(now, id).run();
  } else {
    const error = typeof body.error === 'string' ? body.error.slice(0, 300) : 'unknown error';
    const attempts = row.attempts + 1;
    // A temporary SMTP fault is retried on the next pull; after a few tries it stays failed.
    const status = attempts >= INVITE_MAX_ATTEMPTS ? 'failed' : 'pending';
    await env.DB.prepare('UPDATE invites SET status = ?, error = ?, attempts = ? WHERE id = ? AND status = ?')
      .bind(status, error, attempts, id, 'pending').run();
  }
  const r = await env.DB.prepare('SELECT id, email, status, sent_at, error, attempts FROM invites WHERE id = ?').bind(id).first();
  return json(r);
}

async function patchUser(request, env, actor, target) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  const change = {};
  if (body.role !== undefined) {
    if (body.role !== 'admin' && body.role !== 'reader') throw new HttpError(400, "role must be 'admin' or 'reader'");
    change.role = body.role;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be true or false');
    change.active = body.active;
  }
  if (!Object.keys(change).length) throw new HttpError(400, 'nothing to change: give role or active');
  return changeUser(env, actor, target, change);
}

/** Role change, deactivation or reactivation, with the safety rules. */
async function changeUser(env, actor, target, change) {
  const row = await env.DB.prepare('SELECT role, active FROM users WHERE email = ?').bind(target).first();
  if (!row) throw new HttpError(404, 'no such user');

  const losesAdmin = row.role === 'admin' && row.active
    && (change.role === 'reader' || change.active === false);
  if (target === ownerEmail(env) && losesAdmin) {
    throw new HttpError(409, 'the owner is always an admin and cannot be demoted or removed');
  }
  if (target === ownerEmail(env) && change.active === false) {
    throw new HttpError(409, 'the owner cannot be removed');
  }
  if (losesAdmin) {
    const others = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND email != ?"
    ).bind(target).first();
    if (!others || others.n === 0) {
      throw new HttpError(409, 'the last active admin cannot be demoted or removed');
    }
  }

  const role = change.role ?? row.role;
  const active = change.active === undefined ? !!row.active : change.active;
  if (role === row.role && active === !!row.active) return json(await userRow(env, target), 200);

  await env.DB.prepare('UPDATE users SET role = ?, active = ? WHERE email = ?')
    .bind(role, active ? 1 : 0, target).run();
  if (!active) {
    await env.DB.prepare("UPDATE invites SET status = 'cancelled' WHERE email = ? AND status = 'pending'").bind(target).run();
  }
  const action = !active ? 'deactivate' : (!row.active ? 'reactivate' : 'role');
  await audit(env, actor.email, action, target,
    { from: { role: row.role, active: !!row.active }, to: { role, active } });
  return json(await userRow(env, target), 200);
}

async function userRow(env, email) {
  const r = await env.DB.prepare(
    `SELECT u.email, u.role, u.active, u.created_at, u.created_by, u.last_seen,
            i.status AS invite_status, i.requested_at AS invite_requested_at,
            i.sent_at AS invite_sent_at, i.error AS invite_error
     FROM users u
     LEFT JOIN invites i ON i.id = (SELECT id FROM invites WHERE email = u.email ORDER BY requested_at DESC LIMIT 1)
     WHERE u.email = ?`
  ).bind(email).first();
  if (r) {
    r.active = !!r.active;
    r.is_owner = r.email === ownerEmail(env);
  }
  return r;
}

async function securityReport(env, url) {
  let days = Number(url.searchParams.get('days') || 7);
  if (!Number.isFinite(days) || days < 1) days = 7;
  days = Math.min(Math.floor(days), SECURITY_LOG_DAYS);
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const countSince = async (ms) => {
    const { results } = await env.DB.prepare(
      'SELECT reason, COUNT(*) AS n FROM security_log WHERE ts > ? GROUP BY reason'
    ).bind(iso(ms)).all();
    return Object.fromEntries(results.map((r) => [r.reason, r.n]));
  };
  const { results: rows } = await env.DB.prepare(
    'SELECT * FROM security_log WHERE ts > ? ORDER BY id DESC LIMIT 200'
  ).bind(iso(days * 86400000)).all();
  return json({
    counts: { '24h': await countSince(86400000), '7d': await countSince(7 * 86400000) },
    rows,
  });
}

async function status(env) {
  const reports = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(date) AS last_date, MAX(updated_at) AS last_uploaded,
            COALESCE(SUM(json_array_length(data, '$.events')), 0) AS events
     FROM reports`
  ).first();
  const assessments = await env.DB.prepare('SELECT COUNT(*) AS n FROM assessments').first();
  const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first();
  const lastUpdate = await env.DB.prepare('SELECT MAX(ts) AS ts FROM updates').first();
  const pull = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_machine_pull_at'").first();
  const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first();
  const lastPush = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_push'").first();
  const invites = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE status = 'pending'").first();
  const invitePull = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_invite_pull_at'").first();
  return json({
    alarm: await getAlarm(env),
    refresh: await getRefresh(env),
    invites: { pending: invites.n, last_pull_at: invitePull ? invitePull.value : null },
    push: { subscriptions: subs.n, last: lastPush ? JSON.parse(lastPush.value) : null },
    last_report_date: reports.last_date || null,
    last_report_uploaded_at: reports.last_uploaded || null,
    last_update_at: lastUpdate.ts || null,
    last_machine_pull_at: pull ? pull.value : null,
    counts: { reports: reports.n, events: reports.events, assessments: assessments.n, users: users.n },
    service_token_expires: env.SERVICE_TOKEN_EXPIRES || null,
    runs: await runsStatus(env, Date.now(), invites.n, invitePull ? invitePull.value : null),
  });
}

// ---------------------------------------------------------------------------
// Scheduled runs (Version 3.4)
// ---------------------------------------------------------------------------
async function ingestRun(request, env, id) {
  if (!RUN_ID_RE.test(id)) throw new HttpError(400, 'run id must be 32 hex characters');
  const b = await readJson(request);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'body must be a JSON object');
  if (!Object.hasOwn(RUN_JOBS, b.job)) throw new HttpError(400, `job must be one of ${Object.keys(RUN_JOBS).join(', ')}`);
  if (b.host !== 'mac' && b.host !== 'cloud') throw new HttpError(400, "host must be 'mac' or 'cloud'");
  // 'partial': it exited 0 but part of it fell (401, 429, 503 in its warnings).
  if (!['running', 'ok', 'partial', 'failed'].includes(b.status)) throw new HttpError(400, "status must be 'running', 'ok', 'partial' or 'failed'");
  if (typeof b.started_at !== 'string' || !TS_RE.test(b.started_at)) throw new HttpError(400, 'started_at must be ISO 8601');
  if (b.finished_at != null && (typeof b.finished_at !== 'string' || !TS_RE.test(b.finished_at))) {
    throw new HttpError(400, 'finished_at must be ISO 8601');
  }
  if (b.exit_code != null && !Number.isInteger(b.exit_code)) throw new HttpError(400, 'exit_code must be an integer');
  const warnings = b.warnings ?? [];
  if (!Array.isArray(warnings) || warnings.length > 50 || warnings.some((w) => typeof w !== 'string' || w.length > 500)) {
    throw new HttpError(400, 'warnings must be at most 50 strings of at most 500 characters');
  }
  if (b.log_url != null && (typeof b.log_url !== 'string' || !RUN_LOG_URL_RE.test(b.log_url))) {
    throw new HttpError(400, 'log_url must be a GitHub Actions run URL');
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runs (id, job, host, started_at, finished_at, status, exit_code, warnings, log_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         finished_at = excluded.finished_at, status = excluded.status,
         exit_code = excluded.exit_code, warnings = excluded.warnings, log_url = excluded.log_url`
    ).bind(id, b.job, b.host, new Date(b.started_at).toISOString(),
           b.finished_at ? new Date(b.finished_at).toISOString() : null,
           b.status, b.exit_code ?? null, JSON.stringify(warnings), b.log_url ?? null),
    env.DB.prepare('DELETE FROM runs WHERE started_at < ?')
      .bind(new Date(Date.now() - RUNS_KEEP_DAYS * 86400000).toISOString()),
  ]);
  return json({ ok: true });
}

/** The latest due time of a job at or before `nowMs`, from its Stockholm hours. */
function lastDueMs(hours, nowMs, minute = 0) {
  const { minutes } = stockholmClock(nowMs);
  const at = hours.map((h) => h * 60 + minute);
  const today = at.filter((m) => m <= minutes);
  const back = today.length ? minutes - Math.max(...today) : minutes + 24 * 60 - Math.max(...at);
  return nowMs - (nowMs % 60000) - back * 60000;
}

const stockholmHHMM = (ms) => new Date(ms).toLocaleTimeString('sv-SE', {
  timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit',
});

/**
 * Green, yellow or red per job: red when the last run failed, hangs, or the
 * due run has not started RUN_START_GRACE_MIN after its time; yellow when
 * it finished with warnings; otherwise green. Before the grace runs out a
 * job keeps the light of its previous run.
 */
function runHealth(spec, last, nowMs) {
  if (!last) return { light: 'yellow', text: 'Ingen körning rapporterad än' };
  const due = lastDueMs(spec.hours, nowMs, spec.minute || 0);
  if (last.status === 'running') {
    const mins = Math.round((nowMs - Date.parse(last.started_at)) / 60000);
    return mins > spec.maxMinutes * 2
      ? { light: 'red', text: `Har kört i ${mins} min – har den hängt sig?` }
      : { light: 'green', text: `Kör nu, startade ${stockholmHHMM(Date.parse(last.started_at))}` };
  }
  // Ten minutes' slack: launchd starts on the dot, a manual run a bit early.
  const ranSinceDue = Date.parse(last.started_at) >= due - 10 * 60000;
  if (!ranSinceDue) {
    if ((nowMs - due) / 60000 > RUN_START_GRACE_MIN) {
      return { light: 'red', text: `Körningen ${stockholmHHMM(due)} har inte startat` };
    }
    const prev = runHealth(spec, last, Date.parse(last.started_at) + 60000);
    return { light: prev.light, text: `Väntar på körningen ${stockholmHHMM(due)}` };
  }
  const warnings = JSON.parse(last.warnings || '[]');
  if (last.status === 'failed') return { light: 'red', text: `Misslyckades (kod ${last.exit_code ?? '?'})` };
  if (last.status === 'partial') return { light: 'yellow', text: 'Klar, men en del föll' };
  if (warnings.length) return { light: 'yellow', text: `Klar med ${warnings.length === 1 ? '1 varning' : `${warnings.length} varningar`}` };
  return { light: 'green', text: 'Klar utan fel' };
}

async function runsStatus(env, nowMs, pendingInvites, invitePullAt) {
  const { results } = await env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 30').all();
  const recent = results.map((r) => ({ ...r, warnings: JSON.parse(r.warnings || '[]') }));
  const jobs = Object.entries(RUN_JOBS).map(([job, spec]) => {
    const last = results.find((r) => r.job === job) || null;
    return {
      job, label: spec.label,
      due: spec.hours.map((h) => `${String(h).padStart(2, '0')}:${String(spec.minute || 0).padStart(2, '0')}`),
      ...runHealth(spec, last, nowMs),
      last: last ? recent.find((r) => r.id === last.id) : null,
    };
  });
  // The invitation job (still `mac` in the API); red only when an invite waits.
  const quietMin = invitePullAt ? Math.round((nowMs - Date.parse(invitePullAt)) / 60000) : null;
  const macUp = quietMin != null && quietMin <= MAC_QUIET_MIN;
  const mac = macUp
    ? { light: 'green', text: 'Igång – skickar inbjudningar' }
    : pendingInvites && (quietMin == null || quietMin > 2 * MAC_QUIET_MIN)
      ? { light: 'red', text: `Svarar inte – ${pendingInvites === 1 ? '1 inbjudan väntar' : `${pendingInvites} inbjudningar väntar`}` }
      : { light: 'yellow', text: 'Inte hörd på över en timme' };
  return {
    runner: recent.length ? recent[0].host : null,
    jobs,
    mac: { ...mac, last_seen_at: invitePullAt },
    recent,
  };
}

// ---------------------------------------------------------------------------
// Trends (Version 3.9): a feed of its own, read by nothing else here
// ---------------------------------------------------------------------------
const TREND_SIDES = new Set(['open', 'ru']);
const TREND_SOURCES = new Set(['wikipedia', 'google_trends', 'reddit', 'mastodon', 'bluesky', 'telegram']);
const TREND_KEEP_DAYS = 30;
const TREND_SHOW_DAYS = 3;

async function ingestTrends(request, env) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) throw new HttpError(400, 'body must be { items, summaries, sources }');
  if (body.items.length > 500) throw new HttpError(400, 'at most 500 trends per request');
  const str = (v, max) => (v === undefined || v === null ? null
    : (typeof v === 'string' && v.length <= max ? v : undefined));
  const num = (v) => (v === undefined || v === null ? null : (typeof v === 'number' && Number.isFinite(v) ? v : undefined));
  const stmts = [];
  for (const t of body.items) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, 'each trend must be an object');
    if (typeof t.id !== 'string' || !ITEM_ID_RE.test(t.id)) throw new HttpError(400, 'trend id must be 1-128 of letters, digits, _ . : -');
    if (!TREND_SIDES.has(t.side)) throw new HttpError(400, `trend ${t.id}: side must be open or ru`);
    if (!TREND_SOURCES.has(t.source)) throw new HttpError(400, `trend ${t.id}: unknown source`);
    for (const k of ['first_seen', 'last_seen']) {
      if (typeof t[k] !== 'string' || !TS_RE.test(t[k])) throw new HttpError(400, `trend ${t.id}: ${k} must be ISO 8601`);
    }
    const f = {
      place: str(t.where, 200), title: str(t.title, 1000), title_sv: str(t.title_sv, 1000), summary_sv: str(t.summary_sv, 2000), url: str(t.url, 2000),
      detail: str(t.detail, 4000), metric_sv: str(t.metric_sv, 300), published: str(t.published, 40),
      thread_id: str(t.thread_id, 200), metric: num(t.metric), spike: num(t.spike),
    };
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) throw new HttpError(400, `trend ${t.id}: ${k} has the wrong type or length`);
    }
    if (!f.title) throw new HttpError(400, `trend ${t.id}: title is required`);
    if (f.url && !/^https:\/\//.test(f.url)) throw new HttpError(400, `trend ${t.id}: url must be https`);
    stmts.push(env.DB.prepare(
      `INSERT INTO trends (id, side, source, place, title, title_sv, summary_sv, url, detail, metric, spike, metric_sv, published, thread_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         place = excluded.place, title = excluded.title, title_sv = COALESCE(excluded.title_sv, trends.title_sv),
         summary_sv = COALESCE(excluded.summary_sv, trends.summary_sv),
         url = excluded.url, detail = excluded.detail, metric = excluded.metric, spike = excluded.spike,
         metric_sv = excluded.metric_sv, published = excluded.published, thread_id = excluded.thread_id,
         last_seen = excluded.last_seen`
    ).bind(t.id, t.side, t.source, f.place, f.title, f.title_sv, f.summary_sv, f.url, f.detail, f.metric, f.spike,
           f.metric_sv, f.published, f.thread_id, t.first_seen, t.last_seen));
  }
  for (const s of Array.isArray(body.summaries) ? body.summaries : []) {
    if (!s || !DATE_RE.test(s.date || '')) throw new HttpError(400, 'each summary needs a date');
    const open = str(s.open_sv, 5000); const ru = str(s.ru_sv, 5000);
    if (open === undefined || ru === undefined) throw new HttpError(400, `summary ${s.date}: open_sv and ru_sv must be strings`);
    stmts.push(env.DB.prepare(
      'INSERT INTO trend_summaries (date, open_sv, ru_sv) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET open_sv = excluded.open_sv, ru_sv = excluded.ru_sv'
    ).bind(s.date, open, ru));
  }
  // Posts the run judged off the subject (2 Nov): taken out, not just left to age.
  const remove = Array.isArray(body.remove) ? body.remove.filter((id) => typeof id === 'string' && ITEM_ID_RE.test(id)).slice(0, 500) : [];
  for (const id of remove) stmts.push(env.DB.prepare('DELETE FROM trends WHERE id = ?').bind(id));
  const cutoff = new Date(Date.now() - TREND_KEEP_DAYS * 86400000).toISOString();
  stmts.push(env.DB.prepare('DELETE FROM trends WHERE last_seen < ?').bind(cutoff));
  stmts.push(env.DB.prepare('DELETE FROM trend_summaries WHERE date < ?').bind(cutoff.slice(0, 10)));
  await env.DB.batch(stmts);
  if (body.sources && typeof body.sources === 'object') {
    await setMeta(env, 'trend_sources', JSON.stringify(body.sources).slice(0, 4000));
  }
  return json({ ok: true, count: body.items.length });
}

// ---------------------------------------------------------------------------
// Russia's courses of action (Version 3.11)
// ---------------------------------------------------------------------------
const COURSE_IDS = ['troligast', 'mojligt', 'farligast'];
const COURSE_LEVELS = new Set(['låg', 'måttlig', 'hög']);
const SIGN_STATUSES = new Set(['inte observerat', 'delvis', 'observerat']);

async function ingestCourses(request, env) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object' || !DATE_RE.test(b.date || '')) throw new HttpError(400, 'body must be an assessment with a date');
  if (!Array.isArray(b.courses) || b.courses.map((c) => c && c.id).join() !== COURSE_IDS.join()) {
    throw new HttpError(400, `courses must be ${COURSE_IDS.join(', ')}, in that order`);
  }
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  for (const c of b.courses) {
    if (!str(c.title, 300) || !Array.isArray(c.text) || c.text.length > 5 || !c.text.every((t) => str(t, 600))) throw new HttpError(400, `${c.id}: title and text (at most 5 sentences)`);
    if (!COURSE_LEVELS.has(c.likelihood)) throw new HttpError(400, `${c.id}: likelihood must be låg, måttlig or hög`);
    if (!Array.isArray(c.signs) || c.signs.length > 10 || !c.signs.every((sg) => sg && str(sg.text, 300) && SIGN_STATUSES.has(sg.status))) throw new HttpError(400, `${c.id}: signs`);
    if (!Array.isArray(c.arrows) || c.arrows.length > 10 || !Array.isArray(c.marks) || c.marks.length > 10) throw new HttpError(400, `${c.id}: arrows and marks`);
  }
  if (!Array.isArray(b.history) || b.history.length > 90) throw new HttpError(400, 'history must be an array');
  const data = JSON.stringify(b);
  if (data.length > 200000) throw new HttpError(413, 'assessment too large');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO course_assessments (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data').bind(b.date, data),
    env.DB.prepare("DELETE FROM course_assessments WHERE date < date('now', '-120 days')"),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The forces map (Version 3.12)
// ---------------------------------------------------------------------------
const FORCE_BRANCHES = new Set(['flyg', 'marin', 'armé', 'luftvärn', 'robot', 'fallskärm']);
const FORCE_STATUSES = new Set(['anfallen', 'aktiv', 'okänd']);

async function ingestStrikes(request, env) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object' || !DATE_RE.test(b.date || '')) throw new HttpError(400, 'body must be a strike map with a date');
  if (!Array.isArray(b.days) || b.days.length > 60) throw new HttpError(400, 'days must be an array of at most 60');
  const place = (p) => p && typeof p.lat === 'number' && typeof p.lon === 'number' && typeof p.name === 'string' && p.name.length <= 200;
  for (const d of b.days) {
    if (!d || !DATE_RE.test(d.date || '') || !Array.isArray(d.rows) || d.rows.length > 100) throw new HttpError(400, 'each day needs a date and rows');
    for (const r of d.rows) {
      if (!r || typeof r.model !== 'string' || r.model.length > 200) throw new HttpError(400, `${d.date}: each row needs a model`);
      if (!Array.isArray(r.from) || !Array.isArray(r.to) || !r.from.every(place) || !r.to.every(place)) throw new HttpError(400, `${d.date}: from and to must be places`);
    }
  }
  const data = JSON.stringify(b);
  if (data.length > MAX_BODY_BYTES) throw new HttpError(413, 'strike map too large');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO strike_maps (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data').bind(b.date, data),
    env.DB.prepare("DELETE FROM strike_maps WHERE date < date('now', '-14 days')"),
  ]);
  return json({ ok: true });
}

async function ingestForces(request, env) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object' || !DATE_RE.test(b.date || '')) throw new HttpError(400, 'body must be a forces map with a date');
  if (!Array.isArray(b.bases) || !b.bases.length || b.bases.length > 2000) throw new HttpError(400, 'bases must be an array of at most 2000');
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  const strs = (a) => Array.isArray(a) && a.length <= 60 && a.every((t) => str(t, 200));
  for (const x of b.bases) {
    if (!x || !ITEM_ID_RE.test(x.id || '') || !str(x.name, 300)) throw new HttpError(400, 'each base needs an id and a name');
    if (typeof x.lat !== 'number' || typeof x.lon !== 'number') throw new HttpError(400, `${x.id}: lat and lon`);
    if (!FORCE_BRANCHES.has(x.branch) || !FORCE_STATUSES.has(x.status)) throw new HttpError(400, `${x.id}: branch and status`);
    if (!strs(x.units) || !strs(x.equipment)) throw new HttpError(400, `${x.id}: units and equipment`);
    if (!Array.isArray(x.events) || !Array.isArray(x.changes)) throw new HttpError(400, `${x.id}: events and changes`);
    for (const e of [...x.events, ...x.changes]) {
      if (!e || !DATE_RE.test(e.date || '') || !str(e.text_sv, 1000)) throw new HttpError(400, `${x.id}: each entry needs a date and text_sv`);
      if (e.sources != null && (!Array.isArray(e.sources) || !e.sources.every((s) => s && str(s.url, 2000) && /^https?:\/\//.test(s.url)))) {
        throw new HttpError(400, `${x.id}: sources must be http(s) links`);
      }
    }
  }
  if (!Array.isArray(b.nights) || b.nights.length > 60) throw new HttpError(400, 'nights must be an array');
  const data = JSON.stringify(b);
  if (data.length > MAX_BODY_BYTES) throw new HttpError(413, 'forces map too large');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO force_maps (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data').bind(b.date, data),
    env.DB.prepare("DELETE FROM force_maps WHERE date < date('now', '-30 days')"),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The Swedish authorities' brief (Version 3.10), read by nothing else here
// ---------------------------------------------------------------------------
const AUTHORITIES = new Set(['Försvarsmakten', 'MUST', 'MCF', 'Regeringen', 'Polisen', 'Säpo', 'Tullverket', 'Kustbevakningen']);
const NATO_TOPICS = new Set(['Generalsekreteraren', 'Militära kommandon', 'Östersjön och östflanken', 'Ukraina', 'EU och partner', 'Övrigt']);
const AUTHORITY_BRIEFS_KEEP = 60;

async function ingestAuthorities(request, env) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'body must be a brief object');
  if (typeof b.generated_at !== 'string' || !TS_RE.test(b.generated_at)) throw new HttpError(400, 'generated_at must be ISO 8601');
  if (typeof b.overall_sv !== 'string' || b.overall_sv.length > 3000) throw new HttpError(400, 'overall_sv must be a string');
  if (!Array.isArray(b.items) || b.items.length > 40) throw new HttpError(400, 'items must be an array of at most 40');
  const item = (known) => (it) => {
    if (!it || !known.has(it.agency)) throw new HttpError(400, 'each item needs a known agency or topic');
    if (typeof it.text_sv !== 'string' || it.text_sv.length > 1000) throw new HttpError(400, `${it.agency}: text_sv must be a string`);
    if (it.url != null && (typeof it.url !== 'string' || !/^https:\/\//.test(it.url) || it.url.length > 2000)) throw new HttpError(400, `${it.agency}: url must be https`);
    if (it.via != null && (typeof it.via !== 'string' || it.via.length > 300)) throw new HttpError(400, `${it.agency}: via must be a string`);
    if (typeof it.date !== 'string' || !DATE_RE.test(it.date)) throw new HttpError(400, `${it.agency}: date must be YYYY-MM-DD`);
    return { agency: it.agency, text_sv: it.text_sv, via: it.via ?? null, url: it.url ?? null, date: it.date, fresh: it.fresh === true };
  };
  const items = b.items.map(item(AUTHORITIES));
  const quiet = Array.isArray(b.quiet) ? b.quiet.filter((a) => AUTHORITIES.has(a)) : [];
  // NATO (1 Nov): its own brief in the same row; items carry a topic in `agency`.
  let nato = null;
  if (b.nato != null) {
    if (typeof b.nato !== 'object' || !Array.isArray(b.nato.items) || b.nato.items.length > 20) throw new HttpError(400, 'nato must be { overall_sv, items }');
    if (b.nato.overall_sv != null && (typeof b.nato.overall_sv !== 'string' || b.nato.overall_sv.length > 3000)) throw new HttpError(400, 'nato.overall_sv must be a string');
    nato = { overall_sv: b.nato.overall_sv ?? null, items: b.nato.items.map(item(NATO_TOPICS)) };
  }
  const data = JSON.stringify({ generated_at: b.generated_at, overall_sv: b.overall_sv, items, quiet, nato });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO authority_briefs (generated_at, data) VALUES (?, ?) ON CONFLICT(generated_at) DO UPDATE SET data = excluded.data')
      .bind(b.generated_at, data),
    env.DB.prepare(`DELETE FROM authority_briefs WHERE generated_at NOT IN
      (SELECT generated_at FROM authority_briefs ORDER BY generated_at DESC LIMIT ${AUTHORITY_BRIEFS_KEEP})`),
  ]);
  return json({ ok: true, items: items.length });
}

/** One side at a time: the app asks for 'ru' only when the reader chose to see it. */
async function listTrends(env, url, guest = false) {
  const side = url.searchParams.get('side') || 'open';
  if (!TREND_SIDES.has(side)) throw new HttpError(400, 'side must be open or ru');
  const since = new Date(Date.now() - TREND_SHOW_DAYS * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, source, place, title, title_sv, summary_sv, url, detail, metric, spike, metric_sv, published, thread_id, first_seen, last_seen
     FROM trends WHERE side = ? AND last_seen >= ? ORDER BY last_seen DESC, COALESCE(spike, 1) DESC LIMIT 200`
  ).bind(side, since).all();
  const col = side === 'ru' ? 'ru_sv' : 'open_sv';
  const sums = await env.DB.prepare(
    `SELECT date, ${col} AS text FROM trend_summaries WHERE ${col} IS NOT NULL ORDER BY date DESC LIMIT 7`
  ).all();
  const src = await env.DB.prepare("SELECT value FROM meta WHERE key = 'trend_sources'").first();
  // Guests get the Russian side only as our Swedish summaries: no Russian
  // headlines, quotes or links to the channels themselves.
  let items = results;
  if (guest && side === 'ru') {
    items = results.filter((r) => r.title_sv || r.summary_sv);
    for (const r of items) { r.title = null; r.detail = null; r.url = null; }
  }
  return json({ side, items, summaries: sums.results, sources: src ? JSON.parse(src.value) : null });
}

// ---------------------------------------------------------------------------
// Starting the runs (Version 3.8)
// ---------------------------------------------------------------------------
/** Starts a GitHub Actions workflow on main (workflow_dispatch). */
async function dispatchWorkflow(env, workflow, inputs) {
  if (!env.GITHUB_REPO || !env.GITHUB_DISPATCH_TOKEN) throw new Error('GITHUB_REPO or GITHUB_DISPATCH_TOKEN is not set');
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'hotmonitor-worker',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Starts the jobs due at this Stockholm hour. `at` lets run_job.py skip a
 * job that GitHub's own schedule, kept as the fallback, has already run;
 * that skip also makes a second start of the same run harmless. A start
 * that fails raises an admin alarm.
 */
async function startDueRuns(env, nowMs) {
  // Each start is a fetch too: leave room for them under the 50 subrequests.
  const budget = { left: PUSH_BATCH - Object.keys(RUN_JOBS).length };
  const { minutes } = stockholmClock(nowMs);
  const hour = Math.floor(minutes / 60);
  const half = minutes % 60 >= 30 ? 30 : 0;
  for (const [job, spec] of Object.entries(RUN_JOBS)) {
    if (!spec.hours.includes(hour) || (spec.minute || 0) !== half) continue;
    try {
      // scheduled-jobs.yml runs several jobs and takes `job`; trends.yml does not.
      const inputs = { test: 'false', at: String(hour) };
      if (spec.workflow === 'scheduled-jobs.yml') inputs.job = job;
      await dispatchWorkflow(env, spec.workflow, inputs);
    } catch (err) {
      console.error(`could not start ${job}`, err.message);
      await audit(env, 'system', 'alarm', null, { run_not_started: job, error: err.message });
      await pushTo(env, { adminsOnly: true, pref: 'alarm' }, {
        title: `${spec.label} kunde inte startas`,
        body: `Körningen ${String(hour).padStart(2, '0')}:${String(half).padStart(2, '0')} startade inte: ${err.message.slice(0, 120)}`,
        url: '/#/admin',
      }, 'high', budget);
    }
  }
}

async function audit(env, actor, action, target, detail) {
  await env.DB.prepare(
    'INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)'
  ).bind(new Date().toISOString(), actor, action, target, detail ? JSON.stringify(detail) : null).run();
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run();
}

// ---------------------------------------------------------------------------
// Missing-report alarm, home screen, Web Push, backup export (Version 3)
// ---------------------------------------------------------------------------
/** Stockholm local date and minutes past midnight at `ms` - DST-safe via Intl. */
function stockholmClock(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

async function getAlarm(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'alarm_missing_report'").first();
  return { missing_report: row && row.value ? row.value : null };
}

// Version 3.25: the morning report is started again when it has not come:
// at 05:30 and at 07:00 Stockholm time, at most twice a day, never while a
// run of it is still going. Gemini overloaded or out of quota is the usual
// cause, and it often passes within the hour.
const REPORT_RETRY_AT_MINUTES = [5 * 60 + 30, 7 * 60];
const RUN_STILL_GOING_MS = 50 * 60 * 1000;

async function retryMissingReport(env, nowMs) {
  const { date, minutes } = stockholmClock(nowMs);
  const due = REPORT_RETRY_AT_MINUTES.filter((m) => minutes >= m).length;   // 0, 1 or 2
  if (!due) return { retried: false, reason: 'too early' };
  const report = await env.DB.prepare('SELECT 1 AS ok FROM reports WHERE date = ?').bind(date).first();
  if (report) return { retried: false, reason: 'report here' };
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'report_retries'").first();
  let state = { date, n: 0 };
  try { if (row && row.value) { const v = JSON.parse(row.value); if (v.date === date) state = v; } } catch { /* start over */ }
  if (state.n >= due) return { retried: false, reason: 'already retried' };
  const running = await env.DB.prepare(
    "SELECT started_at FROM runs WHERE job = 'daily' AND status = 'running' AND started_at > ? ORDER BY started_at DESC LIMIT 1"
  ).bind(new Date(nowMs - RUN_STILL_GOING_MS).toISOString()).first();
  if (running) return { retried: false, reason: 'a run is still going' };
  state.n += 1;
  await setMeta(env, 'report_retries', JSON.stringify(state));
  try {
    // No `at`: run_job.py would skip a slot that has already started once.
    await dispatchWorkflow(env, RUN_JOBS.daily.workflow, { job: 'daily', test: 'false', at: '' });
    await audit(env, 'system', 'retry', null, { report_retry: date, attempt: state.n });
    return { retried: true, attempt: state.n };
  } catch (err) {
    console.error('report retry failed', err.message);
    await audit(env, 'system', 'alarm', null, { report_retry_failed: date, error: err.message });
    return { retried: false, reason: err.message };
  }
}

/** Past 07:00 Stockholm time with no report for today: raise the alarm once per date. */
async function checkMissingReport(env, nowMs, budget = newBudget()) {
  const { date, minutes } = stockholmClock(nowMs);
  if (minutes < ALARM_AFTER_MINUTES) return { checked: false, date };
  const report = await env.DB.prepare('SELECT 1 AS ok FROM reports WHERE date = ?').bind(date).first();
  if (report) return { checked: true, date, missing: false };
  const current = await getAlarm(env);
  if (current.missing_report === date) return { checked: true, date, missing: true, raised: false };
  await setMeta(env, 'alarm_missing_report', date);
  await audit(env, 'system', 'alarm', null, { missing_report: date });
  await pushTo(env, { adminsOnly: true, pref: 'alarm' }, {
    title: 'Dagens rapport har inte kommit',
    body: `Ingen morgonrapport för ${date} kl. 07:00. Den körs om automatiskt kl. 05:30 och 07:00. Se Systemstatus.`,
    url: '/#/admin',
  }, 'high', budget);
  return { checked: true, date, missing: true, raised: true };
}

async function recordDevice(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  if (typeof body.standalone !== 'boolean') throw new HttpError(400, 'standalone must be true or false');
  if (!['ios', 'android', 'desktop'].includes(body.platform)) throw new HttpError(400, "platform must be 'ios', 'android' or 'desktop'");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE users SET platform = ?,
       installed_at = CASE WHEN installed_at IS NULL AND ? = 1 THEN ? ELSE installed_at END
     WHERE email = ?`
  ).bind(body.platform, body.standalone ? 1 : 0, now, who.email).run();
  const row = await env.DB.prepare('SELECT installed_at, platform FROM users WHERE email = ?').bind(who.email).first();
  return json({ ok: true, installed_at: row ? row.installed_at : null, platform: row ? row.platform : body.platform });
}

/** A fake push server origin for local tests - honoured only with the dev auth bypass on. */
function devPushAllow(env) {
  return env.DEV_AUTH_EMAIL && env.DEV_PUSH_ALLOW ? env.DEV_PUSH_ALLOW : '';
}

// Version 3.23: a guest's subscription has email NULL; the endpoint, which
// only that browser knows, is the key. Guests get only the public pushes
// (reportPush: big index moves and events scored 9+), never notices from
// admins or alarms. A subscription may follow topics or countries: then
// event pushes reach it only when an event matches (empty = everything).
const MAX_GUEST_SUBSCRIPTIONS = 5000;
const GUEST_PREFS = new Set(['report']);
const PUSH_TOPICS = new Set(['Drönare', 'Sabotage', 'IT-hot', 'Skuggflotta', 'Sanktioner', 'Diplomati', 'Arktis', 'Desinformation', 'Kinetiskt']);
const COUNTRY_RE = /^[A-Z]{2}$/;

/** {topics, countries} from a body, validated; undefined when absent. */
function followFrom(body) {
  const out = {};
  for (const [k, max, ok] of [['topics', 9, (t) => PUSH_TOPICS.has(t)], ['countries', 40, (c) => COUNTRY_RE.test(c)]]) {
    if (body[k] === undefined) continue;
    const v = body[k] === null ? [] : body[k];
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !ok(x))) {
      throw new HttpError(400, k === 'topics' ? 'topics must be a list of the fixed TOPICS' : 'countries must be a list of ISO 3166-1 alpha-2 codes');
    }
    out[k] = [...new Set(v)];
  }
  return out;
}

async function subscribePush(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a PushSubscription object');
  const { endpoint, keys } = body;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !allowedEndpoint(endpoint, devPushAllow(env))) {
    throw new HttpError(400, 'endpoint must be an https URL of a known push service');
  }
  if (!keys || typeof keys !== 'object' || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new HttpError(400, 'keys.p256dh and keys.auth are required');
  }
  try {
    checkPoint(b64uDecode(keys.p256dh));
  } catch {
    throw new HttpError(400, 'keys.p256dh must be a 65-byte P-256 public key (base64url)');
  }
  let authLen = 0;
  try { authLen = b64uDecode(keys.auth).length; } catch { /* reported below */ }
  if (authLen !== 16) throw new HttpError(400, 'keys.auth must be 16 bytes (base64url)');

  let prefs = null;
  if (body.prefs !== undefined && body.prefs !== null) {
    const p = body.prefs;
    if (typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length > 10
        || Object.entries(p).some(([k, v]) => !/^[a-z_]{1,32}$/.test(k) || typeof v !== 'boolean')) {
      throw new HttpError(400, 'prefs must be an object of true/false flags');
    }
    // A guest's flags can only turn public pushes off; the rest mean nothing.
    prefs = JSON.stringify(who ? p : Object.fromEntries(Object.entries(p).filter(([k]) => GUEST_PREFS.has(k))));
  }
  const follow = followFrom(body);
  const email = who ? who.email : null;

  const existing = await env.DB.prepare('SELECT email FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first();
  if (!existing) {
    if (who) {
      const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE email = ?').bind(email).first();
      if (mine.n >= MAX_SUBSCRIPTIONS_PER_USER) throw new HttpError(400, `at most ${MAX_SUBSCRIPTIONS_PER_USER} devices per user`);
    } else {
      const guests = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE email IS NULL').first();
      if (guests && guests.n >= MAX_GUEST_SUBSCRIPTIONS) throw new HttpError(503, 'no room for more guest subscriptions right now');
    }
  }
  // The endpoint belongs to whoever is signed in on that device now (a guest: no one).
  const upsert = () => env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at, prefs, topics, countries)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh,
       auth = excluded.auth, prefs = excluded.prefs,
       topics = COALESCE(excluded.topics, push_subscriptions.topics),
       countries = COALESCE(excluded.countries, push_subscriptions.countries)`
  ).bind(endpoint, email, keys.p256dh, keys.auth, new Date().toISOString(), prefs,
    follow.topics ? JSON.stringify(follow.topics) : null,
    follow.countries ? JSON.stringify(follow.countries) : null).run();
  try {
    await upsert();
  } catch (err) {
    // Before migration 0015: a person's plain subscription still works.
    if (!who || follow.topics || follow.countries || !schemaMissing(err)) throw err;
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at, prefs)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh,
         auth = excluded.auth, prefs = excluded.prefs`
    ).bind(endpoint, email, keys.p256dh, keys.auth, new Date().toISOString(), prefs).run();
  }
  return json({ ok: true, guest: !who }, existing ? 200 : 201);
}

async function unsubscribePush(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || typeof body.endpoint !== 'string' || body.endpoint.length > 1024) {
    throw new HttpError(400, 'endpoint is required');
  }
  // Only your own devices; a guest only a guest subscription.
  const res = await (who
    ? env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?').bind(body.endpoint, who.email)
    : env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND email IS NULL').bind(body.endpoint)
  ).run();
  return json({ ok: true, removed: res.meta?.changes || 0 });
}

/** POST /api/push/prefs {endpoint, topics?, countries?}: what event pushes this device follows. */
async function pushFollow(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.endpoint !== 'string' || body.endpoint.length > 1024) {
    throw new HttpError(400, 'endpoint is required');
  }
  const follow = followFrom(body);
  if (!follow.topics && !follow.countries) throw new HttpError(400, 'give topics or countries (an empty list follows everything)');
  const row = await (who
    ? env.DB.prepare('SELECT topics, countries FROM push_subscriptions WHERE endpoint = ? AND email = ?').bind(body.endpoint, who.email)
    : env.DB.prepare('SELECT topics, countries FROM push_subscriptions WHERE endpoint = ? AND email IS NULL').bind(body.endpoint)
  ).first();
  if (!row) throw new HttpError(404, 'no such subscription on this device');
  const parse = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const topics = follow.topics ?? parse(row.topics);
  const countries = follow.countries ?? parse(row.countries);
  await env.DB.prepare('UPDATE push_subscriptions SET topics = ?, countries = ? WHERE endpoint = ?')
    .bind(JSON.stringify(topics), JSON.stringify(countries), body.endpoint).run();
  return json({ ok: true, topics, countries });
}

/** Does a subscription following topics/countries want a push about these events? */
function followsMatch(sub, match) {
  if (!match) return true;   // not an event push: everyone
  const parse = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const topics = parse(sub.topics);
  const countries = parse(sub.countries);
  if (!topics.length && !countries.length) return true;
  return topics.some((t) => match.topics.includes(t)) || countries.some((c) => match.countries.includes(c));
}

const svNum = (v) => v.toFixed(1).replace('.', ',');

/**
 * A push for a newly ingested report when (a) the general index moved
 * 0.5 or more from the previous report, or (b) it has events scored 9+
 * not pushed before. Only for today's or yesterday's Stockholm date, so
 * re-uploading old reports never notifies anyone.
 */
async function reportPush(env, body, date) {
  const today = stockholmClock(Date.now()).date;
  const yesterday = stockholmClock(Date.parse(`${today}T12:00:00Z`) - 86400000).date;
  if (date !== today && date !== yesterday) return { sent: 0, reason: 'old report' };

  const key = `push_sent:${date}`;
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  const sent = row ? JSON.parse(row.value) : { index: false, events: [] };

  const idx = typeof body.threat_index === 'number' ? body.threat_index : null;
  const prev = await env.DB.prepare(
    'SELECT threat_index FROM reports WHERE date < ? AND threat_index IS NOT NULL ORDER BY date DESC LIMIT 1'
  ).bind(date).first();
  const delta = idx !== null && prev ? Math.round((idx - prev.threat_index) * 10) / 10 : 0;
  const indexTrigger = !sent.index && Math.abs(delta) >= INDEX_PUSH_DELTA;

  const events = Array.isArray(body.events) ? body.events : [];
  const high = events.filter((e) => e && typeof e.id === 'string' && typeof e.score === 'number'
    && e.score >= HIGH_SCORE && !sent.events.includes(e.id));
  if (!indexTrigger && !high.length) return { sent: 0, reason: 'nothing notable' };

  // Recorded before sending, so a quick re-upload cannot notify twice.
  await setMeta(env, key, JSON.stringify({
    index: sent.index || indexTrigger, events: [...sent.events, ...high.map((e) => e.id)],
  }));

  const top = (body.executive_sv && body.executive_sv.top) || body.top_development || '';
  const eventTitle = (e) => String(e.title_sv || e.title || '').slice(0, 160);
  let payload;
  if (indexTrigger) {
    const more = high.length ? ` · ${high.length} ${high.length === 1 ? 'händelse' : 'händelser'} med poäng 9–10` : '';
    payload = {
      title: `Hotindex ${svNum(idx)} (${delta > 0 ? '+' : '−'}${svNum(Math.abs(delta))})`,
      body: `${String(top).slice(0, 170)}${more}`,
      url: '/#/',
    };
  } else if (high.length === 1) {
    payload = { title: `Ny händelse ${high[0].score}/10`, body: eventTitle(high[0]), url: `/#/handelse/${date}/${high[0].id}` };
  } else {
    payload = { title: `${high.length} nya händelser med poäng 9–10`, body: eventTitle(high[0]), url: '/#/' };
  }
  // An index move is for everyone; an event push only for those following
  // its topics or countries (or nothing in particular). Guests get both.
  const match = indexTrigger ? null : {
    topics: [...new Set(high.flatMap((e) => (Array.isArray(e.topics) ? e.topics : [])))],
    countries: [...new Set(high.flatMap((e) => (Array.isArray(e.countries) ? e.countries : [])))],
  };
  return pushTo(env, { adminsOnly: false, pref: 'report', guests: true, match }, payload, indexTrigger ? 'high' : 'normal');
}

function inQuietHours(ms) {
  const { minutes } = stockholmClock(ms);
  return minutes >= QUIET_FROM_MINUTES || minutes < QUIET_UNTIL_MINUTES;
}

async function getDeferred(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'push_deferred'").first();
  return row && row.value ? JSON.parse(row.value) : [];
}

/** Sends the pushes held over quiet hours, once they have ended. */
async function flushDeferredPushes(env, nowMs, budget = newBudget()) {
  if (inQuietHours(nowMs)) return { sent: 0, reason: 'quiet hours' };
  const held = await getDeferred(env);
  if (!held.length) return { sent: 0 };
  // Cleared before sending, so an overlapping cron cannot send twice.
  await env.DB.prepare("DELETE FROM meta WHERE key = 'push_deferred'").run();
  let sent = 0;
  for (const p of held) {
    const r = await pushTo(env, p.target, p.payload, p.urgency, budget);
    sent += r.sent || 0;
  }
  await audit(env, 'system', 'push_deferred_sent', null, { pushes: held.length, sent });
  return { sent };
}

// Version 3.22: one fetch per subscription, and the free plan allows 50
// subrequests per invocation. So a push is queued (meta 'push_queue', the
// matching endpoints) and sent PUSH_BATCH at a time: the first batch at
// once, the rest by PUSH_QUEUE_CRON, every ten minutes. `budget` is shared
// by every push of one invocation, so together they stay under the limit.
const PUSH_BATCH = 40;
const PUSH_QUEUE_CRON = '*/10 * * * *';
const PUSH_QUEUE_MAX_JOBS = 20;
const newBudget = () => ({ left: PUSH_BATCH });

async function getPushQueue(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'push_queue'").first();
  if (!row || !row.value) return [];
  try { const q = JSON.parse(row.value); return Array.isArray(q) ? q : []; } catch { return []; }
}

/** Queues a push for every matching subscription and sends the first batch.
 *  During quiet hours the push is held until 07:00 instead. */
async function pushTo(env, { adminsOnly, pref, guests = false, match = null }, payload, urgency = 'normal', budget = newBudget()) {
  if (inQuietHours(Date.now())) {
    const held = await getDeferred(env);
    held.push({ target: { adminsOnly, pref, guests, match }, payload, urgency });
    await setMeta(env, 'push_deferred', JSON.stringify(held.slice(-20)));
    return { sent: 0, deferred: true, reason: 'quiet hours' };
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('push skipped: VAPID keys not configured');
    return { sent: 0, reason: 'not configured' };
  }
  const owner = ownerEmail(env);
  const select = (cols) => env.DB.prepare(
    adminsOnly
      ? `SELECT ${cols} FROM push_subscriptions p LEFT JOIN users u ON u.email = p.email
         WHERE p.email = ? OR (u.role = 'admin' AND u.active = 1)`
      : `SELECT ${cols} FROM push_subscriptions p LEFT JOIN users u ON u.email = p.email
         WHERE p.email = ? OR u.active = 1${guests && !adminsOnly ? ' OR p.email IS NULL' : ''}`
  ).bind(owner).all();
  let results;
  try {
    ({ results } = await select('p.endpoint, p.prefs, p.topics, p.countries'));
  } catch (err) {
    // Before migration 0015 (no topics/countries, no guests): push as before.
    if (!schemaMissing(err)) throw err;
    console.error('push without migration 0015:', err.message);
    ({ results } = await select('p.endpoint, p.prefs'));
  }
  const devAllow = devPushAllow(env);
  const endpoints = [];
  for (const s of results) {
    let prefs = {};
    try { prefs = s.prefs ? JSON.parse(s.prefs) : {}; } catch { prefs = {}; }
    if (pref && prefs[pref] === false) continue;
    if (!followsMatch(s, match)) continue;
    // Stored endpoints were checked on subscribe; checked again before any request.
    if (!allowedEndpoint(s.endpoint, devAllow)) continue;
    endpoints.push(s.endpoint);
  }
  if (!endpoints.length) {
    const summary = { at: new Date().toISOString(), title: payload.title, sent: 0, failed: 0, removed: 0, queued: 0 };
    await setMeta(env, 'last_push', JSON.stringify(summary));
    return summary;
  }
  const queue = await getPushQueue(env);
  queue.push({ id: crypto.randomUUID(), at: new Date().toISOString(), payload, urgency, endpoints, sent: 0, failed: 0, removed: 0 });
  await setMeta(env, 'push_queue', JSON.stringify(queue.slice(-PUSH_QUEUE_MAX_JOBS)));
  return drainPushQueue(env, budget);
}

/** Sends up to budget.left queued messages, oldest push first; dead
 *  subscriptions (404/410) are deleted. */
async function drainPushQueue(env, budget = newBudget()) {
  if (inQuietHours(Date.now())) return { sent: 0, reason: 'quiet hours' };
  if (budget.left <= 0) return { sent: 0, reason: 'no budget left' };
  const queue = await getPushQueue(env);
  if (!queue.length) return { sent: 0, queued: 0 };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0, reason: 'not configured' };

  // Claimed (and written back) before sending, so an overlapping run cannot send twice.
  const batch = [];
  for (const job of queue) {
    while (job.endpoints.length && batch.length < budget.left) batch.push({ job, endpoint: job.endpoints.shift() });
  }
  budget.left -= batch.length;
  await setMeta(env, 'push_queue', JSON.stringify(queue.filter((j) => j.endpoints.length)));

  const subs = new Map();
  const list = batch.map((b) => b.endpoint);
  for (let i = 0; i < list.length; i += 40) {
    const part = list.slice(i, i + 40);
    const { results } = await env.DB.prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint IN (${part.map(() => '?').join(', ')})`
    ).bind(...part).all();
    for (const r of results) subs.set(r.endpoint, r);
  }

  const owner = ownerEmail(env);
  const vapid = { subject: `mailto:${owner}`, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const done = new Map();   // job id -> { sent, failed, removed }
  let sent = 0, failed = 0, removed = 0;
  for (const { job, endpoint } of batch) {
    const c = done.get(job.id) || { sent: 0, failed: 0, removed: 0 };
    done.set(job.id, c);
    const s = subs.get(endpoint);
    if (!s) continue;   // unsubscribed since it was queued
    try {
      const r = await sendPush({ endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, job.payload, vapid, { urgency: job.urgency });
      if (r.ok) { sent++; c.sent++; } else {
        failed++; c.failed++;
        if (r.gone) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
          removed++; c.removed++;
        }
      }
    } catch (err) {
      failed++; c.failed++;
      console.error('push send failed', err && err.message);
    }
  }

  // Running totals onto the jobs still queued; the last one touched is the summary.
  const rest = await getPushQueue(env);
  let summary = null;
  for (const job of batch.length ? [...new Set(batch.map((b) => b.job))] : []) {
    const c = done.get(job.id);
    const left = rest.find((j) => j.id === job.id);
    const total = { sent: job.sent + c.sent, failed: job.failed + c.failed, removed: job.removed + c.removed };
    if (left) Object.assign(left, total);
    summary = { at: new Date().toISOString(), title: job.payload && job.payload.title, ...total, queued: left ? left.endpoints.length : 0 };
  }
  if (rest.length) await setMeta(env, 'push_queue', JSON.stringify(rest));
  if (summary) await setMeta(env, 'last_push', JSON.stringify(summary));
  const queued = rest.reduce((n, j) => n + j.endpoints.length, 0);
  return { sent, failed, removed, queued };
}

// ---------------------------------------------------------------------------
// Notices (Version 3.2)
// ---------------------------------------------------------------------------
const NOTICE_URL_RE = /^(#\/|\/(?!\/))[A-Za-z0-9\-._~%\/?#&=+]*$/;

async function createNotice(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
  const text = (v, max, name) => {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max) {
      throw new HttpError(400, `${name} must be 1-${max} characters`);
    }
    return v.trim();
  };
  const title = text(body.title, 80, 'title');
  const msg = text(body.body, 500, 'body');
  let url = null;
  if (body.url !== undefined && body.url !== null && body.url !== '') {
    if (typeof body.url !== 'string' || body.url.length > 200 || !NOTICE_URL_RE.test(body.url)) {
      throw new HttpError(400, 'url must be a same-origin path starting with #/ or /');
    }
    url = body.url;
  }
  if (body.push !== undefined && typeof body.push !== 'boolean') throw new HttpError(400, 'push must be a boolean');
  const days = body.expires_days === undefined ? 7 : body.expires_days;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, 'expires_days must be 1-30');

  const now = Date.now();
  const notice = {
    id: crypto.randomUUID(), ts: new Date(now).toISOString(), author: who.email,
    title, body: msg, url, expires_at: new Date(now + days * 86400000).toISOString(),
  };
  await env.DB.prepare(
    'INSERT INTO notices (id, ts, author, title, body, url, active, expires_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).bind(notice.id, notice.ts, notice.author, title, msg, url, notice.expires_at).run();
  await audit(env, who.email, 'notice', notice.id, { title, push: !!body.push, expires_days: days });

  let pushed = 0, failed = 0;
  if (body.push) {
    const target = url ? (url.startsWith('#') ? `/${url}` : url) : '/#/';
    const r = await pushTo(env, { adminsOnly: false, pref: 'notice' }, { title, body: msg, url: target });
    pushed = r.sent || 0;
    failed = r.failed || 0;
  }
  return json({ notice, pushed, failed }, 201);
}

async function removeNotice(env, who, id) {
  const row = await env.DB.prepare('SELECT id, active FROM notices WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'no such notice');
  await env.DB.prepare('UPDATE notices SET active = 0 WHERE id = ?').bind(id).run();
  await audit(env, who.email, 'notice_removed', id, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Sources added in the app (Version 3.5)
// ---------------------------------------------------------------------------
const SOURCE_KINDS = ['auto', 'rss', 'article'];
// Version 3.16: never a source for the analysis - Telegram and Russian state
// media (TASS, RT, RIA Novosti, Sputnik, Izvestia, Zvezda, Rossiyskaya
// Gazeta). A host matches itself and its subdomains.
// The same list as src/blocklist.py (keep them in step): Telegram, Russian
// state media and the pro-Kremlin network around them. A host matches itself
// and its subdomains; a page or feed title is matched as a whole name.
const BLOCKED_SOURCE_HOSTS = [
  // Telegram
  't.me', 'telegram.me', 'telegram.org', 'telegra.ph', 'telesco.pe',
  // State agencies, TV and papers
  'tass.ru', 'tass.com', 'rt.com', 'ria.ru', 'sputniknews.com', 'sputniknews.ru', 'sputnikglobe.com',
  'sputnik.by', 'sputnik.kz', 'sputniknews.cn', 'iz.ru', 'tvzvezda.ru', 'rg.ru', '1tv.ru', '1tv.com',
  'vesti.ru', 'smotrim.ru', 'ren.tv', 'ntv.ru',
  // Pro-Kremlin outlets
  'lenta.ru', 'gazeta.ru', 'kp.ru', 'aif.ru', 'ukraina.ru', 'kommersant.ru', 'kommersant.com',
  'interfax.ru', 'interfax.com', 'pravda.ru', 'news-front.info', 'news-front.su',
  'southfront.org', 'southfront.press', 'rubaltic.ru', 'baltnews.com', 'eadaily.com', 'regnum.ru',
  'inosmi.ru', 'rusvesna.su', 'tsargrad.tv', 'topwar.ru', 'reseauinternational.net',
  // The "Pravda" network (Portal Kombat)
  'news-pravda.com', 'pravda-en.com', 'pravda-fr.com', 'pravda-de.com', 'pravda-es.com', 'pravda-pl.com',
  'pravda-fi.com', 'pravda-se.com', 'pravda-nl.com', 'pravda-it.com', 'pravda-pt.com',
];
// pravda-xx.com for any language code, and their subdomains.
const PORTAL_KOMBAT_RE = /(^|\.)pravda-[a-z]{2,3}\.com$/;
// Never blocked although they look alike: Ukrainska Pravda, Interfax-Ukraine.
const ALLOWED_SOURCE_HOSTS = ['pravda.com.ua', 'interfax.com.ua'];
const BLOCKED_OUTLET_RE = new RegExp('^(?:the\\s+)?(?:' + [
  'tass(?:\\s+news\\s+agency)?', 'тасс', 'itar[-\\s]tass',
  'rt(?:\\s+(?:news|international|en\\s+español|en\\s+espanol|france|deutsch|arabic|on\\s+rumble))?', 'russia\\s+today', 'rt\\.com',
  'ria(?:\\s+novosti)?', 'риа\\s+новости', 'ria\\.ru',
  'sputnik(?:\\s+(?:news|international|globe|india|africa|brasil|mundo))?', 'sputnikglobe(?:\\.com)?',
  'izvestia', 'известия', 'iz\\.ru', 'zvezda', 'tv\\s*zvezda', 'звезда',
  'rossiyskaya\\s+gazeta', 'российская\\s+газета', 'rg\\.ru',
  'channel\\s+one(?:\\s+russia)?', 'первый\\s+канал', 'vesti(?:\\.ru)?', 'вести', 'ntv\\.ru', 'ren\\s*tv',
  'lenta\\.ru', 'лента\\.ру', 'gazeta\\.ru', 'газета\\.ру',
  'komsomolskaya\\s+pravda', 'комсомольская\\s+правда', 'kp\\.ru',
  'argumenty\\s+i\\s+fakty', 'аргументы\\s+и\\s+факты', 'aif\\.ru',
  'ukraina\\.ru', 'украина\\.ру', 'kommersant(?:\\.ru)?', 'коммерсантъ?', 'interfax(?:\\.ru)?', 'интерфакс',
  'pravda\\.ru', 'pravda\\s+(?:en|fr|de|es|pl|fi|se|nl|it|pt)', 'news[-\\s]pravda(?:\\.com)?', 'portal\\s+kombat',
  'news\\s*front', 'news-front(?:\\.info)?',
  'south\\s*front', 'inosmi', 'eadaily', 'regnum', 'tsargrad', 'rubaltic', 'baltnews',
  'telegram', 't\\.me',
].join('|') + ')$', 'i');

function blockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h || ALLOWED_SOURCE_HOSTS.some((a) => h === a || h.endsWith(`.${a}`))) return false;
  return PORTAL_KOMBAT_RE.test(h) || BLOCKED_SOURCE_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
}
function blockedSource(href) {
  let host;
  try { host = new URL(href).hostname; } catch { return false; }
  return blockedHost(host);
}
/** A publisher's name (a feed or page title), or a bare domain. */
function blockedOutlet(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return false;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(n) && blockedHost(n)) return true;
  return BLOCKED_OUTLET_RE.test(n);
}
const BLOCKED_SOURCE_MSG = 'Telegram, rysk statsmedia och det prokremlska nätverket runt dem (bl.a. TASS, RT, RIA, Sputnik, Izvestija, Lenta.ru, Gazeta.ru, Kommersant, Interfax, News Front och Pravda-nätverket) tas inte emot som källor.';
const SOURCE_FETCH_MS = 8000;
const SOURCE_PEEK_BYTES = 200000;

async function listSources(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, kind, url, title, added_by, added_at FROM sources WHERE active = 1 ORDER BY added_at DESC'
  ).all();
  return json(results);
}

/** The start of a page, for telling a feed from an article. Never throws. */
async function peekUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Hotmonitor)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.8' },
      redirect: 'follow', signal: AbortSignal.timeout(SOURCE_FETCH_MS),
    });
    if (!res.ok) return { error: `svarade ${res.status}` };
    const reader = res.body.getReader();
    let text = '';
    const dec = new TextDecoder();
    while (text.length < SOURCE_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return { finalUrl: res.url || url, type: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { error: e && e.name === 'TimeoutError' ? 'svarade inte i tid' : 'gick inte att nå' };
  }
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/<!\[CDATA\[|\]\]>/g, '').trim();

function looksLikeFeed(peek) {
  return /(rss|atom)\+xml|\/xml|text\/xml/i.test(peek.type) && /<(rss|feed|rdf:RDF)[\s>]/i.test(peek.text)
    || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/i.test(peek.text);
}

function pageTitle(text) {
  const og = text.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const t = og || text.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  return t ? decodeEntities(t[1]).slice(0, 200) : null;
}

/** "russian-diesel-bound-for-new-york" from an article's address, as words. */
function slugTitle(url) {
  const seg = url.pathname.split('/').filter(Boolean)
    .map((x) => { try { return decodeURIComponent(x); } catch { return x; } })
    .map((x) => x.replace(/\.[a-z]{2,5}$/i, ''))
    .filter((x) => /[a-z].*[-_].*[a-z]/i.test(x)).pop();
  if (!seg) return null;
  const words = seg.replace(/[-_]+/g, ' ').trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 200);
}

/** The feed a site's front page announces (<link rel="alternate" type="application/rss+xml">). */
function announcedFeed(text, base) {
  for (const tag of text.match(/<link\b[^>]*>/gi) || []) {
    if (/rel=["']?alternate/i.test(tag) && /type=["']application\/(rss|atom)\+xml/i.test(tag)) {
      const href = tag.match(/href=["']([^"']+)["']/i);
      if (href) { try { return new URL(decodeEntities(href[1]), base).href; } catch { /* ignore */ } }
    }
  }
  return null;
}

async function addSource(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
  const kind = body.kind === undefined ? 'auto' : body.kind;
  if (!SOURCE_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${SOURCE_KINDS.join(', ')}`);
  let url;
  try {
    url = new URL(String(body.url || '').trim());
  } catch {
    throw new HttpError(400, 'Det där ser inte ut som en webbadress.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.href.length > 1000) {
    throw new HttpError(400, 'Adressen måste börja med http:// eller https://.');
  }
  if (blockedSource(url.href)) throw new HttpError(422, BLOCKED_SOURCE_MSG);

  const peek = await peekUrl(url.href);
  // A link that redirects there (a shortener, a mirror) is refused too.
  if (peek.finalUrl && blockedSource(peek.finalUrl)) throw new HttpError(422, BLOCKED_SOURCE_MSG);
  // Many news sites turn away fetches that are not a browser. An article
  // is still worth keeping: the jobs try again, and its address names it.
  if (peek.error && kind === 'rss') throw new HttpError(422, `Sidan ${peek.error} – kontrollera adressen.`);
  if (peek.error) peek.text = '';
  let finalKind = kind;
  let finalUrl = url.href;
  let title = null;
  if (kind !== 'article' && looksLikeFeed(peek)) {
    finalKind = 'rss';
    const t = peek.text.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
    title = t ? decodeEntities(t[1]).slice(0, 200) : url.hostname;
  } else if (kind === 'rss') {
    // A site's front page instead of its feed: use the feed it announces.
    const feed = announcedFeed(peek.text, peek.finalUrl);
    if (!feed) throw new HttpError(422, 'Hittade inget RSS-flöde på den adressen.');
    const fp = await peekUrl(feed);
    if (fp.error || !looksLikeFeed(fp)) throw new HttpError(422, 'Sidans RSS-flöde gick inte att läsa.');
    if (blockedSource(feed) || (fp.finalUrl && blockedSource(fp.finalUrl))) throw new HttpError(422, BLOCKED_SOURCE_MSG);
    finalUrl = feed;
    const t = fp.text.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
    title = t ? decodeEntities(t[1]).slice(0, 200) : url.hostname;
  } else {
    finalKind = 'article';
    title = pageTitle(peek.text) || slugTitle(url) || url.hostname;
  }
  // A feed names its publisher in its title: "TASS", "Lenta.ru" ...
  if (finalKind === 'rss' && blockedOutlet(title)) throw new HttpError(422, BLOCKED_SOURCE_MSG);
  if (typeof body.title === 'string' && body.title.trim()) title = body.title.trim().slice(0, 200);

  const dup = await env.DB.prepare('SELECT id FROM sources WHERE active = 1 AND url = ?').bind(finalUrl).first();
  if (dup) throw new HttpError(409, 'Den källan finns redan.');
  const row = {
    id: crypto.randomUUID(), kind: finalKind, url: finalUrl, title,
    added_by: who.email, added_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    'INSERT INTO sources (id, kind, url, title, added_by, added_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).bind(row.id, row.kind, row.url, row.title, row.added_by, row.added_at).run();
  await audit(env, who.email, 'source', row.id, { kind: row.kind, url: row.url });
  return json({ source: row }, 201);
}

async function removeSource(env, who, id) {
  const row = await env.DB.prepare('SELECT id FROM sources WHERE id = ? AND active = 1').bind(id).first();
  if (!row) throw new HttpError(404, 'no such source');
  await env.DB.prepare('UPDATE sources SET active = 0 WHERE id = ?').bind(id).run();
  await audit(env, who.email, 'source_removed', id, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// "Update everyone" (Version 3.3): open apps reload code and data
// ---------------------------------------------------------------------------
async function getRefresh(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'app_refresh'").first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/**
 * Records a refresh in meta (so /api/me tells every app, push or not) and
 * pushes it. The app reloads when it sees a refresh newer than its own
 * start, then shows the message as "Appen har uppdaterats".
 */
async function refreshEveryone(request, env, who) {
  const body = await readJson(request);
  if (body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, 'body must be an object');
  let message = null;
  if (body && body.message !== undefined && body.message !== null && body.message !== '') {
    if (typeof body.message !== 'string' || body.message.trim().length > 200) {
      throw new HttpError(400, 'message must be at most 200 characters');
    }
    message = body.message.trim() || null;
  }
  const prev = await getRefresh(env);
  if (prev && Date.now() - Date.parse(prev.at) < REFRESH_MIN_GAP_MS) {
    throw new HttpError(429, 'an update was just sent; wait half a minute');
  }
  const refresh = { id: crypto.randomUUID(), at: new Date().toISOString(), by: who.email, message };
  await setMeta(env, 'app_refresh', JSON.stringify(refresh));
  await audit(env, who.email, 'refresh', null, { message });
  const r = await pushTo(env, { adminsOnly: false, pref: 'notice' }, {
    title: 'Hotmonitor har uppdaterats',
    body: message || 'Ny version och nya uppgifter. Tryck för att öppna.',
    url: '/#/',
    tag: 'hm-refresh',
    kind: 'refresh',
    refresh_id: refresh.id,
  });
  return json({ refresh, pushed: r.sent || 0, failed: r.failed || 0 }, 201);
}

/** Everything the Mac keeps as a daily backup - no push keys. */
async function exportAll(env) {
  const all = async (sql) => (await env.DB.prepare(sql).all()).results;
  const updates = await all('SELECT * FROM updates ORDER BY ts');
  for (const u of updates) {
    try { u.outlets = JSON.parse(u.outlets || '[]'); } catch { u.outlets = []; }
  }
  const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first();
  return json({
    users: await all('SELECT email, role, active, created_at, created_by, last_seen, prev_visit, installed_at, platform FROM users ORDER BY email'),
    audit_log: await all('SELECT * FROM audit_log ORDER BY id'),
    security_log: await all('SELECT * FROM security_log ORDER BY id'),
    reads: await all('SELECT * FROM reads ORDER BY email, ts'),
    updates,
    notices: await all('SELECT * FROM notices ORDER BY ts'),
    invites: await all('SELECT * FROM invites ORDER BY requested_at'),
    push_subscription_count: subs.n,
    exported_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Security log and rate limit
// ---------------------------------------------------------------------------
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

// invalid_jwt is logged at most once per IP per minute, rate_limited once
// per key per minute: a flood must not flood the log too.
const logThrottle = new Map();
function throttledReason(req, reason) {
  const key = `${reason}|${reason === R.invalidJwt ? clientIp(req.request) : (req.email || clientIp(req.request))}`;
  const now = Date.now();
  const last = logThrottle.get(key) || 0;
  if (now - last < 60000) return 'none';
  logThrottle.set(key, now);
  if (logThrottle.size > 5000) logThrottle.clear();
  return reason;
}

let lastPrune = 0;
async function securityLog(req, reason, detail) {
  if (reason === 'none') return;
  const { request, env, url, ctx } = req;
  const work = (async () => {
    try {
      const now = new Date();
      await env.DB.prepare(
        `INSERT INTO security_log (ts, email, ip_country, path, method, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(now.toISOString(), req.email || null, request.headers.get('CF-IPCountry') || null,
             url.pathname.slice(0, 200), request.method, reason, String(detail || '').slice(0, 500)).run();
      if (now.getTime() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = now.getTime();
        await env.DB.prepare('DELETE FROM security_log WHERE ts < ?')
          .bind(new Date(now.getTime() - SECURITY_LOG_DAYS * 86400000).toISOString()).run();
      }
    } catch (err) {
      console.error('security_log write failed', err && err.message);
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
}

// Per isolate, so approximate across Cloudflare's edge - enough to stop a
// runaway client or a scripted flood from one address. The machine is exempt.
const rateWindows = new Map();
function rateLimit(req, id) {
  if (id.kind === 'machine') return;
  const key = id.kind === 'user' ? `u:${id.email}` : `ip:${clientIp(req.request)}`;
  const now = Date.now();
  let w = rateWindows.get(key);
  if (!w || now - w.start >= 60000) {
    w = { start: now, n: 0 };
    rateWindows.set(key, w);
    if (rateWindows.size > 10000) {
      for (const [k, v] of rateWindows) if (now - v.start >= 60000) rateWindows.delete(k);
    }
  }
  w.n += 1;
  if (w.n > (id.kind === 'user' ? RATE_LIMIT_PER_MIN : RATE_LIMIT_PER_IP_MIN)) {
    throw new HttpError(429, 'too many requests', throttledReason(req, R.rateLimited));
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
/**
 * Who sent this, before any role lookup:
 * {kind: 'user', email} | {kind: 'machine'} | {kind: 'invalid'}.
 * No token, a bad token and Access not configured are all 'invalid'.
 */
async function identify(request, env, url) {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  // Local development only: both conditions must hold, and the DEV_* vars
  // are only ever set in .dev.vars, which is gitignored and never deployed.
  if (local && env.DEV_AUTH_MACHINE === '1' && request.headers.get('X-Dev-Machine') === '1') {
    return { kind: 'machine' };
  }
  if (local && env.DEV_AUTH_EMAIL) {
    return { kind: 'user', email: (request.headers.get('X-Dev-Email') || env.DEV_AUTH_EMAIL).trim().toLowerCase() };
  }

  if (!env.TEAM_DOMAIN || !env.ACCESS_AUD) return { kind: 'invalid' };  // not configured: fail closed

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) return { kind: 'invalid' };

  const claims = await verifyAccessJwt(token, env);
  if (!claims) return { kind: 'invalid' };

  if (claims.email) return { kind: 'user', email: String(claims.email).trim().toLowerCase() };
  if (env.MACHINE_CLIENT_ID && claims.common_name && claims.common_name === env.MACHINE_CLIENT_ID) {
    return { kind: 'machine' };
  }
  return { kind: 'invalid' };
}

/** Kept for tests: identify + role lookup, 401 as null. */
async function authenticate(request, env, url) {
  const id = await identify(request, env, url);
  if (id.kind === 'invalid') return null;
  if (id.kind === 'machine') return id;
  return userFor(id.email, { env, request, url });
}

function ownerEmail(env) {
  return String(env.OWNER || '').trim().toLowerCase();
}

let seededFor = null;
/** First use of an empty users table: seed it from OWNER, ADMINS and READERS. */
async function ensureSeeded(env) {
  if (seededFor === env.DB) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row && row.n === 0) {
    const now = new Date().toISOString();
    const seed = new Map();
    for (const e of emailList(env.READERS)) seed.set(e, 'reader');
    for (const e of emailList(env.ADMINS)) seed.set(e, 'admin');
    if (ownerEmail(env)) seed.set(ownerEmail(env), 'admin');
    for (const [email, role] of seed) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users (email, role, active, created_at, created_by) VALUES (?, ?, 1, ?, 'seed')"
      ).bind(email, role, now).run();
    }
    if (seed.size) await audit(env, 'system', 'seed', null, Object.fromEntries(seed));
  }
  seededFor = env.DB;
}

const lastSeenWritten = new Map();
/**
 * The verified email's role from D1; OWNER is always an active admin.
 * Unknown or inactive -> 403 not_allowed.
 */
async function userFor(email, req) {
  const env = req.env;
  await ensureSeeded(env);
  const owner = ownerEmail(env);
  const row = await env.DB.prepare(
    'SELECT role, active, last_seen, prev_visit FROM users WHERE email = ?'
  ).bind(email).first();

  const isOwner = !!owner && email === owner;
  if (!isOwner && (!row || !row.active)) {
    throw new HttpError(403, 'this account has no access', R.notAllowed);
  }

  // last_seen at most every 5 minutes; a gap of 30+ minutes starts a new
  // visit, and the old last_seen becomes prev_visit ("new since last time").
  let lastVisit = row ? row.prev_visit : null;
  const now = Date.now();
  const written = lastSeenWritten.get(email) || 0;
  if (row && now - written >= LAST_SEEN_EVERY_MS) {
    const seen = row.last_seen ? Date.parse(row.last_seen) : 0;
    if (!seen || now - seen >= LAST_SEEN_EVERY_MS) {
      const newVisit = !seen || now - seen >= NEW_VISIT_GAP_MS;
      if (newVisit) lastVisit = row.last_seen || null;
      await env.DB.prepare(
        newVisit
          ? 'UPDATE users SET last_seen = ?, prev_visit = last_seen WHERE email = ?'
          : 'UPDATE users SET last_seen = ? WHERE email = ?'
      ).bind(new Date(now).toISOString(), email).run();
    }
    lastSeenWritten.set(email, now);
    if (lastSeenWritten.size > 5000) lastSeenWritten.clear();
  }

  return {
    kind: 'user',
    email,
    role: isOwner ? 'admin' : row.role,
    is_owner: isOwner,
    last_visit: lastVisit,
  };
}

function emailList(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function cookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

let jwksCache = { keys: new Map(), fetchedAt: 0, domain: '' };

async function signingKey(kid, env) {
  const now = Date.now();
  const stale = jwksCache.domain !== env.TEAM_DOMAIN || now - jwksCache.fetchedAt > JWKS_TTL_MS;
  // An unknown kid may mean Access rotated its keys: refetch, but not more
  // than once a minute however many bad tokens arrive.
  const unknownKid = !jwksCache.keys.has(kid) && now - jwksCache.fetchedAt > JWKS_MIN_REFETCH_MS;
  if (stale || unknownKid) {
    const res = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
    const { keys = [] } = await res.json();
    const map = new Map();
    for (const jwk of keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      const key = await crypto.subtle.importKey(
        'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
      );
      map.set(jwk.kid, key);
    }
    jwksCache = { keys: map, fetchedAt: now, domain: env.TEAM_DOMAIN };
  }
  return jwksCache.keys.get(kid) || null;
}

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(b64urlText(parts[0]));
    claims = JSON.parse(b64urlText(parts[1]));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const key = await signingKey(header.kid, env);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  // ACCESS_AUD may name several Access applications, comma-separated.
  const want = String(env.ACCESS_AUD).split(',').map((a) => a.trim()).filter(Boolean);
  if (!aud.some((a) => want.includes(a))) return null;
  if (claims.iss !== `https://${env.TEAM_DOMAIN}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
  return claims;
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function apiHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: apiHeaders() });
}

// Exported for tests only.
export const _test = { startDueRuns, lastDueMs, retryMissingReport, blockedSource, blockedOutlet, resetPublicLatest: () => { publicLatestMemo = null; }, reportPush, followsMatch, pushTo, drainPushQueue, PUSH_BATCH, guestKey, guestCache, pseudonymize, isPublicPath, verifyAccessJwt, authenticate, identify, userFor, stockholmClock, checkMissingReport, peekUrl, looksLikeFeed, pageTitle, announcedFeed };
