import { describe, expect, test } from "vitest";
import { seedStagePr } from "../../src/helpers/seed-stage-pr";
import { makeMockAdapter } from "./_mock-adapter";

describe("seedStagePr", () => {
  test("happy path: get base sha, create branch, write file, open PR", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockResolvedValueOnce({ data: {} });
    bundle.mocks.getContent.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 7, html_url: "https://x/pr/7" },
    });

    const result = await seedStagePr(bundle.adapter, {
      issueNumber: 42,
      slug: "do-thing",
      stage: "spec",
      content: "# Spec\n\nbody",
      baseBranch: "main",
      prTitle: "Seed spec for #42: Do thing",
      prSummary: "Seeded from issue #42's body during triage.",
    });

    expect(result).toEqual({
      prNumber: 7,
      url: "https://x/pr/7",
      branchName: "shopfloor/spec/42-do-thing",
      filePath: "docs/shopfloor/specs/42-do-thing.md",
    });
    expect(bundle.mocks.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "refs/heads/shopfloor/spec/42-do-thing",
        sha: "main-sha",
      }),
    );
    expect(bundle.mocks.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "docs/shopfloor/specs/42-do-thing.md",
        branch: "shopfloor/spec/42-do-thing",
        content: Buffer.from("# Spec\n\nbody", "utf8").toString("base64"),
      }),
    );
    const putCall = bundle.mocks.createOrUpdateFileContents.mock
      .calls[0][0] as {
      sha?: string;
    };
    expect(putCall.sha).toBeUndefined();
  });

  test("retry: ref-exists 422 + file already at path: passes existing blob sha", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("Reference already exists"), { status: 422 }),
    );
    bundle.mocks.getContent.mockResolvedValueOnce({
      data: { sha: "blob123", type: "file" },
    });
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 7, html_url: "https://x/pr/7" },
    });

    await seedStagePr(bundle.adapter, {
      issueNumber: 42,
      slug: "do-thing",
      stage: "plan",
      content: "# Plan",
      baseBranch: "main",
      prTitle: "Seed plan for #42",
      prSummary: "summary",
    });

    const putCall = bundle.mocks.createOrUpdateFileContents.mock
      .calls[0][0] as {
      sha?: string;
    };
    expect(putCall.sha).toBe("blob123");
  });

  test("idempotent: existing PR for the head branch is reused", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("exists"), { status: 422 }),
    );
    bundle.mocks.getContent.mockResolvedValueOnce({
      data: { sha: "blob", type: "file" },
    });
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({
      data: [
        {
          number: 99,
          html_url: "https://x/pr/99",
          head: { ref: "shopfloor/spec/42-x" },
        },
      ],
    });

    const result = await seedStagePr(bundle.adapter, {
      issueNumber: 42,
      slug: "x",
      stage: "spec",
      content: "x",
      baseBranch: "main",
      prTitle: "t",
      prSummary: "s",
    });
    expect(result.prNumber).toBe(99);
    expect(bundle.mocks.createPr).not.toHaveBeenCalled();
    expect(bundle.mocks.updatePr).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 99 }),
    );
  });

  test("non-422 createRef error rethrows untouched", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("server error"), { status: 500 }),
    );
    await expect(
      seedStagePr(bundle.adapter, {
        issueNumber: 42,
        slug: "x",
        stage: "spec",
        content: "x",
        baseBranch: "main",
        prTitle: "t",
        prSummary: "s",
      }),
    ).rejects.toThrow("server error");
  });
});
