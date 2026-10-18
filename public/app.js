'use strict';

const BASE = window.BASE || '';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  today: '',
  period: '', // YYYY-MM，收支日历、流水、分类共用
  view: 'home',
  settings: { name: '', title: '一人公司', motto: '', accent: '#a3e36b', hideAmt: false },
  entryType: '',
  keyword: '',
  dayFilter: '',
  selDay: '',
  categories: [],
  summary: null,
  monthRows: [],
  focus: null, // 最近一次拉到的专注汇总
  focusAt: 0, // 拉取时的本地时间，用来推算正在计时的那段
  focusKind: 'deep',
};

// ---- 工具 ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const yuan = (cents) => fmt2.format(Math.abs(cents) / 100);
const money = (cents) => `${cents < 0 ? '-' : ''}¥${yuan(cents)}`;
const whole = (cents) => fmt0.format(Math.abs(cents) / 100);
const tiny = (cents) => {
  const y = Math.abs(cents) / 100;
  // 手机日历格子窄：不加千分位，一万以上写成「1.3万」
  return y >= 10000 ? `${(y / 10000).toFixed(y >= 100000 ? 0 : 1).replace(/\.0$/, '')}万` : String(Math.round(y));
};
const monthText = (p) => `${p.slice(0, 4)}年${Number(p.slice(5))}月`;
const dayText = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`;
const weekday = (d) => `星期${'日一二三四五六'[new Date(`${d}T00:00:00`).getDay()]}`;
const sum = (rows, type) => rows.filter((r) => r.type === type).reduce((a, r) => a + r.amount, 0);
const icon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;
const hours = (secs) => (secs / 3600).toFixed(1).replace(/\.0$/, '');

function shiftMonth(p, delta) {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const lastDay = (p) => new Date(Number(p.slice(0, 4)), Number(p.slice(5)), 0).getDate();

// 人民币大写，记账时核对金额用
function rmbUpper(cents) {
  const digit = '零壹贰叁肆伍陆柒捌玖';
  const unit = ['', '拾', '佰', '仟'];
  const big = ['', '万', '亿', '万亿'];
  const y = Math.floor(cents / 100);
  const jiao = Math.floor(cents / 10) % 10;
  const fen = cents % 10;
  let out = '';
  if (y > 0) {
    const groups = [];
    for (let n = y; n > 0; n = Math.floor(n / 10000)) groups.push(n % 10000);
    let zero = false;
    for (let g = groups.length - 1; g >= 0; g--) {
      const v = groups[g];
      if (v === 0) { zero = out !== ''; continue; }
      if (zero || (out && v < 1000)) out += '零';
      zero = false;
      let s = '';
      let z = false;
      for (let i = 3; i >= 0; i--) {
        const d = Math.floor(v / 10 ** i) % 10;
        if (d === 0) { z = s !== ''; continue; }
        if (z) s += '零';
        z = false;
        s += digit[d] + unit[i];
      }
      out += s + big[g];
    }
    out += '元';
  }
  if (!jiao && !fen) return `${out || '零元'}整`;
  if (jiao) out += `${digit[jiao]}角`;
  else if (y) out += '零';
  if (fen) out += `${digit[fen]}分`;
  return out;
}

// 重新播放一次进场动画（同一个元素连续切换时也能看到）
function replay(el, cls = 'swap') {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// 工作台自己的确认 / 输入弹窗。value 为 null 时只确认，返回 true/false；否则返回填的文字，取消返回 null
let askDone = null;
function ask({ title, text = '', label = '', value = null, okText = '确定', danger = false, maxLength = 20 }) {
  const input = value !== null;
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-field').hidden = !input;
  $('#ask-label').textContent = label;
  $('#ask-input').value = input ? value : '';
  $('#ask-input').maxLength = maxLength;
  $('#ask-err').textContent = '';
  $('#ask-ok').textContent = okText;
  $('#ask-ok').className = `btn ${danger ? 'red' : 'dark'}`;
  $('#ask').hidden = false;
  setTimeout(() => {
    if (input) {
      $('#ask-input').focus();
      $('#ask-input').select();
    } else {
      $('#ask-ok').focus();
    }
  }, 30);
  return new Promise((resolve) => {
    askDone = (ok) => {
      $('#ask').hidden = true;
      askDone = null;
      resolve(input ? (ok ? $('#ask-input').value.trim() : null) : ok);
    };
  });
}
$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('#ask-field').hidden && !$('#ask-input').value.trim()) {
    $('#ask-err').textContent = '不能为空';
    return;
  }
  askDone?.(true);
});
$$('[data-ask-cancel]').forEach((el) => el.addEventListener('click', () => askDone?.(false)));
// Esc 先关最上面的确认弹窗，不连带关掉下面的记账弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && askDone) {
    e.stopImmediatePropagation();
    askDone(false);
  }
}, true);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error(data.error || '请先登录');
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// ---- 登录 / 账号 ----
function showLogin() {
  $('#app').hidden = true;
  $('#sheet').hidden = true;
  $('#login').hidden = false;
  $('#login-pw').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: $('#login-pw').value } });
    $('#login-pw').value = '';
    await boot();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

$$('[data-soon]').forEach((b) => b.addEventListener('click', () => toast(`「${b.dataset.soon}」还在开发`)));

// ---- 个人资料、主题色 ----
function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty('--accent', s.accent);
  const initial = (s.name || '我').trim().slice(0, 1).toUpperCase();
  // 有头像用图片，没有就显示名字首字母
  $$('[data-avatar]').forEach((el) => {
    if (s.avatarAt) el.innerHTML = `<img src="${BASE}/api/avatar?v=${s.avatarAt}" alt="">`;
    else el.textContent = initial;
  });
  $('#avatar-remove').hidden = !s.avatarAt;
  $$('[data-profile-name]').forEach((el) => (el.textContent = s.name || '还没填名字'));
  $$('[data-profile-title]').forEach((el) => (el.textContent = s.title || '一人公司'));
  $$('[data-profile-sub]').forEach((el) => (el.textContent = `${s.title || '一人公司'}，一人工作室`));
}

async function saveSettings(patch) {
  try {
    state.settings = await api('/settings', { method: 'PATCH', body: patch });
  } catch (err) {
    toast(err.message);
    return;
  }
  applySettings();
  renderSettings();
  if (state.view === 'home') setHead();
}

// ---- 搜索 ----
$('#global-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  state.keyword = e.target.value.trim();
  state.dayFilter = '';
  setView('entries');
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#global-search').focus();
  }
});

// ---- 月份 ----
function setPeriod(p) {
  state.period = p;
  state.selDay = '';
  state.dayFilter = '';
  $$('[data-period-label]').forEach((el) => (el.textContent = monthText(p)));
  monthChanged = true;
  refresh();
}
// 换月份后，数据回来时让日历、列表淡入一下
let monthChanged = false;
function afterMonthRender(...els) {
  if (!monthChanged) return;
  monthChanged = false;
  els.forEach((el) => replay(el));
}
$$('[data-shift]').forEach((b) => b.addEventListener('click', () => setPeriod(shiftMonth(state.period, Number(b.dataset.shift)))));
$$('[data-period-label]').forEach((b) => b.addEventListener('click', () => setPeriod(state.today.slice(0, 7))));

// ---- 视图 ----
const VIEWS = ['home', 'tasks', 'ledger', 'entries', 'categories', 'settings'];
function setHead(sub) {
  const s = state.settings;
  const titles = {
    // 总览的标题就是今天；副标题在数据回来后写今天的实际情况
    home: `${dayText(state.today)} ${weekday(state.today)}`,
    tasks: '我的任务',
    ledger: '收支日历',
    entries: '流水明细',
    categories: '分类',
    settings: '设置',
  };
  $('#head-title').textContent = titles[state.view];
  if (sub !== undefined) $('#head-sub').textContent = sub;
  else if (state.view === 'home' && s.motto) $('#head-sub').textContent = s.motto;
  else if (state.view === 'settings') $('#head-sub').textContent = '个人资料与偏好';
}

function setView(v) {
  state.view = v;
  $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $$('.view').forEach((s) => (s.hidden = s.id !== `view-${v}`));
  replay($(`#view-${v}`), 'enter');
  $('#head-sub').textContent = '';
  setHead();
  try { localStorage.setItem('opc.view', v); } catch {}
  window.scrollTo(0, 0);
  refresh();
}
$$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function refresh() {
  if (state.view === 'home') loadHome();
  else if (state.view === 'tasks') loadTasksView();
  else if (state.view === 'ledger') loadLedger();
  else if (state.view === 'entries') loadEntries();
  else if (state.view === 'categories') loadCategoriesView();
  else renderSettings();
}

