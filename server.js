const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config');
const auth = require('./lib/auth');
const service = require('./lib/service');
const desk = require('./lib/desk');
const tasks = require('./lib/tasks');
const { ApiError } = service;

const BASE = config.basePath;

if (!config.password) {
  console.error('没有设置 LOGIN_PASSWORD，先在 .env 里填好登录密码');
  process.exit(1);
}

// 静态文件启动时读一次；页面里的 __BASE__ 换成挂载路径
const read = (name) => fs.readFileSync(path.join(__dirname, 'public', name), 'utf8').replaceAll('__BASE__', BASE);
const assets = {
  '/': { type: 'text/html; charset=utf-8', body: read('index.html') },
  '/app.css': { type: 'text/css; charset=utf-8', body: read('app.css') },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: read('app.js') },
  '/icon.svg': { type: 'image/svg+xml', body: read('icon.svg') },
  '/manifest.webmanifest': { type: 'application/manifest+json', body: read('manifest.webmanifest') },
};
// 字体是二进制文件，原样读取，长期缓存
assets['/jakarta.woff2'] = { type: 'font/woff2', body: fs.readFileSync(path.join(__dirname, 'public', 'jakarta.woff2')), immutable: true };

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// ---- 工具 ----
function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  // 只收 JSON：配合 SameSite=Lax，跨站表单提交不了写操作
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new ApiError('请求格式错误', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new ApiError('请求过大', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('请求格式错误', 400);
  }
}

// 上传图片用：原始字节，限定大小。只收 image/*，跨站的普通表单发不出这种请求
async function readImage(req, max) {
  if (!String(req.headers['content-type'] || '').startsWith('image/')) throw new ApiError('请求格式错误', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new ApiError('图片太大，最多 2 MB', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || '';
}

const today = () => desk.localDate(Date.now());

// ---- 接口 ----
async function handleApi(req, res, route, url) {
  const m = req.method;

  if (route === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (auth.isBlocked(ip)) throw new ApiError('密码错误次数太多，请 15 分钟后再试', 429);
    const body = await readJson(req);
    if (!auth.checkPassword(body.password)) {
      auth.recordFailure(ip);
      throw new ApiError('密码不对', 401);
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie() });
  }
  if (route === '/api/logout' && m === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  if (!auth.isLoggedIn(req)) throw new ApiError('请先登录', 401);

  if (route === '/api/me' && m === 'GET') return sendJson(res, 200, { ok: true, today: today(), settings: desk.getSettings() });

  if (route === '/api/settings') {
    if (m === 'GET') return sendJson(res, 200, desk.getSettings());
    if (m === 'PATCH') return sendJson(res, 200, desk.updateSettings(await readJson(req)));
  }

  if (route === '/api/avatar') {
    if (m === 'GET') {
      const a = desk.getAvatar();
      if (!a) throw new ApiError('还没有头像', 404);
      // 地址里带了上传时间，换头像地址就变，所以可以长期缓存
      res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      return res.end(a.body);
    }
    if (m === 'PUT') return sendJson(res, 200, desk.setAvatar(await readImage(req, desk.AVATAR_MAX)));
    if (m === 'DELETE') return sendJson(res, 200, desk.deleteAvatar());
  }

  if (route === '/api/tasks') {
    if (m === 'GET') return sendJson(res, 200, tasks.listTasks(today()));
    if (m === 'POST') return sendJson(res, 200, tasks.createTask(await readJson(req)));
  }
  const taskId = route.match(/^\/api\/tasks\/(\d+)$/)?.[1];
  if (taskId) {
    if (m === 'PATCH') return sendJson(res, 200, tasks.updateTask(Number(taskId), await readJson(req)));
    if (m === 'DELETE') return sendJson(res, 200, (tasks.deleteTask(Number(taskId)), { ok: true }));
  }

  if (route === '/api/focus' && m === 'GET') return sendJson(res, 200, desk.focusSummary(today()));
  if (route === '/api/focus/start' && m === 'POST') {
    desk.startFocus(await readJson(req));
    return sendJson(res, 200, desk.focusSummary(today()));
  }
  if (route === '/api/focus/stop' && m === 'POST') {
    const r = desk.stopFocus();
    return sendJson(res, 200, { ...desk.focusSummary(today()), discarded: Boolean(r.discarded) });
  }

  if (route === '/api/categories') {
    if (m === 'GET') return sendJson(res, 200, service.listCategories());
    if (m === 'POST') return sendJson(res, 200, service.createCategory(await readJson(req)));
  }
  let id = route.match(/^\/api\/categories\/(\d+)$/)?.[1];
  if (id) {
    if (m === 'PATCH') return sendJson(res, 200, service.updateCategory(Number(id), await readJson(req)));
    if (m === 'DELETE') return sendJson(res, 200, (service.deleteCategory(Number(id)), { ok: true }));
  }

  const query = Object.fromEntries(url.searchParams);
  if (route === '/api/entries') {
    if (m === 'GET') return sendJson(res, 200, service.listEntries(query));
    if (m === 'POST') return sendJson(res, 200, service.createEntry(await readJson(req)));
  }
  id = route.match(/^\/api\/entries\/(\d+)$/)?.[1];
  if (id) {
    if (m === 'PUT') return sendJson(res, 200, service.updateEntry(Number(id), await readJson(req)));
    if (m === 'DELETE') return sendJson(res, 200, (service.deleteEntry(Number(id)), { ok: true }));
  }

  if (route === '/api/summary' && m === 'GET') return sendJson(res, 200, service.summary(query.period || today().slice(0, 7)));

  if (route === '/api/export.csv' && m === 'GET') {
    const csv = service.exportCsv(query);
    const name = `opc-desk-${query.period || `${query.from}_${query.to}`}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  throw new ApiError('接口不存在', 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;

  if (BASE) {
    if (pathname === BASE) {
      res.writeHead(301, { Location: `${BASE}/${url.search}` });
      return res.end();
    }
    if (!pathname.startsWith(`${BASE}/`)) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    pathname = pathname.slice(BASE.length);
  }

  try {
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url);

    const asset = assets[pathname];
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...SECURITY_HEADERS,
      });
      return res.end(req.method === 'HEAD' ? undefined : asset.body);
    }
    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    if (err instanceof ApiError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: '服务器出错了' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`opc-desk 已启动：http://${config.host}:${config.port}${BASE}/`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
