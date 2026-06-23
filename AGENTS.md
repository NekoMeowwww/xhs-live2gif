# AGENTS.md — 云服务器部署/运维操作手册

这份文档写给**在云服务器上操作这个项目的 Agent**（你），不是给人类读的叙述性文档。`docs/cdp-bootstrap.md` 和 `docs/runbook-relogin.md` 是背景说明和人类可读的 runbook；这份文档是把它们压缩成可以照着一步步执行、每步都有明确通过/失败判定的清单，并标出哪些点必须停下来等人类决策。

## 在开始之前：硬性规则

这些规则没有例外，不要因为"看起来能跑通"就绕过：

1. **不要把 worker 并发数从 1 调高。** 单账号背后只有一个 Chrome session，这不是性能瓶颈，是反爬底线（见 `packages/worker/src/index.ts` 里的注释）。要加吞吐量，是复制一整套"账号+Chrome+worker"，按下方"横向扩容：新增一个账号实例"的步骤来，不是改这个数字。
2. **`/opt/xhs-worker/instances/<port>/chrome-profile/` 和任何 cookie JSON 文件等同账号凭证。** 不要 `cat`/打印它们的内容到日志或回复里，不要把它们提交进 git，迁移完成后立刻删除临时 cookie 文件（`docs/cdp-bootstrap.md` 第 4 步已经写了，照做）。
3. **不要往公网暴露 Redis（6379）。** Tier A 的 worker 连 Tier B 的 Redis 必须走防火墙/安全组限制到 Tier A 的 IP，不要为了"先跑起来"临时全开。
4. **改限流数值（`packages/api/src/index.ts` 里的 `max: 1, timeWindow: "1 minute"`）需要人类批准。** 这是账号风险和滥用风险之间的平衡，不是纯技术参数，调之前先汇报现状（账号健康检查历史、实际请求量）再问。
5. **遇到登录墙/验证码/短信验证，停下来找人类处理，不要自己猜着点。** 自动化"处理验证码"这件事本身就是风控最想抓的行为模式。
6. **任何 `git push --force`、删除 Chrome profile、重置 S3 bucket 之类不可逆操作，执行前必须先汇报打算做什么并等待确认。**
7. **不要修改 `packages/worker/src/extract.ts` 里的提取 JS 或 `convert.ts` 里的 ffmpeg 滤镜图**，除非先用已知笔记（见下方"已知良好笔记"）验证过修改后的版本仍然能跑出一致结果。这段逻辑已经端到端验证过，不要凭直觉"优化"它。
8. **worker 不依赖 `opencli` CLI，也不需要在 Tier A 服务器上装它。** 已经源码级确认：opencli 1.8.4 的 `browser` 子命令不支持 `OPENCLI_CDP_ENDPOINT`，强制走浏览器扩展桥接，而扩展在无 GUI 的 Linux 服务器上装不上。`packages/worker/src/cdp.ts` 直连 Chrome 的 CDP 端口（`chrome-remote-interface`），不经过 opencli。**如果你在 Tier A 上遇到任何"扩展未连接/disconnected"之类的报错，不要去修扩展——那是在解决一个我们已经绕开的问题，先检查 `XHS_CDP_ENDPOINT` 是不是指向了正确的端口、Chrome 是不是真的监听在那个端口上。**
9. **Chrome 的调试端口第一个实例固定用 19222，不要改回 9222。** 9222 是 Puppeteer/Playwright 等工具的通用默认端口，共享服务器上极易撞车（实际发生过：一个无关的、root 启动的 Playwright Chrome 占着 9222，导致我们自己的 `xhs-chrome` 被挤到 IPv6 地址上，引发一堆诡异的连接问题）。起任何 `xhs-chrome@<port>.service` 前先用 `ss -ltnp | grep <port>` 确认端口没被占用。
10. **新增账号实例（横向扩容）必须走下方"横向扩容"那一节的步骤，不要现场临时拍一个端口号就上。** 端口号同时是 systemd 模板单元的实例参数（`xhs-chrome@<port>`/`xhs-worker@<port>`）、profile 目录名、`XHS_INSTANCE_ID`——三处必须一致，错位的后果是两个账号的健康检查互相覆盖却看不出报错。

## 已知良好笔记（到处都会用到，记住它）

