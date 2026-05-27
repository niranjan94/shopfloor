import { parseArgs } from "node:util";
import chalk from "chalk";
import { cleanupByTitlePrefix } from "./lib/cleanup.js";
import { loadAndResolveEnv } from "./lib/env.js";
import { makeGh } from "./lib/github.js";
import { preflight, printSummary, runAll } from "./lib/run.js";
import { newRunTag } from "./lib/tag.js";
import type { Scenario } from "./lib/types.js";
import AWAITING_INFO from "./scenarios/awaiting-info.js";
import LARGE from "./scenarios/large.js";
import MEDIUM from "./scenarios/medium.js";
import QUICK from "./scenarios/quick.js";
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
  allowStale: boolean;
  pollMs?: number;
}

function parseCliArgs(argv: string[]): Args {
  // `pnpm smoke -- --only X` forwards the `--` separator into our argv. Node's
  // parseArgs treats `--` as an options terminator, which would turn `--only`
  // and friends into positionals and silently drop them. Strip any standalone
  // `--` tokens so both `pnpm smoke --only X` and `pnpm smoke -- --only X`
  // work. The only real positional this CLI takes is `cleanup`.
  const cleaned = argv.filter((a) => a !== "--");
  const parsed = parseArgs({
    args: cleaned,
    allowPositionals: true,
    strict: true,
    options: {
      only: { type: "string" },
      tag: { type: "string" },
      "allow-stale": { type: "boolean", default: false },
      "poll-ms": { type: "string" },
    },
  });
  return {
    positional: parsed.positionals,
    ...(parsed.values.only !== undefined ? { only: parsed.values.only } : {}),
    ...(parsed.values.tag !== undefined ? { tag: parsed.values.tag } : {}),
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
    `Running ${selected.length} scenario(s) sequentially (main resets between each): ${selected.map((s) => s.id).join(", ")}`,
  );

  const results = await runAll(selected, {
    gh,
    owner: OWNER,
    repo: REPO,
    runTag,
    appLogins,
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
