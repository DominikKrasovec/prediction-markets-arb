import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildEquivalenceEdgesSql,
  buildStructureTierViolationsSql,
  classifyPlatformStructure,
  drawScopeCrossSeriesRefused,
  htFtScopeMismatch,
  isHalfScope,
  HALF_ABBREV_SCOPE_RX,
  boundStrictnessCompatibleSql,
  type StructureTierNode,
} from './equivalence-edge.js';
import { integerGrainUnitsSql } from '../util/condition-shape.js';
import {
  settlementDimensionSql, settlementDimensionCompatibleSql,
} from '../util/settlement-instrument.js';
import { buildMutualExclusionXqEdgesSql } from './mutual-exclusion-xq.js';
import { oraclesCompatibleSql } from '../util/resolution-oracle-compare.js';

const sql = buildEquivalenceEdgesSql();
const muxSql = buildMutualExclusionXqEdgesSql();

test('writes an equivalence edge with the cross_question_equiv pattern label', () => {
  expect(sql).toContain("'equivalence'");
  expect(sql).toContain("'cross_question_equiv'");
});

test('writes a hard, algorithmic, full-confidence edge', () => {
  expect(sql).toContain('1.0, TRUE');
  expect(sql).toContain("'algorithmic'");
});

test('gates on the same-event fragment (game_ordinal marker present)', () => {
  expect(sql).toContain("discriminators->>'game_ordinal'");
});

test('asserts SAME OUTCOME: kind equal + subject/direction/metric NULL-tolerant', () => {
  expect(sql).toContain('a.event_kind = b.event_kind');
  expect(sql).toContain('a.canonical_subject   IS NOT DISTINCT FROM b.canonical_subject');
  expect(sql).toContain('a.condition_direction IS NOT DISTINCT FROM b.condition_direction');
  expect(sql).toContain('a.condition_metric    IS NOT DISTINCT FROM b.condition_metric');
});

test('asserts SAME VALUE and NULL-rejects numeric shapes', () => {
  expect(sql).toContain('a.value_primary IS NOT DISTINCT FROM b.value_primary');
  expect(sql).toContain('a.value_unit    IS NOT DISTINCT FROM b.value_unit');
  expect(sql).toContain(
    "a.condition_shape IN ('monotonic_threshold','point_in_time','range_snapshot','price_snapshot','cumulative_deadline')",
  );
  expect(sql).toContain('a.value_primary IS NULL');
});

test('excludes crypto candle directions (kept as merges)', () => {
  expect(sql).toContain("a.event_kind <> 'candle_direction'");
});

test('wires the per-side Kalshi series CTE + draw-scope cross-series gate', () => {
  expect(sql).toContain('equiv_kalshi_series AS (');
  expect(sql).toContain('LEFT JOIN equiv_kalshi_series ksa ON ksa.question_id = a.question_id');
  expect(sql).toContain('LEFT JOIN equiv_kalshi_series ksb ON ksb.question_id = b.question_id');
  expect(sql).toContain("ksa.series IS DISTINCT FROM ksb.series");
  expect(sql).toContain("draw_axis','') = 'draw'");
});

test('drawScopeCrossSeriesRefused: F3 ≢ F7 refused; same-series / NULL-series kept', () => {
  expect(drawScopeCrossSeriesRefused(true, true, 'KXMLBF3', 'KXMLBF7')).toBe(true);
  expect(drawScopeCrossSeriesRefused(true, true, 'KXMLBF5', 'KXMLBF3')).toBe(true);
  expect(drawScopeCrossSeriesRefused(true, true, 'KXMLBGAME', 'KXMLBGAME')).toBe(false);
  expect(drawScopeCrossSeriesRefused(true, true, 'KXMLBF3', null)).toBe(false);
  expect(drawScopeCrossSeriesRefused(true, true, null, null)).toBe(false);
  expect(drawScopeCrossSeriesRefused(false, true, 'KXMLBF3', 'KXMLBF7')).toBe(false);
});

