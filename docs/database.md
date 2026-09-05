# Database

> **The compute/networking details below are HISTORICAL (retired AWS
> Aurora/VPC/ECS setup).** `scripts/migrate.js` and the isolated-subnet
> deployment model described here predate the Google Cloud Run migration —
> `services/orchestrator/src/migrate.ts` is the current migration runner (see
> `docs/PRODUCTION_OPERATIONS.md`). The schema, tables, and constraints below
> are current: they're read directly from `db/migrations/`, which hasn't
> changed platform.

Aurora PostgreSQL Serverless v2, isolated subnets (no internet route),
schema in `db/migrations/001_initial_schema.sql`, applied by `scripts/migrate.js`
as a one-off ECS task during deploy (see [`deployment.md`](deployment.md) —
the migrate step runs inside the VPC on the orchestrator image, not from the
GitHub runner, since the database has no route out).

## Tables

| Table | Purpose |
|---|---|
| `sources` | Ingestion targets — see [`ingestion.md`](ingestion.md) |
| `observations` | Raw collected content, deduped per-source by `content_hash` |
| `observation_signals` | Individual named signal values behind a score, kept so a score can be recomputed and verified against its exact inputs |
| `runs` | Single-agent / workflow / Beast-mode executions, with a budget and hard expiry |
| `anomalies` | Scored detections — score, band, confidence, and the full `components` breakdown that produced them |
| `evidence` | Captured artifacts — S3 pointer, hash, retention date, chain of custody |
| `audit_log` | Hash-chained, append-only action log |
| `workflows` / `workflow_executions` | Declarative DAGs and their runs |
| `notifications`, `watchlist`, `agent_heartbeats` | Operator-facing / liveness tables |

## Constraints that do real work, not just validation

- **`sources.kind` / `sources.owner_agent` check constraints** enumerate the
  exact agent set (`aria`/`atlas`/`sentinel`/`archivist`) and source kinds —
  a typo fails the insert, not a runtime dispatch.
- **`observations_source_content_uniq UNIQUE (source_id, content_hash)`** —
  the dedupe key. The same bytes from the same source is one row, however
  many times it's re-fetched.
- **`runs_single_active_beast_idx`** — a partial unique index enforcing at
  most one active Beast run at a time, at the database layer. Two operators
  racing to start Beast mode cannot both win and double the spend — this is
  not enforced in application code because application-code enforcement has
  a race window; a unique index doesn't.
- **`evidence_no_delete` trigger** — refuses any `DELETE` on an evidence row
  before its `retain_until` date, citing the S3 Object Lock reason in the
  error hint. This is deliberately redundant with
  [`rbac.ts`](SECURITY.md) denying `evidence:delete` to every role including
  owner — the database enforces it even if a bug or a direct psql session
  bypasses the API layer entirely.
- **`audit_no_update` trigger** — refuses `UPDATE` or `DELETE` on `audit_log`
  outright, no exceptions, no retention window. Combined with the
  `prev_hash`/`entry_hash` chain (see [`SECURITY.md`](SECURITY.md)), altering
  history requires rewriting every row after the tampered one, which the
  trigger already prevents at the database level regardless of hash
  verification.

## Adding a migration

Add `db/migrations/00N_description.sql`, idempotent (`CREATE TABLE IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`) like `001` — the migrate step is
designed to be safely re-run. `scripts/migrate.js` applies migrations in
filename order and records what's been applied.
