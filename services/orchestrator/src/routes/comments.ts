import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { KmsDataKeyProvider } from '@apex/agent-runtime';
import { decryptEnvelope, encryptEnvelope, type EnvelopeCiphertext } from '@apex/core';
import { YouTubeClient, type OAuthTokens } from '@apex/youtube';
import { requirePermission } from '../auth.js';
import type { AuditWriter, Database } from '../db.js';
import type { Config } from '../config.js';
import type { Logger } from '@apex/core';

/**
 * Comment triage and reply approval.
 *
 * This module owns the only code in the system that writes to a platform.
 * Warden reads, classifies and drafts; the act of publishing lives here,
 * behind `reply:approve`, and happens exactly once per approved draft.
 *
 * The rule that shapes the endpoints: a draft becomes a real reply only when a
 * human moves it, and the transition is recorded in the audit ledger with the
 * text that was actually sent — including the operator's edits, which is why
 * `edited_text` is stored separately rather than overwriting the draft.
 */

export interface CommentRouteDeps {
  config: Config;
  db: Database;
  audit: AuditWriter;
  log: Logger;
}

interface CredentialRow {
  id: string;
  platform_account_id: string;
  account_label: string;
  secret: EnvelopeCiphertext;
}

export async function registerCommentRoutes(app: FastifyInstance, deps: CommentRouteDeps): Promise<void> {
  const { db, audit, log } = deps;
  const guard = (permission: string) => requirePermission(permission, audit);

  /** Builds a YouTube client from the stored credential. */
  async function youtubeClient(): Promise<{ client: YouTubeClient; credentialId: string } | null> {
    const credential = await db.one<CredentialRow>(
      `SELECT id, platform_account_id, account_label, secret
         FROM platform_credentials
        WHERE platform = 'youtube' AND revoked_at IS NULL
        ORDER BY connected_at DESC LIMIT 1`,
    );
    if (!credential) return null;

    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are not configured');
    }

    const plaintext = await decryptEnvelope(new KmsDataKeyProvider(), credential.secret);
    const tokens = JSON.parse(plaintext.toString('utf8')) as OAuthTokens;
    return {
      client: new YouTubeClient({ clientId, clientSecret, tokens }),
      credentialId: credential.id,
    };
  }

  // ---- the queue ----------------------------------------------------------

  app.get('/api/comments', { preHandler: guard('comment:read') }, async (request) => {
    const q = z
      .object({
        category: z
          .enum(['praise', 'question', 'neutral', 'criticism', 'hostile', 'harassment', 'threat', 'spam'])
          .optional(),
        // 'unreviewed' hides comments the operator has already labelled — the
        // default, because the queue is a worklist, not an archive.
        view: z.enum(['unreviewed', 'all', 'labelled']).default('unreviewed'),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    return db.query(
      `SELECT c.id, c.author_display_name, c.author_channel_url, c.body, c.published_at,
              c.is_live_chat, c.video_id, s.label AS source_label,
              cc.category, cc.severity, cc.confidence, cc.rationale, cc.model,
              cl.label AS operator_label, cl.labelled_at,
              d.id AS draft_id, d.draft_text, d.status AS draft_status
         FROM comments c
         JOIN sources s ON s.id = c.source_id
         LEFT JOIN comment_classifications cc ON cc.comment_id = c.id
         LEFT JOIN comment_labels cl ON cl.comment_id = c.id
         LEFT JOIN reply_drafts d ON d.comment_id = c.id AND d.status IN ('pending','approved')
        WHERE ($1::text IS NULL OR cc.category = $1)
          AND ($2 = 'all'
               OR ($2 = 'unreviewed' AND cl.comment_id IS NULL)
               OR ($2 = 'labelled' AND cl.comment_id IS NOT NULL))
        -- Worst first, then oldest: the operator should meet the threat before
        -- the mild criticism, whenever it arrived.
        ORDER BY cc.severity DESC NULLS LAST, c.published_at ASC
        LIMIT $3`,
      [q.category ?? null, q.view, q.limit],
    );
  });

  /** The operator's own verdict. Overrides the classifier; triggers nothing. */
  app.post('/api/comments/:id/label', { preHandler: guard('comment:label') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ label: z.enum(['troll', 'not_troll']), note: z.string().max(500).optional() })
      .parse(request.body);

    const row = await db.one(
      `INSERT INTO comment_labels (comment_id, label, note, labelled_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (comment_id) DO UPDATE SET
         label = EXCLUDED.label, note = EXCLUDED.note,
         labelled_by = EXCLUDED.labelled_by, labelled_at = now()
       RETURNING *`,
      [id, body.label, body.note ?? null, request.principal?.username ?? 'unknown'],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });

    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'comment.labelled',
      resourceType: 'comment',
      resourceId: id,
      detail: { label: body.label },
      traceId: request.id,
      outcome: 'allowed',
    });
    return row;
  });

  // ---- reply drafts -------------------------------------------------------

  app.get('/api/replies', { preHandler: guard('reply:read') }, async (request) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return db.query(
      `SELECT d.id, d.comment_id, d.draft_text, d.status, d.model, d.created_at,
              c.author_display_name, c.body AS comment_body, c.is_live_chat,
              cc.category, cc.severity, cc.rationale
         FROM reply_drafts d
         JOIN comments c ON c.id = d.comment_id
         LEFT JOIN comment_classifications cc ON cc.comment_id = c.id
        WHERE d.status = 'pending'
        ORDER BY d.created_at ASC
        LIMIT $1`,
      [q.limit],
    );
  });

  /**
   * Approves a draft and posts it.
   *
   * Posting and recording are ordered deliberately: the row moves to 'approved'
   * first, then the platform call runs, then the row moves to 'posted'. A crash
   * between the two leaves an approved-but-unposted draft, which is visible and
   * recoverable. The reverse order could publish a reply the database has no
   * record of, which is not.
   */
  app.post('/api/replies/:id/approve', { preHandler: guard('reply:approve') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ text: z.string().min(1).max(10_000).optional() }).parse(request.body ?? {});
    const actor = request.principal?.username ?? 'unknown';

    const draft = await db.one<{
      id: string; comment_id: string; draft_text: string; status: string;
      platform_comment_id: string; is_live_chat: boolean; live_chat_id: string | null;
    }>(
      `SELECT d.id, d.comment_id, d.draft_text, d.status,
              c.platform_comment_id, c.is_live_chat, c.live_chat_id
         FROM reply_drafts d JOIN comments c ON c.id = d.comment_id
        WHERE d.id = $1`,
      [id],
    );
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    if (draft.status !== 'pending') {
      return reply.code(409).send({ error: 'not_pending', message: `draft is already ${draft.status}` });
    }

    const text = (body.text ?? draft.draft_text).trim();
    if (!text) return reply.code(400).send({ error: 'empty_reply' });

    const connection = await youtubeClient();
    if (!connection) {
      return reply.code(409).send({
        error: 'not_connected',
        message: 'No YouTube channel is connected, so there is nowhere to post this reply.',
      });
    }

    await db.query(
      `UPDATE reply_drafts SET status = 'approved', edited_text = $2, decided_by = $3, decided_at = now()
        WHERE id = $1`,
      [id, body.text ? text : null, actor],
    );

    try {
      const postedId = draft.is_live_chat && draft.live_chat_id
        ? await connection.client.postLiveChatMessage(draft.live_chat_id, text)
        : await connection.client.replyToComment(draft.platform_comment_id, text);

      await db.query(
        `UPDATE reply_drafts SET status = 'posted', posted_at = now(), posted_comment_id = $2, post_error = NULL
          WHERE id = $1`,
        [id, postedId],
      );

      await audit.append({
        actor,
        actorType: 'human',
        action: 'reply.posted',
        resourceType: 'comment',
        resourceId: draft.comment_id,
        // The sent text goes in the ledger. What was published under the
        // operator's name is exactly the thing worth being able to prove later.
        detail: { text, edited: Boolean(body.text), postedCommentId: postedId },
        traceId: request.id,
        outcome: 'allowed',
      });

      log.info('reply posted', { draftId: id, postedId });
      return { id, status: 'posted', postedCommentId: postedId, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.query(`UPDATE reply_drafts SET status = 'failed', post_error = $2 WHERE id = $1`, [id, message]);
      await audit.append({
        actor,
        actorType: 'human',
        action: 'reply.post_failed',
        resourceType: 'comment',
        resourceId: draft.comment_id,
        detail: { error: message },
        traceId: request.id,
        outcome: 'error',
      });
      return reply.code(502).send({ error: 'post_failed', message });
    }
  });

  app.post('/api/replies/:id/reject', { preHandler: guard('reply:approve') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.one(
      `UPDATE reply_drafts SET status = 'rejected', decided_by = $2, decided_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, request.principal?.username ?? 'unknown'],
    );
    if (!row) return reply.code(409).send({ error: 'not_pending' });

    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'reply.rejected',
      resourceType: 'reply_draft',
      resourceId: id,
      detail: {},
      traceId: request.id,
      outcome: 'allowed',
    });
    return row;
  });

  // ---- connecting a channel ----------------------------------------------

  app.get('/api/youtube/status', { preHandler: guard('credential:read') }, async () => {
    const row = await db.one<{ account_label: string; platform_account_id: string; connected_at: string; last_error: string | null }>(
      `SELECT account_label, platform_account_id, connected_at, last_error
         FROM platform_credentials
        WHERE platform = 'youtube' AND revoked_at IS NULL
        ORDER BY connected_at DESC LIMIT 1`,
    );
    return {
      connected: Boolean(row),
      channel: row ? { id: row.platform_account_id, title: row.account_label } : null,
      connectedAt: row?.connected_at ?? null,
      lastError: row?.last_error ?? null,
      // The dashboard needs this to build the consent URL; it is a public
      // client identifier, not a secret.
      clientId: process.env.YOUTUBE_CLIENT_ID ?? null,
    };
  });

  /**
   * Exchanges an OAuth authorization code for a refresh token and stores it.
   *
   * The refresh token never touches a column in plaintext: it is sealed with a
   * KMS-wrapped data key before the insert, so a database dump on its own
   * discloses nothing usable.
   */
  app.post('/api/youtube/connect', { preHandler: guard('credential:connect') }, async (request, reply) => {
    const body = z.object({ code: z.string().min(1), redirectUri: z.string().url() }).parse(request.body);
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return reply.code(503).send({
        error: 'not_configured',
        message: 'YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are not set on the orchestrator.',
      });
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: body.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: body.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const payload = (await tokenRes.json().catch(() => ({}))) as {
      refresh_token?: string; access_token?: string; expires_in?: number; error?: string; error_description?: string;
    };

    if (!tokenRes.ok || !payload.refresh_token) {
      // No refresh token usually means the account already granted consent and
      // Google withheld it. Say so, rather than reporting a generic failure.
      const message = payload.refresh_token === undefined && tokenRes.ok
        ? 'Google returned no refresh token. Revoke this app under your Google account permissions and authorise again with prompt=consent&access_type=offline.'
        : `${payload.error ?? tokenRes.status}: ${payload.error_description ?? 'token exchange failed'}`;
      return reply.code(400).send({ error: 'exchange_failed', message });
    }

    const tokens: OAuthTokens = {
      refreshToken: payload.refresh_token,
      accessToken: payload.access_token,
      accessExpiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    };

    const channel = await new YouTubeClient({ clientId, clientSecret, tokens }).myChannel();

    const sealed = await encryptEnvelope(
      new KmsDataKeyProvider(),
      JSON.stringify(tokens),
      `youtube:${channel.id}`,
    );

    const row = await db.one(
      `INSERT INTO platform_credentials
         (platform, platform_account_id, account_label, secret, scopes, access_expires_at, connected_by)
       VALUES ('youtube',$1,$2,$3,$4,$5,$6)
       ON CONFLICT (platform, platform_account_id) DO UPDATE SET
         secret = EXCLUDED.secret, account_label = EXCLUDED.account_label,
         scopes = EXCLUDED.scopes, access_expires_at = EXCLUDED.access_expires_at,
         connected_by = EXCLUDED.connected_by, revoked_at = NULL,
         last_error = NULL, updated_at = now()
       RETURNING id, platform_account_id, account_label, connected_at`,
      [
        channel.id,
        channel.title,
        JSON.stringify(sealed),
        ['https://www.googleapis.com/auth/youtube.force-ssl'],
        tokens.accessExpiresAt ? new Date(tokens.accessExpiresAt).toISOString() : null,
        request.principal?.username ?? 'unknown',
      ],
    );

    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'credential.connected',
      resourceType: 'platform_credential',
      resourceId: channel.id,
      detail: { platform: 'youtube', channel: channel.title },
      traceId: request.id,
      outcome: 'allowed',
    });

    log.info('youtube channel connected', { channelId: channel.id, title: channel.title });
    return reply.code(201).send(row);
  });

  app.post('/api/youtube/disconnect', { preHandler: guard('credential:connect') }, async (request) => {
    await db.query(
      `UPDATE platform_credentials SET revoked_at = now(), updated_at = now()
        WHERE platform = 'youtube' AND revoked_at IS NULL`,
    );
    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'credential.revoked',
      resourceType: 'platform_credential',
      resourceId: 'youtube',
      detail: {},
      traceId: request.id,
      outcome: 'allowed',
    });
    return { connected: false };
  });
}
