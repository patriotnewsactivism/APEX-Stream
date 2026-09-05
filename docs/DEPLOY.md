# Deploying APEX Stream

> **HISTORICAL — this walkthrough is for the retired AWS CDK/CloudFormation
> deployment path.** It references `infra/bootstrap/github-oidc.yaml` and
> `infra/lib/*.ts`, which have been removed from this repository. APEX-Stream
> now deploys to Google Cloud Run via `.github/workflows/deploy.yml`; see
> `README.md` and `docs/PRODUCTION_OPERATIONS.md` for the current, guarded
> release process.

Everything below happens in a browser. There is exactly one step that requires
the AWS console, and it exists only because something has to create the trust
relationship before GitHub can create anything else.

**Total time: about 45 minutes, most of it waiting.**

---

## Before you start

You need:

- An AWS account with billing enabled (credits count as billing enabled).
- Admin access to the `patriotnewsactivism/APEX-Stream` GitHub repository.
- An email address for alerts. It will receive a subscription confirmation —
  click it, or you will get no alarms.

You do **not** need: the AWS CLI, Node, Docker, or anything else installed
locally.

---

## Step 1 — Create the GitHub deploy role (AWS console, once)

This creates an OIDC trust so GitHub Actions can get short-lived AWS
credentials. No AWS access key is ever created or stored.

1. Open the AWS console → **CloudFormation** → **Create stack** → **With new
   resources**.
2. Choose **Upload a template file** and upload
   [`infra/bootstrap/github-oidc.yaml`](../infra/bootstrap/github-oidc.yaml).
   (Download it from GitHub first — the file view has a download button.)
3. Stack name: `apex-github-oidc`.
4. Parameters:
   - `GitHubOrg`: `patriotnewsactivism`
   - `GitHubRepo`: `APEX-Stream`
   - `AllowedBranch`: `main`
5. On the last page tick **I acknowledge that AWS CloudFormation might create
   IAM resources with custom names**, then **Submit**.
6. When it reaches `CREATE_COMPLETE`, open the **Outputs** tab and copy
   `RoleArn`. It looks like
   `arn:aws:iam::123456789012:role/apex-github-deploy`.

> **If this fails with "OIDC provider already exists"** your account already
> trusts GitHub. Delete the `GitHubOidcProvider` resource from the template,
> redeploy, and set the role's `Principal.Federated` to the existing provider
> ARN (IAM → Identity providers).

---

## Step 2 — Tell GitHub about it

In the repository: **Settings → Secrets and variables → Actions → Variables →
New repository variable.** Add three:

| Name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the `RoleArn` you copied |
| `AWS_REGION` | `us-east-1` (or wherever you want to run) |
| `APEX_ALERT_EMAIL` | where alarms and budget warnings go |

These are *variables*, not secrets — none of them is sensitive, and variables
show their values in logs, which makes debugging a failed deploy much easier.

---

## Step 3 — Deploy

**Actions → Deploy → Run workflow.** Choose `lean` and run it.

`lean` is the default and the one to start with: about $3/month idle instead of
$181, because the API and three of the four agents run on Lambda with no VPC,
no NAT gateway and no load balancer. See [COST.md](COST.md) for what that trades
away — mainly a 10–20 second wait on the first query after the database has
been idle.

The workflow does five things in order:

1. Builds and tests the code, fails fast if anything is broken.
2. Builds container images — one for `lean` (Sentinel only), five otherwise.
3. Deploys eight CloudFormation stacks via CDK, bundling the Lambdas with
   esbuild during synth.
4. Runs database migrations: over the Data API from the runner for `lean`, as a
   one-off ECS task inside the VPC for the container profiles.
5. Builds the dashboard with the deployed Cognito settings baked in, uploads
   it to S3, and invalidates CloudFront.

**The first run takes 20–40 minutes** (`lean` is at the faster end — four fewer
container builds). Most of it is CloudFront (about 15
minutes on its own) and Aurora. Later deploys take 6–10 minutes.

