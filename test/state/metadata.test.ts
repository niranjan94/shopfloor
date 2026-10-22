import { describe, expect, test } from "vitest";
import {
  branchSlug,
  parseIssueMetadata,
  parsePrMetadata,
  parseStageBranchRef,
} from "../../src/state/metadata.js";

describe("branchSlug", () => {
  test("preserves word boundaries across punctuation separators", () => {
    expect(
      branchSlug("Add rate limiting to /api/users endpoint (OAuth flow)"),
    ).toBe("add-rate-limiting-to-api");
  });

  test("apostrophes become separators, not glue", () => {
    // Regression: old regex stripped ' to nothing, producing "cant".
    // The whole point of this fix is that punctuation splits words.
    expect(branchSlug("Fix: can't log in!")).toBe("fix-can-t-log-in");
  });

  test("internal slashes split adjacent tokens", () => {
    expect(branchSlug("/api/users breaks in prod")).toBe(
      "api-users-breaks-in-prod",
    );
  });

  test("collapses runs of punctuation and whitespace", () => {
    expect(branchSlug("hello,,, world!!!   foo")).toBe("hello-world-foo");
  });

  test("strips leading and trailing dashes after truncation", () => {
    expect(branchSlug("!!!wow!!!")).toBe("wow");
  });

  test("accents-only title falls back to 'issue' sentinel", () => {
    expect(branchSlug("áéíóú")).toBe("issue");
  });

  test("punctuation-only title falls back to 'issue' sentinel", () => {
    expect(branchSlug("!!!???...")).toBe("issue");
  });

  test("empty title falls back to 'issue' sentinel", () => {
    expect(branchSlug("")).toBe("issue");
  });

  test("truncates to 40 chars and strips any trailing dash from the cut", () => {
    const slug = branchSlug("alpha beta gamma delta epsilon zeta eta theta");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
  });
});

describe("parseIssueMetadata", () => {
  test("returns null when body is null", () => {
    expect(parseIssueMetadata(null)).toBeNull();
  });

  test("returns null when body has no metadata block", () => {
    expect(
      parseIssueMetadata("Just a plain issue body, nothing inside."),
    ).toBeNull();
  });

  test("parses Shopfloor-Slug out of the metadata block", () => {
    const body = [
      "Some human-written description.",
      "",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: add-github-oauth-login",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "add-github-oauth-login",
    });
  });

  test("ignores unknown keys without throwing", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: keep-me",
      "Shopfloor-Unknown: whatever",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({ slug: "keep-me" });
  });

  test("returns empty object when the block is present but has no known keys", () => {
    const body = ["<!-- shopfloor:metadata", "Unknown-Key: x", "-->"].join(
      "\n",
    );
    expect(parseIssueMetadata(body)).toEqual({});
  });

  test("tolerates surrounding whitespace and extra text after the block", () => {
    const body = [
      "Lead-in paragraph.",
      "",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: my-slug",
      "-->",
      "",
      "Trailing text that should not confuse the parser.",
    ].join("\n");
    expect(parseIssueMetadata(body)?.slug).toBe("my-slug");
  });
});

describe("parseIssueMetadata Shopfloor-Spec-Path / Shopfloor-Plan-Path", () => {
  test("returns specPath when present", () => {
    const body = [
      "Body.",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: my-slug",
      "Shopfloor-Spec-Path: docs/specs/x.md",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "my-slug",
      specPath: "docs/specs/x.md",
    });
  });

  test("returns planPath when present", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: s",
      "Shopfloor-Plan-Path: docs/plans/x.md",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "s",
      planPath: "docs/plans/x.md",
    });
  });

  test("returns both when both are present", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: s",
      "Shopfloor-Spec-Path: docs/a.md",
      "Shopfloor-Plan-Path: docs/b.md",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "s",
      specPath: "docs/a.md",
      planPath: "docs/b.md",
    });
  });

  test("legacy block with only slug parses cleanly", () => {
    const body = "<!-- shopfloor:metadata\nShopfloor-Slug: s\n-->";
    expect(parseIssueMetadata(body)).toEqual({ slug: "s" });
  });

  test("ignores unknown keys inside the block", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: s",
      "Shopfloor-Future-Key: whatever",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({ slug: "s" });
  });
});

describe("parsePrMetadata", () => {
  test("returns null for null body", () => {
    expect(parsePrMetadata(null)).toBeNull();
  });

  test("returns null for undefined body", () => {
    expect(parsePrMetadata(undefined)).toBeNull();
  });

  test("returns null when required fields are absent", () => {
    expect(parsePrMetadata("No metadata here.")).toBeNull();
  });

  test("parses all fields when present", () => {
    const body =
      "Shopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 3\nShopfloor-Review-Error-Count: 2";
    expect(parsePrMetadata(body)).toEqual({
      issueNumber: 42,
      stage: "implement",
      reviewIteration: 3,
      reviewErrorCount: 2,
    });
  });

  test("defaults reviewIteration and reviewErrorCount to 0 when absent", () => {
    const body = "Shopfloor-Issue: #7\nShopfloor-Stage: spec";
    expect(parsePrMetadata(body)).toEqual({
      issueNumber: 7,
      stage: "spec",
      reviewIteration: 0,
      reviewErrorCount: 0,
    });
  });

  test("returns null when stage is missing even if issue is present", () => {
    expect(parsePrMetadata("Shopfloor-Issue: #5")).toBeNull();
  });

  test("returns null when issue is missing even if stage is present", () => {
    expect(parsePrMetadata("Shopfloor-Stage: plan")).toBeNull();
  });
});

describe("parseStageBranchRef", () => {
  test("returns null for a non-shopfloor ref", () => {
    expect(parseStageBranchRef("feature/my-thing")).toBeNull();
  });

  test("returns null for a malformed shopfloor ref (no issue number)", () => {
    expect(parseStageBranchRef("shopfloor/impl/no-number")).toBeNull();
  });

  test("returns null for an unknown stage kind", () => {
    expect(parseStageBranchRef("shopfloor/triage/42-foo")).toBeNull();
  });

  test("parses a valid impl branch ref", () => {
    expect(parseStageBranchRef("shopfloor/impl/42-github-oauth-login")).toEqual(
      { stage: "impl", issueNumber: 42, slug: "github-oauth-login" },
    );
  });

  test("parses a valid spec branch ref", () => {
    expect(parseStageBranchRef("shopfloor/spec/7-add-search")).toEqual({
      stage: "spec",
      issueNumber: 7,
      slug: "add-search",
    });
  });

  test("parses a valid plan branch ref", () => {
    expect(parseStageBranchRef("shopfloor/plan/99-refactor-auth")).toEqual({
      stage: "plan",
      issueNumber: 99,
      slug: "refactor-auth",
    });
  });

  test("returns null when slug is empty", () => {
    expect(parseStageBranchRef("shopfloor/impl/42-")).toBeNull();
  });
});
