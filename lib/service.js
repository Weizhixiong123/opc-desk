const { q } = require('./db');

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const TYPES = ['income', 'expense'];
const MAX_AMOUNT = 1e12; // 分，即 100 亿元

function parseType(v) {
  if (!TYPES.includes(v)) throw new ApiError('类型只能是收入或支出');
  return v;
}

// 金额按「元」传入，最多两位小数，存成整数分，避免浮点误差
function parseAmount(v) {
  const s = String(v ?? '').trim().replace(/[,，\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ApiError('金额格式不对，最多两位小数');
  const [yuan, frac = ''] = s.split('.');
  const cents = Number(yuan) * 100 + Number(frac.padEnd(2, '0'));
  if (cents <= 0) throw new ApiError('金额要大于 0');
  if (cents > MAX_AMOUNT) throw new ApiError('金额太大');
  return cents;
}

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!isDate(s)) throw new ApiError('日期格式不对');
  return s;
}

function parseNote(v) {
  const s = String(v ?? '').trim();
  if (s.length > 500) throw new ApiError('备注最多 500 字');
  return s;
}

function parseCategory(id, type) {
  const c = q.getCategory.get(Number(id) || 0);
  if (!c) throw new ApiError('请选择分类');
  if (c.type !== type) throw new ApiError('分类和收支类型不匹配');
  return c;
}

// 期间：YYYY-MM 为某月，YYYY 为全年
function periodRange(period) {
  const s = String(period || '');
  if (/^\d{4}-\d{2}$/.test(s) && isDate(`${s}-01`)) {
    const [y, m] = s.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${s}-01`, to: `${s}-${String(last).padStart(2, '0')}` };
  }
  if (/^\d{4}$/.test(s)) return { from: `${s}-01-01`, to: `${s}-12-31` };
  throw new ApiError('期间格式不对');
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

// ---- 分类 ----
function listCategories() {
  return q.listCategories.all();
}

function createCategory(body) {
  const type = parseType(body.type);
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 20) throw new ApiError('分类名 1~20 个字');
  if (q.findCategory.get(type, name)) throw new ApiError('已经有这个分类了');
  const sort = q.maxCategorySort.get(type).n + 1;
  const { lastInsertRowid } = q.insertCategory.run(type, name, sort);
  return q.getCategory.get(lastInsertRowid);
}

function updateCategory(id, body) {
  const c = q.getCategory.get(id);
  if (!c) throw new ApiError('分类不存在', 404);
  const name = body.name === undefined ? c.name : String(body.name).trim();
  if (!name || name.length > 20) throw new ApiError('分类名 1~20 个字');
  const dup = q.findCategory.get(c.type, name);
  if (dup && dup.id !== c.id) throw new ApiError('已经有这个分类了');
  const archived = body.archived === undefined ? c.archived : body.archived ? 1 : 0;
  q.updateCategory.run(name, archived, id);
  return q.getCategory.get(id);
}

// 有账目的分类不能删，只能停用
function deleteCategory(id) {
  if (!q.getCategory.get(id)) throw new ApiError('分类不存在', 404);
  if (q.countEntriesInCategory.get(id).n > 0) throw new ApiError('这个分类下还有账目，只能停用不能删除');
  q.deleteCategory.run(id);
}

// ---- 账目 ----
function parseEntry(body) {
  const type = parseType(body.type);
  return {
    type,
    amount: parseAmount(body.amount),
    category: parseCategory(body.category_id, type),
    date: parseDate(body.date),
    note: parseNote(body.note),
  };
}

function createEntry(body) {
  const e = parseEntry(body);
  const now = Date.now();
  const { lastInsertRowid } = q.insertEntry.run(e.type, e.amount, e.category.id, e.date, e.note, now, now);
  return q.getEntry.get(lastInsertRowid);
}

function updateEntry(id, body) {
  if (!q.getEntry.get(id)) throw new ApiError('账目不存在', 404);
  const e = parseEntry(body);
  q.updateEntry.run(e.type, e.amount, e.category.id, e.date, e.note, Date.now(), id);
  return q.getEntry.get(id);
}

function deleteEntry(id) {
  if (!q.getEntry.get(id)) throw new ApiError('账目不存在', 404);
  q.deleteEntry.run(id);
}

function listEntries({ from, to, period, type = '', category = 0, keyword = '' }) {
  if (period) ({ from, to } = periodRange(period));
  from = parseDate(from);
  to = parseDate(to);
  if (type) parseType(type);
  const kw = String(keyword).trim();
  return q.listEntries.all(from, to, type, Number(category) || 0, kw ? `%${kw}%` : '');
}

// ---- 汇总 ----
function summary(period) {
  const { from, to } = periodRange(period);
  const totals = q.totalsBetween.get(from, to);

  // 走势：月视图看截至当月的 12 个月，年视图看当年 12 个月
  const endMonth = period.length === 7 ? period : `${period}-12`;
  const startMonth = shiftMonth(endMonth, -11);
  const rows = q.byMonthBetween.all(`${startMonth}-01`, periodRange(endMonth).to);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const trend = Array.from({ length: 12 }, (_, i) => {
    const month = shiftMonth(startMonth, i);
    const r = byMonth.get(month);
    return { month, income: r?.income ?? 0, expense: r?.expense ?? 0 };
  });

  // 上一期，用来算环比
  const prev = period.length === 7 ? shiftMonth(period, -1) : String(Number(period) - 1);
  const p = periodRange(prev);
  const prevTotals = q.totalsBetween.get(p.from, p.to);

  return {
    period,
    from,
    to,
    income: totals.income,
    expense: totals.expense,
    profit: totals.income - totals.expense,
    count: totals.count,
    prev: { period: prev, income: prevTotals.income, expense: prevTotals.expense, profit: prevTotals.income - prevTotals.expense },
    categories: q.byCategoryBetween.all(from, to),
    trend,
  };
}

// ---- 导出 ----
function csvCell(v) {
  const s = String(v ?? '');
  // 以 = + - @ 开头的内容加单引号，防止 Excel 当成公式执行
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function exportCsv(query) {
  const rows = listEntries(query).reverse();
  const lines = [['日期', '类型', '分类', '金额', '备注']];
  for (const r of rows) {
    const amount = (r.amount / 100).toFixed(2);
    lines.push([r.date, r.type === 'income' ? '收入' : '支出', r.category, r.type === 'income' ? amount : `-${amount}`, r.note]);
  }
  // 金额列是程序生成的数字，不需要防公式转义
  return '﻿' + lines.map((l) => l.map((c, i) => (i === 3 && /^-?\d/.test(c) ? c : csvCell(c))).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  ApiError,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  createEntry,
  updateEntry,
  deleteEntry,
  listEntries,
  summary,
  exportCsv,
};
