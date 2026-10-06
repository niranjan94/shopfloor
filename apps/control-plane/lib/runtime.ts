import { openPostgresRuntime } from "../../../src/runtime/postgres-queue";

let runtimePromise: ReturnType<typeof openPostgresRuntime> | null = null;
export function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = openPostgresRuntime(process.env.DATABASE_URL ?? "").catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}
export async function getStoreAsync() { return (await getRuntime()).store; }
export function getQueueBackend() { return "pg-boss" as const; }
