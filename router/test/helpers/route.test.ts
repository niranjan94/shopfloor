import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import { context } from "@actions/github";
import { runRoute } from "../../src/helpers/route";
import { makeMockAdapter } from "./_mock-adapter";

vi.mock("@actions/github", () => ({
  context: {
    eventName: "issues",
    payload: {
      action: "labeled",
      issue: {
        number: 42,
        title: "x",
        body: "",
        labels: [], // payload snapshot is EMPTY
        state: "open",
      },
      label: { name: "shopfloor:needs-impl" },
    },
    repo: { owner: "o", repo: "r" },
  },
}));

const DEFAULT_EVENT_NAME = "issues";
const DEFAULT_PAYLOAD = JSON.parse(JSON.stringify(context.payload));

describe("runRoute", () => {
  let setOutput: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setOutput = vi.spyOn(core, "setOutput").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (context as unknown as { eventName: string }).eventName =
      DEFAULT_EVENT_NAME;
    (context as unknown as { payload: unknown }).payload = JSON.parse(
      JSON.stringify(DEFAULT_PAYLOAD),
    );
  });

  test("fetches live labels and uses them for state resolution", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockResolvedValueOnce({
      data: {
        labels: [{ name: "shopfloor:needs-impl" }, { name: "shopfloor:quick" }],
        state: "open",
      },
    });
    await runRoute(bundle.adapter);
    expect(bundle.mocks.getIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42 }),
    );
    expect(setOutput).toHaveBeenCalledWith("stage", "implement");
  });

  test("falls back to payload labels on API error", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getIssue.mockRejectedValueOnce(new Error("boom"));
    await runRoute(bundle.adapter);
    // Payload has empty issue.labels but label.name is shopfloor:needs-impl.
    // With empty label set, computeStageFromLabels returns null and stage
    // resolves to none.
    expect(setOutput).toHaveBeenCalledWith("stage", "none");
  });

  describe("review-stuck unlabel enrichment", () => {
    beforeEach(() => {
      (context as unknown as { payload: unknown }).payload = {
        action: "unlabeled",
        label: { name: "shopfloor:review-stuck" },
        issue: {
          number: 42,
          title: "Add OAuth",
          body: "",
          labels: [{ name: "shopfloor:needs-review" }],
          state: "open",
          pull_request: null,
        },
        repository: { owner: { login: "o" }, name: "r" },
      };
    });

    test("enriches decision with impl PR number and review iteration", async () => {
      const bundle = makeMockAdapter();
      bundle.mocks.getIssue.mockResolvedValueOnce({
        data: {
          labels: [{ name: "shopfloor:needs-review" }],
          state: "open",
        },
      });
      bundle.mocks.listPrs.mockResolvedValueOnce({
        data: [
          {
            number: 77,
            html_url: "https://x/pr/77",
            body: "Shopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 2",
            head: { ref: "shopfloor/impl/42-add-oauth" },
          },
        ],
      });

      await runRoute(bundle.adapter);

      expect(bundle.mocks.listPrs).toHaveBeenCalledWith(
        expect.objectContaining({ state: "open", per_page: 100, page: 1 }),
      );
      expect(setOutput).toHaveBeenCalledWith("stage", "review");
      expect(setOutput).toHaveBeenCalledWith("impl_pr_number", "77");
      expect(setOutput).toHaveBeenCalledWith("review_iteration", "2");
    });

    test("skips non-matching PRs and picks the impl branch for this issue", async () => {
      const bundle = makeMockAdapter();
      bundle.mocks.getIssue.mockResolvedValueOnce({
        data: {
          labels: [{ name: "shopfloor:needs-review" }],
          state: "open",
        },
      });
      bundle.mocks.listPrs.mockResolvedValueOnce({
        data: [
          {
            number: 50,
            html_url: "https://x/pr/50",
            body: "",
            head: { ref: "feature/unrelated" },
          },
          {
            number: 51,
            html_url: "https://x/pr/51",
            body: "",
            head: { ref: "shopfloor/impl/41-other-issue" },
          },
          {
            number: 77,
            html_url: "https://x/pr/77",
            body: "Shopfloor-Issue: #42\nShopfloor-Stage: implement",
            head: { ref: "shopfloor/impl/42-add-oauth" },
          },
        ],
      });

      await runRoute(bundle.adapter);

      expect(setOutput).toHaveBeenCalledWith("impl_pr_number", "77");
      // No Shopfloor-Review-Iteration in body -> defaults to 0.
      expect(setOutput).toHaveBeenCalledWith("review_iteration", "0");
    });

    test("degrades to stage:none when no matching open impl PR exists", async () => {
      const bundle = makeMockAdapter();
      bundle.mocks.getIssue.mockResolvedValueOnce({
        data: {
          labels: [{ name: "shopfloor:needs-review" }],
          state: "open",
        },
      });
      bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });

      await runRoute(bundle.adapter);

      expect(setOutput).toHaveBeenCalledWith("stage", "none");
      expect(setOutput).toHaveBeenCalledWith(
        "reason",
        "review_stuck_removed_no_open_impl_pr",
      );
      expect(setOutput).not.toHaveBeenCalledWith(
        "impl_pr_number",
        expect.anything(),
      );
    });

    test("degrades to stage:none when the impl PR lookup throws", async () => {
      const bundle = makeMockAdapter();
      bundle.mocks.getIssue.mockResolvedValueOnce({
        data: {
          labels: [{ name: "shopfloor:needs-review" }],
          state: "open",
        },
      });
      bundle.mocks.listPrs.mockRejectedValueOnce(new Error("rate limited"));

      await runRoute(bundle.adapter);

      expect(setOutput).toHaveBeenCalledWith("stage", "none");
      expect(setOutput).toHaveBeenCalledWith(
        "reason",
        "review_stuck_removed_lookup_failed",
      );
    });
  });

  describe("review_only mode", () => {
    beforeEach(() => {
      (context as unknown as { eventName: string }).eventName = "pull_request";
      (context as unknown as { payload: unknown }).payload = {
        action: "synchronize",
        pull_request: {
          number: 77,
          body: null,
          state: "open",
          draft: false,
          merged: false,
          head: { ref: "feature/x", sha: "abc" },
          base: { ref: "main", sha: "def" },
          labels: [],
        },
        repository: { owner: { login: "o" }, name: "r" },
      };
    });

    test("review_only=true dispatches to resolveReviewOnly", async () => {
      vi.spyOn(core, "getInput").mockImplementation((name: string) => {
        if (name === "review_only") return "true";
        if (name === "trigger_label") return "";
        return "";
      });
      const bundle = makeMockAdapter();
      await runRoute(bundle.adapter);
      expect(setOutput).toHaveBeenCalledWith("stage", "review");
      expect(setOutput).toHaveBeenCalledWith("impl_pr_number", "77");
      // Crucially: no issueNumber is emitted because human PRs have no linked
      // Shopfloor issue. Downstream jobs pass PR number as issue_number instead.
      expect(setOutput).not.toHaveBeenCalledWith(
        "issue_number",
        expect.anything(),
      );
    });

    test("review_only not set -> falls through to resolveStage (PR without metadata -> none)", async () => {
      vi.spyOn(core, "getInput").mockImplementation(() => "");
      const bundle = makeMockAdapter();
      await runRoute(bundle.adapter);
      expect(setOutput).toHaveBeenCalledWith("stage", "none");
    });
  });
});
