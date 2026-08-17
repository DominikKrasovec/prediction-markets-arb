/**
 * Archives live edges that current builder gates would refuse at build time,
 * so the graph is sound before the next rebuild lands the gates.
 *
 * Safety:
 *   - dry-run by default — prints a per-class count and one summary line; writes nothing.
 *   - `--apply` sets `archived_at = now()` (never DELETE — reversible).
 *   - idempotent — every class filters `archived_at IS NULL`, so a re-run is a no-op.
 *   - read-only-until-apply — no schema change, no mutation of any other table.
 *
 * Each class is either an explicit edge-ID list or a predicate that mirrors
 * the corresponding builder gate 1:1 (so archival and the gate can never drift).
 *
 * Run:  node_modules/.bin/tsx services/pipeline/src/scripts/archive-unsound-edges-2026-07-21.ts          # dry-run
 *       node_modules/.bin/tsx services/pipeline/src/scripts/archive-unsound-edges-2026-07-21.ts --apply  # write
 */
import { query, endPool } from '@arb/db';

const APPLY = process.argv.includes('--apply');

/** A Kalshi series-prefix membership EXISTS test for one edge endpoint (`col` = the
 *  edge's antecedent_question_id / consequent_question_id). Matches when the question
 *  has a Kalshi member whose event_ticker series family equals `prefix`. */
function seriesPrefixExists(col: string, prefix: string): string {
  return `EXISTS (
    SELECT 1 FROM question_members qm
    JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
    JOIN market_metadata_raw r ON r.market_id = m.id
    WHERE qm.question_id = ${col}
      AND split_part(r.raw->>'event_ticker', '-', 1) = '${prefix}'
  )`;
}

interface EdgeClass {
  /** Stable class key (also the summary-line label). */
  name: string;
  /** One-line human note printed with the count. */
  note: string;
  /** SQL selecting the edge ids to archive: MUST `SELECT e.id FROM implication_edges e …`
   *  and MUST include `e.archived_at IS NULL` in its WHERE (idempotency). */
  idsSql: string;
}

/** Explicit-ID class helper. */
function explicit(name: string, note: string, ids: number[]): EdgeClass {
  return {
    name,
    note,
    idsSql: `SELECT e.id FROM implication_edges e
             WHERE e.id = ANY(ARRAY[${ids.join(',')}]::bigint[]) AND e.archived_at IS NULL`,
  };
}

/** Rep-member title lateral for an edge endpoint column. */
function repTitleLateral(alias: string, col: string): string {
  return `LEFT JOIN LATERAL (
    SELECT m.title FROM question_members qm JOIN markets m ON m.id = qm.market_id
    WHERE qm.question_id = ${col} ORDER BY m.id LIMIT 1
  ) ${alias} ON TRUE`;
}

