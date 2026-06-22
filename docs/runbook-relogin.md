# Runbook：小红书登录态失效 / 验证码 / 重新登录

## 触发信号

任一出现，视为账号 session 可能已经掉线：

- `GET /api/health` 返回 `sessionOk: false`（worker 每 15 分钟自动跑的健康检查，见 `packages/worker/src/health.ts`）。
- 收到 `XHS_ALERT_WEBHOOK_URL` 发出的告警消息。
- worker 日志（`journalctl -u xhs-worker -f`）里 `opencli browser ... open` 之后解析不到 `noteId`，或对已知笔记 eval 不到 `noteDetailMap`。
- 4xx/超时在短时间内激增。

## 处理步骤

1. **暂停接单**，避免在排查期间继续产生失败任务：
   ```bash
   sudo systemctl stop xhs-worker
   ```
   （只停 worker，`xhs-xvfb`/`xhs-chrome` 继续跑——Chrome session 本身不动。）

2. **临时开 VNC 看一眼 Xvfb 里 Chrome 实际显示了什么**：
   ```bash
   sudo apt-get install -y x11vnc novnc
   DISPLAY=:99 x11vnc -display :99 -nopw -listen 0.0.0.0 -xkb &
   novnc_proxy --vnc localhost:5900 &
   ```
   用浏览器开 `http://<linux-host>:6080/vnc.html` 接进去，应该能看到 Chrome 当前停在哪个页面：登录墙、短信验证码、滑块验证，还是别的。

3. **人工处理掉这个验证**（输验证码 / 过滑块 / 重新扫码登录），确认能正常浏览小红书笔记页面。

4. **关掉 VNC**（不要长期开着，这是个临时排查口子）：
   ```bash
   kill %1 %2   # 或按实际 PID kill x11vnc / novnc_proxy
   ```

5. **跑一次烟雾测试确认恢复**（同 `docs/cdp-bootstrap.md` 第 5 步）：
   ```bash
   OPENCLI_CDP_ENDPOINT=http://localhost:9222 opencli doctor
   OPENCLI_CDP_ENDPOINT=http://localhost:9222 \
     bash /opt/xhs-worker/app/scripts/xhs-live2gif.sh "http://xhslink.com/o/2E5XOr9DlHP" /tmp/xhs-test
   ```
   确认 18 张实况图都能正常提取转换。

6. **立刻备份新的 profile**（不要等夜间 cron）：
   ```bash
   sudo systemctl stop xhs-chrome
   sudo cp -a /opt/xhs-worker/chrome-profile /tmp/chrome-profile-backup-$(date +%F)
   sudo systemctl start xhs-chrome
   ```

7. **恢复接单**：
   ```bash
   sudo systemctl start xhs-worker
   ```

8. **记录这次事故**（哪怕只是一行）：时间、触发信号是什么、用了多久恢复。记录格式建议：

   ```
   2026-06-22 14:30  触发: sessionOk=false (smoke check mismatch)  处理: 滑块验证  耗时: 12min
   ```

## 决策：要不要上第二个账号

把第 8 步的记录攒起来看：**如果同一个月内触发超过一次**，说明单账号撑不住当前的访问量/风控敏感度，应该启动多账号池（每个账号配一套独立的 Chrome profile + worker 进程，都消费同一个 BullMQ 队列），而不是继续靠人工救一个账号。新增账号的步骤和这份 runbook、`docs/cdp-bootstrap.md` 完全一样，只是 profile 目录、systemd unit 名字换一套（如 `xhs-chrome-2.service`、`xhs-worker-2.service`）。

## Plan B：cookie 导入完全跑不通时的备选登录方式

如果 `cookie-import.js`（见 `docs/cdp-bootstrap.md` 第 4 步）反复无法建立有效登录态，直接在 Linux 上走一次全新交互式登录：

1. 按上面第 2 步开 VNC 接到 `:99`。
2. 在 VNC 里打开的 Chrome 窗口手动访问 `xiaohongshu.com`，扫码/输入账号密码登录这个新建账号。
3. 预期可能触发"新设备登录"的短信/滑块验证——正常处理就行，这是新 IP 登录的代价，不代表方案有问题。
4. 登录成功后按第 5 步跑烟雾测试，第 6 步立刻备份 profile。
5. 关掉 VNC。

这条路径只是更容易触发风控验证，不影响最终结果——成功登录、profile 持久化下来之后，后续行为和 cookie 导入路径完全一样。