// ---- 流水条目 ----
// 分类没有单独存图标，收入用向上箭头，支出用向下箭头
const entryCache = new Map();
function rowHtml(r, { showDate = false } = {}) {
  entryCache.set(r.id, r);
  const isInc = r.type === 'income';
  const title = r.note || r.category;
  const sub = [r.note ? r.category : '', showDate ? dayText(r.date) : ''].filter(Boolean).join('，');
  return `<div class="row-item">
    <button class="row-main" data-edit="${r.id}">
      <span class="row-ic ${isInc ? 'inc' : ''}">${icon(isInc ? 'up' : 'down')}</span>
      <span class="row-text"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="row-amt n ${isInc ? 'inc' : ''}">${isInc ? '+' : '-'}${yuan(r.amount)}</span>
    </button>
    <button class="row-del" data-del="${r.id}" aria-label="删除这笔">${icon('x')}</button>
  </div>`;
}
document.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openSheet(entryCache.get(Number(edit.dataset.edit)));
  const del = e.target.closest('[data-del]');
  if (del) {
    const r = entryCache.get(Number(del.dataset.del));
    if (!r) return;
    const ok = await ask({
      title: '删除这笔流水？',
      text: `「${r.note || r.category}」${money(r.type === 'income' ? r.amount : -r.amount)}，删除后不能恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/entries/${r.id}`, { method: 'DELETE' });
    } catch (err) {
      return toast(err.message);
    }
    toast('已删除');
    refresh();
  }
});

// ---- 总览 ----
async function loadHome() {
  const month = state.today.slice(0, 7);
  let s, rows;
  try {
    [s, rows] = await Promise.all([api(`/summary?period=${month}`), api(`/entries?period=${month}`), loadFocus(), loadTasks()]);
  } catch (e) {
    return toast(e.message);
  }
  if (state.view !== 'home') return;
  const hide = state.settings.hideAmt;
  const mask = (v) => (hide ? '****' : v);
  $('#home-month').textContent = `${Number(month.slice(5))}月账目`;
  $('#home-net').textContent = hide ? '¥ ****' : money(s.profit);
  $('#home-net').classList.toggle('neg-text', s.profit < 0);
  $('#home-inc').textContent = mask(yuan(s.income));
  $('#home-exp').textContent = mask(yuan(s.expense));
  const top = s.categories.filter((c) => c.type === 'expense').slice(0, 3);
  $('#home-top3').innerHTML = top.length
    ? top.map((c) => `<span class="mb-row"><span>${esc(c.name)}</span><span class="bar"><i style="width:${(c.amount / top[0].amount) * 100}%"></i></span><span class="val n">${mask(whole(c.amount))}</span></span>`).join('')
    : '<span class="muted">本月还没有支出</span>';
  renderDaily(month, rows, hide);
  $('#home-recent').innerHTML = rows.length
    ? rows.slice(0, 20).map((r) => rowHtml(r, { showDate: true })).join('')
    : '<p class="empty">这个月还没有流水。点右上角「记一笔」开始。</p>';

  renderFocus();
  renderHomeTasks();
  // 副标题：没写个人副标题时，用一句话说今天的情况
  if (!state.settings.motto) {
    const t = focusToday();
    const todo = todayTodo().length;
    const parts = [todo ? `今天还有 ${todo} 项待办` : '今天的任务都做完了'];
    parts.push(t ? `已专注 ${hours(t)} 小时` : '还没开始专注');
    if (!hide) parts.push(`本月净收入 ${money(s.profit)}`);
    $('#head-sub').textContent = `${parts.join('，')}。`;
  }
}

