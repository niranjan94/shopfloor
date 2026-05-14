import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface MintArgs {
  clientId: string;
  privateKey: string;
  owner: string;
  repo: string;
  /** Optional installation id. When omitted and authFactory is provided, a
   *  sentinel value of 0 is used (the mock ignores it). For real callers,
   *  supply this explicitly; resolveInstallationId will throw otherwise. */
  installationId?: number;
  /** Inject for tests */
  authFactory?: (opts: {
    appId: string;
    privateKey: string;
  }) => (req: {
    type: "installation";
    installationId: number;
  }) => Promise<{ token: string; expiresAt: string }>;
  /** Refresh tokens that expire within this margin. Default 5 minutes. */
  expiryMarginMs?: number;
}

type CacheEntry = { token: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export function __resetTokenCache(): void {
  cache.clear();
}

export async function mintInstallationToken(args: MintArgs): Promise<string> {
  const margin = args.expiryMarginMs ?? 5 * 60_000;
  const key = `${args.clientId}|${args.owner}/${args.repo}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt - Date.now() > margin) return cached.token;

  const authFn = args.authFactory
    ? args.authFactory({ appId: args.clientId, privateKey: args.privateKey })
    : createAppAuth({ appId: args.clientId, privateKey: args.privateKey });

  // When authFactory is injected (tests), the mock does not validate
  // installationId, so we fall back to 0 rather than calling the throwing
  // stub. Real callers must supply installationId explicitly until Plan 3
  // wires resolveInstallationId from the Actions event payload.
  const installationId =
    args.installationId ??
    (args.authFactory ? 0 : await resolveInstallationId(args));

  const result = await authFn({ type: "installation", installationId });
  cache.set(key, {
    token: result.token,
    expiresAt: new Date(result.expiresAt).getTime(),
  });
  return result.token;
}

async function resolveInstallationId(args: MintArgs): Promise<number> {
  return discoverInstallationId({
    clientId: args.clientId,
    privateKey: args.privateKey,
    owner: args.owner,
    repo: args.repo,
  });
}

export interface DiscoverInstallationIdArgs {
  clientId: string;
  privateKey: string;
  owner: string;
  repo: string;
}

// Mints a short-lived JWT for the App, then queries the installation that
// covers owner/repo. Called once per process at startup; the resulting id is
// handed to Octokit's auth-app strategy, which keeps refreshing the
// installation token transparently for the lifetime of the run.
export async function discoverInstallationId(
  args: DiscoverInstallationIdArgs,
): Promise<number> {
  const authFn = createAppAuth({
    appId: args.clientId,
    privateKey: args.privateKey,
  });
  const { token: jwt } = await authFn({ type: "app" });
  const probe = new Octokit({ auth: jwt });
  const { data } = await probe.rest.apps.getRepoInstallation({
    owner: args.owner,
    repo: args.repo,
  });
  return data.id;
}

// AuthSpec describes the resolved authentication strategy handed to Octokit.
// `app` lets Octokit's auth-app strategy mint installation tokens on demand
// and refresh them before expiry — required for stages that may outrun the
// one-hour installation token TTL. `token` is a static bearer (a preminted
// installation token or the workflow's GITHUB_TOKEN fallback).
export type AuthSpec =
  | { kind: "token"; token: string; source: "preminted" | "github_token" }
  | {
      kind: "app";
      clientId: string;
      privateKey: string;
      installationId: number;
    };

export interface ResolveAuthInputs {
  preminted?: string | null;
  app?: { clientId: string; privateKey: string } | null;
  fallbackToken?: string | null;
  owner: string;
  repo: string;
}

// Picks the strongest auth available. Order: preminted token, App credentials
// (in-process minting with refresh), GITHUB_TOKEN fallback. Returns null when
// no source is configured; callers decide whether that's fatal.
export async function resolveAuth(
  input: ResolveAuthInputs,
): Promise<AuthSpec | null> {
  if (input.preminted) {
    return { kind: "token", token: input.preminted, source: "preminted" };
  }
  if (input.app) {
    const installationId = await discoverInstallationId({
      clientId: input.app.clientId,
      privateKey: input.app.privateKey,
      owner: input.owner,
      repo: input.repo,
    });
    return {
      kind: "app",
      clientId: input.app.clientId,
      privateKey: input.app.privateKey,
      installationId,
    };
  }
  if (input.fallbackToken) {
    return {
      kind: "token",
      token: input.fallbackToken,
      source: "github_token",
    };
  }
  return null;
}
