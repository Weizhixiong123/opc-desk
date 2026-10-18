const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  // 挂在子路径时填，例如 /desk；用独立域名就留空
  basePath: (env.BASE_PATH ?? '').replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === '1',
  dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db'),
  // 登录密码；会话签名也用它派生，改密码后所有设备需要重新登录
  password: env.LOGIN_PASSWORD || '',
  sessionDays: num(env.SESSION_DAYS, 30),
  // 走 https 时设为 1，cookie 加 Secure
  secureCookie: env.SECURE_COOKIE === '1',
};
