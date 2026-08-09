import { createHash } from 'node:crypto';
import type { AnomalyBand } from '../types.js';
import {
  DEFAULT_PROFILE,
  type ScoringProfile,
  type SignalDefinition,
  type SignalObservation,
} from './signals.js';

export interface ScoreComponent {
  signalId: string;
  label: string;
  description: string;
  /** Raw measurement in the signal's own units. */
  raw: number;
  /** Raw mapped to 0..1 by the signal's normalizer. */
  normalized: number;
  /** Declared weight from the profile. */
  declaredWeight: number;
  /** Weight after renormalising across the signals actually included. */
  effectiveWeight: number;
  /** Points this component added to the final 0..100 score. */
  contribution: number;
  included: boolean;
  exclusionReason: string | null;
  evidence: string | null;
  /** Plain-language description of the normalizer, for tooltips. */
  method: string;
  sampleSize: number;
}

export interface Counterfactual {
  signalId: string;
  label: string;
  /** Where the score would land if this signal were absent entirely. */
  scoreIfRemoved: number;
  /** Where the score would land if this signal maxed out at 1.0. */
  scoreIfMaximal: number;
}

export interface AnomalyScoreResult {
  score: number;
  band: AnomalyBand;
  /** Fraction of declared weight that had usable data behind it. */
  coverage: number;
  /** coverage adjusted for sample sizes; low confidence != low score. */
  confidence: number;
  components: ScoreComponent[];
  topDrivers: ScoreComponent[];
  counterfactuals: Counterfactual[];
  /** Human-readable one-paragraph justification. */
  explanation: string;
  profileId: string;
  profileVersion: string;
  computedAt: string;
  /** Hash of profile + inputs. Same hash must always yield the same score. */
  inputHash: string;
}

const round = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function bandFor(score: number, profile: ScoringProfile): AnomalyBand {
  if (score >= profile.bands.critical) return 'critical';
  if (score >= profile.bands.elevated) return 'elevated';
  if (score >= profile.bands.notice) return 'notice';
  return 'info';
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compute a transparent anomaly score.
 *
 * Design decisions worth knowing before you tune this:
 *
 * 1. **Missing signals are excluded, not zeroed.** A signal with too little
 *    data does not quietly drag the score toward zero — it is dropped and the
 *    remaining weights are renormalised. Zeroing missing data is the single
 *    most common way scoring systems lie to their operators.
 *
 * 2. **Coverage is reported separately from score.** A score of 80 from two
 *    signals is not the same claim as an 80 from eight, and the operator sees
 *    the difference rather than having it averaged away.
 *
 * 3. **Deterministic.** No randomness, no clock dependence inside the maths.
 *    `inputHash` lets you prove after the fact that a stored score matches the
 *    inputs it claims to come from — which is what makes an archived anomaly
 *    defensible rather than merely asserted.
 */
export function scoreObservation(
  observations: SignalObservation[],
  profile: ScoringProfile = DEFAULT_PROFILE,
): AnomalyScoreResult {
  const byId = new Map<string, SignalObservation>();
  for (const o of observations) byId.set(o.signalId, o);

  const evaluated = profile.signals.map((def) => evaluateSignal(def, byId.get(def.id)));

  const included = evaluated.filter((c) => c.included);
  const includedWeight = included.reduce((sum, c) => sum + c.declaredWeight, 0);
  const totalWeight = profile.signals.reduce((sum, s) => sum + s.weight, 0);
  const coverage = totalWeight === 0 ? 0 : includedWeight / totalWeight;

  // Renormalise so included weights sum to 1.
  for (const c of evaluated) {
    c.effectiveWeight = c.included && includedWeight > 0 ? round(c.declaredWeight / includedWeight) : 0;
    c.contribution = round(c.normalized * c.effectiveWeight * 100, 2);
  }

  const score = round(
    evaluated.reduce((sum, c) => sum + c.contribution, 0),
    2,
  );
  const band = bandFor(score, profile);

  // Confidence penalises both thin coverage and thin samples behind the
  // signals that did make it in.
  const sampleAdequacy =
    included.length === 0
      ? 0
      : included.reduce((sum, c) => {
          const def = profile.signals.find((s) => s.id === c.signalId);
          const need = Math.max(1, def?.minSampleSize ?? 1);
          return sum + Math.min(1, c.sampleSize / (need * 2));
        }, 0) / included.length;
  const confidence = round(Math.sqrt(Math.max(0, coverage) * Math.max(0, sampleAdequacy)), 3);

  const topDrivers = [...included].sort((a, b) => b.contribution - a.contribution).slice(0, 3);

  const counterfactuals = included.map<Counterfactual>((c) => ({
    signalId: c.signalId,
    label: c.label,
    scoreIfRemoved: recomputeWithout(evaluated, c.signalId),
    scoreIfMaximal: recomputeWith(evaluated, c.signalId, 1),
  }));

  const inputHash = createHash('sha256')
    .update(
      stableStringify({
        profile: { id: profile.id, version: profile.version, bands: profile.bands },
        signals: profile.signals.map((s) => ({ id: s.id, w: s.weight, n: s.normalizer.kind })),
        observations: [...byId.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, o]) => ({ id, raw: o.raw, n: o.sampleSize })),
      }),
    )
    .digest('hex');

  return {
    score,
    band,
    coverage: round(coverage, 3),
    confidence,
    components: evaluated,
    topDrivers,
    counterfactuals,
    explanation: explain(score, band, coverage, confidence, topDrivers, evaluated, profile),
    profileId: profile.id,
    profileVersion: profile.version,
    computedAt: new Date().toISOString(),
    inputHash,
  };
}

