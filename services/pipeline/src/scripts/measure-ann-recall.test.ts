/**
 * measure-ann-recall — pure tests (no DB).
 *
 * The harness imports GATE_ORDER/gateSql/eventPairGatesSql from
 * ann-candidates.ts directly — the fragments it replays are the production
 * fragments, so there is no separate copy that can drift out of sync. What
 * remains testable here:
 *   - the conjunction the harness replays (allGatesSql) is exactly the
 *     production conjunction (eventPairGatesSql), gate-for-gate, in order;
 *   - the production queries still interpolate eventPairGatesSql (a rewrite
 *     that inlines gates into a query, bypassing the named fragments, would
 *     silently re-open the drift hole — this source check catches it);
 *   - classifyPair precedence.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { allGatesSql, gateSql, GATE_ORDER, classifyPair, type GateName } from './measure-ann-recall.js';
import { eventPairGatesSql } from '../stage3-events/ann-candidates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizeSql(s: string): string {
  return s
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('gate-fragment parity with eventPairGatesSql (drift detector)', () => {
  test('allGatesSql ≡ the production eventPairGatesSql conjunction', () => {
    expect(normalizeSql(allGatesSql('CRYPTO_P', 'HOUR_P'))).toBe(
      normalizeSql(eventPairGatesSql('CRYPTO_P', 'HOUR_P')),
    );
  });

  test('the production conjunction is the ordered join of the named fragments', () => {
    // Guards a rewrite of eventPairGatesSql that adds a conjunct WITHOUT a
    // named GATE_ORDER fragment — such a conjunct would run in production but
    // never be measured per-gate by the harness.
    const joined = GATE_ORDER.map((g) => gateSql(g, 'CRYPTO_P', 'HOUR_P')).join(' AND ');
    expect(normalizeSql(eventPairGatesSql('CRYPTO_P', 'HOUR_P'))).toBe(normalizeSql(joined));
  });

  test('every named gate appears in the conjunction exactly once', () => {
    const all = normalizeSql(allGatesSql('$3', '$4'));
    for (const g of GATE_ORDER) {
      const frag = normalizeSql(gateSql(g, '$3', '$4'));
      expect(all.includes(frag)).toBe(true);
      expect(all.indexOf(frag)).toBe(all.lastIndexOf(frag));
    }
  });

  test('DW-20 participant_set gate is present and named (the 4b49315 regression)', () => {
    expect(GATE_ORDER).toContain('participant_set');
    const frag = gateSql('participant_set', '$3', '$4');
    expect(frag).toContain('participants');
    expect(frag).toContain('condition_date IS NULL');
  });

  test('production ANN queries interpolate eventPairGatesSql (no inline gate copies)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'stage3-events', 'ann-candidates.ts'), 'utf-8');
    // Both the event pass and the market fallback must call the shared
    // conjunction. 2 call sites + the function definition's own name uses.
    const callSites = src.match(/\$\{eventPairGatesSql\('\$\d+', '\$\d+'\)\}/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
  });
});

describe('classifyPair precedence', () => {
  const base = {
    missingEmbedding: false,
    corrupted: false,
    distance: 0.1,
    failingGates: [] as GateName[],
    topkUngated: true,
    topkGated: true,
  };

  test('full production conjunction → retrieved', () => {
    expect(classifyPair({ ...base }, 0.35)).toBe('retrieved');
  });

  test('missing embedding wins over everything', () => {
    expect(classifyPair({ ...base, missingEmbedding: true, corrupted: true }, 0.35)).toBe('missing-embedding');
  });

  test('corruption wins over retrieval (poisoned vectors are never counted as recall)', () => {
    expect(classifyPair({ ...base, corrupted: true }, 0.35)).toBe('embedding-corrupted');
  });

  test('gate failure → blocked-by-gate even when distance is also bad', () => {
    expect(classifyPair({ ...base, failingGates: ['date'] as GateName[], distance: 0.9 }, 0.35)).toBe('blocked-by-gate');
  });

  test('participant_set gate failure classifies like any other gate (DW-20)', () => {
    expect(classifyPair({ ...base, failingGates: ['participant_set'] as GateName[] }, 0.35)).toBe('blocked-by-gate');
  });

  test('gates pass, distance ≥ max → blocked-by-distance', () => {
    expect(classifyPair({ ...base, distance: 0.35 }, 0.35)).toBe('blocked-by-distance');
    expect(classifyPair({ ...base, distance: null }, 0.35)).toBe('blocked-by-distance');
  });

  test('gates pass, distance fine, out-kNN’d → blocked-by-rank', () => {
    expect(classifyPair({ ...base, topkGated: false }, 0.35)).toBe('blocked-by-rank');
  });
});
