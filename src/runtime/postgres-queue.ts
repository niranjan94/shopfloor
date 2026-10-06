import { Pool, type PoolClient } from "pg";
import { PgBoss } from "pg-boss";
import type { JobQueue, StageJobPayload } from "./jobs.js";
import { PostgresRuntimeStore, type SqlQuery } from "./postgres-store.js";
import { stageTimeoutMs } from "./run-stage-job.js";
import type { RuntimeStore } from "./store.js";

export const STAGE_QUEUE = "shopfloor-stage";
export const DEAD_QUEUE = "shopfloor-stage-dead";

export function sqlFor(client: Pick<Pool, "query"> | PoolClient): SqlQuery {
  return async (strings, ...values) => {
    const text = strings.reduce((sql, part, i) => sql + part + (i < values.length ? `$${i + 1}` : ""), "");
    return (await client.query(text, values)).rows;
  };
}

export function serializationKey(job: StageJobPayload): string {
  const payload = job.event.payload as unknown as { pull_request?: { number: number }; issue?: { number: number } };
  const issue = job.decision.issueNumber ?? payload.issue?.number;
  return `${job.owner.toLowerCase()}/${job.repo.toLowerCase()}/${issue !== undefined ? `issue:${issue}` : `pr:${payload.pull_request?.number ?? "repository"}`}`;
}

export class PostgresJobQueue implements JobQueue {
  constructor(private readonly boss: PgBoss, private readonly client?: PoolClient) {}
  async enqueueStage(job: StageJobPayload): Promise<{ jobId: string }> {
    const jobId = await this.boss.send(STAGE_QUEUE, job, {
      singletonKey: serializationKey(job),
      expireInSeconds: Math.ceil(stageTimeoutMs(job.stage) / 1000) + 120,
      heartbeatSeconds: 60,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      ...(this.client ? { db: { executeSql: (text: string, values?: unknown[]) => this.client!.query(text, values) } } : {}),
    });
    if (!jobId) throw new Error("Durable enqueue did not create a job");
    return { jobId };
  }
}

export type RouteTransaction = <T>(fn: (store: RuntimeStore, queue: JobQueue) => Promise<T>) => Promise<T>;

export async function openPostgresRuntime(databaseUrl: string, migrate = false) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  pool.on("error", () => console.error("Postgres connection error"));
  const boss = new PgBoss({ connectionString: databaseUrl, migrate, supervise: true, schedule: false });
  boss.on("error", () => console.error("Durable queue error"));
  try {
    await boss.start();
    if (migrate) {
      await boss.createQueue(DEAD_QUEUE);
      await boss.createQueue(STAGE_QUEUE, { policy: "singleton", deadLetter: DEAD_QUEUE });
    }
    await pool.query("SELECT id FROM shopfloor_runs LIMIT 0");
    if (!(await boss.getQueue(STAGE_QUEUE))) throw new Error("Run database migrations before starting services");
  } catch (err) {
    await boss.stop();
    await pool.end();
    throw err;
  }
  const store = new PostgresRuntimeStore({ sql: sqlFor(pool), autoMigrate: false });
  const queue = new PostgresJobQueue(boss);
  const transaction: RouteTransaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PostgresRuntimeStore({ sql: sqlFor(client), autoMigrate: false }), new PostgresJobQueue(boss, client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  };
  return { pool, boss, store, queue, transaction, close: async () => { await boss.stop(); await pool.end(); } };
}
