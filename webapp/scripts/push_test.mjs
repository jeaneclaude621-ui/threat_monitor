#!/usr/bin/env node
// Unit test of the Web Push code - no server, no network.
//   node scripts/push_test.mjs
// - RFC 8291 Appendix A: the exact encrypted body for the published keys.
// - Round trip with fresh keys (encrypt, then decrypt as the browser would).
// - RFC 8292 VAPID JWT: claims, and the ES256 signature verifies.
// - The request fetch() gets: headers, body, Authorization.
// - The endpoint allowlist.
import {
  encryptPayload, decryptPayload, vapidJwt, buildPushRequest, allowedEndpoint, b64uEncode, b64uDecode,
} from '../src/webpush.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const enc = new TextEncoder();

// RFC 8291 Appendix A
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

console.log('RFC 8291 Appendix A');
const body = await encryptPayload(enc.encode(V.plaintext), { p256dh: V.uaPublic, auth: V.auth },
  { asPrivate: V.asPrivate, asPublic: V.asPublic, salt: V.salt });
ok('encrypted body matches the RFC test vector', b64uEncode(body) === V.body, `\n        got ${b64uEncode(body)}`);
const back = await decryptPayload(b64uDecode(V.body), V.uaPrivate, V.uaPublic, V.auth);
ok('RFC body decrypts to the plaintext', new TextDecoder().decode(back) === V.plaintext);

console.log('Round trip with fresh keys');
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = b64uEncode(await crypto.subtle.exportKey('raw', ua.publicKey));
const uaD = (await crypto.subtle.exportKey('jwk', ua.privateKey)).d;
const auth = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
const msg = JSON.stringify({ title: 'Hotindex 7,1 (+0,6)', body: 'Åäö – test', url: '/#/' });
const b2 = await encryptPayload(enc.encode(msg), { p256dh: uaPub, auth });
ok('fresh message decrypts', new TextDecoder().decode(await decryptPayload(b2, uaD, uaPub, auth)) === msg);
const b3 = await encryptPayload(enc.encode(msg), { p256dh: uaPub, auth });
ok('each message uses a new salt and key', b64uEncode(b2.slice(0, 16)) !== b64uEncode(b3.slice(0, 16)));
ok('record size 4096 in header', new DataView(b2.buffer).getUint32(16) === 4096 && b2[20] === 65);
let threw = false;
try { await encryptPayload(enc.encode('x'), { p256dh: uaPub, auth: b64uEncode(new Uint8Array(8)) }); } catch { threw = true; }
ok('short auth secret refused', threw);
threw = false;
try { await encryptPayload(enc.encode('x'), { p256dh: b64uEncode(new Uint8Array(65)), auth }); } catch { threw = true; }
ok('invalid p256dh refused', threw);

console.log('VAPID (RFC 8292)');
const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vPub = b64uEncode(await crypto.subtle.exportKey('raw', vk.publicKey));
const vD = (await crypto.subtle.exportKey('jwk', vk.privateKey)).d;
const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH-abc';
const now = Math.floor(Date.now() / 1000);
const jwt = await vapidJwt(endpoint, 'mailto:owner@example.com', vD, vPub, now);
const [h, c, s] = jwt.split('.');
const header = JSON.parse(new TextDecoder().decode(b64uDecode(h)));
const claims = JSON.parse(new TextDecoder().decode(b64uDecode(c)));
ok('header ES256 JWT', header.alg === 'ES256' && header.typ === 'JWT');
ok('aud is the push service origin', claims.aud === 'https://web.push.apple.com');
ok('exp within 24h', claims.exp > now && claims.exp <= now + 86400);
ok('sub is mailto', claims.sub === 'mailto:owner@example.com');
ok('signature is raw r||s (64 bytes)', b64uDecode(s).length === 64);
ok('signature verifies with the public key', await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey, b64uDecode(s), enc.encode(`${h}.${c}`)));
const jwkJson = JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey));
const jwt2 = await vapidJwt(endpoint, 'mailto:owner@example.com', jwkJson, vPub, now);
const [h2, c2, s2] = jwt2.split('.');
ok('private key as JWK also works', await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey, b64uDecode(s2), enc.encode(`${h2}.${c2}`)));

console.log('Request building');
const req = await buildPushRequest({ endpoint, keys: { p256dh: uaPub, auth } }, { title: 't', body: 'b', url: '/' },
  { subject: 'mailto:owner@example.com', privateKey: vD, publicKey: vPub }, { urgency: 'high' });
ok('POST to the endpoint', req.url === endpoint && req.init.method === 'POST');
ok('aes128gcm headers', req.init.headers['Content-Encoding'] === 'aes128gcm' && req.init.headers['Content-Type'] === 'application/octet-stream');
ok('TTL and Urgency', req.init.headers.TTL === '86400' && req.init.headers.Urgency === 'high');
ok('Authorization: vapid t=..., k=<public key>', new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vPub}$`).test(req.init.headers.Authorization));
ok('body decrypts to the payload JSON', JSON.parse(new TextDecoder().decode(await decryptPayload(req.init.body, uaD, uaPub, auth))).title === 't');

console.log('Endpoint allowlist');
ok('Apple allowed', allowedEndpoint('https://web.push.apple.com/abc'));
ok('FCM allowed', allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
ok('Mozilla allowed', allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'));
ok('Windows allowed', allowedEndpoint('https://db5p.notify.windows.com/w/?token=abc'));
ok('other host refused', !allowedEndpoint('https://evil.example/abc'));
ok('lookalike refused', !allowedEndpoint('https://web.push.apple.com.evil.example/abc'));
ok('http refused', !allowedEndpoint('http://web.push.apple.com/abc'));
ok('port refused', !allowedEndpoint('https://web.push.apple.com:8443/abc'));
ok('userinfo refused', !allowedEndpoint('https://x@web.push.apple.com/abc'));
ok('garbage refused', !allowedEndpoint('not a url'));
ok('dev origin only when listed', allowedEndpoint('http://127.0.0.1:8799/p/1', 'http://127.0.0.1:8799') && !allowedEndpoint('http://127.0.0.1:8799/p/1'));

console.log(`\npush_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
