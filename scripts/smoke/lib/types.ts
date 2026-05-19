import type { Octokit } from "@octokit/rest";

export type StageName = "spec" | "plan" | "implement" | "review";

export interface AppLogins {
  primary: string;
  review: string;
}

export interface ExpectOpts {
  timeoutMs?: number;
  pollMs?: number;
}

export interface PrRef {
  number: number;
  headRef: string;
  headSha: string;
}

export interface SmokeCtx {
  tag: string;
  log: (msg: string) => void;
  gh: Octokit;
  appLogins: AppLogins;
  owner: string;
  repo: string;

  createIssue(opts: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number }>;
  addLabel(issue: number, label: string): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  commentOnIssue(issue: number, body: string): Promise<void>;
  commentOnPr(pr: number, body: string): Promise<void>;
  mergePr(pr: number, method?: "squash" | "merge"): Promise<void>;
  closePr(pr: number): Promise<void>;
  deleteBranch(ref: string): Promise<void>;

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

export type ScenarioOutcome =
  | { kind: "pass" }
  | { kind: "soft-pass"; reason: string }
  | { kind: "fail"; reason: string };

export interface Scenario {
  id: string;
  name: string;
  flaky: boolean;
  timeoutMs: number;
  run: (ctx: SmokeCtx) => Promise<ScenarioOutcome>;
}

export interface ScenarioResult {
  scenario: Scenario;
  outcome: ScenarioOutcome | { kind: "timeout"; reason: string };
  startedAt: number;
  endedAt: number;
  createdIssues: number[];
  createdPrs: number[];
}
