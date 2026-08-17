import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildMarginWinnerEdgesSql,
  buildMarginLadderEdgesSql,
  marginWinnerPairsCtesSql,
  partyFromTitle,
  partyFromTicker,
  parseMarginRaceKey,
  US_STATES,
} from './margin-winner.js';

const sql = buildMarginWinnerEdgesSql();
const ctes = marginWinnerPairsCtesSql();
const ladderSql = buildMarginLadderEdgesSql();

// ── edge contract (solver-facing) ──────────────────────────────────────────────

test('writes a strict_implication / margin_winner edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'margin_winner'");
  expect(sql).toContain("'algorithmic'");
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('orientation: antecedent = margin, consequent = winner (sound for any X>0)', () => {
  expect(sql).toMatch(/SELECT antecedent_question_id, consequent_question_id,\s*\n\s*'strict_implication'/);
  // the antecedent is the margin side (race_keys), the consequent the winner
  expect(ctes).toMatch(/rk\.question_id AS antecedent_question_id,\s*\n\s*b\.question_id\s+AS consequent_question_id/);
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

// ── antecedent gates ───────────────────────────────────────────────────────────

test('margin antecedent: election_margin, above-direction, X>0, no interior bands', () => {
  expect(ctes).toContain(`q.event_kind = 'election_margin'`);
  expect(ctes).toContain(`q.condition_direction = 'above'`);
  expect(ctes).toContain('q.value_primary > 0');
  expect(ctes).toContain('q.value_secondary IS NULL');
  expect(ctes).toContain('q.archived_at IS NULL');
  expect(ctes).toContain(`m.platform = 'kalshi'`);
});

test('party comes from title + ticker (NEVER the corrupted canonical_subject)', () => {
  // word-anchored title regex, both-mentions → no party
  expect(ctes).toContain(`title ~* '\\mfor (the )?republicans?\\M' AND title !~* '\\mfor (the )?democrats?\\M'`);
  expect(ctes).toContain(`title ~* '\\mfor (the )?democrats?\\M' AND title !~* '\\mfor (the )?republicans?\\M'`);
  // ticker belt: last letter must AGREE with the title party
  expect(ctes).toContain(`CASE right(ticker, 1) WHEN 'R' THEN 'Republican Party' WHEN 'D' THEN 'Democratic Party' END`);
  expect(ctes).toContain('f.party_title = f.party_ticker');
  expect(ctes).toContain('f.party_title IS NOT NULL');
  // the margin CTE must not read q.canonical_subject (corrupted: office crossed)
  const marginStart = ctes.indexOf('margin AS (');
  const marginEnd = ctes.indexOf('mfacts AS MATERIALIZED (');
  expect(marginStart).toBeGreaterThan(-1);
  expect(marginEnd).toBeGreaterThan(marginStart);
  expect(ctes.slice(marginStart, marginEnd)).not.toContain('canonical_subject');
});

// ── race-key join + traps ──────────────────────────────────────────────────────

test('race key joins on cycle year + party + exact canonical_event templates', () => {
  // party match: R-margin ⟹ R-win only — plain hashable equi-join
  expect(ctes).toContain('b.ce = rk.winner_key');
  expect(ctes).toContain('b.party = rk.party');
  // house (merged + unmerged-twin templates, padded + unpadded seat)
  expect(ctes).toContain(`yr || ' ' || house_st || ' ' || seat || ' house seat' AS winner_key`);
  expect(ctes).toContain(`yr || ' house race for ' || house_st || ' ' || seat`);
  expect(ctes).toContain(`yr || ' house race for ' || house_st || ' ' || ltrim(seat, '0')`);
  // senate (both live word orders; exact equality cannot hit 'state senate')
  expect(ctes).toContain(`yr || ' ' || sg_state || ' senate race'`);
  expect(ctes).toContain(`yr || ' senate race in ' || sg_state`);
  // governor
  expect(ctes).toContain(`yr || ' ' || sg_state || ' governor race'`);
  // padded/unpadded key coincidence dedupe
  expect(ctes).toContain('SELECT DISTINCT');
});

test('winner consequent: election_outcome_winner with exact party subjects', () => {
  expect(ctes).toContain(`event_kind = 'election_outcome_winner'`);
  expect(ctes).toContain(`canonical_subject IN ('Democratic Party', 'Republican Party')`);
});

test('special-vs-general guard: house seats with a same-cycle special are excluded', () => {
  // precomputed once (special_seats CTE), anti-joined in race_clean
  expect(ctes).toContain(`special election') AS seat_key`);
  expect(ctes).toContain(`IN (SELECT seat_key FROM special_seats WHERE seat_key IS NOT NULL)`);
  expect(ctes).toMatch(/race_clean AS MATERIALIZED \(\s*\n\s*SELECT \* FROM race a\s*\n\s*WHERE NOT \(\s*\n\s*a\.office = 'house'/);
  // every race_keys branch reads the guarded race_clean, never raw race
  expect(ctes).not.toMatch(/FROM race WHERE office/);
});

test('production SQL uses the canonical_event cycle year (no simulation)', () => {
  expect(ctes).toContain('left(ce, 4) AS yr');
  // the dry-run simulation overrides it…
  expect(marginWinnerPairsCtesSql({ simulateCycleYear: '2026' })).toContain(`'2026' AS yr`);
  // …and rejects non-year garbage (raw string interpolation guard)
  expect(() => marginWinnerPairsCtesSql({ simulateCycleYear: `26'; DROP` })).toThrow();
});

// ── pure-helper: party extraction ──────────────────────────────────────────────

test('partyFromTitle: word-anchored, both/neither → null (party-agnostic bands excluded)', () => {
  expect(partyFromTitle(
    "Will the margin of victory for Republicans in the Georgia's 9th District House election be at least 37 percentage points?",
  )).toBe('Republican Party');
  expect(partyFromTitle(
    'Will the margin of victory for Democrats in the U.S. Senate election in Illinois be at least 25 percentage points?',
  )).toBe('Democratic Party');
  // party-agnostic absolute band: implies NOTHING about who wins → null
  expect(partyFromTitle('Will the margin of victory in the FL-09 election be at least 10 points?')).toBeNull();
  // both parties mentioned → ambiguous → null
  expect(partyFromTitle('Margin for Republicans or for Democrats at least 5?')).toBeNull();
  expect(partyFromTitle(null)).toBeNull();
});

test('partyFromTicker: KXMIDTERMMOV suffix letter', () => {
  expect(partyFromTicker('KXMIDTERMMOV-GA09R')).toBe('Republican Party');
  expect(partyFromTicker('KXMIDTERMMOV-ILSEND')).toBe('Democratic Party');
  expect(partyFromTicker('KXMIDTERMMOV-TNGOVR')).toBe('Republican Party');
  expect(partyFromTicker('KXMIDTERMMOV-VTALD')).toBe('Democratic Party'); // at-large
  expect(partyFromTicker('KXHOUSERACE-FL09-26')).toBeNull(); // not a party letter
  expect(partyFromTicker(null)).toBeNull();
});

// ── pure-helper: race-key parse (mirrors the SQL mfacts CTE) ───────────────────

test('parseMarginRaceKey: the four live templates', () => {
  expect(parseMarginRaceKey('2026 georgia 09 house race margin'))
    .toEqual({ year: '2026', office: 'house', stateName: 'georgia', seat: '09' });
  expect(parseMarginRaceKey('2026 north dakota 03 house race margin'))
    .toEqual({ year: '2026', office: 'house', stateName: 'north dakota', seat: '03' });
  // at-large: no district token → seat 'al'
  expect(parseMarginRaceKey('2026 vermont house race margin'))
    .toEqual({ year: '2026', office: 'house', stateName: 'vermont', seat: 'al' });
  expect(parseMarginRaceKey('2026 illinois senate race margin'))
    .toEqual({ year: '2026', office: 'senate', stateName: 'illinois' });
  expect(parseMarginRaceKey('2026 tennessee governor race margin'))
    .toEqual({ year: '2026', office: 'governor', stateName: 'tennessee' });
});

test('parseMarginRaceKey: non-template strings are rejected', () => {
  expect(parseMarginRaceKey('2026 nj 11 special election by 40 or more')).toBeNull();
  expect(parseMarginRaceKey('2026 arizona state senate')).toBeNull();
  expect(parseMarginRaceKey('2026 fl 09 republican primary')).toBeNull();
  expect(parseMarginRaceKey('2026 fl 09 house seat')).toBeNull(); // a WINNER key, not a margin key
  expect(parseMarginRaceKey('')).toBeNull();
  expect(parseMarginRaceKey(null)).toBeNull();
});

test('US_STATES covers all 50 states + DC with unique abbrevs', () => {
  expect(US_STATES.length).toBe(51);
  const abbrevs = new Set(US_STATES.map(([, ab]) => ab));
  expect(abbrevs.size).toBe(51);
  expect(US_STATES.find(([n]) => n === 'georgia')?.[1]).toBe('ga');
  expect(US_STATES.find(([n]) => n === 'north dakota')?.[1]).toBe('nd');
});

// ── same-(race, party) margin ladder ────────────────────────────────────────────

test('margin ladder: reuses the numeric_ladder_xq label with the solver contract', () => {
  expect(ladderSql).toContain("'strict_implication'");
  expect(ladderSql).toContain("'numeric_ladder_xq'");
  expect(ladderSql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
  expect(ladderSql).toContain(EDGE_CONFLICT_SQL);
});

test('margin ladder: party double-belt is load-bearing (title primary, ticker belt)', () => {
  // a party-agnostic band (NULL party_title) or a title/ticker disagreement
  // yields NO party → no rung → no edge (R-margins never ladder onto D-margins).
  expect(ladderSql).toContain('party_title IS NOT NULL');
  expect(ladderSql).toContain('party_title = party_ticker');
});

test('margin ladder: partitions by (race string, party, unit, shape) and chains ADJACENT rungs only', () => {
  // unit + shape in the partition: the reused numeric_ladder_xq pattern's
  // asserts require both to agree on every rung pair
  expect(ladderSql).toContain('PARTITION BY ce, party, value_unit, condition_shape ORDER BY v');
  expect(ladderSql).toContain('b.value_unit IS NOT DISTINCT FROM a.value_unit');
  expect(ladderSql).toContain('b.condition_shape IS NOT DISTINCT FROM a.condition_shape');
  expect(ladderSql).toContain('a.rk = b.rk + 1');
  // dense_rank: equal values share a rank → duplicates never become an edge
  expect(ladderSql).toContain('dense_rank()');
});

test('margin ladder: orientation = stricter (higher margin) implies looser', () => {
  // a.rk = b.rk + 1 with rank ordered by v ASC ⇒ antecedent a has the HIGHER value
  expect(ladderSql).toMatch(/a\.question_id AS antecedent_question_id,\s*\n\s*b\.question_id AS consequent_question_id/);
});

test('margin ladder: inherits the margin-CTE antecedent gates (above, X>0, no bands)', () => {
  // the shared marginFactsCtesSql carries the gates the winner-bridge relies on
  expect(ladderSql).toContain(`q.event_kind = 'election_margin'`);
  expect(ladderSql).toContain(`q.condition_direction = 'above'`);
  expect(ladderSql).toContain('q.value_primary > 0');
  expect(ladderSql).toContain('q.value_secondary IS NULL');
});
