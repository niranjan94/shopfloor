import { describe, expect, test } from "vitest";
import { precheckStage } from "../../src/helpers/precheck-stage";
import { makeMockAdapter } from "./_mock-adapter";

function withLabels(
  bundle: ReturnType<typeof makeMockAdapter>,
  labels: string[],
): void {
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: labels.map((name) => ({ name })),
      state: "open",
    },
  });
}

describe("precheckStage", () => {
  describe("triage", () => {
    test("no state labels -> skip=false", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, []);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("triaging mutex marker already present -> skip=true", async () => {
      // A queued second triage run must not race the first: the triaging
      // marker is set by the triage job's pre-agent advance-state step and
      // cleared either by apply-triage-decision (success) or report-failure
      // (failure). Its presence means either a concurrent run is live or a
      // prior run crashed without cleanup.
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:triaging"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toMatch(/triaging/);
    });

    test("awaiting-info present -> skip=false", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:awaiting-info"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("advancement already applied -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:quick", "shopfloor:needs-impl"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toMatch(/needs-impl/);
    });
  });

  describe("spec", () => {
    test("needs-spec present, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-spec"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "spec",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("marker present -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-spec", "shopfloor:spec-running"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "spec",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toBe("spec_already_in_progress");
    });

    test("needs-spec absent -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:spec-in-review"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "spec",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toBe("spec_needs_spec_label_absent");
    });
  });

  describe("plan", () => {
    test("needs-plan present, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-plan"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "plan",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("marker present -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-plan", "shopfloor:plan-running"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "plan",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
    });
  });

  describe("implement", () => {
    test("needs-impl, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-impl"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "implement",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("revision label, no marker -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, [
        "shopfloor:impl-in-review",
        "shopfloor:review-requested-changes",
      ]);
      const r = await precheckStage(bundle.adapter, {
        stage: "implement",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("implementing marker -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-impl", "shopfloor:implementing"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "implement",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toBe("implement_already_in_progress");
    });

    test("already advanced past needs-impl -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:impl-in-review"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "implement",
        issueNumber: 42,
      });
      expect(r.skip).toBe(true);
    });
  });

  describe("review-aggregator", () => {
    test("needs-review present, no SHA check -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-review"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "review-aggregator",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
    });

    test("head sha drift -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-review"]);
      bundle.mocks.getPr.mockResolvedValueOnce({
        data: {
          head: { sha: "newsha" },
          labels: [],
          state: "open",
          draft: false,
          merged: false,
          body: "",
        },
      });
      const r = await precheckStage(bundle.adapter, {
        stage: "review-aggregator",
        issueNumber: 42,
        prNumber: 99,
        analysedSha: "oldsha1234567",
      });
      expect(r.skip).toBe(true);
      expect(r.reason).toMatch(/drift/);
    });

    test("head sha match -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-review"]);
      bundle.mocks.getPr.mockResolvedValueOnce({
        data: {
          head: { sha: "samesha" },
          labels: [],
          state: "open",
          draft: false,
          merged: false,
          body: "",
        },
      });
      const r = await precheckStage(bundle.adapter, {
        stage: "review-aggregator",
        issueNumber: 42,
        prNumber: 99,
        analysedSha: "samesha",
      });
      expect(r.skip).toBe(false);
    });
  });

  describe("handle-merge", () => {
    test("spec transition already applied -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:needs-plan"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "handle-merge",
        issueNumber: 42,
        mergedStage: "spec",
      });
      expect(r.skip).toBe(true);
    });

    test("spec transition not yet applied -> pass", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:spec-in-review"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "handle-merge",
        issueNumber: 42,
        mergedStage: "spec",
      });
      expect(r.skip).toBe(false);
    });

    test("impl merge already done -> skip=true", async () => {
      const bundle = makeMockAdapter();
      withLabels(bundle, ["shopfloor:done"]);
      const r = await precheckStage(bundle.adapter, {
        stage: "handle-merge",
        issueNumber: 42,
        mergedStage: "implement",
      });
      expect(r.skip).toBe(true);
    });
  });

  describe("fail policy", () => {
    test("API read error -> fail open (skip=false)", async () => {
      const bundle = makeMockAdapter();
      bundle.mocks.getIssue.mockRejectedValueOnce(new Error("boom"));
      const r = await precheckStage(bundle.adapter, {
        stage: "triage",
        issueNumber: 42,
      });
      expect(r.skip).toBe(false);
      expect(r.reason).toBe("precheck_read_error_fail_open");
    });
  });
});
