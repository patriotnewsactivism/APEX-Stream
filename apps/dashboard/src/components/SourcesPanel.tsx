import { useCallback, useEffect, useState } from 'react';
import { api, type OwnerAgent, type Source, type SourceKind } from '../api.js';

/**
 * Sources panel.
 *
 * `/api/sources` has existed since the first commit, but nothing in the UI
 * ever called it — so the one screen that answers "what is this thing
 * actually watching?" was unreachable outside of curl. This is that screen.
 *
 * The kind -> owning agent mapping is fixed (see docs/agents.md and the
 * `owner_agent` check constraint), so the form derives the agent instead of
 * asking. Making an operator choose both invites a combination the database
 * accepts but no agent ever polls.
 */

interface KindSpec {
  kind: SourceKind;
  label: string;
  agent: OwnerAgent;
  /** What the agent literally does with this source. Plain language, no overselling. */
  does: string;
  polled: boolean;
  urlHint: string;
}

const KINDS: KindSpec[] = [
  {
    kind: 'rss',
    label: 'RSS / Atom feed',
    agent: 'aria',
    does: 'Aria re-reads the feed on a schedule and flags entries that are new, bursty, or match a watchlist term.',
    polled: true,
    urlHint: 'https://example.com/feed.xml',
  },
  {
    kind: 'http_api',
    label: 'HTTP / JSON API',
    agent: 'aria',
    does: 'Aria polls the endpoint and scores the response body the same way it scores a feed entry.',
    polled: true,
    urlHint: 'https://api.example.com/v1/items',
  },
  {
    kind: 'web_page',
    label: 'Web page',
    agent: 'atlas',
    does: 'Atlas re-fetches the page and diffs it against the last archived copy to catch silent edits.',
    polled: true,
    urlHint: 'https://example.com/some/page',
  },
  {
    kind: 'social',
    label: 'Social page',
    agent: 'atlas',
    does:
      'Atlas fetches the page HTML and diffs it, exactly like any other web page. It does not sign in, ' +
      'read comments, or read live chat — see the note below the table.',
    polled: true,
    urlHint: 'https://www.youtube.com/@yourchannel/community',
  },
  {
    kind: 'court_docket',
    label: 'Court docket',
    agent: 'atlas',
    does: 'Atlas fetches the docket page and reports new or altered entries.',
    polled: true,
    urlHint: 'https://www.courtlistener.com/docket/...',
  },
  {
    kind: 'live_stream',
    label: 'Live stream (audio)',
    agent: 'sentinel',
    does:
      'Sentinel holds the audio stream open, cuts it into segments, archives each segment to S3, and ' +
      'transcribes it — only once a transcriber is configured. It captures audio, not chat.',
    polled: false,
    urlHint: 'https://example.com/live/stream.m3u8',
  },
  {
    kind: 'upload',
    label: 'Uploaded evidence',
    agent: 'archivist',
    does: 'Archivist takes custody of material submitted to it. Never polled — nothing is fetched on a schedule.',
    polled: false,
    urlHint: 'A reference URL for provenance',
  },
];

const AGENT_NAMES: Record<OwnerAgent, string> = {
  aria: 'Aria',
  atlas: 'Atlas',
  sentinel: 'Sentinel',
  archivist: 'Archivist',
};

