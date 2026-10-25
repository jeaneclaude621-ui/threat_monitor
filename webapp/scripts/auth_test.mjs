#!/usr/bin/env node
// Unit test of the Worker's Access JWT verification - no server, no network.
// Signs tokens with a throwaway RSA key and serves its JWKS through a
// stubbed fetch, then drives the Worker's fetch handler directly.
//
//   node scripts/auth_test.mjs
import worker, { _test } from '../src/worker.js';

const TEAM = 'hotmonitor.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const KID = 'kid-1';
const MACHINE_ID = 'abc123.access';

const enc = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

const good = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const evil = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', good.publicKey);

globalThis.fetch = async (url) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256' }] }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

async function sign(claims, { key = good.privateKey, header = { alg: 'RS256', kid: KID, typ: 'JWT' } } = {}) {
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);
const base = { aud: [AUD], iss: `https://${TEAM}`, iat: now, nbf: now - 10, exp: now + 3600 };
// Just enough of D1 for identity: the users table (seeded by the Worker on
// first use), plus sinks for the audit and security logs.
class MockD1 {
  constructor() { this.users = new Map(); this.securityLog = []; this.audit = []; }
  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async first() {
        if (/^SELECT COUNT\(\*\) AS n FROM users/.test(sql)) return { n: db.users.size };
        if (/FROM users WHERE email = \?/.test(sql)) return db.users.get(args[0]) || null;
        return null;
      },
      async run() {
        if (/^INSERT OR IGNORE INTO users/.test(sql) && !db.users.has(args[0])) {
          db.users.set(args[0], { role: args[1], active: 1, last_seen: null, prev_visit: null });
        } else if (/^UPDATE users SET last_seen/.test(sql)) {
          const u = db.users.get(args[1]); if (u) u.last_seen = args[0];
        } else if (/^INSERT INTO security_log/.test(sql)) {
          db.securityLog.push(args[5]);
        } else if (/^INSERT INTO audit_log/.test(sql)) {
          db.audit.push(args[2]);
        }
        return { meta: { changes: 1 } };
      },
      async all() { return { results: [] }; },
    };
    return stmt;
  }
}
const db = new MockD1();
const env = {
  TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
  ADMINS: 'admin.one@example.org,admin.two@example.org',
  READERS: 'reader@example.com', MACHINE_CLIENT_ID: MACHINE_ID,
  OWNER: 'the.owner@example.org',
  DB: db, ASSETS: { fetch: () => new Response('asset') },
};

let pass = 0, fail = 0;
function expect(name, got, want) {
  if (got === want) { pass++; console.log(`  ok    ${name} (${got})`); }
  else { fail++; console.log(`  FAIL  ${name}: expected ${want}, got ${got}`); }
}

async function me(token, { host = 'hotmonitor.example.workers.dev', envOver = {}, cookie = false } = {}) {
  const headers = {};
  if (token && cookie) headers.Cookie = `other=1; CF_Authorization=${token}`;
  else if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  const res = await worker.fetch(new Request(`https://${host}/api/me`, { headers }), { ...env, ...envOver });
  return { status: res.status, body: await res.json() };
}

let r;
r = await me(await sign({ ...base, email: 'Admin.One@Example.org' }));
expect('valid admin token', r.status, 200); expect('admin role', r.body.role, 'admin');
r = await me(await sign({ ...base, email: 'admin.two@example.org' }), { cookie: true });
expect('token in CF_Authorization cookie', r.status, 200);
r = await me(await sign({ ...base, email: 'reader@example.com' }));
expect('reader role', r.body.role, 'reader');
r = await me(await sign({ ...base, email: 'stranger@example.com' }));
expect('verified but unlisted email', r.status, 403);
expect('unlisted email logged not_allowed', db.securityLog.at(-1), 'not_allowed');
r = await me(await sign({ ...base, email: 'the.owner@example.org' }));
expect('owner is admin', r.body.role, 'admin'); expect('owner flagged', r.body.is_owner, true);
db.users.get('admin.one@example.org').active = 0;
r = await me(await sign({ ...base, email: 'admin.one@example.org' }));
expect('deactivated user refused', r.status, 403);
db.users.get('admin.one@example.org').active = 1;
db.users.delete('the.owner@example.org');
r = await me(await sign({ ...base, email: 'the.owner@example.org' }));
expect('owner admin even without a users row', r.body.role, 'admin');
expect('seed wrote an audit row', db.audit[0], 'seed');
r = await me(null);
expect('no token', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org', aud: ['other-aud'] }));
expect('wrong audience', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org', iss: 'https://evil.cloudflareaccess.com' }));
expect('wrong issuer', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org', exp: now - 5 }));
expect('expired', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org', nbf: now + 3600 }));
expect('not yet valid', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org' }, { key: evil.privateKey }));
expect('signed by another key', r.status, 401);
const unsigned = `${b64url(enc.encode(JSON.stringify({ alg: 'none', kid: KID })))}.${b64url(enc.encode(JSON.stringify({ ...base, email: 'admin.one@example.org' })))}.`;
r = await me(unsigned);
expect('alg none', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org' }, { header: { alg: 'RS256', kid: 'unknown-kid' } }));
expect('unknown kid', r.status, 401);
r = await me('garbage');
expect('malformed token', r.status, 401);

// Fail closed when Access is not configured, even with a valid token.
r = await me(await sign({ ...base, email: 'admin.one@example.org' }), { envOver: { TEAM_DOMAIN: '' } });
expect('TEAM_DOMAIN empty', r.status, 401);
r = await me(await sign({ ...base, email: 'admin.one@example.org' }), { envOver: { ACCESS_AUD: '' } });
expect('ACCESS_AUD empty', r.status, 401);

// Dev bypass: only on localhost AND only with DEV_AUTH_EMAIL set.
r = await me(null, { host: 'localhost:8787' });
expect('localhost without dev vars', r.status, 401);
r = await me(null, { envOver: { DEV_AUTH_EMAIL: 'the.owner@example.org' } });
expect('dev vars on a public host', r.status, 401);
r = await me(null, { host: '127.0.0.1:8787', envOver: { DEV_AUTH_EMAIL: 'the.owner@example.org' } });
expect('dev bypass on 127.0.0.1', r.status, 200);

// Service token -> machine; a machine cannot use user routes.
const machineTok = await sign({ ...base, common_name: MACHINE_ID });
const who = await _test.authenticate(new Request('https://h/api/x', { headers: { 'Cf-Access-Jwt-Assertion': machineTok } }), env, new URL('https://h/api/x'));
expect('service token is machine', who && who.kind, 'machine');
r = await me(machineTok);
expect('machine on user route', r.status, 403);
r = await me(await sign({ ...base, common_name: 'other.access' }));
expect('unknown service token', r.status, 401);
r = await me(machineTok, { envOver: { MACHINE_CLIENT_ID: '' } });
expect('machine id unset', r.status, 401);

console.log(`auth_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
