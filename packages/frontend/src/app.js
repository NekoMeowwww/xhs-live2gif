// Same-origin: nginx reverse-proxies /api/* to the API service (see
// infra/docker-compose.api.yml), so no CORS/base-URL config is needed here.
const API_BASE = "/api";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;

const form = document.getElementById("job-form");
const input = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");
const statusLine = document.getElementById("status-line");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");
const resultSection = document.getElementById("result");
const resultMessage = document.getElementById("result-message");
const zipLink = document.getElementById("zip-link");
const gifGrid = document.getElementById("gif-grid");

// Xiaohongshu's app "copy link" share action produces text like:
// "敲代码的可爱小熊 http://xhslink.com/o/2WwdoTSaEth 存下链接，去【小红书】阅读全文~"
// — pull just the URL out so users can paste that whole blob directly
// instead of having to manually trim it themselves.
function extractXhsUrl(text) {
  const match = text.match(/https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/\S+/i);
  if (!match) return null;
  // Defensive trim in case share text ever omits the trailing space and a
  // punctuation mark gets swallowed into the \S+ match.
  return match[0].replace(/[，,。.!！?？、)\]）】]+$/, "");
}

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.hidden = !text;
  statusLine.classList.toggle("error", isError);
}

const STAGE_LABELS = {
  extracting: "解析链接",
  downloading: "下载实况视频",
  converting: "转换 GIF",
  uploading: "上传结果",
};

function setProgress(progress) {
  if (!progress) {
    progressWrap.hidden = true;
    return;
  }
  progressWrap.hidden = false;
  progressBar.value = progress.percent ?? 0;
  const stageText = STAGE_LABELS[progress.stage] ?? progress.stage ?? "";
  const countText = progress.total ? ` (${progress.current ?? 0}/${progress.total})` : "";
  progressLabel.textContent = `${stageText}${countText} ${Math.round(progress.percent ?? 0)}%`;
}

function hideProgress() {
  progressWrap.hidden = true;
  progressBar.value = 0;
  progressLabel.textContent = "";
}

function resetResult() {
  resultSection.hidden = true;
  resultMessage.textContent = "";
  zipLink.hidden = true;
  gifGrid.innerHTML = "";
  hideProgress();
}

function renderResult(result) {
  resultSection.hidden = false;

  if (result.message) {
    resultMessage.textContent = result.message;
  } else {
    resultMessage.textContent = `共生成 ${result.gifs?.length ?? 0} 个 GIF`;
  }

  if (result.zipUrl) {
    zipLink.href = result.zipUrl;
    zipLink.hidden = false;
  }

  for (const gif of result.gifs ?? []) {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.src = gif.url;
    img.alt = gif.name;
    img.loading = "lazy";
    const caption = document.createElement("figcaption");
    const link = document.createElement("a");
    link.href = gif.url;
    link.textContent = "下载";
    link.download = gif.name;
    caption.appendChild(link);
    figure.append(img, caption);
    gifGrid.appendChild(figure);
  }
}

async function pollJob(jobId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const res = await fetch(`${API_BASE}/jobs/${jobId}`);
    if (!res.ok) {
      setStatus("查询任务状态失败，请稍后重试。", true);
      return;
    }
    const data = await res.json();

    if (data.status === "queued") {
      setStatus("排队中...");
      setProgress(data.progress);
    } else if (data.status === "processing") {
      setStatus("");
      setProgress(data.progress ?? { percent: 0, stage: "extracting" });
    } else if (data.status === "done") {
      setStatus("");
      hideProgress();
      renderResult(data.result);
      return;
    } else if (data.status === "failed") {
      hideProgress();
      setStatus(`处理失败：${data.result?.error ?? "未知错误"}`, true);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  hideProgress();
  setStatus("处理超时，请稍后重试。", true);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;

  const url = extractXhsUrl(raw);
  if (!url) {
    resetResult();
    setStatus("没有在粘贴内容里识别到小红书链接，请确认包含完整的 xiaohongshu.com 或 xhslink.com 链接。", true);
    return;
  }

  submitBtn.disabled = true;
  resetResult();
  setStatus("提交中...");

  try {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      setStatus(`请求太频繁，请${retryAfter ? `等待 ${retryAfter} 秒后` : "稍后"}再试。`, true);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus(data.error ?? "提交失败，请检查链接是否为小红书笔记链接。", true);
      return;
    }

    const { jobId } = await res.json();
    setStatus("已提交，排队中...");
    await pollJob(jobId);
  } catch (err) {
    setStatus(`网络错误：${err.message}`, true);
  } finally {
    submitBtn.disabled = false;
  }
});
