/**
 * Golden generator for the Ω-constraints parity test. Freezes enumerateStates +
 * clusterToFacets + both engines' optimal cost across the fixture battery:
 *
 *   node_modules/.bin/tsx services/arb-solver/src/solver/__fixtures__/gen-omega-parity.ts
 *
 * `omega-constraints.parity.test.ts` re-runs the same fixtures and asserts
 * byte-equality against this committed golden. Do not regenerate after
 * refactoring — the whole point is that the golden predates it.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFixtures, computeRow, type ParityRow } from './omega-parity-fixtures.js';

async function main(): Promise<void> {
  const fixtures = buildFixtures();
  const rows: ParityRow[] = [];
  for (const fix of fixtures) rows.push(await computeRow(fix));
  const outPath = join(dirname(fileURLToPath(import.meta.url)), 'omega-parity.golden.json');
  writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`wrote ${rows.length} parity rows → ${outPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
