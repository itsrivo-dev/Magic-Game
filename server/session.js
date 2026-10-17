'use strict';

const crypto = require('node:crypto');

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signSession(uid, secret, options = {}) {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('SESSION_SECRET_INVALID');
  const now = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const payload = b64url(JSON.stringify({
    sub: String(uid),
    iat: now,
    exp: now + (options.ttlSeconds || 7 * 86400),
    nonce: crypto.randomBytes(12).toString('base64url')
  }));
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifySession(token, secret, options = {}) {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  const now = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  if (!data || !/^\d{1,20}$/.test(String(data.sub)) || !Number.isSafeInteger(data.exp) || data.exp <= now || data.iat > now + 60) return null;
  return { uid: String(data.sub), issuedAt: data.iat, expiresAt: data.exp };
}

function signAdminMfa(uid, secret, options = {}) {
  const now = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const payload = b64url(JSON.stringify({ sub: String(uid), exp: now + (options.ttlSeconds || 900), scope: 'admin-finance' }));
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function verifyAdminMfa(token, uid, secret, options = {}) {
  const verified = verifySessionLike(token, secret, options);
  if (!verified || verified.sub !== String(uid) || verified.scope !== 'admin-finance') return false;
  return verified.exp > Math.floor((options.now ? options.now() : Date.now()) / 1000);
}

function verifySessionLike(token, secret, options = {}) {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const now = Math.floor((options.now ? options.now() : Date.now()) / 1000);
    if (!data || !Number.isSafeInteger(data.exp) || data.exp <= now) return null;
    return data;
  } catch { return null; }
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const text = String(input || '').toUpperCase().replace(/\s+/g,'').replace(/=+$/g,'');
  if (!/^[A-Z2-7]{16,128}$/.test(text)) throw new Error('INVALID_TOTP_SECRET');
  let bits = '';
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5,'0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i,i+8),2));
  if (!bytes.length) throw new Error('INVALID_TOTP_SECRET');
  return Buffer.from(bytes);
}

function totpAt(secret, time = Date.now(), stepSeconds = 30) {
  const key = base32Decode(secret);
  const counter = Math.floor(time / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code, options = {}) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const now = options.now ? options.now() : Date.now();
  try {
    for (const delta of [-1,0,1]) {
      const expected = totpAt(secret,now+delta*30000);
      const left=Buffer.from(expected);
      const right=Buffer.from(String(code));
      if(left.length===right.length&&crypto.timingSafeEqual(left,right)) return true;
    }
  } catch { return false; }
  return false;
}

module.exports = { signSession, verifySession, signAdminMfa, verifyAdminMfa, verifyTotp, totpAt };
