# xhs-live2gif

把小红书笔记里的实况图片（Live Photo）批量转成 GIF。可以当 CLI 脚本用，也可以部署成一个公开网页：粘贴链接 → 自动提取 → 下载 GIF。

## 这是怎么做到的

小红书网页端把每篇笔记的数据放在 `window.__INITIAL_STATE__` 里，实况图对应的视频直链藏在 `imageList[].stream.h264[].masterUrl`，并有 `livePhoto: true` 标记。核心思路就是：用一个**真实、已登录**的 Chrome 打开笔记页，直接读这段状态拿到视频直链，再用 `ffmpeg` 转成 GIF。

不直接拼小红书的接口请求，是因为他们的反爬（TLS 指纹、签名参数月度轮换、设备/账号指纹关联）专门对付"伪装成浏览器的脚本"——而我们用的是货真价实的浏览器，指纹和签名都是小红书自己的前端 JS 算出来的，不用逆向、也不容易因为签名轮换而失效。

浏览器自动化分两条路：`scripts/xhs-live2gif.sh`（手动/调试用）走 [OpenCLI](https://opencli.info) 的浏览器扩展桥接，复用桌面 Chrome 的登录态；`packages/worker` 这条生产路径**不用 opencli**——`packages/worker/src/cdp.ts` 直接用 `chrome-remote-interface` 连 Chrome 的 CDP 端口。这是踩坑之后确认的：opencli 1.8.4 的 `browser` 子命令不支持 CDP 直连（只在它的 Electron 分支生效），强制要求浏览器扩展，而扩展在无 GUI 的 Linux 服务器上装不上。直连 CDP 之后，本地开发和生产用的是**同一套代码路径**，都需要一个开了调试端口、已登录小红书的 Chrome（登录态怎么建立见 `docs/cdp-bootstrap.md`）——**两边都不需要任何 Windows 服务器**。

## 仓库结构

```
scripts/xhs-live2gif.sh   单文件 CLI 版本，本地手动用/应急调试用，逻辑和下面的 worker 完全一致
packages/
  shared/                 共享类型 + URL 白名单校验（整个系统的 SSRF/滥用边界）
  worker/                 提取→下载→转码→上传的流水线，BullMQ 消费者，session 健康检查
    bootstrap/            一次性脚本：把手动导出的 cookie 注入 Linux Chrome profile（导出本身是人工步骤，见 docs/cdp-bootstrap.md）
  api/                    Fastify API：提交任务 / 查询进度 / 健康检查
  frontend/                静态页面：粘贴链接 → 轮询 → 展示并下载 GIF
infra/                    systemd unit（浏览器 worker 那台机器）+ docker-compose（API/前端那台机器）
docs/
  cdp-bootstrap.md        从零搭建 Linux 浏览器 worker 的完整步骤
  runbook-relogin.md       登录态失效/触发验证码时的处理流程
```

更完整的架构说明、风险评估和容量规划见 [`docs/cdp-bootstrap.md`](docs/cdp-bootstrap.md) 和 [`docs/runbook-relogin.md`](docs/runbook-relogin.md)。

## 快速开始（CLI，本机已登录小红书的 Chrome）

```bash
npm install -g @jackwener/opencli   # 首次需要装扩展并登录小红书，见 opencli.info
bash scripts/xhs-live2gif.sh "<小红书笔记链接或短链>"
# 默认输出到 ~/xhs-live-gifs/<笔记ID>/gif/
```

## 本地开发（Web 服务）

需要：Node.js 20+、Redis、`ffmpeg`、`curl`，以及一个**开了 CDP 调试端口、已登录小红书**的 Chrome（不是你日常用的那个 Chrome——Chrome 不允许对默认 profile 目录开调试端口，必须是单独的 profile，登录态怎么建立见 `docs/cdp-bootstrap.md` 第 4 步）：

```bash
google-chrome --remote-debugging-port=19222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/path/to/a/fresh/profile --no-first-run --no-default-browser-check &

npm install
npm run build

# 三个进程分开起：
redis-server
XHS_CDP_ENDPOINT=http://127.0.0.1:19222 node packages/worker/dist/index.js   # 还需要配好下面这些环境变量
node packages/api/dist/index.js
# 前端是纯静态文件，直接用任意静态服务器开 packages/frontend/ 即可，
# 或者参考 infra/docker-compose.api.yml 用 nginx 起
```

### 环境变量

worker 和 API 需要的环境变量分别见 [`infra/worker.env.example`](infra/worker.env.example) 和 [`infra/api.env.example`](infra/api.env.example)（复制成 `.env` 同名文件去掉 `.example` 后填值）。关键几项：

| 变量 | 用途 |
|---|---|
| `XHS_REDIS_URL` | BullMQ 队列 + 限流共享存储 |
| `XHS_S3_*` | 结果文件（GIF/zip）的对象存储，S3 兼容 |
| `XHS_CDP_ENDPOINT` | Chrome 的 CDP 地址，默认 `http://127.0.0.1:19222`（端口故意不用 9222，见下方风险说明） |
| `XHS_ALERT_WEBHOOK_URL` | session 掉线时的告警 webhook |

## 部署到生产（Linux，不需要 Windows）

完整步骤见 [`docs/cdp-bootstrap.md`](docs/cdp-bootstrap.md)，简要分两层：

- **Tier A（有状态）**：一台机器跑 Xvfb + 有头 Chrome（CDP 模式）+ Node worker，持有唯一一份登录态。用 `infra/systemd/*.service` 管理，故意不用容器（Chrome 的显示/sandbox 在容器里太麻烦，且这是单实例、不该频繁重建的资源）。
- **Tier B（无状态）**：API + 前端 + Redis，用 `infra/docker-compose.api.yml` 起，可以随时重建/扩容，永远碰不到 Chrome 的登录态。

两层只通过 Redis 队列通信。

## 安全 / 风险

- `packages/shared/src/validation.ts` 是唯一的输入边界：只接受 `xiaohongshu.com` 笔记链接和 `xhslink.com` 短链，其他一律拒绝——没有这层，"把任意链接丢进已登录浏览器"就是一个开放 SSRF。
- 所有子进程调用（`curl`/`ffmpeg`）都用数组参数 + `execFile`，不拼 shell 字符串。
- 单账号背后只有一个 Chrome session，worker 并发数锁定为 1——扩容靠加"账号+Chrome+worker"整套副本，不是调高并发数。
- Chrome 的 CDP 端口固定用 19222、绑定 `127.0.0.1`，不要用默认的 9222——那是 Puppeteer/Playwright 等工具的通用默认端口，共享服务器上实测发生过撞车（被一个无关的 root 进程占着）。
- 这类自动化只读访问本质上仍处于平台 ToS 的灰色地带；建账号、限流、监控告警等缓解措施见 [`docs/runbook-relogin.md`](docs/runbook-relogin.md)，但风险不能降到零，公开推广前请知情承担。
