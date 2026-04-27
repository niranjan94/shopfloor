import { describe, expect, test } from "vitest";
import { upsertIssueMetadata } from "../../src/helpers/upsert-issue-metadata";
import { parseIssueMetadata } from "../../src/state";

describe("upsertIssueMetadata", () => {
  test("appends a new block when none exists", () => {
    const body = "Human-written description.\n\nSecond paragraph.";
    const next = upsertIssueMetadata(body, { slug: "my-slug" });
    expect(next).toContain("Human-written description.");
    expect(next).toContain("Second paragraph.");
    expect(parseIssueMetadata(next)?.slug).toBe("my-slug");
  });

  test("replaces an existing block in place, preserving surrounding text", () => {
    const body = [
      "Lead-in text.",
      "",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: old-slug",
      "-->",
      "",
      "Trailing text.",
    ].join("\n");
    const next = upsertIssueMetadata(body, { slug: "new-slug" });
    expect(next).toContain("Lead-in text.");
    expect(next).toContain("Trailing text.");
    expect(parseIssueMetadata(next)?.slug).toBe("new-slug");
    // no duplication: exactly one opener in the result
    expect(next.match(/<!--\s*shopfloor:metadata/g)?.length).toBe(1);
  });

  test("running twice with the same fields is idempotent", () => {
    const once = upsertIssueMetadata("body", { slug: "my-slug" });
    const twice = upsertIssueMetadata(once, { slug: "my-slug" });
    expect(twice).toBe(once);
    expect(twice.match(/<!--\s*shopfloor:metadata/g)?.length).toBe(1);
  });

  test("handles a null body by producing a body with just the block", () => {
    const next = upsertIssueMetadata(null, { slug: "my-slug" });
    expect(parseIssueMetadata(next)?.slug).toBe("my-slug");
  });

  test("handles an empty string body", () => {
    const next = upsertIssueMetadata("", { slug: "my-slug" });
    expect(parseIssueMetadata(next)?.slug).toBe("my-slug");
  });

  test("replaces a malformed block without throwing", () => {
    // Missing closer: the parser would currently refuse to match, but the
    // writer must not leave the broken opener in place. It detects the
    // opener and replaces from there to the end of the body.
    const body = [
      "Before.",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: broken",
      "",
      "oops no closer",
    ].join("\n");
    const next = upsertIssueMetadata(body, { slug: "fixed" });
    expect(next).toContain("Before.");
    expect(parseIssueMetadata(next)?.slug).toBe("fixed");
    expect(next.match(/<!--\s*shopfloor:metadata/g)?.length).toBe(1);
  });

  test("writes specPath when supplied alongside slug", () => {
    const next = upsertIssueMetadata(null, {
      slug: "s",
      specPath: "docs/specs/x.md",
    });
    expect(parseIssueMetadata(next)).toEqual({
      slug: "s",
      specPath: "docs/specs/x.md",
    });
  });

  test("writes planPath when supplied alongside slug", () => {
    const next = upsertIssueMetadata(null, {
      slug: "s",
      planPath: "docs/plans/x.md",
    });
    expect(parseIssueMetadata(next)).toEqual({
      slug: "s",
      planPath: "docs/plans/x.md",
    });
  });

  test("writes both paths in stable order: slug, specPath, planPath", () => {
    const next = upsertIssueMetadata(null, {
      slug: "s",
      specPath: "a.md",
      planPath: "b.md",
    });
    const block =
      next.match(/<!--\s*shopfloor:metadata([\s\S]*?)-->/)?.[1] ?? "";
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      "Shopfloor-Slug: s",
      "Shopfloor-Spec-Path: a.md",
      "Shopfloor-Plan-Path: b.md",
    ]);
  });

  test("upsert is idempotent across spec/plan path writes", () => {
    const once = upsertIssueMetadata(null, {
      slug: "s",
      specPath: "a.md",
    });
    const twice = upsertIssueMetadata(once, { slug: "s", specPath: "a.md" });
    expect(twice).toBe(once);
  });

  test("upserting with a wider field set replaces the block contents", () => {
    const initial = upsertIssueMetadata(null, {
      slug: "s",
      specPath: "a.md",
    });
    const next = upsertIssueMetadata(initial, {
      slug: "s",
      specPath: "a.md",
      planPath: "b.md",
    });
    expect(parseIssueMetadata(next)).toEqual({
      slug: "s",
      specPath: "a.md",
      planPath: "b.md",
    });
  });
});
