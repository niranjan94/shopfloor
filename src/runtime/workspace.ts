import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CloneWorkspaceOpts {
  owner: string;
  repo: string;
  /** GitHub token (installation or PAT) embedded in clone URL. */
  token: string;
  /** Branch or SHA to checkout after clone. Defaults to remote HEAD. */
  ref?: string;
  /** Parent directory for the temp workspace. Defaults to os.tmpdir(). */
  parentDir?: string;
  /** Shallow clone depth. Defaults to 1. Use 0 for full history. */
  depth?: number;
}

export interface GitWorkspace {
  cwd: string;
  cleanup: () => Promise<void>;
}

/**
 * Clone a GitHub repo into a fresh temp directory for stage execution.
 * Caller must invoke cleanup() (or use withGitWorkspace).
 */
export async function cloneGitWorkspace(
  opts: CloneWorkspaceOpts,
): Promise<GitWorkspace> {
  const parent = opts.parentDir ?? tmpdir();
  const cwd = await mkdtemp(join(parent, "shopfloor-ws-"));
  const url = `https://x-access-token:${opts.token}@github.com/${opts.owner}/${opts.repo}.git`;
  const depth = opts.depth === undefined ? 1 : opts.depth;

  try {
    const cloneArgs = ["clone", "--no-tags"];
    if (depth > 0) {
      cloneArgs.push(`--depth=${depth}`);
    }
    if (opts.ref) {
      cloneArgs.push("--branch", opts.ref);
    }
    cloneArgs.push(url, cwd);
    await runGit(parent, cloneArgs);
  } catch (err) {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

/** Clone, run handler, always tear down the workspace. */
export async function withGitWorkspace<T>(
  opts: CloneWorkspaceOpts,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const ws = await cloneGitWorkspace(opts);
  try {
    return await fn(ws.cwd);
  } finally {
    await ws.cleanup();
  }
}

export function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const cleaned = `${stderr}\n${stdout}`.replace(
        /x-access-token:[^@]+@/g,
        "x-access-token:***@",
      );
      reject(
        new Error(
          `git ${args.filter((a) => !a.includes("x-access-token")).join(" ")} failed (exit ${code}): ${cleaned.trim()}`,
        ),
      );
    });
  });
}

/** Resolve a short-lived token for clone from env / App credentials is left to callers. */
export function githubCloneUrl(
  owner: string,
  repo: string,
  token: string,
): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}
