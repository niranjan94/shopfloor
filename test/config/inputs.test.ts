import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/inputs.js";

const baseInputs: Record<string, string> = {
  anthropic_api_key: "sk-test",
  github_app_client_id: "Iv23test",
  github_app_private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
  trigger_label: "shopfloor",
  max_review_iterations: "3",
  triage_model: "claude-sonnet-4-6",
  spec_model: "claude-opus-4-7[1m]",
  plan_model: "claude-opus-4-7[1m]",
  impl_model: "claude-opus-4-7[1m]",
  review_compliance_model: "claude-opus-4-7[1m]",
  review_bugs_model: "claude-opus-4-7[1m]",
  review_security_model: "claude-opus-4-7[1m]",
  review_smells_model: "claude-opus-4-7[1m]",
  triage_max_budget_usd: "0.25",
  impl_max_budget_usd: "2.50",
  triage_timeout_ms: "120000",
};

describe("parseConfig", () => {
  it("parses valid inputs", () => {
    const cfg = parseConfig(baseInputs);
    expect(cfg.triageModel).toBe("claude-sonnet-4-6");
    expect(cfg.maxReviewIterations).toBe(3);
    expect(cfg.implMaxBudgetUsd).toBe(2.5);
  });

  it("fills provider-aware model defaults when models are unset (claude)", () => {
    const {
      triage_model: _t,
      spec_model: _s,
      plan_model: _p,
      impl_model: _i,
      review_compliance_model: _rc,
      review_bugs_model: _rb,
      review_security_model: _rs,
      review_smells_model: _rsm,
      ...rest
    } = baseInputs;
    const cfg = parseConfig(rest);
    expect(cfg.triageModel).toBe("claude-sonnet-4-6");
    expect(cfg.specModel).toBe("claude-opus-4-8[1m]");
    expect(cfg.implModel).toBe("claude-opus-4-8[1m]");
    expect(cfg.reviewModels.security).toBe("claude-opus-4-8[1m]");
  });

  it("fills gpt-5.5 model defaults when provider is codex and models are unset", () => {
    const {
      anthropic_api_key: _a,
      triage_model: _t,
      spec_model: _s,
      plan_model: _p,
      impl_model: _i,
      review_compliance_model: _rc,
      review_bugs_model: _rb,
      review_security_model: _rs,
      review_smells_model: _rsm,
      ...rest
    } = baseInputs;
    const cfg = parseConfig({ ...rest, agent_provider: "codex" });
    expect(cfg.triageModel).toBe("gpt-5.5");
    expect(cfg.implModel).toBe("gpt-5.5");
    expect(cfg.reviewModels.compliance).toBe("gpt-5.5");
  });

  it("lets an explicit model input override the provider default", () => {
    const cfg = parseConfig({
      ...baseInputs,
      agent_provider: "codex",
      impl_model: "gpt-5.5-pro",
    });
    expect(cfg.implModel).toBe("gpt-5.5-pro");
  });

  it("rejects missing required inputs", () => {
    const { anthropic_api_key: _omitted, ...rest } = baseInputs;
    expect(() =>
      parseConfig({ ...rest, claude_code_oauth_token: "" }),
    ).toThrow();
  });

  it("accepts claude_code_oauth_token as an alternative to anthropic_api_key", () => {
    const { anthropic_api_key: _omitted, ...rest } = baseInputs;
    expect(() =>
      parseConfig({ ...rest, claude_code_oauth_token: "oauth-tok" }),
    ).not.toThrow();
  });

  it("rejects non-numeric budget values", () => {
    expect(() =>
      parseConfig({ ...baseInputs, impl_max_budget_usd: "lots" }),
    ).toThrow();
  });

  it("defaults mode to auto and stages to empty list", () => {
    const cfg = parseConfig(baseInputs);
    expect(cfg.mode).toBe("auto");
    expect(cfg.stages).toEqual([]);
  });

  it("parses mode=resolve and mode=execute", () => {
    expect(parseConfig({ ...baseInputs, mode: "resolve" }).mode).toBe(
      "resolve",
    );
    expect(parseConfig({ ...baseInputs, mode: "execute" }).mode).toBe(
      "execute",
    );
  });

  it("rejects an unknown mode value", () => {
    expect(() => parseConfig({ ...baseInputs, mode: "wat" })).toThrow();
  });

  it("parses a comma-separated stages list, trimming whitespace", () => {
    const cfg = parseConfig({
      ...baseInputs,
      stages: "triage, implement ,review",
    });
    expect(cfg.stages).toEqual(["triage", "implement", "review"]);
  });

  it("rejects an unknown stage name in stages", () => {
    expect(() =>
      parseConfig({ ...baseInputs, stages: "triage,nonsense" }),
    ).toThrow();
  });
});
