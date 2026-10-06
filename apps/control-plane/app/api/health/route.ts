import { getRuntime } from "../../../lib/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try {
    const runtime = await getRuntime();
    await runtime.pool.query("SELECT id FROM shopfloor_runs LIMIT 0");
    const queue = await runtime.boss.getQueue("shopfloor-stage");
    const ready = Boolean(queue && (process.env.GITHUB_WEBHOOK_SECRET || process.env.SHOPFLOOR_WEBHOOK_SECRET));
    return Response.json({ ok: ready, service: "shopfloor-web", queue: "pg-boss" }, { status: ready ? 200 : 503 });
  } catch {
    return Response.json({ ok: false, error: "Durable runtime unavailable" }, { status: 503 });
  }
}
