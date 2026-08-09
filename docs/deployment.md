# Deployment

Everything here is **deployable, not deployed**. No AWS resources exist yet.
Deployment is entirely GitHub-Actions-driven via OIDC — no AWS access keys are
ever stored in this repo or on your machine.

## One-time setup (console, ~10 minutes)

1. **Deploy the OIDC trust stack.** In the AWS Console → CloudFormation →
   Create stack → upload `infra/bootstrap/github-oidc.yaml`. Parameters
   default to this repo (`patriotnewsactivism/APEX-Stream`, branch `main`) —
   only override them if you forked it. This creates:
   - A GitHub Actions OIDC identity provider (if the account doesn't already
     have one).
   - An IAM role GitHub can assume with short-lived credentials, trust-scoped
     so only workflows running on `main` in this exact repo can assume it —
     a pull request from a fork cannot deploy.

   This is the **only** step that touches the AWS console. Everything after
   this happens from GitHub Actions.

2. **Copy the role ARN** from the stack's Outputs tab.

3. **Set repo variables** (Settings → Secrets and variables → Actions →
   Variables — these are non-secret, since the ARN alone is useless without
   the OIDC trust, but nothing here is a credential):
   - `AWS_DEPLOY_ROLE_ARN` — the ARN from step 2.
   - `AWS_REGION` — defaults to `us-east-1` if unset.
   - `APEX_ALERT_EMAIL` — where budget/CloudWatch alarms go
     (`infra/lib/observability-stack.ts`). Required — CDK synth fails without
     it.

No AWS access key, secret key, or session token is ever needed by GitHub.

## Ongoing deploys

Push to `main`, or run the `Deploy` workflow manually
(`workflow_dispatch`, choose `dev`/`staging`/`prod`). `.github/workflows/deploy.yml`
runs, in order:

1. **build** — installs, builds `@apex/core`/`@apex/agent-runtime`/`@apex/workflow-engine`,
   runs unit tests, then builds and pushes each service's Docker image
   (arm64) to its own ECR repo, tagged with the 12-char commit SHA (immutable
   tags — a deploy is always traceable to exactly one commit).
2. **infrastructure** — bootstraps the CDK toolkit stack if the account has
   never been bootstrapped, then `cdk deploy --all` for the 8 stacks
   (Network, Security, Data, Messaging, Auth, Compute, Frontend,
   Observability), `--require-approval never` since this already ran through
   CI. Outputs (API URL, dashboard URL, Cognito pool/client IDs, cluster name)
   are captured to `cdk-outputs.json` and uploaded as a build artifact.
3. **migrate** — runs `db/migrations` as a one-off ECS Fargate task using the
   just-deployed orchestrator image (`node services/orchestrator/dist/migrate.js`).
   Aurora sits in isolated subnets with no internet route, so migrations run
   inside the VPC on this task rather than from the GitHub runner. Skippable
   via the `skip_migrations` workflow input.
4. **dashboard** — builds the SPA with the deployed Cognito domain/client ID
   baked in, syncs it to the Frontend stack's S3 bucket (hashed assets get a
   1-year immutable cache, `index.html` gets `no-cache`), and invalidates
   CloudFront for `index.html`/`/`.

A step summary at the end lists the environment, dashboard URL, API URL,
Cognito pool ID, and image tag for that run.

## Local development against a deployed backend

```bash
npm install
npm run build
npm run dashboard:dev   # apps/dashboard, point VITE_API_BASE at your API URL
```

## Cost posture

`infra/lib/config.ts` keeps `dev` deliberately cheap: single NAT gateway,
Aurora floor of 0 ACU (pauses when idle), Fargate Spot where agents can
tolerate interruption, Sentinel scales to zero. `prod` trades this for
availability (multi-AZ, no Spot on the orchestrator, non-zero mins). A
CloudWatch billing alarm (`ObservabilityStack`) fires against
`monthlyBudgetUsd` — set this below your actual credit/budget ceiling before
deploying `prod`.

## Rollback

Every image tag is the commit SHA — to roll back, re-run the `Deploy` workflow
via `workflow_dispatch` after reverting `main`, or manually update the ECS
service's task definition to a prior tag if you need to move faster than a
full pipeline run.
