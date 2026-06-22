// Same-origin: nginx reverse-proxies /api/* to the API service (see
// infra/docker-compose.api.yml), so no CORS/base-URL config is needed here.
const API_BASE = "/api";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;

const form = document.getElementById("job-form");
const input = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");
const statusLine = document.getElementById("status-line");
const resultSection = document.getElementById("result");
const resultMessage = document.getElementById("result-message");
const zipLink = document.getElementById("zip-link");
const gifGrid = document.getElementById("gif-grid");

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.hidden = !text;
  statusLine.classList.toggle("error", isError);
}

function resetResult() {
  resultSection.hidden = true;
  resultMessage.textContent = "";
  zipLink.hidden = true;
  gifGrid.innerHTML = "";
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
    } else if (data.status === "processing") {
      setStatus("正在提取并转换中...");
    } else if (data.status === "done") {
      setStatus("");
      renderResult(data.result);
      return;
    } else if (data.status === "failed") {
      setStatus(`处理失败：${data.result?.error ?? "未知错误"}`, true);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  setStatus("处理超时，请稍后重试。", true);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;

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
