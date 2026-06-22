# Tier A（Browser Worker）首次搭建

目标：在一台 Linux 服务器上跑起来 Xvfb + 有头 Chrome（CDP 模式）+ Node worker，并让 Chrome 继承已经登录小红书的会话，全程不需要 Windows。

## 0. 前置

- 一台 Linux 服务器（用户现有云服务器即可），能装 `xvfb`、`google-chrome-stable`、Node.js 20+。
- 专门为这个服务新建的小红书账号（不要用主账号，见方案第 4 节）。
- 这台 Windows 开发机上，该账号当前已经登录在某个 Chrome profile 里。

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
npm run build --workspaces --if-present
```

把 `infra/worker.env.example` 复制为 `/opt/xhs-worker/worker.env`，填好 S3、Redis、告警 webhook 等值（见该文件内注释）。

## 3. 装 systemd unit

```bash
sudo cp infra/systemd/xhs-xvfb.service infra/systemd/xhs-chrome.service infra/systemd/xhs-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-xvfb xhs-chrome
```

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

脚本会把 cookie 注入这台 Linux Chrome 的 profile，导航到 `xiaohongshu.com` 验证一次。脚本跑完后再手动确认：

```bash
OPENCLI_CDP_ENDPOINT=http://localhost:9222 opencli browser verify-session eval "window.__INITIAL_STATE__.user"
```

确认显示的是你这个新账号的登录态，不是登录墙。**确认完之后，立刻删掉两台机器上的 `xhs-cookies.json`**——这份文件等同账号凭证。

如果这一步反复失败（页面始终是登录墙/验证码），改用 Plan B：临时起 VNC 直接在 Linux 上手动登录一次（步骤见 `docs/runbook-relogin.md` 的 Plan B 部分）。

## 5. 启动 worker，跑一次烟雾测试

```bash
sudo systemctl enable --now xhs-worker
sudo systemctl status xhs-worker
```

验证（对应方案第 6 节验证步骤 1-2）：

```bash
curl http://localhost:9222/json/version
OPENCLI_CDP_ENDPOINT=http://localhost:9222 opencli doctor

# 核心逻辑迁移验证：复用现有脚本，只是改用 CDP 模式
OPENCLI_CDP_ENDPOINT=http://localhost:9222 \
  bash /opt/xhs-worker/app/scripts/xhs-live2gif.sh "http://xhslink.com/o/2E5XOr9DlHP" /tmp/xhs-test
```

应该和 Windows 上跑出来的结果一致：noteId `6a349af8000000000702c166`，18 张实况图全部转出 GIF。这一步通过了才说明"迁移到 Linux 没有破坏任何东西"，再放心把 Tier B（API/前端）接上来。

## 6. 备份 Chrome profile

```bash
sudo systemctl stop xhs-chrome
sudo cp -a /opt/xhs-worker/chrome-profile /tmp/chrome-profile-backup
sudo systemctl start xhs-chrome
tar czf chrome-profile-$(date +%F).tar.gz -C /tmp chrome-profile-backup
# 上传到对象存储，保留 7 天，权限收紧（见方案 1.3）
```

建议写个每晚跑一次的 cron，自动做这一步。
