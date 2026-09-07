import { describe, expect, it, vi } from "vitest";
import {
  InngestJobQueue,
  MemoryRuntimeStore,
  PostgresRuntimeStore,
  stageTimeoutMs,
  runStageJob,
  runStageInSandbox,
  type StageJobPayload,
  type E2BSandboxHandle,
} from "../../src/runtime/index.js";

function sampleJob(
  stage: StageJobPayload["stage"],
  extra: Partial<StageJobPayload> = {},
): StageJobPayload {
  return {
    runId: `run_${stage}`,
    deliveryId: "del",
    owner: "o",
    repo: "r",
    stage,
    event: {
      name: "issues",
      payload: {} as StageJobPayload["event"]["payload"],
      deliveryId: "del",
      receivedAt: new Date().toISOString(),
    },
    decision: { stage },
    ...extra,
  };
}

describe("PostgresRuntimeStore (fake sql)", () => {
  it("claims deliveries idempotently and persists runs/audit", async () => {
    const db = {
      deliveries: new Map<string, Record<string, unknown>>(),
      runs: new Map<string, Record<string, unknown>>(),
      audits: [] as Array<Record<string, unknown>>,
    };
    const store = new PostgresRuntimeStore({
      sql: async (strings, ...values) => {
        const text = strings.reduce(
          (acc, s, i) => acc + s + (i < values.length ? `$${i}` : ""),
          "",
        );
        const n = text.replace(/\s+/g, " ").trim().toLowerCase();
        if (n.startsWith("create ")) return [];
        if (n.includes("insert into shopfloor_deliveries")) {
          const id = String(values[0]);
          if (db.deliveries.has(id)) return [];
          db.deliveries.set(id, {
            delivery_id: id,
            event_name: values[1],
            owner: values[2],
            repo: values[3],
            installation_id: values[4],
            received_at: values[5],
            duplicate: false,
          });
          return [{ delivery_id: id }];
        }
        if (n.includes("select * from shopfloor_deliveries")) {
          const row = db.deliveries.get(String(values[0]));
          return row ? [row] : [];
        }
        if (n.includes("insert into shopfloor_runs")) {
          const id = String(values[0]);
          db.runs.set(id, {
            id,
            delivery_id: values[1],
            owner: values[2],
            repo: values[3],
            stage: values[4],
            status: values[5],
            issue_number: values[6],
            created_at: values[7],
            updated_at: values[8],
            error_message: values[9],
            executed: values[10],
            reason: values[11],
          });
          return [];
        }
        if (n.includes("update shopfloor_runs")) {
          const id = String(values[6]);
          const existing = db.runs.get(id);
          if (!existing) return [];
          existing.status = values[0];
          existing.executed = values[1];
          existing.error_message = values[2];
          existing.stage = values[3];
          existing.reason = values[4];
          existing.updated_at = values[5];
          return [];
        }
        if (n.includes("select * from shopfloor_runs where id")) {
          const row = db.runs.get(String(values[0]));
          return row ? [row] : [];
        }
        if (n.includes("from shopfloor_runs") && n.includes("order by")) {
          return Array.from(db.runs.values()).sort((a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)),
          );
        }
        if (n.includes("insert into shopfloor_audit")) {
          db.audits.push({
            run_id: values[0],
            ts: values[1],
            event:
              typeof values[2] === "string"
                ? JSON.parse(String(values[2]))
                : values[2],
          });
          return [];
        }
        if (n.includes("from shopfloor_audit")) {
          return db.audits
            .filter((a) => a.run_id === values[0])
            .map((a, i) => ({ ...a, id: i + 1 }));
        }
        throw new Error(`unhandled: ${n}`);
      },
    });

    expect(
      await store.claimDelivery({
        deliveryId: "d1",
        eventName: "issues",
        owner: "o",
        repo: "r",
        receivedAt: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(
      await store.claimDelivery({
        deliveryId: "d1",
        eventName: "issues",
        owner: "o",
        repo: "r",
        receivedAt: new Date().toISOString(),
      }),
    ).toBe(false);

    const run = await store.createRun({
      id: "run_1",
      deliveryId: "d1",
      owner: "o",
      repo: "r",
      stage: "triage",
    });
    expect(run.status).toBe("queued");

    await store.updateRun("run_1", { status: "succeeded", executed: true });
    const got = await store.getRun("run_1");
    expect(got?.status).toBe("succeeded");
    expect(got?.executed).toBe(true);

    await store.appendAudit("run_1", {
      type: "stage_resolved",
      stage: "triage",
      reason: "test",
    });
    const audit = await store.listAudit("run_1");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event.type).toBe("stage_resolved");

    const listed = await store.listRuns(10);
    expect(listed[0]?.id).toBe("run_1");
  });
});

describe("InngestJobQueue", () => {
  it("sends shopfloor/execute-stage events", async () => {
    const sent: unknown[] = [];
    const queue = new InngestJobQueue({
      send: async (payload) => {
        sent.push(payload);
        return {};
      },
    });
    const job = sampleJob("triage", {
      decision: { stage: "triage", issueNumber: 1 },
    });
    const { jobId } = await queue.enqueueStage(job);
    expect(jobId).toContain(job.runId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "shopfloor/execute-stage",
      data: job,
    });
  });
});

