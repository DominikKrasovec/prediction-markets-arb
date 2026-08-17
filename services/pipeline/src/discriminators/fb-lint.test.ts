/**
 * The F-B lint. A builder that re-parses a title while a stamped discriminator
 * field already carries the same fact is a soundness risk: two independent
 * readings of the same fact can drift, and drift produces an unsound edge.
 * This test reads the stage4-events/*.ts sources and fails when a builder
 * applies a POSIX regex directly to a `.title` column (or reads
 * `raw->>'title'`) outside an explicit allowlist — fold on the stamped
 * discriminator, never re-parse the title.
 *
 * It is a ratchet: the allowlist is the set of files that legitimately
 * re-parse a title today (belts / documented exceptions), each annotated
 * with the reason it is permanent or the plan to retire it. Adding a new
 * title-regex site — a new builder, or an existing non-allowlisted file —
 * fails this test.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Files permitted to re-parse a title in stage4-events. Each entry: the reason
 * + the wave that retires the belt (or 'permanent'). Retiring a belt = the
 * discriminator moves upstream and this entry is DELETED from the allowlist,
 * turning the belt into a lint-enforced 0-site.
 */
const ALLOWLIST: Record<string, string> = {
  // Party member-title hand-check, retired once a `party` discriminator stamps the party.
  'margin-winner.ts': 'party member-title check → belt (retire: wave 2 D1 `party`)',
  // `dir` reads the stamped condition_direction field first; the title regex
  // is a permanent cross-check belt for unshaped "reach $X" markets (no
  // normalization fields), where the title parse of the rung facts is unavoidable.
  'reach-threshold-chain.ts': 'raw-driven rung parse (permanent belt) + reach_dir_titlecheck cross-check (D8 field consume SHIPPED WP-2.1)',
  // HALF_RX metric_scope title-check, retired once metric_scope is consumed builder-side.
  'mutual-exclusion-xq.ts': 'HALF_RX metric_scope title-check → belt (retire: wave 2 metric_scope consume)',
  // Week/month-of + time-of-day admission regex, retired once the
  // period-anchor resolution moment is stamped.
  'shape-bridge.ts': 'week/month-of + time-of-day admission (retire: wave 3 P-DATE)',
  // WC third-place/bronze exclusion — a tournament-structural belt (no
  // discriminator lifts this; it names a structurally-excluded medal match).
  'tournament-edges.ts': 'WC 3rd-place/bronze structural exclusion (permanent belt)',
  // stage_advance top-N/relegation/playoff set-membership heuristic — a
  // recall belt for a fuzzy membership predicate, not a fold key (permanent).
  'finalize.ts': 'stage_advance top-N/relegation membership heuristic (permanent belt)',
};

/** POSIX regex applied to a title column, or a raw->>'title' read. */
const TITLE_REGEX = /(?:\bm?\.?title\s*!?~)|raw\s*->>\s*'title'/;

/** True for a source line that is (heuristically) a comment, not SQL/code. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--');
}

describe('F-B lint: no title-regex in stage4 builders outside the allowlist', () => {
  const dir = fileURLToPath(new URL('../stage4-events/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  /** file → the offending code lines (comments excluded). */
  const offenders = new Map<string, string[]>();
  for (const f of files) {
    const hits: string[] = [];
    const src = readFileSync(dir + f, 'utf8').split('\n');
    for (const line of src) {
      if (isCommentLine(line)) continue;
      if (TITLE_REGEX.test(line)) hits.push(line.trim());
    }
    if (hits.length > 0) offenders.set(f, hits);
  }

  test('every title-regex site is in the allowlist', () => {
    const unlisted = [...offenders.keys()].filter((f) => !(f in ALLOWLIST));
    if (unlisted.length > 0) {
      const detail = unlisted
        .map((f) => `  ${f}:\n    ${(offenders.get(f) ?? []).join('\n    ')}`)
        .join('\n');
      throw new Error(
        `F-B lint: ${unlisted.length} stage4 builder(s) re-parse a title outside the allowlist ` +
          `— fold on the stamped discriminator instead (spec §1.5), or add an annotated allowlist ` +
          `entry naming the wave that retires it:\n${detail}`,
      );
    }
    expect(unlisted).toEqual([]);
  });

  test('the allowlist has no dead entries (belt actually still fires)', () => {
    // A belt that no longer re-parses a title should be deleted from the
    // allowlist (that is how a retired belt becomes lint-enforced); every
    // remaining entry must be a live title-regex offender.
    const dead = Object.keys(ALLOWLIST).filter((f) => !offenders.has(f));
    expect(dead).toEqual([]);
  });
});