```
URL:    http://xhslink.com/o/2E5XOr9DlHP
noteId: 6a349af8000000000702c166
预期:   18 个实况图片，全部能提取、下载、转换成功
```

这是 `packages/worker/src/health.ts` 健康检查用的同一个笔记，也是下面每一步验证用的标准答案。

## 前置条件检查清单

执行任何部署步骤前，先确认这些都已具备，缺哪个就停下来问人类要：

- [ ] 一台 Linux 云服务器的 SSH 访问权限
- [ ] 一个**专门为这个服务新建**的小红书账号（不是人类的主账号）——见硬性规则 5 和 `docs/runbook-relogin.md`
- [ ] 这台 Windows 开发机（或任意一台已经登录该账号的 Chrome）的访问权限，用于导出登录态
- [ ] S3 兼容对象存储的 endpoint / bucket / access key / secret key
- [ ] （可选）告警 webhook URL

## 部署执行序列

严格按顺序执行，每步做完按"判定"标准自检，不通过就停下不要往后走。

### 阶段 1：Tier A 系统依赖

```bash
sudo apt-get update
sudo apt-get install -y xvfb
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
sudo apt-get install -y /tmp/chrome.deb
sudo useradd -r -m -d /opt/xhs-worker xhsworker
sudo mkdir -p /opt/xhs-worker/instances/19222/chrome-profile
sudo chown -R xhsworker:xhsworker /opt/xhs-worker
sudo chmod 700 /opt/xhs-worker/instances/19222/chrome-profile
```

（`xhs-chrome@.service` 自己的 `ExecStartPre` 也会 `mkdir -p` 这个目录，这里手动建一次只是为了能在阶段 4 之前就 `chmod 700` 它。19222 是第一个实例的端口——后续每加一个账号实例就重复这两条 `mkdir`/`chmod`，换成新端口号。）

**判定**：`google-chrome --version` 和 `Xvfb -help` 都能正常输出，不报命令未找到。

### 阶段 2：拉代码、装依赖、编译

```bash
sudo -u xhsworker git clone https://github.com/NekoMeowwww/xhs-live2gif.git /opt/xhs-worker/app
cd /opt/xhs-worker/app
npm install
npm run build
```

**判定**：`npm run build` 以 exit code 0 结束（内部按 shared → worker → api 顺序串行编译，顺序写死在根 `package.json` 的 build script 里，不要改成 `--workspaces` 通配，那样顺序不保证，会因为 api 先于 shared 编译而报类型错误），`packages/{shared,worker,api}/dist/` 都生成了文件。

把 `infra/worker.env.example` 复制成 `/opt/xhs-worker/worker.env`，填好 S3/Redis/webhook 的值（这些值人类应该已经在前置条件清单里给你了；如果没给，停下来问）。

### 阶段 3：起 Xvfb + Chrome（先不起 worker）

先确认端口没被占用（硬性规则 9）：

```bash
ss -ltnp | grep 19222
# 有输出就停下汇报，不要硬启——先弄清楚占着这个端口的是什么进程
```

```bash
sudo cp infra/systemd/xhs-xvfb.service infra/systemd/xhs-chrome@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-xvfb xhs-chrome@19222
sleep 3
curl http://127.0.0.1:19222/json/version
```

`xhs-chrome@.service` 是模板单元（`@` 后面留空），`19222` 是这次启动的实例参数，会被代入 `%i`（端口号 + profile 目录名）——见单元文件里的注释。

**判定**：`curl` 返回一段包含 `"Browser"` 字段的 JSON，不是连接拒绝，且 `Browser` 字段是 `Chrome/...`（不是 `HeadlessChrome` 之类——那通常意味着连到了别的工具，不是我们自己的 `xhs-chrome`）。`systemctl status xhs-xvfb xhs-chrome@19222` 都是 `active (running)`。

**先不要装 `xhs-worker@19222.service`**——这台 Chrome 的 profile 是空的，没有登录态，worker 跑起来也只会不断失败。下一步必须先建立登录态。

### 阶段 4：迁移登录态 ——cookie 导出必须由人类手动做，照 `docs/cdp-bootstrap.md` 第 4 步执行

**不要尝试写脚本自动导出 Windows Chrome 的 cookie。** 已经验证过：Chrome 127+ 的 App-Bound Encryption 会让"复制 profile 再用 CDP 读 cookie"这种自动化手法读出空结果——这个限制是 Chrome 故意加的，专门用来防止 cookie 窃取，不要去找办法绕过去。

