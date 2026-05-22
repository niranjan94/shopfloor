import type { Octokit } from "@octokit/rest";
import { deleteIssueGraphQL } from "./github.js";
import { deleteShopfloorBranches } from "./baseline.js";

export interface CleanupReport {
  prsClosed: number;
  branchesDeleted: number;
  issuesDeleted: number;
  errors: Array<{ context: string; message: string }>;
}

export async function cleanupByTitlePrefix(
  gh: Octokit,
  owner: string,
  repo: string,
  titlePrefix: string,
): Promise<CleanupReport> {
  const report: CleanupReport = {
    prsClosed: 0,
    branchesDeleted: 0,
    issuesDeleted: 0,
    errors: [],
  };

  const prHits = await gh.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:pr in:title "${titlePrefix}"`,
    per_page: 100,
  });
  for (const item of prHits.data.items) {
    try {
      await gh.pulls.update({
        owner,
        repo,
        pull_number: item.number,
        state: "closed",
      });
      report.prsClosed += 1;
    } catch (err) {
      report.errors.push({
        context: `close PR #${item.number}`,
        message: (err as Error).message,
      });
      continue;
    }
    let headRef: string | undefined;
    try {
      const pr = await gh.pulls.get({ owner, repo, pull_number: item.number });
      headRef = pr.data.head.ref;
    } catch (err) {
      report.errors.push({
        context: `get PR #${item.number} head`,
        message: (err as Error).message,
      });
    }
    if (headRef) {
      try {
        await gh.git.deleteRef({
          owner,
          repo,
          ref: `heads/${headRef}`,
        });
        report.branchesDeleted += 1;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 422) continue;
        report.errors.push({
          context: `delete branch ${headRef}`,
          message: (err as Error).message,
        });
      }
    }
  }

  const issueHits = await gh.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue in:title "${titlePrefix}"`,
    per_page: 100,
  });
  for (const item of issueHits.data.items) {
    try {
      await deleteIssueGraphQL(gh, owner, repo, item.number);
      report.issuesDeleted += 1;
    } catch (err) {
      report.errors.push({
        context: `delete issue #${item.number}`,
        message: (err as Error).message,
      });
    }
  }

  // Stage PRs target shopfloor/<stage>/<n>-<slug> branches. The per-PR loop
  // above deletes a branch only when the PR list still matches the title; refs
  // whose PRs were already closed in a prior cleanup are skipped. Sweep the
  // namespace explicitly so nothing lingers across runs.
  const sweep = await deleteShopfloorBranches(gh, owner, repo);
  report.branchesDeleted += sweep.deleted;
  for (const e of sweep.errors) {
    report.errors.push({
      context: `delete branch ${e.ref}`,
      message: e.message,
    });
  }

  return report;
}
