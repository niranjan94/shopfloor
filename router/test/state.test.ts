import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { branchSlug, parseIssueMetadata, resolveStage } from "../src/state";
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
    expect(decision.issueNumber).toBe(42);
    expect(decision.implPrNumber).toBe(45);
    expect(decision.branchName).toBe("shopfloor/impl/42-github-oauth-login");
    expect(decision.specFilePath).toBe(
      "docs/shopfloor/specs/42-github-oauth-login.md",
    );
    expect(decision.planFilePath).toBe(
      "docs/shopfloor/plans/42-github-oauth-login.md",
    );
    expect(decision.reason).toBe("human_requested_changes");
  });

  test("changes_requested review on impl PR with unparseable head ref -> none (fail closed)", () => {
    const decision = resolveStage(
      ctx(
        "pull_request_review",
        "pr-review-submitted-changes-requested-unparseable-ref",
      ),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("impl_revision_unparseable_branch_ref");
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

  test("synchronize on impl PR with shopfloor:wip label -> none", () => {
    const decision = resolveStage(
      ctx("pull_request", "pr-synchronize-impl-wip"),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("pr_has_wip_label");
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
    expect(decision.issueNumber).toBe(42);
    // The route must re-emit the spec branch so the downstream spec stage
    // can upsert the existing PR instead of opening a new one.
    expect(decision.branchName).toBe("shopfloor/spec/42-x");
    expect(decision.specFilePath).toBe("docs/shopfloor/specs/42-x.md");
    expect(decision.reason).toBe("human_requested_changes");
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

  test("unlabeled(shopfloor:failed:review) with needs-review present -> none (retry requires next PR push)", () => {
    // Review is driven by pull_request events, so there is no issue-side
    // stage to transition to. Clearing the failed label unblocks the
    // failed-label gate; the next push to the impl PR will retrigger
    // review via synchronize. The reason surfaces this in router logs so
    // it does not look like the action got lost.
    const decision = resolveStage(
      ctx("issues", "issue-unlabeled-failed-review-with-needs-review"),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("retry_review_cleared_awaiting_next_push");
    expect(decision.issueNumber).toBe(42);
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

  test("persisted slug in issue body survives a title rename", () => {
    // Regression for the rename-after-triage bug: the title was edited to
    // something unrelated, but the slug was persisted to the issue body
    // during triage. The branch name must come from the persisted slug, not
    // from re-running branchSlug on the current (renamed) title.
    const decision = resolveStage(
      ctx("issues", "issue-labeled-needs-spec-renamed-with-slug"),
    );
    expect(decision.stage).toBe("spec");
    expect(decision.branchName).toBe(
      "shopfloor/spec/42-add-github-oauth-login",
    );
  });

  test("legacy issue without persisted slug falls back to branchSlug(title)", () => {
    // Existing fixture has no shopfloor:metadata block in body; this
    // guarantees in-flight issues from before the persistence change keep
    // advancing normally.
    const decision = resolveStage(
      ctx("issues", "issue-unlabeled-failed-spec-with-needs-spec"),
    );
    expect(decision.branchName).toBe(
      "shopfloor/spec/42-add-github-oauth-login",
    );
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

describe("parseIssueMetadata", () => {
  test("returns null when body is null", () => {
    expect(parseIssueMetadata(null)).toBeNull();
  });

  test("returns null when body has no metadata block", () => {
    expect(
      parseIssueMetadata("Just a plain issue body, nothing inside."),
    ).toBeNull();
  });

  test("parses Shopfloor-Slug out of the metadata block", () => {
    const body = [
      "Some human-written description.",
      "",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: add-github-oauth-login",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "add-github-oauth-login",
    });
  });

  test("ignores unknown keys without throwing", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: keep-me",
      "Shopfloor-Unknown: whatever",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({ slug: "keep-me" });
  });

  test("returns empty object when the block is present but has no known keys", () => {
    const body = ["<!-- shopfloor:metadata", "Unknown-Key: x", "-->"].join(
      "\n",
    );
    expect(parseIssueMetadata(body)).toEqual({});
  });

  test("tolerates surrounding whitespace and extra text after the block", () => {
    const body = [
      "Lead-in paragraph.",
      "",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: my-slug",
      "-->",
      "",
      "Trailing text that should not confuse the parser.",
    ].join("\n");
    expect(parseIssueMetadata(body)?.slug).toBe("my-slug");
  });
});
