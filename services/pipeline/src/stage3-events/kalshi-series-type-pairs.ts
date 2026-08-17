/**
 * Deterministic SAME-FIXTURE × DIFFERENT-MARKET-TYPE PAIR rejecter (Stage-3b).
 *
 * Two candidate platform_events that describe the SAME fixture (team-fold match)
 * but resolve on DIFFERENT market types (e.g. one is "total corners", the other
 * "total goals") are structurally different questions — merging them fuses two
 * unrelated outcome spaces on one fixture. This rejecter skips the LLM for the
 * type-pairs proven 0-false-reject against ground truth. Monotone-safe: a reject
 * only SHRINKS the match graph, so it can never manufacture a fake arb; the only
 * residual risk is recall loss, and the allowlist is exactly the set with zero
 * real merges in the decided set.
 *
 * Design:
 *   (1) Kalshi `...GAME` series = the moneyline/full-game market ⇒ type NULL,
 *       never a specific type. Typing `...GAME` as a distinct `game` type
 *       false-rejects real merges (`exact_score × game`, e.g. "Ajax vs
 *       Utrecht" ≡ "AFC Ajax vs. FC Utrecht - Exact Score" — the LLM's event
 *       granularity is fixture-level there, so the exact-score market IS the
 *       same event as the moneyline). Mapping GAME⇒NULL structurally kills
 *       that class (a NULL type never forms a pair).
 *   (2) Fire ONLY on a validated type-pair ALLOWLIST (each cell decided with
 *       zero real merges) — never a blanket "different type ⇒ reject" predicate.
 *   (3) Explicit BLOCKLIST {exact_score×game, btts×exact_score} — the two
 *       cells with real merges in ground truth. `exact_score×game` is already
 *       structurally dead under GAME⇒NULL; it is listed for defence-in-depth.
 *   (4) Fixture identity folds via `foldAscii` FIRST so diacritic drift
 *       ("Côte d'Ivoire" / "Cote d Ivoire") does not split a fixture.
 *   (5) Wrapper / "More Markets" / bare titles ⇒ type NULL (kept — load-bearing).
 *
 * PURE / TOTAL / order-independent (unit-tested in `kalshi-series-type-pairs.test.ts`).
 */

/** Kalshi series-ticker suffix → market type. `GAME` is deliberately ABSENT
 *  (the full-game/moneyline series types as NULL — see doc §1). */
const KALSHI_SUFFIX_TYPE: [RegExp, string][] = [
  [/BTTS$/, 'btts'],
  [/TOTAL$/, 'total'],
  [/SPREAD$/, 'spread'],
  [/1H$/, 'first_half'],
  [/RFI$/, 'first_inning'],
  [/F5$/, 'first_five'],
  [/CORNERS$/, 'corners'],
  [/CARDS$/, 'cards'],
  [/OVERTIME$/, 'overtime'],
  // NB: no `GAME$` entry — the moneyline series types as NULL by omission.
];

/** Non-kalshi title-suffix → market type (matched against the trailing
 *  ": <segment>" / " - <segment>" of the title). */
const TITLE_SUFFIX_TYPE: [RegExp, string][] = [
  [/both teams to score|btts/i, 'btts'],
  [/total corners|\bcorners\b/i, 'corners'],
  [/total cards|\bcards\b/i, 'cards'],
  [/exact score/i, 'exact_score'],
  [/player props/i, 'player_props'],
  [/first half|1st half/i, 'first_half'],
  [/first inning|nrfi|yrfi/i, 'first_inning'],
  [/\bspread\b/i, 'spread'],
  [/total goals|\btotals?\b|\bo\/u\b|over\/under/i, 'total'],
  [/overtime/i, 'overtime'],
];

/**
 * The validated allowlist of unordered type-pairs (each decided with 0 real
 * merges in ground truth). Cells involving `game` (game×total, corners×game)
 * are INERT under the GAME⇒NULL rule above — a `game` type is never produced
 * — but are retained verbatim from the validator matrix to document that they
 * were measured safe.
 */
export const U7_TYPE_PAIR_ALLOWLIST: ReadonlySet<string> = new Set([
  typePairKey('corners', 'total'),
  typePairKey('btts', 'total'),
  typePairKey('game', 'total'), // inert (game⇒NULL)
  typePairKey('corners', 'game'), // inert (game⇒NULL)
  typePairKey('exact_score', 'total'),
  typePairKey('corners', 'spread'),
  typePairKey('cards', 'corners'),
  typePairKey('corners', 'first_half'),
  typePairKey('cards', 'total'),
  typePairKey('btts', 'corners'),
]);

