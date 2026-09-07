import { getQueueBackend } from "../../../lib/runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    service: "shopfloor-control-plane",
    version: "0.2.0",
    time: new Date().toISOString(),
    runtime: "vercel",
    checks: {
      webhookSecret: Boolean(
        process.env.GITHUB_WEBHOOK_SECRET ??
          process.env.SHOPFLOOR_WEBHOOK_SECRET,
      ),
      githubApp: Boolean(
        process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_PRIVATE_KEY,
      ),
      databaseUrl: Boolean(process.env.DATABASE_URL),
      inngest: Boolean(process.env.INNGEST_EVENT_KEY),
      e2b: Boolean(process.env.E2B_API_KEY),
      workerUrl: Boolean(process.env.SHOPFLOOR_WORKER_URL),
      inlineExecute:
        (process.env.SHOPFLOOR_INLINE_EXECUTE ?? "").toLowerCase() === "true",
      queueBackend: getQueueBackend(),
    },
  });
}
