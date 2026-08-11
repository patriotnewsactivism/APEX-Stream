import { useCallback, useEffect, useState } from 'react';
import { api, type CommentCategory, type QueuedComment, type ReplyDraft, type YouTubeStatus } from '../api.js';

/**
 * Comment triage.
 *
 * Two lists, because they are two different jobs. The queue is "what is being
 * said" — read, judge, label. The drafts list is "what would go out under my
 * name" — read, edit, send or discard. Mixing them would mean every glance at
 * the conversation is also a prompt to publish something, which is exactly the
 * pressure this screen should not apply.
 *
 * Nothing here hides, deletes or bans. The only outbound action is sending a
 * reply the operator has read.
 */

const CATEGORY_LABEL: Record<CommentCategory, string> = {
  praise: 'Praise',
  question: 'Question',
  neutral: 'Neutral',
  criticism: 'Criticism',
  hostile: 'Hostile',
  harassment: 'Harassment',
  threat: 'Threat',
  spam: 'Spam',
};

/** Maps to the existing band colours so severity reads the same as elsewhere. */
function bandFor(category: CommentCategory | null, severity: number): string {
  if (category === 'threat' || category === 'harassment') return 'critical';
  if (category === 'hostile') return severity >= 0.6 ? 'critical' : 'elevated';
  if (category === 'spam') return 'info';
  if (category === 'criticism') return 'notice';
  return 'info';
}

