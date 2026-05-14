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

async function resolveInstallationId(_args: MintArgs): Promise<number> {
  // The workflow is expected to mint App tokens via
  // actions/create-github-app-token@v3 and pass them in as github_app_token /
  // github_app_review_token. resolveAppToken's "preminted" path is the
  // supported entry; the mint path here remains for tests that inject
  // authFactory + installationId.
  throw new Error(
    "resolveInstallationId: not implemented; mint App tokens via actions/create-github-app-token in the caller workflow and pass them as github_app_token/github_app_review_token inputs",
  );
}

// The action accepts a preminted installation token (produced by
// actions/create-github-app-token in the caller workflow). The mint path is
// kept for tests that inject `authFactory`; production callers always go
// through "preminted".
export type AppTokenInput =
  | { mode: "preminted"; token: string }
  | {
      mode: "mint";
      clientId: string;
      privateKey: string;
      owner: string;
      repo: string;
      installationId?: number;
      authFactory?: MintArgs["authFactory"];
    };

export async function resolveAppToken(input: AppTokenInput): Promise<string> {
  if (input.mode === "preminted") {
    if (!input.token) throw new Error("resolveAppToken: empty preminted token");
    return input.token;
  }
  return mintInstallationToken({
    clientId: input.clientId,
    privateKey: input.privateKey,
    owner: input.owner,
    repo: input.repo,
    ...(input.installationId !== undefined
      ? { installationId: input.installationId }
      : {}),
    ...(input.authFactory !== undefined
      ? { authFactory: input.authFactory }
      : {}),
  });
}
