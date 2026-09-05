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

The AWS-derived interfaces previously listed here — SQS/EventBridge for task
dispatch and event fan-out, DynamoDB for agent memory, Cognito for operator
authentication, S3 Object Lock + KMS for evidence retention, ECS for
Sentinel's on-demand launcher, and Bedrock for Warden's Claude calls — have
each been replaced in code (PRs #13-#17 on this repository, 2026-09-05):
Postgres-native dispatch/eventing/memory, Cloud KMS, GCS + GCS Object
Retention Lock, Cloud Run Jobs, OpenRouter, and Identity Platform /
Firebase Auth, respectively. No AWS SDK package remains in this repository.

That is a code-level claim, not a production-verified one. None of these
replacements has been exercised against live GCP, Identity Platform, or
OpenRouter credentials — the environment every migrating PR was authored in
had none of these. Specifically unverified, and flagged as such in code
comments at the exact points that need checking before relying on them:

- **GCS Object Retention Lock** actually forbids deletion/overwrite before
  `retainUntilTime` the way S3 Object Lock did (`services/agent-archivist/src/vault.ts`).
  Verify with `gcloud storage objects describe --format="value(retention)"`.
- **Cloud Run Jobs execution naming** — `sentinel.ts`'s `launch()` reads the
  new execution's name from the `RunJob` operation's metadata immediately,
  without waiting for the watch to finish; this is the standard LRO
  convention but has a fallback path that has also never run against a real
  Job.
- **`verifyIdToken()`** against a real Identity Platform token, and the
  `roles` custom claim actually round-tripping from the provisioning
  workflow to the decoded token.
- **The provisioning workflow's Workload Identity Federation** setup
  (`GCP_WORKLOAD_IDENTITY_PROVIDER`/`GCP_SERVICE_ACCOUNT` per GitHub
  Environment) has never run.

Do not use fake GCP resource identifiers (KMS key names, bucket names, Cloud
Run job names, Firebase project config) as a production compatibility layer,
for the same reason fake AWS ones were rejected above. A successful `/health`
response still proves database reachability and orchestrator boot only; it
does not prove agent dispatch, authentication, or evidence archival against
real cloud services.

The next platform phase is live verification against a real GCP project and
Identity Platform instance, then enabling APEX-Stream production deployment.

## Credential boundaries

Do not copy credentials from the main APEX Cloud Run service into APEX-Stream. In particular, main APEX admin credentials and LLM/provider credentials are not APEX-Stream deployment configuration merely because the repositories share a Google Cloud project.

Do not print secret values in CI logs. Prefer Secret Manager references or workload identity for durable production configuration when the dedicated service is provisioned.

## Legacy cleanup

The retired `infra/` AWS CDK tree was removed from the active repository because it was no longer the deployment path and contained unresolved merge-conflict artifacts. Historical versions remain recoverable from Git commits.
