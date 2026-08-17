/**
 * SQL predicates over `llm_market_normalizations` row validity.
 *
 * Stage 1 writes a sentinel row `canonical_event = '__extraction_failed__'`
 * (with `confidence = 0`) when extraction fails, so the market still has a
 * normalization row for queue-completion bookkeeping but downstream stages
 * must ignore it. Any query that joins through `llm_market_normalizations`
 * to look up a real normalization MUST exclude these sentinel rows AND
 * require positive confidence — always use this shared fragment rather than
 * open-coding either half of the guard.
 */

/**
 * SQL fragment: row carries a real Stage-1 normalization (not a failure
 * sentinel) AND its extractor reported non-zero confidence.
 *
 * Wraps in parens so callers can paste it after `AND` / `OR` without
 * precedence ambiguity.
 */
export const validNormalizationSql = (alias: string): string =>
  `(${alias}.canonical_event <> '__extraction_failed__' AND ${alias}.confidence > 0)`;
