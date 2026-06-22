import { isXiaohongshuHost, extractNoteId, isValidNoteId } from "@xhs/shared";
import { createSession, browserOpen, browserEval, browserClose } from "./opencli";

export interface LivePhotoExtraction {
  noteId: string;
  videoUrls: string[];
}

// Ported verbatim from scripts/xhs-live2gif.sh — this JS only works because it
// runs inside a real, already-logged-in browser tab: window.__INITIAL_STATE__
// is Xiaohongshu's own client-side state, populated by their (signed,
// monthly-rotating) API calls. We never compute or replay that signing
// ourselves; we just read what their own page already computed.
function buildExtractionJs(noteId: string): string {
  return (
    `var n=window.__INITIAL_STATE__.note.noteDetailMap['${noteId}'].note;` +
    `JSON.stringify(n.imageList.filter(function(img){return img.livePhoto;})` +
    `.map(function(img){var h264=(img.stream&&img.stream.h264)||[];return h264.length?h264[0].masterUrl:null;})` +
    `.filter(Boolean))`
  );
}

function cleanEvalString(raw: string): string {
  return raw.replace(/["\r\n]/g, "").trim();
}

export async function extractLivePhotos(url: string): Promise<LivePhotoExtraction> {
  const session = createSession();
  try {
    await browserOpen(session, url);

    const hrefRaw = await browserEval(session, "window.location.href");
    const href = cleanEvalString(hrefRaw);

    // Re-validate after redirect: a malicious xhslink.com short link must not
    // be able to send the real, authenticated browser anywhere else.
    if (!isXiaohongshuHost(href)) {
      throw new Error(`Resolved URL is not on xiaohongshu.com: ${href}`);
    }

    const noteId = extractNoteId(href);
    if (!noteId || !isValidNoteId(noteId)) {
      throw new Error(`Could not resolve a note ID from: ${href}`);
    }

    // noteId is validated against /^[a-f0-9]{20,}$/ above before being
    // string-interpolated into the JS payload below.
    const json = await browserEval(session, buildExtractionJs(noteId));
    const videoUrls: string[] = JSON.parse(json.trim());

    return { noteId, videoUrls };
  } finally {
    await browserClose(session);
  }
}
