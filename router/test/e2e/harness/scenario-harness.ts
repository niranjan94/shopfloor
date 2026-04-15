import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import * as tmp from "tmp";
import { vi } from "vitest";
import { getOctokit } from "@actions/github";
import { main } from "../../../src/index";
import { runBootstrapLabels } from "../../../src/helpers/bootstrap-labels";
import { GitHubAdapter } from "../../../src/github";
import type { OctokitLike } from "../../../src/types";
import { FakeGitHub } from "../fake-github";
import { snapshotEnv, resetCoreState } from "./env";
import { parseGithubOutput } from "./parse-output";
import {
  AgentStub,
  type NonReviewStage,
  type AgentResponse,
  type ReviewAgentBundle,
} from "./agent-stub";
import {
  jobGraph,
  type GraphStep,
  type InputMap,
  type StageContext,
  type StageKey,
} from "./job-graph";
import type { GitHubEvent } from "./fixtures";

const PRIMARY_TOKEN = "primary-token";
const REVIEW_TOKEN = "review-token";

/**
 * The ScenarioHarness is the single entry point scenario tests use to
 * drive the router through a full stage. It owns four pieces of state
 * that must be kept in lock-step for the in-process e2e layer to work:
 *
 * 1. A FakeGitHub instance that backs every Octokit read/write.
 * 2. A workspace temp dir used for GITHUB_OUTPUT, GITHUB_EVENT_PATH,
 *    rendered context JSON artifacts, and RUNNER_TEMP.
 * 3. A queued AgentStub that replaces claude-code-action output.
 * 4. The most recent event payload, which every helper invocation
 *    needs via GITHUB_EVENT_PATH.
 *
 * deliverEvent() runs the route helper and stashes its outputs; those
 * outputs feed all downstream runStage() calls via the job graph.
 */
export class ScenarioHarness {
  readonly fake: FakeGitHub;
  readonly workspaceDir: string;
  private readonly tmpHandle: tmp.DirResult;
  private readonly stub = new AgentStub();
  private currentEvent: GitHubEvent | null = null;
  private routeOutputs: Record<string, string> = {};
  private seq = 0;

  constructor(opts: { fake: FakeGitHub; workspaceDir?: string }) {
    this.fake = opts.fake;
    if (opts.workspaceDir) {
      this.workspaceDir = opts.workspaceDir;
      this.tmpHandle = {
        name: opts.workspaceDir,
        removeCallback: () => {},
      } as never;
    } else {
      this.tmpHandle = tmp.dirSync({ unsafeCleanup: true });
      this.workspaceDir = this.tmpHandle.name;
    }
    registerFake(this.fake);
  }

  async bootstrap(): Promise<void> {
    const adapter = new GitHubAdapter(
      this.fake.asOctokit(this.fake.primaryIdentity) as unknown as OctokitLike,
      { owner: this.fake.owner, repo: this.fake.repo },
    );
    await runBootstrapLabels(adapter);
  }

  /**
   * Deliver a GitHub webhook payload, run the route helper against it,
   * and stash the route outputs for downstream stage invocations. The
   * `extraInputs` bag lets scenarios pass workflow-level inputs like
   * trigger_label that the router reads off INPUT_* env vars.
   */
  async deliverEvent(
    event: GitHubEvent,
    extraInputs: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    this.currentEvent = event;
    const outputs = await this.invokeHelper("route", extraInputs);
    this.routeOutputs = outputs;
    return outputs;
  }

  async runStage(stage: StageKey | "implement"): Promise<void> {
    const key: StageKey =
      stage === "implement"
        ? this.routeOutputs.revision_mode === "true"
          ? "implement-revision"
          : "implement-first-run"
        : stage;
    const steps = jobGraph[key];
    if (!steps || steps.length === 0) {
      throw new Error(`runStage: no graph for '${key}'`);
    }
    const previous: Record<string, Record<string, string>> = {};
    for (let idx = 0; idx < steps.length; idx++) {
      try {
        await this.runStep(steps[idx], previous);
      } catch (err) {
        throw new ScenarioStepError(key, idx, steps[idx], err, this.fake);
      }
    }
  }

  private async runStep(
    step: GraphStep,
    previous: Record<string, Record<string, string>>,
  ): Promise<void> {
    if (step.kind === "if") {
      const ctx = this.makeStageContext(previous);
      if (step.when(ctx)) {
        for (const inner of step.then) await this.runStep(inner, previous);
      }
      return;
    }
    if (step.kind === "context") {
      const ctx = this.makeStageContext(previous);
      const artifact = step.build(ctx);
      const file = join(this.workspaceDir, `${step.id}.json`);
      writeFileSync(file, JSON.stringify(artifact.json));
      previous[step.id] = { path: file };
      return;
    }
    if (step.kind === "agent") {
      if (step.stage === "review") {
        const bundle = this.stub.consumeReview();
        previous.agent_review = serializeReviewBundle(bundle);
      } else {
        const response = this.stub.consume(step.stage as NonReviewStage);
        previous.agent = { ...response };
      }
      return;
    }
    const inputs = this.resolveInputs(step.from, previous);
    const outputs = await this.invokeHelper(step.helper, inputs);
    if (step.id) previous[step.id] = outputs;
    previous[step.helper] = outputs;
  }

