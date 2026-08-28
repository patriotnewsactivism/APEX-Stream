# APEX Stream

Cloud-native multi-agent monitoring, anomaly detection, and evidence archival platform on AWS. Built as the deployable foundation for a multi-agent surveillance-and-verification pipeline (Aria, Atlas, Sentinel, Archivist, Warden) coordinated by a central orchestrator, with a dashboard for human operators.

**Status: deployable, not deployed.** Everything needed to stand this up on AWS is committed — application code, infrastructure-as-code, CI/CD, and a GitHub OIDC trust so no long-lived AWS keys are ever stored in this repo. See [`docs/deployment.md`](docs/deployment.md) to provision.

## Layout

| Path | What it is |
|---|---|
| `services/orchestrator` | Fastify API: auth, task dispatch, comment triage & Beast-mode run control |
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

## Agents

| Agent | Watches | Produces |
|---|---|---|
| **Aria** | RSS feeds, public APIs, push webhooks | Normalized feed items & event triggers |
| **Atlas** | Target web pages, DOM changes, text diffs | Snapshot diffs & scraped assets |
| **Sentinel** | Live streams & video feeds | Audio/video transcription segments |
| **Archivist** | Ingested payloads & evidence bundles | WORM-locked S3 evidence bundles with cryptographic manifests |
| **Warden** | YouTube live streams & channel comments | Moderation triage, anomaly alerts & automated reply drafts |

## Local development

```bash
npm install
npm run build        # builds every workspace
npm test             # packages/core + packages/workflow-engine unit tests
npm run typecheck    # project-referenced tsc across services + packages
npm run dashboard:dev # dashboard on localhost, against your own API
```

Node >= 20 required.
