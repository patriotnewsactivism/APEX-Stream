# Ingestion

Sources are rows in the `sources` table (`db/migrations/001_initial_schema.sql`),
not hardcoded config — adding a target is a database insert, not a deploy.
Each source has a `kind`, an `owner_agent` (which of the four agents polls
it), an `interval_seconds`, an `authority` weight (0-1, how much this
source's signals count toward a final score), and failure tracking
(`consecutive_failures`, `last_error`).

## Source kinds → agent

| `kind` | Agent | Notes |
|---|---|---|
| `rss`, `http_api` | Aria (`src/feed.ts`) | Polled on `interval_seconds` |
| `web_page`, `social`, `court_docket` | Atlas (`src/page.ts`) | Page fetch/diff; social and docket sources still route here since they're fundamentally "fetch a page, extract structured signal" |
| `live_stream` | Sentinel (`src/stream.ts`) | Long-lived connection, not interval-polled |
| `upload` | Archivist (`src/vault.ts`) | Operator- or API-submitted evidence, not polled at all |

## API / web / live-stream ingestion

Aria and Atlas both run on a poll loop keyed by `interval_seconds`, writing
one `observations` row per poll (with a `raw_payload` and a `fetched_at`),
and zero or more `observation_signals` rows — the individual named signals
(e.g. `silent_edit`) that feed the scoring engine
(`packages/core/src/scoring`). A source that starts failing increments
`consecutive_failures` and records `last_error`; agents should back off
(via the queue's `VisibilityTimeout`) rather than hot-looping a dead source.

Sentinel differs structurally: it holds a connection open rather than
polling, which is why it's sized differently in `infra/lib/config.ts`
(the only agent allowed to run 0 tasks and the only one given real memory
headroom for a sustained connection) and why `agents.md` calls it "the
expensive agent."

## Uploaded evidence

Archivist doesn't ingest on a schedule — it receives evidence directly
(operator upload through the orchestrator, or an API call from an external
system) and is responsible for getting it into the `evidence` table plus the
S3 evidence bucket with the right chain-of-custody fields intact (see
[`database.md`](database.md) and [`security.md`](security.md) for what
"intact" means here — this is the one table where write-once semantics
actually matter).

## Adding a new source

Insert into `sources` with the right `kind` and `owner_agent` — the check
constraints (`kind IN (...)`, `owner_agent IN ('aria','atlas','sentinel','archivist')`)
mean a typo fails at the database, not silently at runtime. There is no
separate "ingestion config" file to keep in sync.
