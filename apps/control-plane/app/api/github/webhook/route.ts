import {
  type Config,
  parseRouteConfigFromEnv,
  routeGitHubWebhook,
} from "../../../../lib/shopfloor";
import { getQueue, getStoreAsync } from "../../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const webhookSecret =
    process.env.GITHUB_WEBHOOK_SECRET ??
    process.env.SHOPFLOOR_WEBHOOK_SECRET ??
    "";
  if (!webhookSecret) {
    return Response.json(
      { error: "GITHUB_WEBHOOK_SECRET is not configured" },
      { status: 500 },
    );
  }

  const rawBody = await request.text();

  let config: Config;
  try {
    config = parseRouteConfigFromEnv(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `invalid shopfloor config: ${message}` },
      { status: 500 },
    );
  }

  const store = await getStoreAsync();
  const result = await routeGitHubWebhook({
    rawBody,
    headers: request.headers,
    webhookSecret,
    config,
    store,
    queue: getQueue(),
    reviewOnly: (process.env.SHOPFLOOR_REVIEW_ONLY ?? "") === "true",
  });

  return Response.json(result.body, { status: result.status });
}

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    endpoint: "github-webhook",
    hint: "POST GitHub App webhook events here",
  });
}
