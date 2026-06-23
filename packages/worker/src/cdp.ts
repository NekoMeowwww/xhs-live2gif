import CDP from "chrome-remote-interface";

// opencli 1.8.4's `browser` subcommand does NOT honor OPENCLI_CDP_ENDPOINT —
// confirmed from source: that env var only takes effect in the Electron
// branch of execution.js, while `browser open/eval/close` always goes
// through shouldUseBrowserSession, which forces the extension bridge
// regardless. The extension bridge requires a real desktop Chrome with the
// OpenCLI extension loaded, which doesn't work on a headless Linux server
// (Chrome 127+ has also progressively locked down unpacked/sideloaded
// extension loading). So instead of going through opencli at all, we talk
// to Chrome's CDP directly — the same approach already proven in
// bootstrap/cookie-import.js.
//
// Default port deliberately avoids 9222: it's the universal default for
// Chrome/Puppeteer/Playwright debug ports and collides easily with other
// tooling on a shared host (this is exactly what happened during rollout —
// an unrelated root-owned Playwright Chrome was already squatting 9222).
const CDP_ENDPOINT = process.env.XHS_CDP_ENDPOINT ?? "http://127.0.0.1:19222";
const NAVIGATION_TIMEOUT_MS = 20_000;

function parseEndpoint(endpoint: string): { host: string; port: number } {
  const u = new URL(endpoint);
  return { host: u.hostname, port: Number(u.port || 80) };
}

const { host: CDP_HOST, port: CDP_PORT } = parseEndpoint(CDP_ENDPOINT);

export async function isCdpReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

type Evaluate = (js: string) => Promise<unknown>;

// Opens one CDP connection, navigates to `url`, hands the caller an
// `evaluate` function to run JS in that page (as many times as needed), then
// always disconnects — mirrors the open/eval/eval/.../close lifecycle the
// bash script and opencli.ts used, just over raw CDP instead of a CLI.
export async function withPage<T>(url: string, fn: (evaluate: Evaluate) => Promise<T>): Promise<T> {
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT });
  try {
    const { Page, Runtime } = client;
    await Page.enable();

    const loaded = new Promise<void>((resolve) => {
      Page.loadEventFired(() => resolve());
    });
    await Page.navigate({ url });
    await Promise.race([
      loaded,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Page load timed out after ${NAVIGATION_TIMEOUT_MS}ms: ${url}`)), NAVIGATION_TIMEOUT_MS),
      ),
    ]);

    const evaluate: Evaluate = async (js) => {
      const { result, exceptionDetails } = await Runtime.evaluate({ expression: js, returnByValue: true });
      if (exceptionDetails) {
        throw new Error(`Page eval threw: ${exceptionDetails.text}`);
      }
      return result.value;
    };

    return await fn(evaluate);
  } finally {
    await client.close();
  }
}
