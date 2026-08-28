export type ModerationDecision = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ESCALATED';

export interface YouTubeCommentIngestRequest {
  commentId: string;
  videoId: string;
  authorDisplayName: string;
  authorChannelId: string;
  textDisplay: string;
  publishedAt: string;
  toxicityScore?: number;
}

export interface DraftQueueItem {
  draftId: string;
  commentId: string;
  suggestedReplyText: string;
  status: ModerationDecision;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reason?: string;
}

export class YouTubeModerationDraftManager {
  private readonly draftStore = new Map<string, DraftQueueItem>();
  private readonly deadLetterQueue: Array<{ payload: unknown; error: string; timestamp: string }> = [];
  private readonly rateLimits = new Map<string, { count: number; windowStart: number }>();
  private readonly maxPerWindow = 100;
  private readonly windowMs = 60000;

  public checkRateLimit(authorChannelId: string): boolean {
    const now = Date.now();
    const current = this.rateLimits.get(authorChannelId) || { count: 0, windowStart: now };
    if (now - current.windowStart > this.windowMs) {
      this.rateLimits.set(authorChannelId, { count: 1, windowStart: now });
      return true;
    }
    if (current.count >= this.maxPerWindow) {
      return false;
    }
    current.count += 1;
    this.rateLimits.set(authorChannelId, current);
    return true;
  }

  public enqueueComment(comment: YouTubeCommentIngestRequest): DraftQueueItem | null {
    try {
      if (!comment.commentId || !comment.videoId || !comment.textDisplay) {
        throw new Error('Invalid comment ingest request: missing required fields');
      }

      if (!this.checkRateLimit(comment.authorChannelId || 'anonymous')) {
        throw new Error(`Rate limit exceeded for author ${comment.authorChannelId}`);
      }

      const draftId = `draft-${comment.commentId}`;
      const toxicity = comment.toxicityScore ?? 0;
      let initialStatus: ModerationDecision = 'PENDING';
      let initialReply = 'Thank you for your comment. We have received your input.';

      if (toxicity > 0.8) {
        initialStatus = 'ESCALATED';
        initialReply = 'This comment flagged high-toxicity and requires operator intervention.';
      }

      const item: DraftQueueItem = {
        draftId,
        commentId: comment.commentId,
        suggestedReplyText: initialReply,
        status: initialStatus,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      this.draftStore.set(draftId, item);
      return item;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.deadLetterQueue.push({
        payload: comment,
        error,
        timestamp: new Date().toISOString(),
      });
      return null;
    }
  }

  public transitionDraft(draftId: string, decision: ModerationDecision, reviewer: string, reason?: string): DraftQueueItem {
    const existing = this.draftStore.get(draftId);
    if (!existing) {
      throw new Error(`Draft ${draftId} not found`);
    }
    existing.status = decision;
    existing.reviewedBy = reviewer;
    existing.reason = reason;
    existing.updatedAt = new Date().toISOString();
    this.draftStore.set(draftId, existing);
    return existing;
  }

  public getDraft(draftId: string): DraftQueueItem | undefined {
    return this.draftStore.get(draftId);
  }

  public getDlq(): ReadonlyArray<{ payload: unknown; error: string; timestamp: string }> {
    return this.deadLetterQueue;
  }
}
