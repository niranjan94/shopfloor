import type { AuditEvent } from "../audit/events.js";
import type { Stage } from "../state/labels.js";
import type {
  AuditRow,
  DeliveryRecord,
  RunRecord,
  RunStatus,
  RuntimeStore,
} from "./store.js";

/** Minimal SQL tagged-template surface (Neon serverless `sql` or wrapper). */
export type SqlQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

export interface PostgresRuntimeStoreOptions {
  /** Neon `neon(DATABASE_URL)` or compatible tagged template. */
  sql: SqlQuery;
  /** When false, skip CREATE TABLE on first use (migrations managed externally). */
  autoMigrate?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asStage(value: unknown): Stage | "none" {
  return value as Stage | "none";
}

function asStatus(value: unknown): RunStatus {
  return value as RunStatus;
}

function mapRun(row: Record<string, unknown>): RunRecord {
  const run: RunRecord = {
    id: String(row.id),
    deliveryId: String(row.delivery_id),
    owner: String(row.owner),
    repo: String(row.repo),
    stage: asStage(row.stage),
    status: asStatus(row.status),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    executed: Boolean(row.executed),
  };
  if (row.issue_number !== null && row.issue_number !== undefined) {
    run.issueNumber = Number(row.issue_number);
  }
  if (row.error_message !== null && row.error_message !== undefined) {
    run.errorMessage = String(row.error_message);
  }
  if (row.reason !== null && row.reason !== undefined) {
    run.reason = String(row.reason);
  }
  return run;
}

function mapDelivery(row: Record<string, unknown>): DeliveryRecord {
  const rec: DeliveryRecord = {
    deliveryId: String(row.delivery_id),
    eventName: String(row.event_name),
    owner: String(row.owner ?? ""),
    repo: String(row.repo ?? ""),
    receivedAt:
      row.received_at instanceof Date
        ? row.received_at.toISOString()
        : String(row.received_at),
    duplicate: Boolean(row.duplicate),
  };
  if (row.installation_id !== null && row.installation_id !== undefined) {
    rec.installationId = Number(row.installation_id);
  }
  return rec;
}

/**
 * Durable RuntimeStore backed by Postgres (Neon on Vercel).
 * Uses INSERT … ON CONFLICT for delivery idempotency across isolates.
 */
export class PostgresRuntimeStore implements RuntimeStore {
  private readonly sql: SqlQuery;
  private readonly autoMigrate: boolean;
  private schemaReady: Promise<void> | null = null;

