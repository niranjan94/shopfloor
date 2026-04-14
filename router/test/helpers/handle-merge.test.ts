import { describe, expect, test } from "vitest";
import { handleMerge } from "../../src/helpers/handle-merge";
import { makeMockAdapter } from "./_mock-adapter";

describe("handleMerge", () => {
  test("spec PR merged -> needs-plan", async () => {
    const { adapter, mocks } = makeMockAdapter();
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
});
