import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobResult } from "@xhs/shared";
import { extractLivePhotos } from "./extract";
import { downloadVideos } from "./download";
import { convertAll } from "./convert";
import { uploadResults } from "./upload";

export async function processJob(jobId: string, url: string): Promise<JobResult> {
  const { noteId, videoUrls } = await extractLivePhotos(url);

  if (videoUrls.length === 0) {
    return { status: "done", noteId, gifs: [], message: "该笔记没有实况图片（livePhoto），无需转换。" };
  }

  const tmpRoot = path.join(os.tmpdir(), "xhs-worker", jobId);
  const mp4Dir = path.join(tmpRoot, "mp4");
  const gifDir = path.join(tmpRoot, "gif");
  fs.mkdirSync(mp4Dir, { recursive: true });
  fs.mkdirSync(gifDir, { recursive: true });

  try {
    const mp4Paths = await downloadVideos(videoUrls, mp4Dir);
    const gifPaths = await convertAll(mp4Paths, gifDir);
    const { gifs, zipUrl } = await uploadResults(noteId, jobId, gifPaths);
    return { status: "done", noteId, gifs, zipUrl };
  } finally {
    // Object storage is now the source of truth — local temp files are
    // disposable once uploaded (plan section 4.4 cleanup policy).
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
