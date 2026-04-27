import { describe, expect, test } from "vitest";
import {
  resolveArtifactPaths,
  validateOverridePath,
} from "../../src/helpers/resolve-artifact-paths";

describe("resolveArtifactPaths", () => {
  test("no metadata yields canonical paths from issue number + slug", () => {
    expect(resolveArtifactPaths(42, "my-slug", null)).toEqual({
      specFilePath: "docs/shopfloor/specs/42-my-slug.md",
      planFilePath: "docs/shopfloor/plans/42-my-slug.md",
    });
  });

  test("metadata without paths yields canonical paths", () => {
    expect(resolveArtifactPaths(42, "s", { slug: "s" })).toEqual({
      specFilePath: "docs/shopfloor/specs/42-s.md",
      planFilePath: "docs/shopfloor/plans/42-s.md",
    });
  });

  test("specPath override returns the override for spec, canonical for plan", () => {
    expect(
      resolveArtifactPaths(42, "s", { slug: "s", specPath: "docs/x.md" }),
    ).toEqual({
      specFilePath: "docs/x.md",
      planFilePath: "docs/shopfloor/plans/42-s.md",
    });
  });

  test("planPath override returns canonical for spec, override for plan", () => {
    expect(
      resolveArtifactPaths(42, "s", { slug: "s", planPath: "docs/y.md" }),
    ).toEqual({
      specFilePath: "docs/shopfloor/specs/42-s.md",
      planFilePath: "docs/y.md",
    });
  });

  test("both overrides returned together", () => {
    expect(
      resolveArtifactPaths(42, "s", {
        slug: "s",
        specPath: "a.md",
        planPath: "b.md",
      }),
    ).toEqual({
      specFilePath: "a.md",
      planFilePath: "b.md",
    });
  });
});

describe("validateOverridePath", () => {
  test("accepts a clean relative .md path", () => {
    expect(() => validateOverridePath("docs/specs/x.md")).not.toThrow();
  });

  test("rejects a leading slash (absolute path)", () => {
    expect(() => validateOverridePath("/etc/passwd")).toThrow(
      /must be a relative path/,
    );
  });

  test("rejects a path containing ..", () => {
    expect(() => validateOverridePath("docs/../etc/x.md")).toThrow(
      /must not contain '\.\.'/,
    );
  });

  test("rejects a non-.md path", () => {
    expect(() => validateOverridePath("docs/specs/x.txt")).toThrow(
      /must end in '\.md'/,
    );
  });

  test("rejects an empty string", () => {
    expect(() => validateOverridePath("")).toThrow(/must not be empty/);
  });
});
