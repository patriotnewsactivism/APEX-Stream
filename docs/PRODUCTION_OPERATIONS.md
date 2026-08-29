# APEX Stream Production Operations

## Source of truth

Current deployment platform: **Google Cloud Run**.

The former AWS CDK/ECS architecture is historical. Git history preserves it; it is not an active deployment contract.

## Known Google Cloud state

Read-only discovery on 2026-08-29 confirmed the configured project/region contains several Cloud Run services, including a service named `apex`. That service belongs to the separate main APEX application and contains APEX-specific administration/LLM configuration. It is **not** an APEX-Stream target.

No dedicated APEX-Stream Cloud Run service was found during that inventory.

### Non-negotiable target rule

Never deploy this repository to Cloud Run service `apex`.

The deployment workflow must remain disabled until `APEX_STREAM_CLOUD_RUN_SERVICE` identifies a separately verified, existing APEX-Stream service. The workflow must describe that exact service before any image build or update. It must not create a service as a fallback and must not infer a target from a project name or an unrelated service.

## Release contract

A production release requires:

1. PR validation passes for the active application and orchestrator container.
2. `APEX_STREAM_DEPLOY_ENABLED=true` is explicitly set.
3. `APEX_STREAM_CLOUD_RUN_SERVICE` is non-empty and is not `apex`.
4. Google authentication succeeds.
5. `gcloud run services describe` confirms the exact target already exists and has a Ready revision.
6. The image is built and pushed with the full Git commit SHA as the immutable tag. Do not rely on `latest`.
7. `gcloud run services update` updates only that existing service and preserves its existing service configuration.
8. The latest created revision becomes the latest Ready revision.
9. `/health.version` matches the exact Git SHA released.

If any step fails, production is not considered released.

## Current runtime gap

The Cloud Run migration is incomplete at the application layer. Postgres connectivity has been proven, but these interfaces remain AWS-derived:

- task queues: SQS
- event fan-out: EventBridge
- operator authentication: Cognito
- evidence/object retention: S3/Object Lock + KMS
- some agent runtime helpers and comments still assume AWS execution semantics

Do not use fake AWS account IDs, queue URLs, Cognito IDs, bucket names, or KMS aliases as a production compatibility layer. A successful `/health` response currently proves database reachability and orchestrator boot only; it does not prove agent dispatch, authentication, or evidence archival.

The next platform phase is to replace or deliberately re-home these interfaces before enabling APEX-Stream production deployment.

## Credential boundaries

Do not copy credentials from the main APEX Cloud Run service into APEX-Stream. In particular, main APEX admin credentials and LLM/provider credentials are not APEX-Stream deployment configuration merely because the repositories share a Google Cloud project.

Do not print secret values in CI logs. Prefer Secret Manager references or workload identity for durable production configuration when the dedicated service is provisioned.

## Legacy cleanup

The retired `infra/` AWS CDK tree was removed from the active repository because it was no longer the deployment path and contained unresolved merge-conflict artifacts. Historical versions remain recoverable from Git commits.
