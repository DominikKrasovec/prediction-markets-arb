/**
 * Defensive parsers for JSONB column values returned by the Postgres
 * driver. Live in `@arb/db` because the "Postgres might return JSONB
 * as either a native value or a stringified form" dance is a property
 * of the DB layer, not of any particular caller's domain.
 *
 * History: there were SEVEN incarnations of this defensive-parse
 * pattern scattered across `services/pipeline` and elsewhere, with
 * subtly different micro-decisions (`.filter` vs `.map(String)`,
 * different fallback values). Drift caught during the entity-write
 * unification refactor.
 * Canonicalised here so future drift gets a one-import fix instead
 * of a per-domain rewrite.
 */

/**
 * Parse a JSONB array column value into `string[]`. Handles three
 * shapes the pg driver can return:
 *
 *   - Native array (newer drivers, `jsonb` cast to array)
 *   - Stringified JSON (older paths, `jsonb` returned as text)
 *   - `null` / `undefined` / non-array / non-string → returns `[]`
 *
 * Non-string elements inside an array are **dropped**, not coerced.
 * Synthesising strings from numbers ("3" from 3) loses information
 * about source-data shape — better to surface the empty result and
 * let the caller add explicit coercion when intended (e.g.
 * `parseJsonbArray(raw).map(String)` for explicit string coercion).
 *
 * Never throws. Malformed JSON returns `[]`.
 */
export function parseJsonbArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Parse a JSONB object column value into `Record<string, unknown>`.
 * Same defensive shape-handling as `parseJsonbArray`:
 *
 *   - Native object → returned as-is (typed as `Record<string, unknown>`)
 *   - Stringified JSON → parsed; if result is an object, returned
 *   - `null` / array / non-object / non-string → returns `{}`
 *
 * Returns `{}` rather than `null` so callers can drop the `?? {}`
 * idiom that used to dot every consumer site.
 *
 * Never throws. Malformed JSON returns `{}`.
 */
export function parseJsonbObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}
