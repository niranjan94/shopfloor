import type { Octokit } from "@octokit/rest";

export const BASELINE_TAG = "smoke-baseline";
const SHOPFLOOR_BRANCH_PREFIX = "shopfloor/";

export interface ResetReport {
  baselineSha: string;
  defaultBranch: string;
  mainBeforeSha: string;
  mainAfterSha: string;
  noop: boolean;
}

/**
 * Resolve the smoke-baseline tag to a commit SHA. Tags are typically
 * lightweight (object.type === "commit") but the helper handles the annotated
 * case (object.type === "tag" -> peel one level) for robustness.
 */
async function resolveBaselineSha(
  gh: Octokit,
  owner: string,
  repo: string,
): Promise<string> {
  let ref;
  try {
    ref = await gh.git.getRef({
      owner,
      repo,
      ref: `tags/${BASELINE_TAG}`,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      throw new Error(
        `Tag "${BASELINE_TAG}" not found on ${owner}/${repo}. Create it pointing at the desired clean baseline commit, then re-run.`,
      );
    }
    throw err;
  }
  if (ref.data.object.type === "commit") {
    return ref.data.object.sha;
  }
  const annotated = await gh.git.getTag({
    owner,
    repo,
    tag_sha: ref.data.object.sha,
  });
  return annotated.data.object.sha;
}

/**
 * Force-update the default branch ref to the smoke-baseline tag's commit so
 * every scenario starts against a known, identical repo state. Returns enough
 * detail for the caller to log what changed.
 */
export async function resetDefaultBranchToBaseline(
  gh: Octokit,
  owner: string,
  repo: string,
): Promise<ResetReport> {
  const baselineSha = await resolveBaselineSha(gh, owner, repo);
  const repoInfo = await gh.repos.get({ owner, repo });
  const defaultBranch = repoInfo.data.default_branch;

  const main = await gh.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  const mainBeforeSha = main.data.object.sha;

  if (mainBeforeSha === baselineSha) {
    return {
      baselineSha,
      defaultBranch,
      mainBeforeSha,
      mainAfterSha: mainBeforeSha,
      noop: true,
    };
  }

  await gh.git.updateRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
    sha: baselineSha,
    force: true,
  });

  return {
    baselineSha,
    defaultBranch,
    mainBeforeSha,
    mainAfterSha: baselineSha,
    noop: false,
  };
}

/**
 * Delete every dangling `shopfloor/*` branch on the remote. Stage PRs target
 * these branches, so left-behind refs accumulate across runs even after PRs
 * close (closed PRs do not auto-delete their head branch). Returns the count
 * of refs successfully deleted.
 */
export async function deleteShopfloorBranches(
  gh: Octokit,
  owner: string,
  repo: string,
): Promise<{ deleted: number; errors: Array<{ ref: string; message: string }> }> {
  let refs: Array<{ ref: string }>;
  try {
    const res = await gh.git.listMatchingRefs({
      owner,
      repo,
      ref: `heads/${SHOPFLOOR_BRANCH_PREFIX}`,
    });
    refs = res.data as Array<{ ref: string }>;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { deleted: 0, errors: [] };
    throw err;
  }

  let deleted = 0;
  const errors: Array<{ ref: string; message: string }> = [];
  for (const r of refs) {
    const heads = r.ref.replace(/^refs\//, "");
    try {
      await gh.git.deleteRef({ owner, repo, ref: heads });
      deleted += 1;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 422) continue;
      errors.push({
        ref: r.ref,
        message: (err as Error).message,
      });
    }
  }
  return { deleted, errors };
}
