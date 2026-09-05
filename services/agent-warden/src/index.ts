import {
  Agent,
  KmsDataKeyProvider,
  createExecutor,
  startHealthServer,
  type AgentContext,
  type SqlExecutor,
} from '@apex/agent-runtime';
import { decryptEnvelope, rootLogger, type AgentTask, type EnvelopeCiphertext } from '@apex/core';
import { defaultClassifier, type Classifier } from './classify.js';
import { defaultDrafter, type Drafter } from './draft.js';
import { WardenStore, type WardenSource } from './store.js';
import { parseVideoId, YouTubeClient, type OAuthTokens } from '@apex/youtube';

/**
 * Warden — community watch.
 *
 * Reads the operator's own YouTube live chat and video comments, classifies
 * each comment, and drafts a reply where one would help. It does not post, hide,
 * delete or ban. Everything it produces lands in a queue a human works through.
 *
 * That restraint is structural rather than a matter of discipline: Warden's
 * database role can create a `pending` draft and nothing else, and the code that
 * publishes a reply lives in the orchestrator behind a `reply:approve` check.
 * A bug in this service cannot put words on the channel.
 */

interface WardenPayload {
  mode?: 'scheduled' | 'beast';
  sourceId?: string;
  /** Beast mode: keep working until this timestamp. */
  sweepUntil?: string;
}

interface WardenResult {
  comments: number;
  classified: number;
  drafted: number;
}

class Warden extends Agent<WardenPayload, WardenResult> {
  private readonly store = new WardenStore();
  private readonly classifier: Classifier = defaultClassifier(rootLogger.child({ service: 'agent-warden' }));
  private readonly drafter: Drafter = defaultDrafter();
  private youtube: YouTubeClient | null = null;
  private credentialId: string | null = null;

  protected override async handle(task: AgentTask<WardenPayload>, ctx: AgentContext): Promise<WardenResult> {
    const payload = task.payload;
    const totals: WardenResult = { comments: 0, classified: 0, drafted: 0 };

    const client = await this.client(ctx);
    if (!client) {
      ctx.log.warn('no YouTube channel is connected — nothing to read');
      return totals;
    }

    const sources = await this.store.claimSources(payload.sourceId);
    if (sources.length === 0) {
      ctx.log.info('no enabled warden sources');
      return totals;
    }

    const sweepUntil = payload.sweepUntil ? new Date(payload.sweepUntil).getTime() : 0;

    do {
      for (const source of sources) {
        await ctx.keepAlive();
        try {
          const collected =
            source.kind === 'youtube_live_chat'
              ? await this.pollLiveChat(client, source, ctx)
              : await this.pollVideoComments(client, source, ctx);

          totals.comments += collected;
          await this.store.markPolled(source.id, null);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.log.warn('source poll failed', { sourceId: source.id, error: message });
          await this.store.markPolled(source.id, message);
          // A credential problem is not per-source — stop the sweep rather than
          // failing every source in turn against the same dead token.
          if (/token refresh failed|invalid_grant|401/i.test(message)) {
            if (this.credentialId) await this.store.recordCredentialError(this.credentialId, message);
            throw err;
          }
        }
      }

      const processed = await this.triage(ctx);
      totals.classified += processed.classified;
      totals.drafted += processed.drafted;

      if (sweepUntil > Date.now()) await sleep(15_000);
    } while (sweepUntil > Date.now());

    return totals;
  }

  /** Builds the YouTube client from the stored credential, decrypting via KMS. */
  private async client(ctx: AgentContext): Promise<YouTubeClient | null> {
    if (this.youtube) return this.youtube;

    const credential = await this.store.activeCredential();
    if (!credential) return null;
    this.credentialId = credential.id;

    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set to use a stored credential');
    }

    const plaintext = await decryptEnvelope(
      new KmsDataKeyProvider(),
      credential.secret as unknown as EnvelopeCiphertext,
    );
    const tokens = JSON.parse(plaintext.toString('utf8')) as OAuthTokens;

