#!/usr/bin/env node
// Version 3.17, the Cloudflare half: checks, fixes and finishes what
// DEPLOY.md "Version 3.17" describes, so the app opens to guests while the
// login and the Mac's paths stay behind Access.
//
//   cd threat_monitor && git checkout main && git pull
//   node webapp/scripts/open_app.mjs --check   # only look and report, change nothing
//   node webapp/scripts/open_app.mjs           # do it (asks before removing the old protection)
//
// Needs a Cloudflare API token that you make yourself and paste when asked
// (it is never written anywhere): My Profile -> API Tokens -> Create Token
// -> Custom token, with the account permissions
//   Access: Apps and Policies - Edit
//   Access: Organizations, Identity Providers, and Groups - Read
//   Workers Scripts - Read
// Delete the token afterwards. The Mac's service-token check uses
// CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET from ~/.zshrc (DEPLOY.md 4).
//
// Steps: 1 find the account, the app's address, the old Access application
// (its AUD is ACCESS_AUD in wrangler.jsonc) and the policies; 2 create or
// fix "Hotmonitor inloggning" (login, api/ingest/*, api/export/*; One-time
// PIN; 30 days; cookie path attribute off); 3 both AUD tags into
// wrangler.jsonc, commit, push; 4 deploy; 5 the Mac's path through the new
// application; 6 remove the old application (asks first); 7 check as a guest.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHECK = process.argv.includes('--check');
const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(WEBAPP, 'wrangler.jsonc');
const NEW_NAME = 'Hotmonitor inloggning';
const PATHS = ['login', 'api/ingest/*', 'api/export/*'];
const API = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';   // CF_API_BASE: tests only

const ok = (m) => console.log(`  ok   ${m}`);
const warn = (m) => console.log(`  !    ${m}`);
const step = (m) => console.log(`\n== ${m}`);
function die(m) { console.log(`\nSTOPP: ${m}`); process.exit(1); }

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) console.log(''); resolve(a.trim()); });
  });
}

let TOKEN = process.env.CF_SETUP_TOKEN || '';
async function cf(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    const errs = (j.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`${method} ${p} -> HTTP ${res.status} ${errs}`);
  }
  return j.result;
}

