import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildReachThresholdChainEdgesSql,
  reachThresholdRungsCtesSql,
  parseReachValue,
  magnitudeMultiplier,
  reachDirection,
  reachImplies,
  isExcludedReachFamily,
  hasUnfilledStrikePlaceholder,
} from './reach-threshold-chain.js';

const sql = buildReachThresholdChainEdgesSql();
const ctes = reachThresholdRungsCtesSql();

// pure-TS: magnitude-normalized value parse (mirrors the SQL `val`)

test('magnitude suffix folds into the value (k/m/b/t)', () => {
  expect(magnitudeMultiplier('k')).toBe(1e3);
  expect(magnitudeMultiplier('M')).toBe(1e6);
  expect(magnitudeMultiplier('b')).toBe(1e9);
  expect(magnitudeMultiplier('T')).toBe(1e12);
  expect(magnitudeMultiplier(null)).toBe(1);
  expect(magnitudeMultiplier('')).toBe(1);
});

test('parseReachValue normalizes commas + magnitude so $1B > $500M compares right', () => {
  expect(parseReachValue('Will Based Polymarket revenue hit $5M before 2027?')).toBe(5e6);
  expect(parseReachValue('Will stablecoins hit $500B before 2027?')).toBe(500e9);
  expect(parseReachValue('Will Lighter reach $1B before 2027?')).toBe(1e9);
  // $1B (1e9) is strictly greater than $500M (500e6) once normalized
  expect(parseReachValue('Will Lighter reach $1B before 2027?')!).toBeGreaterThan(
    parseReachValue('Will Based Polymarket revenue hit $500M before 2027?')!,
  );
  // comma-format crypto strikes
  expect(parseReachValue('Will Bitcoin reach $150,000 by December 31, 2026?')).toBe(150000);
  expect(parseReachValue('Will Bitcoin reach $1,000,000 by December 31, 2026?')).toBe(1000000);
  // decimals + non-dollar units
  expect(parseReachValue('Will Ethena reach $0.48 by December 31, 2026?')).toBe(0.48);
  expect(parseReachValue('Will Bitcoin Dominance hit 70% before 2027?')).toBe(70);
});

test('NEGATIVE: the "$150,000 by December" b/by mis-parse trap — magnitude must be adjacent', () => {
  // the 'b' in "by December" must NOT be read as a billions magnitude → value stays 150000
  expect(parseReachValue('Will Bitcoin reach $150,000 by December 31, 2026?')).toBe(150000);
  expect(parseReachValue('Will Bitcoin reach $150,000 by December 31, 2026?')).not.toBe(150000e9);
});

test('NEGATIVE: no numeric rung → null (no garbage edge)', () => {
  expect(parseReachValue('Will Bitcoin reach a new all-time high?')).toBeNull();
  expect(parseReachValue(null)).toBeNull();
  expect(parseReachValue('')).toBeNull();
});

// pure-TS: direction derivation (or-lower ⇒ below)

test('direction: or-lower/or-less ⇒ below; everything else ⇒ above', () => {
  expect(reachDirection("Will the Fed's lower bound reach 0.5% or lower before 2027?")).toBe('below');
  expect(reachDirection('rates hit 2.5% or less in 2026')).toBe('below');
  expect(reachDirection("Will the Fed's upper bound reach 5.0% or higher before 2027?")).toBe('above');
  expect(reachDirection('Will Bitcoin reach $150,000 by December 31, 2026?')).toBe('above');
});

test('direction: the "(LOW)" watermark idiom ⇒ below (N1 reversed-chain fix)', () => {
  // a touch-LOW market pays on the period MINIMUM reaching ≤X — LOWER is stricter
  expect(reachDirection('Will Ornn hit $4.40 (LOW)?')).toBe('below');
  expect(reachDirection('Will S&P 500 (SPX) hit $6,900 (LOW) in June?')).toBe('below');
  expect(reachDirection('will eth hit $2,000 (low) in june?')).toBe('below'); // case-insensitive
  // HIGH / Close / Open watermarks and plain titles stay ascending ('above')
  expect(reachDirection('Will Ornn hit $4.40 (HIGH)?')).toBe('above');
  expect(reachDirection('Will S&P 500 (SPX) hit $6,900 (Close) in June?')).toBe('above');
  expect(reachDirection('Will S&P 500 (SPX) hit $6,900 (Open) in June?')).toBe('above');
});

