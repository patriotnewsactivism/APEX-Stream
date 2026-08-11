# Agents

Four independent Fargate services, each with its own SQS queue + dead-letter
queue, each implementing the same `run(task) -> result` contract from
`packages/agent-runtime`. None have public ingress — they pull work, they
don't receive it directly.

| Agent | Service | Ingests | Entry point |
|---|---|---|---|
| **Aria** | `services/agent-aria` | RSS/HTTP API feeds | `src/feed.ts` |
| **Atlas** | `services/agent-atlas` | Web pages (scraping/diffing) | `src/page.ts` |
| **Sentinel** | `services/agent-sentinel` | Live streams | `src/stream.ts` |
| **Archivist** | `services/agent-archivist` | Uploaded evidence, S3 vault | `src/vault.ts` |
| **Warden** | `services/agent-warden` | YouTube live chat and comments | `src/index.ts` |

These map directly to the `sources.kind` check constraint in
`db/migrations/001_initial_schema.sql`: `rss`, `http_api`, `web_page`,
`social`, `court_docket` route to Aria or Atlas depending on polling model;
`live_stream` routes to Sentinel; `upload` routes to Archivist;
`youtube_live_chat` and `youtube_video` route to Warden. Every source row has an
`owner_agent` column constrained to exactly these five names — the schema and
the runtime agree on the same fixed set by construction.

Warden is the odd one out in two ways, both deliberate. It reads a channel the
operator *owns* rather than a third party's public surface, and its output is
addressed to a human for a decision rather than filed as a finding. It is also
the only agent whose subject matter could justify acting — and it cannot: it has
no `reply:post` or `comment:moderate` scope, its database role can only create a
`pending` draft, and the code that publishes a reply lives in the orchestrator
behind a `reply:approve` check. See [`youtube.md`](youtube.md).

## Task lifecycle

1. `Dispatcher` (`services/orchestrator/src/dispatcher.ts`) enqueues an
   `AgentTask` with an explicit `expiresAt`, `maxAttempts`, `priority`, and a
   `traceId` for correlating a task across logs.
2. The agent's runtime harness (`packages/agent-runtime`) long-polls its
   queue, claims a message, and calls the agent's `run()`.
3. On success, the agent writes results (Postgres for structured rows, S3 for
   raw evidence) and reports back through the orchestrator's `effects.ts`.
4. On failure, the message becomes visible again after `VisibilityTimeout`
   and eventually redrives to the agent's DLQ per `maxAttempts` — a task is
   never silently dropped.
5. On cancellation (e.g. a Beast run stopped mid-flight), tasks are **not**
   purged from the queue — purging queues destroys in-flight work
   indiscriminately. Tasks simply age out via `expiresAt` and agents drop them
   on pickup instead of executing stale work
   (see the comment in `Dispatcher`).

## Sizing

`infra/lib/config.ts` sizes each agent independently because their cost/load
profiles differ:

- **Sentinel** holds long-lived stream connections — it gets the most
  CPU/memory of the four, and is the only agent allowed `minCount: 0`
  (scales to zero when nothing is being watched — it's the expensive one).
- **Aria** and **Archivist** are lightweight, bursty, request/response-shaped
  work — smallest footprint, always at least 1 running.
- **Atlas** sits in between (headless-browser-shaped work is heavier than a
  feed poll, lighter than holding a stream open).

## Adding a fifth agent

1. Add a `services/agent-<name>` package following the existing four's shape
   (`Dockerfile`, `package.json`, `tsconfig.json`, `src/index.ts` implementing
   `run(task) -> result`).
2. Add it to `AGENTS` in `infra/lib/compute-stack.ts` and to the
   `owner_agent`/`sources.kind` check constraints in a new migration — the
   schema intentionally enumerates agents explicitly rather than leaving the
   column free-text, so a new agent needs a migration, not just code.
3. Add its queue in `infra/lib/messaging-stack.ts` and wire it into
   `Dispatcher`'s queue map.
