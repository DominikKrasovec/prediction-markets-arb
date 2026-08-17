/**
 * Registry entry — `metric_qualifier`. Guard-only: feeds the generic Stage-3
 * leg-coherence belt + telemetry only; not a fold key and never a set
 * group-key (excluded from `foldKeySpecs()`), so the Stage-4 fold-SQL / set
 * keys / certifier stay unaffected.
 *
 * Core CPI (ex-food-and-energy) and headline CPI (all items) are different
 * statistics that print different numbers on the same release — a "core
 * above 2.6%" leg and a "headline above 3.0%" leg co-resolve independently
 * and do not tile one number line. Fusing them as one numeric partition makes
 * complementary value coverage look exhaustive (Σ=1) to the LP, minting a
 * fake. The qualifier lives only in the title ("core CPI" vs the unqualified
 * "CPI inflation"); this entry lifts it to a JSONB fact so the leg-coherence
 * belt refuses a core↔headline fusion.
 *
 * Kalshi's convention writes "core CPI/PCE" for core and the bare "CPI
 * inflation" for headline — the literal word "headline" never appears, so
 * headline is the unqualified default: `extract` stamps 'headline' whenever a
 * CPI/PCE/inflation title lacks the 'core' qualifier. That makes both
 * partitions known, so `tolerant`'s both-known-and-differ arm catches the fusion.
 *
 * Scope: `extract` returns null unless the title matches (cpi|pce|inflation),
 * so a bare 'core' elsewhere ("core team", "hardcore") never stamps.
 * `\bcore\b` is word-anchored so 'supercore'/'hardcore' do not fire.
 *
 * A legit CPI threshold ladder never mixes core and headline, so this
 * qualifier is a cross-question merge discriminator, not a within-set
 * partition key — fold-key promotion is deliberately not proposed here.
 *
 * kinds='all': the fake spans PM `other` (Core CPI) × Kalshi
 * `econ_indicator_threshold` (headline CPI), so a kind allowlist would have
 * to enumerate multiple kinds to reach both legs — the anchored
 * (cpi|pce|inflation) regex is the cleaner scope (null everywhere else).
 *
 * Stamp: `source:'title-regex'`, JSONB-only (no typed column).
 */
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** Econ metric scope: the title must be about CPI / PCE / inflation for the
 *  qualifier to mean anything. */
const ECON_METRIC_RX = /\b(?:cpi|pce|inflation)\b/i;
/** The 'core' qualifier (word-anchored so 'supercore'/'hardcore' never fire). */
const CORE_RX = /\bcore\b/i;

/**
 * 'core' vs 'headline' for a CPI/PCE/inflation title, or null when the title is not
 * an econ metric title. Headline is the UNQUALIFIED default (the census found the
 * literal word "headline" in 0 titles — Kalshi writes "core CPI" for core and bare
 * "CPI inflation" for headline). Pure + total.
 */
export function extractMetricQualifier(title: string | null | undefined): string | null {
  if (!title || !ECON_METRIC_RX.test(title)) return null;
  return CORE_RX.test(title) ? 'core' : 'headline';
}

export const metricQualifierSpec: DiscriminatorSpec = {
  name: 'metric_qualifier',
  // The (cpi|pce|inflation) regex is the scope (null on every non-econ title).
  kinds: 'all',
  source: 'title-regex',
  extract: (ctx: ExtractCtx) => extractMetricQualifier(ctx.title),
  // JSONB-only — no typed column; never dual-writes.
  assertion: 'guard-only',
  // headline-as-default makes both partitions known, so both-known-and-differ
  // catches the fusion; a NULL-tolerant sibling (non-econ leg) is never dropped.
  nullPolicy: 'tolerant',
};
