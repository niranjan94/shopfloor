import type { OctokitLike } from "./types";

export interface RepoContext {
  owner: string;
  repo: string;
}

export interface OpenStagePrInput {
  base: string;
  head: string;
  title: string;
  body: string;
  stage: "spec" | "plan" | "implement";
  issueNumber: number;
  reviewIteration?: number;
  draft?: boolean;
  /**
   * When true and an open PR already exists for this head branch, return the
   * existing PR without overwriting its title or body. Used for the implement
   * stage where the body may already contain a Shopfloor-Review-Iteration
   * marker from a running review loop that must not be clobbered.
   */
  preserveBodyIfExists?: boolean;
}

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

export class GitHubAdapter {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly repo: RepoContext,
  ) {}

  async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      ...this.repo,
      issue_number: issueNumber,
      labels: [label],
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        ...this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }

  async postIssueComment(issueNumber: number, body: string): Promise<number> {
    const res = await this.octokit.rest.issues.createComment({
      ...this.repo,
      issue_number: issueNumber,
      body,
    });
    return res.data.id;
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      ...this.repo,
      comment_id: commentId,
      body,
    });
  }

  async findOpenPrByHead(
    head: string,
  ): Promise<{ number: number; url: string } | null> {
    const res = await this.octokit.rest.pulls.list({
      ...this.repo,
      head: `${this.repo.owner}:${head}`,
      state: "open",
      per_page: 1,
    });
    if (!res.data || res.data.length === 0) return null;
    const pr = res.data[0];
    return { number: pr.number, url: pr.html_url };
  }

  async openStagePr(
    input: OpenStagePrInput,
  ): Promise<{ number: number; url: string }> {
    const metadataLines: string[] = [
      "",
      "---",
      `Shopfloor-Issue: #${input.issueNumber}`,
      `Shopfloor-Stage: ${input.stage}`,
    ];
    if (input.stage === "implement") {
      metadataLines.push(
        `Shopfloor-Review-Iteration: ${input.reviewIteration ?? 0}`,
      );
    }
    const body = `${input.body}\n${metadataLines.join("\n")}\n`;

    // Upsert: if a previous run (or an open review loop) already left an open
    // PR for this head branch, reuse it instead of failing with "A pull
    // request already exists". For spec/plan we also refresh the title/body
    // so the PR reflects the latest stage output. For implement we preserve
    // whatever's on the PR (per preserveBodyIfExists) because the body may
    // carry a Shopfloor-Review-Iteration marker from the review flow.
    const existing = await this.findOpenPrByHead(input.head);
    if (existing) {
      if (!input.preserveBodyIfExists) {
        await this.octokit.rest.pulls.update({
          ...this.repo,
          pull_number: existing.number,
          title: input.title,
          body,
        });
      }
      return existing;
    }

    const res = await this.octokit.rest.pulls.create({
      ...this.repo,
      base: input.base,
      head: input.head,
      title: input.title,
      body,
      draft: input.draft ?? false,
    });
    return { number: res.data.number, url: res.data.html_url };
  }

  async updatePrBody(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      ...this.repo,
      pull_number: prNumber,
      body,
    });
  }

  async updatePr(
    prNumber: number,
    fields: { title?: string; body?: string },
  ): Promise<void> {
    await this.octokit.rest.pulls.update({
      ...this.repo,
      pull_number: prNumber,
      ...fields,
    });
  }

  async postReview(params: {
    prNumber: number;
    commitSha: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    comments: ReviewComment[];
  }): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      ...this.repo,
      pull_number: params.prNumber,
      commit_id: params.commitSha,
      event: params.event,
      body: params.body,
      comments: params.comments,
    });
  }

  async setReviewStatus(
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
    targetUrl?: string,
  ): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({
      ...this.repo,
      sha,
      state,
      context: "shopfloor/review",
      description: description.slice(0, 140),
      target_url: targetUrl,
    });
  }

  async listRepoLabels(): Promise<string[]> {
    const res = await this.octokit.rest.issues.listLabelsForRepo({
      ...this.repo,
      per_page: 100,
    });
    return res.data.map((l) => l.name);
  }

  async createLabel(
    name: string,
    color: string,
    description?: string,
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.createLabel({
        ...this.repo,
        name,
        color,
        description,
      });
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 422) return;
      throw err;
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.octokit.rest.issues.update({
      ...this.repo,
      issue_number: issueNumber,
      state: "closed",
    });
  }

  async getPr(prNumber: number): Promise<{
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    labels: Array<{ name: string }>;
    head: { sha: string };
    body: string | null;
  }> {
    const res = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: prNumber,
    });
    return res.data as never;
  }

  async listChangedFiles(prNumber: number): Promise<string[]> {
    const files: string[] = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.pulls.listFiles({
        ...this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      files.push(...res.data.map((f) => f.filename));
      if (res.data.length < 100) break;
      page++;
    }
    return files;
  }

  async getIssue(issueNumber: number): Promise<{
    labels: Array<{ name: string }>;
    state: "open" | "closed";
    title: string;
    body: string | null;
  }> {
    const res = await this.octokit.rest.issues.get({
      ...this.repo,
      issue_number: issueNumber,
    });
    return {
      labels: res.data.labels as Array<{ name: string }>,
      state: res.data.state as "open" | "closed",
      title: (res.data.title as string | undefined) ?? "",
      body: (res.data.body as string | null | undefined) ?? null,
    };
  }

  async updateIssueBody(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.update({
      ...this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async getPrReviewsAtSha(
    prNumber: number,
    sha: string,
  ): Promise<
    Array<{ id: number; user: { login: string } | null; body: string }>
  > {
    const res = await this.octokit.rest.pulls.listReviews({
      ...this.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return res.data
      .filter((r) => r.commit_id === sha)
      .map((r) => ({
        id: r.id,
        user: r.user as { login: string } | null,
        body: r.body ?? "",
      }));
  }

  async listPrReviews(prNumber: number): Promise<
    Array<{
      id: number;
      user: { login: string } | null;
      body: string;
      commit_id: string;
      state: string;
      submitted_at: string | null;
    }>
  > {
    const res = await this.octokit.rest.pulls.listReviews({
      ...this.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return res.data.map((r) => ({
      id: r.id,
      user: r.user as { login: string } | null,
      body: r.body ?? "",
      commit_id: r.commit_id,
      state: r.state,
      submitted_at: r.submitted_at,
    }));
  }

  async listPrReviewComments(prNumber: number): Promise<
    Array<{
      id: number;
      pull_request_review_id: number | null;
      path: string;
      line: number | null;
      side: "LEFT" | "RIGHT" | null;
      start_line: number | null;
      start_side: "LEFT" | "RIGHT" | null;
      body: string;
    }>
  > {
    const all: Array<{
      id: number;
      pull_request_review_id: number | null;
      path: string;
      line: number | null;
      side: "LEFT" | "RIGHT" | null;
      start_line: number | null;
      start_side: "LEFT" | "RIGHT" | null;
      body: string;
    }> = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.pulls.listReviewComments({
        ...this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      all.push(
        ...res.data.map((c) => ({
          id: c.id,
          pull_request_review_id: c.pull_request_review_id,
          path: c.path,
          line: c.line,
          side: c.side,
          start_line: c.start_line,
          start_side: c.start_side,
          body: c.body,
        })),
      );
      if (res.data.length < 100) break;
      page++;
    }
    return all;
  }

  async listIssueComments(issueNumber: number): Promise<
    Array<{
      user: { login: string } | null;
      created_at: string;
      body: string | null;
    }>
  > {
    const all: Array<{
      user: { login: string } | null;
      created_at: string;
      body: string | null;
    }> = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.issues.listComments({
        ...this.repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      });
      all.push(
        ...res.data.map((c) => ({
          user: c.user as { login: string } | null,
          created_at: c.created_at,
          body: c.body,
        })),
      );
      if (res.data.length < 100) break;
      page++;
    }
    return all;
  }
}
