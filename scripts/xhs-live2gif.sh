#!/usr/bin/env bash
# 把小红书笔记里的实况图片(Live Photo)转成 GIF
# 依赖: opencli (https://www.npmjs.com/package/@jackwener/opencli，需已登录小红书), ffmpeg, curl, node
# 用法: xhs-live2gif.sh <小红书笔记链接或短链> [输出目录，默认 ~/xhs-live-gifs]
set -euo pipefail

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ -z "${1:-}" ]; then
  echo "用法: xhs-live2gif.sh <小红书笔记链接或短链> [输出目录]"
  echo "  输出目录默认: \$HOME/xhs-live-gifs (不依赖当前工作目录，可在任意目录下运行)"
  exit 0
fi

for dep in opencli ffmpeg curl node; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "✗ 未找到依赖命令: $dep，请先安装后再运行。" >&2
    exit 1
  fi
done

URL="$1"
OUTDIR="${2:-$HOME/xhs-live-gifs}"
SESSION="xhs-live2gif-$$"

cleanup() {
  opencli browser "$SESSION" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/5] 打开链接..." >&2
if ! opencli browser "$SESSION" open "$URL" >/dev/null; then
  echo "✗ 打开笔记失败，请检查 OpenCLI 浏览器连接和链接。" >&2
  exit 1
fi

HREF=$(opencli browser "$SESSION" eval "window.location.href" | tr -d '"\r\n')
NOTE_ID=$(printf '%s' "$HREF" | grep -oE '(explore|discovery/item)/[a-f0-9]+' | grep -oE '[a-f0-9]{20,}$' || true)

if [ -z "$NOTE_ID" ]; then
  echo "✗ 无法解析笔记 ID，链接可能无效，或小红书未登录/笔记已被删除。" >&2
  echo "  实际跳转地址: $HREF" >&2
  exit 1
fi

echo "[2/5] 笔记 ID: $NOTE_ID，提取实况视频地址..." >&2

JS="(function(){var detail=window.__INITIAL_STATE__?.note?.noteDetailMap?.['$NOTE_ID'];var n=detail?.note;if(!n||!Array.isArray(n.imageList))throw new Error('笔记数据尚未加载');var live=n.imageList.filter(function(img){return img.livePhoto;});var urls=live.map(function(img){var streams=img.stream||{};var keys=['h264','h265','av1'].concat(Object.keys(streams));for(var key of keys){var variants=streams[key];if(!Array.isArray(variants))continue;for(var item of variants){if(!item)continue;var url=item.masterUrl||item.master_url||(item.backupUrls&&item.backupUrls[0]);if(typeof url==='string'&&/^https?:/.test(url))return url;}}return null;}).filter(Boolean);return JSON.stringify({liveCount:live.length,urls:urls});})()"

if ! RESULT_JSON=$(opencli browser "$SESSION" eval "$JS"); then
  echo "✗ 读取笔记数据失败。请在 Chrome 中确认笔记可打开，然后重试。" >&2
  exit 1
fi

if ! STATS=$(printf '%s' "$RESULT_JSON" | node -e 'const x=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!Number.isInteger(x.liveCount)||!Array.isArray(x.urls))process.exit(1);process.stdout.write(x.liveCount+" "+x.urls.length)' 2>/dev/null); then
  echo "✗ 浏览器返回的数据无法解析。" >&2
  exit 1
fi
read -r LIVE_COUNT COUNT <<< "$STATS"

if [ "$LIVE_COUNT" = "0" ]; then
  echo "该笔记没有实况图片（livePhoto）。" >&2
  exit 0
fi
if [ "$COUNT" = "0" ]; then
  echo "✗ 找到 $LIVE_COUNT 张实况图片，但未找到可下载的视频流。" >&2
  exit 1
fi
if [ "$COUNT" -ne "$LIVE_COUNT" ]; then
  echo "注意：$LIVE_COUNT 张实况图片中，仅 $COUNT 张找到了视频流。" >&2
fi

echo "[3/5] 发现 $COUNT 张实况图片，下载视频..." >&2

NOTE_DIR="$OUTDIR/$NOTE_ID"
mkdir -p "$NOTE_DIR/mp4" "$NOTE_DIR/gif"

printf '%s' "$RESULT_JSON" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")).urls.forEach(u=>console.log(u))' > "$NOTE_DIR/.live_urls.txt"

i=1
while IFS= read -r vurl; do
  idx=$(printf "%02d" "$i")
  curl -fLsS --retry 2 -o "$NOTE_DIR/mp4/live_${idx}.mp4" "$vurl"
  i=$((i+1))
done < "$NOTE_DIR/.live_urls.txt"

echo "[4/5] 转换为 GIF (ffmpeg)..." >&2
for f in "$NOTE_DIR"/mp4/live_*.mp4; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .mp4)
  ffmpeg -y -i "$f" -vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "$NOTE_DIR/gif/${name}.gif" -hide_banner -loglevel error
done

rm -f "$NOTE_DIR/.live_urls.txt"

GIF_DIR_ABS=$(cd "$NOTE_DIR/gif" && pwd)
echo "[5/5] 完成！共生成 $(ls "$NOTE_DIR/gif" | wc -l) 个 GIF，保存在: $GIF_DIR_ABS" >&2
ls "$NOTE_DIR/gif"
