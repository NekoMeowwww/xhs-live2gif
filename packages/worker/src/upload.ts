import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import archiver from "archiver";
import { isValidNoteId, MediaResult } from "@xhs/shared";

const BUCKET = process.env.XHS_S3_BUCKET ?? "";
// Long enough for a user to click through after the job finishes, short
// enough to limit hot-link sharing of scraped third-party content.
const SIGNED_URL_TTL_SECONDS = 15 * 60;

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.XHS_S3_ENDPOINT,
    region: process.env.XHS_S3_REGION || "auto",
    forcePathStyle: process.env.XHS_S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.XHS_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.XHS_S3_SECRET_ACCESS_KEY ?? "",
    },
  });
}

async function uploadAndSign(
  s3: S3Client,
  localPath: string,
  key: string,
  contentType: string,
): Promise<string> {
  const body = fs.readFileSync(localPath);
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });
}

function buildZip(filePaths: string[], jobId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(os.tmpdir(), `${jobId}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip");
    output.on("close", () => resolve(zipPath));
    archive.on("error", reject);
    archive.pipe(output);
    for (const filePath of filePaths) {
      archive.file(filePath, { name: path.basename(filePath) });
    }
    void archive.finalize();
  });
}

export async function uploadResults(
  noteId: string,
  jobId: string,
  filePaths: string[],
  contentType: string,
): Promise<{ files: MediaResult[]; zipUrl?: string }> {
  if (!isValidNoteId(noteId)) {
    // noteId is interpolated into the object storage key below — never trust
    // it there without this check, even though extract.ts already validates it.
    throw new Error(`Refusing to use invalid noteId as storage key: ${noteId}`);
  }

  const s3 = getS3Client();
  const prefix = `xhs-gifs/${noteId}/${jobId}`;
  const files: MediaResult[] = [];

  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    const url = await uploadAndSign(s3, filePath, `${prefix}/${name}`, contentType);
    files.push({ name, url });
  }

  // A single file has nothing to bundle — skip the zip rather than wrapping
  // one (often large, for mp4) file in another file for no benefit.
  if (filePaths.length <= 1) {
    return { files };
  }

  const zipPath = await buildZip(filePaths, jobId);
  try {
    const zipUrl = await uploadAndSign(s3, zipPath, `${prefix}/all.zip`, "application/zip");
    return { files, zipUrl };
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}
