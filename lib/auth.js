const crypto = require('node:crypto');
const config = require('./config');

const COOKIE = 'opc_session';
// 签名密钥从密码派生：改了 LOGIN_PASSWORD，旧会话全部失效
const key = crypto.createHash('sha256').update(`opc-desk:${config.password}`).digest();

const sign = (exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPassword(input) {
  return Boolean(config.password) && sameSecret(String(input ?? ''), config.password);
}

function cookieAttrs(maxAge) {
  return [
    `Path=${config.basePath || '/'}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    config.secureCookie ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function sessionCookie() {
  const maxAge = Math.round(config.sessionDays * 86400);
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  return `${COOKIE}=${exp}.${sign(exp)}; ${cookieAttrs(maxAge)}`;
}

const clearCookie = () => `${COOKIE}=; ${cookieAttrs(0)}`;

function isLoggedIn(req) {
  const raw = String(req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  return sameSecret(sig, sign(exp));
}

// 输错密码太多次的 IP 暂时封禁
const failures = new Map();
const FAIL_LIMIT = 10;
const FAIL_WINDOW = 15 * 60e3;

function isBlocked(ip) {
  const f = failures.get(ip);
  return Boolean(f && f.until > Date.now() && f.count >= FAIL_LIMIT);
}

function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { count: 1, until: now + FAIL_WINDOW });
  else f.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (f.until < now) failures.delete(ip);
}, 60e3).unref();

module.exports = { checkPassword, sessionCookie, clearCookie, isLoggedIn, isBlocked, recordFailure };
