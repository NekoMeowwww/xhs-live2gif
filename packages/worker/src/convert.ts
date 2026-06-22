import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

// Same two-pass palette filter graph as scripts/xhs-live2gif.sh — proven on
// the test note (18/18 conversions succeeded). Do not change without re-testing.
const FFMPEG_FILTER =
  "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse";

async function convertToGif(mp4Path: string, gifPath: string): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i", mp4Path,
      "-vf", FFMPEG_FILTER,
      "-loop", "0",
      gifPath,
      "-hide_banner",
      "-loglevel", "error",
    ],
    { timeout: 60_000 },
  );
}

export async function convertAll(mp4Paths: string[], gifDir: string): Promise<string[]> {
  const gifPaths: string[] = [];
  for (const mp4Path of mp4Paths) {
    const name = path.basename(mp4Path, ".mp4");
    const gifPath = path.join(gifDir, `${name}.gif`);
    await convertToGif(mp4Path, gifPath);
    gifPaths.push(gifPath);
  }
  return gifPaths;
}
