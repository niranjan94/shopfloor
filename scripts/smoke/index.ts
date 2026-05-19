import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadAndResolveEnv } from "./lib/env.js";
import { makeGh } from "./lib/github.js";
import { newRunTag } from "./lib/tag.js";
import { preflight, runAll, printSummary } from "./lib/run.js";
import { cleanupByTitlePrefix } from "./lib/cleanup.js";
import type { Scenario } from "./lib/types.js";

import QUICK from "./scenarios/quick.js";
import MEDIUM from "./scenarios/medium.js";
import LARGE from "./scenarios/large.js";
import AWAITING_INFO from "./scenarios/awaiting-info.js";
import REVIEW_ONLY from "./scenarios/review-only.js";
import REVISION_LOOP from "./scenarios/revision-loop.js";
import SKIP_REVIEW_AND_REVISE from "./scenarios/skip-review-and-revise.js";

const OWNER = "niranjan94";
const REPO = "shopfloor-smoke";

const ALL_SCENARIOS: Scenario[] = [
  QUICK,
  MEDIUM,
  LARGE,
  AWAITING_INFO,
  REVIEW_ONLY,
  REVISION_LOOP,
  SKIP_REVIEW_AND_REVISE,
];

interface Args {
  positional: string[];
  only?: string;
  tag?: string;
  sequential: boolean;
  allowStale: boolean;
  pollMs?: number;
}

function parseCliArgs(argv: string[]): Args {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      only: { type: "string" },
      tag: { type: "string" },
      sequential: { type: "boolean", default: false },
      "allow-stale": { type: "boolean", default: false },
      "poll-ms": { type: "string" },
    },
  });
  return {
    positional: parsed.positionals,
    ...(parsed.values.only !== undefined ? { only: parsed.values.only } : {}),
    ...(parsed.values.tag !== undefined ? { tag: parsed.values.tag } : {}),
    sequential: parsed.values.sequential === true,
    allowStale: parsed.values["allow-stale"] === true,
    ...(parsed.values["poll-ms"] !== undefined
      ? { pollMs: Number(parsed.values["poll-ms"]) }
      : {}),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const { token, appLogins } = loadAndResolveEnv();
  const gh = makeGh(token);

  if (args.positional[0] === "cleanup") {
    const prefix = args.tag ?? "smoke-";
    console.log(chalk.bold(`Cleaning up artifacts with prefix "${prefix}"...`));
    const report = await cleanupByTitlePrefix(gh, OWNER, REPO, prefix);
    console.log(
      `  PRs closed:        ${report.prsClosed}\n  Branches deleted:  ${report.branchesDeleted}\n  Issues deleted:    ${report.issuesDeleted}`,
    );
    if (report.errors.length > 0) {
      console.log(chalk.red(`  Errors (${report.errors.length}):`));
      for (const e of report.errors)
        console.log(`    - ${e.context}: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  await preflight({
    gh,
    owner: OWNER,
    repo: REPO,
    allowStale: args.allowStale,
  });

  const runTag = args.tag ?? newRunTag();
  console.log(chalk.bold(`Smoke run tag: ${runTag}`));

  const onlyFilter = args.only;
  const selected = onlyFilter
    ? ALL_SCENARIOS.filter((s) => onlyFilter.split(",").includes(s.id))
    : ALL_SCENARIOS;

  if (selected.length === 0) {
    console.error(`No scenarios matched --only=${args.only}`);
    process.exit(2);
  }

  console.log(
    `Running ${selected.length} scenario(s) ${args.sequential ? "sequentially" : "in parallel"}: ${selected.map((s) => s.id).join(", ")}`,
  );

  const results = await runAll(selected, {
    gh,
    owner: OWNER,
    repo: REPO,
    runTag,
    appLogins,
    sequential: args.sequential,
    ...(args.pollMs !== undefined ? { pollMs: args.pollMs } : {}),
  });

  for (const r of results) {
    if (r.outcome.kind === "pass" || r.outcome.kind === "soft-pass") {
      const tag = `${runTag}/${r.scenario.id}`;
      try {
        await cleanupByTitlePrefix(gh, OWNER, REPO, tag);
      } catch (err) {
        console.warn(
          chalk.yellow(
            `cleanup for ${tag} reported an error: ${(err as Error).message}`,
          ),
        );
      }
    }
  }

  const ok = printSummary(results);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(chalk.red(`smoke fatal: ${(err as Error).message}`));
  process.exit(2);
});