// 本月每天的收入（中线上方）和支出（下方），收支两边用同一个比例
function renderDaily(month, rows, hide) {
  const days = lastDay(month);
  const inc = new Array(days + 1).fill(0);
  const exp = new Array(days + 1).fill(0);
  for (const r of rows) (r.type === 'income' ? inc : exp)[Number(r.date.slice(8))] += r.amount;
  const max = Math.max(1, ...inc, ...exp);
  let html = '';
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const tip = hide ? dayText(date) : `${dayText(date)}：收入 ${whole(inc[d])}，支出 ${whole(exp[d])}`;
    html += `<span class="${date > state.today ? 'future' : ''}" title="${tip}">
      <span class="up">${inc[d] ? `<i style="height:${(inc[d] / max) * 100}%"></i>` : ''}</span>
      <span class="dn">${exp[d] ? `<i style="height:${(exp[d] / max) * 100}%"></i>` : ''}</span>
    </span>`;
  }
  $('#home-daily').innerHTML = html;
  $('#home-daily-mid').textContent = `${Math.ceil(days / 2)}日`;
  $('#home-daily-end').textContent = `${days}日`;
}

function focusToday() {
  const f = state.focus;
  if (!f) return 0;
  const cur = f.current;
  return f.today + (cur && cur.date === state.today ? Math.max(0, Math.round((Date.now() - state.focusAt) / 1000)) : 0);
}

// ---- 专注计时 ----
async function loadFocus() {
  state.focus = await api('/focus');
  state.focusAt = Date.now();
}

// 正在计时的那段到现在为止多少秒
function runningSecs() {
  const f = state.focus;
  if (!f?.current) return 0;
  return Math.max(0, Math.round((f.now + (Date.now() - state.focusAt) - f.current.started_at) / 1000));
}

