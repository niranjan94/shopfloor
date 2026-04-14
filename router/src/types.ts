export type Stage = 'triage' | 'spec' | 'plan' | 'implement' | 'review' | 'none';

export type Complexity = 'quick' | 'medium' | 'large';

export type ShopfloorLabel =
  | 'shopfloor:triaging'
  | 'shopfloor:awaiting-info'
  | 'shopfloor:quick'
  | 'shopfloor:medium'
  | 'shopfloor:large'
  | 'shopfloor:needs-spec'
  | 'shopfloor:spec-in-review'
  | 'shopfloor:needs-plan'
  | 'shopfloor:plan-in-review'
  | 'shopfloor:needs-impl'
  | 'shopfloor:impl-in-review'
  | 'shopfloor:needs-review'
  | 'shopfloor:review-requested-changes'
  | 'shopfloor:review-approved'
  | 'shopfloor:review-stuck'
  | 'shopfloor:skip-review'
  | 'shopfloor:done'
  | 'shopfloor:revise'
  | `shopfloor:failed:${'triage' | 'spec' | 'plan' | 'implement' | 'review'}`;

export interface RouterDecision {
  stage: Stage;
  issueNumber?: number;
  complexity?: Complexity;
  branchName?: string;
  specFilePath?: string;
  planFilePath?: string;
  revisionMode?: boolean;
  reviewIteration?: number;
  implPrNumber?: number;
  reason?: string;
}

export interface PrMetadata {
  issueNumber: number;
  stage: Exclude<Stage, 'none' | 'triage'>;
  reviewIteration: number;
}

export interface IssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    state: 'open' | 'closed';
    pull_request?: unknown | null;
  };
  label?: { name: string };
  repository: { owner: { login: string }; name: string };
}

export interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    body: string | null;
    state: 'open' | 'closed';
    draft: boolean;
    merged: boolean;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    labels: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string };
}

export interface PullRequestReviewPayload {
  action: string;
  review: {
    state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
    body: string | null;
    user: { login: string };
  };
  pull_request: PullRequestPayload['pull_request'];
  repository: { owner: { login: string }; name: string };
}

export type EventPayload = IssuePayload | PullRequestPayload | PullRequestReviewPayload;

export interface StateContext {
  eventName: string;
  payload: EventPayload;
  shopfloorBotLogin?: string;
  /**
   * Optional gate label. When set, the state machine refuses to enter the pipeline
   * for issues that do not carry this label. Once the issue has any `shopfloor:*`
   * state label, the gate stops applying so iteration continues normally.
   */
  triggerLabel?: string;
}

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
        state?: 'open' | 'closed';
      }): Promise<unknown>;
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{ data: { labels: unknown; state: string } }>;
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
      }): Promise<{ data: unknown }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: Array<{ filename: string }> }>;
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id?: string;
        event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
        body: string;
        comments?: Array<unknown>;
      }): Promise<unknown>;
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }): Promise<{
        data: Array<{ id: number; user: unknown; body: string | null; commit_id: string }>;
      }>;
    };
    repos: {
      createCommitStatus(params: {
        owner: string;
        repo: string;
        sha: string;
        state: 'pending' | 'success' | 'failure' | 'error';
        context: string;
        description: string;
        target_url?: string;
      }): Promise<unknown>;
    };
  };
}
