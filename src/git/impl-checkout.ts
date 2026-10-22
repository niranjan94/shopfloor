import { spawn } from "node:child_process";
import * as core from "@actions/core";
import { type AuthSpec, mintInstallationToken } from "../github/app-token.js";

export interface PrepareImplCheckoutOpts {
  cwd: string;
  branchName: string;
  baseBranch: string;
  revisionMode: boolean;
  owner: string;
  repo: string;
  token: string;
  /** Override the remote name. Defaults to "origin". */
  remote?: string;
}

export interface PushImplCommitsOpts {
  cwd: string;
  branchName: string;
  owner: string;
  repo: string;
  token: string;
  remote?: string;
}

// Configures the local working tree so the impl agent's commits land on the
// right branch. For first runs we create the branch from the default-branch
// HEAD that actions/checkout already provisioned. For revision runs we fetch
// the prior iteration's branch from the remote and reset the working tree
// onto it, so the agent sees the previous round's history before making new
// commits. The remote URL is reset to a credential-free form first: the agent
// runs in this checkout afterwards and must not find the installation token in
// .git/config. Credentials are supplied per git invocation (gitAuthEnv) only
// for the network operations Shopfloor itself performs.
export async function prepareImplCheckout(
  opts: PrepareImplCheckoutOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await setCleanRemote(opts.cwd, remote, opts.owner, opts.repo);
  await checkoutImplBranch({
    cwd: opts.cwd,
    branchName: opts.branchName,
    revisionMode: opts.revisionMode,
    remote,
    env: gitAuthEnv(opts.token),
  });
}

// Pushes whatever commits the agent landed on `branchName` to origin. This is
// the moment the impl branch first appears on the remote (for first runs) or
// gains its new iteration (for revision runs). The push is performed AFTER
// the agent finishes so the resulting `push` event (or
// `pull_request.synchronize` when a PR already exists) is attributed to the
// App identity, which lets downstream review workflows trigger. A push
// authenticated by the workflow's GITHUB_TOKEN would NOT trigger downstream
// workflows; this is why the App credentials are strongly preferred.
//
// The caller passes a freshly resolved token in case the pre-agent token has
// aged past its installation-token TTL during a long run. The remote URL is
// reset to its credential-free form because the agent had write access to
// .git/config and could have pointed the remote elsewhere.
export async function pushImplCommits(
  opts: PushImplCommitsOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await setCleanRemote(opts.cwd, remote, opts.owner, opts.repo);
  await runGit(
    opts.cwd,
    ["push", remote, opts.branchName],
    gitAuthEnv(opts.token),
  );
}

// Returns a closure that yields a usable git token for the given auth
// surface. For preminted or GITHUB_TOKEN auth the closure returns the static
// token on every call. For App auth it mints (or returns a cached, in-margin)
// installation token via @octokit/auth-app, so a long-running impl agent's
// post-agent push always uses a fresh token.
export function tokenResolverFor(
  auth: AuthSpec,
  owner: string,
  repo: string,
): () => Promise<string> {
  if (auth.kind === "token") {
    return async () => auth.token;
  }
  return () =>
    mintInstallationToken({
      clientId: auth.clientId,
      privateKey: auth.privateKey,
      owner,
      repo,
      installationId: auth.installationId,
    });
}

export function remoteUrlFor(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export async function setCleanRemote(
  cwd: string,
  remote: string,
  owner: string,
  repo: string,
): Promise<void> {
  await runGit(cwd, ["remote", "set-url", remote, remoteUrlFor(owner, repo)]);
}

const GITHUB_EXTRAHEADER_KEY = "http.https://github.com/.extraheader";

// Builds GIT_CONFIG_* environment variables that authenticate a single git
// invocation against github.com. Passing config through the environment keeps
// the token out of .git/config, out of the remote URL, and out of the process
// argv. The first entry is an empty value, which resets any extraheader
// inherited from repo config (for example a GITHUB_TOKEN persisted by
// actions/checkout) so only the App token is sent.
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  );
  core.setSecret(token);
  core.setSecret(basic);
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: GITHUB_EXTRAHEADER_KEY,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: GITHUB_EXTRAHEADER_KEY,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface FetchReviewBaseOpts {
  cwd: string;
  baseRef: string;
  /** Override the remote name. Defaults to "origin". */
  remote?: string;
  /** Extra environment for the fetch, typically gitAuthEnv(token). */
  env?: Record<string, string>;
}

export interface PrepareReviewBaseOpts extends FetchReviewBaseOpts {
  owner: string;
  repo: string;
  token: string;
}

// Provisions the base branch as a local `refs/remotes/<remote>/<base>` ref so
// the review lenses can diff the PR against it. A `pull/N/merge` checkout is a
// shallow merge commit whose parents are not present as objects and whose
// base-branch tracking ref does not exist, so any `origin/<base>...HEAD` the
// lens agent tries fails outright. We fetch the base tip at depth 1 (enough,
// because the lenses use a two-dot `git diff origin/<base> HEAD`, which
// compares tree snapshots and needs no shared ancestry).
export async function fetchReviewBase(
  opts: FetchReviewBaseOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await runGit(
    opts.cwd,
    [
      "fetch",
      "--no-tags",
      "--depth=1",
      remote,
      `+refs/heads/${opts.baseRef}:refs/remotes/${remote}/${opts.baseRef}`,
    ],
    opts.env,
  );
}

// The review checkout runs with `persist-credentials: false`, so the fetch is
// authenticated per invocation with the App token. The remote URL stays
// credential-free because the review lenses run in this checkout next.
export async function prepareReviewBase(
  opts: PrepareReviewBaseOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await setCleanRemote(opts.cwd, remote, opts.owner, opts.repo);
  await fetchReviewBase({
    cwd: opts.cwd,
    baseRef: opts.baseRef,
    remote,
    env: gitAuthEnv(opts.token),
  });
}

export interface CheckoutImplBranchOpts {
  cwd: string;
  branchName: string;
  revisionMode: boolean;
  remote?: string;
  /** Extra environment for the revision-mode fetch, typically gitAuthEnv(token). */
  env?: Record<string, string>;
}

// The branch-creation half of prepareImplCheckout. Separated from the remote
// URL reset so tests can drive it against a local file-system remote.
export async function checkoutImplBranch(
  opts: CheckoutImplBranchOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  if (opts.revisionMode) {
    await runGit(opts.cwd, ["fetch", remote, opts.branchName], opts.env);
    await runGit(opts.cwd, ["checkout", "-B", opts.branchName, "FETCH_HEAD"]);
    return;
  }
  // First run. actions/checkout left HEAD at the default branch tip, which is
  // exactly where the impl branch should diverge from. `checkout -B` reuses
  // the branch if a prior failed run left one behind locally, so re-runs are
  // idempotent.
  await runGit(opts.cwd, ["checkout", "-B", opts.branchName]);
}

function runGit(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
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
        // Strip any leaked token from the error message before bubbling.
        const cleaned = stderr.replace(
          /x-access-token:[^@]+@/g,
          "x-access-token:***@",
        );
        reject(
          new Error(
            `git ${args.join(" ")} failed (${code}): ${cleaned.trim()}`,
          ),
        );
      }
    });
  });
}
