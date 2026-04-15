import { describe, expect, test } from "vitest";
import { advanceState } from "../../src/helpers/advance-state";
import { makeMockAdapter } from "./_mock-adapter";

describe("advanceState", () => {
  test("removes fromLabels and adds toLabels", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:needs-spec" }], state: "open" },
    });
    await advanceState(
      adapter,
      42,
      ["shopfloor:needs-spec"],
      ["shopfloor:spec-in-review"],
    );
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shopfloor:needs-spec" }),
    );
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["shopfloor:spec-in-review"] }),
    );
  });

  test("throws when no from_labels are currently present on the issue", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: { labels: [{ name: "shopfloor:other" }], state: "open" },
    });
    await expect(
      advanceState(
        bundle.adapter,
        42,
        ["shopfloor:needs-spec"],
        ["shopfloor:spec-in-review"],
      ),
    ).rejects.toThrow(/shopfloor:needs-spec/);
    expect(bundle.mocks.removeLabel).not.toHaveBeenCalled();
  });
});
