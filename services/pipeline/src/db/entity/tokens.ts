/** Diacritic folding + tokenization helpers for entity matching. Pure, no I/O. */

/** ASCII transliteration for single codepoints that don't decompose under NFD. */
const EXTENDED_LATIN_FOLD: Record<string, string> = {
  'Ł': 'L',  'ł': 'l',
  'Đ': 'Dj', 'đ': 'dj',
  'Ø': 'O',  'ø': 'o',
  'Æ': 'Ae', 'æ': 'ae',
  'ß': 'ss',
  'Þ': 'Th', 'þ': 'th',
  'Ð': 'D',  'ð': 'd',
};

/** Diacritic-insensitive ASCII fold; must run before `tokenize()`'s charset strip, or an accented letter is dropped instead of folded to its ASCII base. */
export function foldAscii(s: string): string {
  let preprocessed = '';
  for (const ch of s) {
    preprocessed += EXTENDED_LATIN_FOLD[ch] ?? ch;
  }
  return preprocessed.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Space+case+diacritic-invariant key for a name; punctuation is intentionally kept, only whitespace is stripped. Null on empty input. */
export function spaceInvariantVariant(name: string): string | null {
  const variant = foldAscii(name).toLowerCase().replace(/\s+/g, '');
  return variant.length === 0 ? null : variant;
}

/** New space-invariant alias variants to add for one entity; caller must route the result through `mergeAliases` for cross-entity collision checks. */
export function aliasVariantsToAdd(
  canonical: string,
  existingAliases: readonly string[],
): string[] {
  // Match key mirrors the existing fold+lower lookup path (not despaced — the variant itself already is).
  const matchKey = (s: string): string => foldAscii(s).toLowerCase();

  const existingKeys = new Set<string>();
  for (const form of [canonical, ...existingAliases]) {
    existingKeys.add(matchKey(form));
  }

  const out: string[] = [];
  const emitted = new Set<string>();
  for (const form of [canonical, ...existingAliases]) {
    const variant = spaceInvariantVariant(form);
    if (variant === null) continue;
    if (existingKeys.has(variant)) continue;
    if (emitted.has(variant)) continue;
    emitted.add(variant);
    out.push(variant);
  }
  return out;
}

/** Keywords that make a name station-scoped unconditionally. */
const STATION_KEYWORD_RE =
  /\b(airport|airfield|airbase|air\s+(?:force\s+)?base|station|observatory|heliport|downtown)\b/i;

/** Venue keywords that are station-scoped only with a ", <city>" suffix — bare forms are legitimate sports-venue aliases. */
const VENUE_WITH_CITY_KEYWORD_RE = /\b(park|field|base|garden|gardens|grounds)\b/i;

/** True when a name carries a station/venue keyword; shared by every KB merge/alias guard to keep weather stations from folding into bare-city entities. */
export function isStationScopedName(name: string): boolean {
  if (STATION_KEYWORD_RE.test(name)) return true;
  if (name.includes(',') && VENUE_WITH_CITY_KEYWORD_RE.test(name)) return true;
  return false;
}

/** Trailing ", <city>" of a station-scoped name, or null. */
export function stationCityContext(name: string): string | null {
  if (!isStationScopedName(name)) return null;
  const m = name.match(/,\s*([^,]+?)\s*$/);
  return m ? m[1] : null;
}

/** Lowercase significant tokens (>=3 chars), diacritic-folded first. */
export function tokenize(text: string): string[] {
  return foldAscii(text)
    .split(/[\s\-_/]+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= 3);
}

/** Context words that alone don't prove two subjects are the same entity; the Tier-2 cosine merge requires >=1 non-context token. */
export const T2_CONTEXT_TOKENS: ReadonlySet<string> = new Set([
  'end', 'draw', 'win', 'wins', 'lose', 'lost', 'beat', 'score', 'game', 'match',
  'will', 'the', 'and', 'for', 'not', 'first', 'last', 'next',
  'saudi', 'club',
  'team', 'party', 'coach',
]);

/** tokenize() minus T2_CONTEXT_TOKENS; an empty result means the name can only merge via an exact alias. */
export function entitySpecificTokens(name: string): string[] {
  return tokenize(name.toLowerCase()).filter((t) => !T2_CONTEXT_TOKENS.has(t));
}

const INITIAL_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'for', 'in', 'on', 'at', 'by', 'to',
]);

/** True when `acronym` is plausibly `fullName`'s initials, skipping connectives. */
export function looksLikeAcronymOf(acronym: string, fullName: string): boolean {
  const a = acronym.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (a.length < 2 || a.length > 5) return false;
  const initials = computeAcronym(fullName);
  return initials !== null && initials === a;
}

/** Lowercased initials acronym for `text` (needs >=2 significant tokens), or null. */
export function computeAcronym(text: string): string | null {
  const tokens = text
    .trim()
    .toLowerCase()
    .split(/[\s\-]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0 && !INITIAL_STOPWORDS.has(t));
  if (tokens.length < 2) return null;
  const initials = tokens.map((t) => t[0]).join('');
  if (initials.length < 2 || initials.length > 5) return null;
  return initials;
}

/** Words that are NOT meaningful for entity matching (titles, roles, articles) */
const ENTITY_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'for', 'and', 'or', 'to', 'at', 'by', 'on', 'is', 'was',
  'president', 'prime', 'minister', 'senator', 'governor', 'king', 'queen', 'prince',
  'chairman', 'ceo', 'cfo', 'cto', 'coach', 'manager', 'director', 'mr', 'mrs', 'ms', 'dr',
  'u.s.', 'us', 'uk', 'former', 'current', 'acting', 'vice', 'deputy',
]);

/** Kept as significant tokens since they distinguish otherwise-identical names (e.g. "Trump" vs "Trump Jr."). */
const GENERATIONAL_SUFFIXES: ReadonlySet<string> = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

/** Canonical generational suffix ("JR", "III", ...) carried by any of `forms`, or null. */
export function getGenerationalSuffix(forms: string[]): string | null {
  for (const form of forms) {
    const m = form.match(/\b(jr|sr|ii|iii|iv|v)\.?\s*$/i);
    if (m) {
      const norm = m[1].toUpperCase();
      if (GENERATIONAL_SUFFIXES.has(norm)) return norm;
    }
  }
  return null;
}

/**
 * Significant tokens for fuzzy matching: filters stop words/titles, keeps
 * 2-char ALL-CAPS qualifiers ("NC", "GA") and generational suffixes.
 */
export function extractSignificantTokens(forms: string[]): string[] {
  const tokens = new Set<string>();
  for (const form of forms) {
    for (const word of foldAscii(form).split(/\s+/)) {
      const clean = word.replace(/[.,;:()'"`]/g, '');
      const upper = clean.toUpperCase();
      const isGenerationalSuffix = GENERATIONAL_SUFFIXES.has(upper);
      const qualifies =
        isGenerationalSuffix ||
        ((clean.length >= 3 || (clean.length === 2 && /^[A-Z0-9]{2}$/.test(clean))) &&
         !ENTITY_STOP_WORDS.has(clean.toLowerCase()));
      if (qualifies) {
        tokens.add(isGenerationalSuffix ? upper : clean);
      }
    }
  }
  return [...tokens];
}
