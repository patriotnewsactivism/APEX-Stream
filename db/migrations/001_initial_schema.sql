-- APEX Stream — initial schema
-- Applied by the deploy pipeline. Idempotent so a re-run is harmless.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('rss','http_api','web_page','social','court_docket','live_stream','upload')),
  label                text NOT NULL,
  url                  text NOT NULL,
  interval_seconds     integer NOT NULL DEFAULT 900 CHECK (interval_seconds >= 0),
  enabled              boolean NOT NULL DEFAULT true,
  owner_agent          text NOT NULL CHECK (owner_agent IN ('aria','atlas','sentinel','archivist')),
  tags                 text[] NOT NULL DEFAULT '{}',
  authority            numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (authority BETWEEN 0 AND 1),
  last_polled_at       timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_due_idx ON sources (owner_agent, last_polled_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS sources_tags_idx ON sources USING gin (tags);

-- ---------------------------------------------------------------------------
-- Observations and their raw signal measurements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  collected_by text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  occurred_at  timestamptz,
  title        text,
  content      text NOT NULL,
  content_hash text NOT NULL,
  fingerprint  text,
  url          text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Dedupe key: the same bytes from the same source are one observation.
  CONSTRAINT observations_source_content_uniq UNIQUE (source_id, content_hash)
);
CREATE INDEX IF NOT EXISTS observations_recent_idx ON observations (source_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS observations_url_idx ON observations (source_id, url, collected_at DESC);

-- Raw signal values are kept so a stored score can be recomputed and verified
-- later against the exact inputs it claims to come from.
CREATE TABLE IF NOT EXISTS observation_signals (
  observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  signal_id      text NOT NULL,
  raw            numeric NOT NULL,
  sample_size    integer NOT NULL DEFAULT 1,
  evidence       text,
  PRIMARY KEY (observation_id, signal_id)
);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id                   uuid PRIMARY KEY,
  mode                 text NOT NULL CHECK (mode IN ('single_agent','workflow','beast')),
  status               text NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled','budget_halted','expired')),
  initiated_by         text NOT NULL,
  participating_agents jsonb NOT NULL DEFAULT '[]'::jsonb,
  workflow_id          text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  expires_at           timestamptz NOT NULL,
  budget               jsonb NOT NULL,
  stats                jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status, started_at DESC);
-- At most one Beast run may be active at a time; enforced by the database so a
-- race between two operators cannot double the spend.
CREATE UNIQUE INDEX IF NOT EXISTS runs_single_active_beast_idx
  ON runs ((mode)) WHERE mode = 'beast' AND status = 'running';

-- ---------------------------------------------------------------------------
-- Anomalies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anomalies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                   uuid,
  observation_id           uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  source_id                uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  detected_by              text NOT NULL,
  detected_at              timestamptz NOT NULL DEFAULT now(),
  score                    numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  band                     text NOT NULL CHECK (band IN ('info','notice','elevated','critical')),
  confidence               numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  summary                  text NOT NULL,
  scoring_profile_id       text NOT NULL,
  scoring_profile_version  text NOT NULL,
  components               jsonb NOT NULL,
  input_hash               text NOT NULL,
  explanation              text NOT NULL,
  acknowledged_by          text,
  acknowledged_at          timestamptz
);
CREATE INDEX IF NOT EXISTS anomalies_feed_idx ON anomalies (detected_at DESC);
CREATE INDEX IF NOT EXISTS anomalies_band_idx ON anomalies (band, detected_at DESC);
CREATE INDEX IF NOT EXISTS anomalies_unack_idx ON anomalies (detected_at DESC) WHERE acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence (
  id               uuid PRIMARY KEY,
  anomaly_id       uuid REFERENCES anomalies(id) ON DELETE SET NULL,
  observation_id   uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  captured_by      text NOT NULL,
  captured_at      timestamptz NOT NULL DEFAULT now(),
  s3_bucket        text NOT NULL,
  s3_key           text NOT NULL,
  s3_version_id    text,
  sha256           text NOT NULL,
  bytes            bigint NOT NULL,
  content_type     text NOT NULL,
  retain_until     timestamptz NOT NULL,
  manifest_sha256  text NOT NULL,
  chain_of_custody jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS evidence_anomaly_idx ON evidence (anomaly_id);
CREATE INDEX IF NOT EXISTS evidence_recent_idx ON evidence (captured_at DESC);

-- The application never deletes evidence, and neither does the database.
CREATE OR REPLACE FUNCTION refuse_evidence_deletion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence rows are immutable until their retention date (id=%)', OLD.id
    USING HINT = 'the underlying object is under S3 Object Lock in compliance mode';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_no_delete ON evidence;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
  FOR EACH ROW WHEN (OLD.retain_until > now())
  EXECUTE FUNCTION refuse_evidence_deletion();

-- ---------------------------------------------------------------------------
-- Audit log — hash chained, append only
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  sequence      bigint PRIMARY KEY,
  recorded_at   timestamptz NOT NULL,
  actor         text NOT NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('human','agent','system')),
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address    text,
  user_agent    text,
  trace_id      text,
  outcome       text NOT NULL CHECK (outcome IN ('allowed','denied','error')),
  prev_hash     char(64) NOT NULL,
  entry_hash    char(64) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action, recorded_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log (actor, recorded_at DESC);

-- Rewriting history would silently invalidate the chain; block it outright so
-- the failure is loud and immediate instead of discovered during verification.
CREATE OR REPLACE FUNCTION refuse_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

-- ---------------------------------------------------------------------------
-- Workflows, notifications, watchlist, heartbeats
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','disabled')),
  definition  jsonb NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id                 uuid PRIMARY KEY,
  workflow_id        text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status             text NOT NULL,
  dry_run            boolean NOT NULL DEFAULT false,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  nodes_executed     integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  result             jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_exec_idx ON workflow_executions (workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id                 uuid PRIMARY KEY,
  anomaly_id         uuid REFERENCES anomalies(id) ON DELETE SET NULL,
  run_id             uuid,
  channel            text NOT NULL CHECK (channel IN ('email','sms','webhook','dashboard')),
  target             text NOT NULL,
  subject            text NOT NULL,
  body               text NOT NULL,
  dedupe_key         text NOT NULL,
  status             text NOT NULL CHECK (status IN ('queued','sent','failed','suppressed')),
  suppression_reason text,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (dedupe_key, sent_at DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term       text NOT NULL UNIQUE,
  category   text NOT NULL DEFAULT 'general',
  enabled    boolean NOT NULL DEFAULT true,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  agent_id     text NOT NULL,
  instance_id  text NOT NULL,
  state        text NOT NULL,
  active_tasks integer NOT NULL DEFAULT 0,
  queue_depth  integer NOT NULL DEFAULT 0,
  version      text NOT NULL DEFAULT 'dev',
  emitted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, instance_id)
);
CREATE INDEX IF NOT EXISTS heartbeats_recent_idx ON agent_heartbeats (agent_id, emitted_at DESC);
