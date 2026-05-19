import { describe, expect, it, vi } from "vitest";
import { newRunTag, scenarioTag } from "../../scripts/smoke/lib/tag.js";

describe("tag.ts", () => {
  it("newRunTag returns the canonical shape smoke-YYYYMMDD-xxxx", () => {
    vi.setSystemTime(new Date("2026-05-19T10:00:00Z"));
    const tag = newRunTag();
    expect(tag).toMatch(/^smoke-20260519-[a-z0-9]{4}$/);
    vi.useRealTimers();
  });

  it("newRunTag is unique across rapid invocations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newRunTag());
    expect(seen.size).toBeGreaterThan(180);
  });

  it("scenarioTag composes run tag and scenario id with a slash", () => {
    expect(scenarioTag("smoke-20260519-abc1", "quick")).toBe(
      "smoke-20260519-abc1/quick",
    );
  });
});
