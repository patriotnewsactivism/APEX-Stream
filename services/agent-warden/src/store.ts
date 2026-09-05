import pg from 'pg';
import { loadDatabaseCaBundle } from '@apex/agent-runtime';
import type { Classification } from './classify.js';

/**
 * Warden's database access.
 *
 * Separate from `@apex/agent-runtime`'s `Store` because Warden's tables are
 * disjoint from the observation/anomaly pipeline the other four share, and
 * because its database role is scoped differently: it writes comments,
 * classifications and drafts, and it reads credentials. It has no write path to
 * `reply_drafts.status` beyond creating a pending row — approving is the
 * orchestrator's job, and keeping that out of reach here is the point.
 *
 * `loadDatabaseCaBundle` itself lives in `@apex/agent-runtime` (used by every
 * service's Postgres connection) rather than being copy-pasted here.
 */

export interface WardenSource {
  id: string;
  label: string;
  url: string;
  kind: 'youtube_live_chat' | 'youtube_video';
  intervalSeconds: number;
}

export interface StoredComment {
  id: string;
  platformCommentId: string;
  authorDisplayName: string;
  body: string;
}

export interface EnvelopeJson {
  v: 1;
  alg: 'AES-256-GCM';
  wrappedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  aad: string | null;
}

export class WardenStore {
  private readonly pool: pg.Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      statement_timeout: 20_000,
      ssl:
        process.env.DATABASE_CA_REQUIRED === 'false'
          ? undefined
          : { rejectUnauthorized: true, ca: loadDatabaseCaBundle(process.env.DATABASE_CA_BUNDLE_PATH) },
      application_name: 'apex-warden',
    });
  }

  async claimSources(sourceId?: string): Promise<WardenSource[]> {
    const res = await this.pool.query<{
      id: string; label: string; url: string; kind: WardenSource['kind']; interval_seconds: number;
    }>(
      `SELECT id, label, url, kind, interval_seconds
         FROM sources
        WHERE enabled = true
          AND owner_agent = 'warden'
          AND ($1::uuid IS NULL OR id = $1::uuid)
        ORDER BY last_polled_at ASC NULLS FIRST
        LIMIT 50`,
      [sourceId ?? null],
    );
    return res.rows.map((r) => ({
      id: r.id, label: r.label, url: r.url, kind: r.kind, intervalSeconds: r.interval_seconds,
    }));
  }

  async markPolled(sourceId: string, error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE sources
          SET last_polled_at = now(),
              consecutive_failures = CASE WHEN $2::text IS NULL THEN 0 ELSE consecutive_failures + 1 END,
              last_error = $2
        WHERE id = $1`,
      [sourceId, error],
    );
  }

  /** The active YouTube credential, or null when the channel has not been connected. */
  async activeCredential(): Promise<{ id: string; accountId: string; secret: EnvelopeJson } | null> {
    const res = await this.pool.query<{ id: string; platform_account_id: string; secret: EnvelopeJson }>(
      `SELECT id, platform_account_id, secret
         FROM platform_credentials
        WHERE platform = 'youtube' AND revoked_at IS NULL
        ORDER BY connected_at DESC LIMIT 1`,
    );
    const row = res.rows[0];
    return row ? { id: row.id, accountId: row.platform_account_id, secret: row.secret } : null;
  }

  async recordCredentialError(id: string, error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE platform_credentials SET last_error = $2, updated_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  /**
   * Inserts a comment, or returns null if the platform already gave us this one.
   *
   * Live chat polling windows overlap by design and a reconnect replays the
   * tail, so duplicate delivery is the normal case, not an error case.
   */
  async insertComment(input: {
    sourceId: string;
    platformCommentId: string;
    platformAuthorId: string | null;
    authorDisplayName: string;
    authorChannelUrl: string | null;
    isLiveChat: boolean;
    liveChatId: string | null;
    videoId: string | null;
    body: string;
    publishedAt: string;
  }): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO comments
         (source_id, platform, platform_comment_id, platform_author_id, author_display_name,
          author_channel_url, is_live_chat, live_chat_id, video_id, body, published_at)
       VALUES ($1,'youtube',$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (platform, platform_comment_id) DO NOTHING
       RETURNING id`,
      [
        input.sourceId, input.platformCommentId, input.platformAuthorId, input.authorDisplayName,
        input.authorChannelUrl, input.isLiveChat, input.liveChatId, input.videoId,
        input.body, input.publishedAt,
      ],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Recent comment bodies from one author, oldest first — context for the classifier. */
  async authorHistory(platformAuthorId: string | null, excludeCommentId: string, limit = 5): Promise<string[]> {
    if (!platformAuthorId) return [];
    const res = await this.pool.query<{ body: string }>(
      `SELECT body FROM comments
        WHERE platform = 'youtube' AND platform_author_id = $1 AND id <> $2
        ORDER BY published_at DESC LIMIT $3`,
      [platformAuthorId, excludeCommentId, limit],
    );
    return res.rows.map((r) => r.body).reverse();
  }

  /**
   * Comments with no classification yet, oldest first.
   *
   * Oldest-first matters on a post that is going viral: newest-first would
   * starve the backlog forever while the front of the queue keeps refilling,
   * and the comment the operator most needs to see is rarely the newest one.
   */
  async unclassifiedComments(limit: number): Promise<Array<{
    id: string;
    platformAuthorId: string | null;
    authorDisplayName: string;
    body: string;
  }>> {
    const res = await this.pool.query<{
      id: string; platform_author_id: string | null; author_display_name: string; body: string;
    }>(
      `SELECT c.id, c.platform_author_id, c.author_display_name, c.body
         FROM comments c
         LEFT JOIN comment_classifications cc ON cc.comment_id = c.id
        WHERE cc.comment_id IS NULL
        ORDER BY c.published_at ASC
        LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      platformAuthorId: r.platform_author_id,
      authorDisplayName: r.author_display_name,
      body: r.body,
    }));
  }

  async saveClassification(commentId: string, c: Classification): Promise<void> {
    await this.pool.query(
      `INSERT INTO comment_classifications
         (comment_id, category, severity, confidence, rationale, model)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (comment_id) DO UPDATE SET
         category = EXCLUDED.category, severity = EXCLUDED.severity,
         confidence = EXCLUDED.confidence, rationale = EXCLUDED.rationale,
         model = EXCLUDED.model, classified_at = now()`,
      [commentId, c.category, c.severity, c.confidence, c.rationale, c.model],
    );
  }

  /**
   * Creates a pending draft. Status is always 'pending' — this agent has no
   * path to 'approved', which is what makes approval a human-only transition.
   */
  async saveDraft(commentId: string, text: string, model: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO reply_drafts (comment_id, draft_text, model)
       VALUES ($1,$2,$3)
       ON CONFLICT (comment_id) WHERE status IN ('pending','approved') DO NOTHING`,
      [commentId, text, model],
    );
  }

  // ---- live chat cursors --------------------------------------------------

  async readCursor(sourceId: string): Promise<{ liveChatId: string; pageToken: string | null; pollAfter: Date } | null> {
    const res = await this.pool.query<{ live_chat_id: string; next_page_token: string | null; poll_after: Date }>(
      `SELECT live_chat_id, next_page_token, poll_after FROM live_chat_cursors WHERE source_id = $1`,
      [sourceId],
    );
    const row = res.rows[0];
    return row ? { liveChatId: row.live_chat_id, pageToken: row.next_page_token, pollAfter: row.poll_after } : null;
  }

  async writeCursor(input: {
    sourceId: string;
    liveChatId: string;
    videoId: string | null;
    pageToken: string | null;
    pollAfterMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO live_chat_cursors (source_id, live_chat_id, video_id, next_page_token, poll_after, updated_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' milliseconds')::interval, now())
       ON CONFLICT (source_id) DO UPDATE SET
         live_chat_id = EXCLUDED.live_chat_id, video_id = EXCLUDED.video_id,
         next_page_token = EXCLUDED.next_page_token, poll_after = EXCLUDED.poll_after,
         updated_at = now()`,
      [input.sourceId, input.liveChatId, input.videoId, input.pageToken, String(Math.round(input.pollAfterMs))],
    );
  }

  async clearCursor(sourceId: string): Promise<void> {
    await this.pool.query(`DELETE FROM live_chat_cursors WHERE source_id = $1`, [sourceId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
