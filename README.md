# APEX Stream

APEX Stream is a multi-agent monitoring, anomaly-detection, evidence, and operator-workflow platform built around Aria, Atlas, Sentinel, Archivist, Warden, and a central orchestrator.

## Production status

The active deployment architecture is Google Cloud Run. The former AWS CDK/ECS deployment is retired and is not production ground truth.

**Deployment is intentionally fail-closed right now.** A read-only inventory of the configured Google Cloud project/region confirmed there is no dedicated APEX-Stream Cloud Run service. The previous workflow was hardcoded to service `apex`, which is the separate main APEX application. That collision allowed APEX-Stream and APEX to overwrite each other's revisions. APEX-Stream must never deploy to `apex` again.

The release workflow now requires both:

- `APEX_STREAM_DEPLOY_ENABLED=true`
- `APEX_STREAM_CLOUD_RUN_SERVICE=<verified existing dedicated service>`

It refuses service name `apex`, describes the exact target before building, never creates a Cloud Run service, updates only an existing service, uses an immutable Git SHA image, and verifies the live SHA after release.

A dedicated APEX-Stream service has not yet been verified, so merges can build/test but must not mutate Cloud Run production.

## Runtime migration status

The orchestrator can boot on Cloud Run and has proven Postgres connectivity. The deeper fleet migration is not complete yet: agent dispatch/eventing, authentication, and evidence storage still contain AWS-derived SQS/EventBridge/Cognito/S3/KMS interfaces. Temporary fake AWS resource identifiers are not an acceptable production architecture and are being retired rather than treated as working infrastructure.

Until those seams are replaced or deliberately backed by real services, `/health` proves orchestrator/database health only; it does not prove the full multi-agent fleet is operational.

## Layout

| Path | What it is |
|---|---|
| `services/orchestrator` | Fastify API: auth, task dispatch, comment triage, and Beast-mode control |
| `services/agent-aria` | Feed/API ingestion agent |
| `services/agent-atlas` | Web-page ingestion agent |
| `services/agent-sentinel` | Live-stream ingestion agent |
| `services/agent-archivist` | Evidence archival agent |
| `services/agent-warden` | YouTube live chat + comment triage agent |
| `packages/core` | Shared types, scoring, security, and audit primitives |
| `packages/agent-runtime` | Shared agent harness and current task/event adapters |
| `packages/workflow-engine` | Declarative workflow executor and templates |
| `packages/youtube` | YouTube Data API client |
| `apps/dashboard` | Operator UI (React + Vite) |
| `db/migrations` | Postgres schema |
| `.github/workflows` | PR validation and guarded Cloud Run release workflows |

The historical AWS CDK implementation remains available through Git history rather than as active infrastructure source.

## Local development

```bash
npm ci
npm run build
npm test
npm run typecheck
npm run dashboard:dev
```

Node >= 20 is required.

## Release guardrails

See [`docs/PRODUCTION_OPERATIONS.md`](docs/PRODUCTION_OPERATIONS.md). The short version is: never guess a Cloud Run target, never use the main APEX `apex` service for this repository, never restore placeholder AWS resource IDs as a production fix, and never claim the fleet is healthy from the database-only health response.
