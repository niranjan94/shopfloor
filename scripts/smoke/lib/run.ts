import chalk from "chalk";
import type { Octokit } from "@octokit/rest";
import type { AppLogins, Scenario, ScenarioResult } from "./types.js";
import { runScenario } from "./scenario.js";
import {
  resetDefaultBranchToBaseline,
  deleteShopfloorBranches,
} from "./baseline.js";

export interface RunAllOpts {
  gh: Octokit;
  owner: string;
  repo: string;
  runTag: string;
  appLogins: AppLogins;
  sequential: boolean;
  pollMs?: number;
}

export async function preflight(opts: {
  gh: Octokit;
  owner: string;
  repo: string;
  allowStale: boolean;
}): Promise<void> {
  let repoInfo;
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

  if (!opts.allowStale) {
    const hits = await opts.gh.search.issuesAndPullRequests({
      q: `repo:${opts.owner}/${opts.repo} state:open in:title "smoke-"`,
      per_page: 1,
    });
    if (hits.data.total_count > 0) {
      throw new Error(
        `${hits.data.total_count} open smoke artifact(s) found from previous runs. Run \`pnpm smoke -- cleanup\` or pass \`--allow-stale\`.`,
      );
    }
  }

  // Force-reset the default branch to the smoke-baseline tag so every run
  // starts against an identical repo state. Without this, merged smoke PRs
  // accumulate on main and subsequent runs produce no-op diffs that fail
  // openStagePr with "No commits between main and <branch>".
  const reset = await resetDefaultBranchToBaseline(
    opts.gh,
    opts.owner,
    opts.repo,
  );
  if (reset.noop) {
    console.log(
      chalk.dim(
        `  baseline: ${reset.defaultBranch} already at ${reset.baselineSha.slice(0, 7)}`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        `  baseline: force-reset ${reset.defaultBranch} ${reset.mainBeforeSha.slice(0, 7)} -> ${reset.mainAfterSha.slice(0, 7)}`,
      ),
    );
  }

  // Sweep dangling shopfloor/* branches from prior runs. Closed PRs leave
  // their head branches behind; over time those refs pile up and waste API
  // listings. Doing this in preflight (not just per-scenario cleanup) catches
  // branches whose PR was already cleaned but the ref lingered.
  const branchSweep = await deleteShopfloorBranches(
    opts.gh,
    opts.owner,
    opts.repo,
  );
  if (branchSweep.deleted > 0 || branchSweep.errors.length > 0) {
    console.log(
      chalk.dim(
        `  baseline: swept ${branchSweep.deleted} stale shopfloor/* branch(es)${
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
  const exec = (s: Scenario) =>
    runScenario(s, {
      gh: opts.gh,
      owner: opts.owner,
      repo: opts.repo,
      runTag: opts.runTag,
      appLogins: opts.appLogins,
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    });

  if (opts.sequential) {
    const results: ScenarioResult[] = [];
    for (const s of scenarios) results.push(await exec(s));
    return results;
  }
  return Promise.all(scenarios.map(exec));
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
