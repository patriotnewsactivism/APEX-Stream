import { useEffect, useState } from 'react';
import { api, type BeastPreflight, type Run } from '../api.js';

/**
 * Beast mode control.
 *
 * The design goal is that nobody presses this without knowing what it will
 * cost. Preflight runs on every parameter change, the projection is shown
 * before the button is armed, and the button itself requires a second,
 * explicit confirmation. The rails are enforced server-side regardless — this
 * screen exists so the operator is not surprised, not to enforce anything.
 */
export function BeastControl({ canActivate }: { canActivate: boolean }): JSX.Element {
  const [durationMinutes, setDuration] = useState(30);
  const [budgetUsd, setBudget] = useState(5);
  const [tags, setTags] = useState('');
  const [preflight, setPreflight] = useState<BeastPreflight | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceTags = tags.split(',').map((t) => t.trim()).filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const { run } = await api.activeBeastRun();
        if (!cancelled) setActiveRun(run);
      } catch {
        /* the banner simply will not render */
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!canActivate) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.beastPreflight({ durationMinutes, budgetUsd, sourceTags });
        if (!cancelled) {
          setPreflight(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }, 350); // debounce so dragging a slider does not hammer the API
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [durationMinutes, budgetUsd, tags, canActivate]);

  const activate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.beastActivate({ durationMinutes, budgetUsd, sourceTags });
      setActiveRun(result.run);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (): Promise<void> => {
    if (!activeRun) return;
    setBusy(true);
    try {
      await api.beastDeactivate(activeRun.id);
      setActiveRun(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!canActivate) {
    return (
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          Beast mode requires the operator role. Your account can view the fleet but not command it.
        </p>
      </div>
    );
  }

  if (activeRun) {
    const spent = Number(activeRun.budget.accruedCostUsd);
    const limit = Number(activeRun.budget.maxCostUsd);
    const expires = new Date(activeRun.expiresAt ?? activeRun.expires_at ?? Date.now());
    const remainingMs = expires.getTime() - Date.now();
    return (
      <div className="panel">
        <div className="banner banner-beast">
          <strong>BEAST MODE ACTIVE</strong> — every agent is sweeping every matching source.
        </div>
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <Stat label="Spent" value={`$${spent.toFixed(2)}`} sub={`of $${limit.toFixed(2)} budget`} />
          <Stat
            label="Time left"
            value={remainingMs > 0 ? `${Math.ceil(remainingMs / 60_000)}m` : 'expiring'}
            sub={`ends ${expires.toLocaleTimeString()}`}
          />
          <Stat label="Tasks dispatched" value={String(activeRun.budget.dispatchedTasks)} sub="across the fleet" />
          <Stat label="Concurrency cap" value={String(activeRun.budget.maxConcurrentTasks)} sub="fleet-wide ceiling" />
        </div>
        <div className="bar" style={{ height: 9 }}>
          <div
            style={{
              width: `${Math.min(100, (spent / Math.max(limit, 0.01)) * 100)}%`,
              background: spent / limit > 0.8 ? 'var(--critical)' : undefined,
            }}
          />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 16px' }}>
          The run stops itself when either the budget or the clock runs out. You do not need to remember to turn it off.
        </p>
        <button className="danger" onClick={deactivate} disabled={busy}>
          {busy ? 'Stopping…' : 'Stop Beast mode now'}
        </button>
        {error && <div className="banner banner-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="grid cols-2">
        <div>
          <div className="field">
            <label>Run for (minutes)</label>
            <input
              type="number"
              min={1}
              max={720}
              value={durationMinutes}
              onChange={(e) => setDuration(Math.max(1, Number(e.target.value) || 1))}
            />
            <div className="hint">The run ends itself at this point, whatever else is happening.</div>
          </div>

          <div className="field">
            <label>Hard budget (USD)</label>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={budgetUsd}
              onChange={(e) => setBudget(Math.max(0.5, Number(e.target.value) || 0.5))}
            />
            <div className="hint">Work stops when accrued task cost reaches this. Not a soft target.</div>
          </div>

          <div className="field">
            <label>Limit to source tags (optional)</label>
            <input
              placeholder="news, watch-page, dockets"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
            <div className="hint">Leave empty to sweep every enabled source.</div>
          </div>
        </div>

        <div>
          {preflight ? (
            <>
              <h4 style={{ margin: '0 0 10px', fontSize: 13 }}>Projection</h4>
              <table>
                <thead>
                  <tr><th>Agent</th><th>Sources</th><th>Parallel</th><th>Projected</th></tr>
                </thead>
                <tbody>
                  {preflight.agents.map((agent) => (
                    <tr key={agent.agentId}>
                      <td style={{ textTransform: 'capitalize' }}>{agent.agentId}</td>
                      <td>{agent.sources}</td>
                      <td>{agent.concurrency}</td>
                      <td className="mono">${agent.projectedCostUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3}><strong>Total</strong></td>
                    <td className="mono"><strong>${preflight.projectedCostUsd.toFixed(2)}</strong></td>
                  </tr>
                </tbody>
              </table>

              {preflight.warning && <div className="banner banner-warn" style={{ marginTop: 12 }}>{preflight.warning}</div>}
              {!preflight.allowed && preflight.reason && (
                <div className="banner banner-error" style={{ marginTop: 12 }}>{preflight.reason}</div>
              )}

              <div style={{ marginTop: 16 }}>
                {confirming ? (
                  <div className="row wrap">
                    <button className="beast" onClick={activate} disabled={busy || !preflight.allowed}>
                      {busy ? 'Starting…' : `Yes — spend up to $${budgetUsd.toFixed(2)}`}
                    </button>
                    <button onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
                  </div>
                ) : (
                  <button
                    className="beast"
                    onClick={() => setConfirming(true)}
                    disabled={!preflight.allowed || preflight.totalSources === 0}
                  >
                    Activate Beast mode
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="empty"><span className="spin" /> Calculating…</div>
          )}
          {error && <div className="banner banner-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div>
      <div className="state-label">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div className="signal-meta">{sub}</div>
    </div>
  );
}
