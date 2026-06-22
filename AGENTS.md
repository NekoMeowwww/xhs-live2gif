# AGENTS.md — 云服务器部署/运维操作手册

这份文档写给**在云服务器上操作这个项目的 Agent**（你），不是给人类读的叙述性文档。`docs/cdp-bootstrap.md` 和 `docs/runbook-relogin.md` 是背景说明和人类可读的 runbook；这份文档是把它们压缩成可以照着一步步执行、每步都有明确通过/失败判定的清单，并标出哪些点必须停下来等人类决策。

## 在开始之前：硬性规则

这些规则没有例外，不要因为"看起来能跑通"就绕过：

1. **不要把 worker 并发数从 1 调高。** 单账号背后只有一个 Chrome session，这不是性能瓶颈，是反爬底线（见 `packages/worker/src/index.ts` 里的注释）。要加吞吐量，是复制一整套"账号+Chrome+worker"，不是改这个数字。
2. **`/opt/xhs-worker/chrome-profile/` 和任何 cookie JSON 文件等同账号凭证。** 不要 `cat`/打印它们的内容到日志或回复里，不要把它们提交进 git，迁移完成后立刻删除临时 cookie 文件（`docs/cdp-bootstrap.md` 第 4 步已经写了，照做）。
3. **不要往公网暴露 Redis（6379）。** Tier A 的 worker 连 Tier B 的 Redis 必须走防火墙/安全组限制到 Tier A 的 IP，不要为了"先跑起来"临时全开。
4. **改限流数值（`packages/api/src/index.ts` 里的 `max: 3, timeWindow: "10 minutes"`）需要人类批准。** 这是账号风险和滥用风险之间的平衡，不是纯技术参数，调之前先汇报现状（账号健康检查历史、实际请求量）再问。
5. **遇到登录墙/验证码/短信验证，停下来找人类处理，不要自己猜着点。** 自动化"处理验证码"这件事本身就是风控最想抓的行为模式。
6. **任何 `git push --force`、删除 Chrome profile、重置 S3 bucket 之类不可逆操作，执行前必须先汇报打算做什么并等待确认。**
7. **不要修改 `packages/worker/src/extract.ts` 里的提取 JS 或 `convert.ts` 里的 ffmpeg 滤镜图**，除非先用已知笔记（见下方"已知良好笔记"）验证过修改后的版本仍然能跑出一致结果。这段逻辑已经端到端验证过，不要凭直觉"优化"它。

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
sudo mkdir -p /opt/xhs-worker/chrome-profile
sudo chown -R xhsworker:xhsworker /opt/xhs-worker
sudo chmod 700 /opt/xhs-worker/chrome-profile
```

**判定**：`google-chrome --version` 和 `Xvfb -help` 都能正常输出，不报命令未找到。

### 阶段 2：拉代码、装依赖、编译

```bash
sudo -u xhsworker git clone https://github.com/NekoMeowwww/xhs-live2gif.git /opt/xhs-worker/app
cd /opt/xhs-worker/app
npm install
npm run build --workspaces --if-present
```

**判定**：三个 `npm run build` 都以 exit code 0 结束，`packages/{shared,worker,api}/dist/` 都生成了文件。

把 `infra/worker.env.example` 复制成 `/opt/xhs-worker/worker.env`，填好 S3/Redis/webhook 的值（这些值人类应该已经在前置条件清单里给你了；如果没给，停下来问）。

### 阶段 3：起 Xvfb + Chrome（先不起 worker）

```bash
sudo cp infra/systemd/xhs-xvfb.service infra/systemd/xhs-chrome.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-xvfb xhs-chrome
sleep 3
curl http://localhost:9222/json/version
```

**判定**：`curl` 返回一段包含 `"Browser"` 字段的 JSON，不是连接拒绝。`systemctl status xhs-xvfb xhs-chrome` 都是 `active (running)`。

**先不要装 `xhs-worker.service`**——这台 Chrome 的 profile 是空的，没有登录态，worker 跑起来也只会不断失败。下一步必须先建立登录态。

### 阶段 4：迁移登录态 ——这一步大量依赖人类，照 `docs/cdp-bootstrap.md` 第 4 步执行

1. 让人类确认：开发机上所有常规 Chrome 窗口已经关闭。
2. 在开发机上跑：
   ```bash
   cd packages/worker && npm install
   node bootstrap/cookie-export.js "<chrome-profile-dir>" xhs-cookies.json
   ```
3. `scp` 这个文件到云服务器。
4. 在云服务器上跑：
   ```bash
   sudo -u xhsworker node /opt/xhs-worker/app/packages/worker/bootstrap/cookie-import.js xhs-cookies.json
   ```
5. 验证：
   ```bash
   OPENCLI_CDP_ENDPOINT=http://localhost:9222 opencli browser verify-session eval "window.__INITIAL_STATE__.user"
   ```
   **判定**：返回的是这个新账号的用户信息对象，不是 `undefined`、不是登录墙的 HTML 痕迹。
6. **判定通过后立刻**：`rm` 掉两台机器上的 `xhs-cookies.json`。这一步不可跳过，不要留着"以防万一"。

**如果这一步反复失败**（页面始终是登录墙/验证码）：停下，按 `docs/runbook-relogin.md` 的 Plan B 走——临时起 VNC，**让人类**手动登录。不要自己尝试填验证码、猜短信验证码、或者重试很多次指望它过去（重试本身就是会被风控盯上的行为）。

### 阶段 5：起 worker，跑端到端验证

```bash
sudo cp /opt/xhs-worker/app/infra/systemd/xhs-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-worker
sudo systemctl status xhs-worker

OPENCLI_CDP_ENDPOINT=http://localhost:9222 opencli doctor
OPENCLI_CDP_ENDPOINT=http://localhost:9222 \
  bash /opt/xhs-worker/app/scripts/xhs-live2gif.sh "http://xhslink.com/o/2E5XOr9DlHP" /tmp/xhs-agent-verify
ls /tmp/xhs-agent-verify/6a349af8000000000702c166/gif | wc -l
```

**判定**：最后一行输出 `18`。不是 18 就停下排查，不要继续往下部署 Tier B——核心管线没跑通，接 API/前端只会放大问题。

验证完清理：`rm -rf /tmp/xhs-agent-verify`。

### 阶段 6：备份 Chrome profile

```bash
sudo systemctl stop xhs-chrome
sudo cp -a /opt/xhs-worker/chrome-profile /tmp/chrome-profile-backup
sudo systemctl start xhs-chrome
tar czf /tmp/chrome-profile-$(date +%F).tar.gz -C /tmp chrome-profile-backup
rm -rf /tmp/chrome-profile-backup
```

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

for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/api/jobs \
  -H 'Content-Type: application/json' -d '{"url":"http://xhslink.com/o/2E5XOr9DlHP"}'; done
# 判定：前三个 202，第四个 429
```

### 阶段 9：健康检查 + 告警链路

```bash
curl -s http://localhost/api/health
```

**判定**：`sessionOk: true`。如果配了 `XHS_ALERT_WEBHOOK_URL`，建议人为制造一次失败（比如临时 `systemctl stop xhs-chrome` 几分钟）确认告警真的会发出来，再 `systemctl start xhs-chrome` 恢复。

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
