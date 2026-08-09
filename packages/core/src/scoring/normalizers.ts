/**
 * Normalizers map a raw measurement onto the closed interval [0, 1].
 *
 * Every normalizer is a pure function and is described in plain language so
 * the dashboard can render "why" next to every number without a lookup table.
 */

export interface Normalizer {
  readonly kind: string;
  readonly describe: string;
  apply(raw: number): number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Straight line between min and max; anything outside is pinned to the edge. */
export function linear(min: number, max: number): Normalizer {
  if (max === min) throw new Error('linear normalizer requires max !== min');
  return {
    kind: 'linear',
    describe: `scales linearly from ${min} (0.0) to ${max} (1.0)`,
    apply: (raw) => clamp01((raw - min) / (max - min)),
  };
}

/**
 * Logistic curve over a z-score. Use when the raw value is "standard
 * deviations away from this source's own baseline". steepness controls how
 * fast a mild deviation becomes alarming; 1.0 is a gentle default.
 */
export function logistic(midpoint = 2, steepness = 1): Normalizer {
  return {
    kind: 'logistic',
    describe: `logistic curve centred at ${midpoint}σ (steepness ${steepness})`,
    apply: (raw) => clamp01(1 / (1 + Math.exp(-steepness * (raw - midpoint)))),
  };
}

/** Log scale for counts that span orders of magnitude (shares, views, replies). */
export function logScale(saturationAt: number): Normalizer {
  if (saturationAt <= 1) throw new Error('logScale requires saturationAt > 1');
  const denom = Math.log10(saturationAt);
  return {
    kind: 'log',
    describe: `log10 scale saturating at ${saturationAt}`,
    apply: (raw) => clamp01(Math.log10(Math.max(1, raw)) / denom),
  };
}

/** Hard step. Use sparingly — steps make scores jumpy and hard to explain. */
export function threshold(at: number): Normalizer {
  return {
    kind: 'threshold',
    describe: `0 below ${at}, 1 at or above ${at}`,
    apply: (raw) => (raw >= at ? 1 : 0),
  };
}

/** Pass-through for values already expressed as 0..1. */
export function unit(): Normalizer {
  return { kind: 'unit', describe: 'already normalised 0..1', apply: clamp01 };
}

/** Inverts any normalizer — "low value is the anomalous case". */
export function invert(inner: Normalizer): Normalizer {
  return {
    kind: `inverted:${inner.kind}`,
    describe: `inverse of (${inner.describe})`,
    apply: (raw) => clamp01(1 - inner.apply(raw)),
  };
}
