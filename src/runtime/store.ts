import type { AuditEvent } from "../audit/events.js";
import type { Stage } from "../state/labels.js";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface DeliveryRecord {
  deliveryId: string;
  eventName: string;
  owner: string;
  repo: string;
  installationId?: number;
  receivedAt: string;
  /** true when this delivery was already processed (idempotent replay). */
  duplicate: boolean;
}

export interface RunRecord {
  id: string;
  deliveryId: string;
  owner: string;
  repo: string;
  stage: Stage | "none";
  status: RunStatus;
  issueNumber?: number;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  executed: boolean;
  reason?: string;
}

export interface AuditRow {
  runId: string;
  ts: string;
  event: AuditEvent;
}

export interface RuntimeStore {
  /** Returns true if this delivery is new; false if already seen. */
  claimDelivery(record: Omit<DeliveryRecord, "duplicate">): Promise<boolean>;
  getDelivery(deliveryId: string): Promise<DeliveryRecord | null>;
  createRun(
    input: Omit<
      RunRecord,
      "createdAt" | "updatedAt" | "status" | "executed"
    > & {
      status?: RunStatus;
      executed?: boolean;
    },
  ): Promise<RunRecord>;
  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRecord,
        "status" | "executed" | "errorMessage" | "stage" | "reason"
      >
    >,
  ): Promise<RunRecord | null>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit?: number): Promise<RunRecord[]>;
  appendAudit(runId: string, event: AuditEvent): Promise<void>;
  listAudit(runId: string): Promise<AuditRow[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Process-local store for tests and single-node dev.
 * Production Vercel path should swap in Postgres (Neon) backed store.
 */
export class MemoryRuntimeStore implements RuntimeStore {
  private deliveries = new Map<string, DeliveryRecord>();
  private runs = new Map<string, RunRecord>();
  private audits = new Map<string, AuditRow[]>();

  async claimDelivery(
    record: Omit<DeliveryRecord, "duplicate">,
  ): Promise<boolean> {
    if (this.deliveries.has(record.deliveryId)) return false;
    this.deliveries.set(record.deliveryId, { ...record, duplicate: false });
    return true;
  }

  async getDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    return this.deliveries.get(deliveryId) ?? null;
  }

  async createRun(
    input: Omit<
      RunRecord,
      "createdAt" | "updatedAt" | "status" | "executed"
    > & {
      status?: RunStatus;
      executed?: boolean;
    },
  ): Promise<RunRecord> {
    const ts = nowIso();
    const run: RunRecord = {
      id: input.id || newId("run"),
      deliveryId: input.deliveryId,
      owner: input.owner,
      repo: input.repo,
      stage: input.stage,
      status: input.status ?? "queued",
      executed: input.executed ?? false,
      createdAt: ts,
      updatedAt: ts,
      ...(input.issueNumber !== undefined
        ? { issueNumber: input.issueNumber }
        : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.errorMessage !== undefined
        ? { errorMessage: input.errorMessage }
        : {}),
    };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRecord,
        "status" | "executed" | "errorMessage" | "stage" | "reason"
      >
    >,
  ): Promise<RunRecord | null> {
    const existing = this.runs.get(id);
    if (!existing) return null;
    const updated: RunRecord = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    this.runs.set(id, updated);
    return updated;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(limit = 50): Promise<RunRecord[]> {
    return Array.from(this.runs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async appendAudit(runId: string, event: AuditEvent): Promise<void> {
    const row: AuditRow = { runId, ts: nowIso(), event };
    const list = this.audits.get(runId) ?? [];
    list.push(row);
    this.audits.set(runId, list);
  }

  async listAudit(runId: string): Promise<AuditRow[]> {
    return this.audits.get(runId) ?? [];
  }
}

/** Singleton memory store for the Node process (dev / tests). */
let defaultStore: MemoryRuntimeStore | null = null;

export function getDefaultMemoryStore(): MemoryRuntimeStore {
  if (!defaultStore) defaultStore = new MemoryRuntimeStore();
  return defaultStore;
}

export function __resetDefaultMemoryStore(): void {
  defaultStore = new MemoryRuntimeStore();
}