When it finishes, the run summary shows your dashboard URL, API URL and user
pool ID.

### If the first run fails

| Symptom | Cause | Fix |
|---|---|---|
| `Need to perform AWS calls but no credentials configured` | `AWS_DEPLOY_ROLE_ARN` missing or wrong | Re-check the variable name exactly |
| `not authorized to perform sts:AssumeRoleWithWebIdentity` | Branch condition mismatch | You ran from a branch other than `main`; either merge or redeploy the bootstrap stack with your branch name |
| `Bucket name already exists` | S3 names are globally unique | Someone else owns `apex-dev-evidence-<your-account>`; change the account or rename in `data-stack.ts` |
| Migration task exits `1` | Migration SQL error | Read the logs: CloudWatch → `/ecs/orchestrator` → newest stream |
| CloudFront stuck ~15 min | Normal | Wait |

Re-running the workflow is safe. CDK is declarative and migrations are
idempotent.

---

## Step 4 — Create your account

**Actions → Create operator account → Run workflow.** Enter your email, choose
`owner`, pick the environment you deployed.

Cognito emails you a temporary password. On first sign-in you set a real
password and enrol MFA with an authenticator app. MFA is mandatory — a console
that can spend money and vouch for evidence should not fall to a reused
password.

Open the dashboard URL from Step 3 and sign in.

---

## Step 5 — Add sources and prove it works

The system does nothing until it has something to watch.

1. In the dashboard, add a source. A public RSS feed with `owner_agent = aria`
   and tag `news` is the easiest first test.
2. Go to **Workflows**, build something small, and press **Save & dry run**.
   Dry run reads real sources but dispatches no agents, archives nothing and
   sends nothing — you can experiment freely.
3. Go to **Beast mode**, set 5 minutes and $1, and watch the projection. Press
   activate. Within a minute or two findings start appearing.

On `lean`, the fleet panel shows agents as `offline` between invocations. That is
correct — they exist only while a message is being processed. Queue depth is the
signal to watch there, not agent state.

If nothing appears: check the fleet panel first. Agents showing `offline` means
the ECS tasks are not running — look at CloudWatch logs for the service.

---

## Adding a custom domain (optional)

1. Request a certificate in **ACM in `us-east-1`** (CloudFront only reads
   certificates from that region, regardless of where you deployed).
2. Add to `frontend-stack.ts`:
   ```ts
   domainNames: ['apex.yourdomain.com'],
   certificate: acm.Certificate.fromCertificateArn(this, 'Cert', 'arn:aws:acm:us-east-1:...'),
   ```
3. Add the callback URLs to the Cognito client in `auth-stack.ts`:
   ```ts
   callbackUrls: ['https://apex.yourdomain.com/callback'],
   logoutUrls: ['https://apex.yourdomain.com'],
   ```
4. Push to `main`. Point a CNAME at the CloudFront domain.

Both changes are needed. Changing only the distribution gives you a working
site where sign-in redirects fail.

---

## Going to production

`lean` is built for cost, `dev` for convenience, `prod` for availability. Before
real work moves onto anything:

1. Run the Deploy workflow with `prod`. It creates a fully separate set of
   stacks — separate database, separate evidence bucket, separate user pool.
   Note that `prod` uses containers: Aurora never pauses, so there is no resume
   latency, and agents hold long-lived connections.
2. Restrict `dashboardOrigin` from `*` to your actual domain.
3. Confirm the SNS subscription email.
4. Set the budget in `infra/lib/config.ts` to a number that would genuinely
   alarm you, not a number you expect to hit.
5. Test the restore path before you need it: take an Aurora snapshot and
   restore it into a scratch cluster.

---

## Tearing down

```
Actions → (no workflow for this, by design)
```

Destruction is not wired to a button, deliberately. To tear down a
non-production environment, run `cdk destroy` from CloudShell in the console.
The evidence bucket, its KMS key, and the audit chain are all set to `RETAIN`
and will survive — that is intentional. Evidence you can delete by tearing down
the stack that produced it was never really evidence.