function renderFocus() {
  const f = state.focus;
  if (!f) return;
  const run = runningSecs();
  const cur = f.current;
  const todayIdx = f.week.findIndex((d) => d.date === state.today);
  // 服务器已把正在计时的那段算到拉取时为止，这里只补上拉取之后过去的秒数
  const extra = cur ? Math.max(0, Math.round((Date.now() - state.focusAt) / 1000)) : 0;
  const kindKey = cur?.kind === 'other' ? 'other' : 'deep';
  const week = f.week.map((d) => (cur && d.date === cur.date ? { ...d, [kindKey]: d[kindKey] + extra } : d));
  const today = f.today + (cur && cur.date === state.today ? extra : 0);

  $('#focus-today').textContent = hours(today);
  const diff = today - f.yesterday;
  $('#focus-vs').textContent = !today && !f.yesterday
    ? '选好类型，点「开始计时」。'
    : !f.yesterday ? '昨天没有记录。'
    : Math.abs(diff) < 360 ? '和昨天差不多。' : `比昨天${diff > 0 ? '多' : '少'} ${hours(Math.abs(diff))} 小时。`;

  const deepSum = week.reduce((a, d) => a + d.deep, 0);
  const otherSum = week.reduce((a, d) => a + d.other, 0);
  $('#focus-week').innerHTML = deepSum + otherSum
    ? `本周 <b>${hours(deepSum + otherSum)}</b> 小时，其中深度工作 <b>${hours(deepSum)}</b>，其他 <b>${hours(otherSum)}</b>。`
    : '本周还没有专注记录。';

  // 柱子按本周最长那天缩放，最少按 6 小时算，免得一点时长就顶满
  const maxSecs = Math.max(6 * 3600, ...week.map((d) => d.deep + d.other));
  $('#focus-bars').innerHTML = week
    .map((d) => `<div title="${dayText(d.date)}：深度工作 ${hours(d.deep)} 小时，其他 ${hours(d.other)} 小时">
      <i class="other" style="height:${(d.other / maxSecs) * 100}%"></i>
      <i class="deep" style="height:${(d.deep / maxSecs) * 100}%"></i>
    </div>`)
    .join('');
  $('#focus-days').innerHTML = week
    .map((d, i) => `<span class="${i === todayIdx ? 'today-d' : ''}">${i === todayIdx ? '今天' : '一二三四五六日'[i]}</span>`)
    .join('');

  $('#focus-idle').hidden = Boolean(cur);
  $('#focus-running').hidden = !cur;
  if (cur) {
    $('#focus-kind-label').textContent = cur.kind === 'other' ? '其他' : '深度工作';
    const s = run;
    const hh = Math.floor(s / 3600);
    $('#focus-clock').textContent = `${hh ? `${hh}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
}

setInterval(() => {
  if (state.view === 'home' && state.focus?.current) renderFocus();
}, 1000);

$$('#focus-kind button').forEach((b) =>
  b.addEventListener('click', () => {
    state.focusKind = b.dataset.kind;
    $$('#focus-kind button').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
  })
);
$('#focus-start').addEventListener('click', async () => {
  try {
    state.focus = await api('/focus/start', { method: 'POST', body: { kind: state.focusKind } });
    state.focusAt = Date.now();
  } catch (err) {
    return toast(err.message);
  }
  renderFocus();
});
$('#focus-stop').addEventListener('click', async () => {
  try {
    state.focus = await api('/focus/stop', { method: 'POST', body: {} });
    state.focusAt = Date.now();
  } catch (err) {
    return toast(err.message);
  }
  toast(state.focus.discarded ? '不到 1 分钟，这段没有记录' : '已记录这段专注');
  renderFocus();
});

// ---- 我的任务 ----
const TAGS = ['设计', '开发', '内容', '沟通', '整理', '规划', '学习'];
state.tasks = [];
state.taskFilter = 'all';

function shiftDay(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function dateLabel(d) {
  if (d === state.today) return '今天';
  if (d === shiftDay(state.today, 1)) return '明天';
  if (d === shiftDay(state.today, -1)) return '昨天';
  return dayText(d);
}
// 本周一到本周日
function thisWeek() {
  const dow = new Date(`${state.today}T00:00:00Z`).getUTCDay();
  const mon = shiftDay(state.today, -((dow + 6) % 7));
  return [mon, shiftDay(mon, 6)];
}
const isLate = (t) => !t.done && t.date < state.today;
// 以前的任务今天才做完，也算在今天里，勾完不会突然消失
const doneToday = (t) => t.done && t.done_at && new Date(t.done_at).toLocaleDateString('sv-SE') === state.today;
const inToday = (t) => t.date === state.today || isLate(t) || doneToday(t);
// 今天要做的：今天的，加上以前没做完的
const todayTodo = () => state.tasks.filter((t) => !t.done && t.date <= state.today);

async function loadTasks() {
  state.tasks = await api('/tasks');
  updateTaskBadge();
}
function updateTaskBadge() {
  const n = todayTodo().length;
  $('#nav-task-count').textContent = n ? String(n) : '';
}

const timeText = (t) => (t.start_time ? (t.end_time ? `${t.start_time}-${t.end_time}` : t.start_time) : '');
function taskRow(t, { showDate = true } = {}) {
  const cls = ['task-row', t.done ? 'done' : '', isLate(t) ? 'late' : ''].join(' ');
  const dateCls = isLate(t) ? 'late' : t.date === state.today ? 'is-today' : '';
  const meta = timeText(t);
  return `<div class="${cls}">
    <button class="check" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? '标记为没完成' : '标记为完成'}：${esc(t.title)}" data-task-toggle="${t.id}">${icon('check')}</button>
    <button class="task-main" data-task-edit="${t.id}"><b>${esc(t.title)}</b>${meta ? `<small>${meta}</small>` : ''}</button>
    ${showDate ? `<span class="task-date ${dateCls}">${isLate(t) ? `逾期，${dateLabel(t.date)}` : dateLabel(t.date)}</span>` : ''}
    <span class="tag tag-${t.tag}">${t.tag}</span>
    <button class="row-del" data-task-del="${t.id}" aria-label="删除任务">${icon('x')}</button>
  </div>`;
}

const TASK_FILTERS = {
  all: () => true,
  today: inToday,
  upcoming: (t) => !t.done && t.date > state.today,
  done: (t) => t.done,
};

function renderHomeTasks() {
  const list = state.tasks.filter(inToday);
  const done = list.filter((t) => t.done).length;
  $('#home-task-link').textContent = list.length ? `${done} / ${list.length} 已完成` : '全部任务';
  $('#home-tasks').innerHTML = list.length
    ? list.map((t) => taskRow(t, { showDate: t.date !== state.today })).join('')
    : '<p class="empty">今天还没有任务。在下面写一项，回车就加上。</p>';
}

async function loadTasksView() {
  try {
    await loadTasks();
  } catch (e) {
    return toast(e.message);
  }
  renderTasksView();
}

function renderTasksView() {
  const tasks = state.tasks;
  const open = tasks.filter((t) => !t.done).length;
  setHead(`共 ${tasks.length} 项，未完成 ${open} 项`);
  $$('#task-filter button').forEach((b) => {
    b.classList.toggle('on', b.dataset.filter === state.taskFilter);
    b.querySelector('span').textContent = tasks.filter(TASK_FILTERS[b.dataset.filter]).length;
  });
  const list = tasks.filter(TASK_FILTERS[state.taskFilter]);
  const empty = {
    all: '还没有任务。在上面写一项，回车就加上。',
    today: '今天没有要做的事。',
    upcoming: '后面几天还没有安排。',
    done: '还没有完成的任务。',
  };
  $('#task-list').innerHTML = list.length ? list.map((t) => taskRow(t)).join('') : `<p class="empty">${empty[state.taskFilter]}</p>`;

  // 概况
  const todayList = tasks.filter((t) => t.date === state.today);
  const todayDone = todayList.filter((t) => t.done).length;
  $('#ts-today').innerHTML = `${todayDone} <small>/ ${todayList.length}</small>`;
  $('#ts-today-bar').style.width = `${todayList.length ? (todayDone / todayList.length) * 100 : 0}%`;
  $('#ts-open').textContent = open;
  const [mon, sun] = thisWeek();
  $('#ts-week').textContent = tasks.filter((t) => t.done && t.date >= mon && t.date <= sun).length;
  const byTag = new Map();
  for (const t of tasks) if (!t.done) byTag.set(t.tag, (byTag.get(t.tag) || 0) + 1);
  const tags = [...byTag].sort((a, b) => b[1] - a[1]);
  const max = tags[0]?.[1] || 1;
  $('#ts-tags').innerHTML = tags.length
    ? tags.map(([name, n]) => `<li><span>${name}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="val n">${n}</span></li>`).join('')
    : '<li class="muted">都做完了</li>';
}

function afterTaskChange() {
  updateTaskBadge();
  if (state.view === 'tasks') renderTasksView();
  if (state.view === 'home') loadHome();
}

$('#task-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.taskFilter = b.dataset.filter;
  renderTasksView();
  replay($('#task-list'));
});

$('#ta-tag').innerHTML = TAGS.map((t) => `<option>${t}</option>`).join('');
$('#ta-tag').value = '规划';
$('#task-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    title: $('#ta-title').value, tag: $('#ta-tag').value, date: $('#ta-date').value || state.today,
    start_time: $('#ta-start').value, end_time: $('#ta-end').value,
  };
  // 只填了结束、没填开始，说清楚而不是悄悄丢掉
  if (body.end_time && !body.start_time) return toast('填了结束时间，也要填开始时间');
  try {
    await api('/tasks', { method: 'POST', body });
  } catch (err) {
    return toast(err.message);
  }
  $('#ta-title').value = '';
  $('#ta-start').value = '';
  $('#ta-end').value = '';
  toast('已添加任务');
  await loadTasks();
  afterTaskChange();
  $('#ta-title').focus();
});
$('#home-task-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#home-task-title').value;
  if (!title.trim()) return;
  try {
    await api('/tasks', { method: 'POST', body: { title, date: state.today } });
  } catch (err) {
    return toast(err.message);
  }
  $('#home-task-title').value = '';
  await loadTasks();
  renderHomeTasks();
  updateTaskBadge();
});