    this.youtube = new YouTubeClient({
      clientId,
      clientSecret,
      tokens,
      // The refreshed access token is intentionally not persisted: it lives an
      // hour, the refresh token is what matters, and rewriting the encrypted
      // blob on every refresh is churn for no benefit.
      onTokenRefreshed: async () => {
        ctx.log.debug('refreshed the YouTube access token');
      },
    });
    return this.youtube;
  }

  /**
   * Reads a page of live chat.
   *
   * Runs at most one page per task: YouTube dictates the polling interval and
   * the cursor is persisted, so the next task resumes exactly where this one
   * stopped even if the container was replaced in between.
   */
  private async pollLiveChat(client: YouTubeClient, source: WardenSource, ctx: AgentContext): Promise<number> {
    const cursor = await this.store.readCursor(source.id);

    if (cursor && cursor.pollAfter.getTime() > Date.now()) return 0;

    let liveChatId = cursor?.liveChatId;
    let videoId: string | null = null;

    if (!liveChatId) {
      const live = await client.activeLiveChatId();
      if (!live) {
        ctx.log.debug('channel is not live', { sourceId: source.id });
        return 0;
      }
      liveChatId = live.liveChatId;
      videoId = live.videoId;
      ctx.log.info('joined live chat', { sourceId: source.id, videoId });
    }

    let page;
    try {
      page = await client.liveChatMessages(liveChatId, cursor?.pageToken ?? undefined);
    } catch (err) {
      // A 403/404 on a chat id usually means the broadcast ended. Drop the
      // cursor so the next task looks for a new one instead of retrying a
      // chat that no longer exists.
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        await this.store.clearCursor(source.id);
        ctx.log.info('live chat ended', { sourceId: source.id });
        return 0;
      }
      throw err;
    }

    let stored = 0;
    for (const message of page.messages) {
      // The operator's own messages and their moderators' are not comments to
      // triage — replying to yourself is noise in the queue.
      if (message.isOwner || message.isModerator) continue;

      const id = await this.store.insertComment({
        sourceId: source.id,
        platformCommentId: message.id,
        platformAuthorId: message.authorChannelId,
        authorDisplayName: message.authorDisplayName,
        authorChannelUrl: message.authorChannelUrl,
        isLiveChat: true,
        liveChatId,
        videoId,
        body: message.text,
        publishedAt: message.publishedAt,
      });
      if (id) stored++;
    }

    await this.store.writeCursor({
      sourceId: source.id,
      liveChatId,
      videoId,
      pageToken: page.nextPageToken,
      pollAfterMs: page.pollingIntervalMillis,
    });

    return stored;
  }

  private async pollVideoComments(client: YouTubeClient, source: WardenSource, ctx: AgentContext): Promise<number> {
    const videoId = parseVideoId(source.url);
    if (!videoId) throw new Error(`could not read a video id out of "${source.url}"`);

    const comments = await client.videoComments(videoId);
    let stored = 0;
    for (const comment of comments) {
      const id = await this.store.insertComment({
        sourceId: source.id,
        platformCommentId: comment.id,
        platformAuthorId: comment.authorChannelId,
        authorDisplayName: comment.authorDisplayName,
        authorChannelUrl: comment.authorChannelUrl,
        isLiveChat: false,
        liveChatId: null,
        videoId: comment.videoId,
        body: comment.text,
        publishedAt: comment.publishedAt,
      });
      if (id) stored++;
    }
    ctx.log.debug('read video comments', { sourceId: source.id, videoId, stored });
    return stored;
  }

  /** Classifies everything unclassified, and drafts where the drafter says to. */
  private async triage(ctx: AgentContext): Promise<{ classified: number; drafted: number }> {
    const pending = await this.store.unclassifiedComments(200);
    let classified = 0;
    let drafted = 0;

    for (const comment of pending) {
      await ctx.keepAlive();
      try {
        const history = await this.store.authorHistory(comment.platformAuthorId, comment.id);
        const input = { author: comment.authorDisplayName, text: comment.body, authorHistory: history };

        const verdict = await this.classifier.classify(input);
        await this.store.saveClassification(comment.id, verdict);
        classified++;

        if (verdict.category !== 'praise' && verdict.category !== 'neutral') {
          await ctx.events.publish('comment.flagged', 'warden', {
            commentId: comment.id,
            category: verdict.category,
            severity: verdict.severity,
            confidence: verdict.confidence,
          });
        }

        const draft = await this.drafter.draft(input, verdict);
        if (draft) {
          await this.store.saveDraft(comment.id, draft.text, draft.model);
          drafted++;
        }
      } catch (err) {
        // One bad comment must not stop the batch — the rest of the queue is
        // more valuable than a clean failure on this one.
        ctx.log.warn('triage failed for a comment', { commentId: comment.id, error: err });
      }
    }

    if (classified > 0) ctx.log.info('triage complete', { classified, drafted });
    return { classified, drafted };
  }

  protected override async onStop(): Promise<void> {
    await this.store.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const log = rootLogger.child({ service: 'agent-warden', agentId: 'warden' });

async function main(): Promise<void> {
  const executor: SqlExecutor = await createExecutor();
  const agent = new Warden({
    agentId: 'warden',
    executor,
  });

  startHealthServer(Number(process.env.PORT ?? 8080), log, () => ({ healthy: true, detail: { agent: 'warden' } }));

  await agent.start();
}

main().catch((err) => {
  log.error('agent failed to start', { error: err });
  process.exit(1);
});
