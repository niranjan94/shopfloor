import chalk from "chalk";
import type { Octokit } from "@octokit/rest";
import { makeExpectClient } from "./expect.js";
import type {
  AppLogins,
  Scenario,
  ScenarioResult,
  SmokeCtx,
} from "./types.js";

export interface RunScenarioOpts {
  gh: Octokit;
  owner: string;
  repo: string;
  runTag: string;
  appLogins: AppLogins;
  pollMs?: number;
}

export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOpts,
): Promise<ScenarioResult> {
  const tag = `${opts.runTag}/${scenario.id}`;
  const startedAt = Date.now();
  const createdIssues: number[] = [];
  const createdPrs: number[] = [];

  const expectClient = makeExpectClient(opts.gh, opts.owner, opts.repo, {
    pollMs: opts.pollMs ?? 10_000,
  });

  const log = (msg: string) => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const mm = Math.floor(elapsed / 60)
      .toString()
      .padStart(2, "0");
    const ss = (elapsed % 60).toString().padStart(2, "0");
    console.log(chalk.gray(`[${tag}] 00:${mm}:${ss}  ${msg}`));
  };

  const ctx: SmokeCtx = {
    tag,
    log,
    gh: opts.gh,
    appLogins: opts.appLogins,
    owner: opts.owner,
    repo: opts.repo,

    async createIssue({ title, body, labels }) {
      log(`> creating issue "${title}"`);
      const res = await opts.gh.issues.create({
        owner: opts.owner,
        repo: opts.repo,
        title,
        body,
        ...(labels !== undefined ? { labels } : {}),
      });
      log(`+ issue #${res.data.number} created`);
      createdIssues.push(res.data.number);
      return { number: res.data.number };
    },
    async addLabel(issue, label) {
      await opts.gh.issues.addLabels({
        owner: opts.owner,
        repo: opts.repo,
        issue_number: issue,
        labels: [label],
      });
    },
    async removeLabel(issue, label) {
      try {
        await opts.gh.issues.removeLabel({
          owner: opts.owner,
          repo: opts.repo,
          issue_number: issue,
          name: label,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 404) throw err;
      }
    },
    async commentOnIssue(issue, body) {
      await opts.gh.issues.createComment({
        owner: opts.owner,
        repo: opts.repo,
        issue_number: issue,
        body,
      });
    },
    async commentOnPr(pr, body) {
      await opts.gh.issues.createComment({
        owner: opts.owner,
        repo: opts.repo,
        issue_number: pr,
        body,
      });
    },
    async mergePr(pr, method = "squash") {
      log(`> merging PR #${pr} (${method})`);
      await opts.gh.pulls.merge({
        owner: opts.owner,
        repo: opts.repo,
        pull_number: pr,
        merge_method: method,
      });
      log(`+ PR #${pr} merged`);
    },
    async closePr(pr) {
      await opts.gh.pulls.update({
        owner: opts.owner,
        repo: opts.repo,
        pull_number: pr,
        state: "closed",
      });
    },
    async deleteBranch(ref) {
      try {
        await opts.gh.git.deleteRef({
          owner: opts.owner,
          repo: opts.repo,
          ref: `heads/${ref}`,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 422) throw err;
      }
    },

    async expectLabel(issue, label, expectOpts) {
      const desc = `label ${label.toString()} on #${issue}`;
      log(`. waiting for ${desc}`);
      await expectClient.expectLabel(issue, label, expectOpts);
      log(`+ ${desc}`);
    },
    async expectLabelMissing(issue, label, expectOpts) {
      log(`. waiting for label ${label} to be removed from #${issue}`);
      await expectClient.expectLabelMissing(issue, label, expectOpts);
      log(`+ label ${label} cleared on #${issue}`);
    },
    async expectPrOpenedFor(issue, stage, expectOpts) {
      log(`. waiting for ${stage} PR for #${issue}`);
      const pr = await expectClient.expectPrOpenedFor(issue, stage, expectOpts);
      log(`+ PR #${pr.number} opened for stage=${stage}`);
      createdPrs.push(pr.number);
      return pr;
    },
    async expectCommentByApp(issue, appLogin, contains, expectOpts) {
      log(
        `. waiting for comment by ${appLogin} on #${issue}${contains ? ` matching ${contains}` : ""}`,
      );
      await expectClient.expectCommentByApp(
        issue,
        appLogin,
        contains,
        expectOpts,
      );
      log(`+ comment by ${appLogin} on #${issue}`);
    },
    async expectIssueClosed(issue, expectOpts) {
      log(`. waiting for #${issue} to close`);
      await expectClient.expectIssueClosed(issue, expectOpts);
      log(`+ #${issue} closed`);
    },
    async expectNewCommitOn(pr, sinceSha, expectOpts) {
      log(`. waiting for new commit on PR #${pr} (since ${sinceSha})`);
      const out = await expectClient.expectNewCommitOn(pr, sinceSha, expectOpts);
      log(`+ new commit on PR #${pr} (${out.headSha})`);
      return out;
    },
    async expectReviewByApp(pr, appLogin, contains, expectOpts) {
      log(
        `. waiting for review by ${appLogin} on PR #${pr}${contains ? ` matching ${contains}` : ""}`,
      );
      await expectClient.expectReviewByApp(pr, appLogin, contains, expectOpts);
      log(`+ review by ${appLogin} on PR #${pr}`);
    },
  };

  let outcome: ScenarioResult["outcome"];
  try {
    outcome = await Promise.race([
      scenario.run(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `scenario ${scenario.id} exceeded ${scenario.timeoutMs}ms`,
              ),
            ),
          scenario.timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    outcome = msg.includes("exceeded")
      ? { kind: "timeout", reason: msg }
      : { kind: "fail", reason: msg };
  }

  return {
    scenario,
    outcome,
    startedAt,
    endedAt: Date.now(),
    createdIssues,
    createdPrs,
  };
}
