import { describe, expect, it } from "vitest";
import { parsePrFooter } from "../../scripts/smoke/lib/footer.js";

describe("parsePrFooter", () => {
  it("parses a fully-populated footer", () => {
    const body = [
      "## Plan",
      "Some plan content here.",
      "",
      "---",
      "Shopfloor-Issue: #142",
      "Shopfloor-Stage: plan",
      "Shopfloor-Review-Iteration: 0",
    ].join("\n");
    expect(parsePrFooter(body)).toEqual({
      issueNumber: 142,
      stage: "plan",
      reviewIteration: 0,
    });
  });

  it("defaults reviewIteration to 0 when missing", () => {
    const body = "Shopfloor-Issue: #7\nShopfloor-Stage: implement";
    expect(parsePrFooter(body)).toEqual({
      issueNumber: 7,
      stage: "implement",
      reviewIteration: 0,
    });
  });

  it("returns null when issue marker is missing", () => {
    expect(parsePrFooter("Shopfloor-Stage: plan")).toBeNull();
  });

  it("returns null when stage marker is missing", () => {
    expect(parsePrFooter("Shopfloor-Issue: #1")).toBeNull();
  });

  it("returns null on null/undefined/empty input", () => {
    expect(parsePrFooter(null)).toBeNull();
    expect(parsePrFooter(undefined)).toBeNull();
    expect(parsePrFooter("")).toBeNull();
  });

  it("accepts all four stage values", () => {
    for (const stage of ["spec", "plan", "implement", "review"] as const) {
      const body = `Shopfloor-Issue: #9\nShopfloor-Stage: ${stage}`;
      expect(parsePrFooter(body)?.stage).toBe(stage);
    }
  });
});
