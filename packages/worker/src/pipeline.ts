import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobResult, JobProgress, OutputFormat } from "@xhs/shared";
import { extractLivePhotos } from "./extract";
import { downloadVideos } from "./download";
import { convertAll } from "./convert";
import { uploadResults } from "./upload";

export type ProgressReporter = (progress: JobProgress) => void | Promise<void>;

// Stage boundaries are rough time-share estimates (download/convert are the
// two slow steps, extraction and upload are comparatively quick) — tuned for
// a reasonable-looking bar, not measured benchmarks.
const STAGE_RANGE_GIF = {
  extracting: { start: 0, end: 10 },
  downloading: { start: 10, end: 55 },
  converting: { start: 55, end: 95 },
  uploading: { start: 95, end: 100 },
} as const;

// mp4 mode skips conversion entirely, so downloading absorbs the share of
// the bar that converting would otherwise have used.
const STAGE_RANGE_MP4 = {
  extracting: { start: 0, end: 10 },
  downloading: { start: 10, end: 90 },
  uploading: { start: 90, end: 100 },
} as const;

export async function processJob(
  jobId: string,
  url: string,
  format: OutputFormat,
  onProgress: ProgressReporter = () => {},
): Promise<JobResult> {
  const stageRange = format === "mp4" ? STAGE_RANGE_MP4 : STAGE_RANGE_GIF;

  await onProgress({ percent: stageRange.extracting.start, stage: "extracting" });
  const { noteId, videoUrls } = await extractLivePhotos(url);

  if (videoUrls.length === 0) {
    return { status: "done", noteId, files: [], message: "该笔记没有实况图片（livePhoto），无需转换。" };
  }

  await onProgress({ percent: stageRange.extracting.end, stage: "extracting" });

  const tmpRoot = path.join(os.tmpdir(), "xhs-worker", jobId);
  const mp4Dir = path.join(tmpRoot, "mp4");
  fs.mkdirSync(mp4Dir, { recursive: true });

  try {
    const { start: dlStart, end: dlEnd } = stageRange.downloading;
    const mp4Paths = await downloadVideos(videoUrls, mp4Dir, (done, total) => {
      void onProgress({
        percent: dlStart + Math.round(((dlEnd - dlStart) * done) / total),
        stage: "downloading",
        current: done,
        total,
      });
    });

    let outputPaths = mp4Paths;
    let contentType = "video/mp4";

    if (format === "gif") {
      const gifDir = path.join(tmpRoot, "gif");
      fs.mkdirSync(gifDir, { recursive: true });

      const { start: cvStart, end: cvEnd } = STAGE_RANGE_GIF.converting;
      outputPaths = await convertAll(mp4Paths, gifDir, (done, total) => {
        void onProgress({
          percent: cvStart + Math.round(((cvEnd - cvStart) * done) / total),
          stage: "converting",
          current: done,
          total,
        });
      });
      contentType = "image/gif";
    }

    await onProgress({ percent: stageRange.uploading.start, stage: "uploading" });
    const { files, zipUrl } = await uploadResults(noteId, jobId, outputPaths, contentType);
    await onProgress({ percent: stageRange.uploading.end, stage: "uploading" });

    return { status: "done", noteId, files, zipUrl };
  } finally {
    // Object storage is now the source of truth — local temp files are
    // disposable once uploaded (plan section 4.4 cleanup policy).
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