  constructor(opts: PostgresRuntimeStoreOptions) {
    this.sql = opts.sql;
    this.autoMigrate = opts.autoMigrate !== false;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.sql`
          CREATE TABLE IF NOT EXISTS shopfloor_deliveries (
            delivery_id TEXT PRIMARY KEY,
            event_name TEXT NOT NULL,
            owner TEXT NOT NULL DEFAULT '',
            repo TEXT NOT NULL DEFAULT '',
            installation_id INTEGER,
            received_at TIMESTAMPTZ NOT NULL,
            duplicate BOOLEAN NOT NULL DEFAULT FALSE
          )
        `;
        await this.sql`
          CREATE TABLE IF NOT EXISTS shopfloor_runs (
            id TEXT PRIMARY KEY,
            delivery_id TEXT NOT NULL,
            owner TEXT NOT NULL,
            repo TEXT NOT NULL,
            stage TEXT NOT NULL,
            status TEXT NOT NULL,
            issue_number INTEGER,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            error_message TEXT,
            executed BOOLEAN NOT NULL DEFAULT FALSE,
            reason TEXT
          )
        `;
        await this.sql`
          CREATE INDEX IF NOT EXISTS shopfloor_runs_created_at_idx
            ON shopfloor_runs (created_at DESC)
        `;
        await this.sql`
          CREATE TABLE IF NOT EXISTS shopfloor_audit (
            id BIGSERIAL PRIMARY KEY,
            run_id TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            event JSONB NOT NULL
          )
        `;
        await this.sql`
          CREATE INDEX IF NOT EXISTS shopfloor_audit_run_id_idx
            ON shopfloor_audit (run_id)
        `;
      })().catch((err) => {
        this.schemaReady = null;
        throw err;
      });
    }
    await this.schemaReady;
  }

  async claimDelivery(
    record: Omit<DeliveryRecord, "duplicate">,
  ): Promise<boolean> {
    await this.ensureSchema();
    const rows = await this.sql`
      INSERT INTO shopfloor_deliveries (
        delivery_id, event_name, owner, repo, installation_id, received_at, duplicate
      ) VALUES (
        ${record.deliveryId},
        ${record.eventName},
        ${record.owner},
        ${record.repo},
        ${record.installationId ?? null},
        ${record.receivedAt},
        ${false}
      )
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id
    `;
    return rows.length > 0;
  }

  async getDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT * FROM shopfloor_deliveries WHERE delivery_id = ${deliveryId} LIMIT 1
    `;
    const row = rows[0];
    return row ? mapDelivery(row) : null;
  }

  async createRun(
    input: Omit<RunRecord, "createdAt" | "updatedAt" | "status" | "executed"> & {
      status?: RunStatus;
      executed?: boolean;
    },
  ): Promise<RunRecord> {
    await this.ensureSchema();
    const ts = nowIso();
    const id = input.id || newId("run");
    const status = input.status ?? "queued";
    const executed = input.executed ?? false;
    await this.sql`
      INSERT INTO shopfloor_runs (
        id, delivery_id, owner, repo, stage, status, issue_number,
        created_at, updated_at, error_message, executed, reason
      ) VALUES (
        ${id},
        ${input.deliveryId},
        ${input.owner},
        ${input.repo},
        ${input.stage},
        ${status},
        ${input.issueNumber ?? null},
        ${ts},
        ${ts},
        ${input.errorMessage ?? null},
        ${executed},
        ${input.reason ?? null}
      )
    `;
    const run: RunRecord = {
      id,
      deliveryId: input.deliveryId,
      owner: input.owner,
      repo: input.repo,
      stage: input.stage,
      status,
      executed,
      createdAt: ts,
      updatedAt: ts,
    };
    if (input.issueNumber !== undefined) run.issueNumber = input.issueNumber;
    if (input.reason !== undefined) run.reason = input.reason;
    if (input.errorMessage !== undefined) run.errorMessage = input.errorMessage;
    return run;
  }

  async updateRun(
    id: string,
    patch: Partial<
      Pick<RunRecord, "status" | "executed" | "errorMessage" | "stage" | "reason">
    >,
  ): Promise<RunRecord | null> {
    await this.ensureSchema();
    const existing = await this.getRun(id);
    if (!existing) return null;
    const updated: RunRecord = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    await this.sql`
      UPDATE shopfloor_runs SET
        status = ${updated.status},
        executed = ${updated.executed},
        error_message = ${updated.errorMessage ?? null},
        stage = ${updated.stage},
        reason = ${updated.reason ?? null},
        updated_at = ${updated.updatedAt}
      WHERE id = ${id}
    `;
    return updated;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT * FROM shopfloor_runs WHERE id = ${id} LIMIT 1
    `;
    const row = rows[0];
    return row ? mapRun(row) : null;
  }

  async listRuns(limit = 50): Promise<RunRecord[]> {
    await this.ensureSchema();
    const safe = Math.min(Math.max(1, limit), 200);
    const rows = await this.sql`
      SELECT * FROM shopfloor_runs
      ORDER BY created_at DESC
      LIMIT ${safe}
    `;
    return rows.map(mapRun);
  }

  async appendAudit(runId: string, event: AuditEvent): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO shopfloor_audit (run_id, ts, event)
      VALUES (${runId}, ${nowIso()}, ${JSON.stringify(event)})
    `;
  }

  async listAudit(runId: string): Promise<AuditRow[]> {
    await this.ensureSchema();
    const rows = await this.sql`
      SELECT run_id, ts, event FROM shopfloor_audit
      WHERE run_id = ${runId}
      ORDER BY id ASC
    `;
    return rows.map((row) => {
      const eventRaw = row.event;
      const event =
        typeof eventRaw === "string"
          ? (JSON.parse(eventRaw) as AuditEvent)
          : (eventRaw as AuditEvent);
      return {
        runId: String(row.run_id),
        ts:
          row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
        event,
      };
    });
  }
}

/** Create a store from a DATABASE_URL using @neondatabase/serverless when available. */
export async function createPostgresRuntimeStoreFromUrl(
  databaseUrl: string,
  opts?: { autoMigrate?: boolean },
): Promise<PostgresRuntimeStore> {
  const mod = await import("@neondatabase/serverless");
  const sql = mod.neon(databaseUrl) as unknown as SqlQuery;
  return new PostgresRuntimeStore({
    sql,
    ...(opts?.autoMigrate !== undefined ? { autoMigrate: opts.autoMigrate } : {}),
  });
}
