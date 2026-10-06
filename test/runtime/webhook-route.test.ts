import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/inputs.js";
import {
  MemoryJobQueue,
  MemoryRuntimeStore,
  routeGitHubWebhook,
  signGitHubWebhookBody,
  verifyGitHubWebhookSignature,
} from "../../src/runtime/index.js";

const SECRET = "test-webhook-secret";

function routeConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    anthropic_api_key: "sk-test",
    mode: "resolve",
    ...overrides,
  });
}

function issueOpenedBody(opts?: { labels?: string[] }) {
  return JSON.stringify({
    action: "opened",
    issue: {
      number: 42,
      title: "Add feature",
      body: "Please add the feature",
      labels: (opts?.labels ?? []).map((name) => ({ name })),
      state: "open",
    },
    repository: { owner: { login: "octo" }, name: "demo" },
    installation: { id: 99 },
  });
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a valid sha256 signature", () => {
    const body = '{"ok":true}';
    const sig = signGitHubWebhookBody(body, SECRET);
    expect(verifyGitHubWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects tampered bodies and missing signatures", () => {
    const body = '{"ok":true}';
    const sig = signGitHubWebhookBody(body, SECRET);
    expect(verifyGitHubWebhookSignature('{"ok":false}', sig, SECRET)).toBe(
      false,
    );
    expect(verifyGitHubWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, "sha1=abc", SECRET)).toBe(false);
  });
});

describe("routeGitHubWebhook", () => {
  it("returns 401 on bad signature", async () => {
    const body = issueOpenedBody();
    const result = await routeGitHubWebhook({
      rawBody: body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "del-1",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      webhookSecret: SECRET,
      config: routeConfig(),
      store: new MemoryRuntimeStore(),
      queue: new MemoryJobQueue(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("acks ping without enqueue", async () => {
    const body = '{"zen":"design for failure"}';
    const result = await routeGitHubWebhook({
      rawBody: body,
      headers: {
        "x-github-event": "ping",
        "x-github-delivery": "del-ping",
        "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
      },
      webhookSecret: SECRET,
      config: routeConfig(),
      store: new MemoryRuntimeStore(),
      queue: new MemoryJobQueue(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.eventName).toBe("ping");
      expect(result.body.enqueued).toBe(false);
    }
  });

  it("routes a new issue to triage and enqueues a job", async () => {
    const body = issueOpenedBody();
    const queue = new MemoryJobQueue();
    const store = new MemoryRuntimeStore();
    const result = await routeGitHubWebhook({
      rawBody: body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "del-triage",
        "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
      },
      webhookSecret: SECRET,
      config: routeConfig(),
      store,
      queue,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.stage).toBe("triage");
      expect(result.body.enqueued).toBe(true);
      expect(result.body.owner).toBe("octo");
      expect(result.body.repo).toBe("demo");
      expect(result.body.runId).toBeTruthy();
    }
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.stage).toBe("triage");
    const runs = await store.listRuns();
    expect(runs[0]?.status).toBe("queued");
  });

  it("is idempotent on duplicate delivery ids", async () => {
    const body = issueOpenedBody();
    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "del-dup",
      "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
    };
    const store = new MemoryRuntimeStore();
    const queue = new MemoryJobQueue();
    const first = await routeGitHubWebhook({
      rawBody: body,
      headers,
      webhookSecret: SECRET,
      config: routeConfig(),
      store,
      queue,
    });
    const second = await routeGitHubWebhook({
      rawBody: body,
      headers,
      webhookSecret: SECRET,
      config: routeConfig(),
      store,
      queue,
    });
    expect(first.ok && first.body.duplicate).toBe(false);
    expect(second.ok && second.body.duplicate).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  it("respects trigger_label and skips unlabeled issues", async () => {
    const body = issueOpenedBody();
    const queue = new MemoryJobQueue();
    const result = await routeGitHubWebhook({
      rawBody: body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "del-gate",
        "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
      },
      webhookSecret: SECRET,
      config: routeConfig({ trigger_label: "shopfloor" }),
      store: new MemoryRuntimeStore(),
      queue,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.stage).toBe("none");
      expect(result.body.enqueued).toBe(false);
    }
    expect(queue.jobs).toHaveLength(0);
  });

  it("enqueues triage when the trigger label is applied (labeled event)", async () => {
    // When trigger_label is set, issues.opened is deferred so the subsequent
    // issues.labeled delivery owns triage entry (avoids double-fire).
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "shopfloor" },
      issue: {
        number: 42,
        title: "Add feature",
        body: "Please add the feature",
        labels: [{ name: "shopfloor" }],
        state: "open",
      },
      repository: { owner: { login: "octo" }, name: "demo" },
      installation: { id: 99 },
    });
    const queue = new MemoryJobQueue();
    const result = await routeGitHubWebhook({
      rawBody: body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "del-gate-ok",
        "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
      },
      webhookSecret: SECRET,
      config: routeConfig({ trigger_label: "shopfloor" }),
      store: new MemoryRuntimeStore(),
      queue,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.stage).toBe("triage");
      expect(result.body.enqueued).toBe(true);
    }
  });
});
