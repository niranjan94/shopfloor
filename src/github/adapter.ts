import { parseIssueMetadata } from "../state/metadata.js";
import type { AuditEmitter } from "../audit/events.js";

export interface OctokitLike {
  rest: {
    issues: {
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
      removeLabel(params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<unknown>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id: number } }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
      createLabel(params: {
        owner: string;
        repo: string;
        name: string;
        color: string;
        description?: string;
      }): Promise<unknown>;
      listLabelsForRepo(params: {
        owner: string;
        repo: string;
        per_page?: number;
      }): Promise<{ data: Array<{ name: string }> }>;
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        state?: "open" | "closed";
        body?: string;
      }): Promise<unknown>;
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{
        data: {
          labels: unknown;
          state: string;
          title?: string;
          body?: string | null;
        };
      }>;
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          user: unknown;
          created_at: string;
          body: string | null;
        }>;
      }>;
    };
    pulls: {
      create(params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
        title: string;
        body: string;
        draft?: boolean;
      }): Promise<{ data: { number: number; html_url: string } }>;
      list(params: {
        owner: string;
        repo: string;
        head?: string;
        state?: "open" | "closed" | "all";
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          number: number;
          html_url: string;
          body?: string | null;
          head?: { ref: string };
        }>;
      }>;
      update(params: {
        owner: string;
        repo: string;
        pull_number: number;
        body?: string;
        title?: string;
      }): Promise<unknown>;
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: { node_id?: string } & Record<string, unknown> }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          filename: string;
          patch?: string;
          status: string;
        }>;
      }>;
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id?: string;
        event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
        body: string;
        comments?: Array<unknown>;
      }): Promise<unknown>;
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }): Promise<{
        data: Array<{
          id: number;
          user: unknown;
          body: string | null;
          commit_id: string;
          state: string;
          submitted_at: string | null;
        }>;
      }>;
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          id: number;
          pull_request_review_id: number | null;
          path: string;
          line: number | null;
          side: "LEFT" | "RIGHT" | null;
          start_line: number | null;
          start_side: "LEFT" | "RIGHT" | null;
          body: string;
        }>;
      }>;
    };
    repos: {
      get(params: {
        owner: string;
        repo: string;
      }): Promise<{ data: { default_branch: string } }>;
      createCommitStatus(params: {
        owner: string;
        repo: string;
        sha: string;
        state: "pending" | "success" | "failure" | "error";
        context: string;
        description: string;
        target_url?: string;
      }): Promise<unknown>;
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{
        data: { sha: string; type: string } | Array<unknown>;
      }>;
      createOrUpdateFileContents(params: {
        owner: string;
        repo: string;
        path: string;
        branch: string;
        message: string;
        content: string;
        sha?: string;
      }): Promise<unknown>;
    };
    git: {
      getRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { object: { sha: string } } }>;
      createRef(params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }): Promise<unknown>;
    };
  };
  graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

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

type PrReviewRow = {
  id: number;
  user: { login: string } | null;
  body: string;
  commit_id: string;
  state: string;
  submitted_at: string | null;
};

type PrReviewCommentRow = {
  id: number;
  pull_request_review_id: number | null;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  body: string;
};

type IssueCommentRow = {
  user: { login: string } | null;
  created_at: string;
  body: string | null;
};

const METADATA_OPENER = "<!-- shopfloor:metadata";
const METADATA_CLOSER = "-->";
const METADATA_WELL_FORMED = /<!--\s*shopfloor:metadata[\s\S]*?-->/;
const METADATA_MALFORMED_TAIL = /<!--\s*shopfloor:metadata[\s\S]*$/;

function renderIssueMetadataBlock(fields: {
  slug?: string;
  specPath?: string;
  planPath?: string;
}): string {
  const lines = [METADATA_OPENER];
  if (fields.slug !== undefined) lines.push(`Shopfloor-Slug: ${fields.slug}`);
  if (fields.specPath !== undefined)
    lines.push(`Shopfloor-Spec-Path: ${fields.specPath}`);
  if (fields.planPath !== undefined)
    lines.push(`Shopfloor-Plan-Path: ${fields.planPath}`);
  lines.push(METADATA_CLOSER);
  return lines.join("\n");
}

