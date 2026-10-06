# Shopfloor: what changed since the last self-hosting PR

## What is Shopfloor?

Shopfloor turns GitHub issues into code through a human-gated pipeline:

**Triage → Spec → Plan → Implement → Review**

The state machine decides which stage runs. Agents produce structured decisions; the application applies GitHub changes. Review still uses four lenses: compliance, bugs, security, and code smells.

The GitHub Action remains supported. This work changes the self-hosting infrastructure, not the core pipeline.

## What the previous PR introduced

The previous self-hosting work wrapped the existing pipeline so it could run outside GitHub Actions:

- A Next.js control plane intended for Vercel received GitHub webhooks.
- Neon/serverless Postgres stored deliveries, runs, and audits.
- Queue selection preferred Inngest, then an HTTP worker, inline execution, or logging-only behavior.
- Public `/api/inngest` and `/api/worker/execute` routes connected routing to execution.
- E2B supported repository execution, but missing credentials or a missing worker bundle could fall back to local execution.
- Missing database configuration or initialization failures could fall back to process-local memory.

That was a useful first self-hosting layer, but long-running execution, several fallback paths, and provider-specific wiring made the operational behavior harder to reason about.

## What we changed now

### 1. Hosting: Docker instead of Vercel-specific deployment

The codebase no longer requires Vercel deployment configuration. Next.js remains, but now runs as a persistent Node web service.

We added a multi-stage `Dockerfile` and `compose.yaml` with:

- **Postgres:** durable storage, using a pgvector-capable image.
- **Migration service:** creates the required schema and queue before startup.
- **Web service:** verifies and routes GitHub webhooks; exposes run history and readiness.
- **Private worker:** polls the database queue and executes stages.

The same containers can run on a VM or another cloud/container provider. Docker packages the services; it does not supply compute by itself. Locally, compute comes from the laptop. In the cloud, it comes from the host running the containers. Model inference still runs at the configured AI provider.

Removing Vercel configuration from this repository does **not** delete any existing deployment in a Vercel account. No cloud deployment has been changed by this work.

### 2. Jobs: pg-boss instead of Inngest

`pg-boss` now stores durable jobs in Postgres. The web process only enqueues work; it does not wait for an agent to finish.

The private worker consumes jobs directly from Postgres, without a public execution endpoint. The Inngest integration and its routes have been removed. The production runtime no longer selects HTTP, inline, or logging-only queue fallbacks; some obsolete helper classes still need cleanup.

Queue configuration includes:

- Serialization by repository and issue, or PR for review-only work.
- Two retries with exponential backoff.
- Stage-specific expiration budgets and a 60-second heartbeat.
- A dead-letter consumer to mark exhausted jobs as failed.
- A check that skips a run already recorded as succeeded or skipped.

These are database-backed job controls, not an exactly-once guarantee for GitHub mutations. A crash after posting to GitHub but before recording completion can still repeat a mutation on retry.

### 3. Persistence: one short transaction for webhook acceptance

Previously, claiming a delivery and enqueueing work were separate operations. A failure between them could leave a delivery claimed without a usable job.

The new web path commits these together in one short Postgres transaction:

1. Claim the GitHub delivery ID.
2. Save the routing audit.
3. Create the run record.
4. Enqueue the job if work is needed.

If enqueue fails, the transaction rolls back, allowing GitHub redelivery to retry. The transaction ends before any repository execution begins.

Postgres is required for the deployed runtime. Missing configuration or unavailable durable storage now causes a visible failure rather than a silent memory fallback. Memory stores remain available for tests.

### 4. Review memory: optional pgvector context

**pgvector is historical retrieval, not the queue, hosting provider, or execution engine.**

When explicitly enabled, review findings are stored with repository, commit, path, lens, disposition, model-version metadata, embedding-model identity, and a vector embedding.

The worker retrieves repository-scoped historical context using cosine similarity plus lexical/path relevance. Embedding-model and vector-dimension filters avoid mixing incompatible embeddings. Retrieval currently uses the PR title/body as its query; changed-file-based query enrichment is not yet wired.

At most eight bounded historical findings are supplied to the review lenses as **untrusted data, not instructions**. New model-generated findings are marked `unverified`. History does not automatically suppress findings or change the aggregator's verdict logic.

Memory is disabled by default. Embedding or memory database failures are designed to let the review continue without history. The embedding provider uses a configurable HTTPS OpenAI-compatible endpoint, with an injectable interface for tests. Review text is sent to that provider when memory is enabled.

### 5. Execution: explicit local development, no automatic fallback

We have **not started or used a sandbox during this implementation**. For now, the intended testing path is explicit local development execution.

The current code still retains E2B as the default production execution policy:

- Production requires configured E2B credentials and a template containing the worker bundle.
- Missing template/bundle or an invalid result fails instead of silently running locally.
- `SHOPFLOOR_EXECUTION_MODE=local` enables local execution only outside production.
- The current production Docker worker rejects local execution.

