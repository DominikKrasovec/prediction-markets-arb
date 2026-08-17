/**
 * Centralized queries for `llm_market_normalizations` table.
 */
import { query } from '@arb/db';
import type { LLMMarketNormalization } from '@arb/types';
import { toME } from '@arb/types';
import { guardLLMNormalization } from '../../stage1-normalize/llm-ingestion-guard.js';

export async function upsertNormalization(result: LLMMarketNormalization): Promise<void> {
  // This is the chokepoint where per-market LLM output becomes a
  // normalization row (match_source NULL discriminates; deterministic
  // batches go through bulkUpsertNormalizations and are validated at their
  // own Stage-1 chokepoints). Warn-and-pass validateConditionTuple + date
  // post-coercion to the padded-START + precision storage convention.
  if (result.match_source == null) result = guardLLMNormalization(result);

  // Decompose numeric values into mantissa+exponent for exact storage.
  const pvME = result.value_primary   != null ? toME(result.value_primary)   : null;
  const svME = result.value_secondary != null ? toME(result.value_secondary) : null;

  await query(
    `INSERT INTO llm_market_normalizations (
       market_id, canonical_subject, condition_value,
       condition_date, canonical_event, resolved_entities, resolution_source, confidence,
       condition_shape, condition_direction, condition_metric, temporal_semantics,
       value_primary, value_secondary, value_unit,
       value_primary_m, value_primary_e, value_secondary_m, value_secondary_e,
       participants, event_sourced,
       resolution_provider_id, resolution_kind, league_id, competition_id, event_kind,
       match_source, leg_signatures, outcome_label,
       condition_date_precision, condition_date_source, metric_scope, discriminators
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
     ON CONFLICT (market_id) DO UPDATE SET
       canonical_subject       = EXCLUDED.canonical_subject,
       condition_value         = EXCLUDED.condition_value,
       condition_date          = EXCLUDED.condition_date,
       condition_date_precision = EXCLUDED.condition_date_precision,
       condition_date_source   = EXCLUDED.condition_date_source,
       canonical_event         = EXCLUDED.canonical_event,
       resolved_entities       = EXCLUDED.resolved_entities,
       resolution_source       = EXCLUDED.resolution_source,
       confidence              = EXCLUDED.confidence,
       condition_shape         = COALESCE(EXCLUDED.condition_shape, llm_market_normalizations.condition_shape),
       condition_direction     = COALESCE(EXCLUDED.condition_direction, llm_market_normalizations.condition_direction),
       condition_metric        = COALESCE(EXCLUDED.condition_metric, llm_market_normalizations.condition_metric),
       temporal_semantics      = COALESCE(EXCLUDED.temporal_semantics, llm_market_normalizations.temporal_semantics),
       value_primary           = EXCLUDED.value_primary,
       value_secondary         = EXCLUDED.value_secondary,
       value_unit              = EXCLUDED.value_unit,
       value_primary_m         = EXCLUDED.value_primary_m,
       value_primary_e         = EXCLUDED.value_primary_e,
       value_secondary_m       = EXCLUDED.value_secondary_m,
       value_secondary_e       = EXCLUDED.value_secondary_e,
       participants            = EXCLUDED.participants,
       event_sourced           = EXCLUDED.event_sourced,
       resolution_provider_id  = COALESCE(EXCLUDED.resolution_provider_id, llm_market_normalizations.resolution_provider_id),
       resolution_kind         = COALESCE(EXCLUDED.resolution_kind, llm_market_normalizations.resolution_kind),
       league_id               = COALESCE(EXCLUDED.league_id, llm_market_normalizations.league_id),
       competition_id          = COALESCE(EXCLUDED.competition_id, llm_market_normalizations.competition_id),
       event_kind              = COALESCE(EXCLUDED.event_kind, llm_market_normalizations.event_kind),
       match_source            = COALESCE(EXCLUDED.match_source, llm_market_normalizations.match_source),
       leg_signatures          = COALESCE(EXCLUDED.leg_signatures, llm_market_normalizations.leg_signatures),
       outcome_label           = COALESCE(EXCLUDED.outcome_label, llm_market_normalizations.outcome_label),
       metric_scope            = COALESCE(EXCLUDED.metric_scope, llm_market_normalizations.metric_scope),
       discriminators          = EXCLUDED.discriminators`,
    [
      result.market_id,
      result.canonical_subject,
      result.condition_value,
      result.condition_date,
      result.canonical_event,
      JSON.stringify(result.resolved_entities),
      result.resolution_source,
      result.confidence,
      result.condition_shape ?? null,
      result.condition_direction ?? null,
      result.condition_metric ?? null,
      result.temporal_semantics ?? null,
      result.value_primary ?? null,
      result.value_secondary ?? null,
      result.value_unit ?? null,
      pvME?.m ?? null,
      pvME?.e ?? null,
      svME?.m ?? null,
      svME?.e ?? null,
      result.participants ?? [],
      result.event_sourced ?? false,
      result.resolution_provider_id ?? null,
      result.resolution_kind ?? null,
      result.league_id ?? null,
      result.competition_id ?? null,
      result.event_kind ?? null,
      result.match_source ?? null,
      result.leg_signatures ?? null,
      result.outcome_label ?? null,
      result.condition_date_precision ?? null,
      result.condition_date_source ?? null,
      result.metric_scope ?? null,
      // The DiscriminatorSpec registry stamp. JSONB map; '{}' when the row
      // carried no discriminators (column is NOT NULL DEFAULT '{}').
      JSON.stringify(result.discriminators ?? {}),
    ]
  );
}