const CLASSES: EdgeClass[] = [
  // conditionId-trusting cross_ref_equiv linking opposite H2H teams.
  explicit(
    'cross_ref_side_flip',
    'B: conditionId-trusting cross_ref_equiv linking OPPOSITE H2H teams (2 live + 2 at-risk unverifiable)',
    [525971058, 537173337, 281397972, 281397980],
  ),

  explicit(
    'colon_suffix_equiv',
    'A8: Predict "<group>: <outcome>" legs equated across DIFFERENT outcome tokens (6 live)',
    [4092025, 4092505, 4092591, 4092638, 4092729, 149333415],
  ),

  // A goal-leader containment (a player's country vs the player himself) is
  // not a mutex.
  explicit(
    'golden_boot_containment',
    'A11: goal-leader containment miscoded as mutex (Lautaro team⊂WC; France⊃Mbappe)',
    [4032496, 4044582],
  ),

  explicit(
    'binding_audit_equiv_fakes',
    'A16: placeholder-question equivs + innings-tie pairs from the binding-constraint audit kill list',
    [2043228, 2043316, 1660484214, 1660484215],
  ),

  explicit(
    'cross_league_mutex',
    'A6: Atlanta NFL×NBA record (9) + LoL×Valorant game/map (6) mutexes across different series families',
    [
      1980219, 1980446, 1980453, 1980548, 1980567, 1980570, 1980862, 1982993, 1993376,
      446705908, 446705902, 446705903, 446705904, 446705905, 446705909,
    ],
  ),

  // Both endpoints fully timestamped and far enough apart on
  // questions.condition_date that they cannot be the same event. Stays at
  // the full-timestamp grain so day-only UTC-precision artifacts are not
  // false-archived.
  {
    name: 'cross_event_ladder',
    note: 'A1: numeric_ladder_xq chaining threshold rungs across DIFFERENT events (>=20h fine-stamp gap OR >=2 calendar days at day grain) — the settlement-violating class',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions c ON c.id = e.consequent_question_id
      WHERE e.edge_type = 'strict_implication' AND e.pattern = 'numeric_ladder_xq'
        AND e.archived_at IS NULL
        AND a.condition_date IS NOT NULL AND c.condition_date IS NOT NULL
        AND (
          -- both fully timestamped, >=20h apart
          (a.condition_date LIKE '%T%' AND c.condition_date LIKE '%T%'
           AND abs(extract(epoch FROM (a.condition_date::timestamptz - c.condition_date::timestamptz))) >= 72000)
          -- calendar-day-grain arm: >=2 days apart at day grain regardless of
          -- timestamp precision — a UTC-rounding artifact is <=1 day, so >=2
          -- days is provably cross-event.
          OR abs(left(a.condition_date, 10)::date - left(c.condition_date, 10)::date) >= 2
        )`,
  },

  // Value laddered across different subjects: folded subjects differ after
  // stripping rank/threshold tokens.
  {
    name: 'cross_subject_ladder',
    note: 'A17: numeric_ladder_xq across DIFFERENT subjects (rank-token-stripped fold mismatch)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions c ON c.id = e.consequent_question_id
      WHERE e.edge_type = 'strict_implication' AND e.pattern = 'numeric_ladder_xq'
        AND e.archived_at IS NULL
        AND a.canonical_subject IS NOT NULL AND c.canonical_subject IS NOT NULL
        -- cheap prefilter: raw inequality before the regex fold
        AND a.canonical_subject <> c.canonical_subject
        AND lower(immutable_unaccent(btrim(regexp_replace(a.canonical_subject, '(top *[0-9]+|[0-9]+ *([+]|plus)|[0-9.]+)', '', 'ig'))))
         <> lower(immutable_unaccent(btrim(regexp_replace(c.canonical_subject, '(top *[0-9]+|[0-9]+ *([+]|plus)|[0-9.]+)', '', 'ig'))))`,
  },

  // Bare 'Match Winner'/'Winner' placeholder questions equated to
  // specific-side questions. Removing an equivalence only splits identities
  // (adds worlds), so this is strictly conservative.
  {
    name: 'placeholder_equiv',
    note: 'A18: equivalence edges with a bare match-winner/winner placeholder endpoint (8 self-contradictory + 130 suspect)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions c ON c.id = e.consequent_question_id
      WHERE e.edge_type = 'equivalence' AND e.archived_at IS NULL
        AND (lower(btrim(a.canonical_subject)) IN ('match winner','winner')
          OR lower(btrim(c.canonical_subject)) IN ('match winner','winner'))`,
  },

  // Strict phrase compare: different-or-NULL-on-one-side mention_phrase can
  // never equate on speech_mention questions.
  {
    name: 'cross_word_mention_equiv',
    note: 'A19: equivalence between speech_mention questions with differing mention_phrase (the Warsh/KXFEDMENTION clique)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qc ON qc.id = e.consequent_question_id
      WHERE e.edge_type = 'equivalence' AND e.archived_at IS NULL
        AND qa.event_kind = 'speech_mention' AND qc.event_kind = 'speech_mention'
        AND (qa.discriminators->>'mention_phrase') IS DISTINCT FROM (qc.discriminators->>'mention_phrase')`,
  },

  {
    name: 'spread_winner_cross_date',
    note: 'A2: spread_winner across ≥2-day-disjoint member dates (different fixtures) + the 3 resolved-violation ids',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions c ON c.id = e.consequent_question_id
      WHERE e.pattern = 'spread_winner' AND e.archived_at IS NULL
        AND (
          e.id = ANY(ARRAY[742696896, 764973477, 916652628]::bigint[])
          OR (
            a.condition_date LIKE '%T%' AND c.condition_date LIKE '%T%'
            AND abs(extract(epoch FROM (a.condition_date::timestamptz - c.condition_date::timestamptz))) >= 172800
          )
        )`,
  },

  {
    name: 'match_winner_placeholder',
    note: 'A3: cross_question_mutex with a match_winner endpoint whose subject is NOT a participant (the bare "Match Winner" placeholder)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions b ON b.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex' AND e.archived_at IS NULL
        AND (
          (a.event_kind = 'match_winner' AND a.participants IS NOT NULL AND cardinality(a.participants) > 0 AND NOT (a.canonical_subject = ANY(a.participants)) AND NOT EXISTS (SELECT 1 FROM unnest(a.participants) AS wp_a(p), LATERAL (SELECT lower(immutable_unaccent(btrim(p))) AS fp, lower(immutable_unaccent(btrim(regexp_replace(a.canonical_subject, ' +(wins?|winner)( +(the +)?(match|fight|game|series|map *[0-9]+|game *[0-9]+))? *$', '', 'i')))) AS fs) f WHERE f.fp = f.fs OR (lower(a.canonical_subject) NOT LIKE '% vs %' AND lower(a.canonical_subject) NOT LIKE '% vs. %' AND lower(a.canonical_subject) NOT LIKE '% @ %' AND ((length(f.fs) >= 5 AND f.fp LIKE '%' || f.fs || '%') OR (length(f.fp) >= 5 AND f.fs LIKE '%' || f.fp || '%')))) AND lower(btrim(a.canonical_subject)) <> 'draw' AND COALESCE(a.discriminators->>'draw_axis','') <> 'draw')
          OR (b.event_kind = 'match_winner' AND b.participants IS NOT NULL AND cardinality(b.participants) > 0 AND NOT (b.canonical_subject = ANY(b.participants)) AND NOT EXISTS (SELECT 1 FROM unnest(b.participants) AS wp_b(p), LATERAL (SELECT lower(immutable_unaccent(btrim(p))) AS fp, lower(immutable_unaccent(btrim(regexp_replace(b.canonical_subject, ' +(wins?|winner)( +(the +)?(match|fight|game|series|map *[0-9]+|game *[0-9]+))? *$', '', 'i')))) AS fs) f WHERE f.fp = f.fs OR (lower(b.canonical_subject) NOT LIKE '% vs %' AND lower(b.canonical_subject) NOT LIKE '% vs. %' AND lower(b.canonical_subject) NOT LIKE '% @ %' AND ((length(f.fs) >= 5 AND f.fp LIKE '%' || f.fs || '%') OR (length(f.fp) >= 5 AND f.fs LIKE '%' || f.fp || '%')))) AND lower(btrim(b.canonical_subject)) <> 'draw' AND COALESCE(b.discriminators->>'draw_axis','') <> 'draw')
        )`,
  },

  // Predicate mirror of countSpreadSameTeamViolations (same folded /
  // substring team).
  {
    name: 'spread_same_team_mutex',
    note: 'A9: cross_question_mutex_spread whose two single-team spreads name the SAME team (order-ideal rungs, never mutex)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions b ON b.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex_spread' AND e.archived_at IS NULL
        AND array_length(a.participants, 1) = 1 AND array_length(b.participants, 1) = 1
        AND (
          lower(immutable_unaccent(btrim(a.participants[1]))) = lower(immutable_unaccent(btrim(b.participants[1])))
          OR lower(immutable_unaccent(btrim(a.participants[1]))) ILIKE '%' || lower(immutable_unaccent(btrim(b.participants[1]))) || '%'
          OR lower(immutable_unaccent(btrim(b.participants[1]))) ILIKE '%' || lower(immutable_unaccent(btrim(a.participants[1]))) || '%'
        )`,
  },

  {
    name: 'warsh_sibling_equiv',
    note: 'A7: cross_question_equiv siblings of ONE platform_event with differing "…say X?" titles',
    idsSql: `SELECT e.id
      FROM implication_edges e
      ${repTitleLateral('ta', 'e.antecedent_question_id')}
      ${repTitleLateral('tc', 'e.consequent_question_id')}
      WHERE e.pattern = 'cross_question_equiv' AND e.archived_at IS NULL
        AND lower(btrim(ta.title)) IS DISTINCT FROM lower(btrim(tc.title))
        AND (ta.title ILIKE '%say%' OR tc.title ILIKE '%say%')
        AND EXISTS (
          SELECT 1 FROM question_members qma JOIN markets ma ON ma.id = qma.market_id
          JOIN question_members qmb ON qmb.question_id = e.consequent_question_id
          JOIN markets mb ON mb.id = qmb.market_id
          WHERE qma.question_id = e.antecedent_question_id
            AND ma.platform = mb.platform AND ma.platform_event_id IS NOT NULL
            AND ma.platform_event_id = mb.platform_event_id
        )`,
  },

  // Kalshi carries multiple tie-window series per fixture; different
  // snapshot windows are not equivalent (score moves between checkpoints).
  // Predicate: draw-subject equiv pairs whose Kalshi members belong to
  // different series families.
  {
    name: 'draw_scope_equiv',
    note: 'A15: draw≡draw equivalence across DIFFERENT resolution windows (F3/F5/F7/FT tie snapshots) — the 20:17 clean-graded fake class',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qc ON qc.id = e.consequent_question_id
      WHERE e.edge_type = 'equivalence' AND e.archived_at IS NULL
        AND lower(btrim(qa.canonical_subject)) = 'draw'
        AND lower(btrim(qc.canonical_subject)) = 'draw'
        AND EXISTS (
          SELECT 1
          FROM question_members qma JOIN market_metadata_raw ra ON ra.market_id = qma.market_id,
               question_members qmc JOIN market_metadata_raw rc ON rc.market_id = qmc.market_id
          WHERE qma.question_id = qa.id AND qmc.question_id = qc.id
            AND split_part(ra.raw->>'event_ticker', '-', 1)
                IS DISTINCT FROM split_part(rc.raw->>'event_ticker', '-', 1)
        )`,
  },

  // Nationality is not available in-DB, so archive all mutexes touching a
  // KXPGAWINNERREGION question (player x region + region x region).
  {
    name: 'pga_region_mutex',
    note: 'A4: cross_question_mutex touching a KXPGAWINNERREGION question (nationality unavailable → ALL region pairs archived)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      WHERE e.pattern = 'cross_question_mutex' AND e.archived_at IS NULL
        AND (${seriesPrefixExists('e.antecedent_question_id', 'KXPGAWINNERREGION')}
          OR ${seriesPrefixExists('e.consequent_question_id', 'KXPGAWINNERREGION')})`,
  },

  // Group membership (own-group vs other-group) is not derivable in-DB
  // without the group-qualification KB, so archive the whole
  // KXMENWORLDCUP x KXWCGROUPWINNER cross-series set.
  {
    name: 'wc_team_group_mutex',
    note: 'A5: cross_question_mutex pairing KXMENWORLDCUP × KXWCGROUPWINNER (own-group containment ⊆ this cross-series set)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      WHERE e.pattern = 'cross_question_mutex' AND e.archived_at IS NULL
        AND (
          (${seriesPrefixExists('e.antecedent_question_id', 'KXMENWORLDCUP')}
             AND ${seriesPrefixExists('e.consequent_question_id', 'KXWCGROUPWINNER')})
          OR (${seriesPrefixExists('e.antecedent_question_id', 'KXWCGROUPWINNER')}
             AND ${seriesPrefixExists('e.consequent_question_id', 'KXMENWORLDCUP')})
        )`,
  },

  // Shareable awards: Fields Medal (KXFIELDS) + Nobel Peace Prize (matched
  // by canonical_event, no onboarded ticker in-code).
  {
    name: 'award_multiwinner_mutex',
    note: 'A10: cross_question_mutex within a multi-winner award (Fields Medal KXFIELDS + Nobel Peace Prize)',
    idsSql: `SELECT e.id
      FROM implication_edges e
      JOIN questions a ON a.id = e.antecedent_question_id
      JOIN questions b ON b.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex' AND e.archived_at IS NULL
        AND (
          ${seriesPrefixExists('e.antecedent_question_id', 'KXFIELDS')}
          OR ${seriesPrefixExists('e.consequent_question_id', 'KXFIELDS')}
          OR a.canonical_event ILIKE '%nobel peace%' OR b.canonical_event ILIKE '%nobel peace%'
        )`,
  },
];