function num(v: string | number | null): number {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

export function CommentQueue({
  canLabel,
  canApprove,
  canConnect,
}: {
  canLabel: boolean;
  canApprove: boolean;
  canConnect: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<'queue' | 'drafts'>('queue');
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [comments, setComments] = useState<QueuedComment[]>([]);
  const [drafts, setDrafts] = useState<ReplyDraft[]>([]);
  const [filter, setFilter] = useState<CommentCategory | ''>('');
  const [view, setView] = useState<'unreviewed' | 'all' | 'labelled'>('unreviewed');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [s, c, d] = await Promise.all([
        api.youtubeStatus().catch(() => null),
        api.comments({ category: filter || undefined, view }),
        canApprove ? api.replyDrafts() : Promise.resolve([]),
      ]);
      setStatus(s);
      setComments(c);
      setDrafts(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filter, view, canApprove]);

  useEffect(() => {
    void load();
  }, [load]);

  // Complete the Google consent redirect if we came back with a code.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code || !params.get('scope')?.includes('youtube')) return;
    void api
      .connectYouTube(code, `${window.location.origin}/`)
      .then(() => {
        window.history.replaceState({}, '', '/');
        return load();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const label = async (id: string, value: 'troll' | 'not_troll'): Promise<void> => {
    setBusy(id);
    try {
      await api.labelComment(id, value);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const approve = async (draft: ReplyDraft): Promise<void> => {
    const edited = editing[draft.id];
    setBusy(draft.id);
    try {
      await api.approveReply(draft.id, edited && edited !== draft.draft_text ? edited : undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const reject = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await api.rejectReply(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const beginConnect = (): void => {
    if (!status?.clientId) return;
    const redirect = `${window.location.origin}/`;
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: status.clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: OAUTH_SCOPE,
        // Both are required to get a refresh token back. Without them Google
        // returns only a one-hour access token and the connection dies quietly.
        access_type: 'offline',
        prompt: 'consent',
      });
    window.location.href = url;
  };

  if (status && !status.connected) {
    return (
      <div>
        {error && <div className="banner banner-error">{error}</div>}
        <div className="empty">
          <p style={{ maxWidth: '52ch', margin: '0 auto 16px' }}>
            No YouTube channel is connected, so there are no comments to read. Connecting authorises
            APEX Stream to read your comments and live chat, and to post replies you approve — nothing else.
          </p>
          {status.clientId ? (
            canConnect ? (
              <button className="primary" onClick={beginConnect}>Connect your YouTube channel</button>
            ) : (
              <span className="muted">Your role cannot connect an account — an owner or administrator needs to.</span>
            )
          ) : (
            <div className="banner banner-warn" style={{ textAlign: 'left', maxWidth: 560, margin: '0 auto' }}>
              The orchestrator has no <code>YOUTUBE_CLIENT_ID</code> configured. See{' '}
              <code>docs/youtube.md</code> for creating the Google Cloud OAuth client.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="banner banner-error">{error}</div>}

      {status?.lastError && (
        <div className="banner banner-warn">
          <strong>The channel connection reported a problem.</strong> {status.lastError}
        </div>
      )}

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <div className="palette" style={{ marginBottom: 0 }}>
          <button className={tab === 'queue' ? 'primary' : undefined} onClick={() => setTab('queue')}>
            Comments
          </button>
          {canApprove && (
            <button className={tab === 'drafts' ? 'primary' : undefined} onClick={() => setTab('drafts')}>
              Replies awaiting you{drafts.length > 0 ? ` (${drafts.length})` : ''}
            </button>
          )}
        </div>
        <div className="spacer" />
        <button onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spin" /> : 'Refresh'}
        </button>
      </div>

      {tab === 'queue' && (
        <>
          <div className="row wrap" style={{ marginBottom: 14 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value as CommentCategory | '')} style={{ width: 190 }}>
              <option value="">Every category</option>
              {(Object.keys(CATEGORY_LABEL) as CommentCategory[]).map((c) => (
                <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
              ))}
            </select>
            <select value={view} onChange={(e) => setView(e.target.value as typeof view)} style={{ width: 190 }}>
              <option value="unreviewed">Not yet judged by me</option>
              <option value="labelled">Already judged</option>
              <option value="all">Everything</option>
            </select>
            <span className="muted" style={{ fontSize: 12 }}>
              {comments.length} comment{comments.length === 1 ? '' : 's'}
            </span>
          </div>

          {loading && comments.length === 0 ? (
            <div className="empty"><span className="spin" /> Loading comments…</div>
          ) : comments.length === 0 ? (
            <div className="empty">
              Nothing here. Either Warden has not read anything yet, or you have judged everything
              in this filter already.
            </div>
          ) : (
            comments.map((c) => {
              const severity = num(c.severity);
              return (
                <div key={c.id} className="anomaly">
                  <div className="anomaly-head" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <div className="anomaly-score" style={{ color: `var(--${bandFor(c.category, severity)})`, fontSize: 15, minWidth: 92 }}>
                      {c.category ? CATEGORY_LABEL[c.category] : 'unread'}
                    </div>
                    <div className="anomaly-title">
                      <strong style={{ whiteSpace: 'normal' }}>{c.body}</strong>
                      <span>
                        {c.author_display_name} · {relative(c.published_at)} ·{' '}
                        {c.is_live_chat ? 'live chat' : 'video comment'} · {c.source_label}
                      </span>
                      {c.rationale && (
                        <div className="signal-meta" style={{ marginTop: 6 }}>
                          {c.rationale}
                          {c.confidence !== null && ` · ${(num(c.confidence) * 100).toFixed(0)}% confident`}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                      {c.operator_label ? (
                        <span className={`band band-${c.operator_label === 'troll' ? 'critical' : 'info'}`}>
                          you said {c.operator_label === 'troll' ? 'troll' : 'not a troll'}
                        </span>
                      ) : canLabel ? (
                        <div className="row" style={{ gap: 6 }}>
                          <button onClick={() => void label(c.id, 'troll')} disabled={busy === c.id}>
                            Troll
                          </button>
                          <button onClick={() => void label(c.id, 'not_troll')} disabled={busy === c.id}>
                            Not a troll
                          </button>
                        </div>
                      ) : null}
                      {c.author_channel_url && (
                        <a
                          href={c.author_channel_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="muted"
                          style={{ fontSize: 11 }}
                        >
                          view channel
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </>
      )}

      {tab === 'drafts' && canApprove && (
        <>
          {drafts.length === 0 ? (
            <div className="empty">
              No drafts waiting. Warden only drafts a reply where one would actually help — most
              comments do not get one, and that is the intended behaviour.
            </div>
          ) : (
            drafts.map((d) => {
              const text = editing[d.id] ?? d.draft_text;
              const changed = text !== d.draft_text;
              return (
                <div key={d.id} className="panel" style={{ marginBottom: 12 }}>
                  <div className="signal-meta" style={{ marginBottom: 6 }}>
                    {d.author_display_name} wrote{d.category ? ` · ${CATEGORY_LABEL[d.category]}` : ''}
                    {d.is_live_chat ? ' · live chat' : ' · video comment'}
                  </div>
                  <div className="explanation" style={{ marginBottom: 14 }}>{d.comment_body}</div>

                  <div className="field">
                    <label htmlFor={`draft-${d.id}`}>Your reply {changed && <em className="muted">(edited)</em>}</label>
                    <textarea
                      id={`draft-${d.id}`}
                      value={text}
                      rows={3}
                      onChange={(e) => setEditing({ ...editing, [d.id]: e.target.value })}
                      style={{
                        width: '100%', font: 'inherit', background: 'var(--bg)', color: 'var(--text)',
                        border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', resize: 'vertical',
                      }}
                    />
                    <div className="hint">
                      This goes out publicly as your channel, exactly as written here.
                    </div>
                  </div>

                  <div className="row">
                    <button className="primary" onClick={() => void approve(d)} disabled={busy === d.id || !text.trim()}>
                      {busy === d.id ? 'Sending…' : changed ? 'Send edited reply' : 'Send reply'}
                    </button>
                    <button onClick={() => void reject(d.id)} disabled={busy === d.id}>Discard</button>
                    <div className="spacer" />
                    <span className="muted" style={{ fontSize: 11.5 }}>drafted {relative(d.created_at)}</span>
                  </div>
                </div>
              );
            })
          )}
        </>
      )}

      <div className="banner banner-warn" style={{ marginTop: 20 }}>
        <strong>What this screen does not do.</strong> Nothing here hides, deletes, or bans anyone,
        and no reply is ever sent without you pressing send. Marking someone a troll records your
        judgement and nothing more — it does not act on them. Moderation actions are deliberately
        not wired up; ask if you want them, and they will still be yours to trigger.
      </div>
    </div>
  );
}
