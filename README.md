# APEX Stream

<<<<<<< Updated upstream
Cloud-native multi-agent monitoring, anomaly detection, and evidence archival
platform on AWS. Built as the deployable foundation for a four-agent
surveillance-and-verification pipeline (Aria, Atlas, Sentinel, Archivist)
coordinated by a central orchestrator, with a dashboard for human operators.

**Status: deployable, not deployed.** Everything needed to stand this up on
AWS is committed — application code, infrastructure-as-code, CI/CD, and a
GitHub OIDC trust so no long-lived AWS keys are ever stored in this repo.
Nothing has been provisioned yet. See [`docs/deployment.md`](docs/deployment.md)
to actually bring it up.

## Layout

| Path | What it is |
|---|---|
| `services/orchestrator` | Fastify API: auth, task dispatch, Beast-mode run control |
| `services/agent-aria` | Feed/API ingestion agent |
| `services/agent-atlas` | Web-page ingestion agent |
| `services/agent-sentinel` | Live-stream ingestion agent |
| `services/agent-archivist` | Evidence vault / archival agent |
| `services/agent-warden` | YouTube live chat + comment triage agent |
| `packages/core` | Shared types, scoring engine, security (RBAC/crypto), audit ledger |
| `packages/agent-runtime` | SQS/EventBridge task bus + agent harness used by every service |
| `packages/workflow-engine` | Declarative workflow executor + templates |
| `packages/youtube` | YouTube Data API client (read comments, post approved replies) |
| `apps/dashboard` | Operator UI (React + Vite) |
| `infra` | AWS CDK: network, data, compute, messaging, security, observability, auth, frontend stacks |
| `infra/bootstrap` | One-time GitHub OIDC trust (CloudFormation, console-deployed) |
| `db/migrations` | Postgres schema |
| `.github/workflows` | CI (`ci.yml`) and OIDC-based deploy (`deploy.yml`) |

See [`docs/architecture.md`](docs/architecture.md) for how these fit together.

## Local development

```bash
npm install
npm run build        # builds every workspace
npm test              # packages/core + packages/workflow-engine unit tests
npm run typecheck     # project-referenced tsc across services + packages
npm run dashboard:dev # dashboard on localhost, against your own API
```

Node >= 20 required.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Agents](docs/agents.md)
- [Ingestion](docs/ingestion.md)
- [YouTube comment monitoring](docs/youtube.md)
- [Database](docs/database.md)
- [Security](docs/security.md)
=======
Cloud-native multi-agent monitoring, anomaly detection and evidence custody on
AWS. Four named agents watch sources you define, score what they find with a
breakdown you can read, archive the evidence somewhere nobody can delete it, and
tell you when something matters.

Everything is managed from a browser. The only thing you install is nothing.

---

## What it does

**Four agents, each with its own queue, memory and IAM role.**

| Agent | Watches | Produces |
|---|---|---|
| **Aria** | RSS, JSON APIs, press wires, court dockets | Novelty, publication burst, watchlist density, off-cycle timing |
| **Atlas** | Web pages and social surfaces | Silent edits — content changed with no correction notice |
| **Sentinel** | Live audio and video streams | Transcript segments scored in near real time |
| **Archivist** | Everything the others flag | Write-once evidence with a chain of custody |

**Beast mode** activates the whole fleet at once against every matching source,
under a hard cost ceiling, a wall-clock expiry and a concurrency cap it cannot
exceed. It projects the spend before you commit and stops itself when either
limit is reached.

**Transparent scoring.** Every score is a weighted sum of named signals, and the
stored record keeps every component: raw value, normalised value, weight,
contribution, and the sentence of evidence behind it. Signals without enough
data are excluded and the weights redistributed — never quietly counted as zero.
Coverage and confidence are reported separately from the score, so an 80 from
two signals never looks like an 80 from eight.

**Evidence that survives you.** S3 Object Lock in compliance mode: no principal,
including the account root, can delete an object before its retention date. The
API refuses deletion, the role table grants it to nobody, and a database trigger
blocks it too — three layers agreeing with what the bucket would enforce anyway.

**A tamper-evident audit log.** Every privileged action, including refused ones,
is written to a hash-chained ledger. `GET /api/audit/verify` recomputes the whole
chain on demand and tells you the exact entry where it broke.

**A no-code workflow builder** whose canvas emits exactly the JSON the executor
runs — no translation layer, so validation is honest and dry runs are real.

---

## Getting started

Read **[docs/DEPLOY.md](docs/DEPLOY.md)**. One CloudFormation upload in the AWS
console, three GitHub variables, then press Run workflow. About 30 minutes,
mostly waiting on CloudFront.

Three profiles:

| | idle cost | shape |
|---|---|---|
| **`lean`** | **~$3/mo** | Lambda API and agents, no VPC, no NAT, no load balancer, Aurora paused at 0 ACU, Sentinel launched per watch |
| `dev` | ~$181/mo | Fargate services, one NAT gateway, Spot |
| `prod` | ~$390/mo | Multi-AZ, two NAT gateways, no Spot |

Start with `lean`. It runs the same code — the split is held at two interfaces,
so switching profiles later changes no application logic. See
[COST.md](docs/COST.md) for the tradeoffs, chiefly a 10–20 second wait on the
first query after the database has been idle.

---

## Repository layout

```
packages/core             scoring engine, audit ledger, RBAC, crypto, types
packages/agent-runtime    base agent, queue consumer, isolated memory, store
packages/workflow-engine  workflow DSL, validator, graph executor
services/orchestrator     control plane API, Beast mode, migrations
services/agent-*          the four agents
apps/dashboard            React command deck
infra                     AWS CDK — eight stacks
db/migrations             schema
docs                      deploy, architecture, security, cost
```

## Documentation

- **[DEPLOY.md](docs/DEPLOY.md)** — step by step, browser only
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — what was chosen and why
- **[SECURITY.md](docs/SECURITY.md)** — encryption, RBAC, threat model
- **[COST.md](docs/COST.md)** — what it costs idle and under load, and the levers

## Verification

```bash
npm ci
npm run build -w @apex/core && npm run build -w @apex/agent-runtime && npm run build -w @apex/workflow-engine
npx tsc -b services/orchestrator services/agent-aria services/agent-atlas services/agent-sentinel services/agent-archivist
node --test packages/core/test/*.test.mjs packages/workflow-engine/test/*.test.mjs
npm run build -w @apex/dashboard
cd infra && npm run build && npx cdk synth --quiet     # no AWS credentials needed
```

44 tests cover the scoring engine's exclusion and renormalisation behaviour, the
audit chain against three tampering strategies, the RBAC deny-precedence rules,
envelope encryption, and the workflow validator and executor including budget
halts.

## Known gaps

Transcription is stubbed behind a `Transcriber` interface and returns nothing
rather than inventing text — wire Amazon Transcribe streaming or Whisper to it.
Social platform collectors are not implemented. Screenshot capture is plumbed
through the schema but needs a headless browser task. See
[ARCHITECTURE.md](docs/ARCHITECTURE.md#what-is-deliberately-missing).

## Licence

MIT — see [LICENSE](LICENSE).
>>>>>>> Stashed changes
