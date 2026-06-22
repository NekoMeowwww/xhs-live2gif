#!/usr/bin/env node
/**
 * Run ONCE on the Linux worker host, against the freshly-started Chrome from
 * infra/systemd/xhs-chrome.service (CDP on localhost:9222, empty profile).
 * Injects the cookies exported by cookie-export.js so the Linux Chrome
 * profile inherits the already-trusted Xiaohongshu login session, skipping
 * an interactive login on a brand-new server IP (which risks triggering
 * step-up verification). See docs/cdp-bootstrap.md.
 *
 * Usage:
 *   node cookie-import.js <cookies.json>
 */

const fs = require("node:fs");
const CDP = require("chrome-remote-interface");

const COOKIES_PATH = process.argv[2];
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);

if (!COOKIES_PATH) {
  console.error("Usage: node cookie-import.js <cookies.json>");
  process.exit(1);
}

async function main() {
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
  const client = await CDP({ port: CDP_PORT });
  try {
    const { Network, Page, Runtime } = client;
    await Network.enable();

    for (const cookie of cookies) {
      await Network.setCookie({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expires: cookie.expires,
      });
    }
    console.log(`Injected ${cookies.length} cookies.`);

    await Page.enable();
    await Page.navigate({ url: "https://www.xiaohongshu.com" });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { result } = await Runtime.evaluate({
      expression:
        "window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user ? 'has-user-state' : 'no-user-state'",
    });
    console.log(`Page probe after navigation: ${result.value}`);
    console.log(
      'Now verify with: OPENCLI_CDP_ENDPOINT=http://localhost:9222 opencli browser <session> eval "window.__INITIAL_STATE__.user"',
    );
    console.log("Confirm it shows your logged-in account, not a login wall, before relying on this profile.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
