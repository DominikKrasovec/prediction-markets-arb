/**
 * Bare-alias classifier.
 *
 * A "bare" alias is a shortened, less-specific form of an entity's name — `Recoleta`
 * on `Recoleta FC`, `San Lorenzo` / `sanlorenzo` on `CA San Lorenzo de Almagro`. Bare
 * forms are legitimate and useful when the entity is scoped (a league pins which
 * `San Lorenzo` is meant); on an unscoped row (`league_canonical IS NULL`) they are a
 * cross-entity magnet: the next market naming any San Lorenzo in any league resolves to
 * whichever unscoped row happens to carry the bare token, and the KB silently fuses two
 * different clubs.
 *
 * This module is the one definition of "bare", shared by the write-side gate
 * (`mergeAliases`), the read-side alias-trigger belt (both in db/entity/register.ts) and
 * the idempotent KB sweep (db/seed-entity-kb.ts). Pure — no DB, no I/O.
 *
 * DEFINITION. Bare means "carries NO information the canonical does not already carry,
 * and not all of it". Concretely, with fold = lower + ASCII-fold, RAW tokens = folded
 * alphanumeric runs, and SIGNIFICANT tokens = raw tokens of ≥3 characters (so the club
 * designators `FC`, `CA`, `SC` and the connectives `de`, `do`, `la` drop out), an alias
 * is BARE for owner (canonical, aliases) when
 *   (1) every raw token of the alias DECOMPOSES into canonical raw tokens — either it IS
 *       one, or (the despaced case) it is a concatenation of several, `sanlorenzo` =
 *       `san`+`lorenzo`. A token that does not decompose is NEW INFORMATION, so the
 *       alias is a distinct form, not a shortening: `Chicago W` (the RC2 same-city code
 *       — `w` is not `white`), `zzbatchsc AR`, `Inter Milan` vs `Internazionale Milano`;
 *   (2) the SIGNIFICANT canonical tokens it uses are a PROPER subset of the canonical's,
 *       or there is at most one of them (`Recoleta` on `Recoleta FC`);
 * and it is NOT
 *   (i)  an all-caps ticker/code (`^[A-Z0-9]{2,6}$`) or ≤2 folded characters;
 *   (ii) the despaced/folded variant of the canonical or of any FULL form (an alias that
 *        is not itself bare). This keeps `casanlorenzodealmagro`, `sanlorenzodealmagro`
 *        and `recoletafc` — the space-invariant variants `mergeAliasVariants` mints for
 *        the full names — OUT of the bare set, while `sanlorenzo` (the despaced variant
 *        of the BARE `San Lorenzo`) stays in it.
 */
import { foldAscii } from './tokens.js';

/**
 * Entity types whose bare aliases require a league scope. Team only, deliberately — a
 * `league` / `competition` row has `league_canonical IS NULL` by nature (a league is not
 * in a league), so applying the gate to them would strip every curated short name
 * ("Premier" on "Premier League") and fight seedLeagueDedup's curated-alias
 * re-assertion. Teams are also the entire observed failure class. Lives here (not
 * register.ts) so the seed sweep can read it without an import cycle.
 */
export const BARE_ALIAS_SCOPED_TYPES: ReadonlySet<string> = new Set(['team']);

/** Minimum folded length for a token to count as significant (drops FC/CA/SC/de/la). */
const MIN_SIGNIFICANT_TOKEN_LEN = 3;

/** fold + lower + strip every non-alphanumeric (the "despaced" identity form). */
export function flatForm(s: string): string {
  return foldAscii(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** All folded alphanumeric runs of a name (no length filter). */
export function rawTokens(s: string): string[] {
  return foldAscii(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** The folded significant tokens of a name (≥3 chars each). */
export function significantTokens(s: string): string[] {
  return rawTokens(s).filter((t) => t.length >= MIN_SIGNIFICANT_TOKEN_LEN);
}

/**
 * Decompose `token` into a concatenation of `vocab` members (word-break DP), returning
 * the members used, or null when it does not decompose. Longest-first at each position
 * is enough for name vocabularies and keeps it O(|token|·|vocab|).
 */
function decompose(token: string, vocab: readonly string[]): string[] | null {
  if (token.length === 0) return [];
  const sorted = [...vocab].sort((a, b) => b.length - a.length);
  // best[i] = the parts consuming token[0..i), or null.
  const best: Array<string[] | null> = new Array(token.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < token.length; i++) {
    const prefix = best[i];
    if (prefix === null) continue;
    for (const v of sorted) {
      const end = i + v.length;
      if (end > token.length || best[end] !== null) continue;
      if (token.startsWith(v, i)) best[end] = [...prefix, v];
    }
  }
  return best[token.length];
}

/** True ⟺ the raw form is an all-caps ticker/code or too short to be a name. */
export function isCodeLikeAlias(alias: string): boolean {
  const raw = alias.trim();
  if (/^[A-Z0-9]{2,6}$/.test(raw)) return true;
  return flatForm(raw).length <= 2;
}

/**
 * Is `alias` a SHORTENING of `canonical` (conditions (1)+(2) of the module header)?
 * Ignores the code/ticker and full-form exemptions, which {@link classifyBareAliases}
 * applies around it.
 */
function isShorteningOf(alias: string, canonical: string): boolean {
  const canonRaw = rawTokens(canonical);
  if (canonRaw.length === 0) return false;
  const canonSet = new Set(canonRaw);
  const canonSig = new Set(canonRaw.filter((t) => t.length >= MIN_SIGNIFICANT_TOKEN_LEN));

  const usedSig = new Set<string>();
  for (const t of rawTokens(alias)) {
    const parts = canonSet.has(t) ? [t] : decompose(t, canonRaw);
    if (parts === null) return false; // (1) a token the canonical does not contain
    for (const p of parts) if (p.length >= MIN_SIGNIFICANT_TOKEN_LEN) usedSig.add(p);
  }
  // (2) at most one significant token used, or a PROPER subset of the canonical's.
  if (usedSig.size <= 1) return true;
  return usedSig.size < canonSig.size;
}

/**
 * Classify an owner's alias list into `bare` and `kept`. `aliases` should be the FULL
 * alias set the owner would carry (existing ∪ candidates) so the full-form exemption
 * sees the multi-token names the despaced variants derive from.
 */
export function classifyBareAliases(
  canonical: string,
  aliases: readonly string[],
): { bare: string[]; kept: string[] } {
  // FULL forms = the canonical plus every alias that is NOT itself a shortening of it.
  // Their despaced variants are exempt (that is what `mergeAliasVariants` mints).
  const fullFlats = new Set<string>([flatForm(canonical)]);
  for (const a of aliases) {
    if (!isShorteningOf(a, canonical)) fullFlats.add(flatForm(a));
  }

  const bare: string[] = [];
  const kept: string[] = [];
  for (const a of aliases) {
    if (isCodeLikeAlias(a) || fullFlats.has(flatForm(a)) || !isShorteningOf(a, canonical)) {
      kept.push(a);
    } else {
      bare.push(a);
    }
  }
  return { bare, kept };
}

/**
 * True ⟺ `alias` is BARE for the owner. `otherAliases` is the owner's remaining alias
 * set (used only for the full-form exemption). Convenience over
 * {@link classifyBareAliases} for the single-candidate write/read paths.
 */
export function isBareAliasFor(
  canonical: string,
  otherAliases: readonly string[],
  alias: string,
): boolean {
  const all = otherAliases.includes(alias) ? [...otherAliases] : [...otherAliases, alias];
  return classifyBareAliases(canonical, all).bare.some((b) => b === alias);
}