describe("stageTimeoutMs", () => {
  it("matches pipeline budgets", () => {
    expect(stageTimeoutMs("triage")).toBe(5 * 60 * 1000);
    expect(stageTimeoutMs("implement")).toBe(60 * 60 * 1000);
    expect(stageTimeoutMs("review")).toBe(25 * 60 * 1000);
  });
});

describe("runStageJob", () => {
  it("uses workspaceCwd without cloning when provided", async () => {
    const executeFn = vi.fn(async () => ({
      stage: "triage" as const,
      executed: true,
    }));
    const job = sampleJob("triage", { workspaceCwd: "/tmp/ws" });
await runStageJob(job, {
      env: { ANTHROPIC_API_KEY: "sk-test" },
      executeFn,
    });
    expect(executeFn).toHaveBeenCalledOnce();
    const firstCall = executeFn.mock.calls[0] as
      | [{ workspaceCwd?: string }]
      | undefined;
    expect(firstCall?.[0]?.workspaceCwd).toBe("/tmp/ws");
  });
});

describe("runStageInSandbox", () => {
  it("falls back to local when no E2B key", async () => {
    const executeLocal = vi.fn(async () => ({
      stage: "spec" as const,
      executed: true,
    }));
    const result = await runStageInSandbox({
      job: sampleJob("spec", { workspaceCwd: "/tmp" }),
      env: {},
      e2bApiKey: null,
      executeLocal,
    });
    expect(result.mode).toBe("local_fallback");
    expect(executeLocal).toHaveBeenCalledOnce();
  });

  it("runs in-sandbox worker when template has worker bundle", async () => {
    const handle: E2BSandboxHandle = {
      sandboxId: "sbx_1",
      commands: {
        run: vi.fn(async (cmd: string) => {
          if (cmd.includes("test -f")) {
            return { exitCode: 0, stdout: "HAS_WORKER\n", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout:
              '{"type":"shopfloor_worker_result","stage":"triage","executed":true}\n',
            stderr: "",
          };
        }),
      },
      files: { write: vi.fn(async () => undefined) },
      kill: vi.fn(async () => undefined),
    };
    const result = await runStageInSandbox({
      job: sampleJob("triage"),
      e2bApiKey: "e2b_test",
      env: {},
      createSandbox: async () => handle,
    });
    expect(result.mode).toBe("e2b");
    expect(result.result.executed).toBe(true);
    expect(handle.kill).toHaveBeenCalled();
  });
});

describe("MemoryRuntimeStore still works", () => {
  it("round-trips", async () => {
    const store = new MemoryRuntimeStore();
    await store.claimDelivery({
      deliveryId: "x",
      eventName: "ping",
      owner: "",
      repo: "",
      receivedAt: new Date().toISOString(),
    });
    const run = await store.createRun({
      id: "r",
      deliveryId: "x",
      owner: "a",
      repo: "b",
      stage: "none",
    });
    expect(run.id).toBe("r");
  });
});
