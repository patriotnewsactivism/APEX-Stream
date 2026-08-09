import type { ScoreComponent } from '../api.js';

/**
 * Renders the full scoring breakdown.
 *
 * Excluded signals are shown rather than hidden, with the reason they were
 * dropped. An operator deciding whether to act on a score needs to know that
 * three of eight signals had no data behind them — that is the difference
 * between a finding and a guess.
 */
export function ScoreBreakdown({
  components,
  explanation,
  profile,
  inputHash,
  confidence,
}: {
  components: ScoreComponent[];
  explanation: string;
  profile: string;
  inputHash: string;
  confidence: number;
}): JSX.Element {
  const included = components.filter((c) => c.included);
  const excluded = components.filter((c) => !c.included);
  const maxContribution = Math.max(1, ...included.map((c) => c.contribution));

  return (
    <div>
      <div className="explanation">{explanation}</div>

      <h4 style={{ margin: '0 0 10px', fontSize: 13 }}>
        Signals that counted ({included.length})
      </h4>
      {included
        .slice()
        .sort((a, b) => b.contribution - a.contribution)
        .map((component) => (
          <div key={component.signalId} className="signal">
            <div className="signal-head">
              <span title={component.description}>{component.label}</span>
              <span className="contrib">+{component.contribution.toFixed(1)} pts</span>
            </div>
            <div className="bar">
              <div style={{ width: `${(component.contribution / maxContribution) * 100}%` }} />
            </div>
            <div className="signal-meta">
              raw {formatRaw(component.raw)} → {component.normalized.toFixed(2)} normalised ·
              weight {(component.effectiveWeight * 100).toFixed(0)}% · n={component.sampleSize} · {component.method}
            </div>
            {component.evidence && (
              <div className="signal-meta" style={{ color: 'var(--text)', marginTop: 3 }}>
                ↳ {component.evidence}
              </div>
            )}
          </div>
        ))}

      {excluded.length > 0 && (
        <>
          <h4 style={{ margin: '18px 0 10px', fontSize: 13 }}>
            Signals excluded ({excluded.length}) — weights were redistributed across the rest
          </h4>
          {excluded.map((component) => (
            <div key={component.signalId} className="signal excluded">
              <div className="signal-head">
                <span title={component.description}>{component.label}</span>
                <span className="contrib muted">not counted</span>
              </div>
              <div className="signal-meta">{component.exclusionReason}</div>
            </div>
          ))}
        </>
      )}

      <div className="signal-meta" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        profile {profile} · confidence {(confidence * 100).toFixed(0)}% · input hash{' '}
        <span title="Recomputing the score from the stored signal values must reproduce this hash.">
          {inputHash.slice(0, 16)}…
        </span>
      </div>
    </div>
  );
}

function formatRaw(value: number): string {
  if (Math.abs(value) >= 1000) return value.toExponential(2);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}
