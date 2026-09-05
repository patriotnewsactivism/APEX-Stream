# Architecture

> **HISTORICAL — describes the retired AWS CDK/ECS architecture.** APEX-Stream
> is migrating to Google Cloud Run (see `README.md` and
> `docs/PRODUCTION_OPERATIONS.md` for current, verified state). The `infra/`
> CDK tree this document refers to has been removed from the repository.
> Product-level behavior described below (agent responsibilities, data
> contracts, scoring/workflow semantics) may still apply; infrastructure
> specifics (CDK stack names, Fargate/Aurora/Cognito/CloudFront details) do
> not reflect the current or target deployment.

## The shape of it

```
                    ┌──────────────┐
   Browser ────────▶│  CloudFront  │
                    └──────┬───────┘
                     /            \
         static SPA /              \ /api/*
                   ▼                ▼
            ┌──────────┐      ┌──────────────┐      ┌──────────┐
            │ S3 (SPA) │      │     ALB      │─────▶│ Cognito  │
            └──────────┘      └──────┬───────┘      │  (JWKS)  │
                                     ▼              └──────────┘
                            ┌─────────────────┐
                            │  Orchestrator   │  Fargate, 1–10 tasks
                            │  control plane  │
                            └───┬────────┬────┘
                    dispatch    │        │   read/write
                                ▼        ▼
                  ┌──────────────────┐  ┌────────────────────┐
                  │  SQS × 4 (+DLQ)  │  │ Aurora Serverless  │
                  └────────┬─────────┘  │  v2 (PostgreSQL)   │
                           │            └────────────────────┘
        ┌──────────┬───────┴───┬──────────────┐
        ▼          ▼           ▼              ▼
    ┌───────┐  ┌───────┐  ┌──────────┐  ┌────────────┐
    │ Aria  │  │ Atlas │  │ Sentinel │  │ Archivist  │   Fargate, scale on backlog
    └───┬───┘  └───┬───┘  └────┬─────┘  └─────┬──────┘
        │          │           │              │
        └──────────┴─────┬─────┴──────────────┘
                         ▼
                ┌─────────────────┐        ┌──────────────────────┐
                │  EventBridge    │        │ S3 Object Lock       │
                │  (fan-out)      │        │ COMPLIANCE mode      │
                └────────┬────────┘        │ (evidence, 7 yr)     │
                         ▼                 └──────────────────────┘
                ┌─────────────────┐                  ▲
                │ SNS → operator  │       Archivist ──┘ (only writer)
                └─────────────────┘
```

DynamoDB holds per-agent memory, partitioned so IAM can enforce isolation.

---

## Two deployment shapes, one codebase

The same application runs two ways:

| | `lean` | `dev` / `prod` |
|---|---|---|
| API | Lambda Function URL | Fargate behind an ALB |
| Aria, Atlas, Archivist | Lambda on SQS event sources | Fargate services, polling |
| Sentinel | Fargate task, launched per watch | Fargate service |
| Database access | Aurora Data API over HTTPS | Postgres socket in the VPC |
| VPC | Aurora and Sentinel only | everything |
| Idle cost | ~$3/mo | ~$181–390/mo |

Nothing about the agents' behaviour differs. The split is held at exactly two
seams:

**`SqlExecutor`** — one interface, a Postgres pool on one side and the RDS Data
API on the other. The Data API takes named parameters where the rest of the
codebase writes positional ones, so the executor rewrites `$1` to `:p1` on the
way through, skipping string literals and dollar-quoted blocks. Every query in
the system is written once and runs unchanged on both.

**`Agent.runTask()`** — the polling loop and the SQS handler both call it, with
lease operations injected. A container acks by deleting the message; Lambda acks
by returning without listing it in `batchItemFailures`. Retry classification,
expiry and result reporting are identical because they are literally the same
code.

That is why the lean profile is a configuration choice rather than a fork. If
Lambda's 15-minute ceiling ever becomes a problem, switching an environment back
to containers changes no application logic.

## Why these choices

### Fargate rather than Lambda — for Sentinel

A live stream watch runs for hours; Lambda caps at fifteen minutes. There is no
way around that, so Sentinel is a container in every profile.

The original build put all four agents on Fargate for consistency. That was the
right call for operational simplicity and the wrong call for a platform funded
by credits: it cost about $170/month in fixed infrastructure to keep three
agents warm that spend most of their time idle. The lean profile moves those
three to Lambda and keeps Sentinel on Fargate, launched per watch. Consistency
was worth less than the money.

Fargate Spot carries the collectors in dev, cutting their compute cost by
roughly 70%. A reclaimed task loses nothing: its SQS message becomes visible
again and another task picks it up. That is exactly what interruptible means,
and collectors are exactly that.

### Aurora Serverless v2 rather than DynamoDB

Most of the query load is relational and ad hoc: *anomalies above 60 in the
last day, joined to their source, excluding acknowledged ones*. That is three
lines of SQL and an ugly access-pattern redesign in DynamoDB. The audit log
needs strict monotonic sequencing, which Postgres gives with an advisory lock
and DynamoDB does not give cheaply at all.

Serverless v2 bills per ACU-second, so an idle environment sits at the 0.5 ACU
floor instead of paying for a provisioned instance around the clock.

DynamoDB still earns its place for agent memory, where the access pattern is
exactly one key lookup, TTL expiry is free, and the partition key doubles as an
IAM isolation boundary.

### One queue per agent

