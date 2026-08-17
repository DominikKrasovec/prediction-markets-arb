/**
 * Resolution-time alias deny-list.
 *
 * A known-bad alias→entity mapping is never honored at resolution. This is
 * deliberately not a DB deletion and not a periodic KB mutation:
 *   · KB state stays untouched: Stage-1d/1e enrichments on the target row
 *     (and the alias arrays themselves) are fully preserved.
 *   · Rebuild-reproducing because it is code: a wipe re-mints entity ids, but
 *     the deny key is (type, folded canonical), content not id.
 *   · An LLM enrichment re-adding the bad alias changes nothing; the deny
 *     fires at lookup time, in the cache.ts T1 alias path.
 *
 * Failure direction is the safe one: denying an alias can only turn a
 * wrong-canonical hit into a different-candidate hit or an honest miss, never
 * mint a new attachment.
 *
 * Before adding a row here, census the live rows whose stored phrase folds to
 * the denied alias and confirm the flip: those phrases can re-resolve only to
 * a non-denied candidate or stay a miss; associated canonical_event re-keys
 * ride the standing Stage-1f path / rebuild boundary.
 *
 * The standing lints live in soundness-regression-asserts.ts.
 */

export interface AliasDenyEntry {
  /** known_entities.type of the DENIED target row. */
  type: string;
  /** Folded (foldAscii + lowercase — the cache's _kbKey) canonical of the
   *  denied target. NEVER an id (ids re-mint at rebuild). */
  canonicalFold: string;
  /** Folded alias strings never honored for this target. */
  denyAliasFolds: readonly string[];
  /**
   * Domain scope-gate: when set, the deny fires only for lookups whose caller
   * domain is not in this list — the alias stays honored inside its home
   * domain but is refused everywhere else, including the `'other'` scope-less
   * wildcard. Omitted = unconditional deny.
   */
  allowDomains?: readonly string[];
  /** Why the attachment is factually wrong (audit citation). */
  reason: string;
}

export const ALIAS_DENY_LIST: readonly AliasDenyEntry[] = [
  {
    type: 'team',
    canonicalFold: 'south carolina gamecocks',
    denyAliasFolds: ['usc'],
    reason:
      "'USC' is the University of Southern California (USC Trojans); the attachment to " +
      'South Carolina Gamecocks is factually wrong (correctness audit 2026-06-12 finding 4, probe-kb §3)',
  },
  {
    type: 'asset',
    canonicalFold: 'avax',
    denyAliasFolds: ['avalanche'],
    allowDomains: ['crypto'],
    reason:
      "the seeded bare-word alias 'Avalanche' on the AVAX crypto asset (seed-entity-kb.ts) " +
      'collides with the NHL Colorado Avalanche; a non-crypto subject resolving through a ' +
      "scope-less (domain='other') fold+lower alias lookup would land on the crypto asset " +
      '(parser mis-extraction census 2026-07-02 §4c). Crypto-domain lookups keep resolving ' +
      "'Avalanche' → AVAX; everywhere else the alias tiers refuse and the lookup falls " +
      "through to T2, which finds 'Colorado Avalanche' via the shared token or honestly misses",
  },
];

/** Fast lookup index: `${type}␟${canonicalFold}` → per-alias allow-domains
 *  (`null` = unconditional deny). */
const _denyIndex = new Map<string, Map<string, ReadonlySet<string> | null>>();
for (const e of ALIAS_DENY_LIST) {
  const m = _denyIndex.get(`${e.type}␟${e.canonicalFold}`) ?? new Map<string, ReadonlySet<string> | null>();
  for (const a of e.denyAliasFolds) {
    m.set(a, e.allowDomains ? new Set(e.allowDomains) : null);
  }
  _denyIndex.set(`${e.type}␟${e.canonicalFold}`, m);
}

/**
 * True when `aliasFold` (the folded lookup key) must NOT resolve to the row
 * identified by (type, canonicalFold). Consulted by the cache.ts T1 alias
 * tiers (T1b/T1c); canonical-match lookups (T1a) are deliberately exempt —
 * denying an alias never denies the canonical itself.
 *
 * `domain` is the CALLER's domain_category for the lookup (the market's
 * domain, not the row's). Entries carrying `allowDomains` deny everywhere
 * EXCEPT those domains; entries without it deny unconditionally. Callers that
 * have no domain concept pass nothing → domain-scoped entries treat that as
 * outside the allow-set (the conservative direction: a refusal can only turn
 * a wrong-canonical HIT into a different candidate or an honest MISS).
 */
export function isAliasDenied(
  aliasFold: string,
  type: string,
  canonicalFold: string,
  domain?: string,
): boolean {
  const allow = _denyIndex.get(`${type}␟${canonicalFold}`)?.get(aliasFold);
  if (allow === undefined) return false;          // not a denied alias
  if (allow === null) return true;                // unconditional deny
  return !(domain != null && allow.has(domain));  // denied outside allowDomains
}
