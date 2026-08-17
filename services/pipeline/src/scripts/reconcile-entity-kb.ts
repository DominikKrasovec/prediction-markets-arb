/**
 * KB reconciler — recomputes `known_entities.domain_category` from the
 * markets currently linked to each entity.
 *
 * The KB is write-once at registration time: when the surrounding logic
 * evolves (e.g. a new domain is added) existing rows are not re-evaluated.
 * Observed drift:
 *
 *   - city entities can get stuck at domain='finance' after weather markets
 *     are ingested if the domain code defaulted to finance.
 *   - an entity stored with type=team, domain=finance can have linked
 *     markets that actually span sports + weather.
 *
 * Strategy:
 *   For each entity, MODE() the `category_unified` of all markets that link
 *   to it (via canonical_subject or participants[]), pass through
 *   `unifiedToDomain`, and update domain_category when it differs.
 *
 * Does NOT change `type` (people can be misclassified but auto-fixing type
 * from category alone is unsafe — separate enrichment pass).
 *
 * Run:
 *   bun services/pipeline/src/scripts/reconcile-entity-kb.ts            # apply
 *   bun services/pipeline/src/scripts/reconcile-entity-kb.ts --dry-run  # report only
 */

import { query, endPool } from '@arb/db';
import { createLogger } from '@arb/logger';
import { unifiedToDomain } from '../db/category-taxonomy.js';

const log = createLogger('kb-reconcile');

interface EntityDrift {
  id: number;
  canonical: string;
  type: string;
  current_domain: string;
  proposed_domain: string;
  n_markets: number;
  category_mode: string;
}

async function findDrift(): Promise<EntityDrift[]> {
  // Join known_entities to every market that references the entity via
  // canonical_subject OR participants[]. Aggregate the category mode.
  // Restrict to entities with >=5 linked markets to avoid noise on long-tail
  // rows (and to avoid rewriting entities whose only links are
  // mis-extracted single-shot subjects).
  return query<EntityDrift>(
    `WITH links AS (
       SELECT ke.id, ke.canonical, ke.type, ke.domain_category AS current_domain,
              m.category_unified
       FROM known_entities ke
       JOIN llm_market_normalizations n
         ON n.canonical_subject = ke.canonical
         OR ke.canonical = ANY(n.participants)
       JOIN markets m ON m.id = n.market_id
       WHERE m.category_unified IS NOT NULL
         AND n.confidence > 0
     ),
     agg AS (
       SELECT id, canonical, type, current_domain,
              MODE() WITHIN GROUP (ORDER BY category_unified) AS category_mode,
              COUNT(*) AS n_markets
       FROM links
       GROUP BY id, canonical, type, current_domain
       HAVING COUNT(*) >= 5
     )
     SELECT id, canonical, type, current_domain, category_mode, n_markets,
            -- proposed_domain computed in JS so the unifiedToDomain mapping
            -- stays in one place
            current_domain AS proposed_domain
     FROM agg
     ORDER BY n_markets DESC`
  );
}

async function applyUpdates(rows: EntityDrift[]): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map(r => r.id);
  const newDomains = rows.map(r => r.proposed_domain);
  const result = await query<{ n: string }>(
    `WITH vals(id, new_domain) AS (
       SELECT * FROM UNNEST($1::int[], $2::text[])
     )
     UPDATE known_entities ke
        SET domain_category = v.new_domain,
            updated_at = NOW()
       FROM vals v
      WHERE ke.id = v.id
        AND ke.domain_category IS DISTINCT FROM v.new_domain
      RETURNING 1 AS n`,
    [ids, newDomains],
  );
  return result.length;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  log.info(`Reconciling entity domain_category from linked-market category_unified${dryRun ? ' (DRY-RUN)' : ''}`);

  const candidates = await findDrift();
  log.info(`Loaded ${candidates.length} entities with >=5 linked markets`);

  // Apply the unifiedToDomain mapping in JS so it stays canonical with
  // category-taxonomy.ts (which is what every other consumer uses).
  const drift: EntityDrift[] = [];
  for (const row of candidates) {
    const proposed = unifiedToDomain(row.category_mode);
    if (proposed !== row.current_domain) {
      drift.push({ ...row, proposed_domain: proposed });
    }
  }

  log.info(`Found ${drift.length} entities whose domain_category differs from the linked-market mode`);

  // Group by transition for the summary
  const transitions = new Map<string, number>();
  for (const d of drift) {
    const key = `${d.current_domain} → ${d.proposed_domain}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    log.info(`  ${k}: ${v} entities`);
  }

  // Sample first 10 of each transition for the log
  const samplesByTrans = new Map<string, EntityDrift[]>();
  for (const d of drift) {
    const k = `${d.current_domain} → ${d.proposed_domain}`;
    const arr = samplesByTrans.get(k) ?? [];
    if (arr.length < 5) arr.push(d);
    samplesByTrans.set(k, arr);
  }
  for (const [k, samples] of samplesByTrans.entries()) {
    log.info(`  Sample of ${k}:`);
    for (const s of samples) {
      log.info(`    [${s.id}] ${s.canonical} (type=${s.type}, ${s.n_markets} markets, mode=${s.category_mode})`);
    }
  }

  if (dryRun) {
    log.info('Dry-run mode — no updates applied');
  } else {
    const updated = await applyUpdates(drift);
    log.info(`Updated domain_category on ${updated} entities`);
  }

  await endPool();
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