/**
 * Bulk equivalent of upsertNormalization for deterministic Stage 1 batches.
 * Keeps the exact same ON CONFLICT merge semantics while reducing N round-trips
 * to one query per batch.
 */
export async function bulkUpsertNormalizations(results: ReadonlyArray<LLMMarketNormalization>): Promise<void> {
  if (results.length === 0) return;

  const valuePrimaryME = results.map((r) => r.value_primary != null ? toME(r.value_primary) : null);
  const valueSecondaryME = results.map((r) => r.value_secondary != null ? toME(r.value_secondary) : null);

  await query(
    `INSERT INTO llm_market_normalizations (
       market_id, canonical_subject, condition_value,
       condition_date, canonical_event, resolved_entities, resolution_source, confidence,
       condition_shape, condition_direction, condition_metric, temporal_semantics,
       value_primary, value_secondary, value_unit,
       value_primary_m, value_primary_e, value_secondary_m, value_secondary_e,
       participants, event_sourced,
       resolution_provider_id, resolution_kind, league_id, competition_id, event_kind,
       match_source, leg_signatures, outcome_label,
       condition_date_precision, condition_date_source, metric_scope, discriminators
     )
     SELECT
       src.market_id,
       src.canonical_subject,
       src.condition_value,
       src.condition_date,
       src.canonical_event,
       src.resolved_entities,
       src.resolution_source,
       src.confidence,
       src.condition_shape,
       src.condition_direction,
       src.condition_metric,
       src.temporal_semantics,
       src.value_primary,
       src.value_secondary,
       src.value_unit,
       src.value_primary_m,
       src.value_primary_e,
       src.value_secondary_m,
       src.value_secondary_e,
       ARRAY(SELECT jsonb_array_elements_text(src.participants_json)),
       src.event_sourced,
       src.resolution_provider_id,
       src.resolution_kind,
       src.league_id,
       src.competition_id,
       src.event_kind,
       src.match_source,
       -- leg_signatures: NULL when caller passed null (most non-Kalshi rows),
       -- else a text[] decoded from the per-row jsonb encoding.  Encoding as
       -- jsonb on the JS side avoids the pg-driver headache of passing
       -- text[][] (which Postgres flattens) — see the bulkUpsertNormalizations
       -- params array below for the symmetric encoder.
       CASE
         WHEN src.leg_signatures_json IS NULL OR src.leg_signatures_json = 'null'::jsonb THEN NULL
         ELSE ARRAY(SELECT jsonb_array_elements_text(src.leg_signatures_json))
       END AS leg_signatures,
       src.outcome_label,
       src.condition_date_precision,
       src.condition_date_source,
       src.metric_scope,
       src.discriminators
     FROM (
       SELECT
         unnest($1::int[])      AS market_id,
         unnest($2::text[])     AS canonical_subject,
         unnest($3::text[])     AS condition_value,
         unnest($4::text[])     AS condition_date,
         unnest($5::text[])     AS canonical_event,
         unnest($6::jsonb[])    AS resolved_entities,
         unnest($7::text[])     AS resolution_source,
         unnest($8::numeric[])  AS confidence,
         unnest($9::text[])     AS condition_shape,
         unnest($10::text[])    AS condition_direction,
         unnest($11::text[])    AS condition_metric,
         unnest($12::text[])    AS temporal_semantics,
         unnest($13::numeric[]) AS value_primary,
         unnest($14::numeric[]) AS value_secondary,
         unnest($15::text[])    AS value_unit,
         unnest($16::bigint[])  AS value_primary_m,
         unnest($17::smallint[]) AS value_primary_e,
         unnest($18::bigint[])  AS value_secondary_m,
         unnest($19::smallint[]) AS value_secondary_e,
         unnest($20::jsonb[])   AS participants_json,
         unnest($21::boolean[]) AS event_sourced,
         unnest($22::int[])     AS resolution_provider_id,
         unnest($23::text[])    AS resolution_kind,
         unnest($24::int[])     AS league_id,
         unnest($25::int[])     AS competition_id,
         unnest($26::text[])    AS event_kind,
         unnest($27::text[])    AS match_source,
         unnest($28::jsonb[])   AS leg_signatures_json,
         unnest($29::text[])    AS outcome_label,
         unnest($30::text[])    AS condition_date_precision,
         unnest($31::text[])    AS condition_date_source,
         unnest($32::text[])    AS metric_scope,
         unnest($33::jsonb[])   AS discriminators
     ) AS src
     ON CONFLICT (market_id) DO UPDATE SET
       canonical_subject       = EXCLUDED.canonical_subject,
       condition_value         = EXCLUDED.condition_value,
       condition_date          = EXCLUDED.condition_date,
       condition_date_precision = EXCLUDED.condition_date_precision,
       condition_date_source   = EXCLUDED.condition_date_source,
       canonical_event         = EXCLUDED.canonical_event,
       resolved_entities       = EXCLUDED.resolved_entities,
       resolution_source       = EXCLUDED.resolution_source,
       confidence              = EXCLUDED.confidence,
       condition_shape         = COALESCE(EXCLUDED.condition_shape, llm_market_normalizations.condition_shape),
       condition_direction     = COALESCE(EXCLUDED.condition_direction, llm_market_normalizations.condition_direction),
       condition_metric        = COALESCE(EXCLUDED.condition_metric, llm_market_normalizations.condition_metric),
       temporal_semantics      = COALESCE(EXCLUDED.temporal_semantics, llm_market_normalizations.temporal_semantics),
       value_primary           = EXCLUDED.value_primary,
       value_secondary         = EXCLUDED.value_secondary,
       value_unit              = EXCLUDED.value_unit,
       value_primary_m         = EXCLUDED.value_primary_m,
       value_primary_e         = EXCLUDED.value_primary_e,
       value_secondary_m       = EXCLUDED.value_secondary_m,
       value_secondary_e       = EXCLUDED.value_secondary_e,
       participants            = EXCLUDED.participants,
       event_sourced           = EXCLUDED.event_sourced,
       resolution_provider_id  = COALESCE(EXCLUDED.resolution_provider_id, llm_market_normalizations.resolution_provider_id),
       resolution_kind         = COALESCE(EXCLUDED.resolution_kind, llm_market_normalizations.resolution_kind),
       league_id               = COALESCE(EXCLUDED.league_id, llm_market_normalizations.league_id),
       competition_id          = COALESCE(EXCLUDED.competition_id, llm_market_normalizations.competition_id),
       event_kind              = COALESCE(EXCLUDED.event_kind, llm_market_normalizations.event_kind),
       match_source            = COALESCE(EXCLUDED.match_source, llm_market_normalizations.match_source),
       leg_signatures          = COALESCE(EXCLUDED.leg_signatures, llm_market_normalizations.leg_signatures),
       outcome_label           = COALESCE(EXCLUDED.outcome_label, llm_market_normalizations.outcome_label),
       metric_scope            = COALESCE(EXCLUDED.metric_scope, llm_market_normalizations.metric_scope),
       discriminators          = EXCLUDED.discriminators`,
    [
      results.map((r) => r.market_id),
      results.map((r) => r.canonical_subject),
      results.map((r) => r.condition_value ?? null),
      results.map((r) => r.condition_date ?? null),
      results.map((r) => r.canonical_event),
      results.map((r) => JSON.stringify(r.resolved_entities)),
      results.map((r) => r.resolution_source ?? null),
      results.map((r) => r.confidence),
      results.map((r) => r.condition_shape ?? null),
      results.map((r) => r.condition_direction ?? null),
      results.map((r) => r.condition_metric ?? null),
      results.map((r) => r.temporal_semantics ?? null),
      results.map((r) => r.value_primary ?? null),
      results.map((r) => r.value_secondary ?? null),
      results.map((r) => r.value_unit ?? null),
      valuePrimaryME.map((v) => v?.m ?? null),
      valuePrimaryME.map((v) => v?.e ?? null),
      valueSecondaryME.map((v) => v?.m ?? null),
      valueSecondaryME.map((v) => v?.e ?? null),
      results.map((r) => JSON.stringify(r.participants ?? [])),
      results.map((r) => r.event_sourced ?? false),
      results.map((r) => r.resolution_provider_id ?? null),
      results.map((r) => r.resolution_kind ?? null),
      results.map((r) => r.league_id ?? null),
      results.map((r) => r.competition_id ?? null),
      results.map((r) => r.event_kind ?? null),
      results.map((r) => r.match_source ?? null),
      // Per-row jsonb encoding: 'null' for missing (most non-Kalshi), array
      // JSON for populated.  Decoded back to text[] in the SQL projection
      // above.  Avoids the pg-driver text[][] flattening issue.
      results.map((r) => JSON.stringify(r.leg_signatures ?? null)),
      results.map((r) => r.outcome_label ?? null),
      results.map((r) => r.condition_date_precision ?? null),
      results.map((r) => r.condition_date_source ?? null),
      results.map((r) => r.metric_scope ?? null),
      // Per-row DiscriminatorSpec JSONB, decoded via unnest($33::jsonb[])
      // above. '{}' for rows with no discriminators.
      results.map((r) => JSON.stringify(r.discriminators ?? {})),
    ],
  );
}

export async function getAllResolutionSources(): Promise<Map<number, string | null>> {
  const rows = await query<{ market_id: number; resolution_source: string | null }>(
    `SELECT n.market_id, n.resolution_source
       FROM llm_market_normalizations n
       JOIN markets m ON m.id = n.market_id
      WHERE m.resolved_at IS NULL`
  );
  return new Map(rows.map((r) => [r.market_id, r.resolution_source]));
}
