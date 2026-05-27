import type { Octokit } from "@octokit/rest";
import chalk from "chalk";
import {
  deleteShopfloorBranches,
  resetDefaultBranchToBaseline,
} from "./baseline.js";
import { cleanupByTitlePrefix } from "./cleanup.js";
import { runScenario } from "./scenario.js";
import type { AppLogins, Scenario, ScenarioResult } from "./types.js";

export interface RunAllOpts {
  gh: Octokit;
  owner: string;
  repo: string;
  runTag: string;
  appLogins: AppLogins;
  pollMs?: number;
}

export async function preflight(opts: {
  gh: Octokit;
  owner: string;
  repo: string;
  allowStale: boolean;
}): Promise<void> {
  let repoInfo: Awaited<ReturnType<typeof opts.gh.repos.get>>["data"];
  try {
    const res = await opts.gh.repos.get({
      owner: opts.owner,
      repo: opts.repo,
    });
    repoInfo = res.data;
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new Error(
      `Cannot access ${opts.owner}/${opts.repo} (status ${status ?? "?"}). The PAT must have repo access and Administration:read/write.`,
    );
  }

  if (!repoInfo.permissions?.admin) {
    throw new Error(
      `PAT does not have admin permission on ${opts.owner}/${opts.repo}. Required for GraphQL deleteIssue at cleanup time.`,
    );
  }

  // Auto-clean any leftover smoke-* PRs and issues from prior runs that
  // didn't reach the per-scenario cleanup step (timeouts, failures). The
  // baseline reset below blows away the merged commits, so re-opening the
  // pipeline against the new main needs a clean issue/PR slate too.
  // --allow-stale opts out of the auto-clean for the rare case where the user
  // wants to inspect leftovers before they vanish.
  if (!opts.allowStale) {
    const stale = await cleanupByTitlePrefix(
      opts.gh,
      opts.owner,
      opts.repo,
      "smoke-",
    );
    if (
      stale.prsClosed > 0 ||
      stale.issuesDeleted > 0 ||
      stale.branchesDeleted > 0
    ) {
      console.log(
        chalk.dim(
          `  preflight cleanup: ${stale.prsClosed} PR(s), ${stale.issuesDeleted} issue(s), ${stale.branchesDeleted} branch(es)`,
        ),
      );
    }
    if (stale.errors.length > 0) {
      const head = stale.errors.slice(0, 3);
      const tail =
        stale.errors.length > 3 ? ` (+${stale.errors.length - 3} more)` : "";
      throw new Error(
        `preflight cleanup hit ${stale.errors.length} error(s): ${head.map((e) => `${e.context}: ${e.message}`).join("; ")}${tail}`,
      );
    }
  }

  // Force-reset the default branch to the smoke-baseline tag so the run starts
  // against an identical repo state. Without this, merged smoke PRs accumulate
  // on main and subsequent runs produce no-op diffs that fail openStagePr with
  // "No commits between main and <branch>".
  await resetToBaseline(opts.gh, opts.owner, opts.repo, "  baseline");
}

/**
 * Force the default branch back to the smoke-baseline tag and sweep dangling
 * shopfloor/* branches. Called in preflight and again between scenarios so
 * each scenario runs against the same pristine baseline, fully isolated from
 * the merges the previous scenario landed.
 */
export async function resetToBaseline(
  gh: Octokit,
  owner: string,
  repo: string,
  logPrefix: string,
): Promise<void> {
  const reset = await resetDefaultBranchToBaseline(gh, owner, repo);
  if (reset.noop) {
    console.log(
      chalk.dim(
        `${logPrefix}: ${reset.defaultBranch} already at ${reset.baselineSha.slice(0, 7)}`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        `${logPrefix}: force-reset ${reset.defaultBranch} ${reset.mainBeforeSha.slice(0, 7)} -> ${reset.mainAfterSha.slice(0, 7)}`,
      ),
    );
  }

  const branchSweep = await deleteShopfloorBranches(gh, owner, repo);
  if (branchSweep.deleted > 0 || branchSweep.errors.length > 0) {
    console.log(
      chalk.dim(
        `${logPrefix}: swept ${branchSweep.deleted} stale shopfloor/* branch(es)${
          branchSweep.errors.length > 0
            ? `, ${branchSweep.errors.length} error(s)`
            : ""
        }`,
      ),
    );
  }
}

export async function runAll(
  scenarios: Scenario[],
  opts: RunAllOpts,
): Promise<ScenarioResult[]> {
  // Scenarios run strictly one at a time. Parallel execution is unsupported:
  // scenarios that mutate the same files (e.g. medium and large both edit
  // app/page.tsx) would race on merge, and the per-scenario baseline reset
  // below would clobber a concurrently-running scenario's branch base.
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    results.push(
      await runScenario(s, {
        gh: opts.gh,
        owner: opts.owner,
        repo: opts.repo,
        runTag: opts.runTag,
        appLogins: opts.appLogins,
        ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      }),
    );
    // Reset main to the baseline after each scenario so the next one starts
    // from a pristine tree, isolated from the merges this scenario landed.
    // Runs regardless of pass/fail so a partial scenario can't pollute the
    // next one's starting state.
    await resetToBaseline(opts.gh, opts.owner, opts.repo, "  reset");
  }
  return results;
}

export function printSummary(results: ScenarioResult[]): boolean {
  console.log("");
  console.log(chalk.bold("SCENARIO            STATUS    TIME      NOTES"));
  let allOk = true;
  for (const r of results) {
    const durationSec = Math.floor((r.endedAt - r.startedAt) / 1000);
    const mm = Math.floor(durationSec / 60);
    const ss = (durationSec % 60).toString().padStart(2, "0");
    const time = `${mm}m${ss}s`;
    const id = r.scenario.id.padEnd(19);
    let status: string;
    let notes = "";
    switch (r.outcome.kind) {
      case "pass":
        status = chalk.green("PASS    ");
        break;
      case "soft-pass":
        status = chalk.yellow("PASS*   ");
        notes = r.outcome.reason;
        break;
      case "fail":
        status = chalk.red("FAIL    ");
        notes = r.outcome.reason;
        allOk = false;
        break;
      case "timeout":
        status = chalk.red("TIMEOUT ");
        notes = r.outcome.reason;
        allOk = false;
        break;
    }
    console.log(`${id} ${status}  ${time.padEnd(9)} ${notes}`);
  }
  return allOk;
}
