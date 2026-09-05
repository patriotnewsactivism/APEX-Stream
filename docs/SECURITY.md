# Security model

> **HISTORICAL — describes the retired AWS security architecture** (KMS CMKs,
> Cognito, VPC three-tier network, CDK-managed IAM). APEX-Stream is migrating
> to Google Cloud Run; see `README.md` and `docs/PRODUCTION_OPERATIONS.md` for
> current, verified state. The threat model, RBAC design (deny-wins, nobody
> holds `evidence:delete`), and audit hash-chain concepts below remain the
> intended design — the specific AWS services implementing them are being
> replaced, one subsystem at a time, and dispatch/auth/evidence storage still
> run on the AWS services described here as of this writing (see
> `docs/PRODUCTION_OPERATIONS.md` for exactly which).

## Encryption

**At rest.** Two customer-managed KMS keys, both rotating annually: `data`
(Aurora storage, SQS, DynamoDB, ECR) and `evidence` (the archive). Separation
means a service role that can decrypt one cannot decrypt both, and the evidence
key carries a stricter policy than the general one. The evidence key is set to
`RETAIN` and is never destroyed with the stack — losing it would render every
archived artefact permanently unreadable.

The database credential secret uses the AWS-managed Secrets Manager key rather
than a third CMK. ECS automatically grants the task execution role read access
to that secret, and with a customer-managed key that grant writes the role ARN
into the key policy — which makes the security stack depend on the compute
stack that already depends on it, and CDK rejects the cycle. The secret is still
encrypted at rest; what is given up is independent rotation control over the
key, which the database credential's own rotation already covers.

Consumers are granted key use through **identity** policies on their own roles,
never by adding statements to the key policy, for the same reason. CDK's default
key policy already delegates authorisation to IAM for same-account principals,
so this is equivalent in effect and keeps the stack graph acyclic.

**In transit.** TLS everywhere. `rds.force_ssl=1` on Aurora, `enforceSSL` on
every bucket and queue, TLS 1.2+ at CloudFront.

**Application-level.** `encryptEnvelope`/`decryptEnvelope` in `@apex/core`
provide envelope encryption for sensitive field values: KMS mints a one-time
data key, AES-256-GCM encrypts locally, the wrapped key is stored beside the
ciphertext, and the plaintext key is zeroed from the heap in a `finally` block.
Additional authenticated data binds a ciphertext to its context, so a value
lifted from one record cannot be replayed into another.

## Authentication

Cognito, MFA required, no self-registration. Access tokens are verified against
the pool's JWKS on every request — signature, issuer, audience and expiry.

The browser uses the authorisation-code flow with PKCE. No token appears in a
URL or browser history, and there is no client secret to leak into a bundle.
Tokens live in `sessionStorage`, not `localStorage`: a console that can trigger
Beast mode should not stay signed in across browser restarts.

## Authorisation

Five roles, permissions as `resource:action` strings, `*` matching one segment.
Denies are evaluated after grants and always win — which is what makes "admin,
but may never delete evidence" expressible.

Cognito group membership is the single source of truth. There is no second
users table to drift.

**Nobody is granted `evidence:delete`.** Not admin, not owner. The bucket would
refuse the call anyway; encoding it in the role table keeps the application
honest about what the storage layer will actually do. The API endpoint exists
solely to return 403 and write an audit entry, because an attempted deletion is
itself a security event worth recording.

The dashboard hides controls the signed-in user cannot use. That is a usability
affordance, not a boundary — the server re-checks every request.

## Network

Three tiers. Public holds only the load balancer. Private-with-egress holds all
compute. Isolated holds the database, with no route to the internet at all.

Agents have unrestricted egress because they fetch arbitrary external sources —
that is the job. Restricting it would mean an allowlist that breaks the moment
an operator adds a source. The compensating controls are that agents run with
narrow IAM, hold no long-lived credentials, and cannot reach each other's data.

VPC endpoints keep SQS, KMS, ECR, Secrets Manager, CloudWatch and EventBridge
traffic on the AWS backbone rather than out through NAT.

## Supply chain

- ECR scans every image on push.
- Image tags are immutable — a deployed tag maps to exactly one build forever.
- Containers run as a non-root user with `tini` as PID 1.
- `npm ci` against a committed lockfile; no floating installs in CI.
- The GitHub deploy role is scoped to one repository and one branch, and
  carries an explicit `Deny` on the evidence bucket. A compromised workflow can
  redeploy the platform but cannot touch the archive.

## Threat model

| Threat | Control | Residual risk |
|---|---|---|
| Stolen operator credentials | MFA required; all actions audited; Beast mode budget-capped | An attacker with the device can still act as that operator |
| Compromised agent container | Per-agent IAM; no cross-agent access; no evidence deletion | That agent's own sources and memory are exposed |
| Malicious source content | Size caps, timeouts, no XML entity expansion, regex length limits | A hostile page can still waste fetch budget |
| Insider deleting evidence | Object Lock COMPLIANCE — root cannot delete before retention | Evidence never captured was never protected |
| Insider rewriting audit history | Hash chain makes partial tampering detectable; append-only triggers | Full-chain rewrite with database write access is possible unless digests are anchored externally |
| Runaway cost | Per-run budget, wall-clock expiry, concurrency caps, AWS Budgets alerts | A misconfigured always-on source still costs money slowly |
| Leaked deploy credentials | OIDC only; no static keys; short-lived sessions; branch-scoped | An attacker who can merge to `main` can deploy |

## Operational notes

- Logs are structured JSON with deny-by-default redaction on key names matching
  `pass|secret|token|key|credential|authorization|cookie|session|private`. It
  is cheaper to over-redact than to find a token in a log group six months on.
- Audit entries record identifiers, never content. Evidence content lives in
  the vault; the log records that it was accessed, by whom, and when.
- `GET /api/audit/verify` recomputes every hash on demand. Run it after any
  database maintenance.
- The Cognito advanced-security mode is `ENFORCED`, which blocks sign-ins from
  credentials known to be compromised.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository. Do not open a public
issue.
