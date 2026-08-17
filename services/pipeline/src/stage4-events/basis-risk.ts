/** Cross-venue settlement basis-risk tagging: stamps a cross-platform mutex/equiv edge `basis_risk='cross_venue_settlement'` when its legs can diverge on a not-played/cancelled/tied event (Kalshi last-fair vs UMA/PM 50-50). Pure telemetry, never changes which edges exist. */

/** Event-kinds whose cross-venue resolution can diverge on a not-played/cancelled/tied/no-award event; deliberately narrow (see FIXTURE_KINDS + championship_winner). */
export const SETTLEMENT_DIVERGENCE_KINDS: ReadonlySet<string> = new Set([
  'match_winner',
  'match_total_metric',
  'match_spread',
  'both_teams_score',
  'exact_score',
  'halftime_leader',
  'match_event_prop',
  'championship_winner',
]);

/** 22 chars — needs implication_edges.basis_risk to be at least VARCHAR(30). */
export const CROSS_VENUE_SETTLEMENT = 'cross_venue_settlement';

/** True when a divergence-kind edge's legs aren't confined to one venue; tests the UNION of both nodes' member platforms, not one representative each. */
export function isCrossVenueSettlementMembers(
  aPlatforms: ReadonlyArray<string | null | undefined>,
  bPlatforms: ReadonlyArray<string | null | undefined>,
  eventKind: string | null,
): boolean {
  if (eventKind == null || !SETTLEMENT_DIVERGENCE_KINDS.has(eventKind)) return false;
  const platforms = new Set<string>();
  for (const p of aPlatforms) if (p != null) platforms.add(p);
  for (const p of bPlatforms) if (p != null) platforms.add(p);
  return platforms.size > 1;
}

export function isCrossVenueSettlement(
  aPlatform: string | null,
  bPlatform: string | null,
  eventKind: string | null,
): boolean {
  return isCrossVenueSettlementMembers([aPlatform], [bPlatform], eventKind);
}

/** Derived from SETTLEMENT_DIVERGENCE_KINDS (no drift). */
const KINDS_SQL = `(${[...SETTLEMENT_DIVERGENCE_KINDS].map((k) => `'${k}'`).join(',')})`;

/** SQL twin of isCrossVenueSettlementMembers; takes question-id expressions, deriving member platforms on the fly via question_members ⋈ markets. */
export function crossVenueSettlementTagSql(
  aQuestionId: string,
  bQuestionId: string,
  eventKind: string,
): string {
  return `CASE
        WHEN ${eventKind} IN ${KINDS_SQL}
         AND (
           SELECT count(DISTINCT m.platform)
           FROM question_members qm
           JOIN markets m ON m.id = qm.market_id
           WHERE qm.question_id IN (${aQuestionId}, ${bQuestionId})
         ) > 1
        THEN '${CROSS_VENUE_SETTLEMENT}'
        ELSE NULL
      END`;
}
