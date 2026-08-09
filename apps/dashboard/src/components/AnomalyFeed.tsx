import { useState } from 'react';
import type { Anomaly } from '../api.js';
import { ScoreBreakdown } from './ScoreBreakdown.js';

export function AnomalyFeed({
  anomalies,
  loading,
  canAcknowledge,
  onAcknowledge,
}: {
  anomalies: Anomaly[];
  loading: boolean;
  canAcknowledge: boolean;
  onAcknowledge: (id: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading && anomalies.length === 0) {
    return <div className="empty"><span className="spin" /> Loading findings…</div>;
  }
  if (anomalies.length === 0) {
    return (
      <div className="empty">
        Nothing flagged yet. Add sources and run a sweep — or start Beast mode to cover everything at once.
      </div>
    );
  }

  return (
    <div>
      {anomalies.map((anomaly) => {
        const score = Number(anomaly.score);
        const confidence = Number(anomaly.confidence);
        const open = expanded === anomaly.id;
        return (
          <div key={anomaly.id} className="anomaly">
            <div
              className="anomaly-head"
              onClick={() => setExpanded(open ? null : anomaly.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setExpanded(open ? null : anomaly.id);
              }}
            >
              <div className="anomaly-score" style={{ color: `var(--${anomaly.band})` }}>
                {score.toFixed(0)}
              </div>
              <div className="anomaly-title">
                <strong>{anomaly.summary}</strong>
                <span>
                  {anomaly.source_label ?? anomaly.source_id} · {anomaly.detected_by} ·{' '}
                  {new Date(anomaly.detected_at).toLocaleString()}
                  {confidence < 0.5 && ' · low confidence'}
                </span>
              </div>
              <span className={`band band-${anomaly.band}`}>{anomaly.band}</span>
              {anomaly.acknowledged_at ? (
                <span className="muted" style={{ fontSize: 12 }}>✓ {anomaly.acknowledged_by}</span>
              ) : (
                canAcknowledge && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAcknowledge(anomaly.id);
                    }}
                  >
                    Acknowledge
                  </button>
                )
              )}
            </div>

            {open && (
              <div className="anomaly-body">
                <ScoreBreakdown
                  components={anomaly.components ?? []}
                  explanation={anomaly.explanation}
                  profile={`${anomaly.scoring_profile_id}@${anomaly.scoring_profile_version}`}
                  inputHash={anomaly.input_hash}
                  confidence={confidence}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