test('wires the HT↔FT scope-mismatch gate into the cand WHERE', () => {
  expect(sql).toContain("COALESCE(a.metric_scope, '') IN ('half_1','half_2')");
  expect(sql).toContain('half[ -]?time|1st half|first half|2nd half|second half|at the half');
  expect(sql).toContain('AND NOT (');
  expect(sql).toContain(
    "COALESCE(a.metric_scope, '') IN ('half_1','half_2') OR COALESCE(lower(immutable_unaccent(a.title)) ~ '\\m(half[ -]?time|1st half|first half|2nd half|second half|at the half)\\M', FALSE)",
  );
  expect(sql).toContain(
    "COALESCE(b.metric_scope, '') IN ('half_1','half_2') OR COALESCE(lower(immutable_unaccent(b.title)) ~ '\\m(half[ -]?time|1st half|first half|2nd half|second half|at the half)\\M', FALSE)",
  );
});

test('F2: fiscal-guarded 1H/2H abbreviation arm is wired into isHalfScopeSql', () => {
  expect(sql).toContain("~ '\\m1h\\M|\\m2h\\M'");
  expect(sql).toContain('\\m(q[1-4]|[1-4]h|h[1-4])\\s+(of\\s+)?(fy\\s?)?(19|20)\\d{2}\\M');
  expect(sql).toContain('\\m(revenue|earnings|eps|gdp|cpi');
});

test('isHalfScope: structured half OR half/period title reads as half-scope', () => {
  expect(isHalfScope('half_1', 'FK Borac Banja Luka leading at halftime?')).toBe(true);
  expect(isHalfScope('half_2', 'Whatever')).toBe(true);
  expect(isHalfScope(null, 'PFK Levski Sofia vs. FK Borac Banja Luka: Second half draw?')).toBe(true);
  expect(isHalfScope(null, 'Will Banja Luka win the 1st Half?')).toBe(true);
  expect(isHalfScope(null, 'Will FK Borac Banja Luka win on 2026-07-14?')).toBe(false);
  expect(isHalfScope(null, 'Will PFK Levski Sofia vs. FK Borac Banja Luka end in a draw?')).toBe(false);
});

test('F2 isHalfScope: bare 1H/2H reads as half; fiscal 1H/2H does NOT', () => {
  expect(isHalfScope(null, 'Team A vs Team B 1H winner')).toBe(true);
  expect(isHalfScope(null, 'Lakers vs Celtics 2H spread')).toBe(true);
  expect(isHalfScope(null, 'Deere 1H 2026 revenue above $12.5B?')).toBe(false);
  expect(isHalfScope(null, 'Will 1H 2026 GDP be positive?')).toBe(false);
  expect(isHalfScope(null, 'Will Deere 1H revenue beat guidance?')).toBe(false);
  expect(isHalfScope(null, 'Total goals over 2.5')).toBe(false);
});

test('F2 twin-sync: the 1H/2H abbreviation literal is byte-aligned across all three sites', () => {
  expect(HALF_ABBREV_SCOPE_RX).toBe('\\m1h\\M|\\m2h\\M');
  expect(sql).toContain(HALF_ABBREV_SCOPE_RX);
  expect(muxSql).toContain(HALF_ABBREV_SCOPE_RX);
  for (const s of [sql, muxSql]) {
    expect(s).toContain('\\m(q[1-4]|[1-4]h|h[1-4])\\s+(of\\s+)?(fy\\s?)?(19|20)\\d{2}\\M');
    expect(s).toContain('\\m(revenue|earnings|eps|gdp|cpi');
  }
});

test('htFtScopeMismatch: HT↔FT pairs are refused; same-scope pairs are kept', () => {
  expect(htFtScopeMismatch('half_1', 'FK Borac Banja Luka leading at halftime?', null, 'Will FK Borac Banja Luka win on 2026-07-14?')).toBe(true);
  expect(htFtScopeMismatch('half_1', 'Draw at halftime?', null, 'Will ... end in a draw?')).toBe(true);
  expect(htFtScopeMismatch(null, 'Second half draw?', null, 'end in a draw?')).toBe(true);
  expect(htFtScopeMismatch('half_1', 'Will Banja Luka win the 1st Half?', 'half_1', 'FK Borac Banja Luka leading at halftime?')).toBe(false);
  expect(htFtScopeMismatch(null, 'Will X win on 2026-07-14?', null, 'X vs Y Winner?')).toBe(false);
  expect(htFtScopeMismatch('game', 'O/U 2.5', null, 'Total goals over/under 2.5')).toBe(false);
});

