# APEX Stream

Cloud-native multi-agent monitoring, anomaly detection, and evidence archival platform on AWS. Built as the deployable foundation for a multi-agent surveillance-and-verification pipeline (Aria, Atlas, Sentinel, Archivist, Warden) coordinated by a central orchestrator, with a dashboard for human operators.

**Status: deployable.** Application code, infrastructure-as-code, CI/CD, and GitHub OIDC trust configurations are defined. See [`docs/deployment.md`](docs/deployment.md) to stand up on AWS.

## Layout

| Path | What it is |
|---|---|
| `services/orchestrator` | Fastify API: auth, task dispatch, YouTube moderation, draft triage |
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

## Local development

```bash
npm install
npm run build        # builds every workspace
npm test             # unit and integration tests
npm run typecheck    # project-referenced tsc across services + packages
npm run dashboard:dev # dashboard on localhost, against your own API
```

Node >= 20 required.
