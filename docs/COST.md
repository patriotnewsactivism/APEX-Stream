# Cost model

> **HISTORICAL — describes the retired AWS cost model** (Lambda, Aurora,
> Fargate, NAT gateways, CloudWatch Budgets). APEX-Stream deploys to Google
> Cloud Run; see `README.md` and `docs/PRODUCTION_OPERATIONS.md` for current
> state. The cost-consciousness *principles* below (an on-demand launcher for
> Sentinel specifically because continuous stream watching dominates the
> bill, a hard budget/expiry/concurrency ceiling on Beast mode, watching
> forecasted rather than only actual spend) still hold; the dollar figures
> and AWS-specific levers do not, and a Cloud Run equivalent has not been
> recalculated (`packages/core/src/agents.ts`'s `costPerTaskMinuteUsd`
> figures are flagged, not fixed, for the same reason).

Three profiles ship. Pick with `-c env=<profile>` or the environment input on
the Deploy workflow.

| | idle / month | what it is |
|---|---|---|
| **`lean`** | **~$3** | Lambda + Aurora at 0 ACU + on-demand Sentinel |
| `dev` | ~$181 | Fargate services, one NAT, Spot |
| `prod` | ~$390 | Multi-AZ, two NAT, no Spot |

Figures are `us-east-1` estimates. Your actual bill depends on how much you
monitor. The point of this document is where the money goes and which levers
move it.

---

## Why `dev` costs $181 doing nothing

| Item | Monthly |
|---|---|
| NAT gateway × 1 | $32 |
| VPC interface endpoints × 7 | $51 |
| Aurora Serverless v2 at the 0.5 ACU floor | $43 |
| Application Load Balancer | $17 |
| Fargate minimums (orchestrator + 3 agents) | $28 |
| CloudWatch, S3, SQS, Cognito, ECR | $10 |

Almost none of that is work. It is fixed infrastructure billing by the hour
whether or not a single source is being watched.

---

## What `lean` removes, and how

Every line above is either deleted or driven to zero:

**No VPC attachment for compute.** Aurora's Data API is plain HTTPS, so Lambda
queries the database without an ENI. Nothing runs inside the VPC, which means
the NAT gateway has nothing to serve (−$32) and the interface endpoints have
nothing to keep off it (−$51). The database still sits in isolated subnets and
is still unreachable from outside the VPC — the Data API is an AWS-side
endpoint, not a hole in the network.

**No load balancer.** The orchestrator is a Lambda Function URL behind
CloudFront (−$17). Same Fastify application, same routes, same auth.

**No always-on tasks.** Aria, Atlas and Archivist run as Lambdas driven by
their own SQS queues (−$28). They idle at exactly zero.

**Aurora floor at 0 ACU.** The cluster pauses when nothing queries it (−$43).

What is left: Cognito (~$1 for a handful of operators on the Plus plan), ECR
storage for the Sentinel image, S3 and CloudWatch in the cents, and Lambda
invocations that are free until you are doing real volume.

**Idle: roughly $3/month.**

---

## What lean costs you

Not free. Four real tradeoffs:

**Aurora resume takes 10–20 seconds.** The first query after the cluster has
paused waits. For an operator console this is a slow page load once a day. For
a public API it would be unacceptable.

**Cold starts of ~1 second** on the API and on an agent that has been idle.

**A 15-minute ceiling per agent invocation.** Functions are set to 10 minutes
so there is margin. Beast mode sweeps become many short invocations rather than
one long one — same behaviour, more messages.

**No static egress IPs.** Lambda without a VPC egresses from AWS's shared pool.
If a source ever requires IP allowlisting, that agent needs a VPC and a NAT
gateway, and you are paying $32 again for that one path.

---

## Marginal cost of actual work

On top of whichever floor you chose:

| Activity | `lean` | `dev` |
|---|---|---|
| Aria — 100 text sources, 15-min interval | ~$2/mo | ~$12/mo |
| Atlas — 50 pages hourly with diffing | ~$4/mo | ~$18/mo |
| Archivist — 10k artefacts/mo | ~$1/mo | ~$3/mo |
| Evidence storage — 100 GB after tiering | ~$1.30/mo | ~$1.30/mo |
| Beast mode — 30 min, full fleet | ~$0.40 | ~$1.50 |
| **Sentinel — one continuous stream watch** | **~$0.35/hr** | ~$0.57/hr |

Lambda is cheaper per unit of work here because the agents spend most of their
time waiting on remote servers, and Lambda bills for that at a far lower rate
than a Fargate task sized to handle bursts.

---

## Sentinel is still the whole story

At ~$0.35/hr, one stream watched around the clock is **~$250/month** — eighty
times the entire lean floor. Nothing else comes close.

So in `lean` it is not a service. It is a task definition with no service
attached, launched only when you call `POST /api/watches`, capped at two
concurrent watches, and killed when its window closes. There is no schedule
that can start it and no minimum count that keeps it warm.

Watch streams during events. Not continuously.

---

## Squeezing further

If ~$3 is still more than you want:

1. **Delete the Cognito Plus feature plan** (−$1/mo). You lose compromised-
   credential detection. For a console that can spend money, I would keep it.
2. **Drop evidence retention from 7 years to 1** in `config.ts`. Object Lock
   retention cannot be shortened after an object is written, so this only
   affects future captures — decide before you start archiving.
3. **Delete the ECR repository** if you never use Sentinel. The image is the
   only thing keeping it.
4. **Widen poll intervals.** A source polled every 15 minutes costs four times
   one polled hourly, and for most sources the extra freshness changes nothing.

Below that you are optimising cents, and your time is worth more.

---

## Watching the spend

`ObservabilityStack` creates an AWS Budget filtered on `Project=APEX-Stream`,
alerting at 50% and 80% of actual and 100% of forecast. The lean budget defaults
to $25/month — high enough that normal operation never fires it, low enough that
a forgotten stream watch fires it within a day.

The forecast alert is the useful one. It warns before the money is gone rather
than after.

## A note on credits

Credits create a false sense of safety. They run out quietly, and the first real
invoice is the notification.

At the lean floor, a $5,000 credit balance funds the platform for **decades** of
idle time — the constraint becomes how much you actually monitor, which is the
right constraint to have. At the `dev` floor it is about 27 months. That
difference is the whole reason the lean profile exists.
