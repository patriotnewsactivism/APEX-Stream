import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreObservation, DEFAULT_PROFILE } from '../dist/index.js';

const obs = (signalId, raw, sampleSize, evidence) => ({ signalId, raw, sampleSize, evidence });

test('score is 0 with no usable signals and says so explicitly', () => {
  const r = scoreObservation([]);
  assert.equal(r.score, 0);
  assert.equal(r.coverage, 0);
  assert.equal(r.confidence, 0);
  assert.match(r.explanation, /not measured/);
});

test('missing signals are excluded rather than counted as zero', () => {
  // Only one signal present, and it is maximal. If missing signals were
  // zeroed, the score would be ~20. Renormalisation should push it near 100.
  const r = scoreObservation([obs('silent_edit', 1, 1, 'page body changed, no correction notice')]);
  assert.ok(r.score > 95, `expected near-100, got ${r.score}`);
  assert.equal(r.components.filter((c) => c.included).length, 1);
  assert.ok(r.coverage < 0.25);
});

test('coverage and confidence are reported independently of score', () => {
  const thin = scoreObservation([obs('silent_edit', 1, 1)]);
  const thick = scoreObservation([
    obs('silent_edit', 1, 1),
    obs('content_novelty', 1, 4),
    obs('source_divergence', 1, 6),
    obs('watchlist_match', 5, 3),
    obs('velocity_burst', 4, 40),
    obs('amplification_asymmetry', 10000, 30),
    obs('sentiment_shift', 3, 20),
    obs('temporal_anomaly', 1, 40),
  ]);
  assert.ok(thick.confidence > thin.confidence);
  assert.ok(thick.coverage > thin.coverage);
  assert.equal(thick.coverage, 1);
});

test('signals below minimum sample size are excluded with a stated reason', () => {
  const r = scoreObservation([obs('velocity_burst', 9, 2)]); // needs 8 samples
  const c = r.components.find((x) => x.signalId === 'velocity_burst');
  assert.equal(c.included, false);
  assert.match(c.exclusionReason, /needs 8 samples, had 2/);
  assert.equal(r.score, 0);
});

test('contributions sum to the reported score', () => {
  const r = scoreObservation([
    obs('silent_edit', 1, 1),
    obs('content_novelty', 0.6, 3),
    obs('watchlist_match', 2, 2),
  ]);
  const sum = r.components.reduce((s, c) => s + c.contribution, 0);
  assert.ok(Math.abs(sum - r.score) < 0.05, `sum ${sum} vs score ${r.score}`);
});

test('bands follow the profile cut-points', () => {
  assert.equal(scoreObservation([obs('silent_edit', 1, 1)]).band, 'critical');
  assert.equal(scoreObservation([obs('content_novelty', 0.05, 3)]).band, 'info');
});

test('scoring is deterministic and inputHash is stable', () => {
  const input = [obs('silent_edit', 1, 1), obs('content_novelty', 0.42, 5)];
  const a = scoreObservation(input);
  const b = scoreObservation([...input].reverse());
  assert.equal(a.score, b.score);
  assert.equal(a.inputHash, b.inputHash, 'hash must not depend on observation order');
});

test('counterfactuals show what each signal is actually doing', () => {
  const r = scoreObservation([
    obs('silent_edit', 1, 1),
    obs('content_novelty', 0.2, 3),
  ]);
  const cf = r.counterfactuals.find((c) => c.signalId === 'silent_edit');
  assert.ok(cf.scoreIfRemoved < r.score, 'removing the top driver must lower the score');
  assert.ok(cf.scoreIfMaximal >= r.score);
});

test('profile band configuration is respected', () => {
  const strict = { ...DEFAULT_PROFILE, bands: { notice: 10, elevated: 20, critical: 30 } };
  const r = scoreObservation([obs('content_novelty', 0.35, 3)], strict);
  assert.equal(r.band, 'critical');
});
