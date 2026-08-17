/**
 * Registry entry — `language_variant`, a wrong-axis-fusion guard. GUARD-ONLY:
 * feeds the generic Stage-3 leg-coherence belt + telemetry only; NOT a fold key and
 * NEVER a set group-key (excluded from `foldKeySpecs()`), so the Stage-4 fold-SQL /
 * set keys / certifier stay byte-identical.
 *
 * ── THE DEFECT IT DEFENDS ──────────────────────────────────────────────────
 * The Crunchyroll "Best Anime Voice Artist Performance" award is graded PER DUB
 * LANGUAGE — a separate winner for the (Latin Spanish) dub, the (Castilian Spanish)
 * dub, the (Brazilian Portuguese) dub, etc. SE 2193 fused the (Latin Spanish) and
 * (Castilian Spanish) categories into one exclusive set (the PM event itself mixes
 * both language categories — GW-R2's feed-B cousin), so a voice actor nominated in
 * BOTH language dubs appears as two "mutually exclusive" outcomes that are actually
 * independent prizes → a fake mutex. The discriminating fact — the dub LANGUAGE — is
 * a parenthesized qualifier in the title, carried nowhere in a gated field. This entry
 * lifts the parenthesized language qualifier to a JSONB fact so the leg-coherence belt
 * refuses a cross-language fusion.
 *
 * ── LIVE CENSUS (data/exports/gwr4a-spec-census.ts, 2026-07-12) ──────────────
 *  · 7 live PM markets (event_kind 'other') carry a parenthesized language
 *    qualifier: (Castilian Spanish) 2, (Brazilian Portuguese) / (English) / (French)
 *    / (German) / (Latin Spanish) 1 each — all "…win Best Anime Voice Artist
 *    Performance (<lang>) at the 2026 Crunchyroll Anime Awards".
 *  · 0 canonical_events currently mix distinct language qualifiers (the KB separates
 *    them); the only place two languages meet is the cross-QUESTION merge (SE 2193)
 *    the belt guards.
 *
 * ── SCOPE — award title + a LONE language parenthetical ─────────────────────
 * `extract` requires BOTH (a) an award cue (`award`) in the title and (b) a
 * parenthetical whose ENTIRE content is `<optional region> <language>` — so
 * "(English Premier League)" does NOT match (trailing "Premier League" leaves the
 * paren non-lone) and a soccer title without "award" never reaches the language
 * scan. Two anchors keep the kinds:'all' surface tight.
 *
 * ── ASSERTION / NULL-POLICY = guard-only + tolerant ─────────────────────────
 * Same wave-2.5 shape as the other guard-only entries. The confirmed fake is
 * both-known-and-differ (a 'latin spanish' leg fused against a 'castilian spanish'
 * leg), which `tolerant` catches; a NULL/unstamped sibling is never dropped. Fold-key
 * promotion is NOT proposed — the language is a within-question leg discriminator, not
 * an event-identity or set-partition key (a legit per-language winner set carries ONE
 * language across all its slots), so it must never enter the certifier.
 *
 * ── KIND = 'all' (the two title anchors are the scope) ──────────────────────
 * The live surface is event_kind 'other'; the award-cue + lone-language-paren anchors
 * are the scope (null everywhere else). Mirrors predicate_grain's 'all' precedent.
 *
 * Stamp: `source:'title-regex'`, JSONB-only (no typed column). The value is the
 * FOLDED qualifier (lowercased, whitespace-collapsed) — e.g. 'latin spanish'.
 */
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** An award title (the first anchor). */
const AWARD_CUE_RX = /\baward/i;

/** A LONE language parenthetical: the whole paren content is an optional region
 *  modifier + a language name, nothing else (so "(English Premier League)" fails).
 *  Global so a two-language title collects both ⇒ the both-or-neither gate nulls it. */
const LANG_PAREN_RX =
  /\(\s*((?:latin|castilian|european|brazilian|mexican|american|british|traditional|simplified|continental)\s+)?(?:spanish|portuguese|japanese|korean|english|french|german|italian|mandarin|cantonese|chinese|russian|hindi|arabic|dutch|polish|turkish)\s*\)/gi;

/** Fold a captured qualifier: strip the parens, trim, collapse internal whitespace,
 *  lowercase (the "folded" value). */
function foldQualifier(raw: string): string {
  return raw.replace(/^\(|\)$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The folded parenthesized language qualifier for an award title, or null when the
 * title is not an award title, carries no lone-language parenthetical, or carries
 * MORE THAN ONE distinct qualifier (ambiguous → no stamp; mirrors the both-or-neither
 * rule). Pure + total.
 */
export function extractLanguageVariant(title: string | null | undefined): string | null {
  if (!title || !AWARD_CUE_RX.test(title)) return null;
  const found = new Set<string>();
  for (const m of title.matchAll(LANG_PAREN_RX)) found.add(foldQualifier(m[0]));
  return found.size === 1 ? [...found][0]! : null;
}

export const languageVariantSpec: DiscriminatorSpec = {
  name: 'language_variant',
  // 'all' — live surface is event_kind 'other'; the award-cue + lone-language-paren
  // anchors are the scope (null everywhere else). See KIND note above.
  kinds: 'all',
  source: 'title-regex',
  extract: (ctx: ExtractCtx) => extractLanguageVariant(ctx.title),
  // JSONB-only — no typed column; never dual-writes.
  assertion: 'guard-only',
  // tolerant — SE 2193 is both-known-and-differ (latin spanish vs castilian spanish);
  // a NULL/unstamped sibling is never dropped. See the NULL-POLICY note above.
  nullPolicy: 'tolerant',
};
