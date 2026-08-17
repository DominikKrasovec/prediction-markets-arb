/**
 * Unit tests for `planBareAliasSweep`, the pure core of `sweepBareAliasScope`.
 *
 * This suite does not stub `@arb/db`: `mock.module('@arb/db', …)` leaks
 * across the whole `bun test` process, hence the pure-core split.
 *
 * What must hold:
 *   - an unscoped team row loses every bare alias and keeps its full name,
 *     fold variants and codes;
 *   - a scoped row keeps a bare alias that only it claims, but loses one
 *     claimed by another entity too;
 *   - league / competition rows are out of scope entirely;
 *   - the plan is idempotent — replanning over the swept state yields
 *     nothing.
 */
import { describe, test, expect } from 'bun:test';
import { planBareAliasSweep, type BareAliasSweepRow } from './seed-entity-kb.js';

const KB = (): BareAliasSweepRow[] => [
  { id: 1837, canonical: 'CA San Lorenzo de Almagro', type: 'team', league_canonical: null,
    aliases: ['casanlorenzodealmagro', 'San Lorenzo', 'San Lorenzo de Almagro', 'sanlorenzo', 'sanlorenzodealmagro'] },
  { id: 1838, canonical: 'Recoleta FC', type: 'team', league_canonical: null, aliases: ['recoletafc', 'Recoleta'] },
  // SCOPED + the bare form is claimed by nobody else → kept.
  { id: 100, canonical: 'Arsenal FC', type: 'team', league_canonical: 'Premier League', aliases: ['Arsenal', 'ARS'] },
  // SCOPED but the bare form is claimed by two entities → dropped from both.
  { id: 200, canonical: 'Rangers FC', type: 'team', league_canonical: 'Scottish Premiership', aliases: ['Rangers'] },
  { id: 201, canonical: 'Queens Park Rangers FC', type: 'team', league_canonical: 'Championship', aliases: ['Rangers'] },
  // A league row: never swept (its league_canonical is NULL by nature).
  { id: 300, canonical: 'Premier League', type: 'league', league_canonical: null, aliases: ['Premier', 'EPL'] },
];

const MULTI_CLAIMED = new Set(['rangers']);

const planFor = (id: number, plans: ReturnType<typeof planBareAliasSweep>) => plans.find((p) => p.id === id);

describe('planBareAliasSweep', () => {
  test('unscoped team rows lose their bare aliases and keep the full name + fold variants', () => {
    const plans = planBareAliasSweep(KB(), MULTI_CLAIMED);

    const p1837 = planFor(1837, plans)!;
    expect(p1837.dropped.sort()).toEqual(['San Lorenzo', 'sanlorenzo']);
    expect(p1837.kept.sort()).toEqual(['San Lorenzo de Almagro', 'casanlorenzodealmagro', 'sanlorenzodealmagro']);
    expect(p1837.unscopedDropped).toBe(2);

    const p1838 = planFor(1838, plans)!;
    expect(p1838.dropped).toEqual(['Recoleta']);
    expect(p1838.kept).toEqual(['recoletafc']);
  });

  test('a SCOPED row keeps a bare alias only it claims', () => {
    expect(planFor(100, planBareAliasSweep(KB(), MULTI_CLAIMED))).toBeUndefined();
  });

  test('a CROSS-CLAIMED bare alias is dropped from every scoped owner', () => {
    const plans = planBareAliasSweep(KB(), MULTI_CLAIMED);
    for (const id of [200, 201]) {
      const p = planFor(id, plans)!;
      expect(p.dropped).toEqual(['Rangers']);
      expect(p.kept).toEqual([]);
      expect(p.crossClaimedDropped).toBe(1);
      expect(p.unscopedDropped).toBe(0);
    }
  });

  test('league / competition rows are never swept', () => {
    expect(planFor(300, planBareAliasSweep(KB(), MULTI_CLAIMED))).toBeUndefined();
  });

  test('IDEMPOTENT: replanning over the swept state yields NO further changes', () => {
    const rows = KB();
    const first = planBareAliasSweep(rows, MULTI_CLAIMED);
    expect(first.length).toBe(4);
    const swept = rows.map((r) => {
      const p = planFor(r.id, first);
      return p ? { ...r, aliases: p.kept } : r;
    });
    expect(planBareAliasSweep(swept, MULTI_CLAIMED)).toEqual([]);
  });

  test('a converged KB (no bare aliases) plans nothing', () => {
    const rows: BareAliasSweepRow[] = [
      { id: 1, canonical: 'Recoleta FC', type: 'team', league_canonical: null, aliases: ['recoletafc'] },
    ];
    expect(planBareAliasSweep(rows, new Set())).toEqual([]);
  });

  test('JSONB arriving as a STRING is parsed (pg driver variance)', () => {
    const rows: BareAliasSweepRow[] = [
      { id: 1838, canonical: 'Recoleta FC', type: 'team', league_canonical: null, aliases: '["recoletafc","Recoleta"]' },
    ];
    expect(planBareAliasSweep(rows, new Set())[0]!.dropped).toEqual(['Recoleta']);
  });
});