  private resolveInputs(
    map: InputMap,
    previous: Record<string, Record<string, string>>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const ctx = this.makeStageContext(previous);
    for (const [k, src] of Object.entries(map)) {
      switch (src.source) {
        case "literal":
          out[k] = src.value;
          break;
        case "route":
          out[k] = this.routeOutputs[src.key] ?? "";
          break;
        case "agent":
          out[k] = previous.agent?.[src.key] ?? "";
          break;
        case "agent-role":
          out[k] = previous.agent_review?.[src.role] ?? "";
          break;
        case "previous":
          out[k] = previous[src.helper]?.[src.key] ?? "";
          break;
        case "fake":
          out[k] = src.resolve(ctx);
          break;
      }
    }
    return out;
  }

  private makeStageContext(
    previous: Record<string, Record<string, string>>,
  ): StageContext {
    return {
      fake: this.fake,
      routeOutputs: this.routeOutputs,
      previous,
      workspaceDir: this.workspaceDir,
      currentEvent: this.currentEvent,
    };
  }

  async invokeHelper(
    helper: string,
    inputs: Record<string, string>,
  ): Promise<Record<string, string>> {
    if (!this.currentEvent) {
      throw new Error(
        "invokeHelper: no event delivered yet -- call deliverEvent first",
      );
    }
    const restoreEnv = snapshotEnv();
    const seq = ++this.seq;
    const eventFile = join(this.workspaceDir, `event-${seq}.json`);
    const outputFile = join(this.workspaceDir, `output-${seq}.txt`);
    writeFileSync(eventFile, JSON.stringify(this.currentEvent.payload));
    writeFileSync(outputFile, "");
    // Scrub any INPUT_* carried over from a prior helper invocation
    // before we stamp in the new ones. snapshotEnv will restore them
    // when we're done, but we must not let e.g. INPUT_STAGE from a
    // precheck step leak into a downstream helper that does not set it.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("INPUT_")) delete process.env[k];
    }
    process.env.INPUT_HELPER = helper;
    process.env.INPUT_GITHUB_TOKEN = PRIMARY_TOKEN;
    if (helper === "aggregate-review") {
      process.env.INPUT_REVIEW_GITHUB_TOKEN = REVIEW_TOKEN;
    }
    for (const [k, v] of Object.entries(inputs)) {
      process.env[`INPUT_${k.toUpperCase()}`] = v;
    }
    process.env.GITHUB_EVENT_PATH = eventFile;
    process.env.GITHUB_EVENT_NAME = this.currentEvent.eventName;
    process.env.GITHUB_OUTPUT = outputFile;
    process.env.GITHUB_REPOSITORY = `${this.fake.owner}/${this.fake.repo}`;
    process.env.RUNNER_TEMP = this.workspaceDir;
    resetCoreState();
    try {
      await main();
      if (process.exitCode && process.exitCode !== 0) {
        const code = process.exitCode;
        process.exitCode = 0;
        throw new Error(
          `helper '${helper}' set exitCode ${code}; check core.setFailed messages`,
        );
      }
      return parseGithubOutput(readFileSync(outputFile, "utf-8"));
    } finally {
      restoreEnv();
    }
  }

  // Public sugar

  queueAgent(stage: NonReviewStage, response: AgentResponse): void {
    this.stub.queue(stage, response);
  }

  queueReviewAgents(bundle: ReviewAgentBundle): void {
    this.stub.queueReview(bundle);
  }

  seedFile(relativePath: string, contents: string): void {
    const abs = join(this.workspaceDir, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  async dispose(): Promise<void> {
    unregisterFake(this.fake);
    this.tmpHandle.removeCallback();
  }
}

function serializeReviewBundle(
  bundle: ReviewAgentBundle,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ["compliance", "bugs", "security", "smells"] as const) {
    const r = bundle[role];
    out[role] = "failed" in r && r.failed ? "" : r.output;
  }
  return out;
}

class ScenarioStepError extends Error {
  constructor(
    stage: string,
    stepIndex: number,
    step: GraphStep,
    inner: unknown,
    fake: FakeGitHub,
  ) {
    const helperName =
      step.kind === "helper"
        ? step.helper
        : step.kind === "context"
          ? `context:${step.id}`
          : step.kind === "agent"
            ? `agent:${step.stage}`
            : "if";
    const msg = inner instanceof Error ? inner.message : String(inner);
    super(
      `ScenarioStepError: stage=${stage} step=${stepIndex} kind=${step.kind} ref=${helperName}\n  Helper threw: ${msg}\n\n  GitHub state at time of failure:\n${fake.eventLogSummary()}\n`,
    );
    this.name = "ScenarioStepError";
  }
}

// -----------------------------------------------------------------------
// Global mock plumbing. The harness redirects @actions/github's
// getOctokit() to return the FakeGitHub-backed shim. The vi.mock call
// that sets this in motion lives in the test file (Task 7) or in a
// global setup (Task 8); here we only wire the mock implementation.
// -----------------------------------------------------------------------

const fakeRegistry = new Map<string, FakeGitHub>();

function registerFake(fake: FakeGitHub) {
  fakeRegistry.set(`${fake.owner}/${fake.repo}`, fake);
}

function unregisterFake(fake: FakeGitHub) {
  fakeRegistry.delete(`${fake.owner}/${fake.repo}`);
}

vi.mocked(getOctokit).mockImplementation((token: string) => {
  const fake = Array.from(fakeRegistry.values())[0];
  if (!fake) {
    throw new Error("getOctokit called without a registered FakeGitHub");
  }
  if (token === REVIEW_TOKEN) {
    const reviewer = fake.reviewIdentity;
    if (!reviewer) {
      throw new Error(
        "getOctokit: REVIEW_TOKEN was used but the fake has no reviewAuthIdentity. Pass it in the FakeGitHub constructor.",
      );
    }
    return fake.asOctokit(reviewer) as never;
  }
  return fake.asOctokit(fake.primaryIdentity) as never;
});
