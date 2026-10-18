// 我的任务
const { q } = require('./db');
const { ApiError } = require('./service');

const TAGS = ['设计', '开发', '内容', '沟通', '整理', '规划', '学习'];

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseTime(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new ApiError(`${label}格式不对，要像 09:30 这样`);
  return s;
}

// 新建时缺的字段用默认值；修改时缺的字段沿用原来的
function parseTask(body, base = {}) {
  const pick = (k) => (body[k] === undefined ? base[k] : body[k]);
  const title = String(pick('title') ?? '').trim();
  if (!title) throw new ApiError('任务名称不能为空');
  if (title.length > 100) throw new ApiError('任务名称最多 100 个字');
  const tag = pick('tag') || '规划';
  if (!TAGS.includes(tag)) throw new ApiError('类型只能从给出的几种里选');
  const date = String(pick('date') ?? '');
  if (!isDate(date)) throw new ApiError('日期格式不对');
  const start = parseTime(body.start_time === undefined ? base.start_time : body.start_time, '开始时间');
  let end = parseTime(body.end_time === undefined ? base.end_time : body.end_time, '结束时间');
  if (!start) end = null;
  if (start && end && end <= start) throw new ApiError('结束时间要晚于开始时间');
  return { title, tag, date, start, end };
}

const out = (t) => t && { ...t, done: Boolean(t.done) };

function listTasks(today) {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 60);
  return q.listTasks.all(since.toISOString().slice(0, 10)).map(out);
}

function createTask(body) {
  const t = parseTask(body);
  const now = Date.now();
  const { lastInsertRowid } = q.insertTask.run(t.title, t.tag, t.date, t.start, t.end, now, now);
  return out(q.getTask.get(lastInsertRowid));
}

function updateTask(id, body) {
  const cur = q.getTask.get(id);
  if (!cur) throw new ApiError('任务不存在', 404);
  const t = parseTask(body, cur);
  const done = body.done === undefined ? Boolean(cur.done) : Boolean(body.done);
  const doneAt = done ? cur.done_at || Date.now() : null;
  q.updateTask.run(t.title, t.tag, t.date, t.start, t.end, done ? 1 : 0, doneAt, Date.now(), id);
  return out(q.getTask.get(id));
}

function deleteTask(id) {
  if (!q.getTask.get(id)) throw new ApiError('任务不存在', 404);
  q.deleteTask.run(id);
}

module.exports = { TAGS, listTasks, createTask, updateTask, deleteTask };