/**
 * The blocklist of type-pairs with ≥1 real merge in ground truth — NEVER reject
 * these (they defer to the LLM). `exact_score×game` is additionally structurally
 * dead under GAME⇒NULL; kept for defence-in-depth.
 */
export const U7_TYPE_PAIR_BLOCKLIST: ReadonlySet<string> = new Set([
  typePairKey('exact_score', 'game'),
  typePairKey('btts', 'exact_score'),
]);

/** Canonical unordered key for a type pair. */
export function typePairKey(a: string, b: string): string {
  return a <= b ? `${a}×${b}` : `${b}×${a}`;
}

/**
 * Market type of a KALSHI event from its child series tickers (the prefix of the
 * `event_ticker`, e.g. `KXEPLCORNERS`). Returns a single type only when ALL typed
 * series agree on ONE type; NULL on `game`/no-match/mixed (so an ambiguous event
 * never keys a reject). PURE.
 */
export function kalshiSeriesType(seriesTickers: (string | null | undefined)[]): string | null {
  const types = new Set<string>();
  for (const s of seriesTickers) {
    if (!s) continue;
    for (const [re, ty] of KALSHI_SUFFIX_TYPE) {
      if (re.test(s)) { types.add(ty); break; }
    }
  }
  return types.size === 1 ? [...types][0] : null;
}

/**
 * Market type of a NON-kalshi event from the trailing descriptor of its title
 * ("… : Total Corners", "… - Exact Score"). "More Markets" wrappers and bare
 * titles ⇒ NULL. PURE.
 */
export function titleType(title: string | null | undefined): string | null {
  if (!title) return null;
  if (/more markets/i.test(title)) return null;
  const m = title.match(/(?::|-)\s*([^:-]+)$/);
  const seg = m ? m[1] : '';
  for (const [re, ty] of TITLE_SUFFIX_TYPE) if (re.test(seg)) return ty;
  return null;
}

/** Market type of an event (kalshi ⇒ series-type, else title-type). */
export function eventMarketType(
  platform: string, title: string | null, kalshiSeries: (string | null | undefined)[],
): string | null {
  return platform === 'kalshi' ? kalshiSeriesType(kalshiSeries) : titleType(title);
}

// Fixture identity (foldAscii-first)

const FIXTURE_NOISE = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'club', 'united', 'city', '1', '2', 'de', 'the', 'at', 'vs', 'v']);

/** Diacritic/case/punctuation fold of a team phrase (foldAscii FIRST). */
function fold(s: string): string {
  return foldAsciiLocal(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Local foldAscii shim (avoids a cross-module import cycle; identical NFD strip).
function foldAsciiLocal(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * The two team phrases of a fixture title ("A vs. B", "A at B", "A @ B"), each
 * foldAscii-normalised. NULL when the title is not an "A vs B" fixture. PURE.
 */
export function fixtureTeams(title: string | null | undefined): [string, string] | null {
  if (!title) return null;
  const main = title.split(/(?::| - )/)[0];
  const m = main.match(/^(.+?)\s+(?:vs\.?|at|@)\s+(.+)$/i);
  if (!m) return null;
  return [fold(m[1]), fold(m[2])];
}

function toks(s: string): Set<string> {
  return new Set(s.split(' ').filter((w) => w.length >= 4 && !FIXTURE_NOISE.has(w)));
}
function share(x: string, y: string): boolean {
  const tx = toks(x), ty = toks(y);
  for (const t of tx) if (ty.has(t)) return true;
  return x.includes(y) || y.includes(x);
}

/** TRUE iff the two folded team-pairs describe the same fixture (each side of A
 *  matches some side of B). PURE. */
export function sameFixture(fa: [string, string], fb: [string, string]): boolean {
  const s = (i: number, j: number) => share(fa[i], fb[j]);
  return (s(0, 0) || s(0, 1)) && (s(1, 0) || s(1, 1));
}

/**
 * U7 pure decision: return a reason tag iff the pair should be REJECTED — same
 * fixture, both types known, DIFFERENT, the unordered type-pair is in the
 * allowlist AND not in the blocklist. NULL otherwise (⇒ defer to the LLM). PURE.
 */
export function u7RejectTag(
  aTitle: string | null, aType: string | null,
  bTitle: string | null, bType: string | null,
): string | null {
  if (!aType || !bType || aType === bType) return null;
  const key = typePairKey(aType, bType);
  if (U7_TYPE_PAIR_BLOCKLIST.has(key)) return null;
  if (!U7_TYPE_PAIR_ALLOWLIST.has(key)) return null;
  const fa = fixtureTeams(aTitle), fb = fixtureTeams(bTitle);
  if (!fa || !fb || !sameFixture(fa, fb)) return null;
  return `deterministic: U7 same-fixture different-type (${key})`;
}
