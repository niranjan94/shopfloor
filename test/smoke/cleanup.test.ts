import { describe, expect, it, vi } from "vitest";
import { cleanupByTitlePrefix } from "../../scripts/smoke/lib/cleanup.js";

function fakeGh(opts: {
  searchResults: Array<{
    number: number;
    pull_request?: { url: string };
    title: string;
  }>;
  prDetails?: Record<number, { head: { ref: string } }>;
}) {
  let searchCall = 0;
  return {
    search: {
      issuesAndPullRequests: vi.fn(async ({ q }: { q: string }) => {
        searchCall += 1;
        const wantPr = q.includes("is:pr");
        const items = opts.searchResults.filter((it) =>
          wantPr ? !!it.pull_request : !it.pull_request,
        );
        return { data: { items, total_count: items.length, call: searchCall } };
      }),
    },
    pulls: {
      get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
        data: opts.prDetails?.[pull_number] ?? { head: { ref: "default-ref" } },
      })),
      update: vi.fn(async () => ({})),
    },
    git: {
      deleteRef: vi.fn(async () => ({})),
    },
    graphql: vi.fn(async (query: string) => {
      if (query.includes("repository(")) {
        return { repository: { issue: { id: "MDEx" } } };
      }
      return { deleteIssue: { __typename: "DeleteIssuePayload" } };
    }),
  };
}

describe("cleanupByTitlePrefix", () => {
  it("closes PRs, deletes branches, and deletes issues", async () => {
    const gh = fakeGh({
      searchResults: [
        {
          number: 7,
          title: "smoke-abc/quick: PR title",
          pull_request: { url: "..." },
        },
        { number: 8, title: "smoke-abc/quick: issue title" },
      ],
      prDetails: { 7: { head: { ref: "shopfloor/impl/8-x" } } },
    });
    const report = await cleanupByTitlePrefix(
      gh as never,
      "o",
      "r",
      "smoke-abc",
    );
    expect(report.prsClosed).toBe(1);
    expect(report.branchesDeleted).toBe(1);
    expect(report.issuesDeleted).toBe(1);
    expect(gh.pulls.update).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      state: "closed",
    });
    expect(gh.git.deleteRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/shopfloor/impl/8-x",
    });
  });

  it("swallows 'Reference does not exist' on deleteRef", async () => {
    const gh = fakeGh({
      searchResults: [
        {
          number: 7,
          title: "smoke-abc/quick: PR",
          pull_request: { url: "..." },
        },
      ],
    });
    gh.git.deleteRef = vi.fn(async () => {
      const e = new Error("Reference does not exist") as Error & {
        status?: number;
      };
      e.status = 422;
      throw e;
    });
    const report = await cleanupByTitlePrefix(
      gh as never,
      "o",
      "r",
      "smoke-abc",
    );
    expect(report.errors).toEqual([]);
    expect(report.branchesDeleted).toBe(0);
  });

  it("records errors for non-422 failures without throwing", async () => {
    const gh = fakeGh({
      searchResults: [{ number: 8, title: "smoke-abc/quick: issue" }],
    });
    gh.graphql = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const report = await cleanupByTitlePrefix(
      gh as never,
      "o",
      "r",
      "smoke-abc",
    );
    expect(report.errors.length).toBe(1);
    expect(report.issuesDeleted).toBe(0);
  });
});
