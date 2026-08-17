/**
 * Registry entry — `award_tier`. Guard-only: feeds the generic Stage-3
 * leg-coherence belt + telemetry only; it is not a fold key and never a set
 * group-key (excluded from `foldKeySpecs()`), so the Stage-4 fold-SQL / set
 * keys / certifier stay byte-identical.
 *
 * Distinguishes prizes that share the same outcome set but are different
 * prizes — e.g. a World Cup Silver Boot and Golden Boot both award among the
 * same top scorers, but a player can win at most one, so the two markets are
 * not a shared mutex. The tier lives only in the title ("...win the Silver
 * Boot?" vs "...Golden Boot Winner: ...") and never in a gated field (both
 * sides are `award_winner`/`championship_winner`, canonical_subject = the
 * player), so no existing fold key separates them. This entry lifts the tier
 * to a JSONB fact so the leg-coherence belt refuses a cross-tier fusion.
 *
 * Null policy is `tolerant`: the failure mode this guards against is
 * both-known-and-differ (a Silver-Boot leg fused against a Golden-Boot leg),
 * which `tolerant` catches directly with no NULL bridge needed;
 * `block-when-sibling-known` would false-drop legit unstamped sibling legs
 * (e.g. residual "another player" rows) for no extra coverage. Fold-key
 * promotion is not proposed — the tier is a within-question leg
 * discriminator, not an event-identity or set-partition key (a legit winner
 * set never spans two tiers), so it must never enter the certifier.
 *
 * `kind: 'all'` — the vocab requires a tier immediately followed by an award
 * object (boot|ball|glove|slipper), which is unambiguously a prize name and
 * essentially never appears outside award markets, so a kind allowlist buys
 * nothing. Requiring the object also kills the bare-tier trap ("Golden State
 * Warriors", "golden anniversary"). Guard-only + tolerant makes any
 * incidental 'all' stamp inert unless two fused legs carry known-and-differing
 * tiers.
 *
 * Stamp: `source:'title-regex'`, JSONB-only (no typed column).
 */
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** Anchored award-tier vocab: a tier tag IMMEDIATELY followed by an award object
 *  (the object anchor proves it is a prize name, not a bare 'golden'/'silver').
 *  Global so every occurrence is collected; the value is the TIER (group 1). */
const AWARD_TIER_RX = /\b(golden|silver|bronze)\s+(?:boot|ball|glove|slipper)s?\b/gi;

/**
 * The single award-tier token for a title, or null when ZERO or MORE-THAN-ONE
 * distinct tier is present (a combined "Golden Boot and the Golden Ball" market with
 * two DIFFERENT tiers → ambiguous → no stamp; mirrors the org_tour/party
 * both-or-neither rule). Pure + total.
 */
export function extractAwardTier(title: string | null | undefined): string | null {
  if (!title) return null;
  const found = new Set<string>();
  for (const m of title.matchAll(AWARD_TIER_RX)) found.add(m[1]!.toLowerCase());
  return found.size === 1 ? [...found][0]! : null;
}

export const awardTierSpec: DiscriminatorSpec = {
  name: 'award_tier',
  // 'all' — the anchored tier+object vocab is the scope (null on non-award titles);
  // guard-only+tolerant makes 'all' inert except on a genuine cross-tier fusion.
  kinds: 'all',
  source: 'title-regex',
  extract: (ctx: ExtractCtx) => extractAwardTier(ctx.title),
  // JSONB-only — no typed tier column; never dual-writes.
  assertion: 'guard-only',
  // tolerant — catches a both-known-and-differ cross-tier fusion directly;
  // block-when-sibling-known would false-drop legit unstamped sibling legs.
  nullPolicy: 'tolerant',
};
