#!/bin/sh
set -e

# Starts Xvfb + Chrome + the worker in one container (see
# infra/docker-compose.tierA.yml and AGENTS.md "CentOS 7 等旧 glibc 主机").
# Backgrounding Xvfb/Chrome then `exec`ing node as the final step keeps the
# container's lifecycle tied to the worker process: if the worker dies,
# Docker's restart policy restarts the whole container (Xvfb+Chrome included)
# from scratch, same self-healing property the three chained systemd units
# give the bare-metal deployment.

CDP_PORT="${XHS_CDP_PORT:-19222}"

Xvfb :99 -screen 0 1920x1080x24 -ac &

google-chrome \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/data/chrome-profile \
  --remote-allow-origins=* \
  --no-first-run --no-default-browser-check \
  --window-size=1920,1080 \
  --no-sandbox \
  --disable-dev-shm-usage &

# --no-sandbox is effectively required here (Chrome refuses its own sandbox
# when running as root, which this container does) — not just a convenience
# flag. Acceptable because packages/shared/src/validation.ts already
# restricts every URL this Chrome ever navigates to, to xiaohongshu.com /
# xhslink.com — it never renders arbitrary attacker-supplied content.

until curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; do
  sleep 0.5
done

exec node dist/index.js