1. 让人类用 Cookie-Editor 之类的扩展，在已登录小红书的 Chrome 上手动导出 cookie 为 JSON（`docs/cdp-bootstrap.md` 第 4 步有具体操作）。这一步只能人类做，你不要代劳。
2. 拿到人类给你的 `xhs-cookies.json` 后，`scp` 到云服务器。
3. 在云服务器上跑：
   ```bash
   sudo -u xhsworker node /opt/xhs-worker/app/packages/worker/bootstrap/cookie-import.js xhs-cookies.json
   ```
4. 验证：`cookie-import.js` 自己会打印一行 `Page probe after navigation: has-user-state`（或 `no-user-state`）——这就是判定依据，不需要再跑 `opencli browser` 之类的命令二次确认（opencli 在这个场景下不可用，见硬性规则 8）。
   **判定**：输出是 `has-user-state`，不是 `no-user-state`。
5. **判定通过后立刻**：`rm` 掉两台机器上的 `xhs-cookies.json`。这一步不可跳过，不要留着"以防万一"。

**如果这一步反复失败**（页面始终是登录墙/验证码）：停下，按 `docs/runbook-relogin.md` 的 Plan B 走——临时起 VNC，**让人类**手动登录。不要自己尝试填验证码、猜短信验证码、或者重试很多次指望它过去（重试本身就是会被风控盯上的行为）。

### 阶段 5：起 worker，跑端到端验证

```bash
sudo cp /opt/xhs-worker/app/infra/systemd/xhs-worker@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-worker@19222
sudo systemctl status xhs-worker@19222
```

直接用 worker 自己编译出来的代码验证（不经过 opencli/bash 脚本，硬性规则 8）：

```bash
cd /opt/xhs-worker/app/packages/worker
node -e "
const { extractLivePhotos } = require('./dist/extract');
const { downloadVideos } = require('./dist/download');
const { convertAll } = require('./dist/convert');
const fs = require('fs');
const path = require('path');
const tmp = '/tmp/xhs-agent-verify';
fs.mkdirSync(path.join(tmp, 'mp4'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'gif'), { recursive: true });
(async () => {
  const { noteId, videoUrls } = await extractLivePhotos('http://xhslink.com/o/2E5XOr9DlHP');
  console.log('noteId:', noteId, 'count:', videoUrls.length);
  const mp4s = await downloadVideos(videoUrls, path.join(tmp, 'mp4'));
  const gifs = await convertAll(mp4s, path.join(tmp, 'gif'));
  console.log('gifs ok:', gifs.length);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
"
```

**判定**：`noteId` 输出 `6a349af8000000000702c166`，`count` 和 `gifs ok` 都输出 `18`。不是 18 就停下排查，不要继续往下部署 Tier B——核心管线没跑通，接 API/前端只会放大问题。

验证完清理：`rm -rf /tmp/xhs-agent-verify`。

### 阶段 6：备份 Chrome profile

```bash
sudo systemctl stop xhs-chrome@19222
sudo cp -a /opt/xhs-worker/instances/19222/chrome-profile /tmp/chrome-profile-backup
sudo systemctl start xhs-chrome@19222
tar czf /tmp/chrome-profile-19222-$(date +%F).tar.gz -C /tmp chrome-profile-backup
rm -rf /tmp/chrome-profile-backup
```

（多实例时，对每个端口重复这一套，备份文件名带上端口号区分。）

把这个 tar.gz 上传到 S3（`xhs-ops-backups/` 之类的前缀，和产品的 `xhs-gifs/` 分开），然后删掉本地副本。建议把这一步写成 cron（每天一次），但**第一次手动跑一遍确认流程通**之后才接 cron。

### 阶段 7：Tier B（API + 前端 + Redis）

这一层通常在另一台机器，或者先和 Tier A 同机跑（用不同 docker-compose 栈，逻辑隔离）：

```bash
cd /path/to/xhs-live2gif/infra
cp api.env.example api.env   # 填 XHS_CORS_ORIGIN / XHS_ALERT_WEBHOOK_URL
docker compose -f docker-compose.api.yml up -d --build
docker compose -f docker-compose.api.yml ps
```

