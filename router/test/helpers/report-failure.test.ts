import { describe, expect, test } from "vitest";
import { reportFailure } from "../../src/helpers/report-failure";
import { makeMockAdapter } from "./_mock-adapter";

describe("reportFailure", () => {
  test("posts diagnostic comment and applies failed label", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "spec",
      runUrl: "https://x/run/1",
    });
    expect(mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("spec") }),
    );
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:failed:spec"] }),
    );
  });

  test("stage=triage also clears the shopfloor:triaging mutex marker", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "triage",
      runUrl: "https://x/run/1",
    });
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:failed:triage"] }),
    );
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:triaging" }),
    );
  });

  test("stage=spec clears the shopfloor:spec-running mutex marker", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "spec",
      runUrl: "https://x/run/1",
    });
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:spec-running" }),
    );
  });

  test("stage=plan clears the shopfloor:plan-running mutex marker", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "plan",
      runUrl: "https://x/run/1",
    });
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:plan-running" }),
    );
  });

  test("stage=implement clears the shopfloor:implementing mutex marker", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "implement",
      runUrl: "https://x/run/1",
    });
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:implementing" }),
    );
  });

  test("stage=review does not clear any mutex marker", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "review",
      runUrl: "https://x/run/7",
      targetPrNumber: 99,
    });
    expect(mocks.removeLabel).not.toHaveBeenCalled();
  });

  test("stage=review surfaces push-or-rerun retry instructions", async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, {
      issueNumber: 42,
      stage: "review",
      runUrl: "https://x/run/7",
      targetPrNumber: 99,
    });
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:failed:review"] }),
    );
    const comment = mocks.createComment.mock.calls[0][0] as { body: string };
    // Review cannot be driven from an issue event, so removing the label
    // alone is not enough; the comment must call out both retry paths.
    expect(comment.body).toContain("shopfloor:failed:review");
    expect(comment.body).toContain("pushing a new commit");
    expect(comment.body).toContain("re-running the failed jobs");
  });
});
