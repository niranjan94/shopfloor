import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { branchSlug, resolveStage } from "../src/state";
import type { StateContext } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "events", `${name}.json`),
      "utf-8",
    ),
  );
}

function ctx(
  eventName: string,
  fixtureName: string,
  overrides: Partial<StateContext> = {},
): StateContext {
  return {
    eventName,
    payload: loadFixture(fixtureName) as StateContext["payload"],
    ...overrides,
  };
}

describe("resolveStage", () => {
  test("new issue with no labels -> triage", () => {
    const decision = resolveStage(ctx("issues", "issue-opened-bare"));
    expect(decision.stage).toBe("triage");
    expect(decision.issueNumber).toBe(42);
  });

  test("issue labeled shopfloor:needs-spec -> spec", () => {
    const decision = resolveStage(ctx("issues", "issue-labeled-needs-spec"));
    expect(decision.stage).toBe("spec");
    expect(decision.issueNumber).toBe(42);
  });

  test("synchronize on impl PR -> review", () => {
    const decision = resolveStage(ctx("pull_request", "pr-synchronize-impl"));
    expect(decision.stage).toBe("review");
    expect(decision.implPrNumber).toBe(45);
    expect(decision.reviewIteration).toBe(0);
  });

  test("ready_for_review on impl PR -> review (first iteration un-draft path)", () => {
    const decision = resolveStage(
      ctx("pull_request", "pr-ready-for-review-impl"),
    );
    expect(decision.stage).toBe("review");
    expect(decision.implPrNumber).toBe(45);
    expect(decision.reviewIteration).toBe(0);
  });

  test("spec PR merged -> none (reason triggers label flip)", () => {
    const decision = resolveStage(ctx("pull_request", "pr-closed-merged-spec"));
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_merged_spec_triggered_label_flip");
  });

  test("pull_request.closed merged=true returns issueNumber from PR body metadata", () => {
    const decision = resolveStage(ctx("pull_request", "pr-closed-merged-spec"));
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_merged_spec_triggered_label_flip");
    expect(decision.issueNumber).toBe(42);
  });

  test("changes_requested review on impl PR -> implement (revision mode)", () => {
    const decision = resolveStage(
      ctx("pull_request_review", "pr-review-submitted-changes-requested"),
    );
    expect(decision.stage).toBe("implement");
    expect(decision.revisionMode).toBe(true);
  });

  test("closed issue -> none, reason aborted", () => {
    const decision = resolveStage(ctx("issues", "issue-closed"));
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("issue_closed_aborted");
  });

  test("review-stuck label removed -> review", () => {
    const decision = resolveStage(
      ctx("issues", "issue-unlabeled-review-stuck"),
    );
    expect(decision.stage).toBe("review");
  });

  test("awaiting-info label removed -> re-triage", () => {
    const decision = resolveStage(
      ctx("issues", "issue-unlabeled-awaiting-info"),
    );
    expect(decision.stage).toBe("triage");
    expect(decision.reason).toBe("re_triage_after_clarification");
  });

  test("impl PR with skip-review label -> none", () => {
    const decision = resolveStage(
      ctx("pull_request", "pr-synchronize-impl-with-skip-review"),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("skip_review_label_present");
  });

  test("draft impl PR -> none", () => {
    const decision = resolveStage(
      ctx("pull_request", "pr-synchronize-impl-draft"),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_is_draft");
  });

  test("approved review -> none", () => {
    const decision = resolveStage(
      ctx("pull_request_review", "pr-review-approved"),
    );
    expect(decision.stage).toBe("none");
  });

  test("spec PR with changes_requested -> spec (revision mode)", () => {
    const decision = resolveStage(
      ctx("pull_request_review", "pr-review-spec-changes-requested"),
    );
    expect(decision.stage).toBe("spec");
    expect(decision.revisionMode).toBe(true);
  });

  test("branch slug derivation handles special characters", () => {
    const decision = resolveStage(
      ctx("issues", "issue-labeled-needs-plan-no-title"),
    );
    expect(decision.stage).toBe("plan");
    expect(decision.branchName).toBe("shopfloor/plan/42-fix-can-t-log-in");
  });

  test("trigger_label set, new issue without it -> none (trigger_label_absent)", () => {
    const decision = resolveStage(
      ctx("issues", "issue-opened-bare", { triggerLabel: "shopfloor:enabled" }),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("trigger_label_absent");
  });

  test("trigger_label set, issue opened with the label -> none (deferred to labeled event)", () => {
    // Opening an issue with a label already applied fires BOTH 'opened' and
    // 'labeled' events. To prevent double-triggering triage, we defer the 'opened'
    // event to the paired 'labeled' event, which is the single source of truth for
    // pipeline entry when trigger_label is configured.
    const decision = resolveStage(
      ctx("issues", "issue-opened-with-trigger-label", {
        triggerLabel: "shopfloor:enabled",
      }),
    );
    expect(decision.stage).toBe("none");
    expect(decision.issueNumber).toBe(42);
    expect(decision.reason).toBe("opened_deferred_to_labeled_event");
  });

  test("trigger_label set, labeled event adds it -> triage (trigger_label_added)", () => {
    const decision = resolveStage(
      ctx("issues", "issue-labeled-trigger-label-added", {
        triggerLabel: "shopfloor:enabled",
      }),
    );
    expect(decision.stage).toBe("triage");
    expect(decision.reason).toBe("trigger_label_added");
  });

  test("trigger_label set, mid-pipeline issue advances normally without the label", () => {
    // Fixture "issue-labeled-needs-spec" has only shopfloor:large and shopfloor:needs-spec,
    // not the trigger label. Because it has a state label (needs-spec), the gate is grandfathered
    // and the state machine still emits spec.
    const decision = resolveStage(
      ctx("issues", "issue-labeled-needs-spec", {
        triggerLabel: "shopfloor:enabled",
      }),
    );
    expect(decision.stage).toBe("spec");
  });

  test("trigger_label empty string -> treated as unset, existing behavior preserved", () => {
    const decision = resolveStage(
      ctx("issues", "issue-opened-bare", { triggerLabel: "" }),
    );
    expect(decision.stage).toBe("triage");
  });

  test("failed:triage label present + labeled(trigger) -> none (blocked)", () => {
    // Simulates the queued second run of a double-fire where the first run failed
    // triage and recorded shopfloor:failed:triage. The second run must not re-enter.
    const decision = resolveStage(
      ctx("issues", "issue-labeled-trigger-with-failed-triage", {
        triggerLabel: "shopfloor:enabled",
      }),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("blocked_by_shopfloor:failed:triage");
  });

  test("unlabeled(shopfloor:failed:triage) -> triage (retry)", () => {
    const decision = resolveStage(
      ctx("issues", "issue-unlabeled-failed-triage", {
        triggerLabel: "shopfloor:enabled",
      }),
    );
    expect(decision.stage).toBe("triage");
    expect(decision.reason).toBe("retry_after_shopfloor:failed:triage_removed");
  });

  test("unlabeled(shopfloor:failed:spec) with needs-spec still present -> spec (retry)", () => {
    const decision = resolveStage(
      ctx("issues", "issue-unlabeled-failed-spec-with-needs-spec"),
    );
    expect(decision.stage).toBe("spec");
    expect(decision.reason).toBe("retry_after_shopfloor:failed:spec_removed");
    expect(decision.branchName).toBe(
      "shopfloor/spec/42-add-github-oauth-login",
    );
  });

  test("labeled with unrelated label while needs-spec present -> none", () => {
    // Regression guard: previously the state-label rules used `labels.has(...)` with
    // no action guard, so an incidental labeled event (priority tag, random label,
    // or the second run of a double-fired event) would re-enter spec. Now gated on
    // the labeled event's added label matching one of the advancement state labels.
    const decision = resolveStage(
      ctx("issues", "issue-labeled-unrelated-with-needs-spec"),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("no_matching_label_rule");
  });

  test("liveLabels takes precedence over payload.issue.labels for advancement", () => {
    // payload.issue.labels is empty; liveLabels supplies shopfloor:needs-spec.
    // payload.label.name is still shopfloor:needs-spec (the just-added trigger gate).
    // Without liveLabels the labels set would be empty and computeStageFromLabels
    // would return null; with liveLabels it resolves to spec.
    const decision = resolveStage({
      ...ctx("issues", "issue-labeled-needs-spec-empty-issue-labels"),
      liveLabels: ["shopfloor:needs-spec"],
    });
    expect(decision.stage).toBe("spec");
  });

  test("liveLabels can expose a stale advancement when payload says no-op", () => {
    // An opened event where liveLabels carries a state label (needs-impl).
    // hasStateLabel derives from the liveLabels set, so the opened-without-state-label
    // branch does NOT fire, and the decision falls through to none rather than triage.
    // Proves liveLabels are consulted inside resolveIssueEvent.
    const decision = resolveStage({
      ...ctx("issues", "issue-opened-bare"),
      liveLabels: ["shopfloor:quick", "shopfloor:needs-impl"],
    });
    expect(decision.stage).not.toBe("triage");
  });
});

describe("branchSlug", () => {
  test("preserves word boundaries across punctuation separators", () => {
    expect(
      branchSlug("Add rate limiting to /api/users endpoint (OAuth flow)"),
    ).toBe("add-rate-limiting-to-api");
  });

  test("apostrophes become separators, not glue", () => {
    // Regression: old regex stripped ' to nothing, producing "cant".
    // The whole point of this fix is that punctuation splits words.
    expect(branchSlug("Fix: can't log in!")).toBe("fix-can-t-log-in");
  });

  test("internal slashes split adjacent tokens", () => {
    expect(branchSlug("/api/users breaks in prod")).toBe(
      "api-users-breaks-in-prod",
    );
  });

  test("collapses runs of punctuation and whitespace", () => {
    expect(branchSlug("hello,,, world!!!   foo")).toBe("hello-world-foo");
  });

  test("strips leading and trailing dashes after truncation", () => {
    expect(branchSlug("!!!wow!!!")).toBe("wow");
  });

  test("accents-only title falls back to 'issue' sentinel", () => {
    expect(branchSlug("áéíóú")).toBe("issue");
  });

  test("punctuation-only title falls back to 'issue' sentinel", () => {
    expect(branchSlug("!!!???...")).toBe("issue");
  });

  test("empty title falls back to 'issue' sentinel", () => {
    expect(branchSlug("")).toBe("issue");
  });

  test("truncates to 40 chars and strips any trailing dash from the cut", () => {
    const slug = branchSlug("alpha beta gamma delta epsilon zeta eta theta");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
  });
});