document.addEventListener('click', async (e) => {
  const tog = e.target.closest('[data-task-toggle]');
  if (tog) {
    const t = state.tasks.find((x) => x.id === Number(tog.dataset.taskToggle));
    if (!t) return;
    // 先在界面上勾上，请求失败再改回来
    t.done = !t.done;
    afterTaskChangeLocal();
    try {
      Object.assign(t, await api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: t.done } }));
    } catch (err) {
      t.done = !t.done;
      toast(err.message);
    }
    afterTaskChangeLocal();
    return;
  }
  const edit = e.target.closest('[data-task-edit]');
  if (edit) return openTask(state.tasks.find((x) => x.id === Number(edit.dataset.taskEdit)));
  const del = e.target.closest('[data-task-del]');
  if (del) {
    const t = state.tasks.find((x) => x.id === Number(del.dataset.taskDel));
    if (t && (await ask({ title: '删除这个任务？', text: `「${t.title}」，删除后不能恢复。`, okText: '删除', danger: true }))) deleteTask(t);
  }
});
// 勾选只重画任务部分，不重新拉总览的其他数据
function afterTaskChangeLocal() {
  updateTaskBadge();
  if (state.view === 'tasks') renderTasksView();
  if (state.view === 'home') renderHomeTasks();
}

async function deleteTask(t) {
  try {
    await api(`/tasks/${t.id}`, { method: 'DELETE' });
  } catch (err) {
    return toast(err.message);
  }
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  toast('已删除任务');
  closeTask();
  afterTaskChangeLocal();
}

// 修改任务
let editingTask = null;
let editTag = '规划';
function renderTaskTags() {
  $('#tf-tags').innerHTML = TAGS.map((t) => `<button type="button" data-tag="${t}" class="${t === editTag ? 'on' : ''}" aria-pressed="${t === editTag}">${t}</button>`).join('');
}
function openTask(t) {
  if (!t) return;
  editingTask = t;
  editTag = t.tag;
  $('#tf-title').value = t.title;
  $('#tf-date').value = t.date;
  $('#tf-start').value = t.start_time || '';
  $('#tf-end').value = t.end_time || '';
  $('#tf-err').textContent = '';
  renderTaskTags();
  $('#task-sheet').hidden = false;
  setTimeout(() => $('#tf-title').focus(), 50);
}
const closeTask = () => ($('#task-sheet').hidden = true);
$$('[data-task-close]').forEach((el) => el.addEventListener('click', closeTask));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#task-sheet').hidden) closeTask();
});
$('#tf-tags').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  editTag = b.dataset.tag;
  renderTaskTags();
});
$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { title: $('#tf-title').value, tag: editTag, date: $('#tf-date').value, start_time: $('#tf-start').value, end_time: $('#tf-end').value };
  if (body.end_time && !body.start_time) {
    $('#tf-err').textContent = '填了结束时间，也要填开始时间';
    return;
  }
  try {
    Object.assign(editingTask, await api(`/tasks/${editingTask.id}`, { method: 'PATCH', body }));
  } catch (err) {
    $('#tf-err').textContent = err.message;
    return;
  }
  toast('已保存任务');
  closeTask();
  await loadTasks();
  afterTaskChangeLocal();
});
$('#tf-delete').addEventListener('click', async () => {
  if (!editingTask) return;
  if (await ask({ title: '删除这个任务？', text: `「${editingTask.title}」，删除后不能恢复。`, okText: '删除', danger: true })) deleteTask(editingTask);
});

// ---- 收支日历 ----
async function loadLedger() {
  const period = state.period;
  let s, rows;
  try {
    [s, rows] = await Promise.all([api(`/summary?period=${period}`), api(`/entries?period=${period}`)]);
  } catch (e) {
    return toast(e.message);
  }
  if (period !== state.period || state.view !== 'ledger') return;
  state.summary = s;
  state.monthRows = rows;
  setHead(`${monthText(period)}，已记 ${rows.length} 笔，按实际收付款日期记录`);

  $('#sum-net').textContent = money(s.profit);
  $('#sum-net').closest('.sum-cell').classList.toggle('neg', s.profit < 0);
  $('#sum-inc').textContent = money(s.income);
  $('#sum-exp').textContent = money(s.expense);

  // 默认选中：今天在这个月就选今天，否则选最近一笔流水那天，都没有就选 1 号
  if (!state.selDay || state.selDay.slice(0, 7) !== period) {
    state.selDay = state.today.startsWith(period) ? state.today : rows[0]?.date || `${period}-01`;
  }
  renderCalendar();
  renderDay();
  const big = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 12);
  $('#big-list').innerHTML = big.length
    ? big.map((r) => rowHtml(r, { showDate: true })).join('')
    : `<p class="empty">${monthText(period)}还没有流水。</p>`;
  afterMonthRender($('.lsum'), $('#cal'), $('#day-card'), $('#big-list'));
}

function renderCalendar() {
  const p = state.period;
  const byDay = new Map();
  for (const r of state.monthRows) {
    const d = byDay.get(r.date) || { inc: 0, exp: 0 };
    d[r.type === 'income' ? 'inc' : 'exp'] += r.amount;
    byDay.set(r.date, d);
  }
  const narrow = matchMedia('(max-width: 719px)').matches;
  const maxInc = Math.max(1, ...[...byDay.values()].map((d) => d.inc));
  const first = new Date(Number(p.slice(0, 4)), Number(p.slice(5)) - 1, 1).getDay();
  let html = '<span class="day pad"></span>'.repeat(first);
  for (let i = 1; i <= lastDay(p); i++) {
    const date = `${p}-${String(i).padStart(2, '0')}`;
    const d = byDay.get(date);
    const cls = ['day'];
    // 收入越多底色越深，分三档
    if (d?.inc) cls.push(d.inc / maxInc > 0.66 ? 'l3' : d.inc / maxInc > 0.33 ? 'l2' : 'l1');
    if (date === state.today) cls.push('today');
    if (date > state.today) cls.push('future');
    if (date === state.selDay) cls.push('sel');
    const title = d ? `${dayText(date)}：收入 ${yuan(d.inc)}，支出 ${yuan(d.exp)}` : dayText(date);
    html += `<button class="${cls.join(' ')}" data-date="${date}" title="${title}" aria-pressed="${date === state.selDay}">
      <span class="dn n">${i}</span>
      ${d?.inc ? `<span class="di n">${narrow ? tiny(d.inc) : `+${whole(d.inc)}`}</span>` : ''}
      ${d?.exp ? `<span class="de n"><span class="lbl">支出 </span>-${narrow ? tiny(d.exp) : whole(d.exp)}</span>` : ''}
      ${d?.inc && d.exp > d.inc ? '<i class="loss" title="当天支出比收入多"></i>' : ''}
    </button>`;
  }
  $('#cal').innerHTML = html;
}
matchMedia('(max-width: 719px)').addEventListener('change', () => state.view === 'ledger' && state.monthRows && renderCalendar());

