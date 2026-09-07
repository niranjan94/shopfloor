import { type Config, parseConfig } from "../config/inputs.js";

/**
 * Map Vercel / self-host environment variables onto the same string-keyed
 * surface parseConfig already understands from action.yml inputs.
 *
 * Preferred names use SHOPFLOOR_ / GITHUB_APP_ prefixes. Bare action-style
 * names (anthropic_api_key) are also accepted for parity with local .env files.
 */
const ENV_TO_INPUT: Array<{ env: string; input: string }> = [
  { env: "ANTHROPIC_API_KEY", input: "anthropic_api_key" },
  { env: "CLAUDE_CODE_OAUTH_TOKEN", input: "claude_code_oauth_token" },
  { env: "SHOPFLOOR_AGENT_PROVIDER", input: "agent_provider" },
  { env: "OPENAI_API_KEY", input: "openai_api_key" },
  { env: "CODEX_AUTH_JSON", input: "codex_auth_json" },
  { env: "GITHUB_APP_CLIENT_ID", input: "github_app_client_id" },
  { env: "GITHUB_APP_PRIVATE_KEY", input: "github_app_private_key" },
  {
    env: "GITHUB_APP_REVIEW_CLIENT_ID",
    input: "github_app_review_client_id",
  },
  {
    env: "GITHUB_APP_REVIEW_PRIVATE_KEY",
    input: "github_app_review_private_key",
  },
  { env: "SHOPFLOOR_GITHUB_APP_TOKEN", input: "github_app_token" },
  {
    env: "SHOPFLOOR_GITHUB_APP_REVIEW_TOKEN",
    input: "github_app_review_token",
  },
  { env: "SSH_SIGNING_KEY", input: "ssh_signing_key" },
  { env: "SHOPFLOOR_TRIGGER_LABEL", input: "trigger_label" },
  {
    env: "SHOPFLOOR_MAX_REVIEW_ITERATIONS",
    input: "max_review_iterations",
  },
  { env: "SHOPFLOOR_TRIAGE_MODEL", input: "triage_model" },
  { env: "SHOPFLOOR_SPEC_MODEL", input: "spec_model" },
  { env: "SHOPFLOOR_PLAN_MODEL", input: "plan_model" },
  { env: "SHOPFLOOR_IMPL_MODEL", input: "impl_model" },
  {
    env: "SHOPFLOOR_REVIEW_COMPLIANCE_MODEL",
    input: "review_compliance_model",
  },
  { env: "SHOPFLOOR_REVIEW_BUGS_MODEL", input: "review_bugs_model" },
  {
    env: "SHOPFLOOR_REVIEW_SECURITY_MODEL",
    input: "review_security_model",
  },
  { env: "SHOPFLOOR_REVIEW_SMELLS_MODEL", input: "review_smells_model" },
  { env: "SHOPFLOOR_MODE", input: "mode" },
  { env: "SHOPFLOOR_STAGES", input: "stages" },
];

export interface ControlPlaneEnv {
  webhookSecret: string;
  databaseUrl: string | null;
  redisUrl: string | null;
  inngestEventKey: string | null;
  inngestSigningKey: string | null;
  e2bApiKey: string | null;
  /** When true, execute stages inline (dev only — not for production implement). */
  inlineExecute: boolean;
  publicBaseUrl: string | null;
}

export function readControlPlaneEnv(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneEnv {
  const webhookSecret =
    env.GITHUB_WEBHOOK_SECRET ?? env.SHOPFLOOR_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) {
    throw new Error(
      "GITHUB_WEBHOOK_SECRET (or SHOPFLOOR_WEBHOOK_SECRET) is required",
    );
  }
  return {
    webhookSecret,
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.UPSTASH_REDIS_REST_URL
      ? env.UPSTASH_REDIS_REST_URL
      : (env.REDIS_URL ?? null),
    inngestEventKey: env.INNGEST_EVENT_KEY ?? null,
    inngestSigningKey: env.INNGEST_SIGNING_KEY ?? null,
    e2bApiKey: env.E2B_API_KEY ?? null,
    inlineExecute:
      (env.SHOPFLOOR_INLINE_EXECUTE ?? "").toLowerCase() === "true",
    publicBaseUrl: (() => {
      if (env.SHOPFLOOR_PUBLIC_BASE_URL) return env.SHOPFLOOR_PUBLIC_BASE_URL;
      if (!env.VERCEL_URL) return null;
      return env.VERCEL_URL.startsWith("http")
        ? env.VERCEL_URL
        : `https://${env.VERCEL_URL}`;
    })(),
  };
}

/** Build action-style raw inputs from env, skipping empty values so Zod defaults apply. */
export function rawInputsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { env: envKey, input } of ENV_TO_INPUT) {
    const v = env[envKey];
    if (v) out[input] = v;
  }
  // Also accept bare action input names for local .env convenience.
  for (const { input } of ENV_TO_INPUT) {
    if (out[input]) continue;
    const bare = env[input];
    if (bare) out[input] = bare;
  }
  // Normalize PEM newlines if someone pasted with literal \n sequences.
  for (const key of [
    "github_app_private_key",
    "github_app_review_private_key",
    "ssh_signing_key",
  ] as const) {
    const v = out[key];
    if (v?.includes("\\n")) out[key] = v.replace(/\\n/g, "\n");
  }
  return out;
}

export function parseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): Config {
  return parseConfig({ ...rawInputsFromEnv(env), ...overrides });
}

/**
 * Route-only config: agent credentials are not required because resolve mode
 * never invokes an agent. Used by the Vercel webhook path.
 */
export function parseRouteConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const raw = rawInputsFromEnv(env);
  // Satisfy Claude-provider refine without forcing operators to set a key on
  // the control plane solely for routing. Execute workers still require real keys.
  if (!raw.anthropic_api_key && !raw.claude_code_oauth_token) {
    if (raw.agent_provider === "codex") {
      if (!raw.openai_api_key && !raw.codex_auth_json) {
        raw.openai_api_key = "route-only-placeholder";
      }
    } else {
      raw.anthropic_api_key = "route-only-placeholder";
    }
  }
  raw.mode = "resolve";
  return parseConfig(raw);
}
