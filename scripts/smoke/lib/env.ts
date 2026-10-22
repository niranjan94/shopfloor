import { config as loadDotenv } from "dotenv";
import type { AppLogins } from "./types.js";

export interface ResolvedEnv {
  token: string;
  appLogins: AppLogins;
}

interface RawEnv {
  SHOPFLOOR_SMOKE_GH_TOKEN?: string | undefined;
  SHOPFLOOR_PRIMARY_APP_LOGIN?: string | undefined;
  SHOPFLOOR_REVIEW_APP_LOGIN?: string | undefined;
}

export function resolveEnv(env: RawEnv): ResolvedEnv {
  const token = env.SHOPFLOOR_SMOKE_GH_TOKEN;
  const primary = env.SHOPFLOOR_PRIMARY_APP_LOGIN;
  const review = env.SHOPFLOOR_REVIEW_APP_LOGIN;

  if (!token) {
    throw new Error(
      "SHOPFLOOR_SMOKE_GH_TOKEN is required. See .env.example for the required scopes.",
    );
  }
  if (!primary) {
    throw new Error(
      "SHOPFLOOR_PRIMARY_APP_LOGIN is required (e.g. 'shopfloor[bot]').",
    );
  }
  if (!review) {
    throw new Error(
      "SHOPFLOOR_REVIEW_APP_LOGIN is required (e.g. 'shopfloor-reviewer[bot]').",
    );
  }
  return { token, appLogins: { primary, review } };
}

export function loadAndResolveEnv(): ResolvedEnv {
  loadDotenv();
  return resolveEnv(process.env);
}
