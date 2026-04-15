import { describe, expect, test } from "vitest";
import { handleMerge } from "../../src/helpers/handle-merge";
import { makeMockAdapter } from "./_mock-adapter";

describe("handleMerge", () => {
  test("spec PR merged -> needs-plan", async () => {
    const { adapter, mocks } = makeMockAdapter();
    // alreadyApplied check: needs-plan not present, spec-in-review is
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:spec-in-review" }], state: "open" },
    });
    // advance-state from-labels check
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:spec-in-review" }], state: "open" },
    });
    await handleMerge(adapter, {
      issueNumber: 42,
      mergedStage: "spec",
      prNumber: 43,
    });
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:spec-in-review" }),
    );
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:needs-plan"] }),
    );
  });

  test("plan PR merged -> needs-impl", async () => {
    const { adapter, mocks } = makeMockAdapter();
    // alreadyApplied check: needs-impl not present, plan-in-review is
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:plan-in-review" }], state: "open" },
    });
    // advance-state from-labels check
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:plan-in-review" }], state: "open" },
    });
    await handleMerge(adapter, {
      issueNumber: 42,
      mergedStage: "plan",
      prNumber: 44,
    });
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:plan-in-review" }),
    );
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:needs-impl"] }),
    );
  });

  test("impl PR merged -> done + close issue", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:impl-in-review" }], state: "open" },
    });
    // advance-state from-labels check
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:impl-in-review" }], state: "open" },
    });
    await handleMerge(adapter, {
      issueNumber: 42,
      mergedStage: "implement",
      prNumber: 45,
    });
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:done"] }),
    );
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, state: "closed" }),
    );
  });

  test("is idempotent when spec transition is already applied", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:needs-plan" }],
        state: "open",
      },
    });
    await handleMerge(bundle.adapter, {
      issueNumber: 42,
      mergedStage: "spec",
      prNumber: 7,
    });
    expect(bundle.mocks.removeLabel).not.toHaveBeenCalled();
    expect(bundle.mocks.addLabels).not.toHaveBeenCalled();
    expect(bundle.mocks.createComment).not.toHaveBeenCalled();
  });
});
