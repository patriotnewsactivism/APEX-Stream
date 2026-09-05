-- APEX Stream — Postgres-native task queue, event log, and agent memory
--
-- Replaces AWS SQS (task dispatch), EventBridge (event fan-out), and
-- DynamoDB (agent memory) so the platform has no AWS dependency for these
-- three subsystems. Applied by the same migration runner as 001/002 --
-- idempotent, so a re-run is harmless.

-- ---------------------------------------------------------------------------
-- Task queue (replaces one SQS queue per agent)
-- ---------------------------------------------------------------------------
-- One shared table, partitioned by agent_id, rather than one table per agent --
-- there is nothing agent-specific about the claim logic, and a shared table
-- makes fleet-wide depth/backlog observability a single query instead of five.
CREATE TABLE IF NOT EXISTS agent_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- AgentTask.taskId, kept for tracing/lookup only -- it is caller-supplied
  -- and not guaranteed to be UUID-formatted, so it is never the primary key.
  task_id       text NOT NULL,
  agent_id      text NOT NULL,
  body          jsonb NOT NULL,
  priority      integer NOT NULL DEFAULT 5,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight')),
  -- Random per-claim token. ack/nack/heartbeat must present it, so a lease
  -- operation from a claim that has since expired and been re-claimed by
  -- another worker is a safe no-op instead of corrupting the new claim --
  -- the same compare-and-set principle the approval system uses elsewhere
  -- in this platform.
  lease_token   uuid,
  receive_count integer NOT NULL DEFAULT 0,
  -- A pending row becomes claimable once visible_at <= now(); a claimed row's
  -- visible_at is pushed out by the visibility timeout, and pulled back in by
  -- nack (with backoff) or left alone by heartbeat (extends the lease).
  visible_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tasks_claim_idx ON agent_tasks (agent_id, visible_at, priority DESC);
CREATE INDEX IF NOT EXISTS agent_tasks_task_id_idx ON agent_tasks (task_id);

-- ---------------------------------------------------------------------------
-- Event log (replaces EventBridge)
-- ---------------------------------------------------------------------------
-- Durable, append-only fan-out record. Nothing in this codebase currently
-- subscribes in-process (the EventBridge bus fed external/dashboard
-- consumers at the infra level) -- this table preserves the same
-- publish-and-record contract. A future in-process subscriber can `LISTEN`
-- on the apex_events channel this table's trigger notifies, using the row
-- itself as the durable source of truth if a listener was offline when the
-- notify fired.
CREATE TABLE IF NOT EXISTS agent_events (
  id         bigserial PRIMARY KEY,
  event_type text NOT NULL,
  source     text NOT NULL,
  detail     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_events_type_idx ON agent_events (event_type, created_at DESC);

CREATE OR REPLACE FUNCTION notify_agent_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('apex_events', json_build_object('id', NEW.id, 'event_type', NEW.event_type, 'source', NEW.source)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_events_notify ON agent_events;
CREATE TRIGGER agent_events_notify AFTER INSERT ON agent_events
  FOR EACH ROW EXECUTE FUNCTION notify_agent_event();

-- ---------------------------------------------------------------------------
-- Agent memory (replaces DynamoDB)
-- ---------------------------------------------------------------------------
-- DynamoDB's per-agent isolation was enforced twice: by key-namespacing in
-- code, and by an IAM condition scoping each agent's task role to its own
-- partition. The IAM layer has no direct Postgres equivalent while every
-- agent shares one DATABASE_URL role -- isolation here relies on the
-- application-level agent_id scoping alone (still the primary mechanism
-- DynamoDB relied on; the IAM condition was defense-in-depth against a
-- compromised container specifically). If per-agent database credentials are
-- introduced later, row-level security policies keyed on
-- current_setting('apex.agent_id') would restore an equivalent second layer.
CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id   text NOT NULL,
  tier       text NOT NULL CHECK (tier IN ('working', 'episodic')),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (agent_id, tier, key)
);
CREATE INDEX IF NOT EXISTS agent_memory_prefix_idx ON agent_memory (agent_id, tier, key text_pattern_ops);
