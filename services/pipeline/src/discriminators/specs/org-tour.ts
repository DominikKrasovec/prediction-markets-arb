/**
 * Registry entry — `org_tour` (generalizes the tour_gender anatomy beyond
 * tennis). Guard-only: feeds the Stage-3 leg-coherence belt + telemetry only;
 * not a fold key (excluded from `foldKeySpecs()`).
 *
 * What it discriminates: many championship families crown one champion per
 * sanctioning body / tour, so two markets that name different orgs are
 * different questions even when a builder folds them onto one
 * canonical_event:
 *   · golf: PGA Tour vs LPGA (men's/women's) vs DP World Tour vs LIV;
 *   · boxing: WBA / WBC / IBF / WBO (a boxer can hold several belts at once, so
 *     "X wins the WBC title" and "X wins the WBA title" are independent — both
 *     can happen — yet collapse onto one "X vs Y" / weight-class canonical_event);
 *   · MMA: UFC / Bellator / PFL / ONE (one champion per org per weight class).
 *
 * Source/soundness — both-or-neither implies null (mirrors party/tour_gender):
 * the title is scanned for a word-anchored org token; the canonical org token
 * is the value (two same-org rows fold, two different-org rows split). Zero
 * or more-than-one distinct org present implies null. Kind-scoped to the two
 * winner kinds (championship_winner + match_winner); a no-op stamp elsewhere.
 * Pure and total.
 *
 * Why guard-only, not fold-key: golf's PGA/LPGA is also a gender split that
 * `tour_gender` handles for tennis; here it rides org_tour because the token
 * is an org name, not a men's/women's tour tag. As guard-only it never enters
 * an event-identity fragment or a set group-key, so it cannot false-split a
 * legitimately-shared event. Promotion to fold-key would demote several
 * legitimate one-champion exhaustive sets under `block-when-sibling-known`
 * (the org token rides only the one slot whose title names the org, while
 * sibling player-name slots are NULL), so it stays guard-only until there is
 * a real multi-belt collision to weigh against that recall loss.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

const ORG_TOUR_KINDS: readonly EventKind[] = ['championship_winner', 'match_winner'];

/**
 * Word-anchored org vocabulary → canonical lowercase token. Conservative: only
 * unambiguous, well-known bodies. Order does not matter (each distinct token
 * folds independently); two DIFFERENT tokens present ⇒ ambiguous ⇒ null.
 * `lpga` is a distinct token from `pga` (JS `\b` does not match inside 'lpga').
 */
const ORG_VOCAB: ReadonlyArray<readonly [RegExp, string]> = [
  // golf circuits / tours
  [/\blpga\b/i, 'lpga'],
  [/\bpga\b/i, 'pga'],
  [/\bdp world tour\b/i, 'dp_world'],
  [/\bliv golf\b/i, 'liv'],
  // boxing sanctioning bodies (the multi-belt collision case)
  [/\bwba\b/i, 'wba'],
  [/\bwbc\b/i, 'wbc'],
  [/\bibf\b/i, 'ibf'],
  [/\bwbo\b/i, 'wbo'],
  // MMA promotions
  [/\bufc\b/i, 'ufc'],
  [/\bbellator\b/i, 'bellator'],
  [/\bpfl\b/i, 'pfl'],
];

/**
 * The canonical org token for a title (+ the derived canonical_event), or null
 * when zero or more-than-one distinct org is present (ambiguous, no stamp).
 * Pure and total.
 *
 * Scans canonical_event as well as title because Kalshi carries the org in
 * the series/event ticker, not the market title — a Kalshi leg's title can
 * omit the org word entirely while its canonical_event carries it uniformly
 * with the cross-platform sibling's. Title-only scanning would leave such
 * Kalshi legs NULL while a same-org sibling stamps a real org, so
 * `block-when-sibling-known` would drop every Kalshi leg of a genuinely
 * same-org cross-platform fold. Unioning the two surfaces keeps the
 * both-or-neither guard intact: a genuine cross-org disagreement (title `pga`
 * vs canonical_event `liv golf`) still yields >=2 tokens, so still null.
 */
export function extractOrgTour(
  title: string | null | undefined,
  canonicalEvent?: string | null,
): string | null {
  const found = new Set<string>();
  for (const src of [title, canonicalEvent]) {
    if (!src) continue;
    for (const [rx, tok] of ORG_VOCAB) if (rx.test(src)) found.add(tok);
  }
  return found.size === 1 ? [...found][0]! : null;
}

export const orgTourSpec: DiscriminatorSpec = {
  name: 'org_tour',
  kinds: ORG_TOUR_KINDS,
  source: 'title-regex',
  extract: (ctx: ExtractCtx) => extractOrgTour(ctx.title, (ctx.gated?.canonical_event as string | null | undefined) ?? null),
  // JSONB-only — no typed org column; never dual-writes.
  assertion: 'guard-only',
  // block-when-sibling-known (mirrors tour_gender): a NULL-org leg entering a
  // fusion where a sibling's org is known is dropped, and two different known
  // orgs conflict. The safe direction for a one-champion-per-org exclusivity axis.
  nullPolicy: 'block-when-sibling-known',
};
