/**
 * The "inert-by-default" contract for the econ/count price-ladder kinds:
 * they carry an honest Stage-1 label but must NOT be consumed by any
 * kind-gated edge/set rule. Only kalshi-strike-ladder reads them, and even
 * there they stay out of every kind-gated allowlist. This test pins that no
 * future edit admits them into DECISIVE_KINDS / fixture logic / a
 * numeric-ladder or equivalence allowlist.
 */
import { test, expect } from 'bun:test';
import {
  SET_INERT_EVENT_KINDS,
  EVENT_KINDS,
  TERMINAL_MONOTONIC_EVENT_KINDS,
  STAGE_EVENT_KINDS,
  isSetInertEventKind,
} from '@arb/types';
import { DECISIVE_KINDS } from './same-event.js';
import { ONE_HOT_FIXTURE_KINDS } from './finalize.js';
import { FIXTURE_KINDS } from '../stage3-events/guards.js';
import { buildNumericLadderXqEdgesSql } from './numeric-ladder-xq.js';
import { buildEquivalenceEdgesSql } from './equivalence-edge.js';
import { buildMutualExclusionXqEdges } from './mutual-exclusion-xq.js';

const INERT = [...SET_INERT_EVENT_KINDS];

test('SET_INERT_EVENT_KINDS = exactly the two econ/count kinds, all real EVENT_KINDS', () => {
  expect(INERT.sort()).toEqual(['count_threshold', 'econ_indicator_threshold']);
  const known = new Set<string>(EVENT_KINDS);
  for (const k of INERT) expect(known.has(k)).toBe(true);
  expect(isSetInertEventKind('econ_indicator_threshold')).toBe(true);
  expect(isSetInertEventKind('count_threshold')).toBe(true);
  expect(isSetInertEventKind('price_threshold')).toBe(false);
  expect(isSetInertEventKind(null)).toBe(false);
});

test('inert kinds are in NONE of the terminal / stage / decisive / fixture kind SETS', () => {
  for (const k of INERT) {
    expect((TERMINAL_MONOTONIC_EVENT_KINDS as readonly string[]).includes(k)).toBe(false);
    expect((STAGE_EVENT_KINDS as readonly string[]).includes(k)).toBe(false);
    expect(DECISIVE_KINDS.has(k)).toBe(false);
    expect(ONE_HOT_FIXTURE_KINDS.has(k)).toBe(false);
    expect(FIXTURE_KINDS.has(k)).toBe(false);
  }
});

test('inert kinds appear in NO kind-gated edge-builder SQL allowlist (numeric-ladder / equivalence / mutual-exclusion)', () => {
  // These builders hard-code their kind allowlists inline; if a future edit ever
  // adds an inert kind to LADDER_KINDS / PARTICIPANT_KINDS / a winner-mutex list,
  // its literal would surface in the emitted SQL and this pin would fail.
  const numeric = buildNumericLadderXqEdgesSql();
  const equiv = buildEquivalenceEdgesSql();
  const mutex = buildMutualExclusionXqEdges.toString(); // fn source carries the inline SQL
  for (const k of INERT) {
    expect(numeric.includes(`'${k}'`)).toBe(false);
    expect(equiv.includes(`'${k}'`)).toBe(false);
    expect(mutex.includes(`'${k}'`)).toBe(false);
  }
});
