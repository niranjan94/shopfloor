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

  async getIssue(
    issueNumber: number,
  ): Promise<{ labels: Array<{ name: string }>; state: "open" | "closed" }> {
    const res = await this.octokit.rest.issues.get({
      ...this.repo,
      issue_number: issueNumber,
    });
    return {
      labels: res.data.labels as Array<{ name: string }>,
      state: res.data.state as "open" | "closed",
    };
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
}
