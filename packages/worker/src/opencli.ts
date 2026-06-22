import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

// On Linux (the production target) opencli is a plain executable — invoke it
// directly, no shell needed. On Windows, npm wraps JS-based CLIs in a ".cmd"
// shim that Node's child_process refuses to spawn directly (EINVAL) without
// shell:true, and shell:true does not safely quote our argv on Windows
// (DEP0190: arguments are concatenated, not escaped). So on Windows we
// resolve the real entry script once and run it via `node <script> ...args`
// instead, which needs no shell on either platform.
function resolveOpencliInvocation(): { command: string; prefixArgs: string[] } {
  if (process.platform !== "win32") {
    return { command: "opencli", prefixArgs: [] };
  }
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const pkgDir = path.join(globalRoot, "@jackwener", "opencli");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const binRel: string = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.opencli;
  return { command: process.execPath, prefixArgs: [path.join(pkgDir, binRel)] };
}

const { command: OPENCLI_COMMAND, prefixArgs: OPENCLI_PREFIX_ARGS } = resolveOpencliInvocation();

export interface OpencliSession {
  name: string;
}

let sessionCounter = 0;

export function createSession(prefix = "xhs-job"): OpencliSession {
  sessionCounter += 1;
  return { name: `${prefix}-${process.pid}-${Date.now()}-${sessionCounter}` };
}

async function runOpencli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(OPENCLI_COMMAND, [...OPENCLI_PREFIX_ARGS, ...args], {
    maxBuffer: 1024 * 1024 * 16,
    timeout: 30_000,
    env: process.env,
  });
  return stdout;
}

export async function browserOpen(session: OpencliSession, url: string): Promise<void> {
  await runOpencli(["browser", session.name, "open", url]);
}

export async function browserEval(session: OpencliSession, js: string): Promise<string> {
  return runOpencli(["browser", session.name, "eval", js]);
}

// Best-effort, mirrors the bash script's `cleanup() { ... || true; }` trap.
export async function browserClose(session: OpencliSession): Promise<void> {
  try {
    await runOpencli(["browser", session.name, "close"]);
  } catch {
    // session tab lease release failing is not fatal — ignore.
  }
}

export async function doctor(): Promise<void> {
  await runOpencli(["doctor"]);
}
