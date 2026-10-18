// 工作台的通用功能：专注计时、个人资料和偏好、头像
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { q } = require('./db');
const { ApiError } = require('./service');

const TZ = process.env.TZ || 'Asia/Shanghai';
const localDate = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ });

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- 专注计时 ----
const KINDS = ['deep', 'other'];

function startFocus(body) {
  const kind = KINDS.includes(body.kind) ? body.kind : 'deep';
  if (q.runningFocus.get()) throw new ApiError('已经在计时了，先结束当前这段');
  const now = Date.now();
  const { lastInsertRowid } = q.insertFocus.run(kind, localDate(now), now);
  return q.getFocus.get(lastInsertRowid);
}

function stopFocus() {
  const cur = q.runningFocus.get();
  if (!cur) throw new ApiError('现在没有在计时');
  const now = Date.now();
  // 不到 1 分钟的当作误点，直接丢掉
  if (now - cur.started_at < 60e3) {
    q.deleteFocus.run(cur.id);
    return { discarded: true };
  }
  q.stopFocus.run(now, cur.id);
  return q.getFocus.get(cur.id);
}

// 某天所在那一周（周一到周日）的专注时长，单位秒；正在进行的那段算到现在
function focusSummary(date) {
  const now = Date.now();
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = 周日
  const monday = shiftDate(date, -((day + 6) % 7));
  const sunday = shiftDate(monday, 6);
  const yesterday = shiftDate(date, -1);
  const from = yesterday < monday ? yesterday : monday;

  const byDate = new Map();
  for (const s of q.focusBetween.all(from, sunday)) {
    const secs = Math.max(0, Math.round(((s.ended_at ?? now) - s.started_at) / 1000));
    const d = byDate.get(s.date) || { deep: 0, other: 0 };
    d[s.kind === 'other' ? 'other' : 'deep'] += secs;
    byDate.set(s.date, d);
  }
  const total = (d) => (d ? d.deep + d.other : 0);
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = shiftDate(monday, i);
    return { date: d, ...(byDate.get(d) || { deep: 0, other: 0 }) };
  });
  return {
    now,
    current: q.runningFocus.get() || null,
    today: total(byDate.get(date)),
    yesterday: total(byDate.get(yesterday)),
    week,
  };
}

// ---- 个人资料和偏好 ----
const ACCENTS = ['#a3e36b', '#7fd1b0', '#f2c14e', '#9cc3ff'];
// avatarAt：头像上传时间，页面用它拼图片地址，换了头像浏览器会重新取；0 表示没有头像
const DEFAULTS = { name: '', title: '一人公司', motto: '', accent: ACCENTS[0], hideAmt: false, avatarAt: 0 };
const TEXT_LIMITS = { name: 20, title: 20, motto: 60 };

function getSettings() {
  const out = { ...DEFAULTS };
  for (const { key, value } of q.allSettings.all()) {
    if (key in DEFAULTS) {
      try {
        out[key] = JSON.parse(value);
      } catch {}
    }
  }
  return out;
}

function updateSettings(body) {
  for (const [key, raw] of Object.entries(body || {})) {
    let value;
    if (key in TEXT_LIMITS) {
      value = String(raw ?? '').trim();
      if (value.length > TEXT_LIMITS[key]) throw new ApiError(`最多 ${TEXT_LIMITS[key]} 个字`);
    } else if (key === 'accent') {
      if (!ACCENTS.includes(raw)) throw new ApiError('主题色只能从给出的几种里选');
      value = raw;
    } else if (key === 'hideAmt') {
      value = Boolean(raw);
    } else {
      continue; // 不认识的字段忽略
    }
    q.putSetting.run(key, JSON.stringify(value));
  }
  return getSettings();
}

// ---- 头像：一个文件，放在数据库旁边，跟着数据卷一起备份 ----
const AVATAR_FILE = path.join(path.dirname(config.dbFile), 'avatar');
const AVATAR_MAX = 2 * 1024 * 1024;

// 按文件头认图片格式，不信请求里声明的类型
function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function setAvatar(buf) {
  if (!buf.length) throw new ApiError('没有收到图片');
  if (buf.length > AVATAR_MAX) throw new ApiError('图片太大，最多 2 MB', 413);
  const type = imageType(buf);
  if (!type) throw new ApiError('只支持 PNG、JPG、WebP 图片');
  fs.writeFileSync(AVATAR_FILE, buf);
  q.putSetting.run('avatarType', JSON.stringify(type));
  q.putSetting.run('avatarAt', JSON.stringify(Date.now()));
  return getSettings();
}

function getAvatar() {
  if (!getSettings().avatarAt || !fs.existsSync(AVATAR_FILE)) return null;
  const type = q.allSettings.all().find((r) => r.key === 'avatarType');
  return { type: type ? JSON.parse(type.value) : 'image/jpeg', body: fs.readFileSync(AVATAR_FILE) };
}

function deleteAvatar() {
  fs.rmSync(AVATAR_FILE, { force: true });
  q.putSetting.run('avatarAt', JSON.stringify(0));
  return getSettings();
}

module.exports = {
  AVATAR_MAX, localDate, startFocus, stopFocus, focusSummary, getSettings, updateSettings, setAvatar, getAvatar, deleteAvatar,
};
