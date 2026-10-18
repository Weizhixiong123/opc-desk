const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,              -- income | expense
    name      TEXT NOT NULL,
    sort      INTEGER NOT NULL DEFAULT 0,
    archived  INTEGER NOT NULL DEFAULT 0, -- 停用后新记账里不再显示，旧账保留
    UNIQUE (type, name)
  );

  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,            -- income | expense
    amount      INTEGER NOT NULL,         -- 单位：分，始终为正数
    category_id INTEGER NOT NULL REFERENCES categories(id),
    date        TEXT NOT NULL,            -- YYYY-MM-DD
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);

  -- 专注计时：ended_at 为空表示正在计时，同一时间最多一条
  CREATE TABLE IF NOT EXISTS focus_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,            -- deep | other
    date        TEXT NOT NULL,            -- 开始那天，YYYY-MM-DD
    started_at  INTEGER NOT NULL,         -- 毫秒
    ended_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_focus_date ON focus_sessions(date);

  -- 我的任务；start_time/end_time 可空，格式 HH:MM
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    tag         TEXT NOT NULL,
    date        TEXT NOT NULL,            -- YYYY-MM-DD
    start_time  TEXT,
    end_time    TEXT,
    done        INTEGER NOT NULL DEFAULT 0,
    done_at     INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date);

  -- 个人资料和偏好，value 存 JSON
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 首次启动放一套一人公司常用分类，之后可以在「设置」里增改
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const seed = {
    income: ['服务收入', '产品销售', '订阅收入', '其他收入'],
    expense: ['服务器/云', '软件订阅', '广告推广', '外包', '办公', '交通', '餐饮', '税费', '其他支出'],
  };
  const ins = db.prepare('INSERT INTO categories (type, name, sort) VALUES (?, ?, ?)');
  for (const [type, names] of Object.entries(seed)) names.forEach((n, i) => ins.run(type, n, i));
}

const ENTRY_COLS = `e.id, e.type, e.amount, e.category_id, c.name AS category, e.date, e.note`;

const q = {
  listCategories: db.prepare('SELECT * FROM categories ORDER BY type, archived, sort, id'),
  getCategory: db.prepare('SELECT * FROM categories WHERE id = ?'),
  findCategory: db.prepare('SELECT * FROM categories WHERE type = ? AND name = ?'),
  maxCategorySort: db.prepare('SELECT COALESCE(MAX(sort), -1) AS n FROM categories WHERE type = ?'),
  insertCategory: db.prepare('INSERT INTO categories (type, name, sort) VALUES (?, ?, ?)'),
  updateCategory: db.prepare('UPDATE categories SET name = ?, archived = ? WHERE id = ?'),
  deleteCategory: db.prepare('DELETE FROM categories WHERE id = ?'),
  countEntriesInCategory: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE category_id = ?'),

  getEntry: db.prepare(`SELECT ${ENTRY_COLS} FROM entries e JOIN categories c ON c.id = e.category_id WHERE e.id = ?`),
  listEntries: db.prepare(`
    SELECT ${ENTRY_COLS} FROM entries e JOIN categories c ON c.id = e.category_id
    WHERE e.date >= ?1 AND e.date <= ?2
      AND (?3 = '' OR e.type = ?3)
      AND (?4 = 0 OR e.category_id = ?4)
      AND (?5 = '' OR e.note LIKE ?5 OR c.name LIKE ?5)
    ORDER BY e.date DESC, e.id DESC
  `),
  insertEntry: db.prepare(`
    INSERT INTO entries (type, amount, category_id, date, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateEntry: db.prepare(`
    UPDATE entries SET type = ?, amount = ?, category_id = ?, date = ?, note = ?, updated_at = ? WHERE id = ?
  `),
  deleteEntry: db.prepare('DELETE FROM entries WHERE id = ?'),

  totalsBetween: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense,
      COUNT(*) AS count
    FROM entries WHERE date >= ? AND date <= ?
  `),
  byCategoryBetween: db.prepare(`
    SELECT e.type, c.id, c.name, SUM(e.amount) AS amount, COUNT(*) AS count
    FROM entries e JOIN categories c ON c.id = e.category_id
    WHERE e.date >= ? AND e.date <= ?
    GROUP BY e.type, c.id ORDER BY amount DESC
  `),
  byMonthBetween: db.prepare(`
    SELECT substr(date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
    FROM entries WHERE date >= ? AND date <= ?
    GROUP BY month ORDER BY month
  `),

  runningFocus: db.prepare('SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'),
  insertFocus: db.prepare('INSERT INTO focus_sessions (kind, date, started_at) VALUES (?, ?, ?)'),
  getFocus: db.prepare('SELECT * FROM focus_sessions WHERE id = ?'),
  stopFocus: db.prepare('UPDATE focus_sessions SET ended_at = ? WHERE id = ?'),
  deleteFocus: db.prepare('DELETE FROM focus_sessions WHERE id = ?'),
  focusBetween: db.prepare('SELECT * FROM focus_sessions WHERE date >= ? AND date <= ? ORDER BY started_at'),

  // 没完成的全部要；完成的只要最近 60 天的，列表不会越来越长
  listTasks: db.prepare(`
    SELECT * FROM tasks WHERE done = 0 OR date >= ?
    -- 没完成的按日期从早到晚；完成的最近做的排前面
    ORDER BY done,
      CASE WHEN done = 0 THEN date END,
      CASE WHEN done = 1 THEN date END DESC,
      COALESCE(start_time, '99:99'), id
  `),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  insertTask: db.prepare(`
    INSERT INTO tasks (title, tag, date, start_time, end_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateTask: db.prepare(`
    UPDATE tasks SET title = ?, tag = ?, date = ?, start_time = ?, end_time = ?, done = ?, done_at = ?, updated_at = ? WHERE id = ?
  `),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),

  allSettings: db.prepare('SELECT key, value FROM settings'),
  putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

module.exports = { db, q };