// pure-TS: (LOW) ladder chains DESCENDING; HIGH/default unchanged; no mixing

test('(LOW) ladder: the LOWER threshold is the antecedent (hit 4.30 LOW ⟹ hit 4.40 LOW)', () => {
  const lo = 'Will Ornn hit $4.30 (LOW) by May 31, 2026?';
  const hi = 'Will Ornn hit $4.40 (LOW) by May 31, 2026?';
  const dir = reachDirection(lo);
  expect(dir).toBe('below');
  expect(reachDirection(hi)).toBe(dir); // one shared direction per (LOW) family
  // sound: touching the 4.30 low necessarily touched the 4.40 low
  expect(reachImplies(dir, parseReachValue(lo), parseReachValue(hi))).toBe(true);
  // NEGATIVE: the reversed orientation (4.40 ⟹ 4.30) is a fabricated arbitrage
  expect(reachImplies(dir, parseReachValue(hi), parseReachValue(lo))).toBe(false);
});

test('HIGH / default ladder unchanged: the HIGHER threshold stays the antecedent', () => {
  const hi = 'Will Ornn hit $4.40 (HIGH) by May 31, 2026?';
  const lo = 'Will Ornn hit $4.30 (HIGH) by May 31, 2026?';
  const dir = reachDirection(hi);
  expect(dir).toBe('above');
  expect(reachImplies(dir, parseReachValue(hi), parseReachValue(lo))).toBe(true);
  expect(reachImplies(dir, parseReachValue(lo), parseReachValue(hi))).toBe(false);
  // plain (no watermark tag) titles also stay ascending
  expect(reachDirection('Will Bitcoin reach $150,000 by December 31, 2026?')).toBe('above');
  expect(reachImplies('above', 150000, 100000)).toBe(true);
});

test('mixed HIGH/LOW set: no cross-direction edge (direction + extremum both partition)', () => {
  const low = 'Will Ornn hit $4.30 (LOW) by May 31, 2026?';
  const high = 'Will Ornn hit $4.40 (HIGH) by May 31, 2026?';
  // directions differ → the SQL dir equality join can never pair them …
  expect(reachDirection(low)).not.toBe(reachDirection(high));
  // … and even a hypothetical shared-direction evaluation refuses both orientations
  expect(reachImplies(reachDirection(low), parseReachValue(high), parseReachValue(low))).toBe(false);
  // belt: the extremum partition key separates them in SQL too
  expect(ctes).toContain('b.extremum = a.extremum');
  expect(ctes).toContain('b.dir      = a.dir');
});

// pure-TS: chain orientation (the antecedent is the STRICTER rung)

test('above: the HIGHER threshold is the antecedent (reach Xhi ⟹ reach Xlo)', () => {
  expect(reachImplies('above', 10000, 8000)).toBe(true);
  // NEGATIVE: reversed orientation is a fabricated arbitrage
  expect(reachImplies('above', 8000, 10000)).toBe(false);
});

test('below: the LOWER threshold is the antecedent (reach Xlo-or-lower ⟹ reach Xhi-or-lower)', () => {
  // "reach 0% or lower" ⟹ "reach 0.25% or lower"
  expect(reachImplies('below', 0, 0.25)).toBe(true);
  // NEGATIVE: reversed orientation
  expect(reachImplies('below', 0.25, 0)).toBe(false);
});

test('NEGATIVE: equal values never ladder; unknown direction / NULLs never relate', () => {
  expect(reachImplies('above', 5000, 5000)).toBe(false);
  expect(reachImplies('below', 5000, 5000)).toBe(false);
  expect(reachImplies('sideways', 10, 5)).toBe(false);
  expect(reachImplies(null, 10, 5)).toBe(false);
  expect(reachImplies('above', null, 5)).toBe(false);
  expect(reachImplies('above', 10, null)).toBe(false);
});

// pure-TS: excluded non-ladder families

