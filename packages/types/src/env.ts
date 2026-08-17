/**
 * Env-var readers with deprecated-alias back-compat.
 *
 * An env-prefix consolidation (SOLVER_* / bare knobs -> SOLVE_*, EVENT_EMBED* /
 * EVENT_EMBEDDING* -> EMBED_*) must not break the live VPS systemd units, which
 * still set the old names. These helpers read the new (canonical) name first and
 * fall back to the old (alias) name with a one-time `console.warn` per alias per
 * process, so every old name keeps working while operators migrate.
 *
 * Placement: @arb/types is the zero-dependency leaf package that BOTH services
 * and their scripts already import — putting the helper here needs no new
 * workspace wiring and no new package (which on this Windows checkout would add
 * junction/link risk). The helper is a tiny pure runtime util, tree-shaken away
 * anywhere it is not called.
 */

const warnedAliases = new Set<string>();

function warnAliasOnce(alias: string, canonical: string): void {
  if (warnedAliases.has(alias)) return;
  warnedAliases.add(alias);
  console.warn(
    `[env] "${alias}" is a DEPRECATED alias for "${canonical}" — honoring it for ` +
      `now, but please set "${canonical}" instead (the alias will be removed in a ` +
      `future release).`,
  );
}

export interface EnvAliasOptions {
  /** Legacy env-var name to fall back to (with a one-time deprecation warn). */
  alias?: string;
}

/**
 * Read `process.env[name]`. If it is unset and an `alias` (legacy name) is
 * given, fall back to `process.env[alias]` and emit a one-time deprecation warn.
 * Returns `undefined` when neither is set, so callers keep supplying their
 * default via `?? 'x'` exactly as before.
 */
export function readEnv(name: string, opts?: EnvAliasOptions): string | undefined {
  const primary = process.env[name];
  if (primary !== undefined) return primary;
  const alias = opts?.alias;
  if (alias !== undefined) {
    const legacy = process.env[alias];
    if (legacy !== undefined) {
      warnAliasOnce(alias, name);
      return legacy;
    }
  }
  return undefined;
}

/**
 * Boolean env read using the project's established flag semantics (matches the
 * long-standing `envFlag` in arb-solver/config.ts): `undefined` -> `dflt`,
 * otherwise TRUE unless the value is exactly `'false'` or `'0'`. Honors the same
 * deprecated-alias fallback as {@link readEnv}.
 */
export function readBoolEnv(name: string, dflt: boolean, opts?: EnvAliasOptions): boolean {
  const raw = readEnv(name, opts);
  if (raw === undefined) return dflt;
  return raw !== 'false' && raw !== '0';
}
