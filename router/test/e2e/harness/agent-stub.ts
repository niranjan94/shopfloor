export type StageName =
  | "triage"
  | "spec"
  | "plan"
  | "implement"
  | "review"
  | "handle-merge";

export type NonReviewStage = Exclude<StageName, "review">;

export interface AgentResponse {
  /** Maps directly to the `INPUT_*` env var names the next helper reads. */
  [key: string]: string;
}

export type AgentRole = "compliance" | "bugs" | "security" | "smells";

interface ReviewerOk {
  output: string;
  failed?: false;
}

interface ReviewerFailed {
  failed: true;
  reason: string;
}

export type ReviewerResponse = ReviewerOk | ReviewerFailed;

export type ReviewAgentBundle = Record<AgentRole, ReviewerResponse>;

export class AgentStub {
  private byStage: Map<NonReviewStage, AgentResponse[]> = new Map();
  private reviewBundles: ReviewAgentBundle[] = [];

  queue(stage: NonReviewStage, response: AgentResponse): void {
    if (!this.byStage.has(stage)) this.byStage.set(stage, []);
    this.byStage.get(stage)!.push(response);
  }

  queueReview(bundle: ReviewAgentBundle): void {
    this.reviewBundles.push(bundle);
  }

  consume(stage: NonReviewStage): AgentResponse {
    const q = this.byStage.get(stage);
    if (!q || q.length === 0) {
      throw new Error(
        `AgentStub: no queued agent response for stage '${stage}'. Did the scenario forget harness.queueAgent('${stage}', ...) before runStage?`,
      );
    }
    return q.shift()!;
  }

  consumeReview(): ReviewAgentBundle {
    const b = this.reviewBundles.shift();
    if (!b) {
      throw new Error(
        "AgentStub: no queued review bundle. Did the scenario forget harness.queueReviewAgents(...) before runStage('review')?",
      );
    }
    return b;
  }

  /** Returns counts for all stages that still have queued responses. */
  remainingSummary(): string {
    const parts: string[] = [];
    for (const [stage, q] of this.byStage.entries()) {
      if (q.length > 0) parts.push(`${stage}:${q.length}`);
    }
    if (this.reviewBundles.length > 0) {
      parts.push(`review:${this.reviewBundles.length}`);
    }
    return parts.length === 0 ? "(empty)" : parts.join(", ");
  }
}
