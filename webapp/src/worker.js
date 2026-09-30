/**
 * Hotmonitor API - Cloudflare Worker.
 *
 * Serves /api/* (see ../CONTRACT.md); everything else is the static app in
 * ../public, served by Workers Static Assets before this code runs.
 *
 * Auth: Cloudflare Access sits in front of the hostname, and this Worker
 * verifies the Access JWT itself as well - so a misconfigured Access
 * policy, or a request that reaches the Worker some other way, is refused
 * rather than trusted. Without TEAM_DOMAIN and ACCESS_AUD every request
 * is refused (fail closed).
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ARTICLE_ID_RE = /^[0-9a-f]{16}$/;
const CLIENT_ID_RE = /^[0-9A-Za-z-]{8,64}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      console.error('Unhandled error', err && err.stack ? err.stack : err);
      return json({ error: 'internal error' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const who = await authenticate(request, env, url);

  if (path === '/api/me') {
    allow(method, 'GET');
    requireUser(who);
    return json({ email: who.email, role: who.role });
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

  m = path.match(/^\/api\/ingest\/reports\/([^/]+)$/);
  if (m) {
    allow(method, 'PUT');
    requireMachine(who);
    return ingestReport(request, env, m[1]);
  }

  if (path === '/api/export/assessments') {
    allow(method, 'GET');
    requireMachine(who);
    const since = url.searchParams.get('since') || '';
    const { results } = await env.DB.prepare(
      'SELECT * FROM assessments WHERE ts > ? ORDER BY ts, rowid'
    ).bind(since).all();
    return json(results);
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
// Handlers
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
// Auth
// ---------------------------------------------------------------------------
/**
 * Returns {kind: 'user', email, role} | {kind: 'machine'} | null.
 * Throws 403 for a verified user who is on neither list.
 */
async function authenticate(request, env, url) {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  // Local development only: both conditions must hold, and the DEV_* vars
  // are only ever set in .dev.vars, which is gitignored and never deployed.
  if (local && env.DEV_AUTH_MACHINE === '1' && request.headers.get('X-Dev-Machine') === '1') {
    return { kind: 'machine' };
  }
  if (local && env.DEV_AUTH_EMAIL) {
    const email = (request.headers.get('X-Dev-Email') || env.DEV_AUTH_EMAIL).toLowerCase();
    return userFor(email, env);
  }

  if (!env.TEAM_DOMAIN || !env.ACCESS_AUD) return null;  // not configured: fail closed

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) return null;

  const claims = await verifyAccessJwt(token, env);
  if (!claims) return null;

  if (claims.email) return userFor(String(claims.email).toLowerCase(), env);
  if (env.MACHINE_CLIENT_ID && claims.common_name && claims.common_name === env.MACHINE_CLIENT_ID) {
    return { kind: 'machine' };
  }
  return null;
}

function userFor(email, env) {
  if (emailList(env.ADMINS).includes(email)) return { kind: 'user', email, role: 'admin' };
  if (emailList(env.READERS).includes(email)) return { kind: 'user', email, role: 'reader' };
  throw new HttpError(403, 'this account has no access');
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
export const _test = { verifyAccessJwt, authenticate, userFor };
