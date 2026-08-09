import type { AgentStatus } from '../api.js';

const AGENT_BLURB: Record<string, string> = {
  aria: 'Reads text feeds, APIs and dockets. Measures novelty, burst and watchlist density.',
  atlas: 'Re-fetches watched pages and compares them with the archived copy to catch silent edits.',
  sentinel: 'Holds live audio and video streams open, transcribes, and scores each segment.',
  archivist: 'Takes custody of evidence: hashes it, stores it write-once, records the chain.',
};

export function FleetPanel({ agents, loading }: { agents: AgentStatus[]; loading: boolean }): JSX.Element {
  if (loading && agents.length === 0) {
    return <div className="empty"><span className="spin" /> Reading fleet status…</div>;
  }
  if (agents.length === 0) {
    return (
      <div className="empty">
        No agents are reporting. If you have just deployed, ECS tasks take a minute or two to
        register their first heartbeat.
      </div>
    );
  }

  return (
    <div className="grid cols-4">
      {agents.map((agent) => {
        const stale = agent.lastHeartbeatAt
          ? Date.now() - new Date(agent.lastHeartbeatAt).getTime()
          : Number.POSITIVE_INFINITY;
        const load = agent.maxConcurrency > 0 ? agent.activeTasks / agent.maxConcurrency : 0;
        return (
          <div key={agent.id} className={`panel agent-card state-${agent.state}`}>
            <div className="row">
              <h3>{agent.displayName}</h3>
              <div className="spacer" />
              <span className="state-label"><span className="dot" />{agent.state}</span>
            </div>
            <div className="role">{AGENT_BLURB[agent.id] ?? agent.role}</div>

            <div className="bar" title={`${(load * 100).toFixed(0)}% of concurrency ceiling`}>
              <div style={{ width: `${Math.min(100, load * 100)}%` }} />
            </div>

            <div className="agent-stats">
              <div><b>{agent.activeTasks}</b>active</div>
              <div><b>{agent.queue.visible < 0 ? '—' : agent.queue.visible}</b>queued</div>
              <div><b>{agent.maxConcurrency}</b>max</div>
            </div>

            <div className="signal-meta" style={{ marginTop: 10 }}>
              {agent.lastHeartbeatAt
                ? stale > 120_000
                  ? `no heartbeat for ${Math.round(stale / 60_000)}m`
                  : `heartbeat ${Math.round(stale / 1000)}s ago`
                : 'never reported'}
              {agent.version ? ` · ${agent.version}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
