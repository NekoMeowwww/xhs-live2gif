// This allowlist is the system's main SSRF/abuse boundary: only Xiaohongshu note
// URLs/short-links may ever be opened in the logged-in browser. Used by the API
// before enqueueing, and re-checked by the worker against the post-redirect URL.

const XHS_NOTE_PATH_RE = /^\/(explore|discovery\/item)\/[a-f0-9]{20,}/;
const XHS_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const XHSLINK_HOST = "xhslink.com";
const XHSLINK_PATH_RE = /^\/[A-Za-z0-9/_-]+$/;

export function isAllowedInputUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (XHS_HOSTS.has(u.hostname)) return XHS_NOTE_PATH_RE.test(u.pathname);
  if (u.hostname === XHSLINK_HOST) return XHSLINK_PATH_RE.test(u.pathname);
  return false;
}

// Used after navigation to confirm a short link actually resolved onto
// xiaohongshu.com before any page data is read or trusted.
export function isXiaohongshuHost(raw: string): boolean {
  try {
    return XHS_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

const NOTE_ID_RE = /(?:explore|discovery\/item)\/([a-f0-9]{20,})/;

export function extractNoteId(href: string): string | null {
  const m = href.match(NOTE_ID_RE);
  return m ? m[1] : null;
}

const NOTE_ID_PATTERN = /^[a-f0-9]{20,}$/;

// noteId/jobId are interpolated into filesystem paths and object storage keys —
// always validate before using them that way.
export function isValidNoteId(id: string): boolean {
  return NOTE_ID_PATTERN.test(id);
}

export function isValidOutputFormat(value: unknown): value is "gif" | "mp4" {
  return value === "gif" || value === "mp4";
}
