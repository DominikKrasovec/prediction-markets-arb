/** The ONE place that decides whether two markets' settlement authorities are
 *  known to differ. Equality is exact (post-trim) over the controlled RESOLUTION_ORACLES
 *  vocabulary; NULL policy is both-known-and-differ. Pure -- the TS predicate
 *  and SQL fragment are emitted from the same constant so they cannot drift. */

/** Values that carry no data-authority information (e.g. 'UMA', a ratification
 *  mechanism, not a reading of its own) -- read as unknown. */
export const NON_DISCRIMINATING_ORACLES: ReadonlySet<string> = new Set(['UMA']);

export function discriminatingOracle(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === '') return null;
  return NON_DISCRIMINATING_ORACLES.has(v) ? null : v;
}

export function oraclesKnownToDiffer(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const da = discriminatingOracle(a);
  const db = discriminatingOracle(b);
  return da !== null && db !== null && da !== db;
}

/** Set-grain twin of {@link oraclesKnownToDiffer}: sorted distinct discriminating
 *  authorities when the collection spans >=2, else null. */
export function conflictingOracles(
  values: Iterable<string | null | undefined>,
): string[] | null {
  const known = new Set<string>();
  for (const v of values) {
    const d = discriminatingOracle(v);
    if (d !== null) known.add(d);
  }
  return known.size >= 2 ? [...known].sort() : null;
}

function nonDiscriminatingSqlList(): string {
  return [...NON_DISCRIMINATING_ORACLES].map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

export function discriminatingOracleSql(col: string): string {
  return `NULLIF(CASE WHEN btrim(${col}) IN (${nonDiscriminatingSqlList()}) THEN NULL ELSE btrim(${col}) END, '')`;
}

/** TRUE = the pair may stand; the conjunct a builder adds to keep a pair. */
export function oraclesCompatibleSql(a: string, b: string): string {
  const da = discriminatingOracleSql(a);
  const db = discriminatingOracleSql(b);
  return `NOT (${da} IS NOT NULL AND ${db} IS NOT NULL AND ${da} IS DISTINCT FROM ${db})`;
}

export function oraclesKnownToDifferSql(a: string, b: string): string {
  return `NOT (${oraclesCompatibleSql(a, b)})`;
}
