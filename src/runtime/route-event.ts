import { type AuditEmitter, createAuditEmitter } from "../audit/events.js";
import type { Config } from "../config/inputs.js";
import { resolveReviewOnly, resolveStage } from "../state/machine.js";
import type {
  EventPayload,
  PullRequestPayload,
  RouterDecision,
} from "../state/types.js";
import {
  type EventEnvelope,
  extractInstallationId,
  extractRepoFromPayload,
} from "./event-envelope.js";
import type { JobQueue } from "./jobs.js";
import type { RunRecord, RuntimeStore } from "./store.js";
import { readWebhookHeaders, verifyGitHubWebhookSignature } from "./webhook.js";

export interface RouteEventInput {
  rawBody: string | Buffer;
  headers: Headers | Record<string, string | string[] | undefined>;
  webhookSecret: string;
  config: Config;
  store: RuntimeStore;
  queue: JobQueue;
  /** When true, pull_request events use resolveReviewOnly. */
  reviewOnly?: boolean;
  shopfloorBotLogin?: string;
  now?: () => Date;
}

export type RouteEventResult =
  | { ok: true; status: 200; body: RouteEventSuccessBody }
  | { ok: false; status: number; body: { error: string } };

export interface RouteEventSuccessBody {
  duplicate: boolean;
  deliveryId: string;
  eventName: string;
  owner?: string;
  repo?: string;
  stage: RouterDecision["stage"];
  reason?: string;
  runId?: string;
  enqueued: boolean;
  executed: boolean;
}

/**
 * Control-plane webhook handler core:
 * verify signature → claim delivery → resolveStage → enqueue or skip.
 * Does not run agents. Keeps the request short for GitHub webhook ACK.
 */
