import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobResult, JobProgress } from "@xhs/shared";
import { extractLivePhotos } from "./extract";
import { downloadVideos } from "./download";
import { convertAll } from "./convert";
import { uploadResults } from "./upload";

export type ProgressReporter = (progress: JobProgress) => void | Promise<void>;

// Stage boundaries are rough time-share estimates (download/convert are the
// two slow steps, extraction and upload are comparatively quick) — tuned for
// a reasonable-looking bar, not measured benchmarks.
const STAGE_RANGE = {
  extracting: { start: 0, end: 10 },
  downloading: { start: 10, end: 55 },
  converting: { start: 55, end: 95 },
  uploading: { start: 95, end: 100 },
} as const;

export async function processJob(
  jobId: string,
  url: string,
  onProgress: ProgressReporter = () => {},
): Promise<JobResult> {
  await onProgress({ percent: STAGE_RANGE.extracting.start, stage: "extracting" });
  const { noteId, videoUrls } = await extractLivePhotos(url);

  if (videoUrls.length === 0) {
    return { status: "done", noteId, gifs: [], message: "该笔记没有实况图片（livePhoto），无需转换。" };
  }

  await onProgress({ percent: STAGE_RANGE.extracting.end, stage: "extracting" });

  const tmpRoot = path.join(os.tmpdir(), "xhs-worker", jobId);
  const mp4Dir = path.join(tmpRoot, "mp4");
  const gifDir = path.join(tmpRoot, "gif");
  fs.mkdirSync(mp4Dir, { recursive: true });
  fs.mkdirSync(gifDir, { recursive: true });

  try {
    const { start: dlStart, end: dlEnd } = STAGE_RANGE.downloading;
    const mp4Paths = await downloadVideos(videoUrls, mp4Dir, (done, total) => {
      void onProgress({
        percent: dlStart + Math.round(((dlEnd - dlStart) * done) / total),
        stage: "downloading",
        current: done,
        total,
      });
    });

    const { start: cvStart, end: cvEnd } = STAGE_RANGE.converting;
    const gifPaths = await convertAll(mp4Paths, gifDir, (done, total) => {
      void onProgress({
        percent: cvStart + Math.round(((cvEnd - cvStart) * done) / total),
        stage: "converting",
        current: done,
        total,
      });
    });

    await onProgress({ percent: STAGE_RANGE.uploading.start, stage: "uploading" });
    const { gifs, zipUrl } = await uploadResults(noteId, jobId, gifPaths);
    await onProgress({ percent: STAGE_RANGE.uploading.end, stage: "uploading" });

    return { status: "done", noteId, gifs, zipUrl };
  } finally {
    // Object storage is now the source of truth — local temp files are
    // disposable once uploaded (plan section 4.4 cleanup policy).
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
