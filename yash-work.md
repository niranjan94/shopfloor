# What I built on Shopfloor (simple version)

## What is Shopfloor?

Shopfloor is a bot that helps turn a GitHub issue into real code.

It works in steps:

1. **Triage** — understand the issue
2. **Spec** — write what should be built
3. **Plan** — decide how to build it
4. **Implement** — write the code
5. **Review** — check the code

Before this work, Shopfloor mainly ran as a **GitHub Action** (GitHub’s own computers + a workflow file in each repo).

---

## What problem did I solve?

People should also be able to run Shopfloor **on their own cloud**, without putting a workflow file in every repo.

We chose **Vercel** as that cloud host.

There is one big catch:

- Writing code (especially **implement**) can take a long time (up to about an hour)
- It needs a real git folder and tools
- A normal Vercel request cannot safely do that by itself

So I split the system into two parts.

---



## The big idea (two halves)



### 1. Control plane (Vercel) — the front desk

This part:

- receives messages from GitHub (webhooks)
- checks they are real (security signature)
- decides what stage should run next
- saves a record of the run
- puts work on a queue
- answers GitHub quickly

It does **not** sit around for an hour writing code.

### 2. Workers / sandboxes — the workshop

This part:

- clones the repo
- runs the AI agents
- commits and pushes code
- can take a long time

**Simple mental model:**  
Vercel decides and records. Workers do the heavy work.

The old GitHub Action path still works. Self-host is an *extra* way to run the same brain, not a total rewrite.

---



## What I actually built



### 1. A real database for runs (Neon / Postgres)

Without a database, run history dies when the server restarts.

Now, if you set `DATABASE_URL`:

- webhook deliveries are remembered (so the same event is not processed twice)
- runs are saved
- audit logs are saved

If there is no database, it still works in memory for simple local testing.

### 2. A way to really run a stage

Routing alone only says “triage should run.”  
Something still has to do the work.

I added a path that:

1. reads config
2. clones the repo (when needed)
3. runs the same orchestrator as Action mode
4. cleans up the temp folder



### 3. Sandboxes for long jobs (E2B)

Long agent work should run in an isolated machine, not on bare Vercel disk.

- If `E2B_API_KEY` is set, try E2B
- Prefer a sandbox template that already has Shopfloor’s worker code (`dist/worker.cjs`)
- If that is missing, fall back to local run (okay for dev, not ideal for full production isolation)



### 4. A job queue so webhooks stay fast

GitHub expects a quick “got it.”

So work goes to a queue. Priority order:

1. **Inngest** (best for production durable jobs)
2. **HTTP worker URL** (send the job to another endpoint)
3. **Inline** (run in the same process — dev only)
4. **Logging only** (record the job, don’t run agents yet)

Also added:

- `/api/worker/execute` — HTTP endpoint that runs a stage job
- `/api/inngest` — Inngest hookup



### 5. Control plane extras

- health check shows what is configured (database, queue, E2B, etc.)
- home page shows recent runs
- docs for operators: `docs/shopfloor/self-host-vercel.md`

---



## How it works, step by step

```
You open a GitHub issue
        │
        ▼
GitHub sends a webhook to Vercel
        │
        ▼
Control plane:
  - checks signature
  - ignores duplicate deliveries
  - decides next stage (e.g. triage)
  - saves a run
  - enqueues the job
  - returns 200 quickly
        │
        ▼
Queue (Inngest / HTTP / inline)
        │
        ▼
Worker:
  - clone repo (or use E2B sandbox)
  - run AI stage
  - update GitHub labels / PRs
  - mark run succeeded or failed
```

Same pipeline brain as the Action. Different body that hosts it.

---



## Important files (map)


| What                         | Where                                             |
| ---------------------------- | ------------------------------------------------- |
| Webhook decision logic       | `src/runtime/route-event.ts`                      |
| Run a stage outside Actions  | `src/runtime/execute.ts`                          |
| Clone + run job              | `src/runtime/run-stage-job.ts`, `workspace.ts`    |
| Database store               | `src/runtime/postgres-store.ts`                   |
| Inngest queue helper         | `src/runtime/inngest-queue.ts`                    |
| E2B sandbox helper           | `src/runtime/sandbox.ts`                          |
| Worker entry (for sandboxes) | `src/runtime/worker-entry.ts` → `dist/worker.cjs` |
| Vercel app wiring            | `apps/control-plane/`                             |
| Setup guide                  | `docs/shopfloor/self-host-vercel.md`              |


I did **not** rewrite the core pipeline (state machine, stages, agents, labels). I wrapped it so it can run outside GitHub Actions.

---



## What stayed the same on purpose

- Same labels and PR behavior
- Same agent pipeline stages
- Action install still builds (`dist/index.cjs`)
- Tests still pass; Action path still supported

---



## How to run this in production 

1. Deploy `apps/control-plane` to Vercel
2. Set webhook secret + GitHub App credentials + AI key
3. Add Neon database (`DATABASE_URL`)
4. Add Inngest keys
5. Add E2B (and put `dist/worker.cjs` in the sandbox template for long implement)
6. Point the GitHub App webhook to:
  `https://your-app.vercel.app/api/github/webhook`
7. Open an issue and watch `/api/runs` or the home page

If you skip the worker/queue setup, routing still works and runs are recorded, but agents won’t run yet. That is intentional — you can wire pieces one at a time.

---



## To sum up what i did

**I made Shopfloor runnable on Vercel: GitHub talks to Vercel, Vercel decides and remembers, by storing data, workers/sandboxes do the long AI work, and the original GitHub Action still works.**