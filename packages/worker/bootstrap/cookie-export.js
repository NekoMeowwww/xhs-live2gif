#!/usr/bin/env node
/**
 * Run ONCE on the Windows machine that already has a logged-in Xiaohongshu
 * Chrome session. Exports all xiaohongshu.com cookies (including HttpOnly
 * ones like web_session/a1 — document.cookie cannot see these, hence CDP)
 * to a JSON file for transfer to the Linux worker host.
 *
 * IMPORTANT: close all regular Chrome windows first. Chrome refuses to open
 * the same --user-data-dir twice, so this script needs exclusive access to
 * your profile dir for a few seconds.
 *
 * Usage:
 *   node cookie-export.js "<chrome-profile-dir>" [out.json]
 * Example profile dir (Windows default):
 *   "C:\\Users\\<you>\\AppData\\Local\\Google\\Chrome\\User Data"
 *
 * See docs/cdp-bootstrap.md for the full procedure including the matching
 * Linux-side cookie-import.js step.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const CDP = require("chrome-remote-interface");

const CHROME_PATH =
  process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_DIR = process.argv[2];
const OUT_PATH = process.argv[3] ?? "xhs-cookies.json";
const DEBUG_PORT = 9223;

if (!PROFILE_DIR) {
  console.error("Usage: node cookie-export.js <chrome-profile-dir> [out.json]");
  console.error('Example: "C:\\Users\\<you>\\AppData\\Local\\Google\\Chrome\\User Data"');
  console.error("Close all regular Chrome windows first.");
  process.exit(1);
}

async function main() {
  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );

  // Give Chrome a moment to start its CDP listener.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const client = await CDP({ port: DEBUG_PORT });
  try {
    const { Network } = client;
    await Network.enable();
    const { cookies } = await Network.getAllCookies();
    const xhsCookies = cookies.filter((c) => c.domain.includes("xiaohongshu.com"));

    if (xhsCookies.length === 0) {
      console.error(
        "No xiaohongshu.com cookies found — make sure this profile is actually logged in to xiaohongshu.com.",
      );
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(xhsCookies, null, 2));
    console.log(`Exported ${xhsCookies.length} cookies to ${OUT_PATH}`);
    console.log("Transfer this file to the Linux worker host (scp/sftp), then run cookie-import.js there.");
    console.log("Treat this file as a credential — delete it from both machines once import is verified.");
  } finally {
    await client.close();
    chrome.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
