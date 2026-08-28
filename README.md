# APEX Stream

Cloud-native multi-agent monitoring, anomaly detection, and evidence custody on AWS. Four named agents (Aria, Atlas, Sentinel, Archivist) watch sources, score findings, archive evidence with cryptographically verifiable tamper-evidence, and alert operators in real-time.

**Status: deployable, not deployed.** Infrastructure-as-code, application code, CI/CD, and GitHub OIDC trust configurations are prepared for zero-credential pipeline execution.

## Layout

| Path | What it is |
|---|---|
| `services/orchestrator` | Fastify API: auth, task dispatch, run control |
| `services/agent-aria` | Feed/API ingestion agent |
| `services/agent-atlas` | Web-page ingestion agent |
| `services/agent-sentinel` | Live-stream ingestion agent |
| `services/agent-archivist` | Evidence vault / archival agent |
| `services/agent-warden` | YouTube live chat + comment triage agent |
| `packages/core` | Shared types, scoring engine, security (RBAC/crypto), audit ledger |
| `packages/agent-runtime` | SQS/EventBridge task bus + agent harness used by every service |
| `packages/workflow-engine` | Declarative workflow executor + templates |
| `packages/youtube` | YouTube Data API client |
| `apps/dashboard` | Operator UI (React + Vite) |
| `infra` | AWS CDK: network, data, compute, messaging, security, observability, auth, frontend stacks |
| `infra/bootstrap` | One-time GitHub OIDC trust (CloudFormation) |
| `db/migrations` | Postgres schema |
| `.github/workflows` | CI (`ci.yml`) and OIDC-based deploy (`deploy.yml`) |

## Local development

```bash
npm install
npm run build        # builds every workspace
npm test             # runs test suites
npm run typecheck    # project-referenced tsc across services + packages
```

Node >= 20 required.
