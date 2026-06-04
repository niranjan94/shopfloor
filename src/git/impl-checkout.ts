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
// commits. In every case we rewrite origin's URL to embed the App
// installation token so the post-agent push can authenticate without
// relying on a credential helper. actions/checkout in the consumer workflow
// must run with `persist-credentials: false`; otherwise its GITHUB_TOKEN
// http extraheader shadows the embedded x-access-token credential here.
export async function prepareImplCheckout(
  opts: PrepareImplCheckoutOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await setRemoteWithToken(opts.cwd, remote, opts.owner, opts.repo, opts.token);
  await checkoutImplBranch({
    cwd: opts.cwd,
    branchName: opts.branchName,
    revisionMode: opts.revisionMode,
    remote,
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
// We always re-set the remote URL with a freshly resolved token in case the
// pre-agent token has aged past its installation-token TTL during a long
// run.
export async function pushImplCommits(
  opts: PushImplCommitsOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await setRemoteWithToken(opts.cwd, remote, opts.owner, opts.repo, opts.token);
  await runGit(opts.cwd, ["push", remote, opts.branchName]);
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

// Rewrites `<remote>`'s URL to https://x-access-token:<token>@github.com/<owner>/<repo>.git.
// Exported so tests can exercise URL formatting without exercising the full
// prepare/push flow.
export async function setRemoteWithToken(
  cwd: string,
  remote: string,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  // Mask the token in case it ends up in any error output. The token is also
  // already masked by entry.ts via the App auth machinery; this is belt-and-
  // braces for callers that wire helpers directly.
  core.setSecret(token);
  await runGit(cwd, ["remote", "set-url", remote, url]);
}

export interface FetchReviewBaseOpts {
  cwd: string;
  baseRef: string;
  /** Override the remote name. Defaults to "origin". */
  remote?: string;
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
  await runGit(opts.cwd, [
    "fetch",
    "--no-tags",
    "--depth=1",
    remote,
    `+refs/heads/${opts.baseRef}:refs/remotes/${remote}/${opts.baseRef}`,
  ]);
}

// Embeds the App installation token in the remote URL (the review checkout
// runs with `persist-credentials: false`, so the agent has no usable git
// credential) and then fetches the base ref. Mirrors prepareImplCheckout's
// set-url-then-fetch shape.
export async function prepareReviewBase(
  opts: PrepareReviewBaseOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  await setRemoteWithToken(opts.cwd, remote, opts.owner, opts.repo, opts.token);
  await fetchReviewBase({ cwd: opts.cwd, baseRef: opts.baseRef, remote });
}

export interface CheckoutImplBranchOpts {
  cwd: string;
  branchName: string;
  revisionMode: boolean;
  remote?: string;
}

// The branch-creation half of prepareImplCheckout. Separated from the URL
// rewriting so tests can drive it against a local file-system remote
// without funneling through https://x-access-token URLs.
export async function checkoutImplBranch(
  opts: CheckoutImplBranchOpts,
): Promise<void> {
  const remote = opts.remote ?? "origin";
  if (opts.revisionMode) {
    await runGit(opts.cwd, ["fetch", remote, opts.branchName]);
    await runGit(opts.cwd, ["checkout", "-B", opts.branchName, "FETCH_HEAD"]);
    return;
  }
  // First run. actions/checkout left HEAD at the default branch tip, which is
  // exactly where the impl branch should diverge from. `checkout -B` reuses
  // the branch if a prior failed run left one behind locally, so re-runs are
  // idempotent.
  await runGit(opts.cwd, ["checkout", "-B", opts.branchName]);
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
