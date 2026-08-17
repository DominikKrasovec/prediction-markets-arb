/**
 * One-shot re-seed of the entity KB. The seed function upserts so it's
 * safe to run on a populated DB — restores any missing seed entities
 * without disturbing the rest.
 */
import { seedStructuralEntities, seedCryptoAssets, seedTeamLeagues } from '../services/pipeline/src/db/seed-entity-kb.js';

// Bypass the threshold gate in seedEntityKB() — call each phase directly
// so missing seeds get restored even when total structural count is high.
// All three functions are upserts (ON CONFLICT DO UPDATE) so this is safe
// to re-run.
const structural = await seedStructuralEntities();
const assets     = await seedCryptoAssets();
console.log(JSON.stringify({ structural, assetsUpserted: assets }, null, 2));
process.exit(0);
