-- APEX Stream — YouTube comment monitoring, classification and approve-first replies
--
-- Adds a fifth agent (Warden) and the tables behind live comment triage.
--
-- Design constraint that shapes this whole migration: the operator decides.
-- Warden reads, classifies and drafts; it never posts and never moderates.
-- A reply reaches YouTube only after a human approves a specific draft, which
-- is why `reply_drafts` is a first-class table with an explicit status
-- machine rather than a nullable column hanging off `comments`.
--
-- Idempotent, in keeping with 001.

-- ---------------------------------------------------------------------------
-- Extend the source and agent enumerations
-- ---------------------------------------------------------------------------
-- 001 declared these constraints inline, so Postgres named them itself. Drop
-- by that generated name and rebuild with the new members.
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (
  kind IN (
    'rss','http_api','web_page','social','court_docket','live_stream','upload',
    -- A channel's live broadcasts: Warden follows whatever is currently live
    -- and reads its chat.
    'youtube_live_chat',
    -- A specific video's top-level comments and replies.
    'youtube_video'
  )
);

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_owner_agent_check;
ALTER TABLE sources ADD CONSTRAINT sources_owner_agent_check CHECK (
  owner_agent IN ('aria','atlas','sentinel','archivist','warden')
);

-- ---------------------------------------------------------------------------
-- Platform credentials
-- ---------------------------------------------------------------------------
-- OAuth refresh tokens are the most dangerous thing this system stores: one
-- grants indefinite write access to the operator's channel. They are held as
-- an `EnvelopeCiphertext` (packages/core/src/security/crypto.ts) — KMS-wrapped
-- AES-256-GCM — so a database dump alone discloses nothing. The plaintext is
-- never written to a column, and the token columns that do exist hold only
-- non-secret metadata.
CREATE TABLE IF NOT EXISTS platform_credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            text NOT NULL CHECK (platform IN ('youtube')),
  -- Channel this grant is for, as the platform identifies it.
  platform_account_id text NOT NULL,
  account_label       text NOT NULL,
  -- EnvelopeCiphertext JSON: { v, alg, wrappedKey, iv, authTag, ciphertext, aad }
  secret              jsonb NOT NULL,
  scopes              text[] NOT NULL DEFAULT '{}',
  -- Access-token expiry, so a refresh can be scheduled before it lapses. The
  -- refresh token itself does not expire on a schedule; it is revoked.
  access_expires_at   timestamptz,
  connected_by        text NOT NULL,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  last_error          text,
  CONSTRAINT platform_credentials_account_uniq UNIQUE (platform, platform_account_id)
);
CREATE INDEX IF NOT EXISTS platform_credentials_active_idx
  ON platform_credentials (platform) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('youtube')),
  -- The platform's own id. Uniqueness on it is what makes ingestion
  -- re-entrant: live chat polling overlaps by design, and a dropped
  -- connection replays the tail of the window.
  platform_comment_id text NOT NULL,
  platform_author_id  text,
  author_display_name text NOT NULL,
  author_channel_url  text,
  -- True for live chat, false for a video comment thread. Live chat is
  -- ephemeral and high-rate; video comments persist and can be edited.
  is_live_chat        boolean NOT NULL DEFAULT false,
  live_chat_id        text,
  video_id            text,
  parent_comment_id   text,
  body                text NOT NULL,
  published_at        timestamptz NOT NULL,
  collected_at        timestamptz NOT NULL DEFAULT now(),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT comments_platform_id_uniq UNIQUE (platform, platform_comment_id)
);
CREATE INDEX IF NOT EXISTS comments_feed_idx ON comments (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS comments_recent_idx ON comments (published_at DESC);
CREATE INDEX IF NOT EXISTS comments_author_idx ON comments (platform, platform_author_id, published_at DESC);

-- ---------------------------------------------------------------------------
-- Classifications
-- ---------------------------------------------------------------------------
-- One row per comment. `rationale` is stored because an operator acting on a
-- classification is entitled to know why it was made — an unexplained
-- "hostile" verdict is not reviewable, and this queue exists to be reviewed.
CREATE TABLE IF NOT EXISTS comment_classifications (
  comment_id     uuid PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  category       text NOT NULL CHECK (category IN (
                   'praise','question','neutral','criticism',
                   'hostile','harassment','threat','spam'
                 )),
  -- 0..1. Severity is about the comment's intensity, confidence is about the
  -- classifier's certainty. They are independent: a clearly-worded mild insult
  -- is high confidence, low severity.
  severity       numeric(4,3) NOT NULL CHECK (severity BETWEEN 0 AND 1),
  confidence     numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale      text NOT NULL,
  model          text NOT NULL,
  classified_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comment_classifications_category_idx
  ON comment_classifications (category, severity DESC);

-- ---------------------------------------------------------------------------
-- Operator labels
-- ---------------------------------------------------------------------------
-- The operator's own verdict, which always outranks the classifier's. Kept
-- separate from `comment_classifications` rather than overwriting it: the
-- disagreement between the two is the only honest measure of whether the
-- classifier is any good on this particular channel's regulars.
CREATE TABLE IF NOT EXISTS comment_labels (
  comment_id   uuid PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  label        text NOT NULL CHECK (label IN ('troll','not_troll')),
  note         text,
  labelled_by  text NOT NULL,
  labelled_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comment_labels_label_idx ON comment_labels (label, labelled_at DESC);

-- ---------------------------------------------------------------------------
-- Reply drafts
-- ---------------------------------------------------------------------------
-- The approve-first queue. A draft is inert until a human moves it to
-- 'approved'; only then does the orchestrator post it. `posted_comment_id`
-- is set from the platform's response, so a draft that reached YouTube can
-- always be traced to the comment it became.
CREATE TABLE IF NOT EXISTS reply_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id         uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  draft_text         text NOT NULL,
  -- Set when the operator rewrites the draft before approving. The original
  -- `draft_text` is never overwritten -- comparing the two is how you find out
  -- whether the drafting prompt is actually pulling its weight.
  edited_text        text,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','posted','failed')),
  model              text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_by         text,
  decided_at         timestamptz,
  posted_at          timestamptz,
  posted_comment_id  text,
  post_error         text
);
-- At most one live draft per comment; rejected and posted drafts are history
-- and may accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS reply_drafts_one_open_idx
  ON reply_drafts (comment_id) WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS reply_drafts_queue_idx ON reply_drafts (status, created_at);

-- ---------------------------------------------------------------------------
-- Live chat polling cursors
-- ---------------------------------------------------------------------------
-- YouTube's liveChatMessages endpoint is cursor-based and tells the caller how
-- long to wait before polling again. Losing the cursor means re-reading the
-- window or missing messages, so it is persisted rather than held in memory --
-- Warden is a Fargate task and can be replaced mid-broadcast.
CREATE TABLE IF NOT EXISTS live_chat_cursors (
  source_id       uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  live_chat_id    text NOT NULL,
  video_id        text,
  next_page_token text,
  poll_after      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