$('#cal').addEventListener('click', (e) => {
  const b = e.target.closest('.day[data-date]');
  if (!b) return;
  state.selDay = b.dataset.date;
  renderCalendar();
  renderDay();
  replay($('#day-card'));
});

function renderDay() {
  const d = state.selDay;
  const rows = state.monthRows
    .filter((r) => r.date === d)
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'income' ? -1 : 1));
  $('#day-date').textContent = dayText(d);
  $('#day-week').textContent = `${weekday(d)}${d === state.today ? '，今天' : ''}`;
  $('#day-inc').textContent = money(sum(rows, 'income'));
  $('#day-exp').textContent = money(sum(rows, 'expense'));
  $('#day-count').textContent = rows.length ? `当日流水 ${rows.length} 笔` : '当日流水';
  $('#day-list').innerHTML = rows.length
    ? rows.map((r) => rowHtml(r)).join('')
    : `<p class="empty">${d > state.today ? '这天还没到。' : '这天还没有流水。'}</p>`;
  $('#day-add-text').textContent = `给 ${dayText(d)}记一笔`;

  const top = state.summary.categories.filter((c) => c.type === 'expense').slice(0, 3);
  const max = top[0]?.amount || 1;
  $('#top3').innerHTML = top.length
    ? top.map((c) => `<li><span>${esc(c.name)}</span><span class="bar"><i style="width:${(c.amount / max) * 100}%"></i></span><span class="val n">${whole(c.amount)}</span></li>`).join('')
    : '<li class="muted">本月还没有支出</li>';
}
$('#day-add').addEventListener('click', () => openSheet(null, { date: state.selDay }));

// ---- 流水明细 ----
let entriesReq = 0;
async function loadEntries() {
  const id = ++entriesReq;
  const params = new URLSearchParams({ type: state.entryType, keyword: state.keyword });
  if (state.dayFilter) {
    params.set('from', state.dayFilter);
    params.set('to', state.dayFilter);
  } else {
    params.set('period', state.period);
  }
  const rows = await api(`/entries?${params}`).catch((e) => toast(e.message));
  if (!rows || id !== entriesReq) return;

  $('#day-filter').hidden = !state.dayFilter;
  $('#day-filter-text').textContent = state.dayFilter ? `只看 ${dayText(state.dayFilter)}` : '';
  $('#kw-filter').hidden = !state.keyword;
  $('#kw-filter-text').textContent = state.keyword ? `搜索：${state.keyword}` : '';
  if ($('#entry-search').value.trim() !== state.keyword) $('#entry-search').value = state.keyword;
  setHead(state.dayFilter ? `${dayText(state.dayFilter)} ${weekday(state.dayFilter)}` : monthText(state.period));

  const inc = sum(rows, 'income');
  const exp = sum(rows, 'expense');
  $('#entry-totals').innerHTML = rows.length
    ? `共 <b>${rows.length}</b> 笔，收入 <b class="n inc">${yuan(inc)}</b>，支出 <b class="n">${yuan(exp)}</b>`
    : '';
  // 右侧按分类汇总当前列表里的流水（跟着筛选条件变）
  for (const [type, sel] of [['expense', '#entries-cat-exp'], ['income', '#entries-cat-inc']]) {
    const by = new Map();
    for (const r of rows) if (r.type === type) by.set(r.category, (by.get(r.category) || 0) + r.amount);
    const list = [...by].sort((a, b) => b[1] - a[1]);
    const max = list[0]?.[1] || 1;
    $(sel).innerHTML = list.length
      ? list.map(([name, v]) => `<li><span>${esc(name)}</span><span class="bar"><i style="width:${(v / max) * 100}%"></i></span><span class="val n">${whole(v)}</span></li>`).join('')
      : `<li class="muted">没有${type === 'income' ? '收入' : '支出'}</li>`;
  }

  if (!rows.length) {
    $('#entry-list').innerHTML = `<p class="empty">${state.keyword || state.entryType || state.dayFilter ? '没有符合条件的流水。' : `${monthText(state.period)}还没有流水，点「记一笔」开始。`}</p>`;
    return;
  }
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  $('#entry-list').innerHTML = [...byDate]
    .map(([date, list]) => {
      const net = sum(list, 'income') - sum(list, 'expense');
      return `<div class="date-head"><span>${dayText(date)} ${weekday(date)}</span><span class="n">${net >= 0 ? '+' : '-'}${yuan(net)}</span></div>
        ${list.map((r) => rowHtml(r)).join('')}`;
    })
    .join('');
  afterMonthRender($('#entry-list'));
}

function bindSeg(sel, onPick) {
  $$(`${sel} button`).forEach((b) =>
    b.addEventListener('click', () => {
      $$(`${sel} button`).forEach((x) => x.classList.toggle('on', x === b));
      onPick(b.dataset);
    })
  );
}
bindSeg('#entry-type', ({ type }) => {
  state.entryType = type;
  loadEntries();
});
$('#day-filter button').addEventListener('click', () => {
  state.dayFilter = '';
  loadEntries();
});
$('#kw-filter button').addEventListener('click', () => {
  state.keyword = '';
  $('#global-search').value = '';
  $('#entry-search').value = '';
  loadEntries();
});
let searchTimer;
$('#entry-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.keyword = e.target.value.trim();
    loadEntries();
  }, 250);
});

