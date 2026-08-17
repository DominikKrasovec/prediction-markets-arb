/**
 * Registry entry — `org_split`. The gender-axis fold-key that generalizes
 * tennis's `tour_gender` to every non-tennis one-champion family: PGA/LPGA
 * golf, NBA/WNBA basketball, and any men's/women's championship that shares
 * an event name across the gender split.
 *
 * A men's and a women's championship are different events, but a builder
 * that folds on a gender-blind canonical_event pairs every men's question
 * against every women's question (a fake mutex arb). tour_gender solves this
 * for ATP x WTA; org_split arms the identical guard for golf/basketball/etc.
 *
 * Why a per-subject source: a title-only spec would stamp the org token only
 * on the one slot whose title names the org, leaving sibling player-name
 * slots NULL, so a block-when-sibling-known certifier would demote the
 * exhaustive one-champion set on the known+NULL mix. org_split instead reads
 * the gender per subject from the KB (`tour_gender`, seeded plus athlete
 * inheritance), so every slot in a field agrees and no demote fires.
 *
 * Extract (KB first, title fallback):
 *   1. KB arm — the canonical_subject's `tour_gender` fact ('men'|'women').
 *      Covers person fields uniformly.
 *   2. title arm — a gendered league/tour token (wnba/lpga/wta/nwsl -> women;
 *      nba/pga/atp -> men) or an explicit "men's"/"women's"/"ladies"
 *      qualifier. Covers team fields (KB does not stamp clubs). Two
 *      conflicting genders in one title -> null (never guess).
 * org_split does not mutate canonical_event, so an ungated men/women token
 * can only refuse a both-known-differ fold (always sound) or contribute a
 * known+NULL certifier demote (a recall loss, never a fake arb).
 *
 * nullPolicy `block-when-sibling-known` (same as tour_gender): tolerant at
 * Stage-4 folds; the Stage-3 leg-coherence belt drops a NULL-gender leg
 * entering a fusion whose sibling gender is known. Kind-scoped to
 * championship_winner + match_winner. Golf "make-the-cut"/"finish" markets
 * normalize under championship_winner, so they are already in scope.
 *
 * Not a set-split key (deliberate): org_split declares no `setSplit`. A
 * gendered categorical set ("Will {team} win the WNBA title?") is a
 * legitimate single-gender mutex whose slots all share one gender;
 * splitting such a set on gender would shatter the mutex.
 *
 * Tennis relationship: org_split is a strict superset of tour_gender on the
 * covered kinds and agrees with it on every row tour_gender stamps. Both
 * stay registered; expansion-specs.test.ts asserts they never disagree on a
 * shared row.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

export type OrgSplitGender = 'men' | 'women';

const ORG_SPLIT_KINDS: readonly EventKind[] = ['championship_winner', 'match_winner'];

/**
 * Gendered league/tour tokens + explicit gender qualifiers → the gender they
 * imply. Word-anchored. The `\b` boundary is load-bearing twice over:
 *   · `\bpga\b` does NOT match inside "lpga" (l-p is letter-letter, no boundary)
 *     and `\bnba\b`/`\batp\b` do NOT match inside "wnba"/"wta" — so a women's-tour
 *     token never also trips the men's token;
 *   · `\bmen\b` cannot match inside "women"/"tournament"/"Bremen" (the preceding
 *     char is always a word char → no boundary).
 * Only families that share an event name across the gender split are listed;
 * men's-only leagues with no colliding women's counterpart (NFL/MLB/NHL) are
 * omitted (pure over-stamp risk, zero merge to fix).
 */
const GENDERED_TOKENS: ReadonlyArray<readonly [RegExp, OrgSplitGender]> = [
  [/\bwnba\b/i, 'women'],
  [/\blpga\b/i, 'women'],
  [/\bwta\b/i, 'women'],
  [/\bnwsl\b/i, 'women'],
  [/\bnba\b/i, 'men'],
  [/\bpga\b/i, 'men'],
  [/\batp\b/i, 'men'],
  [/\bwomen(?:['’]?s)?\b/i, 'women'],
  [/\bladies\b/i, 'women'],
  [/\bmen(?:['’]?s)?\b/i, 'men'],
];

/**
 * The gender a TITLE implies, or null when none — or when TWO conflicting
 * genders are present (ambiguous → never guess). Pure + total.
 */
export function extractGenderFromTitle(title: string | null | undefined): OrgSplitGender | null {
  if (!title) return null;
  const found = new Set<OrgSplitGender>();
  for (const [rx, g] of GENDERED_TOKENS) if (rx.test(title)) found.add(g);
  return found.size === 1 ? [...found][0]! : null;
}

/** Coerce an arbitrary KB tour_gender value to the {men,women} axis, else null. */
function normGender(v: string | null | undefined): OrgSplitGender | null {
  return v === 'men' || v === 'women' ? v : null;
}

/**
 * KB-first, title-fallback gender extract (pure + total). The subject's KB
 * `tour_gender` wins when present (per-slot-uniform for person fields); otherwise
 * the market title's gendered token/qualifier (covers team fields the KB leaves
 * NULL). A cold KB cache ⇒ KB arm null ⇒ title arm only (soundness direction).
 */
export function extractOrgSplit(ctx: ExtractCtx): OrgSplitGender | null {
  const subj = typeof ctx.gated.canonical_subject === 'string' ? ctx.gated.canonical_subject : null;
  const kbGender = subj ? normGender(ctx.kb?.lookupCanonical(subj)?.tour_gender) : null;
  if (kbGender) return kbGender;
  return extractGenderFromTitle(ctx.title);
}

export const orgSplitSpec: DiscriminatorSpec = {
  name: 'org_split',
  kinds: ORG_SPLIT_KINDS,
  // KB is the authoritative (per-subject-uniform) arm; the title fallback rides
  // inside the same total extract for the team fields the KB does not cover.
  source: 'kb',
  extract: extractOrgSplit,
  // JSONB-only — no typed gender column; never dual-writes.
  assertion: 'fold-key',
  nullPolicy: 'block-when-sibling-known',
  foldSurface: 'builder',
  // NO setSplit: a single-gender categorical set is a legitimate mutex; keying
  // the finalize set partition on gender would shatter it (the party trap).
};