test('TOUCH ≢ SNAPSHOT: monotonic_threshold never equates with point_in_time/range_snapshot (audit §6 S3)', () => {
  expect(sql).toContain(
    "(a.condition_shape = 'monotonic_threshold' AND b.condition_shape IN ('point_in_time','range_snapshot','price_snapshot'))",
  );
  expect(sql).toContain(
    "(b.condition_shape = 'monotonic_threshold' AND a.condition_shape IN ('point_in_time','range_snapshot','price_snapshot'))",
  );
});

test('defensively refuses two slots of the same outcome_set (mutex, not equal)', () => {
  expect(sql).toContain('outcome_set_slots s1');
  expect(sql).toContain('s1.set_id = s2.set_id');
});

test('orders the pair (a < b) and is first-writer-wins on conflict', () => {
  expect(sql).toContain('a.question_id < b.question_id');
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('carries the cheap hashable canonical_event equality in the JOIN ON', () => {
  expect(sql).toContain(
    'lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))',
  );
});

test('G_B: gates value_secondary so different exact scorelines (2-2 vs 2-3) do not fuse', () => {
  expect(sql).toContain('a.value_secondary IS NOT DISTINCT FROM b.value_secondary');
});

test('G_A: rejects same-platform_event binary sibling props with different titles', () => {
  expect(sql).toContain("a.condition_shape = 'binary_event' AND b.condition_shape = 'binary_event'");
  expect(sql).toContain('a.platform_event_id = b.platform_event_id');
  expect(sql).toContain('lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))');
});

test('G_C: requires order/case/accent-insensitive participants equality for participant kinds', () => {
  expect(sql).toContain("'match_spread'"); // PARTICIPANT_KINDS_SQL member
  expect(sql).toContain('array_agg(lower(immutable_unaccent(x)) ORDER BY lower(immutable_unaccent(x)))');
  expect(sql).toContain('FROM unnest(a.participants) x');
});

test('G_D: gates on the per-QUESTION deadline (questions.condition_date), not the pe date', () => {
  expect(sql).toContain('JOIN questions qa ON qa.id = c.aq');
  expect(sql).toContain('JOIN questions qb ON qb.id = c.bq');
  expect(sql).toContain('(qa.condition_date IS NULL AND qb.condition_date IS NULL)');
  expect(sql).toContain("left(qa.condition_date, CASE GREATEST(CASE qa.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END");
  expect(sql).not.toContain('qa.condition_date IS NOT DISTINCT FROM qb.condition_date');
});

test('metric_scope gate: NULL-tolerant both-known-and-differ (preserves one-side-NULL xplat equivs)', () => {
  expect(sql).toContain(
    'NOT (a.metric_scope IS NOT NULL AND b.metric_scope IS NOT NULL AND a.metric_scope IS DISTINCT FROM b.metric_scope)',
  );
  expect(sql).not.toContain('a.metric_scope IS NOT DISTINCT FROM b.metric_scope');
});

test('S1: rejects election_margin pairs whose rep titles carry OPPOSITE party tokens', () => {
  expect(sql).toContain("a.event_kind = 'election_margin'");
  expect(sql).toContain("~ '\\m(republican|republicans|gop)\\M'");
  expect(sql).toContain("~ '\\m(democrat|democrats|democratic)\\M'");
});

test('S1: is scoped to election_margin only — does NOT party-reject other kinds', () => {
  const idx = sql.indexOf("~ '\\m(republican|republicans|gop)\\M'");
  const windowBefore = sql.slice(Math.max(0, idx - 400), idx);
  expect(windowBefore).toContain("a.event_kind = 'election_margin'");
});

test('S3a: rejects two-sided stage_advance with differing titles, ungated on value_primary', () => {
  expect(sql).toContain("a.event_kind = 'stage_advance' AND b.event_kind = 'stage_advance'");
  const s3aIdx = sql.indexOf("a.event_kind = 'stage_advance' AND b.event_kind = 'stage_advance'");
  const s3aBlock = sql.slice(s3aIdx, s3aIdx + 220);
  expect(s3aBlock).not.toContain('value_primary IS NULL');
  expect(s3aBlock).toContain('IS DISTINCT FROM');
});

test("S3a': rejects NULL-value categorical/stage siblings with differing titles (no pe gate)", () => {
  expect(sql).toContain(
    "(a.condition_shape = 'categorical_outcome' OR a.event_kind = 'stage_advance')",
  );
  const opener = "(a.condition_shape = 'categorical_outcome' OR a.event_kind = 'stage_advance')";
  const occurrences = sql.split(opener).length - 1;
  expect(occurrences).toBeGreaterThanOrEqual(2);
});

test('S3b: rejects participant-kind pairs with differing titles bearing a prop token or a one-sided draw', () => {
  expect(sql).toContain('most sixes');
  expect(sql).toContain('top batter');
  expect(sql).toContain('toss match');
  expect(sql).toContain("(lower(immutable_unaccent(a.title)) ~ '\\mdraw\\M')");
  expect(sql).toContain("(lower(immutable_unaccent(b.title)) ~ '\\mdraw\\M')");
});

test('S4: rejects election_outcome_winner pairs where exactly one title is a precondition (ballot vs win)', () => {
  expect(sql).toContain("a.event_kind = 'election_outcome_winner' AND b.event_kind = 'election_outcome_winner'");
  expect(sql).toContain('on the ballot');
  expect(sql).toContain('make the runoff');
  const s4Idx = sql.indexOf(
    "a.event_kind = 'election_outcome_winner' AND b.event_kind = 'election_outcome_winner'",
  );
  const s4Block = sql.slice(s4Idx, s4Idx + 400);
  expect(s4Block).toContain('<>');
  expect(s4Block).toContain('run for'); // last precondition token — proves the rx is inside the XOR
});

test('R10: the outcome_set mutex guard EXEMPTS cross-platform same-outcome duplicate slots', () => {
  expect(sql).toContain('a.platform <> b.platform');
  expect(sql).toContain('outcome_set_slots s1');
  expect(sql).toContain(
    'lower(immutable_unaccent(btrim(a.title))) IS NOT DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))',
  );
});

test('R10: the mutex guard is NOT a blanket same-set reject anymore (has an exemption)', () => {
  const existsIdx = sql.lastIndexOf('FROM outcome_set_slots s1');
  const after = sql.slice(existsIdx);
  expect(after).toContain('a.platform <> b.platform');
});

const node = (p: Partial<StructureTierNode>): StructureTierNode => ({
  platform: 'polymarket',
  platformEventId: null,
  title: null,
  ...p,
});

test('W1-B spec: kalshi members sharing an event_ticker are siblings, never equal — even with identical titles', () => {
  const a = node({ platform: 'kalshi', title: 'Arsenal vs Everton Winner?', kalshiEventTickers: ['KXEWSLGAME-26MAY13ARSEVE'] });
  const b = node({ platform: 'kalshi', title: 'Arsenal vs Everton Winner?', kalshiEventTickers: ['KXEWSLGAME-26MAY13ARSEVE'] });
  expect(classifyPlatformStructure(a, b)).toBe('sibling-ticker');
});

test('W1-B spec: sibling-ticker fires through MIXED-platform nodes (rep platform not kalshi)', () => {
  const a = node({ platform: 'polymarket', kalshiEventTickers: ['KXWCGAME-SCOBRA'] });
  const b = node({ platform: 'kalshi', kalshiEventTickers: ['KXWCGAME-SCOBRA'] });
  expect(classifyPlatformStructure(a, b)).toBe('sibling-ticker');
});

test('W1-B spec: kalshi↔kalshi across different event_tickers is the variant-series trap', () => {
  const a = node({ platform: 'kalshi', title: 'Pure Album Sales', kalshiEventTickers: ['KXALBUMSALES-ICE-PURE'] });
  const b = node({ platform: 'kalshi', title: 'Activity (Combined Sales)', kalshiEventTickers: ['KXALBUMSALES-ICE-ACT'] });
  expect(classifyPlatformStructure(a, b)).toBe('variant-series');
});

test('W1-B spec: PM same-pe differing titles = sibling props (CSK-LSG Toss vs Most Sixes)', () => {
  const a = node({ platformEventId: 'pe-cricket-1', title: 'CSK vs LSG - Toss Match Double Draw' });
  const b = node({ platformEventId: 'pe-cricket-1', title: 'CSK vs LSG - Most Sixes Draw' });
  expect(classifyPlatformStructure(a, b)).toBe('same-pe-sibling');
});

test('W1-B spec: PM same-pe IDENTICAL titles = true duplicate listing — ALLOWED through', () => {
  const a = node({ platformEventId: 'pe-gold', title: 'Gold (LOW) $4,400' });
  const b = node({ platformEventId: 'pe-gold', title: 'Gold (LOW) $4,400' });
  expect(classifyPlatformStructure(a, b)).toBeNull();
});

test('W1-B spec: PM cross-pe identical titles = generic sub-market trap (Roshan)', () => {
  const a = node({ platformEventId: 'pe-tundra', title: 'Game 1: Both Teams Beat Roshan?' });
  const b = node({ platformEventId: 'pe-playtime', title: 'Game 1: Both Teams Beat Roshan?' });
  expect(classifyPlatformStructure(a, b)).toBe('xpe-identical-title');
});

test('W1-B spec: one-side-NULL pe with identical titles is rejected (structure unprovable)', () => {
  const a = node({ platformEventId: null, title: 'Game 1: Both Teams Beat Roshan?' });
  const b = node({ platformEventId: 'pe-x', title: 'Game 1: Both Teams Beat Roshan?' });
  expect(classifyPlatformStructure(a, b)).toBe('xpe-identical-title');
});

test('W1-B spec: title folding is accent/case-insensitive (Tōkyō ≡ tokyo)', () => {
  const a = node({ platformEventId: 'pe-1', title: 'FC Tōkyō Winner?' });
  const b = node({ platformEventId: 'pe-2', title: 'fc tokyo winner?' });
  expect(classifyPlatformStructure(a, b)).toBe('xpe-identical-title');
});

test('W1-B spec: cross-platform pairs always fall through to the field gates', () => {
  const a = node({ platform: 'kalshi', kalshiEventTickers: ['KXEPLGAME-X'] });
  const b = node({ platform: 'polymarket', platformEventId: 'pe-1', title: 'Will Arsenal win?' });
  expect(classifyPlatformStructure(a, b)).toBeNull();
});

test('W1-B spec: same-platform diff-pe differing titles fall through (governed by field/date gates)', () => {
  const a = node({ platformEventId: 'pe-2026', title: 'OpenSea FDV $5B by 2026?' });
  const b = node({ platformEventId: 'pe-2027', title: 'OpenSea FDV $5B by 2027?' });
  expect(classifyPlatformStructure(a, b)).toBeNull();
});

test('W1-B SQL: no kalshi↔kalshi algorithmic equivalences', () => {
  expect(sql).toContain("NOT (a.platform = 'kalshi' AND b.platform = 'kalshi')");
});

test('W1-B SQL: same-pe-sibling reject does NOT require special shapes/kinds (structure-only)', () => {
  const anchor = sql.indexOf('Platform-structure tier');
  expect(anchor).toBeGreaterThan(-1);
  const block = sql.slice(anchor);
  expect(block).toContain('a.platform = b.platform');
  expect(block).toContain('a.platform_event_id = b.platform_event_id');
});

test('W1-B SQL: xpe-identical-title reject uses IS DISTINCT FROM pe + IS NOT DISTINCT FROM titles', () => {
  const anchor = sql.indexOf('Platform-structure tier');
  expect(anchor).toBeGreaterThan(-1);
  const block = sql.slice(anchor);
  expect(block).toContain('a.platform_event_id IS DISTINCT FROM b.platform_event_id');
  expect(block).toContain(
    'lower(immutable_unaccent(btrim(a.title))) IS NOT DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))',
  );
});

test('W1-B SQL: sibling-ticker anti-join scans ALL kalshi members of both questions', () => {
  expect(sql).toContain("ra.raw->>'event_ticker' = rb.raw->>'event_ticker'");
  expect(sql).toContain("ma.platform = 'kalshi'");
  expect(sql).toContain('qma.question_id = a.question_id');
});

test('W1-B diagnostics: violations SQL counts live equiv edges per reason tag', () => {
  const diag = buildStructureTierViolationsSql();
  expect(diag).toContain('variant_series');
  expect(diag).toContain('same_pe_sibling');
  expect(diag).toContain('xpe_identical_title');
  expect(diag).toContain('sibling_ticker');
  expect(diag).toContain('s3b_other_prop');
  expect(diag).toContain("e.pattern = 'cross_question_equiv'");
  expect(diag).toContain('e.archived_at IS NULL');
});

test("W1-B S3b: prop guard extends to event_kind='other' pairs", () => {
  expect(sql).toContain("OR (a.event_kind = 'other' AND b.event_kind = 'other')");
});

test('W1-B S3b: token list covers completed-match / wins-the-toss / team-top', () => {
  expect(sql).toContain('completed match');
  expect(sql).toContain('wins the toss');
  expect(sql).toContain('team top');
});

test('cross-source: both-known differing resolution_source is MARKED in reasoning', () => {
  expect(sql).toContain("' [cross-source: '");
  expect(sql).toContain('ra.resolution_source IS DISTINCT FROM rb.resolution_source');
  expect(sql).toContain('question_resolution_source');
  expect(sql).toContain('count(DISTINCT nz.resolution_source) = 1');
});

test('cross-source: G_O supersedes "never refuse" — the refusal conjunct IS now present', () => {
  expect(sql).toContain(oraclesCompatibleSql('ra.resolution_source', 'rb.resolution_source'));
  expect(sql).not.toMatch(/AND\s+ra\.resolution_source\s*=/);
});

test('cross-source: the marker rides LEFT JOINs so unknown-source pairs are untouched', () => {
  expect(sql).toContain('LEFT JOIN question_resolution_source ra ON ra.question_id = c.aq');
  expect(sql).toContain('LEFT JOIN question_resolution_source rb ON rb.question_id = c.bq');
});

test('G_D: carries the minute-vs-day evening day-shift arm with the prone-sport guard', () => {
  expect(sql).toContain('a.sport AS a_sport');
  expect(sql).toContain('b.sport AS b_sport');
  expect(sql).toContain("qa.condition_date_precision = 'minute' AND qb.condition_date_precision = 'day'");
  expect(sql).toContain("qb.condition_date_precision = 'minute' AND qa.condition_date_precision = 'day'");
  expect(sql).toContain("EXTRACT(HOUR FROM qa.condition_date::timestamptz AT TIME ZONE 'UTC') < 10");
  expect(sql).toContain('(qb.condition_date::timestamptz)::date = (qa.condition_date::timestamptz)::date - 1');
  expect(sql).toContain('c.a_sport IS NOT NULL AND c.b_sport IS NOT NULL');
  expect(sql).toContain("lower(c.a_sport) NOT IN ('baseball','basketball','ice hockey','hockey')");
  expect(sql).toContain("lower(c.b_sport) NOT IN ('baseball','basketball','ice hockey','hockey')");
  expect(sql).toContain('(qa.condition_date IS NULL AND qb.condition_date IS NULL)');
});

test('G7a (§A7): member-level same-platform-event sibling refusal (Warsh flood)', () => {
  expect(sql).toContain('ma.platform = mb.platform');
  expect(sql).toContain('ma.platform_event_id = mb.platform_event_id');
  expect(sql).toContain('lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))');
});

test('G7b (§A8): Predict colon-suffix idiom — same group prefix, different outcome token', () => {
  expect(sql).toContain("position(':' in a.title) > 0 AND position(':' in b.title) > 0");
  expect(sql).toContain("split_part(a.title, ':', 1)");
  expect(sql).toContain("split_part(b.title, ':', 1)");
  expect(sql).toContain("regexp_replace(a.title, '^[^:]*:\\s*', '')");
  expect(sql).toContain("regexp_replace(b.title, '^[^:]*:\\s*', '')");
});

test('P3: refuses a FIXTURE-shaped canonical_subject with no structured discriminator', () => {
  expect(sql).toContain('btrim(a.canonical_subject) ~*');
  expect(sql).toContain('a.condition_metric IS NULL OR a.value_primary IS NULL');
  expect(sql).toContain('a.canonical_subject IS NOT NULL');
});

test('P12a: hoists a per-question strike_type strictness CTE (never a per-pair EXISTS)', () => {
  expect(sql).toContain('equiv_strike_strictness AS (');
  expect(sql).toContain("WHEN 'greater' THEN 'strict'");
  expect(sql).toContain("WHEN 'greater_or_equal' THEN 'inclusive'");
  expect(sql).toContain('LEFT JOIN equiv_strike_strictness sta ON sta.question_id = a.question_id');
  expect(sql).toContain('LEFT JOIN equiv_strike_strictness stb ON stb.question_id = b.question_id');
});

test('P12a: the refusal is both-known-differ, numeric-bound-only, continuous-unit-exempt', () => {
  const frag = boundStrictnessCompatibleSql('sta', 'stb', 'a');
  expect(frag).toContain('sta.strictness IS NOT NULL AND stb.strictness IS NOT NULL');
  expect(frag).toContain('sta.strictness IS DISTINCT FROM stb.strictness');
  expect(frag).toContain('a.value_primary IS NOT NULL');
  expect(frag).toContain(integerGrainUnitsSql());
  expect(sql).toContain(frag);
});

test('P6b: the per-question settlement-dimension CTE is hoisted and joined NULL-tolerantly', () => {
  expect(sql).toContain('equiv_settlement_dimension AS (');
  expect(sql).toContain('JOIN market_metadata_raw r ON r.market_id = qm.market_id');
  expect(sql).toContain('CASE WHEN count(DISTINCT d.dim) = 1 THEN min(d.dim) END');
  expect(sql).toContain('LEFT JOIN equiv_settlement_dimension sda ON sda.question_id = a.question_id');
  expect(sql).toContain('LEFT JOIN equiv_settlement_dimension sdb ON sdb.question_id = b.question_id');
});

test('P6b: the conjunct is EMITTED from the shared twin (no hand-inlined copy)', () => {
  expect(sql).toContain(settlementDimensionCompatibleSql('sda.dim', 'sdb.dim'));
  expect(sql).toContain(settlementDimensionSql('r.raw'));
});

test('G_O: the ins WHERE carries the cross-oracle refusal conjunct on BOTH question-grain sources', () => {
  expect(sql).toContain(oraclesCompatibleSql('ra.resolution_source', 'rb.resolution_source'));
});

test('G_O: the gate is both-known-and-differ, not a symmetric equality (one-side-unknown must pass)', () => {
  const conj = oraclesCompatibleSql('ra.resolution_source', 'rb.resolution_source');
  expect(conj.startsWith('NOT (')).toBe(true);
  expect(conj).toContain('IS NOT NULL AND');
  expect(sql).not.toContain('ra.resolution_source IS NOT DISTINCT FROM rb.resolution_source');
});

test('G_O: the UMA settlement layer is folded to unknown inside the emitted gate', () => {
  expect(sql).toContain("'UMA'");
});

test('G_O: the cross-source reasoning MARKER is retained (the tolerated class stays visible)', () => {
  expect(sql).toContain("' [cross-source: '");
});
