import { describe, expect, test } from "vitest";
import { bootstrapLabels } from "../../src/helpers/bootstrap-labels";
import { makeMockAdapter } from "./_mock-adapter";

describe("bootstrapLabels", () => {
  test("creates every missing label with correct color", async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.listLabelsForRepo.mockResolvedValueOnce({
      data: [{ name: "shopfloor:triaging" }],
    });
    const created = await bootstrapLabels(adapter);
    expect(created.length).toBeGreaterThanOrEqual(18);
    expect(mocks.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "o",
        repo: "r",
        name: "shopfloor:done",
        color: expect.any(String),
      }),
    );
    expect(created).not.toContain("shopfloor:triaging");
    expect(created).toContain("shopfloor:spec-running");
    expect(created).toContain("shopfloor:plan-running");
    expect(created).toContain("shopfloor:implementing");
  });
});
