import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { AuthSpec } from "../github/app-token.js";

export interface GitIdentity {
  name: string;
  email: string;
}

const FALLBACK_IDENTITY: GitIdentity = {
  name: "shopfloor[bot]",
  email: "shopfloor@users.noreply.github.com",
};

// GitHub publishes 41898282 as the canonical user id for the github-actions
// bot account. Used in the default email format for commits authored via the
// workflow's built-in GITHUB_TOKEN.
const GITHUB_ACTIONS_IDENTITY: GitIdentity = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

export interface ResolveBotIdentityDeps {
  appAuthFactory?: typeof createAppAuth;
  fetchAppSlug?: (jwt: string) => Promise<string>;
  fetchBotUserId?: (slug: string) => Promise<number>;
}

// Resolves the commit identity Shopfloor should use given the resolved auth
// surface. The "app" path makes two cheap API calls: one to /app to learn the
// App slug, one to /users/<slug>[bot] for the bot user id. Together they
// produce the canonical `<id>+<slug>[bot]@users.noreply.github.com` email
// that attributes commits to the App's bot account in the GitHub UI. The
// other auth surfaces (github_token, preminted) fall back to identities that
// at least let `git commit` succeed.
export async function resolveBotIdentity(
  auth: AuthSpec,
  deps: ResolveBotIdentityDeps = {},
): Promise<GitIdentity> {
  if (auth.kind === "token" && auth.source === "github_token") {
    return GITHUB_ACTIONS_IDENTITY;
  }
  if (auth.kind !== "app") {
    core.warning(
      "Shopfloor is running with a preminted installation token; cannot resolve the App's bot identity. Commits will use a generic identity. Switch to github_app_client_id + github_app_private_key for proper attribution.",
    );
    return FALLBACK_IDENTITY;
  }

  try {
    const appAuthFactory = deps.appAuthFactory ?? createAppAuth;
    const fetchAppSlug = deps.fetchAppSlug ?? defaultFetchAppSlug;
    const fetchBotUserId = deps.fetchBotUserId ?? defaultFetchBotUserId;

    const authFn = appAuthFactory({
      appId: auth.clientId,
      privateKey: auth.privateKey,
    });
    const { token: jwt } = await authFn({ type: "app" });
    const slug = await fetchAppSlug(jwt);
    const userId = await fetchBotUserId(slug);
    return {
      name: `${slug}[bot]`,
      email: `${userId}+${slug}[bot]@users.noreply.github.com`,
    };
  } catch (err) {
    core.warning(
      `Could not resolve App bot identity (${(err as Error).message}); falling back to a generic identity.`,
    );
    return FALLBACK_IDENTITY;
  }
}

async function defaultFetchAppSlug(jwt: string): Promise<string> {
  const octokit = new Octokit({ auth: jwt });
  const { data } = await octokit.rest.apps.getAuthenticated();
  const slug = data?.slug;
  if (!slug) throw new Error("GET /app did not return a slug");
  return slug;
}

async function defaultFetchBotUserId(slug: string): Promise<number> {
  // The bot user (e.g. `shopfloor[bot]`) is a public account; no auth needed.
  const octokit = new Octokit();
  const { data } = await octokit.rest.users.getByUsername({
    username: `${slug}[bot]`,
  });
  return data.id;
}

export interface ApplyGitIdentityOpts {
  cwd: string;
  identity: GitIdentity;
  sshSigningKey?: string | null;
}

// Writes the resolved identity to the repo-local git config (NOT --global).
// Repo-local matters because the action's Node process runs in the same
// checkout the Claude agent later inherits; the agent's `git commit` reads
// .git/config and gets the identity for free. Repo-local also avoids
// clobbering a developer's ~/.gitconfig if the action is ever exercised
// locally via `act` or a similar harness.
export async function applyGitIdentity(
  opts: ApplyGitIdentityOpts,
): Promise<void> {
  await runGit(opts.cwd, ["config", "user.name", opts.identity.name]);
  await runGit(opts.cwd, ["config", "user.email", opts.identity.email]);

  const key = opts.sshSigningKey?.trim();
  if (!key) return;

  // Materialise the signing key to a 0600-mode file. Path is in a freshly
  // minted temp dir so we don't fight an existing ~/.ssh on the runner.
  const dir = mkdtempSync(join(tmpdir(), "shopfloor-ssh-"));
  const keyPath = join(dir, "signing_key");
  writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`);
  chmodSync(keyPath, 0o600);

  await runGit(opts.cwd, ["config", "gpg.format", "ssh"]);
  await runGit(opts.cwd, ["config", "user.signingkey", keyPath]);
  await runGit(opts.cwd, ["config", "commit.gpgsign", "true"]);
  await runGit(opts.cwd, ["config", "tag.gpgsign", "true"]);
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`),
        );
      }
    });
  });
}