// ---- 分类 ----
async function loadCategories() {
  state.categories = await api('/categories');
}

async function loadCategoriesView() {
  try {
    [state.summary] = await Promise.all([api(`/summary?period=${state.period}`), loadCategories()]);
  } catch (e) {
    return toast(e.message);
  }
  setHead(monthText(state.period));
  renderCatBars();
  afterMonthRender($('#cat-bars-exp'), $('#cat-bars-inc'));
  for (const type of ['income', 'expense']) {
    const list = state.categories.filter((c) => c.type === type);
    $(`#cats-${type}`).innerHTML = list.length
      ? list
          .map((c) => `<li class="${c.archived ? 'archived' : ''}" data-id="${c.id}">
            <span class="row-ic ${type === 'income' ? 'inc' : ''}">${icon(type === 'income' ? 'up' : 'down')}</span>
            <span class="name">${esc(c.name)}</span>
            <button data-act="rename">改名</button>
            <button data-act="archive">${c.archived ? '启用' : '停用'}</button>
            <button data-act="delete">删除</button>
          </li>`)
          .join('')
      : '<li class="muted">还没有分类</li>';
  }
}

function renderCatBars() {
  renderCatBarsFor('expense', '#cat-bars-exp');
  renderCatBarsFor('income', '#cat-bars-inc');
  // 近 12 个月：点一个月就切过去
  const trend = state.summary.trend;
  const max = Math.max(1, ...trend.flatMap((t) => [t.income, t.expense]));
  $('#cat-months').innerHTML = trend
    .map((t) => `<button class="${t.month === state.period ? 'cur' : ''}" data-month="${t.month}" title="${monthText(t.month)}：收入 ${whole(t.income)}，支出 ${whole(t.expense)}">
      <span class="mb"><i class="inc" style="height:${(t.income / max) * 100}%"></i><i class="exp" style="height:${(t.expense / max) * 100}%"></i></span>
      <span class="ml">${Number(t.month.slice(5))}月</span>
    </button>`)
    .join('');
}
$('#cat-months').addEventListener('click', (e) => {
  const b = e.target.closest('[data-month]');
  if (b) setPeriod(b.dataset.month);
});
function renderCatBarsFor(type, sel) {
  const rows = state.summary.categories.filter((c) => c.type === type);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  $(sel).innerHTML = rows.length
    ? rows
        .map((r) => {
          const pct = (r.amount / total) * 100;
          return `<li><span>${esc(r.name)} <span class="muted">${r.count} 笔</span></span>
            <span class="val n">${yuan(r.amount)}<small>${pct.toFixed(pct < 10 ? 1 : 0)}%</small></span>
            <span class="bar"><i style="width:${pct}%"></i></span></li>`;
        })
        .join('')
    : `<li class="empty">本月没有${type === 'income' ? '收入' : '支出'}。</li>`;
}

async function catAction(fn) {
  try {
    await fn();
    await loadCategoriesView();
  } catch (err) {
    toast(err.message);
  }
}
$$('[data-add-cat]').forEach((b) =>
  b.addEventListener('click', async () => {
    const kind = b.dataset.addCat === 'income' ? '收入' : '支出';
    const name = await ask({ title: `添加${kind}分类`, label: '分类名', value: '', okText: '添加' });
    if (name) catAction(() => api('/categories', { method: 'POST', body: { type: b.dataset.addCat, name } }));
  })
);
$('#view-categories').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const c = state.categories.find((x) => x.id === Number(b.closest('li').dataset.id));
  if (!c) return;
  if (b.dataset.act === 'rename') {
    const name = await ask({ title: '修改分类名', text: `现在叫「${c.name}」，改名后以前的流水也会跟着显示新名字。`, label: '新名字', value: c.name, okText: '保存' });
    if (name && name !== c.name) catAction(() => api(`/categories/${c.id}`, { method: 'PATCH', body: { name } }));
  } else if (b.dataset.act === 'archive') {
    catAction(() => api(`/categories/${c.id}`, { method: 'PATCH', body: { archived: !c.archived } }));
  } else if (b.dataset.act === 'delete' && (await ask({ title: '删除这个分类？', text: `「${c.name}」。已经有流水的分类不能删除，只能停用。`, okText: '删除', danger: true }))) {
    catAction(() => api(`/categories/${c.id}`, { method: 'DELETE' }));
  }
});

// ---- 设置 ----
const SWATCHES = [['#a3e36b', '嫩芽绿'], ['#7fd1b0', '薄荷绿'], ['#f2c14e', '暖阳黄'], ['#9cc3ff', '天空蓝']];
function renderSettings() {
  const s = state.settings;
  for (const [id, key] of [['#s-name', 'name'], ['#s-title', 'title'], ['#s-motto', 'motto']]) {
    if (document.activeElement !== $(id)) $(id).value = s[key] || '';
  }
  $('#swatches').innerHTML = SWATCHES.map(
    ([hex, label]) => `<button style="background:${hex}" class="${hex === s.accent ? 'on' : ''}" data-accent="${hex}" aria-label="${label}" aria-pressed="${hex === s.accent}"></button>`
  ).join('');
  $('#s-hide').setAttribute('aria-checked', String(Boolean(s.hideAmt)));

  const year = state.today.slice(0, 4);
  const month = state.today.slice(0, 7);
  $('#export-period').href = `${BASE}/api/export.csv?period=${month}`;
  $('#export-period').textContent = `导出${monthText(month)}`;
  $('#export-year').href = `${BASE}/api/export.csv?period=${year}`;
  $('#export-year').textContent = `导出${year}年`;
  $('#export-all').href = `${BASE}/api/export.csv?from=2000-01-01&to=2099-12-31`;
}
for (const [id, key] of [['#s-name', 'name'], ['#s-title', 'title'], ['#s-motto', 'motto']]) {
  $(id).addEventListener('change', (e) => saveSettings({ [key]: e.target.value }));
}
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-accent]');
  if (b) saveSettings({ accent: b.dataset.accent });
});
$('#s-hide').addEventListener('click', () => saveSettings({ hideAmt: !state.settings.hideAmt }));

