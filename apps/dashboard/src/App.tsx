import { useCallback, useEffect, useState } from 'react';
import {
  api, setAccessToken, setUnauthorizedHandler,
  type AgentStatus, type Anomaly, type AuditEntry, type EvidenceItem,
} from './api.js';
import { beginSignIn, can, completeSignIn, loadSession, readAuthConfig, signOut, type Session } from './auth.js';
import { FleetPanel } from './components/FleetPanel.js';
import { BeastControl } from './components/BeastControl.js';
import { AnomalyFeed } from './components/AnomalyFeed.js';
import { EvidenceVault } from './components/EvidenceVault.js';
import { AuditLog } from './components/AuditLog.js';
import { WorkflowCanvas } from './components/WorkflowCanvas.js';

type View = 'fleet' | 'beast' | 'findings' | 'workflows' | 'evidence' | 'audit';

const VIEWS: Array<{ id: View; label: string; permission: string; blurb: string; title: string }> = [
  { id: 'fleet', label: 'Command deck', permission: 'agent:read', title: 'Command deck', blurb: 'Live state of every agent, its queue depth and how hard it is working.' },
  { id: 'beast', label: 'Beast mode', permission: 'agent:read', title: 'Beast mode', blurb: 'Activate the whole fleet at once against every matching source, under a hard cost and time ceiling.' },
  { id: 'findings', label: 'Findings', permission: 'anomaly:read', title: 'Findings', blurb: 'Scored anomalies with the full signal breakdown behind every number.' },
  { id: 'workflows', label: 'Workflows', permission: 'workflow:read', title: 'Workflow builder', blurb: 'Draw automation on a canvas. What you draw is exactly what executes.' },
  { id: 'evidence', label: 'Evidence vault', permission: 'evidence:read', title: 'Evidence vault', blurb: 'Write-once archived artefacts with their chain of custody.' },
  { id: 'audit', label: 'Audit log', permission: 'audit:read', title: 'Audit log', blurb: 'Hash-chained record of every privileged action, including refused ones.' },
];

export function App(): JSX.Element {
  const authConfig = readAuthConfig();
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState<View>('fleet');
  const [error, setError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Complete the OAuth redirect before anything else tries to call the API.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code || !authConfig || session) return;
    void completeSignIn(authConfig, code)
      .then((next) => {
        setSession(next);
        window.history.replaceState({}, '', '/');
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [authConfig, session]);

  useEffect(() => {
    setAccessToken(session?.accessToken ?? null);
    setUnauthorizedHandler(() => setSession(null));
  }, [session]);

  const roles = session?.roles ?? [];

  const refresh = useCallback(async (): Promise<void> => {
    if (!session) return;
    setLoading(true);
    try {
      const [fleet, findings] = await Promise.all([
        can(roles, 'agent:read') ? api.agents() : Promise.resolve([]),
        can(roles, 'anomaly:read') ? api.anomalies({ limit: 50 }) : Promise.resolve([]),
      ]);
      setAgents(fleet);
      setAnomalies(findings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [session, roles]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Heavier panels load on demand rather than on every poll.
  useEffect(() => {
    if (!session) return;
    if (view === 'evidence' && can(roles, 'evidence:read')) {
      void api.evidence(50).then(setEvidence).catch((err) => setError(String(err)));
    }
    if (view === 'audit' && can(roles, 'audit:read')) {
      void api.audit(0, 200).then(setAudit).catch((err) => setError(String(err)));
    }
  }, [view, session, roles]);

  if (!session) {
    return (
      <div className="signin">
        <div className="panel">
          <h1>APEX<span style={{ color: 'var(--accent)' }}>·</span>STREAM</h1>
          <p>Multi-agent monitoring, anomaly detection and evidence custody.</p>
          {error && <div className="banner banner-error">{error}</div>}
          {authConfig ? (
            <button className="primary" style={{ width: '100%' }} onClick={() => void beginSignIn(authConfig)}>
              Sign in
            </button>
          ) : (
            <div className="banner banner-warn">
              Authentication is not configured. Set <code>VITE_COGNITO_DOMAIN</code> and{' '}
              <code>VITE_COGNITO_CLIENT_ID</code> at build time — the deploy pipeline does this from the
              CDK outputs.
            </div>
          )}
        </div>
      </div>
    );
  }

  const visibleViews = VIEWS.filter((v) => can(roles, v.permission));
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">APEX<span>·</span>STREAM</div>
        <nav className="nav">
          {visibleViews.map((entry) => (
            <button
              key={entry.id}
              className={view === entry.id ? 'active' : ''}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="whoami">
          <strong>{session.username}</strong>
          {roles.length ? roles.join(', ') : 'no roles assigned'}
          <button style={{ width: '100%', marginTop: 10 }} onClick={() => signOut(authConfig)}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="page-head">
          <div>
            <h1>{current.title}</h1>
            <p>{current.blurb}</p>
          </div>
          <button onClick={() => void refresh()} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        {roles.length === 0 && (
          <div className="banner banner-warn">
            Your account has no roles assigned, so everything is hidden. An administrator needs to add you
            to a Cognito group (owner, admin, operator, analyst or viewer).
          </div>
        )}

        {view === 'fleet' && <FleetPanel agents={agents} loading={loading} />}
        {view === 'beast' && <BeastControl canActivate={can(roles, 'agent:beast_mode')} />}
        {view === 'findings' && (
          <AnomalyFeed
            anomalies={anomalies}
            loading={loading}
            canAcknowledge={can(roles, 'anomaly:acknowledge')}
            onAcknowledge={(id) => {
              void api.acknowledgeAnomaly(id).then(refresh).catch((err) => setError(String(err)));
            }}
          />
        )}
        {view === 'workflows' && <WorkflowCanvas canEdit={can(roles, 'workflow:create')} />}
        {view === 'evidence' && <EvidenceVault items={evidence} loading={loading} />}
        {view === 'audit' && <AuditLog entries={audit} loading={loading} />}
      </main>
    </div>
  );
}
