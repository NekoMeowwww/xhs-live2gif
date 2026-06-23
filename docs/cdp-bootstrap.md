# Tier A（Browser Worker）首次搭建

目标：在一台 Linux 服务器上跑起来 Xvfb + 有头 Chrome（CDP 模式）+ Node worker，并让 Chrome 继承已经登录小红书的会话，全程不需要 Windows。

## 重要：worker 不依赖 opencli，直连 CDP

最初设想是用 `opencli browser <session> open/eval/close` 配合 `OPENCLI_CDP_ENDPOINT` 环境变量在 Linux 上跑——实测+读 opencli 1.8.4 源码后确认这条路不通：`OPENCLI_CDP_ENDPOINT` 只在它的 Electron 分支生效，`browser` 子命令走的是另一条路径（`shouldUseBrowserSession`），不经过它自己的 CDPBridge，**强制要求浏览器扩展桥接**，而扩展桥接在无 GUI 的 Linux 服务器上装不上（Chrome 新版本陆续锁死了 `--load-extension`、`external_extensions.json` 等旁路安装方式）。

所以 `packages/worker` 不再依赖 `opencli` CLI 本身——`packages/worker/src/cdp.ts` 直接用 `chrome-remote-interface` 连 Chrome 的 CDP 端口（和 `cookie-import.js` 一直用的方式一样）。**Tier A 服务器不需要装 `opencli`。** `opencli` 只在桌面端（装了扩展、真人登录的 Chrome，比如 `scripts/xhs-live2gif.sh` 这个手动调试脚本）才有用。

## 0. 前置

- 一台 Linux 服务器（用户现有云服务器即可），能装 `xvfb`、`google-chrome-stable`、Node.js 20+。
- 专门为这个服务新建的小红书账号（不要用主账号，见方案第 4 节）。
- 任意一台已经登录该账号的 Chrome（用于手动导出 cookie，不需要是开发机）。

## 1. 安装系统依赖

```bash
sudo apt-get update
sudo apt-get install -y xvfb
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
sudo apt-get install -y /tmp/chrome.deb
```

创建专用运行用户和目录：

```bash
sudo useradd -r -m -d /opt/xhs-worker xhsworker
sudo mkdir -p /opt/xhs-worker/chrome-profile
sudo chown -R xhsworker:xhsworker /opt/xhs-worker
sudo chmod 700 /opt/xhs-worker/chrome-profile
```

## 2. 部署代码

```bash
sudo -u xhsworker git clone <your-repo-url> /opt/xhs-worker/app
cd /opt/xhs-worker/app
npm install
npm run build
```

把 `infra/worker.env.example` 复制为 `/opt/xhs-worker/worker.env`，填好 S3、Redis、告警 webhook 等值（见该文件内注释）。

## 3. 装 systemd unit

**先检查端口 19222 没被占用**——9222/19222 之类的调试端口是很多浏览器自动化工具（Puppeteer/Playwright 等）的常见默认值，共享服务器上容易撞车：

```bash
ss -ltnp | grep 19222 || echo "端口空闲，可以继续"
```

如果输出非空，说明已经有别的进程占了这个端口，先弄清楚是什么（`ss -ltnp` 输出里带 PID），停掉它或者把 `infra/systemd/xhs-chrome.service` 和 `infra/systemd/xhs-worker.service` 里的端口号一起换成另一个没人用的数字，不要硬启。

```bash
sudo cp infra/systemd/xhs-xvfb.service infra/systemd/xhs-chrome.service infra/systemd/xhs-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-xvfb xhs-chrome
sleep 2
curl http://127.0.0.1:19222/json/version
```

**判定**：返回一段包含 `"Browser"` 字段的 JSON，且这个 JSON 里的 `Browser` 字段应该是 `Chrome/...`（不是别的工具，比如 `HeadlessChrome` 通常意味着是别的 Playwright/Puppeteer 进程占了这个端口，不是我们自己的 `xhs-chrome`）。

**先只启动 Xvfb 和 Chrome，不要急着启动 worker** —— 这台 Chrome 的 profile 还是空的，没有登录态，得先做第 4 步。

## 4. 把已登录的会话迁移过来

**这一步的 cookie 导出必须手动做，不能用脚本自动导出。** 早期方案设想过写一个脚本直接读 Windows Chrome 的 cookie 数据库，实测行不通：Chrome 127+ 加了 App-Bound Encryption，专门用来防止"复制 profile + 自动化读 cookie"这种手法（这正是 cookie 窃取木马的标准操作），脚本读出来的 cookie 全是空的。继续找办法绕过去就是在研究怎么绕开 Chrome 的反窃取保护，不做。

正规路径是用浏览器扩展手动导出——扩展走的是 Chrome 官方开放给扩展的 `chrome.cookies` API，不受 App-Bound Encryption 限制：

在 **已经登录小红书的 Chrome**（不需要是开发机，任何一台正常浏览器都行）上：

1. 装 [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm) 扩展。
2. 打开 `https://www.xiaohongshu.com` 并确认已登录。
3. 点扩展图标 → 应该能看到当前站点的全部 cookie（包含 HttpOnly 的）。
4. 点 **Export** → 选 **JSON** 格式 → 复制到剪贴板或直接下载，存成 `xhs-cookies.json`。
5. 把 `xhs-cookies.json` scp 到 Linux 服务器：
   ```bash
   scp xhs-cookies.json xhsworker@<linux-host>:/opt/xhs-worker/app/packages/worker/
   ```

在 **Linux 服务器**上（确认 `xhs-xvfb` 和 `xhs-chrome` 两个 service 已经在跑）：

```bash
cd /opt/xhs-worker/app/packages/worker
sudo -u xhsworker node bootstrap/cookie-import.js xhs-cookies.json
```

脚本会把 cookie 注入这台 Linux Chrome 的 profile，导航到 `xiaohongshu.com` 并打印一行 `Page probe after navigation: has-user-state`（或 `no-user-state`）——这就是验证结果，不需要再额外跑别的命令确认（注：之前这里写的是用 `opencli browser ... eval` 二次确认，已确认 opencli 在这个场景下不可用，删掉了那条建议）。

确认是 `has-user-state` 之后，**立刻删掉两台机器上的 `xhs-cookies.json`**——这份文件等同账号凭证。

如果反复显示 `no-user-state`（页面始终是登录墙/验证码），改用 Plan B：临时起 VNC 直接在 Linux 上手动登录一次（步骤见 `docs/runbook-relogin.md` 的 Plan B 部分）。

## 5. 启动 worker，跑一次烟雾测试

```bash
sudo systemctl enable --now xhs-worker
sudo systemctl status xhs-worker
```

验证（对应方案第 6 节验证步骤 1-2，用 worker 自己编译出来的代码直接测，不再依赖 `opencli`/bash 脚本）：

```bash
curl http://127.0.0.1:19222/json/version

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

**判定**：`noteId` 是 `6a349af8000000000702c166`，`count`/`gifs ok` 都是 `18`。这一步通过了才说明"迁移到 Linux 没有破坏任何东西"，再放心把 Tier B（API/前端）接上来。

验证完清理：`rm -rf /tmp/xhs-agent-verify`。

## 6. 备份 Chrome profile

```bash
sudo systemctl stop xhs-chrome
sudo cp -a /opt/xhs-worker/chrome-profile /tmp/chrome-profile-backup
sudo systemctl start xhs-chrome
tar czf chrome-profile-$(date +%F).tar.gz -C /tmp chrome-profile-backup
# 上传到对象存储，保留 7 天，权限收紧（见方案 1.3）
```

建议写个每晚跑一次的 cron，自动做这一步。
