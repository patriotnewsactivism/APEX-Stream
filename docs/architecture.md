# Architecture

APEX Stream is a monorepo: four ingestion agents, one orchestrator, one
dashboard, backed by Postgres (Aurora Serverless v2), S3, SQS/EventBridge,
running on ECS Fargate behind an ALB, fronted by CloudFront for the dashboard.

```
                          ┌────────────────────┐
                          │      Dashboard      │  CloudFront + S3 (static SPA)
                          │  (apps/dashboard)   │  Cognito Hosted UI for sign-in
                          └─────────┬───────────┘
                                    │ HTTPS (same-origin via CloudFront /api/*)
                          ┌─────────▼───────────┐
                          │    Orchestrator      │  Fastify, ECS Fargate, behind ALB
                          │ (services/orchestrator)│  Verifies Cognito JWTs, RBAC via
                          └────┬───────────┬────┘  packages/core/security, audit ledger
                               │           │
                     dispatch  │           │  results / anomalies
                    (SQS per   │           │  (SQS + EventBridge)
                     agent)    ▼           ▼
        ┌───────────┬───────────┬───────────┬───────────┐
        │ agent-aria │agent-atlas│agent-sent.│agent-arch.│  4 independent Fargate
        │ (feeds/API)│(web pages)│(live      │(evidence  │  services, each with its
        │            │           │ streams)  │ vault/S3) │  own queue + DLQ
        └───────────┴───────────┴───────────┴───────────┘
                               │
                     ┌─────────▼─────────┐
                     │  Aurora PostgreSQL │  Serverless v2, isolated subnets,
                     │   (db/migrations)  │  no internet route
                     └────────────────────┘
```

## Why this shape

- **One queue per agent, not one shared queue.** A slow Sentinel (long-lived
  stream connections) never backs up Aria's or Atlas's work, and each agent
  scales independently (`infra/lib/config.ts` sizes them separately — Sentinel
  is the only one allowed to scale to zero).
- **Stacks split by lifecycle, not by convenience** (`infra/bin/apex.ts`):
  Network/Security change rarely and are risky to touch; Compute changes on
  every deploy. A routine service deploy cannot accidentally replace a VPC or
  KMS key.
- **The orchestrator is the only public entry point.** Agents have no public
  ingress; they pull from their queue and write results back through the
  orchestrator's dispatcher/effects path (`services/orchestrator/src/dispatcher.ts`,
  `effects.ts`).
- **Beast mode** (`services/orchestrator/src/beast.ts`) is the mechanism for
  running all four agents flat-out against a target. Runs carry an explicit
  wall-clock and cost budget; overdue runs are expired by a timer in
  `services/orchestrator/src/index.ts`, independent of any external scheduler.
- **Workflow engine** (`packages/workflow-engine`) is a declarative DAG
  executor with topological ordering, node/cost budgets, and templated
  placeholders — used to script multi-agent investigations without hardcoding
  agent call sequences in application code.
- **Scoring engine** (`packages/core/src/scoring`) turns raw agent signals
  into a single confidence/anomaly score. Missing signals are excluded and the
  result renormalized rather than counted as zero — a page with one
  maximal signal and nine unmeasured ones scores near the top of its range,
  not near the bottom, and `coverage` tells you how much of the signal set was
  actually available.

## Request flow (typical)

1. Operator (or a schedule) creates a run via the orchestrator API.
2. Dispatcher enqueues tasks onto the relevant agent queue(s) with an explicit
   `expiresAt` and `maxAttempts`.
3. Agent picks up the task, does its ingestion/analysis work, writes results
   back (S3 for evidence, Postgres for structured data) and reports through
   `effects.ts`.
4. Orchestrator scores the observation, writes to the audit ledger
   (`packages/core/src/audit/ledger.ts` — append-only, tamper-evident), and
   emits an EventBridge event if the result crosses an anomaly threshold.
5. Dashboard reflects state via polling/websocket against the orchestrator API.

See [`agents.md`](agents.md) for what each agent actually does,
[`database.md`](database.md) for the schema, and [`security.md`](security.md)
for the auth/RBAC/audit model.
