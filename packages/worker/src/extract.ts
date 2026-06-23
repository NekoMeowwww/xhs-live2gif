import { isXiaohongshuHost, extractNoteId, isValidNoteId } from "@xhs/shared";
import { withPage } from "./cdp";

export interface LivePhotoExtraction {
  noteId: string;
  videoUrls: string[];
}

// Ported verbatim from scripts/xhs-live2gif.sh — this JS only works because it
// runs inside a real, already-logged-in browser tab: window.__INITIAL_STATE__
// is Xiaohongshu's own client-side state, populated by their (signed,
// monthly-rotating) API calls. We never compute or replay that signing
// ourselves; we just read what their own page already computed.
//
// Do not change this string without re-running the parity test against the
// known-good note (see AGENTS.md hard rule 7) — it's proven end-to-end.
function buildExtractionJs(noteId: string): string {
  return (
    `var n=window.__INITIAL_STATE__.note.noteDetailMap['${noteId}'].note;` +
    `JSON.stringify(n.imageList.filter(function(img){return img.livePhoto;})` +
    `.map(function(img){var h264=(img.stream&&img.stream.h264)||[];return h264.length?h264[0].masterUrl:null;})` +
    `.filter(Boolean))`
  );
}

export async function extractLivePhotos(url: string): Promise<LivePhotoExtraction> {
  return withPage(url, async (evaluate) => {
    const href = String(await evaluate("window.location.href"));

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
    const json = await evaluate(buildExtractionJs(noteId));
    const videoUrls: string[] = JSON.parse(String(json));

    return { noteId, videoUrls };
  });
}
