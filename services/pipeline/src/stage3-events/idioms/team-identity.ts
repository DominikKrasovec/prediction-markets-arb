/** Fixture team-identity idioms shared by the Stage-2a backfill, the Stage-3b deterministic
 *  reject, and the zero-flip replay so they can never drift. The reject is monotone-safe. */
import { foldAscii } from '../../db/entity/tokens.js';
import { _t1FromCache } from '../../db/entity/cache.js';
import type { DomainCategory } from '@arb/types';

/** Fixture event_kinds whose native participants are outcome-label polluted (the backfill targets). */
export const FIXTURE_LABEL_POLLUTED_KINDS: ReadonlySet<string> = new Set([
  'exact_score', 'both_teams_score', 'match_total_metric', 'match_spread',
  'match_event_prop', 'player_prop_threshold',
]);

export const FIXTURE_PARTICIPANT_COMPARE_KINDS: ReadonlySet<string> = new Set([
  ...FIXTURE_LABEL_POLLUTED_KINDS, 'match_winner', 'halftime_leader',
]);

const MATCHUP_RX = /^(.+?)\s+(?:vs\.?|versus|v\.?|@)\s+(.+)$/i;
const SEP_G_RX = /\s+(?:vs\.?|versus|v\.?|@)\s+/gi;
const NON_NAME_RX =
  /\b(score|scores|scored|win|wins|won|beat|beats|lose|loses|lost|goals?|over|under|odds|points?|spread|total|advance|qualif|overtime|halftime|penalt)\b/i;

/** Necessary-not-sufficient: the KB team resolve is the real filter. */
export function isFixtureNameLike(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || !/[a-z]/i.test(t)) return false;
  if (t.split(/\s+/).length > 4) return false;
  if (NON_NAME_RX.test(t)) return false;
  return true;
}

/** Parses "A vs B" out of a fixture-kind title. Returns null on doubt, never throws. */
export function parseFixtureMatchupTitle(title: string): [string, string] | null {
  const s = title.trim().replace(/[‐-―−]/g, '-');
  const seps = s.match(SEP_G_RX);
  if (seps && seps.length > 1) return null;
  const m = MATCHUP_RX.exec(s);
  if (!m) return null;
  let a = m[1].trim();
  a = a.split(',').pop()!.trim();
  a = a.split(':').pop()!.trim();
  a = a.replace(/^\s*(will|who\s+wins?|match:|game:|prediction:)\s+/i, '').trim();
  let b = m[2].trim();
  b = b.split(',')[0]!.trim();
  b = b.split(/\s+-\s+/)[0]!.trim();
  b = b.split(':')[0]!.trim();
  b = b.replace(/[?.!]+$/, '').trim();
  if (!isFixtureNameLike(a) || !isFixtureNameLike(b)) return null;
  if (a.toLowerCase() === b.toLowerCase()) return null;
  return [a, b];
}

/** Read-only: cache-backed T1 only, type-filtered to `team`, scoped by sport/league. */
export async function resolveTeamCanonical(
  name: string, domain: DomainCategory, sport: string | null, league: string | null,
): Promise<string | null> {
  const t = name.trim();
  if (!t) return null;
  const hit = await _t1FromCache(t.toLowerCase(), t, domain, ['team'], { sport, league });
  return hit?.canonical ?? null;
}

// Generic tokens dropped before comparison; distinctive words ("United", "Real") are kept.
const GENERIC_TEAM_TOK = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'cd', 'rc', 'ca', 'sd', 'kk', 'bk', 'fk', 'ss',
  'ud', 'sk', 'if', 'bc', 'ec', 'sv', 'de', 'del', 'the', 'club', 'saudi',
]);

function sigTokens(name: string): string[] {
  return foldAscii(name).toLowerCase().replace(/[.\-'’]/g, ' ').split(/\s+/)
    .filter((t) => t && !GENERIC_TEAM_TOK.has(t) && !/^\d+$/.test(t));
}
function bigrams(s: string): Set<string> {
  const o = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2));
  return o;
}
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Used only to SUPPRESS a reject, so generous = safe. */
export function sameTeamFuzzy(x: string, y: string): boolean {
  const sx = sigTokens(x), sy = sigTokens(y);
  if (sx.length === 0 || sy.length === 0) return true;
  const setx = new Set(sx), sety = new Set(sy);
  if ([...setx].every((t) => sety.has(t)) || [...sety].every((t) => setx.has(t))) return true;
  for (const t of setx) if (sety.has(t) && t.length >= 4) return true;
  const jx = sx.join(''), jy = sy.join('');
  if (jx.startsWith(jy) || jy.startsWith(jx)) return true;
  if (diceCoefficient(jx, jy) >= 0.5) return true;
  return false;
}

/** ANY cross-side team pair fuzzy-matching ⇒ likely the same fixture, mis-resolved. */
export function anyTeamFuzzy(sa: ReadonlySet<string>, sb: ReadonlySet<string>): boolean {
  for (const x of sa) for (const y of sb) if (sameTeamFuzzy(x, y)) return true;
  return false;
}

/** TRUE iff two events are a different-fixture pair rejectable without an LLM call. */
export function isDisjointDifferentFixture(
  sa: ReadonlySet<string>, sb: ReadonlySet<string>,
): boolean {
  if (sa.size !== 2 || sb.size !== 2) return false;
  for (const x of sa) if (sb.has(x)) return false;
  if (anyTeamFuzzy(sa, sb)) return false;
  return true;
}
