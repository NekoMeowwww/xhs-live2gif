import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

// The live-photo video URLs are signed and time-limited by Xiaohongshu's CDN —
// download promptly after extraction, same as the bash script did.
async function downloadVideo(url: string, destPath: string): Promise<void> {
  await execFileAsync("curl", ["-s", "-o", destPath, url], { timeout: 30_000 });
}

export async function downloadVideos(urls: string[], destDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const idx = String(i + 1).padStart(2, "0");
    const dest = path.join(destDir, `live_${idx}.mp4`);
    await downloadVideo(urls[i], dest);
    paths.push(dest);
  }
  return paths;
}