**判定**：`api`、`frontend`、`redis` 三个容器都是 `Up` 状态。

### 阶段 8：API 端到端验证

```bash
curl -s -X POST http://localhost/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://xhslink.com/o/2E5XOr9DlHP"}'
# 记下返回的 jobId，然后轮询：
curl -s http://localhost/api/jobs/<jobId>
```

**判定**：状态最终变成 `done`，返回里有 18 个 GIF 链接 + 1 个 zip 链接，且这些链接可以直接 `curl -I` 拿到 `200`。

负向测试（这两个都必须按预期失败，不是顺便测测）：
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/api/jobs \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
# 判定：400

for i in 1 2; do curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/api/jobs \
  -H 'Content-Type: application/json' -d '{"url":"http://xhslink.com/o/2E5XOr9DlHP"}'; done
# 判定：第一个 202，第二个（1 分钟内）429
```

### 阶段 9：健康检查 + 告警链路

```bash
curl -s http://localhost/api/health
```

**判定**：返回形如 `{"sessionOk": true, "instances": {"19222": {"sessionOk": true, ...}}}`——顶层 `sessionOk` 是所有已上报实例的 AND，单实例部署时它和 `instances` 里那一个值应该完全一致。如果配了 `XHS_ALERT_WEBHOOK_URL`，建议人为制造一次失败（比如临时 `systemctl stop xhs-chrome@19222` 几分钟）确认告警真的会发出来，再 `systemctl start xhs-chrome@19222` 恢复。

## 横向扩容：新增一个账号实例

只在收到人类明确要求扩容、且已经按硬性规则 5 准备好一个新的专用小红书账号时才执行这一节——不要自己判断"流量大了该扩容了"就主动做。

1. **选一个未被占用的端口**，作为这个新实例的标识（同时是 CDP 端口、`XHS_INSTANCE_ID`、profile 目录名）。沿用递增规律：19223、19224……执行前用 `ss -ltnp | grep <port>` 确认空闲（硬性规则 9/10）。
2. 建目录：`sudo mkdir -p /opt/xhs-worker/instances/<port>/chrome-profile && sudo chown -R xhsworker:xhsworker /opt/xhs-worker/instances/<port> && sudo chmod 700 /opt/xhs-worker/instances/<port>/chrome-profile`。
3. 起 Chrome：`sudo systemctl enable --now xhs-chrome@<port>`，按阶段 3 的判定标准验证（`curl http://127.0.0.1:<port>/json/version`）。
4. 迁移登录态：完全重复阶段 4——人类用新账号手动导出 cookie，`cookie-import.js` 这次要带上新端口：`CDP_PORT=<port> node cookie-import.js xhs-cookies-2.json`，判定标准同阶段 4（`has-user-state`），完成后立刻删 cookie 文件。
5. 起 worker：`sudo systemctl enable --now xhs-worker@<port>`，重复阶段 5 的端到端验证（同一个已知良好笔记，同样要求 `count`/`gifs ok` 都是 18）——**这一步必须独立验证这个新实例，不能因为老实例跑得好就跳过**，每个账号背后是完全独立的 Chrome session 和登录态。
6. 确认 `GET /api/health` 的 `instances` 里出现了这个新端口号对应的 key，且 `sessionOk: true`。
7. 备份这个新实例的 profile（阶段 6 的步骤，换成新端口）。

完成后向人类汇报：新实例的端口号、阶段 5/健康检查的验证结果、现在总共有几个实例在跑。

## 出问题了怎么办

- session 掉线/验证码/账号被风控 → 严格按 `docs/runbook-relogin.md` 执行，不要自己发明处理方式。
- 任何一步"判定"没通过 → 停在那一步，把实际输出和你的判断汇报给人类，不要跳过去先把后面的步骤跑了再回头看。
- 不确定某个改动是否安全 → 默认按硬性规则里最保守的解读处理，先问。

## 完成部署后向人类汇报的格式

简短列出：

- 哪几步做完了，哪几步因为缺什么卡住了
- 阶段 5 的判定结果（18 还是别的数字）
- 阶段 8 的端到端结果（done / 失败原因）
- 阶段 9 的 `sessionOk` 状态
- 有没有动过任何硬性规则里列的红线项（应该是没有——如果有，必须明确说出来，不要省略）
