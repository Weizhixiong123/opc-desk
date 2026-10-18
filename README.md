# opc-desk

一人公司的个人工作台。现在能用的是总览、专注计时和记账；任务、项目、知识库、日程、文件这几个模块还在开发。手机和电脑都能用。

- 零依赖：Node 22.13+ 自带的 `node:sqlite`，不用 `npm install`
- 数据只有一个 SQLite 文件（`data/app.db`），金额按「分」存整数
- 单用户，一个登录密码；登录后 30 天内免登录
- 手机上可以「添加到主屏幕」，打开后像 App 一样全屏

## 功能

| 页面 | 内容 |
|---|---|
| 总览 | 问候语、专注时长（今天、比昨天、本周按天的柱状图）、本月净收入；任务、项目、日程卡片在对应模块做好前显示为空 |
| 专注计时 | 总览「本周专注时长」里选「深度工作 / 其他」开始计时，结束后记一段；不到 1 分钟的不记 |
| 收支日历 | 本月收入、支出、净收入；按天的日历（收入越多底色越深）；点一天看当天流水、本月支出前三 |
| 流水明细 | 按天分组的账目，按收入 / 支出筛选，搜说明或分类；点一笔修改，× 删除 |
| 分类 | 本月各分类金额；增改分类（有账目的分类只能停用，不能删） |
| 记一笔 | 金额、说明、分类、日期，金额下面实时显示大写 |
| 设置 | 名字、身份、首页副标题；主题色；首页隐藏金额；导出 CSV；退出登录 |

## 本地运行

```bash
cp .env.example .env   # 默认密码 dev，端口 3010
npm run dev
```

打开 http://127.0.0.1:3010/

## 部署到服务器

和 gpt-verify 一样：推到 GitHub 的 main 分支后，GitHub Actions 自动构建镜像 `ghcr.io/weizhixiong123/opc-desk`，服务器上拉镜像运行，宝塔做反向代理和 HTTPS。

**1. 推到 GitHub**（第一次）

```bash
git init && git add . && git commit -m "init"
gh repo create opc-desk --private --source . --push
```

等 Actions 跑完（仓库页面的 Actions 标签）。

**2. 服务器上**

```bash
mkdir -p /opt/opc-desk && cd /opt/opc-desk
# 只需要这三个文件
curl -O https://raw.githubusercontent.com/Weizhixiong123/opc-desk/main/docker-compose.yml   # 私有仓库就手动上传
# 同样拿到 update.sh、env.production.example
cp env.production.example .env
vi .env            # 填 LOGIN_PASSWORD：openssl rand -base64 18
chmod +x update.sh && ./update.sh
```

**3. 宝塔：挂到 https://gptsuchong.com/desk**

和 gpt-verify（`/sms`）用同一个 gptsuchong.com 站点，不用新建站点、不用新证书。`.env` 里已经是 `BASE_PATH=/desk`。

打开站点 gptsuchong.com → 反向代理 → 添加：代理名称 `desk`，**代理目录 `/desk`**，目标 URL `http://127.0.0.1:3020`（后面不要加 `/desk` 或 `/`）。或者直接在站点的 nginx 配置里加：

```nginx
location /desk {
    proxy_pass http://127.0.0.1:3020;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 3m;   # 上传头像用
}
```

打开 https://gptsuchong.com/desk 能看到登录页就好了。登录 cookie 只在 `/desk` 下生效，和 `/sms` 互不影响。

**以后更新**：推代码到 main，等 Actions 跑完，服务器上 `./update.sh`。

## 备份

数据在 Docker 卷 `opc-desk_data` 里。备份一份到当前目录：

```bash
docker exec opc-desk node -e "new (require('node:sqlite').DatabaseSync)('/app/data/app.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker cp opc-desk:/app/data/backup.db ./opc-desk-$(date +%F).db
```

也可以在「设置 → 导出全部」下载 CSV 留底。

## 配置项

| 变量 | 说明 |
|---|---|
| `LOGIN_PASSWORD` | 必填。登录密码；改了之后所有设备要重新登录 |
| `BASE_PATH` | 挂在子路径时填，例如 `/desk`；独立域名留空 |
| `HOST_PORT` | 宿主机端口，默认 3020（服务器上 3010 是 gpt-verify） |
| `TRUST_PROXY` | 在 nginx 后面设 1，按真实 IP 限制密码试错（10 次 / 15 分钟） |
| `SECURE_COOKIE` | 走 HTTPS 设 1 |
| `SESSION_DAYS` | 登录有效天数，默认 30 |

## 接口

都在 `/api` 下，除登录外需要登录 cookie；写操作只收 `application/json`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/login` `/logout` | `{ password }` |
| GET | `/summary?period=2026-10` 或 `2026` | 汇总、上期对比、分类、12 个月走势 |
| GET | `/entries?period=&type=&category=&keyword=` | 账目列表，也可以用 `from` `to` |
| POST / PUT / DELETE | `/entries`、`/entries/:id` | `{ type, amount, category_id, date, note }`，amount 单位是元 |
| GET / POST / PATCH / DELETE | `/categories`、`/categories/:id` | `{ type, name }` / `{ name, archived }` |
| GET | `/export.csv?period=` | CSV 导出 |
| GET / PATCH | `/settings` | `{ name, title, motto, accent, hideAmt }` |
| GET | `/focus` | 今天、昨天、本周每天的专注秒数，以及正在计时的那段 |
| POST | `/focus/start` `/focus/stop` | `{ kind: "deep" \| "other" }`；结束时不到 1 分钟的丢弃 |