Therefore, the code is not yet a sandbox-free production deployment. If we decide to run production repository execution directly on a dedicated host/container, that needs a separate execution-policy change and isolation review.

Database and embedding credentials are not forwarded into E2B. App and agent credentials are still needed for stage execution. Docker is packaging, not a hardened boundary for arbitrary repository commands; no Docker socket should be mounted.

### 6. Review and operational fixes

- The review-only flag now travels from webhook routing through the queued job into execution.
- Review workspaces fetch and check out the PR head rather than reviewing the default branch.
- Clone credentials are removed from the workspace's stored origin URL after checkout preparation.
- The worker owns durable run status and receives audit/finding output from execution, rather than giving the sandbox database access.
- Web readiness checks the durable database/queue, and worker health is on a private port.
- Environment examples separate web configuration from worker secrets.
- `.dockerignore` excludes secrets from image build context; `.env.worker` is ignored by Git.

## How it works now

1. A GitHub issue or PR event reaches `POST /api/github/webhook` on the persistent web service.
2. The web service verifies the webhook signature and resolves the next stage using the existing state machine.
3. It atomically records the delivery, audit, run, and any required pg-boss job in Postgres. Duplicate delivery IDs do not enqueue twice.
4. GitHub receives a quick response after durable acceptance; no long-running agent work happens inside the request.
5. The private worker polls Postgres and claims eligible work, with same-key serialization across workers.
6. For review jobs, optional pgvector memory supplies bounded historical context before execution.
7. The execution layer clones the repository, runs the existing orchestrator and stage agents, and applies GitHub changes. Local development execution must be explicitly enabled; production currently requires E2B.
8. The worker persists returned audits/findings and updates the run to succeeded, skipped, or failed. Failed jobs are eligible for bounded queue retries.
9. Operators inspect the home page, `/api/runs`, and readiness checks. Run/audit endpoints should be protected by network controls or reverse-proxy authentication.

**Simple mental model:** web accepts and routes; Postgres remembers and queues; workers execute; pgvector optionally supplies review history.

## What stayed the same

- The stage order, labels, and human merge gates.
- The reusable state machine and orchestrator.
- Claude/Codex agent adapters and the four review lenses.
- Separate primary and review GitHub App identities.
- Review aggregation and verdict rules.
- The GitHub Action path, which is intended to remain compatible and still needs final build/regression verification.

Do not enable both Action and self-host automation on the same repository at once without coordination: their separate delivery streams are not cross-runtime deduplicated.

## Important files

- `apps/control-plane/` — persistent Next.js web service.
- `src/runtime/route-event.ts` — signature verification, routing, and transactional acceptance.
- `src/runtime/postgres-queue.ts` — pg-boss queue and transaction adapter.
- `src/runtime/postgres-store.ts` — durable delivery/run/audit store.
- `src/runtime/queue-worker.ts` — private persistent consumer.
- `src/runtime/run-stage-job.ts`, `workspace.ts`, `execute.ts` — checkout and stage execution.
- `src/runtime/sandbox.ts`, `worker-entry.ts` — retained E2B execution/result transport.
- `src/runtime/review-memory.ts`, `memory-schema.sql` — optional pgvector history.
- `src/runtime/schema.sql`, `scripts/migrate.ts` — explicit database initialization.
- `Dockerfile`, `compose.yaml`, `.dockerignore` — container packaging and service wiring.
- `.env.worker.example`, `apps/control-plane/.env.example` — configuration references.
- `docs/shopfloor/self-host-docker.md` — current operator guide.

The staged `docs/shopfloor/self-host-vercel.md` has been preserved unchanged as requested; it describes the previous approach, not the current deployment instructions.

## Current status and what is still left

The main architecture changes are written, but this is **not yet fully validated or deployment-ready**.

Confirmed so far: the root `pnpm typecheck` passed after the latest wiring fixes.

Still outstanding:

- Remove remaining obsolete queue helpers and finish audit/result validation.
- Complete regression and real Postgres/pgvector integration tests.
- Run the full test suite, app typecheck, and changed-file lint.
- Build the Action, sandbox worker, queue worker, and Next.js app; regenerate committed bundles.
- Verify Docker images, startup, and migrations against a disposable local database.
- Decide the production execution policy if E2B is not wanted.

No sandbox execution, cloud deployment, remote database migration, commit, or push has been performed. Cancelled checks are not counted as passing.

## Summary

Compared with the last self-hosting PR, we replaced the Vercel/Inngest deployment path with a cloud-neutral Docker web/worker architecture and durable Postgres jobs. We added optional pgvector review history while preserving the existing pipeline. The implementation still needs final cleanup and verification before we deploy or rely on an end-to-end review run.
