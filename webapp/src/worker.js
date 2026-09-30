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
 */

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
    return json({ email: who.email, role: who.role, is_owner: who.is_owner });
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
    return ingestReport(request, env, m[1]);
  }

  if (path === '/api/ingest/updates') {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestUpdates(request, env);
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

  const m = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (m) {
    let target;
    try {
      target = decodeURIComponent(m[1]).trim().toLowerCase();
    } catch {
      throw new HttpError(400, 'bad email in path');
    }
    if (!EMAIL_RE.test(target)) throw new HttpError(400, 'bad email in path');
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

async function ingestReport(request, env, date) {
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
      thread_id: str(u.thread_id, 200), thread_label: str(u.thread_label, 500),
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
            (SELECT COUNT(*) FROM assessments a WHERE a.operator = u.email) AS assessments
     FROM users u ORDER BY u.active DESC, u.role, u.email`
  ).all();
  const owner = ownerEmail(env);
  for (const r of results) {
    r.active = !!r.active;
    r.is_owner = r.email === owner;
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

  const existing = await env.DB.prepare('SELECT role, active FROM users WHERE email = ?').bind(email).first();
  const now = new Date().toISOString();
  if (existing) {
    if (existing.active && existing.role === body.role) return json(await userRow(env, email), 200);
    return changeUser(env, actor, email, { role: body.role, active: true });
  }
  await env.DB.prepare(
    'INSERT INTO users (email, role, active, created_at, created_by) VALUES (?, ?, 1, ?, ?)'
  ).bind(email, body.role, now, actor.email).run();
  await audit(env, actor.email, 'add', email, { role: body.role });
  return json(await userRow(env, email), 201);
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
  const action = !active ? 'deactivate' : (!row.active ? 'reactivate' : 'role');
  await audit(env, actor.email, action, target,
    { from: { role: row.role, active: !!row.active }, to: { role, active } });
  return json(await userRow(env, target), 200);
}

async function userRow(env, email) {
  const r = await env.DB.prepare(
    'SELECT email, role, active, created_at, created_by, last_seen FROM users WHERE email = ?'
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
  return json({
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
export const _test = { verifyAccessJwt, authenticate, identify, userFor };