test('excludes rank / set-count / negRisk-first-to-X families (direction-ambiguous)', () => {
  expect(isExcludedReachFamily('Will a coin launched in 2026 end the year in the top 10?')).toBe(true);
  expect(isExcludedReachFamily('Over 10 coins launched in 2026 end the year in the top 100?')).toBe(true);
  expect(isExcludedReachFamily('Will OpenAI be the first company to have an AI model hit 1550 on Chatbot Arena in 2026?')).toBe(true);
  // a genuine per-subject $ threshold is NOT excluded
  expect(isExcludedReachFamily('Will Bitcoin reach $150,000 by December 31, 2026?')).toBe(false);
  expect(isExcludedReachFamily("Will the Fed's lower bound reach 0.5% or lower before 2027?")).toBe(false);
});

// edge contract (solver-facing)

test('writes a strict_implication / numeric_threshold_raw edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  // The raw-driven sibling of numeric_ladder_xq.
  expect(sql).toContain("'numeric_threshold_raw'");
  expect(sql).toContain("'algorithmic'");
  // confidence=1.0 + deterministic TRUE so the solver hard-prunes the edge
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

// identity / soundness guards (SQL)

test('raw-driven: reads markets.title, NO condition_shape gate (mirrors before-date-chain)', () => {
  expect(ctes).toContain('m.title');
  // NO INCLUSION dependence on normalization fields — the ladders are mostly
  // unshaped, and the builder gates INTO the ladder on nothing from
  // llm_market_normalizations (an unshaped market has no normalization row and
  // must still rung); unshaped markets already have question nodes via
  // finalize feed-B. Shaped rungs overlap with numeric-ladder-xq and are deduped
  // by ON CONFLICT — there must be no condition_shape gate that would EXCLUDE the
  // unshaped family this builder exists to cover.
  // (llm_market_normalizations DOES appear once — the field-first direction
  // source — but as a LEFT JOIN inside reach_markets, never as an inclusion gate:
  // an unshaped rung has no norm row yet still rungs (dir falls back to the title).)
  expect(ctes).not.toContain('canonical_event');
  expect(ctes).not.toContain('condition_shape');
  // the field-first LEFT JOIN is the SOLE normalization reference (once, in reach_markets)
  expect(ctes.indexOf('llm_market_normalizations')).toBe(ctes.lastIndexOf('llm_market_normalizations'));
  expect(ctes).toContain('LEFT JOIN llm_market_normalizations n ON n.market_id = m.id');
  // it joins only markets / question_members / questions (the feed-B node graph)
  expect(ctes).toContain('FROM markets m');
  expect(ctes).toContain('JOIN question_members qm');
  expect(ctes).toContain('JOIN questions q');
});

test('same Polymarket event family only: pe-scoped join, polymarket platform gate', () => {
  expect(ctes).toContain(`m.platform = 'polymarket'`);
  expect(ctes).toContain('b.pe       = a.pe');
  expect(ctes).toContain('q.archived_at IS NULL');
});

test('full partition key: pe + subject + direction + dollar + unit + extremum + deadline', () => {
  expect(ctes).toContain('PARTITION BY pe, subj, dir, dollar, unit, extremum, deadline');
  // the join repeats every key column (no cross-family / cross-deadline / cross-extremum leakage)
  for (const k of ['pe', 'subj', 'dir', 'dollar', 'unit', 'extremum', 'deadline']) {
    expect(ctes).toContain(`b.${k}`);
  }
});

test('extremum gate: HIGH-watermark vs LOW-watermark markets never chain together', () => {
  // "(High)" settles on the period max; "(Low)" on the period min — independent
  // extrema, NOT a nested ladder ("hit 1.40 (High)" ⇏ "hit 1.30 (Low)").
  expect(ctes).toContain("substring(m.title from '(?i)[(](high|low|close|open)[)]')");
  expect(ctes).toContain('AS extremum');
  expect(ctes).toContain('b.extremum = a.extremum');
});

test('direction gate: FIELD-FIRST (condition_direction), title (LOW)/or-lower is fallback + ttl_dir', () => {
  // dir reads the stamped condition_direction first; the title parse is the
  // fallback for un-normalized rungs AND the cross-check reference (ttl_dir).
  expect(ctes).toContain("WHEN n.condition_direction IN ('above', 'below') THEN n.condition_direction");
  expect(ctes).toContain('END AS dir');
  expect(ctes).toContain(`CASE WHEN m.title ~* 'or lower|or below|or less' OR m.title ~* '[(]low[)]' THEN 'below' ELSE 'above' END AS ttl_dir`);
  // rank 1 = strictest (above: -val so highest is first; below: val so lowest is first)
  expect(ctes).toContain("CASE WHEN dir = 'above' THEN -val ELSE val END");
});

test('magnitude normalized into val; magnitude letter adjacent (no \\\\s* before [kmbt])', () => {
  expect(ctes).toContain("WHEN 'k' THEN 1e3 WHEN 'm' THEN 1e6 WHEN 'b' THEN 1e9 WHEN 't' THEN 1e12 ELSE 1 END AS val");
  // adjacency: the magnitude capture has NO whitespace between the number and [kmbt]
  expect(ctes).toContain(`[0-9][0-9,.]*([kmbt])`);
  expect(ctes).not.toContain(`[0-9][0-9,.]*\\s*([kmbt])`);
});

test('excluded non-ladder families refused in SQL (rank / set-count / negRisk)', () => {
  expect(ctes).toContain(`m.title !~* '\\btop +[0-9]|end the year in the top|over +[0-9]+ +coins|first (company|to)'`);
});

test('CHAIN not closure: adjacent dense_rank step only, strictest rung first', () => {
  expect(ctes).toContain('dense_rank() OVER (');
  expect(ctes).toContain('b.rk = a.rk + 1');
  // NEGATIVE: no closure join anywhere
  expect(ctes).not.toContain('b.rk > a.rk');
});

test('over-merge disqualifier: any member disagreement on val drops the question', () => {
  expect(ctes).toContain('bad_questions');
  expect(ctes).toContain('HAVING count(DISTINCT val) > 1');
  expect(ctes).toContain('question_id NOT IN (SELECT question_id FROM bad_questions)');
});

test('NEGATIVE: equal values never chain; no self-edges', () => {
  expect(ctes).toContain('b.val <> a.val');
  expect(ctes).toContain('b.question_id <> a.question_id');
});

test('rungs CTE pipeline is exported for the read-only dry-run probe', () => {
  expect(ctes).toContain('chain_pairs AS');
  expect(sql).toContain(ctes);
});

// stamped-direction cross-check belt (belt.reach_dir_titlecheck)

test('direction cross-check belt: title-vs-field disagreement is COUNTED, not dropped (field trusted)', () => {
  expect(ctes).toContain('dir_titlecheck AS (');
  // both-known only: NULL/'at' stamped directions never contribute (the ladder
  // vocabulary is above/below); the belt compares the title-derived ttl_dir to the field.
  expect(ctes).toContain(`r.cond_dir IN ('above', 'below')`);
  expect(ctes).toContain('r.cond_dir <> r.ttl_dir');
  // the field is trusted: `valued` does not subtract dir_titlecheck.
  expect(ctes).not.toContain('market_id NOT IN (SELECT market_id FROM stamped_dir_conflicts)');
  expect(ctes).not.toContain('market_id NOT IN (SELECT market_id FROM dir_titlecheck)');
});

test('reach_dir_titlecheck: cross-check count telemetry SQL reuses the same CTE pipeline', async () => {
  const { countReachDirTitlecheckSql } = await import('./reach-threshold-chain.js');
  const countSql = countReachDirTitlecheckSql();
  expect(countSql).toContain(ctes);
  expect(countSql).toContain('FROM dir_titlecheck');
});

// unfilled-strike placeholder refusal
test('G9: the reach_markets CTE refuses the literal "___" template placeholder', () => {
  expect(sql).toContain("position('___' in m.title) = 0");
});

test('G9 TS mirror: hasUnfilledStrikePlaceholder', () => {
  expect(hasUnfilledStrikePlaceholder('Will X reach $___?')).toBe(true);
  expect(hasUnfilledStrikePlaceholder('Will Bitcoin reach $150,000 by Dec?')).toBe(false);
  expect(hasUnfilledStrikePlaceholder(null)).toBe(false);
});
