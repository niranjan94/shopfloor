import { getStoreAsync } from "../../../../lib/runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const store = await getStoreAsync();
  const run = await store.getRun(id);
  if (!run) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }
  const audit = await store.listAudit(id);
  return Response.json({ run, audit });
}
