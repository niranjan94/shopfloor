import type { OctokitLike } from "../../../src/types";
import {
  newFakeState,
  type FakeState,
  type Issue,
  type Pull,
  type Comment,
  type Review,
  type Status,
  type WriteEvent,
} from "./state";
import { buildOctokitShim } from "./octokit-shim";
export { FakeRequestError } from "./errors";

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  authIdentity?: string;
  reviewAuthIdentity?: string;
}

export class FakeGitHub {
  private readonly state: FakeState;

  constructor(opts: FakeGitHubOptions) {
    this.state = newFakeState(opts);
  }

  get owner(): string {
    return this.state.repo.owner;
  }
  get repo(): string {
    return this.state.repo.repo;
  }
  /** The login the primary App authenticates as. */
  get primaryIdentity(): string {
    return this.state.authIdentity;
  }
  /** The login the secondary review App authenticates as, if configured. */
  get reviewIdentity(): string | undefined {
    return this.state.reviewAuthIdentity;
  }

  /** Build an OctokitLike shim that authenticates as `actor`. */
  asOctokit(actor: string): OctokitLike {
    return buildOctokitShim({ state: this.state, actor });
  }

  // Seeding
  seedLabels(
    labels: Array<{ name: string; color: string; description?: string }>,
  ): void {
    for (const l of labels) {
      this.state.labels.set(l.name, l);
    }
  }

  seedIssue(input: {
    number: number;
    title: string;
    body: string | null;
    author: string;
    labels?: string[];
  }): void {
    if (input.number >= this.state.nextNumber) {
      this.state.nextNumber = input.number + 1;
    }
    this.state.issues.set(input.number, {
      number: input.number,
      title: input.title,
      body: input.body,
      state: "open",
      labels: input.labels ?? [],
      author: input.author,
      createdAt: `2026-04-15T00:00:00Z`,
    });
  }

  seedBranch(name: string, sha: string): void {
    this.state.branches.set(name, sha);
  }

  /**
   * Advance the SHA of a branch and propagate the new value to the head
   * of every open, unmerged PR currently rooted on that branch. This
   * models a `git push` that adds a new commit to the branch tip. The
   * sha-on-the-PR is what aggregate-review and build-revision-context
   * read via getPr; without the propagation, the older review's commit_id
   * and the new review's commit_id collide and the iteration counter
   * cannot tell them apart.
   */
  advanceSha(branch: string): string {
    const current = this.state.branches.get(branch);
    if (!current) throw new Error(`advanceSha: unknown branch ${branch}`);
    const m = current.match(/^(.+)-(\d+)$/);
    const next = m ? `${m[1]}-${Number(m[2]) + 1}` : `${current}-1`;
    this.state.branches.set(branch, next);
    for (const pr of this.state.pulls.values()) {
      if (pr.head.ref === branch && pr.state === "open" && !pr.merged) {
        pr.head.sha = next;
      }
    }
    return next;
  }

  /**
   * Seed the list of changed files on an existing PR. The production
   * workflow derives this from the real git push; in the harness we have
   * no working tree, so scenarios must declare the file list whenever a
   * helper downstream of open-stage-pr reads `adapter.listChangedFiles`
   * (notably check-review-skip, which short-circuits to skip=true when
   * the list is empty).
   */
  setPrFiles(prNumber: number, files: string[]): void {
    const pr = this.state.pulls.get(prNumber);
    if (!pr) throw new Error(`setPrFiles: pr #${prNumber} not found`);
    pr.files = files.slice();
  }

  /** Helper used by scenarios; the router never merges PRs in production. */
  mergePr(prNumber: number, sha: string): void {
    const pr = this.state.pulls.get(prNumber);
    if (!pr) throw new Error(`mergePr: pr #${prNumber} not found`);
    pr.merged = true;
    pr.state = "closed";
    pr.mergedAt = `2026-04-15T00:00:${String(this.state.clock + 1).padStart(2, "0")}Z`;
    this.state.eventLog.push({
      kind: "mergePr",
      pr: prNumber,
      sha,
      t: ++this.state.clock,
    });
  }

  // Read-side accessors
  issue(n: number): Issue {
    const i = this.state.issues.get(n);
    if (!i) throw new Error(`fake.issue(${n}): not found`);
    return i;
  }
  pr(n: number): Pull {
    const p = this.state.pulls.get(n);
    if (!p) throw new Error(`fake.pr(${n}): not found`);
    return p;
  }
  labelsOn(issueNumber: number): string[] {
    return this.issue(issueNumber).labels.slice();
  }
  commentsOn(issueNumber: number): Comment[] {
    return Array.from(this.state.comments.values()).filter(
      (c) => c.issueNumber === issueNumber,
    );
  }
  reviewsOn(prNumber: number): Review[] {
    return Array.from(this.state.reviews.values()).filter(
      (r) => r.prNumber === prNumber,
    );
  }
  statusFor(sha: string, context: string): Status | undefined {
    return this.state.statuses.get(sha)?.get(context);
  }
  openPrs(): Pull[] {
    return Array.from(this.state.pulls.values()).filter(
      (p) => p.state === "open",
    );
  }
  eventLog(): WriteEvent[] {
    return this.state.eventLog.slice();
  }
  eventLogSummary(): string {
    return this.state.eventLog
      .map((e) => `[t+${e.t}] ${JSON.stringify(e)}`)
      .join("\n");
  }

  /**
   * Snapshot suitable for `toMatchSnapshot()`. Internal counters and the
   * event log are deliberately omitted so reorderings do not noisy-diff.
   */
  snapshot(): unknown {
    return {
      labels: Array.from(this.state.labels.keys()).sort(),
      issues: Array.from(this.state.issues.values())
        .sort((a, b) => a.number - b.number)
        .map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels,
          body: i.body,
        })),
      pulls: Array.from(this.state.pulls.values())
        .sort((a, b) => a.number - b.number)
        .map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          merged: p.merged,
          base: p.base.ref,
          head: p.head.ref,
          body: p.body,
        })),
      comments: Array.from(this.state.comments.values()).map((c) => ({
        issue: c.issueNumber,
        body: c.body,
        author: c.author,
      })),
      reviews: Array.from(this.state.reviews.values()).map((r) => ({
        pr: r.prNumber,
        state: r.state,
        commit: r.commitId,
        body: r.body,
        user: r.user.login,
      })),
      statuses: Array.from(this.state.statuses.entries()).map(([sha, m]) => ({
        sha,
        contexts: Array.from(m.entries()).map(([ctx, s]) => ({
          context: ctx,
          state: s.state,
          description: s.description,
        })),
      })),
    };
  }
}