const hostOf = (uri) => String(uri || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
const destsOf = (app) => (app.destinations && app.destinations.length
  ? app.destinations.filter((d) => d.type === 'public' || d.uri).map((d) => d.uri)
  : (app.self_hosted_domains || [app.domain])).filter(Boolean).map((u) => u.replace(/^https?:\/\//, '').toLowerCase());

async function get(url, headers = {}) {
  let res;
  try { res = await fetch(url, { headers, redirect: 'manual' }); } catch (e) {
    return { status: 0, body: null, location: String(e.cause || e).slice(0, 60) };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, location: res.headers.get('location') || '' };
}

// ---------------------------------------------------------------------------
step('1. Konto, adress och nuvarande Access');
const wr = readFileSync(WRANGLER, 'utf8');
const audLine = wr.match(/"ACCESS_AUD":\s*"([^"]*)"/);
if (!audLine) die('hittar inte ACCESS_AUD i webapp/wrangler.jsonc');
const auds = audLine[1].split(',').map((s) => s.trim()).filter(Boolean);
if (!/"PUBLIC_READ":\s*"1"/.test(wr)) die('PUBLIC_READ är inte "1" i wrangler.jsonc - kör git pull på main först (PR #4).');
ok(`wrangler.jsonc: PUBLIC_READ på, ACCESS_AUD har ${auds.length} tagg(ar)`);

if (!TOKEN) TOKEN = await ask('Klistra in Cloudflare API-token (syns inte): ', { hidden: true });
if (!TOKEN) die('ingen token');
const accounts = await cf('GET', '/accounts');
if (!accounts.length) die('token ser inget konto - ge den behörigheterna i skriptets början');
const account = accounts.length === 1 ? accounts[0]
  : accounts[Number(await ask(accounts.map((a, i) => `  ${i}: ${a.name}`).join('\n') + '\nVilket konto (nummer)? ')) || 0];
const A = `/accounts/${account.id}`;
ok(`konto: ${account.name}`);

let host = hostOf(process.env.HOTMONITOR_URL);
if (!host) {
  try {
    const sub = await cf('GET', `${A}/workers/subdomain`);
    host = `hotmonitor.${sub.subdomain}.workers.dev`;
  } catch (e) {
    host = hostOf(await ask('Appens adress (t.ex. hotmonitor.xxxx.workers.dev): '));
  }
}
if (!host) die('ingen adress');
const BASE = `${/^http:\/\/(127\.0\.0\.1|localhost)/.test(process.env.HOTMONITOR_URL || '') ? 'http' : 'https'}://${host}`;
ok(`appen: ${BASE}`);

const apps = await cf('GET', `${A}/access/apps`);
const oldApp = apps.find((a) => auds.includes(a.aud) && a.name !== NEW_NAME
  && !destsOf(a).some((d) => d === `${host}/login`));
let newApp = apps.find((a) => a.name === NEW_NAME)
  || apps.find((a) => destsOf(a).includes(`${host}/login`));
if (oldApp) ok(`gamla skyddet: "${oldApp.name}" (${destsOf(oldApp).join(', ') || oldApp.type})`);
else ok('gamla skyddet för hela adressen finns inte längre');
if (newApp) ok(`ny applikation finns: "${newApp.name}"`);
else warn(`"${NEW_NAME}" finns inte - skapas`);

const idps = await cf('GET', `${A}/access/identity_providers`);
const otp = idps.find((i) => i.type === 'onetimepin');
if (!otp) die('One-time PIN finns inte som inloggningsmetod i Zero Trust (Settings -> Authentication)');

// The two policies: reusable ones by name, else copies of the old application's.
const reusable = await cf('GET', `${A}/access/policies`);
const sourcePolicies = (oldApp && oldApp.policies && oldApp.policies.length) ? oldApp.policies
  : (newApp && newApp.policies) || [];
const want = [];
for (const kind of ['allow', 'non_identity']) {
  let p = reusable.find((r) => r.decision === kind && /hotmonitor/i.test(r.name || ''));
  const src = sourcePolicies.find((s) => s.decision === kind);
  if (!p && src) p = reusable.find((r) => r.id === src.id);
  if (!p && src) {
    if (CHECK) { warn(`policyn "${src.name}" behöver kopieras till en återanvändbar policy`); continue; }
    p = await cf('POST', `${A}/access/policies`, {
      name: `${src.name || (kind === 'allow' ? 'Hotmonitor users' : 'Hotmonitor Mac')}`,
      decision: kind, include: src.include || [], exclude: src.exclude || [], require: src.require || [],
      ...(kind === 'allow' ? { session_duration: '720h' } : {}),
    });
    ok(`kopierade policyn "${p.name}"`);
  }
  if (!p) die(`hittar ingen ${kind === 'allow' ? 'Allow-policy för er e-post' : 'Service Auth-policy för Macens token'} - skapa den i Zero Trust -> Access -> Policies`);
  ok(`policy: "${p.name}" (${kind === 'allow' ? 'Allow' : 'Service Auth'})`);
  want.push(p);
}

// ---------------------------------------------------------------------------
step(`2. Applikationen "${NEW_NAME}"`);
const wantDests = PATHS.map((p) => `${host}/${p}`);
const body = {
  name: NEW_NAME, type: 'self_hosted', domain: wantDests[0],
  destinations: wantDests.map((uri) => ({ type: 'public', uri })),
  session_duration: '720h', allowed_idps: [otp.id], auto_redirect_to_identity: true,
  app_launcher_visible: false, path_cookie_attribute: false,
  policies: want.map((p, i) => ({ id: p.id, precedence: i + 1 })),
};
const problems = [];
if (newApp) {
  const have = destsOf(newApp).map((d) => d.replace(/\/$/, ''));
  for (const d of wantDests) if (!have.includes(d)) problems.push(`adressen ${d} saknas`);
  for (const d of have) if (!wantDests.includes(d)) problems.push(`adressen ${d} ska inte vara med`);
  if (newApp.path_cookie_attribute) problems.push('Cookie path attribute är PÅ (ska vara av)');
  if (newApp.session_duration !== '720h') problems.push(`sessionslängd ${newApp.session_duration} (ska vara 720h)`);
  const idpsHave = newApp.allowed_idps || [];
  if (idpsHave.length !== 1 || idpsHave[0] !== otp.id) problems.push('inloggningsmetod ska vara bara One-time PIN');
  const pol = (newApp.policies || []).map((p) => p.id);
  for (const p of want) if (!pol.includes(p.id)) problems.push(`policyn "${p.name}" är inte vald`);
  if (problems.length) {
    for (const p of problems) warn(p);
    if (!CHECK) {
      newApp = await cf('PUT', `${A}/access/apps/${newApp.id}`, { ...body, auto_redirect_to_identity: true });
      ok('rättat');
    }
  } else {
    ok('allt stämmer');
  }
} else if (!CHECK) {
  newApp = await cf('POST', `${A}/access/apps`, body);
  ok('skapad');
}
if (!newApp) { console.log('\n(--check: slutar här)'); process.exit(0); }
const newAud = newApp.aud;
ok(`AUD-tagg: ${newAud}`);

// ---------------------------------------------------------------------------
step('3. AUD-taggarna i wrangler.jsonc');
if (auds.includes(newAud)) {
  ok('redan inlagd');
} else if (CHECK) {
  warn('den nya taggen saknas i ACCESS_AUD');
} else {
  const next = [...auds, newAud].join(',');
  writeFileSync(WRANGLER, wr.replace(audLine[0], `"ACCESS_AUD": "${next}"`));
  ok('inlagd');
  const git = (...a) => spawnSync('git', a, { cwd: WEBAPP, stdio: 'inherit' }).status === 0;
  if (git('add', 'wrangler.jsonc') && git('commit', '-m', 'ACCESS_AUD: also the login application (Version 3.17)')) {
    if (!git('push', 'origin', 'HEAD')) warn('git push misslyckades - pusha själv senare, driftsättningen fortsätter');
  } else {
    warn('git commit misslyckades - ändringen finns ändå i filen');
  }
}

// ---------------------------------------------------------------------------
const deployedAudCheck = async () => {
  // The Worker answers 401 to a token whose AUD it does not know.
  const id = process.env.CF_ACCESS_CLIENT_ID; const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await get(`${BASE}/api/export/assessments?since=`, { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret });
  return r.status;
};

step('4. Driftsätt');
if (CHECK) {
  warn('hoppar över i --check');
} else {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;   // wrangler uses your own login, as before
  const r = spawnSync('npx', ['wrangler', 'deploy'], { cwd: WEBAPP, env, stdio: 'inherit' });
  if (r.status !== 0) die('wrangler deploy misslyckades - inget mer är ändrat. Kör skriptet igen när det fungerar.');
  ok('driftsatt');
}

// ---------------------------------------------------------------------------
step('5. Macens väg genom den nya applikationen');
let machine = null;
for (let i = 0; i < 6; i++) {
  machine = await deployedAudCheck();
  if (machine === 200 || machine === null) break;
  await new Promise((r) => setTimeout(r, 10000));
}
if (machine === null) warn('CF_ACCESS_CLIENT_ID/SECRET saknas i miljön (kör från en terminal där ~/.zshrc är inläst)');
else if (machine === 200) ok('Macens service token: 200');
else warn(`Macens service token: ${machine} (väntat 200)`);

// ---------------------------------------------------------------------------
step('6. Ta bort skyddet för hela adressen');
if (!oldApp) {
  ok('redan borta');
} else if (CHECK) {
  warn(`"${oldApp.name}" täcker fortfarande hela adressen - appen är inte öppen än`);
} else if (machine !== 200 && !process.argv.includes('--force')) {
  die('tar inte bort det gamla skyddet när Macens kontroll inte gav 200 (då kan nattens uppladdning stoppas). '
    + 'Rätta och kör igen, eller lägg till --force om du vet vad du gör.');
} else {
  const a = await ask(`Ta bort "${oldApp.name}" (${destsOf(oldApp).join(', ') || oldApp.type}) så att appen öppnas för alla? [j/N] `);
  if (!/^j/i.test(a)) die('avbrutet - inget borttaget. Kör skriptet igen när du vill öppna.');
  await cf('DELETE', `${A}/access/apps/${oldApp.id}`);
  ok('borttaget');
}

// ---------------------------------------------------------------------------
step('7. Kontroll utan inloggning');
let me = null;
for (let i = 0; i < (CHECK ? 1 : 9); i++) {
  me = await get(`${BASE}/api/me`);
  if (me.status === 200) break;
  await new Promise((r) => setTimeout(r, 10000));
}
const checks = [
  ['/api/me ger gäst', me.status === 200 && me.body && me.body.role === 'guest', `${me.status} ${me.body ? JSON.stringify(me.body).slice(0, 80) : me.location.slice(0, 60)}`],
];
const reports = await get(`${BASE}/api/reports`);
checks.push(['/api/reports läses av gäster', reports.status === 200, reports.status]);
const reads = await get(`${BASE}/api/reads`);
checks.push(['/api/reads kräver inloggning', reads.status === 401, reads.status]);
const exp = await get(`${BASE}/api/export/assessments?since=`);
checks.push(['/api/export bakom Access', exp.status === 302 || exp.status === 401 || exp.status === 403, `${exp.status} ${exp.location.slice(0, 50)}`]);
const login = await get(`${BASE}/login`);
checks.push(['/login går till Access-inloggningen', login.status === 302 && /cloudflareaccess\.com/.test(login.location), `${login.status} ${login.location.slice(0, 50)}`]);
let failed = 0;
for (const [name, good, detail] of checks) { (good ? ok : warn)(`${name} (${detail})`); if (!good) failed++; }

console.log(failed
  ? `\n${failed} kontroll(er) stämmer inte. Kopiera allt ovan och skicka till Claude.`
  : `\nKlart: ${BASE} är öppen för alla. Logga in via "Logga in" i appen. Ta bort API-token i Cloudflare nu.`);
