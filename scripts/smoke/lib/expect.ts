import type { Octokit } from "@octokit/rest";
import { parsePrFooter } from "./footer.js";
import type { ExpectOpts, PrRef, StageName } from "./types.js";

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const BACKOFF_AFTER_MS = 60_000;
const BACKOFF_POLL_MS = 30_000;

export class ExpectTimeout extends Error {
  constructor(
    public readonly what: string,
    public readonly lastObserved: string,
  ) {
    super(`timed out waiting for ${what}. Last observed: ${lastObserved}`);
    this.name = "ExpectTimeout";
  }
}

interface ExpectClientOpts {
  pollMs?: number;
  defaultTimeoutMs?: number;
}

export interface ExpectClient {
  expectLabel(
    issue: number,
    label: string | RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectLabelMissing(
    issue: number,
    label: string,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectPrOpenedFor(
    issue: number,
    stage: StageName,
    opts?: ExpectOpts,
  ): Promise<PrRef>;
  expectCommentByApp(
    issue: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectIssueClosed(issue: number, opts?: ExpectOpts): Promise<void>;
  expectNewCommitOn(
    pr: number,
    sinceSha: string,
    opts?: ExpectOpts,
  ): Promise<{ headSha: string }>;
  expectReviewByApp(
    pr: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
}

export function makeExpectClient(
  gh: Octokit,
  owner: string,
  repo: string,
  baseOpts: ExpectClientOpts = {},
): ExpectClient {
  const basePoll = baseOpts.pollMs ?? DEFAULT_POLL_MS;
  const baseTimeout = baseOpts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function poll<T>(
    what: string,
    opts: ExpectOpts | undefined,
    probe: () => Promise<{ done: boolean; value?: T; observed: string }>,
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? baseTimeout;
    const start = Date.now();
    let lastObserved = "(none)";
    let pollMs = opts?.pollMs ?? basePoll;
    while (Date.now() - start < timeoutMs) {
      const probed = await probe();
      lastObserved = probed.observed;
      if (probed.done) return probed.value as T;
      if (Date.now() - start > BACKOFF_AFTER_MS) {
        pollMs = Math.max(pollMs, BACKOFF_POLL_MS);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new ExpectTimeout(what, lastObserved);
  }

  function labelMatches(name: string, want: string | RegExp): boolean {
    return typeof want === "string" ? name === want : want.test(name);
  }

  async function expectLabel(
    issue: number,
    label: string | RegExp,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(`label ${label.toString()} on #${issue}`, opts, async () => {
      const res = await gh.issues.listLabelsOnIssue({
        owner,
        repo,
        issue_number: issue,
      });
      const names = res.data.map((l) => l.name);
      const hit = names.some((n) => labelMatches(n, label));
      return { done: hit, observed: names.join(",") || "(no labels)" };
    });
  }

  async function expectLabelMissing(
    issue: number,
    label: string,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(`label ${label} absent on #${issue}`, opts, async () => {
      const res = await gh.issues.listLabelsOnIssue({
        owner,
        repo,
        issue_number: issue,
      });
      const names = res.data.map((l) => l.name);
      return { done: !names.includes(label), observed: names.join(",") };
    });
  }

  async function expectPrOpenedFor(
    issue: number,
    stage: StageName,
    opts?: ExpectOpts,
  ): Promise<PrRef> {
    return poll(`PR for #${issue} stage=${stage}`, opts, async () => {
      const res = await gh.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 50,
      });
      for (const pr of res.data) {
        const footer = parsePrFooter(pr.body ?? null);
        if (footer && footer.issueNumber === issue && footer.stage === stage) {
          return {
            done: true,
            value: {
              number: pr.number,
              headRef: pr.head.ref,
              headSha: pr.head.sha,
            },
            observed: `#${pr.number} (footer matched)`,
          };
        }
      }
      return {
        done: false,
        observed: `${res.data.length} open PR(s), no match`,
      };
    });
  }

  async function expectCommentByApp(
    issue: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(
      `comment by ${appLogin} on #${issue}${contains ? ` matching ${contains}` : ""}`,
      opts,
      async () => {
        const res = await gh.issues.listComments({
          owner,
          repo,
          issue_number: issue,
          per_page: 100,
        });
        const matches = res.data.filter(
          (c) =>
            c.user?.login === appLogin &&
            (!contains || (c.body && contains.test(c.body))),
        );
        return {
          done: matches.length > 0,
          observed: `${res.data.length} comment(s), ${matches.length} match`,
        };
      },
    );
  }

  async function expectIssueClosed(
    issue: number,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(`#${issue} closed`, opts, async () => {
      const res = await gh.issues.get({ owner, repo, issue_number: issue });
      return { done: res.data.state === "closed", observed: res.data.state };
    });
  }

  async function expectNewCommitOn(
    pr: number,
    sinceSha: string,
    opts?: ExpectOpts,
  ): Promise<{ headSha: string }> {
    return poll(`new commit on PR #${pr}`, opts, async () => {
      const res = await gh.pulls.get({ owner, repo, pull_number: pr });
      const sha = res.data.head.sha;
      return { done: sha !== sinceSha, value: { headSha: sha }, observed: sha };
    });
  }

  async function expectReviewByApp(
    pr: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(
      `review by ${appLogin} on PR #${pr}${contains ? ` matching ${contains}` : ""}`,
      opts,
      async () => {
        const res = await gh.pulls.listReviews({
          owner,
          repo,
          pull_number: pr,
          per_page: 100,
        });
        const matches = res.data.filter(
          (r) =>
            r.user?.login === appLogin &&
            (!contains || (r.body && contains.test(r.body))),
        );
        return {
          done: matches.length > 0,
          observed: `${res.data.length} review(s), ${matches.length} match`,
        };
      },
    );
  }

  return {
    expectLabel,
    expectLabelMissing,
    expectPrOpenedFor,
    expectCommentByApp,
    expectIssueClosed,
    expectNewCommitOn,
    expectReviewByApp,
  };
}
