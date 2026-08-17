import { describe, test, expect } from 'bun:test';
import {
  classifyEpisode,
  directionOf,
  isConverging,
  signConsistencyOf,
  summarizeEpisode,
  type EpisodeSample,
} from './classifier.js';
import { DEFAULT_SENTINEL_CONFIG } from './types.js';

const cfg = DEFAULT_SENTINEL_CONFIG;

const samplesOf = (signed: number[]): EpisodeSample[] =>
  signed.map((s, i) => ({ t: i * 1000, metric: Math.abs(s), signed: s }));

describe('classifyEpisode', () => {
  test('one inactive leg → liveness, even with a perfectly one-directional spread', () => {
    const samples = samplesOf([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    expect(classifyEpisode({ samples, legAActive: true, legBActive: false }, cfg)).toBe('liveness');
    expect(classifyEpisode({ samples, legAActive: false, legBActive: true }, cfg)).toBe('liveness');
  });

  test('persistent one-directional spread + both active → suspect-identity', () => {
    const samples = samplesOf([0.08, 0.09, 0.1, 0.09, 0.1, 0.08, 0.09, 0.1]);
    expect(classifyEpisode({ samples, legAActive: true, legBActive: true }, cfg)).toBe(
      'suspect-identity',
    );
  });

  test('one-directional but the other way (b over a) is still suspect-identity', () => {
    const samples = samplesOf([-0.08, -0.09, -0.1, -0.09, -0.1, -0.08]);
    expect(classifyEpisode({ samples, legAActive: true, legBActive: true }, cfg)).toBe(
      'suspect-identity',
    );
  });

  test('oscillating sign → segmentation-latency', () => {
    const samples = samplesOf([0.08, -0.07, 0.09, -0.08, 0.07, -0.09]);
    expect(classifyEpisode({ samples, legAActive: true, legBActive: true }, cfg)).toBe(
      'segmentation-latency',
    );
  });

  test('converging spread → segmentation-latency even when one-directional', () => {
    const samples = samplesOf([0.2, 0.18, 0.15, 0.12, 0.08, 0.06, 0.05, 0.04]);
    expect(classifyEpisode({ samples, legAActive: true, legBActive: true }, cfg)).toBe(
      'segmentation-latency',
    );
  });
});

describe('isConverging', () => {
  test('needs at least 4 samples', () => {
    expect(isConverging(samplesOf([0.2, 0.01, 0.01]), cfg.convergenceRatio)).toBe(false);
  });

  test('flat spread is not converging', () => {
    expect(isConverging(samplesOf([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), cfg.convergenceRatio)).toBe(
      false,
    );
  });

  test('second half well below first half → converging', () => {
    expect(isConverging(samplesOf([0.2, 0.2, 0.2, 0.05, 0.05, 0.05]), cfg.convergenceRatio)).toBe(
      true,
    );
  });
});

describe('signConsistencyOf / directionOf', () => {
  test('empty / all-zero → consistency 1, direction mixed', () => {
    expect(signConsistencyOf([])).toBe(1);
    expect(signConsistencyOf(samplesOf([0, 0]))).toBe(1);
    expect(directionOf([], cfg.signConsistencyMin)).toBe('mixed');
  });

  test('uniform positive → consistency 1, a-over-b', () => {
    const s = samplesOf([0.1, 0.1, 0.1]);
    expect(signConsistencyOf(s)).toBe(1);
    expect(directionOf(s, cfg.signConsistencyMin)).toBe('a-over-b');
  });

  test('uniform negative → b-over-a', () => {
    expect(directionOf(samplesOf([-0.1, -0.1, -0.1]), cfg.signConsistencyMin)).toBe('b-over-a');
  });

  test('alternating → consistency 0.5, mixed', () => {
    const s = samplesOf([0.1, -0.1, 0.1, -0.1]);
    expect(signConsistencyOf(s)).toBe(0.5);
    expect(directionOf(s, cfg.signConsistencyMin)).toBe('mixed');
  });
});

describe('summarizeEpisode', () => {
  test('aggregates max/mean/last and flags', () => {
    const s = samplesOf([0.06, 0.1, 0.08]);
    const sum = summarizeEpisode(s, cfg);
    expect(sum.samples).toBe(3);
    expect(sum.maxMetric).toBeCloseTo(0.1, 9);
    expect(sum.meanMetric).toBeCloseTo(0.08, 9);
    expect(sum.lastMetric).toBeCloseTo(0.08, 9);
    expect(sum.lastSigned).toBeCloseTo(0.08, 9);
    expect(sum.signConsistency).toBe(1);
    expect(sum.direction).toBe('a-over-b');
    expect(sum.converging).toBe(false);
  });

  test('empty episode summarizes to zeros', () => {
    const sum = summarizeEpisode([], cfg);
    expect(sum.samples).toBe(0);
    expect(sum.maxMetric).toBe(0);
    expect(sum.meanMetric).toBe(0);
    expect(sum.direction).toBe('mixed');
  });
});
