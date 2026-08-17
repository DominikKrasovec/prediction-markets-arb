/**
 * Optional live league-dedup accelerator. Invokes the standing wired guard
 * `seedLeagueDedup()` (services/pipeline/src/db/dedup-leagues.ts) once,
 * out-of-band, against the live KB. The same function always runs on every
 * pipeline tick from seedEntityKB(), so a fresh rebuild self-corrects with no
 * manual steps and this script is never required; it exists only to apply the
 * fold to the live DB before the next rebuild.
 *
 * Idempotent (a converged KB folds nothing). Mutates the live DB (folds
 * duplicate rows via the transactional mergeKnownEntities primitive).
 * Re-resolution of the folded rows' markets rides the next rebuild's Stage 1.
 *
 *   bun run services/pipeline/src/scripts/run-league-dedup.ts
 */
import { endPool } from '@arb/db';
import { seedLeagueDedup } from '../db/dedup-leagues.js';

const r = await seedLeagueDedup();

console.log('=== live league dedup (accelerator) ===');
console.log(`seeds considered:      ${r.seedsConsidered}`);
console.log(`anchors found:         ${r.anchorsFound}`);
console.log(`curated aliases added: ${r.aliasesReasserted}`);
console.log(`dup rows folded:       ${r.rowsFolded} (${r.rowsFoldedLinks} market links moved)`);
console.log(`child fork rows folded: ${r.childRowsFolded}`);
console.log(`collisions left separate (conservative): ${r.rowsLeftSeparate}`);
console.log('');
console.log('--- folds applied ---');
for (const f of r.folds) {
  console.log(`  id=${f.dropId} "${f.dropCanonical}" (${f.dropLinks} links) → id=${f.keepId} "${f.keepCanonical}"`);
}
if (r.leftSeparate.length > 0) {
  console.log('');
  console.log('--- left separate (NOT folded — conservative) ---');
  for (const l of r.leftSeparate) {
    console.log(`  id=${l.candidateId} "${l.candidateCanonical}" ~ seed "${l.seedCanonical}": ${l.reason}`);
  }
}

await endPool();
process.exit(0);
