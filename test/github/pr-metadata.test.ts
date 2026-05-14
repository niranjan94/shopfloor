import { describe, expect, it } from "vitest";
import { renderPrBodyWithMetadata } from "../../src/github/pr-metadata.js";
import { parsePrMetadata } from "../../src/state/metadata.js";

describe("renderPrBodyWithMetadata", () => {
  it("appends the metadata block to a fresh body", () => {
    const out = renderPrBodyWithMetadata({
      issueNumber: 7,
      stage: "implement",
      reviewIteration: 2,
      userBody: "## What changed\nstuff",
    });
    expect(out).toContain("## What changed");
    expect(out).toContain("<!-- shopfloor:metadata -->");
    expect(out).toContain("Shopfloor-Issue: #7");
    expect(out).toContain("Shopfloor-Stage: implement");
    expect(out).toContain("Shopfloor-Review-Iteration: 2");
    expect(out).toContain("<!-- /shopfloor:metadata -->");
  });

  it("round-trips with parsePrMetadata", () => {
    const out = renderPrBodyWithMetadata({
      issueNumber: 42,
      stage: "spec",
      reviewIteration: 0,
      userBody: "body",
    });
    const parsed = parsePrMetadata(out);
    expect(parsed).toEqual({
      issueNumber: 42,
      stage: "spec",
      reviewIteration: 0,
    });
  });

  it("trims trailing whitespace from user body before appending", () => {
    const out = renderPrBodyWithMetadata({
      issueNumber: 1,
      stage: "plan",
      reviewIteration: 0,
      userBody: "body text\n\n\n",
    });
    expect(out).toMatch(/body text\n\n<!-- shopfloor:metadata -->/);
  });
});