// 头像：在浏览器里裁成居中的正方形、缩到 256，再上传，几十 KB 就够
async function squareAvatar(file) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const size = Math.min(256, side);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  // PNG 可能有透明背景，保持 PNG；其他转成 JPG
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((ok) => canvas.toBlob(ok, type, 0.9));
}
$('#avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let blob;
  try {
    blob = await squareAvatar(file);
  } catch {
    return toast('这张图片读不出来，换一张 PNG 或 JPG 试试');
  }
  const res = await fetch(`${BASE}/api/avatar`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || '上传失败');
  state.settings = data;
  applySettings();
  toast('头像已更新');
});
$('#avatar-remove').addEventListener('click', async () => {
  if (!(await ask({ title: '移除头像？', text: '移除后显示名字的首字母，随时可以重新上传。', okText: '移除' }))) return;
  try {
    state.settings = await api('/avatar', { method: 'DELETE' });
  } catch (err) {
    return toast(err.message);
  }
  applySettings();
  toast('已移除头像');
});

// ---- 记一笔 ----
const form = { type: 'expense', categoryId: 0, editing: null };
const lastCat = { income: 0, expense: 0 };

function renderFormCats() {
  const list = state.categories.filter((c) => c.type === form.type && (!c.archived || c.id === form.categoryId));
  if (!list.some((c) => c.id === form.categoryId)) form.categoryId = lastCat[form.type] || list[0]?.id || 0;
  if (!list.some((c) => c.id === form.categoryId)) form.categoryId = list[0]?.id || 0;
  $('#f-cats').innerHTML = list.length
    ? list.map((c) => `<button type="button" data-id="${c.id}" class="${c.id === form.categoryId ? 'on' : ''}" aria-pressed="${c.id === form.categoryId}">${esc(c.name)}</button>`).join('')
    : '<span class="muted">还没有分类，先去「分类」添加一个。</span>';
}

function setFormType(t) {
  form.type = t;
  $$('#form-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  $('#f-note').placeholder = t === 'income' ? '如：品牌官网项目尾款' : '如：阿里云续费';
  renderFormCats();
}

function updateUpper() {
  const s = $('#f-amount').value.trim().replace(/[,，\s]/g, '');
  const el = $('#f-upper');
  el.classList.remove('bad');
  if (!s) el.textContent = '';
  else if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) > 1e10) {
    el.textContent = '金额只能是数字，最多两位小数';
    el.classList.add('bad');
  } else {
    const [y, f = ''] = s.split('.');
    el.textContent = `大写：${rmbUpper(Number(y) * 100 + Number(f.padEnd(2, '0')))}`;
  }
}
$('#f-amount').addEventListener('input', updateUpper);

function openSheet(entry, { date } = {}) {
  form.editing = entry || null;
  form.categoryId = entry?.category_id || 0;
  setFormType(entry?.type || form.type);
  $('#sheet-title').textContent = entry ? '修改这笔' : '记一笔';
  $('#f-amount').value = entry ? (entry.amount / 100).toFixed(2).replace(/\.00$/, '') : '';
  $('#f-date').value = entry?.date || date || state.today;
  $('#f-note').value = entry?.note || '';
  $('#form-err').textContent = '';
  $('#f-delete').hidden = !entry;
  updateUpper();
  $('#sheet').hidden = false;
  setTimeout(() => $('#f-amount').focus(), 50);
}
const closeSheet = () => ($('#sheet').hidden = true);

$$('[data-add]').forEach((b) => b.addEventListener('click', () => openSheet(null, { date: state.view === 'ledger' ? state.selDay : state.today })));
$$('[data-close]').forEach((el) => el.addEventListener('click', closeSheet));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});
$$('#form-type button').forEach((b) => b.addEventListener('click', () => setFormType(b.dataset.type)));
$('#f-cats').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  form.categoryId = Number(b.dataset.id);
  $$('#f-cats button').forEach((x) => {
    x.classList.toggle('on', x === b);
    x.setAttribute('aria-pressed', String(x === b));
  });
});

$('#entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    type: form.type,
    amount: $('#f-amount').value,
    category_id: form.categoryId,
    date: $('#f-date').value,
    note: $('#f-note').value,
  };
  let saved;
  try {
    saved = form.editing
      ? await api(`/entries/${form.editing.id}`, { method: 'PUT', body })
      : await api('/entries', { method: 'POST', body });
  } catch (err) {
    $('#form-err').textContent = err.message;
    return;
  }
  lastCat[form.type] = form.categoryId;
  toast(form.editing ? '已保存修改' : `已记一笔${form.type === 'income' ? '收入' : '支出'}`);
  // 记完把日历定位到这笔的日期
  if (saved.date.startsWith(state.period)) state.selDay = saved.date;
  closeSheet();
  refresh();
});

$('#f-delete').addEventListener('click', async () => {
  if (!form.editing) return;
  if (!(await ask({ title: '删除这笔流水？', text: '删除后不能恢复。', okText: '删除', danger: true }))) return;
  try {
    await api(`/entries/${form.editing.id}`, { method: 'DELETE' });
  } catch (err) {
    $('#form-err').textContent = err.message;
    return;
  }
  toast('已删除');
  closeSheet();
  refresh();
});

// ---- 启动 ----
async function boot() {
  let me;
  try {
    me = await api('/me');
  } catch {
    return; // 未登录时 api() 已切到登录页
  }
  state.today = me.today;
  state.settings = me.settings;
  if (!state.period) state.period = me.today.slice(0, 7);
  $$('[data-period-label]').forEach((el) => (el.textContent = monthText(state.period)));
  applySettings();
  await Promise.all([loadCategories(), loadTasks().catch(() => {})]);
  $('#ta-date').value = state.today;
  $('#login').hidden = true;
  $('#app').hidden = false;
  let v = 'home';
  try { v = localStorage.getItem('opc.view') || v; } catch {}
  setView(VIEWS.includes(v) ? v : 'home');
}

boot();