const BLANK = {
  kind: 'rss' as SourceKind,
  label: '',
  url: '',
  intervalMinutes: 15,
  tags: '',
  authority: 0.5,
};

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function SourcesPanel({
  canCreate,
  canUpdate,
}: {
  canCreate: boolean;
  canUpdate: boolean;
}): JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(BLANK);

  const spec = KINDS.find((k) => k.kind === form.kind) ?? KINDS[0]!;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setSources(await api.sources());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.createSource({
        kind: form.kind,
        label: form.label.trim(),
        url: form.url.trim(),
        // Sentinel and Archivist sources are not interval-polled; send 0 rather
        // than a number that would imply a schedule that never runs.
        intervalSeconds: spec.polled ? Math.round(form.intervalMinutes * 60) : 0,
        ownerAgent: spec.agent,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        authority: form.authority,
        enabled: true,
      });
      setForm(BLANK);
      setAdding(false);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (source: Source): Promise<void> => {
    try {
      await api.updateSource(source.id, { enabled: !source.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const valid = form.label.trim().length > 0 && /^https?:\/\/\S+$/.test(form.url.trim());

  return (
    <div>
      {error && <div className="banner banner-error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        {canCreate && (
          <button className={adding ? undefined : 'primary'} onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add a source'}
          </button>
        )}
        <button onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spin" /> : 'Refresh'}
        </button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {sources.length} source{sources.length === 1 ? '' : 's'} ·{' '}
          {sources.filter((s) => s.enabled).length} enabled
        </span>
      </div>

      {adding && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="grid cols-2">
            <div className="field">
              <label htmlFor="src-kind">What kind of source is it?</label>
              <select
                id="src-kind"
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as SourceKind })}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <div className="hint">
                Handled by <strong>{AGENT_NAMES[spec.agent]}</strong>. {spec.does}
              </div>
            </div>

            <div className="field">
              <label htmlFor="src-label">Name it (for your own reference)</label>
              <input
                id="src-label"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. City council agenda page"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="src-url">URL</label>
            <input
              id="src-url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder={spec.urlHint}
            />
            <div className="hint">Must be a full URL starting with http:// or https://</div>
          </div>

          <div className="grid cols-2">
            {spec.polled && (
              <div className="field">
                <label htmlFor="src-interval">Check every (minutes)</label>
                <input
                  id="src-interval"
                  type="number"
                  min={1}
                  max={1440}
                  value={form.intervalMinutes}
                  onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
                />
                <div className="hint">Shorter intervals cost more. 15 minutes is a reasonable default.</div>
              </div>
            )}

            <div className="field">
              <label htmlFor="src-authority">Authority weight ({form.authority.toFixed(2)})</label>
              <input
                id="src-authority"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={form.authority}
                onChange={(e) => setForm({ ...form, authority: Number(e.target.value) })}
              />
              <div className="hint">
                How much this source's signals count toward a finding's score. A primary record gets a high
                weight; an unreliable aggregator gets a low one.
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="src-tags">Tags (comma separated, optional)</label>
            <input
              id="src-tags"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="local-gov, priority"
            />
            <div className="hint">Beast mode targets sources by tag, so tags are how you sweep a subset.</div>
          </div>

          <div className="row">
            <button className="primary" onClick={() => void submit()} disabled={!valid || saving}>
              {saving ? 'Saving…' : 'Add source'}
            </button>
            {!valid && <span className="muted" style={{ fontSize: 12 }}>Needs a name and a valid URL.</span>}
          </div>
        </div>
      )}

      {loading && sources.length === 0 ? (
        <div className="empty">
          <span className="spin" /> Loading sources…
        </div>
      ) : sources.length === 0 ? (
        <div className="empty">
          Nothing is being monitored yet. Every agent works from this list — until something is in it, the
          fleet has nothing to do and Findings will stay empty.
          {canCreate && <div style={{ marginTop: 10 }}>Use “Add a source” above to point it at something.</div>}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Kind</th>
              <th>Agent</th>
              <th>Every</th>
              <th>Last checked</th>
              <th>Health</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => {
              const kind = KINDS.find((k) => k.kind === source.kind);
              return (
                <tr key={source.id} style={source.enabled ? undefined : { opacity: 0.5 }}>
                  <td>
                    <strong>{source.label}</strong>
                    <div className="mono muted" style={{ wordBreak: 'break-all' }}>{source.url}</div>
                    {source.tags.length > 0 && (
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {source.tags.join(' · ')}
                      </div>
                    )}
                  </td>
                  <td>{kind?.label ?? source.kind}</td>
                  <td>{AGENT_NAMES[source.owner_agent] ?? source.owner_agent}</td>
                  <td className="mono">
                    {source.interval_seconds > 0 ? `${Math.round(source.interval_seconds / 60)}m` : '—'}
                  </td>
                  <td className="mono">{relative(source.last_polled_at)}</td>
                  <td>
                    {!source.enabled ? (
                      <span className="muted">disabled</span>
                    ) : source.consecutive_failures > 0 ? (
                      <span style={{ color: 'var(--critical)' }} title={source.last_error ?? undefined}>
                        {source.consecutive_failures} failure
                        {source.consecutive_failures === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--ok)' }}>ok</span>
                    )}
                  </td>
                  <td>
                    {canUpdate && (
                      <button onClick={() => void toggle(source)}>
                        {source.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="banner banner-warn" style={{ marginTop: 20 }}>
        <strong>What this list cannot do yet.</strong> Every agent here only reads. Nothing in APEX Stream
        signs in to YouTube or Facebook, reads live chat or comment threads, posts a reply, hides or deletes
        a comment, or bans an account. A <em>Social page</em> source fetches public page HTML and diffs it —
        that is the whole of it. Live-chat monitoring, comment moderation and automated replies need a new
        agent with platform API credentials; they are not wired up in this build.
      </div>
    </div>
  );
}
