/** Shared duplicate-partition cell-key parser — single source of truth for the solver and
 *  pipeline duplicate gates; must be byte-identical in both, never fork this logic. */

/** foldAscii + lowercase + despace, matching the KB space-invariant fold family. */
export function fold(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const CHAMBER_TOKENS: Record<string, 'house' | 'senate'> = {
  house: 'house',
  senate: 'senate',
};

const PARTY_TOKENS: Record<string, 'D' | 'R'> = {
  d: 'D',
  dem: 'D',
  dems: 'D',
  democrat: 'D',
  democrats: 'D',
  democratic: 'D',
  r: 'R',
  rep: 'R',
  reps: 'R',
  republican: 'R',
  republicans: 'R',
};

/** Words a conjunct may carry besides its one chamber + one party and still parse (e.g.
 *  'Democrats win the House' ≡ 'D House'); excludes anything that could discriminate. */
const FILLER_TOKENS = new Set([
  'control',
  'controls',
  'controlling',
  'win',
  'wins',
  'winning',
  'won',
  'majority',
  'keep',
  'keeps',
  'hold',
  'holds',
  'the',
  'of',
  'a',
]);

/** Parses canonical_subject into an order-invariant chamber×party cellKey, or null if any
 *  conjunct has unconsumed residue (a real discriminator). */
export function parseCellKey(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const conjuncts = subject
    .split(/\s*(?:,|\band\b|&|\+)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
  if (conjuncts.length === 0) return null;
  const tokens: string[] = [];
  for (const c of conjuncts) {
    const words = c.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length === 0) return null;
    let chamber: 'house' | 'senate' | null = null;
    let party: 'D' | 'R' | null = null;
    let sweep = false;
    let ok = true;
    for (const w of words) {
      if (w in CHAMBER_TOKENS) {
        if (chamber !== null && chamber !== CHAMBER_TOKENS[w]) { ok = false; break; }
        chamber = CHAMBER_TOKENS[w];
      } else if (w in PARTY_TOKENS) {
        if (party !== null && party !== PARTY_TOKENS[w]) { ok = false; break; }
        party = PARTY_TOKENS[w];
      } else if (w === 'sweep' || w === 'sweeps' || w === 'trifecta') {
        sweep = true;
      } else if (!FILLER_TOKENS.has(w)) {
        ok = false;
        break;
      }
    }
    if (!ok || !party) return null;
    if (sweep && !chamber) {
      tokens.push(`house=${party}`, `senate=${party}`);
      continue;
    }
    if (!chamber) return null;
    tokens.push(`${chamber}=${party}`);
  }
  return [...new Set(tokens)].sort().join('|');
}

/** equal / ≥5-char-prefix / either-empty ⟹ not distinct (the conservative direction) — used
 *  because fold-identical titles alone over-merge Kalshi categorical siblings. */
function foldNotDistinct(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 5 && longer.startsWith(shorter);
}

// Hits when two folded outcome slugs are equal after stripping a trailing win-token
// (rapid_vienna vs rapid_vienna_win); wall-removing only, shared by both mirrors.
const WIN_SUFFIX_WHITELIST = ['victory', 'winner', 'towin', 'wins', 'win'] as const;

/** Folds a canonical_key to its outcome slug: the tail after the last ':'. */
export function foldOutcomeSlug(canonicalKey: string | null | undefined): string {
  return fold((canonicalKey ?? '').split(':').pop() ?? '');
}

/** Strip at most ONE trailing win-token (longest match first) from a folded slug. */
function stripSlugWinSuffix(slug: string): string {
  for (const suf of WIN_SUFFIX_WHITELIST) {
    if (slug.length > suf.length && slug.endsWith(suf)) return slug.slice(0, -suf.length);
  }
  return slug;
}

/** HIT iff two folded slugs differ but reduce to the same ≥5-char stem after a win-suffix strip. */
export function winSuffixSlugDuplicateHit(
  canonicalKeyA: string | null | undefined,
  canonicalKeyB: string | null | undefined,
): boolean {
  const a = foldOutcomeSlug(canonicalKeyA);
  const b = foldOutcomeSlug(canonicalKeyB);
  if (!a || !b || a === b) return false;
  const stemA = stripSlugWinSuffix(a);
  const stemB = stripSlugWinSuffix(b);
  if (stemA !== stemB) return false;
  return stemA.length >= 5;
}

// Hits when one folded subject is a bare-name subset of the other (surname vs full name); both
// must be bare proper-name shaped (1-4 tokens, no digit/predicate) to avoid fusing scorelines.

// Predicate/relational verbs, structural words, and clause fillers — mark a full clause, not a bare name.
const NON_NAME_SUBJECT_TOKENS = new Set([
  'win', 'wins', 'won', 'winner', 'winners', 'winning',
  'outperform', 'outperforms', 'beat', 'beats',
  'advance', 'advances', 'qualify', 'qualifies', 'eliminated', 'relegated',
  'score', 'scores', 'draw', 'tie', 'tied', 'lead', 'leading', 'leader',
  'first', 'second', 'half', 'innings', 'inning', 'quarter', 'period', 'game',
  'final', 'series', 'round', 'group', 'stage', 'leg', 'day', 'set',
  'vs', 'versus', 'will', 'be', 'the', 'neither', 'either', 'to', 'and', 'or',
  'of', 'at', 'in', 'a', 'most', 'other', 'region', 'exact',
]);

function nameSubjectTokens(subject: string | null | undefined): string[] {
  if (!subject) return [];
  return subject
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** TRUE iff `tokens` is a bare proper-name shape: 1..4 tokens, no digit, no relational/predicate token. */
function isBareNameShape(tokens: string[]): boolean {
  if (tokens.length < 1 || tokens.length > 4) return false;
  for (const t of tokens) {
    if (/[0-9]/.test(t)) return false;
    if (NON_NAME_SUBJECT_TOKENS.has(t)) return false;
  }
  return true;
}

/** HIT iff both subjects are bare names, the shorter's tokens are a proper subset of the
 *  longer's, with ≥1 shorter token of length ≥4. */
export function personNameSubsetDuplicateHit(
  subjectA: string | null | undefined,
  subjectB: string | null | undefined,
): boolean {
  const ta = nameSubjectTokens(subjectA);
  const tb = nameSubjectTokens(subjectB);
  if (!isBareNameShape(ta) || !isBareNameShape(tb)) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const [short, long] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (short.size === long.size) return false; // equal-size sets are never a proper subset here
  for (const t of short) if (!long.has(t)) return false; // every shorter token ∈ longer
  let hasStrong = false;
  for (const t of short) if (t.length >= 4) { hasStrong = true; break; }
  return hasStrong;
}

export function foldTitleDuplicateHit(
  titlesA: ReadonlySet<string>,
  titlesB: ReadonlySet<string>,
  foldedSubjectA: string,
  foldedSubjectB: string,
  // Outcome slug (canonical_key tail); distinct non-prefix slugs release rather than hit.
  foldedOutcomeA = '',
  foldedOutcomeB = '',
): boolean {
  let titleHit = false;
  for (const t of titlesB) {
    if (t && titlesA.has(t)) { titleHit = true; break; }
  }
  if (!titleHit) return false;
  if (!foldNotDistinct(foldedSubjectA, foldedSubjectB)) return false;
  if (!foldNotDistinct(foldedOutcomeA, foldedOutcomeB)) return false;
  return true;
}

// Hits an exact-equal (≥5-char) folded subject with a non-discriminating value tuple (equal-
// or-both-NULL) and an exact-equal outcome slug; wall-removing only, shared by both mirrors.
/** TRUE iff two numeric-ish values are equal-or-both-NULL (numeric compare when both parse finite, else string compare). */
function scalarEqOrBothNull(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  const na = a == null ? null : typeof a === 'number' ? a : Number(a);
  const nb = b == null ? null : typeof b === 'number' ? b : Number(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a) === String(b);
  return na === nb;
}

function strEqOrBothNull(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

export function subjectExactValueUndiscriminatedDuplicateHit(
  subjectA: string | null | undefined,
  subjectB: string | null | undefined,
  canonicalKeyA: string | null | undefined,
  canonicalKeyB: string | null | undefined,
  valuePrimaryA: number | string | null | undefined,
  valuePrimaryB: number | string | null | undefined,
  valueSecondaryA: number | string | null | undefined,
  valueSecondaryB: number | string | null | undefined,
  conditionDirectionA: string | null | undefined,
  conditionDirectionB: string | null | undefined,
): boolean {
  const fa = fold(subjectA);
  const fb = fold(subjectB);
  if (fa.length < 5 || fa !== fb) return false;
  if (!scalarEqOrBothNull(valuePrimaryA, valuePrimaryB)) return false;
  if (!scalarEqOrBothNull(valueSecondaryA, valueSecondaryB)) return false;
  if (!strEqOrBothNull(conditionDirectionA, conditionDirectionB)) return false;
  if (foldOutcomeSlug(canonicalKeyA) !== foldOutcomeSlug(canonicalKeyB)) return false;
  return true;
}
