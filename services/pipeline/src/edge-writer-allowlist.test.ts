/**
 * Edge-writer allow-list static test.
 *
 * The guarantee: nothing regains a path to mint deterministic=TRUE edges from
 * mixed provenance. Scans every non-test .ts file under
 * services/pipeline/src for `INSERT INTO implication_edges` and asserts:
 *
 *   1. the file is in the named allow-list (the stage-4 builders +
 *      finalize.ts; node-facts.ts is the single permitted non-writer mention
 *      — a doc comment);
 *   2. every INSERT in an allowed writer uses the EDGE_CONFLICT_SQL chokepoint
 *      tail (string containment on the imported constant — `${EDGE_CONFLICT_SQL}`
 *      interpolation — never a hand-typed re-derivation), checked as
 *      occurrence-count equality: #INSERTs === #tail interpolations.
 *
 * A future rogue writer fails here before it ever reaches a run. Test files
 * are excluded from the scan because they assert on the literal string; they
 * are not runtime write paths.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(import.meta.dir);

/** Writers permitted to INSERT INTO implication_edges (posix-relative to src/). */
const WRITER_ALLOWLIST = new Set<string>([
  'stage4-events/finalize.ts',                 // threshold-ladder builder
  'stage4-events/tournament-edges.ts',         // tier-A + the shared parametrized upsert (tier-B funnels through it)
  'stage4-events/numeric-ladder-xq.ts',
  'stage4-events/exact-score-derived.ts',
  'stage4-events/mutual-exclusion-xq.ts',
  'stage4-events/date-implication-xq.ts',
  'stage4-events/before-date-chain.ts',
  'stage4-events/reach-threshold-chain.ts',
  'stage4-events/margin-winner.ts',
  'stage4-events/spread-winner.ts',
  'stage4-events/fixture-totals.ts',
  'stage4-events/kalshi-strike-ladder.ts',
  'stage4-events/media-release-ladder.ts',
  'stage4-events/scorer-implication.ts',
  'stage4-events/shape-bridge.ts',
  'stage4-events/window-containment.ts',
  'stage4-events/equivalence-edge.ts',
  'stage4-events/election-precondition-edge.ts', // companion to equivalence guard (win⟹ballot)
  'stage4-events/primary-rank-ladder.ts',        // rank-1⟹rank-≤N — PARKED (not wired; uses the chokepoint tail)
  'stage4-events/cross-ref-equivalence-edge.ts',
  // the chokepoint itself (defines the tail and the new-writer insert standard).
  'util/sql-fragments.ts',
]);

/**
 * Files allowed to MENTION the insert statement without being writers.
 * Read-only probe scripts that strip the exported builder SQL (splitting on
 * the 'INSERT INTO implication_edges' header / EDGE_CONFLICT_SQL tail to get
 * a pure pair-SELECT) belong HERE, not in WRITER_ALLOWLIST — as non-writers
 * they carry zero `${EDGE_CONFLICT_SQL}` interpolations and would (correctly)
 * fail the writer tail-count test.
 */
const DOC_MENTION_ALLOWLIST = new Set<string>([
  'stage4-events/node-facts.ts', // doc comment (non-writer)
  // rc1-veto probes: both SET default_transaction_read_only = on and use the
  // literal only as a split() needle to strip the insert header.
  'scripts/rc1-veto-delta-audit.ts',
  'scripts/rc1-veto-parity-probe.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('edge-writer allow-list', () => {
  const files = walk(SRC_ROOT);
  const mentions = files
    .map((p) => ({
      rel: relative(SRC_ROOT, p).replaceAll('\\', '/'),
      content: readFileSync(p, 'utf8'),
    }))
    .filter((f) => f.content.includes('INSERT INTO implication_edges'));

  test('every INSERT INTO implication_edges site is allow-listed', () => {
    const offenders = mentions
      .map((f) => f.rel)
      .filter((rel) => !WRITER_ALLOWLIST.has(rel) && !DOC_MENTION_ALLOWLIST.has(rel));
    expect(offenders).toEqual([]);
  });

  test('every allowed writer uses the EDGE_CONFLICT_SQL chokepoint tail on every INSERT', () => {
    for (const f of mentions) {
      if (DOC_MENTION_ALLOWLIST.has(f.rel)) continue;
      const inserts = countOccurrences(f.content, 'INSERT INTO implication_edges');
      if (f.rel === 'util/sql-fragments.ts') {
        // The chokepoint module itself: its inserts are the helper's own
        // template(s); each must interpolate the constant it defines.
        expect(countOccurrences(f.content, '${EDGE_CONFLICT_SQL}')).toBeGreaterThanOrEqual(inserts);
        continue;
      }
      // Writer files: one chokepoint-tail interpolation per INSERT, and the
      // constant must be IMPORTED from the chokepoint module (never re-typed).
      expect(`${f.rel}: ${countOccurrences(f.content, '${EDGE_CONFLICT_SQL}')}`)
        .toBe(`${f.rel}: ${inserts}`);
      expect(f.content).toMatch(/import\s*\{[^}]*EDGE_CONFLICT_SQL[^}]*\}\s*from\s*'[^']*util\/sql-fragments\.js'/);
    }
  });

  test('the doc-mention file carries no conflict tail (it is not a writer)', () => {
    for (const f of mentions) {
      if (!DOC_MENTION_ALLOWLIST.has(f.rel)) continue;
      expect(countOccurrences(f.content, '${EDGE_CONFLICT_SQL}')).toBe(0);
    }
  });

  test('the laundering quartet stays deleted from db/queries/edges.ts', () => {
    const edges = readFileSync(join(SRC_ROOT, 'db/queries/edges.ts'), 'utf8');
    for (const fn of ['upsertLLMEdge', 'upsertRuleEdgesBulk', 'getChainEdges', 'upsertTransitiveEdgesBulk', 'upsertEdgeRow']) {
      expect(edges).not.toContain(`function ${fn}`);
    }
    expect(edges).not.toContain('INSERT INTO implication_edges');
  });
});
