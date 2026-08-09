import { linear, logistic, logScale, unit, type Normalizer } from './normalizers.js';

/**
 * A signal is one independent line of evidence that something is unusual.
 * Signals are deliberately small and legible. A score is never a black box —
 * it is a weighted sum of these, and every one of them is shown to the
 * operator with its raw value, its normalised value and its contribution.
 */
export interface SignalDefinition {
  id: string;
  label: string;
  /** Shown in the dashboard tooltip. Write it for a non-engineer. */
  description: string;
  /** Relative importance. Weights are renormalised across included signals. */
  weight: number;
  normalizer: Normalizer;
  /** Below this many underlying samples the signal is excluded, not guessed. */
  minSampleSize: number;
}

export interface SignalObservation {
  signalId: string;
  /** Raw measured value in the signal's own units. */
  raw: number;
  /** How many underlying data points produced `raw`. */
  sampleSize: number;
  /** One sentence the operator can read as justification. */
  evidence?: string;
}

/**
 * The default profile. Tuned for open-source monitoring of news, public
 * records and live broadcast — it favours "this changed unexpectedly" and
 * "the sources disagree" over raw volume, because volume alone is noisy.
 */
export const DEFAULT_SIGNALS: SignalDefinition[] = [
  {
    id: 'velocity_burst',
    label: 'Publication burst',
    description:
      'How far the current publication rate for this source is above its own recent baseline, measured in standard deviations.',
    weight: 0.15,
    normalizer: logistic(2.0, 1.2),
    minSampleSize: 8,
  },
  {
    id: 'content_novelty',
    label: 'Content novelty',
    description:
      'How different this content is from everything already archived for this source. 1.0 means nothing like it has been seen before.',
    weight: 0.12,
    normalizer: unit(),
    minSampleSize: 1,
  },
  {
    id: 'silent_edit',
    label: 'Silent edit',
    description:
      'A previously captured page or record changed without any public correction notice. Strong signal — quiet edits are rarely innocent.',
    weight: 0.2,
    normalizer: unit(),
    minSampleSize: 1,
  },
  {
    id: 'source_divergence',
    label: 'Source divergence',
    description:
      'Independent sources covering the same event materially disagree on the facts.',
    weight: 0.16,
    normalizer: unit(),
    minSampleSize: 2,
  },
  {
    id: 'watchlist_match',
    label: 'Watchlist match',
    description:
      'Density of operator-defined watchlist terms, entities or case numbers appearing in the content.',
    weight: 0.12,
    normalizer: linear(0, 5),
    minSampleSize: 1,
  },
  {
    id: 'amplification_asymmetry',
    label: 'Amplification asymmetry',
    description:
      'Content is spreading far faster than the credibility of its originating source would predict.',
    weight: 0.1,
    normalizer: logScale(10_000),
    minSampleSize: 5,
  },
  {
    id: 'sentiment_shift',
    label: 'Tone shift',
    description:
      'Sudden change in tone relative to how this source normally covers this topic.',
    weight: 0.08,
    normalizer: logistic(1.5, 1.5),
    minSampleSize: 6,
  },
  {
    id: 'temporal_anomaly',
    label: 'Off-cycle timing',
    description:
      'Published far outside this source’s normal publishing window — for example a filing dropped at 2am on a holiday.',
    weight: 0.07,
    normalizer: unit(),
    minSampleSize: 10,
  },
];

export interface ScoringProfile {
  id: string;
  version: string;
  label: string;
  signals: SignalDefinition[];
  /** Score cut-points. Must be ascending and within 0..100. */
  bands: { notice: number; elevated: number; critical: number };
  /** Below this coverage the result is flagged low-confidence. */
  minCoverage: number;
}

export const DEFAULT_PROFILE: ScoringProfile = {
  id: 'apex.default',
  version: '1.0.0',
  label: 'APEX default (open-source monitoring)',
  signals: DEFAULT_SIGNALS,
  bands: { notice: 25, elevated: 50, critical: 75 },
  minCoverage: 0.5,
};
