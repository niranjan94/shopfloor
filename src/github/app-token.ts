import { createAppAuth } from "@octokit/auth-app";

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
  }) => (req: { type: "installation"; installationId: number }) => Promise<{ token: string; expiresAt: string }>;
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
    args.installationId ?? (args.authFactory ? 0 : await resolveInstallationId(args));

  const result = await authFn({ type: "installation", installationId });
  cache.set(key, { token: result.token, expiresAt: new Date(result.expiresAt).getTime() });
  return result.token;
}

async function resolveInstallationId(_args: MintArgs): Promise<number> {
  // Plan 3 wires the entry point and supplies installation id from the
  // GitHub Actions event payload (or actions/create-github-app-token output).
  // Tests inject `authFactory` and pass an explicit `installationId`, so this
  // path is unreachable in Plan 1.
  throw new Error(
    "resolveInstallationId: not implemented in Plan 1 — supply installationId explicitly when wiring entry.ts in Plan 3",
  );
}
