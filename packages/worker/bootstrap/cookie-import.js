#!/usr/bin/env node
/**
 * Run ONCE on the Linux worker host, against the freshly-started Chrome from
 * infra/systemd/xhs-chrome.service (CDP on localhost:9222, empty profile).
 * Injects cookies manually exported from a real, logged-in Xiaohongshu
 * Chrome session (see docs/cdp-bootstrap.md for the export steps — a
 * cookie-export extension like "Cookie-Editor", not a script: modern Chrome's
 * App-Bound Encryption deliberately blocks programmatic extraction of a
 * copied profile's cookies, which is why this is a manual step on the export
 * side). This lets the Linux Chrome profile inherit the already-trusted
 * login session, skipping an interactive login on a brand-new server IP
 * (which risks triggering step-up verification).
 *
 * Accepts either:
 *   - Cookie-Editor's JSON export format (expirationDate, lowercase sameSite
 *     like "no_restriction"/"lax"/"strict"/"unspecified"), or
 *   - CDP's own Network.getAllCookies shape (expires, "None"/"Lax"/"Strict").
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

const SAME_SITE_MAP = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
  unspecified: undefined,
  none: "None",
};

function normalizeSameSite(value) {
  if (value === undefined || value === null) return undefined;
  if (["None", "Lax", "Strict"].includes(value)) return value;
  return SAME_SITE_MAP[String(value).toLowerCase()];
}

function normalizeCookie(raw) {
  const expires = raw.expires ?? raw.expirationDate ?? undefined;
  return {
    name: raw.name,
    value: raw.value,
    domain: raw.domain,
    path: raw.path ?? "/",
    secure: Boolean(raw.secure),
    httpOnly: Boolean(raw.httpOnly),
    sameSite: normalizeSameSite(raw.sameSite),
    // Omit expires entirely for session cookies — CDP treats a missing
    // value as session-scoped, matching the source cookie's behavior.
    ...(expires !== undefined && !raw.session ? { expires } : {}),
  };
}

async function main() {
  const rawCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
  const xhsCookies = rawCookies
    .filter((c) => typeof c.domain === "string" && c.domain.includes("xiaohongshu.com"))
    .map(normalizeCookie);

  if (xhsCookies.length === 0) {
    console.error("No xiaohongshu.com cookies found in this file — check the export, nothing was imported.");
    process.exit(1);
  }

  const client = await CDP({ port: CDP_PORT });
  try {
    const { Network, Page, Runtime } = client;
    await Network.enable();

    let failures = 0;
    for (const cookie of xhsCookies) {
      try {
        await Network.setCookie(cookie);
      } catch (err) {
        failures += 1;
        console.error(`Failed to set cookie "${cookie.name}": ${String(err)}`);
      }
    }
    console.log(`Injected ${xhsCookies.length - failures}/${xhsCookies.length} cookies.`);

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