async function main(): Promise<void> {
  console.log(
    `archive-unsound-edges-2026-07-21 — ${APPLY ? 'APPLY (writing archived_at=now())' : 'DRY-RUN (no writes; pass --apply to archive)'}\n`,
  );
  let total = 0;
  for (const c of CLASSES) {
    if (APPLY) {
      const rows = await query<{ id: string }>(
        `WITH ids AS (${c.idsSql})
         UPDATE implication_edges e SET archived_at = now()
         WHERE e.id IN (SELECT id FROM ids) AND e.archived_at IS NULL
         RETURNING e.id`,
      );
      const n = rows.length;
      total += n;
      console.log(`  [${c.name}] archived ${n.toLocaleString()} — ${c.note}`);
    } else {
      const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM (${c.idsSql}) t`);
      const n = Number(rows[0]?.n ?? 0);
      total += n;
      console.log(`  [${c.name}] ${n.toLocaleString()} would archive — ${c.note}`);
    }
  }
  console.log(
    `\n${APPLY ? 'ARCHIVED' : 'WOULD ARCHIVE'} ${total.toLocaleString()} edge(s) across ${CLASSES.length} classes` +
      `${APPLY ? '' : ' — re-run with --apply to write'}`,
  );
  await endPool();
}

main().catch(async (err) => {
  console.error(err);
  await endPool();
  process.exit(1);
});
