# Security

## Identity: Cognito, no second user table

`services/orchestrator/src/auth.ts` verifies access tokens against the
Cognito pool's published JWKS (signature, issuer, audience, expiry —
`jose`'s `createRemoteJWKSet`/`jwtVerify`). Roles come from `cognito:groups`
directly on the token, so Cognito group membership is the single source of
truth for authorization. There is no separate users/roles table to drift out
of sync with who's actually in which Cognito group.

## Authorization: grant/deny RBAC, deny always wins

`packages/core/src/security/rbac.ts` defines five roles (`owner`, `admin`,
`operator`, `analyst`, `viewer`) as `resource:action` grant/deny lists, where
`*` matches one segment (`evidence:*` = every action on evidence). Denies are
evaluated after grants and always win — this is what makes "admin, but may
never delete evidence" expressible as data instead of a special case in code.

**Nobody — including `owner` — is granted `evidence:delete`.** Evidence lives
in an S3 Object Lock bucket in compliance mode, so the API could not honor a
delete request even if it tried; the RBAC layer encodes that reality instead
of pretending otherwise. The database backs this up independently (see
`evidence_no_delete` trigger in [`database.md`](database.md)) — belt and
suspenders, enforced at two layers that don't trust each other.

## Encryption at rest: envelope encryption, not a static key

`packages/core/src/security/crypto.ts` implements envelope encryption: KMS
mints a one-time data key per record, the record is encrypted locally with
AES-256-GCM, and only the KMS-wrapped copy of that key is stored alongside
the ciphertext. KMS never sees plaintext; the app never holds a long-lived
symmetric key. Rotating the KMS key re-wraps *future* data keys without
touching existing records. `SecurityStack` (`infra/lib/security-stack.ts`)
provisions three separate KMS keys — data, evidence, secrets — so compromising
access to one doesn't expose the others.

## Audit: hash-chained and append-only, enforced twice

`packages/core/src/audit/ledger.ts` chains each entry to the hash of the one
before it — altering or deleting any historical row invalidates every hash
after it. This is explicitly *not* claimed to make the log immutable (a
determined admin with raw database access could rewrite the whole chain and
recompute hashes) — what it makes is **silent, partial tampering detectable**,
which is the realistic threat model. `anchorDigest()` exists to publish a
digest externally (S3 Object Lock, a second AWS account, a public timestamp
service) on a schedule, closing that gap for anyone who actually needs it.

Independently, the database's `audit_no_update` trigger refuses `UPDATE` or
`DELETE` on `audit_log` outright — no retention window, no exception. The
hash chain and the trigger are deliberately redundant: the trigger stops the
easy case (an application bug or a stray `DELETE`), the hash chain stops the
hard case (someone with enough access to disable the trigger and edit rows
directly still can't do it without the tampering being mathematically
evident).

## Config: validate once at boot, refuse to start otherwise

`services/orchestrator/src/config.ts` validates every environment variable
through a zod schema at boot (`DATABASE_URL`, all four queue URLs, KMS key
ID, Cognito pool/client ID, etc.) and freezes the result. A container that
can't serve correctly refuses to start rather than failing later on a
request path, where the failure is harder to attribute to its actual cause.

## Deploy-time: no long-lived AWS keys, ever

GitHub Actions authenticates to AWS via OIDC (`infra/bootstrap/github-oidc.yaml`)
— a short-lived token minted per workflow run, trust-scoped to this exact
repo and the `main` branch. No `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
pair exists in GitHub secrets, so there's nothing to leak from a compromised
Actions run on a fork or a dependency, and nothing to rotate on a schedule.
See [`deployment.md`](deployment.md) for the one-time setup.

## IAM: least privilege per service

`infra/lib/compute-stack.ts` gives each of the five Fargate services
(orchestrator + 4 agents) its own task role scoped to only what that specific
service needs (its own queue, the evidence bucket, its own KMS grants) —
agents cannot read each other's queues or the orchestrator's broader
permissions, and a compromised agent container is contained to that agent's
blast radius.