export async function routeGitHubWebhook(
  input: RouteEventInput,
): Promise<RouteEventResult> {
  const headers = readWebhookHeaders(input.headers);
  if (!headers.eventName) {
    return {
      ok: false,
      status: 400,
      body: { error: "missing X-GitHub-Event" },
    };
  }
  if (!headers.deliveryId) {
    return {
      ok: false,
      status: 400,
      body: { error: "missing X-GitHub-Delivery" },
    };
  }

  const valid = verifyGitHubWebhookSignature(
    input.rawBody,
    headers.signature256,
    input.webhookSecret,
  );
  if (!valid) {
    return {
      ok: false,
      status: 401,
      body: { error: "invalid webhook signature" },
    };
  }

  let payload: Record<string, unknown>;
  try {
    const text =
      typeof input.rawBody === "string"
        ? input.rawBody
        : input.rawBody.toString("utf8");
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, body: { error: "invalid JSON body" } };
  }

  // Ping is accepted without routing.
  if (headers.eventName === "ping") {
    return {
      ok: true,
      status: 200,
      body: {
        duplicate: false,
        deliveryId: headers.deliveryId,
        eventName: "ping",
        stage: "none",
        reason: "ping",
        enqueued: false,
        executed: false,
      },
    };
  }

  const repo = extractRepoFromPayload(payload);
  const installationId =
    extractInstallationId(payload) ??
    (headers.installationId ? Number(headers.installationId) : undefined);
  const receivedAt = (input.now ?? (() => new Date()))().toISOString();

  const claimed = await input.store.claimDelivery({
    deliveryId: headers.deliveryId,
    eventName: headers.eventName,
    owner: repo?.owner ?? "",
    repo: repo?.name ?? "",
    receivedAt,
    ...(installationId !== undefined && Number.isFinite(installationId)
      ? { installationId }
      : {}),
  });

  if (!claimed) {
    return {
      ok: true,
      status: 200,
      body: {
        duplicate: true,
        deliveryId: headers.deliveryId,
        eventName: headers.eventName,
        ...(repo ? { owner: repo.owner, repo: repo.name } : {}),
        stage: "none",
        reason: "duplicate_delivery",
        enqueued: false,
        executed: false,
      },
    };
  }

  if (!repo) {
    return {
      ok: true,
      status: 200,
      body: {
        duplicate: false,
        deliveryId: headers.deliveryId,
        eventName: headers.eventName,
        stage: "none",
        reason: "no_repository_on_payload",
        enqueued: false,
        executed: false,
      },
    };
  }

  const eventPayload = payload as unknown as EventPayload;
  const envelope: EventEnvelope = {
    name: headers.eventName,
    payload: eventPayload,
    deliveryId: headers.deliveryId,
    receivedAt,
    ...(installationId !== undefined && Number.isFinite(installationId)
      ? { installationId }
      : {}),
  };

  const decision = routeDecision({
    eventName: headers.eventName,
    payload: eventPayload,
    config: input.config,
    reviewOnly: input.reviewOnly === true,
    ...(input.shopfloorBotLogin !== undefined
      ? { shopfloorBotLogin: input.shopfloorBotLogin }
      : {}),
  });

  const runId = `run_${headers.deliveryId}`;
  const audit: AuditEmitter = createAuditEmitter({
    runId,
    sink: (line) => {
      // Best-effort structured log; store mirror below.
      console.info(line);
    },
  });

  const storeAudit: AuditEmitter = (event) => {
    audit(event);
    void input.store.appendAudit(runId, event);
  };

  storeAudit({
    type: "stage_resolved",
    stage: decision.stage,
    reason: decision.reason ?? "",
    ...(decision.issueNumber !== undefined
      ? { issueNumber: decision.issueNumber }
      : {}),
    eventName: headers.eventName,
  });

  // advanceOnMerge requires GitHub mutations; enqueue a special execute job
  // with stage still "none" is wrong. Surface as a dedicated run for workers
  // that understand advanceOnMerge via full orchestrator. For MVP we enqueue
  // when stage !== none OR advanceOnMerge is set (worker runs orchestrator).
  const needsWork =
    decision.stage !== "none" || decision.advanceOnMerge !== undefined;

  if (!needsWork) {
    const run = await input.store.createRun({
      id: runId,
      deliveryId: headers.deliveryId,
      owner: repo.owner,
      repo: repo.name,
      stage: decision.stage,
      status: "skipped",
      executed: false,
      ...(decision.issueNumber !== undefined
        ? { issueNumber: decision.issueNumber }
        : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    return {
      ok: true,
      status: 200,
      body: successBody({
        deliveryId: headers.deliveryId,
        eventName: headers.eventName,
        repo,
        decision,
        run,
        enqueued: false,
      }),
    };
  }

  // For advanceOnMerge-only, stage is "none" — worker still needs the event.
  // Represent run stage as the merged stage name when present for ops clarity.
  const runStage =
    decision.stage !== "none"
      ? decision.stage
      : decision.advanceOnMerge
        ? decision.advanceOnMerge.mergedStage
        : "none";

  const run = await input.store.createRun({
    id: runId,
    deliveryId: headers.deliveryId,
    owner: repo.owner,
    repo: repo.name,
    stage: runStage,
    status: "queued",
    executed: false,
    ...(decision.issueNumber !== undefined
      ? { issueNumber: decision.issueNumber }
      : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
  });

  if (decision.stage === "none" && decision.advanceOnMerge) {
    // Worker path uses full orchestrator with mode auto/execute; enqueue with
    // a synthetic stage tag "implement" is wrong. Use LoggingJobQueue payload
    // stage field as the merged stage only for display — execute uses event.
    await input.queue.enqueueStage({
      runId: run.id,
      deliveryId: headers.deliveryId,
      owner: repo.owner,
      repo: repo.name,
      // advanceOnMerge is handled inside runOrchestrator when stage resolves none.
      // Job stage is the merged stage for pool routing (cheap label flip).
      stage: decision.advanceOnMerge.mergedStage,
      event: envelope,
      decision,
    });
  } else if (decision.stage !== "none") {
    await input.queue.enqueueStage({
      runId: run.id,
      deliveryId: headers.deliveryId,
      owner: repo.owner,
      repo: repo.name,
      stage: decision.stage,
      event: envelope,
      decision,
    });
  }

  return {
    ok: true,
    status: 200,
    body: successBody({
      deliveryId: headers.deliveryId,
      eventName: headers.eventName,
      repo,
      decision,
      run,
      enqueued: true,
    }),
  };
}

function routeDecision(args: {
  eventName: string;
  payload: EventPayload;
  config: Config;
  reviewOnly: boolean;
  shopfloorBotLogin?: string;
}): RouterDecision {
  if (args.reviewOnly && args.eventName === "pull_request") {
    return resolveReviewOnly(args.payload as PullRequestPayload);
  }
  const triggerLabel = args.config.triggerLabel ?? undefined;
  return resolveStage({
    eventName: args.eventName,
    payload: args.payload,
    ...(triggerLabel !== undefined ? { triggerLabel } : {}),
    ...(args.shopfloorBotLogin !== undefined
      ? { shopfloorBotLogin: args.shopfloorBotLogin }
      : {}),
  });
}

function successBody(args: {
  deliveryId: string;
  eventName: string;
  repo: { owner: string; name: string };
  decision: RouterDecision;
  run: RunRecord;
  enqueued: boolean;
}): RouteEventSuccessBody {
  return {
    duplicate: false,
    deliveryId: args.deliveryId,
    eventName: args.eventName,
    owner: args.repo.owner,
    repo: args.repo.name,
    stage: args.decision.stage,
    ...(args.decision.reason !== undefined
      ? { reason: args.decision.reason }
      : {}),
    runId: args.run.id,
    enqueued: args.enqueued,
    executed: false,
  };
}
