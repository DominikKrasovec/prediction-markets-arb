/**
 * Ω-CONSTRAINTS PARITY — byte-equality against a golden fixture.
 *
 * The golden (`__fixtures__/omega-parity.golden.json`) pins the expected
 * output of the fixture battery: each serialized row — enumerateStates
 * output (sorted), clusterToFacets rows (sorted), and both engines' optimal
 * cost — must match byte-for-byte. Any drift means a change altered an
 * Ω-interpretation or an LP the two solvers emit.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFixtures, computeRow, type ParityRow } from './__fixtures__/omega-parity-fixtures.js';

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'omega-parity.golden.json');
const golden: ParityRow[] = JSON.parse(readFileSync(goldenPath, 'utf8'));

describe('Ω-constraints parity vs pre-Wave-B golden', () => {
  const fixtures = buildFixtures();

  test('golden covers every fixture (no fixture added without regenerating)', () => {
    expect(golden.length).toBe(fixtures.length);
    expect(new Set(golden.map((g) => g.name))).toEqual(new Set(fixtures.map((f) => f.name)));
  });

  for (const fix of fixtures) {
    test(fix.name, async () => {
      const row = await computeRow(fix);
      const g = golden.find((r) => r.name === row.name);
      expect(g).toBeDefined();
      // Byte-equality of the whole serialized row (states + facets + vCost + fCost).
      expect(JSON.stringify(row)).toBe(JSON.stringify(g));
    });
  }
});