function applyMetadataBlock(body: string | null, block: string): string {
  if (body === null || body.length === 0) return block;
  if (METADATA_WELL_FORMED.test(body)) {
    return body.replace(METADATA_WELL_FORMED, block);
  }
  if (METADATA_MALFORMED_TAIL.test(body)) {
    return body.replace(METADATA_MALFORMED_TAIL, block);
  }
  const sep = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}${block}`;
}

export class GitHubAdapter {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly repo: RepoContext,
    private readonly audit?: AuditEmitter,
  ) {}

  async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      ...this.repo,
      issue_number: issueNumber,
      labels: [label],
    });
    this.audit?.({ type: "label_mutated", issueNumber, op: "add", label });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        ...this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (err: unknown) {
      // The label was already absent. Skip the audit entry: no mutation
      // actually happened, and emitting one would falsely imply a write.
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
    this.audit?.({ type: "label_mutated", issueNumber, op: "remove", label });
  }

  // Batches a label transition: remove the listed labels (404-tolerant via
  // removeLabel) and then add the listed labels. The orchestrator uses this so
  // each stage transition is a single call site that mirrors a single
  // label_applied audit event.
  async replaceLabels(
    issueNumber: number,
    change: { add: string[]; remove: string[] },
  ): Promise<void> {
    for (const label of change.remove) {
      await this.removeLabel(issueNumber, label);
    }
    if (change.add.length > 0) {
      await this.octokit.rest.issues.addLabels({
        ...this.repo,
        issue_number: issueNumber,
        labels: change.add,
      });
      for (const label of change.add) {
        this.audit?.({ type: "label_mutated", issueNumber, op: "add", label });
      }
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
    if (!pr) return null;
    return { number: pr.number, url: pr.html_url };
  }

  // GitHub's pulls.list `head` filter requires an exact `<owner>:<branch>`
  // match -- no prefix or wildcard support -- and the issue-unlabel payload
  // only carries the issue number, not the slug. So we page through open PRs
  // and filter client-side on the canonical impl branch prefix.
  async findOpenImplPrForIssue(
    issueNumber: number,
  ): Promise<{ number: number; body: string | null } | null> {
    const prefix = `shopfloor/impl/${issueNumber}-`;
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.pulls.list({
        ...this.repo,
        state: "open",
        per_page: 100,
        page,
      });
      for (const pr of res.data) {
        if (pr.head?.ref && pr.head.ref.startsWith(prefix)) {
          return { number: pr.number, body: pr.body ?? null };
        }
      }
      if (res.data.length < 100) return null;
      page++;
    }
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
      ...(targetUrl !== undefined ? { target_url: targetUrl } : {}),
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
        ...(description !== undefined ? { description } : {}),
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
    base: { ref: string };
    body: string | null;
  }> {
    const res = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: prNumber,
    });
    return res.data as never;
  }

  async getDefaultBranch(): Promise<string> {
    const res = await this.octokit.rest.repos.get({ ...this.repo });
    return res.data.default_branch;
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

  async listChangedFilePatches(prNumber: number): Promise<
    Array<{
      filename: string;
      patch?: string;
      status: string;
    }>
  > {
    const out: Array<{ filename: string; patch?: string; status: string }> = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.pulls.listFiles({
        ...this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      out.push(
        ...res.data.map((f) => ({
          filename: f.filename,
          ...(f.patch !== undefined ? { patch: f.patch } : {}),
          status: f.status,
        })),
      );
      if (res.data.length < 100) break;
      page++;
    }
    return out;
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

  // Read the current shopfloor:metadata block from the issue body, merge the
  // supplied fields on top, and write the resulting body back. Merging means
  // a caller can upsert one field at a time (e.g. triage writes slug, plan
  // later writes planPath) without clobbering earlier fields. The block lives
  // in an HTML comment so it does not render in GitHub's web UI.
  async upsertIssueMetadata(
    issueNumber: number,
    fields: { slug?: string; specPath?: string; planPath?: string },
  ): Promise<void> {
    const current = await this.getIssue(issueNumber);
    const existing = parseIssueMetadata(current.body);
    const merged = { ...(existing ?? {}), ...fields };
    const block = renderIssueMetadataBlock(merged);
    const nextBody = applyMetadataBlock(current.body, block);
    await this.updateIssueBody(issueNumber, nextBody);
  }

  // The GitHub REST API does not expose a way to flip a PR from draft to
  // ready-for-review. The GraphQL mutation markPullRequestReadyForReview is
  // the only path. We first fetch the PR's node_id via REST to avoid a second
  // GraphQL lookup.
  async markPullRequestReadyForReview(prNumber: number): Promise<void> {
    const res = await this.octokit.rest.pulls.get({
      ...this.repo,
      pull_number: prNumber,
    });
    const nodeId = res.data.node_id;
    if (!nodeId) {
      throw new Error(
        `markPullRequestReadyForReview: PR #${prNumber} has no node_id`,
      );
    }
    await this.octokit.graphql(
      `mutation($id: ID!) {
         markPullRequestReadyForReview(input: { pullRequestId: $id }) {
           pullRequest { id isDraft }
         }
       }`,
      { id: nodeId },
    );
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

  async listPrReviews(prNumber: number): Promise<PrReviewRow[]> {
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
      state: r.state.toLowerCase(),
      submitted_at: r.submitted_at,
    }));
  }

  async listPrReviewComments(prNumber: number): Promise<PrReviewCommentRow[]> {
    const all: PrReviewCommentRow[] = [];
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

  async getRefSha(branchName: string): Promise<string> {
    const res = await this.octokit.rest.git.getRef({
      ...this.repo,
      ref: `heads/${branchName}`,
    });
    return res.data.object.sha;
  }

  async createRef(branchName: string, sha: string): Promise<boolean> {
    try {
      await this.octokit.rest.git.createRef({
        ...this.repo,
        ref: `refs/heads/${branchName}`,
        sha,
      });
      return true;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 422) return false;
      throw err;
    }
  }

  async getFileSha(path: string, branch: string): Promise<string | null> {
    try {
      const res = await this.octokit.rest.repos.getContent({
        ...this.repo,
        path,
        ref: branch,
      });
      if (Array.isArray(res.data)) return null;
      return res.data.sha;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async putFileContents(input: {
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<void> {
    await this.octokit.rest.repos.createOrUpdateFileContents({
      ...this.repo,
      path: input.path,
      branch: input.branch,
      message: input.message,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      ...(input.sha ? { sha: input.sha } : {}),
    });
  }

  async listIssueComments(issueNumber: number): Promise<IssueCommentRow[]> {
    const all: IssueCommentRow[] = [];
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
