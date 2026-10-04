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
 * an alarm when the morning report has not arrived by 06:30 Stockholm time.
 * Version 3.3: invitation emails (queued here, sent by the Mac) and an
 * admin "update everyone" push that makes open apps reload.
 */

import { sendPush, allowedEndpoint, b64uDecode, checkPoint } from './webpush.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

const RATE_LIMIT_PER_MIN = 120;
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

const ALARM_AFTER_MINUTES = 6 * 60 + 30;   // 06:30 Stockholm time
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const INDEX_PUSH_DELTA = 0.5;
const HIGH_SCORE = 9;
const INVITE_MAX_ATTEMPTS = 3;
const REFRESH_MIN_GAP_MS = 30 * 1000;
const INVITE_ID_RE = /^[0-9a-f-]{36}$/;

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
    if (!url.pathname.startsWith('/api/')) {
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

  // Cron (wrangler.jsonc triggers): the missing-report alarm.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkMissingReport(env, event.scheduledTime || Date.now()).catch((err) => {
      console.error('missing-report check failed', err && err.stack ? err.stack : err);
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
  if (id.kind === 'invalid') {
    throw new HttpError(401, 'not authenticated', throttledReason(req, R.invalidJwt));
  }

  // Mutating requests from people must come from the app's own pages.
  // The machine has no browser and no Origin; it is exempt.
  if (id.kind === 'user' && method !== 'GET' && method !== 'HEAD') {
    if (request.headers.get('Origin') !== url.origin) {
      throw new HttpError(403, 'bad origin', R.badOrigin);
    }
  }

  const who = id.kind === 'user' ? await userFor(id.email, req) : id;
  req.who = who;

  if (path === '/api/me') {
    allow(method, 'GET');
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
    requireUser(who);
    if (!env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'push is not configured');
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (path === '/api/push/subscribe') {
    allow(method, 'POST');
    requireUser(who);
    return subscribePush(request, env, who);
  }

  if (path === '/api/push/unsubscribe') {
    allow(method, 'POST');
    requireUser(who);
    return unsubscribePush(request, env, who);
  }

  if (path === '/api/reports') {
    allow(method, 'GET');
    requireUser(who);
    const { results } = await env.DB.prepare(
      'SELECT date, threat_index, threat_index_30d, top_sv FROM reports ORDER BY date DESC'
    ).all();
    return json(results);
  }

  let m = path.match(/^\/api\/reports\/([^/]+)$/);
  if (m) {
    allow(method, 'GET');
    requireUser(who);
    const date = m[1];
    if (!DATE_RE.test(date)) throw new HttpError(400, 'bad date');
    const row = await env.DB.prepare('SELECT data FROM reports WHERE date = ?').bind(date).first();
    if (!row) throw new HttpError(404, 'no report for that date');
    return new Response(row.data, { status: 200, headers: apiHeaders() });
  }

  if (path === '/api/assessments') {
    if (method === 'GET') {
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
    requireUser(who);
    const { results } = await env.DB.prepare(
      'SELECT id, ts, author, title, body, url, expires_at FROM notices WHERE active = 1 AND expires_at > ? ORDER BY ts DESC'
    ).bind(new Date().toISOString()).all();
    return json(results);
  }

  if (path === '/api/updates') {
    allow(method, 'GET');
    requireUser(who);
    return listUpdates(env, url);
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

function allow(method, expected) {
  if (method !== expected) throw new HttpError(405, 'method not allowed');
}

function requireUser(who) {
  if (!who) throw new HttpError(401, 'not authenticated');
  if (who.kind !== 'user') throw new HttpError(403, 'forbidden');
}

function requireMachine(who) {
  if (!who) throw new HttpError(401, 'not authenticated');
  if (who.kind !== 'machine') throw new HttpError(403, 'forbidden');
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

  const existing = await env.DB.prepare('SELECT role, active FROM users WHERE email = ?').bind(email).first();
  const now = new Date().toISOString();
  if (existing) {
    // Someone already in the list gets mail only when asked for explicitly.
    if (body.invite === true) await queueInvite(env, actor, email, body.role);
    if (existing.active && existing.role === body.role) return json(await userRow(env, email), 200);
    return changeUser(env, actor, email, { role: body.role, active: true });
  }
  await env.DB.prepare(
    'INSERT INTO users (email, role, active, created_at, created_by) VALUES (?, ?, 1, ?, ?)'
  ).bind(email, body.role, now, actor.email).run();
  await audit(env, actor.email, 'add', email, { role: body.role });
  if (body.invite !== false) await queueInvite(env, actor, email, body.role);
  return json(await userRow(env, email), 201);
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
  });
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

/** Past 06:30 Stockholm time with no report for today: raise the alarm once per date. */
async function checkMissingReport(env, nowMs) {
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
    body: `Ingen morgonrapport för ${date} kl. 06:30. Kontrollera Macen.`,
    url: '/#/admin',
  }, 'high');
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
    prefs = JSON.stringify(p);
  }

  const existing = await env.DB.prepare('SELECT email FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first();
  if (!existing) {
    const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE email = ?').bind(who.email).first();
    if (mine.n >= MAX_SUBSCRIPTIONS_PER_USER) throw new HttpError(400, `at most ${MAX_SUBSCRIPTIONS_PER_USER} devices per user`);
  }
  // The endpoint belongs to whoever is signed in on that device now.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at, prefs)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh,
       auth = excluded.auth, prefs = excluded.prefs`
  ).bind(endpoint, who.email, keys.p256dh, keys.auth, new Date().toISOString(), prefs).run();
  return json({ ok: true }, existing ? 200 : 201);
}

async function unsubscribePush(request, env, who) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || typeof body.endpoint !== 'string' || body.endpoint.length > 1024) {
    throw new HttpError(400, 'endpoint is required');
  }
  // Only your own devices.
  const res = await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?')
    .bind(body.endpoint, who.email).run();
  return json({ ok: true, removed: res.meta?.changes || 0 });
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
  return pushTo(env, { adminsOnly: false, pref: 'report' }, payload, indexTrigger ? 'high' : 'normal');
}

/** Sends to every matching subscription; dead ones (404/410) are deleted. */
async function pushTo(env, { adminsOnly, pref }, payload, urgency = 'normal') {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('push skipped: VAPID keys not configured');
    return { sent: 0, reason: 'not configured' };
  }
  const owner = ownerEmail(env);
  const { results } = await env.DB.prepare(
    adminsOnly
      ? `SELECT p.* FROM push_subscriptions p LEFT JOIN users u ON u.email = p.email
         WHERE p.email = ? OR (u.role = 'admin' AND u.active = 1)`
      : `SELECT p.* FROM push_subscriptions p LEFT JOIN users u ON u.email = p.email
         WHERE p.email = ? OR u.active = 1`
  ).bind(owner).all();

  const vapid = { subject: `mailto:${owner}`, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const devAllow = devPushAllow(env);
  let sent = 0, failed = 0, removed = 0;
  for (const s of results) {
    let prefs = {};
    try { prefs = s.prefs ? JSON.parse(s.prefs) : {}; } catch { prefs = {}; }
    if (pref && prefs[pref] === false) continue;
    // Stored endpoints were checked on subscribe; check again before any request.
    if (!allowedEndpoint(s.endpoint, devAllow)) continue;
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, vapid, { urgency });
      if (r.ok) sent++;
      else {
        failed++;
        if (r.gone) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
          removed++;
        }
      }
    } catch (err) {
      failed++;
      console.error('push send failed', err && err.message);
    }
  }
  const summary = { at: new Date().toISOString(), title: payload.title, sent, failed, removed };
  await setMeta(env, 'last_push', JSON.stringify(summary));
  return summary;
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
  if (w.n > RATE_LIMIT_PER_MIN) {
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
  if (!aud.includes(env.ACCESS_AUD)) return null;
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
export const _test = { verifyAccessJwt, authenticate, identify, userFor, stockholmClock, checkMissingReport };
