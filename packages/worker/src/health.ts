import { HealthStatus } from "@xhs/shared";
import { extractLivePhotos } from "./extract";
import { isCdpReachable } from "./cdp";

// The same note we've proven end-to-end (18 live photos). Used as a smoke
// test: if this stops resolving correctly, the logged-in session has expired
// or hit a captcha/login wall — see docs/runbook-relogin.md.
const KNOWN_GOOD_NOTE_URL = process.env.XHS_HEALTHCHECK_URL ?? "http://xhslink.com/o/2E5XOr9DlHP";
const KNOWN_GOOD_NOTE_ID = process.env.XHS_HEALTHCHECK_NOTE_ID ?? "6a349af8000000000702c166";

export async function checkSessionHealth(): Promise<HealthStatus> {
  const now = new Date().toISOString();

  if (!(await isCdpReachable())) {
    return { sessionOk: false, lastChecked: now, detail: "Chrome CDP endpoint unreachable (XHS_CDP_ENDPOINT)" };
  }

  try {
    const { noteId, videoUrls } = await extractLivePhotos(KNOWN_GOOD_NOTE_URL);
    if (noteId !== KNOWN_GOOD_NOTE_ID || videoUrls.length === 0) {
      return {
        sessionOk: false,
        lastChecked: now,
        detail: `Smoke check mismatch: noteId=${noteId} videoCount=${videoUrls.length}`,
      };
    }
  } catch (err) {
    return { sessionOk: false, lastChecked: now, detail: `Smoke check failed: ${String(err)}` };
  }

  return { sessionOk: true, lastChecked: now };
}
