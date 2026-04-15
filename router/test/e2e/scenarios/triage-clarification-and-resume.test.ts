import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { FakeGitHub } from "../fake-github";
import { ScenarioHarness } from "../harness/scenario-harness";
import { loadEvent } from "../harness/fixtures";

describe("triage clarification and resume", () => {
  let fake: FakeGitHub;
  let harness: ScenarioHarness;

  beforeEach(async () => {
    fake = new FakeGitHub({
      owner: "niranjan94",
      repo: "shopfloor",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    harness = new ScenarioHarness({ fake });
    await harness.bootstrap();
    fake.seedBranch("main", "sha-main-0");
    fake.seedIssue({
      number: 42,
      title: "Add foo",
      body: "Need foo, but the spec is unclear.",
      author: "alice",
      labels: ["shopfloor:enabled"],
    });
  });
  afterEach(async () => harness.dispose());

  test("triage(needs_clarification) -> user answers -> triage(classified) resumes", async () => {
    // 1. First triage decides it needs more information. The helper
    //    posts the clarifying questions as a comment and flips the
    //    issue into shopfloor:awaiting-info without writing a slug
    //    (the title may still change before the eventual classified
    //    re-triage, so apply-triage-decision defers metadata writes).
    await harness.deliverEvent(
      loadEvent("issue-labeled-trigger-label-added.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "needs_clarification",
        complexity: "medium",
        rationale: "The issue body does not describe the auth flow.",
        clarifying_questions: ["What auth flow?", "Mobile too?"],
      }),
    });
    await harness.runStage("triage");

    expect(fake.labelsOn(42)).toContain("shopfloor:awaiting-info");
    expect(fake.labelsOn(42)).toContain("shopfloor:enabled");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:triaging");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:medium");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:needs-plan");
    expect(fake.issue(42).body ?? "").not.toMatch(/Shopfloor-Slug:/);

    const clarificationComment = fake
      .commentsOn(42)
      .find((c) => c.body.includes("What auth flow?"));
    expect(clarificationComment).toBeDefined();
    expect(clarificationComment!.body).toContain("Mobile too?");
    expect(clarificationComment!.body).toContain("shopfloor:awaiting-info");

    // 2. The reporter answers out of band and removes the awaiting-info
    //    label. In production both actions come from a human; in the
    //    harness we post the comment as alice and remove just the one
    //    label (the enabled gate label must persist so the re-triage
    //    route branch can reach the triage stage).
    await fake.asOctokit("alice").rest.issues.createComment({
      owner: fake.owner,
      repo: fake.repo,
      issue_number: 42,
      body: "OAuth via GitHub App, and yes mobile too.",
    });
    await fake.asOctokit(fake.primaryIdentity).rest.issues.removeLabel({
      owner: fake.owner,
      repo: fake.repo,
      issue_number: 42,
      name: "shopfloor:awaiting-info",
    });
    expect(fake.labelsOn(42)).not.toContain("shopfloor:awaiting-info");
    expect(fake.labelsOn(42)).toContain("shopfloor:enabled");

    // 3. Resume event. The unlabeled-awaiting-info fixture carries an
    //    empty payload label list; the router reads live labels from
    //    the fake, so the gate evaluation sees the real state.
    await harness.deliverEvent(
      loadEvent("issue-unlabeled-awaiting-info.json", { issueNumber: 42 }),
      { trigger_label: "shopfloor:enabled" },
    );
    harness.queueAgent("triage", {
      decision_json: JSON.stringify({
        status: "classified",
        complexity: "medium",
        rationale: "now clear",
        clarifying_questions: [],
      }),
    });
    await harness.runStage("triage");

    // The second triage classifies the issue as medium and hands off
    // to the plan stage via shopfloor:needs-plan. The slug metadata
    // block is written exactly once, on this classified decision.
    expect(fake.labelsOn(42)).toContain("shopfloor:medium");
    expect(fake.labelsOn(42)).toContain("shopfloor:needs-plan");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:awaiting-info");
    expect(fake.labelsOn(42)).not.toContain("shopfloor:triaging");
    expect(fake.issue(42).body ?? "").toMatch(/Shopfloor-Slug:/);

    // The user's answer comment survives the re-triage untouched.
    const answer = fake
      .commentsOn(42)
      .find((c) => c.body.includes("OAuth via GitHub App"));
    expect(answer).toBeDefined();

    // Final snapshot to lock in the post-resume state.
    expect(fake.snapshot()).toMatchSnapshot();
  });
});
