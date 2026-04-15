import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import { runRoute } from "../../src/helpers/route";
import { makeMockAdapter } from "./_mock-adapter";

vi.mock("@actions/github", () => ({
  context: {
    eventName: "issues",
    payload: {
      action: "labeled",
      issue: {
        number: 42,
        title: "x",
        body: "",
        labels: [], // payload snapshot is EMPTY
        state: "open",
      },
      label: { name: "shopfloor:needs-impl" },
    },
    repo: { owner: "o", repo: "r" },
  },
}));

describe("runRoute", () => {
  let setOutput: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setOutput = vi.spyOn(core, "setOutput").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fetches live labels and uses them for state resolution", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [
          { name: "shopfloor:needs-impl" },
          { name: "shopfloor:quick" },
        ],
        state: "open",
      },
    });
    await runRoute(bundle.adapter);
    expect(bundle.mocks.getIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42 }),
    );
    expect(setOutput).toHaveBeenCalledWith("stage", "implement");
  });

  test("falls back to payload labels on API error", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockRejectedValueOnce(new Error("boom"));
    await runRoute(bundle.adapter);
    // Payload has empty issue.labels but label.name is shopfloor:needs-impl.
    // With empty label set, computeStageFromLabels returns null and stage
    // resolves to none.
    expect(setOutput).toHaveBeenCalledWith("stage", "none");
  });
});
