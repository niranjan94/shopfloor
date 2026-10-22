import { describe, expect, it, vi } from "vitest";
import {
  ExpectTimeout,
  makeExpectClient,
} from "../../scripts/smoke/lib/expect.js";

function fakeGhWithLabels(seq: string[][]) {
  let i = 0;
  return {
    issues: {
      listLabelsOnIssue: vi.fn(async () => {
        const labels = seq[Math.min(i++, seq.length - 1)] ?? [];
        return { data: labels.map((name) => ({ name })) };
      }),
    },
  };
}

describe("expect.ts", () => {
  it("expectLabel resolves when label appears on first poll", async () => {
    const gh = fakeGhWithLabels([["shopfloor:triaging"], ["shopfloor:quick"]]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectLabel(42, "shopfloor:quick");
    expect(gh.issues.listLabelsOnIssue).toHaveBeenCalled();
  });

  it("expectLabel matches a regex label", async () => {
    const gh = fakeGhWithLabels([["shopfloor:medium"]]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectLabel(42, /shopfloor:(quick|medium)/);
  });

  it("expectLabel throws ExpectTimeout when label never appears", async () => {
    const gh = fakeGhWithLabels([["other"]]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 25,
    });
    await expect(c.expectLabel(42, "shopfloor:done")).rejects.toBeInstanceOf(
      ExpectTimeout,
    );
  });

  it("expectLabelMissing resolves when label disappears", async () => {
    const gh = fakeGhWithLabels([["x"], []]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectLabelMissing(42, "x");
  });

  it("expectPrOpenedFor matches PR with correct footer", async () => {
    const gh = {
      pulls: {
        list: vi.fn(async () => ({
          data: [
            {
              number: 7,
              head: { ref: "shopfloor/plan/42-x", sha: "abc" },
              body: "Shopfloor-Issue: #42\nShopfloor-Stage: plan",
            },
          ],
        })),
      },
    };
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    const pr = await c.expectPrOpenedFor(42, "plan");
    expect(pr).toEqual({
      number: 7,
      headRef: "shopfloor/plan/42-x",
      headSha: "abc",
    });
  });

  it("expectPrOpenedFor ignores PRs with wrong stage", async () => {
    const gh = {
      pulls: {
        list: vi.fn(async () => ({
          data: [
            {
              number: 7,
              head: { ref: "x", sha: "a" },
              body: "Shopfloor-Issue: #42\nShopfloor-Stage: spec",
            },
          ],
        })),
      },
    };
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 25,
    });
    await expect(c.expectPrOpenedFor(42, "plan")).rejects.toBeInstanceOf(
      ExpectTimeout,
    );
  });

  it("expectReviewByApp matches a review by app login + marker", async () => {
    const gh = {
      pulls: {
        listReviews: vi.fn(async () => ({
          data: [
            {
              user: { login: "shopfloor-reviewer[bot]" },
              body: "<!-- shopfloor-review -->\n**Shopfloor agent review: clean**...",
            },
          ],
        })),
      },
    };
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectReviewByApp(
      11,
      "shopfloor-reviewer[bot]",
      /<!-- shopfloor-review -->/,
    );
  });
});
