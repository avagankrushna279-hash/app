'use strict';
const crypto = require('crypto');
const b64 = (b) => Buffer.from(b).toString('base64url');
function secret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error('APP_SECRET must be set to a random string of 16 or more characters');
  return s;
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, hash] = String(stored).split('$');
    const key = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
    return crypto.timingSafeEqual(key, Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}
function sign(payload, ttlSeconds = 7 * 86400) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function verify(token) {
  try {
    const [body, sig] = String(token).split('.');
    const want = crypto.createHmac('sha256', secret()).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch (e) { return null; }
}
module.exports = { hashPassword, verifyPassword, sign, verify };
