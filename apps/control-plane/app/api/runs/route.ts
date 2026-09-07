import { getStoreAsync } from "../../../lib/runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const store = await getStoreAsync();
  const runs = await store.listRuns(
    Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
  );
  return Response.json({ runs });
}
