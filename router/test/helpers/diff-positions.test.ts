import { describe, expect, test } from "vitest";
import {
  buildPositionMap,
  parseHunkPositions,
  partitionCommentsByDiff,
} from "../../src/helpers/diff-positions";

describe("parseHunkPositions", () => {
  test("returns empty sets for an undefined patch (binary file)", () => {
    expect(parseHunkPositions(undefined)).toEqual({
      left: new Set(),
      right: new Set(),
    });
  });

  test("tracks added, removed, and context lines across both sides", () => {
    const patch = [
      "@@ -10,3 +20,4 @@",
      " ctx10",
      "-old11",
      "+new21",
      " ctx12",
    ].join("\n");
    const positions = parseHunkPositions(patch);
    expect([...positions.left].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect([...positions.right].sort((a, b) => a - b)).toEqual([20, 21, 22]);
  });

  test("handles count-omitted hunk headers (single-line hunks)", () => {
    // GitHub omits `,N` when the count is 1: `@@ -5 +7 @@`.
    const patch = ["@@ -5 +7 @@", "-old5", "+new7"].join("\n");
    const positions = parseHunkPositions(patch);
    expect(positions.left.has(5)).toBe(true);
    expect(positions.right.has(7)).toBe(true);
  });

  test("supports multiple hunks within the same patch", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-a",
      "+a",
      " b",
      "@@ -50,2 +60,2 @@",
      "-x",
      "+x",
      " y",
    ].join("\n");
    const positions = parseHunkPositions(patch);
    expect([...positions.right].sort((a, b) => a - b)).toEqual([1, 2, 60, 61]);
    expect([...positions.left].sort((a, b) => a - b)).toEqual([1, 2, 50, 51]);
  });

  test("ignores `\\ No newline at end of file` markers", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "\\ No newline at end of file",
      "+a",
    ].join("\n");
    const positions = parseHunkPositions(patch);
    expect(positions.left.has(1)).toBe(true);
    expect(positions.right.has(1)).toBe(true);
  });
});

describe("partitionCommentsByDiff", () => {
  test("keeps comments inside hunks; drops those outside", () => {
    const patches = [
      {
        filename: "src/a.ts",
        patch: "@@ -1,1 +1,1 @@\n-a\n+a",
      },
    ];
    const map = buildPositionMap(patches);
    const { valid, dropped } = partitionCommentsByDiff(
      [
        { path: "src/a.ts", line: 1, side: "RIGHT" as const },
        { path: "src/a.ts", line: 99, side: "RIGHT" as const },
        { path: "src/missing.ts", line: 1, side: "RIGHT" as const },
      ],
      map,
    );
    expect(valid).toHaveLength(1);
    expect(valid[0].line).toBe(1);
    expect(dropped).toHaveLength(2);
  });

  test("multi-line comments require both endpoints inside the hunk", () => {
    const patches = [
      {
        filename: "src/a.ts",
        patch: "@@ -1,3 +1,3 @@\n-a\n+a\n b\n c",
      },
    ];
    const map = buildPositionMap(patches);
    const { valid, dropped } = partitionCommentsByDiff(
      [
        // start_line outside the hunk -> drop.
        {
          path: "src/a.ts",
          line: 3,
          side: "RIGHT" as const,
          start_line: 99,
          start_side: "RIGHT" as const,
        },
        // both endpoints inside -> keep.
        {
          path: "src/a.ts",
          line: 3,
          side: "RIGHT" as const,
          start_line: 1,
          start_side: "RIGHT" as const,
        },
      ],
      map,
    );
    expect(valid).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].start_line).toBe(99);
  });

  test("drops every comment on a binary file (patch undefined)", () => {
    const patches = [{ filename: "image.png" }];
    const map = buildPositionMap(patches);
    const { valid, dropped } = partitionCommentsByDiff(
      [{ path: "image.png", line: 1, side: "RIGHT" as const }],
      map,
    );
    expect(valid).toEqual([]);
    expect(dropped).toHaveLength(1);
  });
});