function evaluateSignal(def: SignalDefinition, obs: SignalObservation | undefined): ScoreComponent {
  const base = {
    signalId: def.id,
    label: def.label,
    description: def.description,
    declaredWeight: def.weight,
    effectiveWeight: 0,
    contribution: 0,
    method: def.normalizer.describe,
  };

  if (!obs) {
    return {
      ...base,
      raw: 0,
      normalized: 0,
      included: false,
      exclusionReason: 'no data collected for this signal',
      evidence: null,
      sampleSize: 0,
    };
  }
  if (!Number.isFinite(obs.raw)) {
    return {
      ...base,
      raw: 0,
      normalized: 0,
      included: false,
      exclusionReason: 'raw value was not a finite number',
      evidence: obs.evidence ?? null,
      sampleSize: obs.sampleSize,
    };
  }
  if (obs.sampleSize < def.minSampleSize) {
    return {
      ...base,
      raw: obs.raw,
      normalized: 0,
      included: false,
      exclusionReason: `needs ${def.minSampleSize} samples, had ${obs.sampleSize}`,
      evidence: obs.evidence ?? null,
      sampleSize: obs.sampleSize,
    };
  }

  return {
    ...base,
    raw: obs.raw,
    normalized: round(def.normalizer.apply(obs.raw)),
    included: true,
    exclusionReason: null,
    evidence: obs.evidence ?? null,
    sampleSize: obs.sampleSize,
  };
}

function recomputeWithout(components: ScoreComponent[], excludeId: string): number {
  const kept = components.filter((c) => c.included && c.signalId !== excludeId);
  const w = kept.reduce((s, c) => s + c.declaredWeight, 0);
  if (w === 0) return 0;
  return round(kept.reduce((s, c) => s + (c.normalized * c.declaredWeight * 100) / w, 0), 2);
}

function recomputeWith(components: ScoreComponent[], signalId: string, normalized: number): number {
  const kept = components.filter((c) => c.included);
  const w = kept.reduce((s, c) => s + c.declaredWeight, 0);
  if (w === 0) return 0;
  return round(
    kept.reduce((s, c) => {
      const n = c.signalId === signalId ? normalized : c.normalized;
      return s + (n * c.declaredWeight * 100) / w;
    }, 0),
    2,
  );
}

function explain(
  score: number,
  band: AnomalyBand,
  coverage: number,
  confidence: number,
  topDrivers: ScoreComponent[],
  all: ScoreComponent[],
  profile: ScoringProfile,
): string {
  if (topDrivers.length === 0) {
    return `No signals had enough data to score against profile ${profile.id}@${profile.version}. Score defaults to 0 and should not be read as "normal" — it means "not measured".`;
  }
  const drivers = topDrivers
    .filter((d) => d.contribution > 0)
    .map((d) => `${d.label} (+${d.contribution.toFixed(1)} pts${d.evidence ? `, ${d.evidence}` : ''})`)
    .join('; ');
  const excluded = all.filter((c) => !c.included);
  const excludedNote =
    excluded.length > 0
      ? ` ${excluded.length} of ${all.length} signals were excluded for insufficient data (${excluded
          .map((e) => e.label)
          .join(', ')}), so weights were renormalised across the rest.`
      : ' All signals had usable data.';
  const confidenceNote =
    confidence < profile.minCoverage
      ? ` Confidence is low (${(confidence * 100).toFixed(0)}%) — treat this as a lead to verify, not a finding.`
      : ` Confidence ${(confidence * 100).toFixed(0)}%, coverage ${(coverage * 100).toFixed(0)}%.`;

  return `Scored ${score.toFixed(1)}/100 (${band}). Principal drivers: ${drivers || 'none contributed positively'}.${excludedNote}${confidenceNote}`;
}
