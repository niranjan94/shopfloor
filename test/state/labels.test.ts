import { describe, expect, it } from "vitest";
import {
  complexityLabel,
  failedLabelFor,
  isFailedLabel,
  isRunningLabel,
  isShopfloorLabel,
  LABELS,
  needsLabelFor,
  runningLabelFor,
} from "../../src/state/labels.js";

describe("labels", () => {
  it("namespaces all labels under shopfloor:", () => {
    for (const label of Object.values(LABELS)) {
      expect(label.startsWith("shopfloor:")).toBe(true);
    }
  });

  it("identifies shopfloor labels", () => {
    expect(isShopfloorLabel("shopfloor:triaging")).toBe(true);
    expect(isShopfloorLabel("bug")).toBe(false);
  });

  it("identifies running and failed labels", () => {
    expect(isRunningLabel("shopfloor:triaging")).toBe(true);
    expect(isRunningLabel("shopfloor:spec-running")).toBe(true);
    expect(isRunningLabel("shopfloor:implementing")).toBe(true);
    expect(isRunningLabel("shopfloor:review-running")).toBe(true);
    expect(isRunningLabel("shopfloor:done")).toBe(false);
    expect(isFailedLabel("shopfloor:failed:implement")).toBe(true);
    expect(isFailedLabel("shopfloor:done")).toBe(false);
  });

  it("derives stage-specific failed/running labels", () => {
    expect(failedLabelFor("implement")).toBe("shopfloor:failed:implement");
    expect(runningLabelFor("triage")).toBe("shopfloor:triaging");
    expect(runningLabelFor("implement")).toBe("shopfloor:implementing");
    expect(runningLabelFor("review")).toBe("shopfloor:review-running");
  });

  it("derives complexity and needs labels (v1-compatible flat form)", () => {
    expect(complexityLabel("large")).toBe("shopfloor:large");
    expect(complexityLabel("quick")).toBe("shopfloor:quick");
    expect(needsLabelFor("spec")).toBe("shopfloor:needs-spec");
    expect(needsLabelFor("plan")).toBe("shopfloor:needs-plan");
    expect(needsLabelFor("implement")).toBe("shopfloor:needs-impl");
  });
});
