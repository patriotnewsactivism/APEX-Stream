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
| `youtube_live_chat`, `youtube_video` | Warden (`src/index.ts`) | The operator's own channel, via the YouTube Data API |

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
[`database.md`](database.md) and [`SECURITY.md`](SECURITY.md) for what
"intact" means here — this is the one table where write-once semantics
actually matter).

## Adding a new source

Use the **Sources** screen in the dashboard (`apps/dashboard/src/components/SourcesPanel.tsx`),
which needs the `source:create` permission — owner, admin and operator have it.
It derives `owner_agent` from the chosen `kind` using the table above, because
a row whose `kind`/`owner_agent` pair disagrees with that mapping is accepted
by the database but never polled by anything.

The screen is a client for `/api/sources` (`GET`/`POST`/`PATCH`), so the same
thing can be done by API, or by inserting into `sources` directly. The check
constraints (`kind IN (...)`,
`owner_agent IN ('aria','atlas','sentinel','archivist','warden')`) mean a typo fails at
the database, not silently at runtime. There is no separate "ingestion config"
file to keep in sync.

## What is not ingested

**YouTube is authenticated; everything else is not.** Warden signs in to the
operator's own channel with an OAuth grant and reads its live chat and comment
threads — see [`youtube.md`](youtube.md). Every other agent is read-only against
public surfaces.

The `social` kind is the one that invites a wrong assumption. It is fetched by
Atlas as ordinary public HTML and diffed like any other page: no sign-in, no
comments, no live chat.

**Facebook is not supported and cannot be, for personal profiles.** Meta
provides no API for reading or moderating comments on personal profile posts —
it was removed after Cambridge Analytica. Comment access exists only for
Facebook *Pages*, via the Graph API with `pages_read_engagement` /
`pages_manage_engagement`. Supporting Pages would mean a Meta app and a second
integration alongside Warden's YouTube one; supporting personal profiles is not
a matter of effort, the endpoint does not exist.

The one write path in the whole system is a reply the operator has approved
(`services/orchestrator/src/routes/comments.ts`). Nothing hides, deletes or bans
on any platform.