A shared queue would let a flood of Aria work starve Sentinel, and one poison
message stall everything. Per-agent queues also make backlog a per-agent
autoscaling signal, which is what you actually want to scale on: a collector
waiting on a slow remote server uses almost no CPU while its queue grows, so
CPU-based scaling would leave work queued while the fleet looked healthy.

### EventBridge for fan-out

Agents publish facts; the orchestrator, workflows and dashboard subscribe.
Agents never call each other. The topology stays a star rather than a mesh, so
a fifth agent is an addition rather than a change to the other four. The event
archive means a consumer bug is recoverable by replay instead of being a
permanent hole in the record.

---

## Agent isolation

"Separate agents" is only real if it survives a compromise. Three boundaries,
each independently sufficient:

| Boundary | Mechanism | What it stops |
|---|---|---|
| Queue | Task role granted `sqs:ReceiveMessage` on one queue ARN | Atlas draining Sentinel's work |
| Memory | `dynamodb:LeadingKeys` condition pinned to `mem:<agent>` | Aria reading Archivist's state, even with a code bug |
| Evidence | Only Archivist and Sentinel hold `s3:PutObject`; an explicit `Deny` covers delete and retention changes | A compromised feed parser touching the archive |

The orchestrator can read evidence and never write it. Archivist can write and
never delete. No principal anywhere — including the account root — can delete
an object before its Object Lock retention expires.

---

## Transparent scoring

A score is a weighted sum of named signals, and the stored record always
includes every component: raw value, normalised value, weight, contribution,
and the sentence of evidence behind it.

Three decisions make it honest rather than merely detailed:

**Missing signals are excluded, not zeroed.** A signal with too little data is
dropped and the remaining weights renormalise. Treating "no data" as "no
anomaly" is the most common way a scoring system lies to the person reading it.

**Coverage is reported separately from score.** An 80 from two signals is a
different claim than an 80 from eight, and the operator sees which one they
have instead of having the difference averaged away.

**Everything is deterministic and hashed.** No randomness, no clock dependence
in the arithmetic. `inputHash` commits to the profile and the exact inputs, so
a stored score can be recomputed and proven to match what it claims to come
from. That is what makes an archived finding defensible rather than asserted.

The engine also returns counterfactuals — where the score would land with each
signal removed, or maxed. "This is a 78 almost entirely because of the silent
edit" is a more useful sentence than "this is a 78".

---

## Beast mode

Every agent, every source, at once. Genuinely useful when something is
happening right now and you want maximum coverage while it happens. Also the
most expensive button in the product, and the design assumes it gets pressed
under time pressure by someone not thinking about their AWS bill.

Four rails, none overridable from the UI:

1. **Cost ceiling** — accrues from real task results, halts the run when spent.
2. **Wall-clock expiry** — every run ends itself. Forgetting to turn it off is
   the expected failure, so it does not depend on being remembered.
3. **Concurrency ceiling** — per agent and fleet-wide.
4. **Single-flight** — enforced by a partial unique index in Postgres, so two
   operators reacting to the same event cannot double the spend.

Preflight projects the cost before activation, and the button needs a second
confirmation that names the dollar figure.

On cancel, queued tasks are left to expire rather than purged. Every task
carries a TTL and agents drop expired work on pickup; purging a queue would
also destroy unrelated in-flight work.

---

## Evidence and custody

Ordering is deliberate:

1. Hash the bytes, before anything can touch them.
2. Write to S3 with Object Lock retention set at write time.
3. Write the manifest — after the artefact, so it can record the version id S3
   assigned. A manifest referencing a version that does not exist is worse than
   no manifest.
4. Append custody events, each committing to the hash of the previous one.

The audit log uses the same idea at database scale: each row commits to its
predecessor's hash, so altering or deleting any historical row invalidates
every hash after it. This does not make the log immutable — someone with write
access could rewrite the entire chain — but it makes *silent, partial*
tampering detectable, which is the realistic threat. `anchorDigest()` produces
a digest to publish into the write-once bucket on a schedule for the stronger
guarantee.

---

## Stack boundaries

Split by lifecycle, not convenience:

| Stack | Changes | Contains |
|---|---|---|
| Security | almost never | KMS keys |
| Network | rarely | VPC, subnets, endpoints |
| Data | occasionally | Aurora, evidence bucket, memory table |
| Messaging | occasionally | SQS, EventBridge, SNS |
| Auth | occasionally | Cognito |
| Compute | every deploy | ECS, ALB, task roles |
| Frontend | every deploy | S3, CloudFront |
| Observability | occasionally | alarms, dashboard, budget |

A routine service deploy touches Compute and Frontend. It cannot accidentally
replace a VPC or schedule a KMS key for deletion, because those live in stacks
it does not update.

---

## What is deliberately missing

- **Transcription is stubbed.** `NullTranscriber` returns nothing rather than
  inventing text. Wire Amazon Transcribe streaming or a Whisper container
  behind the `Transcriber` interface; capture, storage and scoring already work.
- **Social APIs are not implemented.** Every platform's API has its own auth,
  rate limits and terms. Atlas handles page fetching and diffing generically;
  platform-specific collectors are additive.
- **Screenshot capture is a flag, not a feature.** `captureScreenshot` is
  plumbed through the workflow schema but needs a headless browser task.
- **HTTPS on the ALB.** CloudFront terminates TLS for browsers. The ALB listens
  on HTTP inside the VPC. Add a certificate and an HTTPS listener before
  exposing the ALB directly.
