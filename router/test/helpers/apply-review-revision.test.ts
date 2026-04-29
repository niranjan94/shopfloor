import { describe, expect, test } from "vitest";
import { applyReviewRevision } from "../../src/helpers/apply-review-revision";
import { makeMockAdapter } from "./_mock-adapter";

describe("applyReviewRevision", () => {
  test("flips issue into review-requested-changes and clears terminal review state", async () => {
    const bundle = makeMockAdapter();

    await applyReviewRevision(bundle.adapter, { issueNumber: 754 });

    expect(bundle.mocks.addLabels).toHaveBeenCalledTimes(1);
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 754,
        labels: ["shopfloor:review-requested-changes"],
      }),
    );

    const removed = bundle.mocks.removeLabel.mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name,
    );
    expect(removed).toEqual(
      expect.arrayContaining([
        "shopfloor:needs-review",
        "shopfloor:review-stuck",
      ]),
    );
  });

  test("removeLabel 404s are swallowed (idempotent re-run)", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.removeLabel.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );

    await expect(
      applyReviewRevision(bundle.adapter, { issueNumber: 754 }),
    ).resolves.toBeUndefined();
    expect(bundle.mocks.addLabels).toHaveBeenCalledTimes(1);
  });
});
