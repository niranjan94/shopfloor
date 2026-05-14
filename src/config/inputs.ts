import { z } from "zod";

const num = (min = 0) =>
  z.string().transform((s, ctx) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < min) {
      ctx.addIssue({
        code: "custom",
        message: `expected number >= ${min}, got ${s}`,
      });
      return z.NEVER;
    }
    return n;
  });

const STAGE_NAMES = ["triage", "spec", "plan", "implement", "review"] as const;
type StageName = (typeof STAGE_NAMES)[number];

function parseStagesList(raw: string): StageName[] {
  if (!raw.trim()) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!(STAGE_NAMES as readonly string[]).includes(p)) {
      throw new Error(
        `invalid stage name in stages: ${p} (valid: ${STAGE_NAMES.join(", ")})`,
      );
    }
  }
  return parts as StageName[];
}

const RawInputs = z
  .object({
    anthropic_api_key: z.string().optional().default(""),
    claude_code_oauth_token: z.string().optional().default(""),
    github_app_client_id: z.string().optional().default(""),
    github_app_private_key: z.string().optional().default(""),
    github_app_review_client_id: z.string().optional().default(""),
    github_app_review_private_key: z.string().optional().default(""),
    ssh_signing_key: z.string().optional().default(""),
    trigger_label: z.string().default(""),
    max_review_iterations: num(1).default("3"),
    triage_model: z.string().default("claude-haiku"),
    spec_model: z.string().default("claude-opus"),
    plan_model: z.string().default("claude-opus"),
    impl_model: z.string().default("claude-opus"),
    review_compliance_model: z.string().default("claude-opus"),
    review_bugs_model: z.string().default("claude-opus"),
    review_security_model: z.string().default("claude-opus"),
    review_smells_model: z.string().default("claude-opus"),
    triage_max_budget_usd: num(0).default("0.25"),
    spec_max_budget_usd: num(0).default("1.50"),
    plan_max_budget_usd: num(0).default("1.50"),
    impl_max_budget_usd: num(0).default("2.50"),
    review_max_budget_usd_per_lens: num(0).default("0.75"),
    triage_timeout_ms: num(1000).default("300000"),
    spec_timeout_ms: num(1000).default("1200000"),
    plan_timeout_ms: num(1000).default("1200000"),
    impl_timeout_ms: num(1000).default("3600000"),
    review_timeout_ms_per_lens: num(1000).default("900000"),
    mode: z.enum(["auto", "resolve", "execute"]).default("auto"),
    stages: z.string().default(""),
  })
  .refine((v) => v.anthropic_api_key || v.claude_code_oauth_token, {
    message: "one of anthropic_api_key or claude_code_oauth_token is required",
  });

export type Config = ReturnType<typeof parseConfig>;

export function parseConfig(raw: Record<string, string | undefined>) {
  const cleaned = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v ?? ""]),
  );
  const parsed = RawInputs.parse(cleaned);
  return {
    anthropicApiKey: parsed.anthropic_api_key,
    claudeCodeOAuthToken: parsed.claude_code_oauth_token,
    githubApp:
      parsed.github_app_client_id &&
      parsed.github_app_private_key
        ? {
            clientId: parsed.github_app_client_id,
            privateKey: parsed.github_app_private_key,
          }
        : null,
    reviewGithubApp: parsed.github_app_review_client_id
      ? {
          clientId: parsed.github_app_review_client_id,
          privateKey: parsed.github_app_review_private_key,
        }
      : null,
    sshSigningKey: parsed.ssh_signing_key || null,
    triggerLabel: parsed.trigger_label || null,
    maxReviewIterations: parsed.max_review_iterations,
    triageModel: parsed.triage_model,
    specModel: parsed.spec_model,
    planModel: parsed.plan_model,
    implModel: parsed.impl_model,
    reviewModels: {
      compliance: parsed.review_compliance_model,
      bugs: parsed.review_bugs_model,
      security: parsed.review_security_model,
      smells: parsed.review_smells_model,
    },
    triageMaxBudgetUsd: parsed.triage_max_budget_usd,
    specMaxBudgetUsd: parsed.spec_max_budget_usd,
    planMaxBudgetUsd: parsed.plan_max_budget_usd,
    implMaxBudgetUsd: parsed.impl_max_budget_usd,
    reviewMaxBudgetUsdPerLens: parsed.review_max_budget_usd_per_lens,
    triageTimeoutMs: parsed.triage_timeout_ms,
    specTimeoutMs: parsed.spec_timeout_ms,
    planTimeoutMs: parsed.plan_timeout_ms,
    implTimeoutMs: parsed.impl_timeout_ms,
    reviewTimeoutMsPerLens: parsed.review_timeout_ms_per_lens,
    mode: parsed.mode,
    stages: parseStagesList(parsed.stages),
  } as const;
}
