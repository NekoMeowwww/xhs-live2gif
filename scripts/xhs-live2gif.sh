#!/usr/bin/env bash
# 把小红书笔记里的实况图片(Live Photo)转成 GIF
# 依赖: opencli (https://www.npmjs.com/package/@jackwener/opencli，需已登录小红书), ffmpeg, curl, node
# 用法: xhs-live2gif.sh <小红书笔记链接或短链> [输出目录，默认 ~/xhs-live-gifs]
set -uo pipefail

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
opencli browser "$SESSION" open "$URL" >/dev/null 2>&1

HREF=$(opencli browser "$SESSION" eval "window.location.href" 2>/dev/null | tr -d '"\r\n')
NOTE_ID=$(echo "$HREF" | grep -oE '(explore|discovery/item)/[a-f0-9]+' | grep -oE '[a-f0-9]{20,}$')

if [ -z "$NOTE_ID" ]; then
  echo "✗ 无法解析笔记 ID，链接可能无效，或小红书未登录/笔记已被删除。" >&2
  echo "  实际跳转地址: $HREF" >&2
  exit 1
fi

echo "[2/5] 笔记 ID: $NOTE_ID，提取实况视频地址..." >&2

JS="var n=window.__INITIAL_STATE__.note.noteDetailMap['$NOTE_ID'].note;JSON.stringify(n.imageList.filter(function(img){return img.livePhoto;}).map(function(img){var h264=(img.stream&&img.stream.h264)||[];return h264.length?h264[0].masterUrl:null;}).filter(Boolean))"

URLS_JSON=$(opencli browser "$SESSION" eval "$JS" 2>/dev/null)

COUNT=$(echo "$URLS_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).length))" 2>/dev/null || echo 0)

if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
  echo "该笔记没有实况图片（livePhoto），无需转换。" >&2
  exit 0
fi

echo "[3/5] 发现 $COUNT 张实况图片，下载视频..." >&2

NOTE_DIR="$OUTDIR/$NOTE_ID"
mkdir -p "$NOTE_DIR/mp4" "$NOTE_DIR/gif"

echo "$URLS_JSON" | node -e "JSON.parse(require('fs').readFileSync(0,'utf8')).forEach(u=>console.log(u))" > "$NOTE_DIR/.live_urls.txt"

i=1
while IFS= read -r vurl; do
  idx=$(printf "%02d" "$i")
  curl -s -o "$NOTE_DIR/mp4/live_${idx}.mp4" "$vurl"
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
