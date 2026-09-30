#!/usr/bin/env node
// Helpers for the push part of smoke_test.sh.
//   node scripts/push_helper.mjs keys
//       -> {"p256dh","auth","d"}: a browser's subscription keys
//   node scripts/push_helper.mjs last <log> <path> <d> <p256dh> <auth> <vapidPublicKey>
//       -> the last message sent to <path>, decrypted, plus whether its
//          VAPID JWT verifies against <vapidPublicKey>
import fs from 'node:fs';
import { decryptPayload, b64uEncode, b64uDecode } from '../src/webpush.js';
const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'keys') {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  console.log(JSON.stringify({
    p256dh: b64uEncode(await crypto.subtle.exportKey('raw', k.publicKey)),
    auth: b64uEncode(crypto.getRandomValues(new Uint8Array(16))),
    d: (await crypto.subtle.exportKey('jwk', k.privateKey)).d,
  }));
} else if (cmd === 'last') {
  const [log, path, d, p256dh, auth, vapidPub] = a;
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const hits = lines.map((l) => JSON.parse(l)).filter((r) => r.path === path);
  if (!hits.length) { console.log(JSON.stringify({ count: 0 })); process.exit(0); }
  const r = hits[hits.length - 1];
  const payload = JSON.parse(new TextDecoder().decode(await decryptPayload(new Uint8Array(Buffer.from(r.body, 'base64')), d, p256dh, auth)));
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(r.headers.authorization || '');
  let jwtOk = false, aud = null;
  if (m && m[4] === vapidPub) {
    const pub = await crypto.subtle.importKey('raw', b64uDecode(vapidPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    jwtOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64uDecode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    aud = JSON.parse(new TextDecoder().decode(b64uDecode(m[2]))).aud;
  }
  console.log(JSON.stringify({ count: hits.length, payload, jwtOk, aud, encoding: r.headers['content-encoding'], ttl: r.headers.ttl }));
}
