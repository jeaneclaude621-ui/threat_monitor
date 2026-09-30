/**
 * Web Push with WebCrypto only: message encryption per RFC 8291
 * (aes128gcm content coding, RFC 8188) and VAPID per RFC 8292.
 *
 * Keys: VAPID_PUBLIC_KEY is the uncompressed P-256 point (65 bytes,
 * base64url); VAPID_PRIVATE_KEY is the private scalar d (32 bytes,
 * base64url) or a JWK. Subscriptions carry the browser's p256dh (65-byte
 * point) and auth (16-byte secret), both base64url.
 */

const enc = new TextEncoder();
const RECORD_SIZE = 4096;

export function b64uEncode(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('not base64url');
  const clean = s.replace(/=+$/, '');
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((clean.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A 65-byte uncompressed P-256 point, or throws. */
export function checkPoint(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('not an uncompressed P-256 point');
  }
  return bytes;
}

function pointToJwk(point, d) {
  checkPoint(point);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEncode(point.slice(1, 33)), y: b64uEncode(point.slice(33, 65)), ext: true };
  if (d) jwk.d = typeof d === 'string' ? d : b64uEncode(d);
  return jwk;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

/**
 * RFC 8291 encryption of `plaintext` (bytes) for a subscription.
 * `keys` = { p256dh, auth } as base64url. `_fixed` = { asPrivate (d, b64u),
 * asPublic (b64u point), salt (b64u) } pins the ephemeral values - tests only.
 * Returns the aes128gcm body (header + single record).
 */
export async function encryptPayload(plaintext, keys, _fixed = null) {
  const uaPublic = checkPoint(b64uDecode(keys.p256dh));
  const authSecret = b64uDecode(keys.auth);
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error('payload too large');

  let asPrivate, asPublic, salt;
  if (_fixed) {
    asPublic = checkPoint(b64uDecode(_fixed.asPublic));
    asPrivate = await crypto.subtle.importKey('jwk', pointToJwk(asPublic, _fixed.asPrivate),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    salt = b64uDecode(_fixed.salt);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    salt = crypto.getRandomValues(new Uint8Array(16));
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // One record, so it is the last one: delimiter 0x02, no padding.
  const padded = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Decrypts an aes128gcm push body with the receiver's keys - tests only. */
export async function decryptPayload(body, uaPrivateD, uaPublicB64, authB64) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const uaPublic = checkPoint(b64uDecode(uaPublicB64));
  const uaPrivate = await crypto.subtle.importKey('jwk', pointToJwk(uaPublic, uaPrivateD),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256));
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(b64uDecode(authB64), ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('bad padding delimiter');
  return padded.slice(0, end);
}

/** The VAPID signing key from the secret: base64url d or a JWK (JSON). */
async function vapidSigningKey(privateKey, publicKeyB64) {
  let jwk;
  const trimmed = String(privateKey || '').trim();
  if (trimmed.startsWith('{')) {
    jwk = JSON.parse(trimmed);
  } else {
    const d = b64uDecode(trimmed);
    if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes');
    jwk = pointToJwk(b64uDecode(publicKeyB64), trimmed.replace(/=+$/, ''));
  }
  return crypto.subtle.importKey('jwk', { ...jwk, kty: 'EC', crv: 'P-256' },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** RFC 8292 JWT for the push service's origin: ES256, raw r||s signature. */
export async function vapidJwt(endpoint, subject, privateKey, publicKeyB64, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSec + 12 * 3600,
    sub: subject,
  })));
  const key = await vapidSigningKey(privateKey, publicKeyB64);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64uEncode(sig)}`;
}

/** Everything fetch() needs to deliver one message - separate so it can be unit-tested. */
export async function buildPushRequest(subscription, payload, vapid, { ttl = 86400, urgency = 'normal', _fixed = null } = {}) {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), subscription.keys, _fixed);
  const jwt = await vapidJwt(subscription.endpoint, vapid.subject, vapid.privateKey, vapid.publicKey);
  return {
    url: subscription.endpoint,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      },
      body,
    },
  };
}

/** Sends one message. Returns { ok, status, gone } - gone means the subscription is dead (404/410). */
export async function sendPush(subscription, payload, vapid, options = {}) {
  const { url, init } = await buildPushRequest(subscription, payload, vapid, options);
  const res = await fetch(url, init);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}

const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];

/**
 * Only known push services may be targeted - otherwise a subscription
 * would let a user make the Worker POST to any URL. `devAllow` (a comma
 * list of origins, local development only) adds a fake push server.
 */
export function allowedEndpoint(endpoint, devAllow = '') {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (devAllow && String(devAllow).split(',').map((s) => s.trim()).filter(Boolean).includes(u.origin)) return true;
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || host.endsWith('.notify.windows.com');
}
