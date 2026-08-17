/**
 * Pure unit tests for resolution-extract.ts — no DB.
 *
 * Fixtures are real raw payloads fetched read-only from the live scraper
 * tables / market_metadata_raw, trimmed to the fields the extractors read.
 * Where the live data contains zero resolved payloads (Kalshi, Limitless —
 * the scraper captures active markets only), the resolved-state fixtures are
 * forward-path synthetics: a real live payload with the platform-documented
 * resolution fields applied (field names cross-checked against
 * services/ingestion/src/resolution-monitor.ts, the validated reference).
 */
import { test, expect } from 'bun:test';
import {
  extractKalshiResolution,
  extractPolymarketResolution,
  extractPredictResolution,
  extractLimitlessResolution,
  extractResolution,
  PM_VOID_SENTINEL,
  KALSHI_VOID_SENTINEL,
} from './resolution-extract.js';

const OBSERVED = new Date('2026-05-13T20:00:00Z');

// ─── Polymarket (real payloads) ──────────────────────────────────────────────

// REAL: polymarket_markets, prices ["1","0"] → first outcome won.
const PM_WINNER_FIRST = {
  conditionId: '0x1bbe955b30231903ebbc4f8c1ff096297a1e4fbafc96c585f89fc141ed105f9b',
  question: 'First Blood in Game 2?',
  outcomes: '["GAM Esports", "Ground Zero Gaming"]',
  outcomePrices: '["1", "0"]',
  closed: 'true',
  active: 'true',
  updatedAt: '2026-04-20T13:52:18.924727Z',
  endDate: '2026-04-19T18:30:00Z',
};

// REAL: prices ["0","1"] → second outcome won.
const PM_WINNER_SECOND = {
  conditionId: '0xc6c7b9d17f5be33db281c690f75da26daf4068fa012691a4d28b08eb43692d1d',
  question: 'Map Handicap: Z7 (-1.5) vs VP.Future (+1.5)',
  outcomes: '["Z7 Esports", "VP.Future"]',
  outcomePrices: '["0", "1"]',
  closed: 'true',
  active: 'true',
  updatedAt: '2026-04-16T16:20:07.779897Z',
  endDate: '2026-04-13T18:30:00Z',
};

// REAL: closed with ["0.5","0.5"] = UMA 50/50 void.
const PM_VOID = {
  conditionId: '0x8246e7f838d7067c0a95f88f4bf65b1cd706758d0c9a12671f1b6333cb25c789',
  question: 'Map 3: Odd/Even Total Kills?',
  outcomes: '["Odd", "Even"]',
  outcomePrices: '["0.5", "0.5"]',
  closed: 'true',
  active: 'true',
  updatedAt: '2026-04-16T16:20:07.673717Z',
  endDate: '2026-04-13T17:30:00Z',
};

// REAL: OPEN market whose live midpoint is exactly ["0.5","0.5"].
// THE trap — prices alone must never be read as a resolution signal.
const PM_OPEN_MIDPOINT = {
  conditionId: '0xf80787280766c1ce3f5d44d451e19bb7fffefdf4d9d4788addd50c0f65104583',
  question: 'BNB Up or Down - May 11, 5:10AM-5:15AM ET',
  outcomes: '["Up", "Down"]',
  outcomePrices: '["0.5", "0.5"]',
  closed: 'false',
  active: 'true',
  updatedAt: '2026-05-10T09:18:54.411806Z',
  endDate: '2026-05-11T09:15:00Z',
};

test('PM: closed + ["1","0"] → first outcome label wins, resolved_at = updatedAt', () => {
  const r = extractPolymarketResolution(PM_WINNER_FIRST, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBe('GAM Esports');
  expect(r!.outcomes).toEqual(['GAM Esports', 'Ground Zero Gaming']);
  expect(r!.resolved_at?.toISOString()).toBe('2026-04-20T13:52:18.924Z');
});

test('PM: closed + ["0","1"] → second outcome label wins', () => {
  const r = extractPolymarketResolution(PM_WINNER_SECOND, OBSERVED);
  expect(r!.winning_outcome).toBe('VP.Future');
});

test('PM: closed + ["0.5","0.5"] → VOID_5050 sentinel (UMA 50/50 split settlement)', () => {
  const r = extractPolymarketResolution(PM_VOID, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBe(PM_VOID_SENTINEL);
});

test('PM TRAP: OPEN market at live midpoint ["0.5","0.5"] → NOT resolved', () => {
  expect(extractPolymarketResolution(PM_OPEN_MIDPOINT, OBSERVED)).toBeNull();
});

test('PM: closed but prices not settlement-shaped (UMA pending) → NOT resolved yet', () => {
  const r = extractPolymarketResolution(
    { ...PM_WINNER_FIRST, outcomePrices: '["0.97", "0.03"]' },
    OBSERVED,
  );
  expect(r).toBeNull();
});

test('PM: float imprecision rounds to settlement shape ("0.999"/"0.001" → winner)', () => {
  const r = extractPolymarketResolution(
    { ...PM_WINNER_FIRST, outcomePrices: '["0.999", "0.001"]' },
    OBSERVED,
  );
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBe('GAM Esports');
});

test('PM: ["1","1"] (paper2 Gamma DB-error shape) → resolved, winner null (never guess)', () => {
  const r = extractPolymarketResolution(
    { ...PM_WINNER_FIRST, outcomePrices: '["1", "1"]' },
    OBSERVED,
  );
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBeNull();
});

test('PM: tolerates real-boolean closed flag and pre-parsed arrays', () => {
  const r = extractPolymarketResolution(
    { ...PM_WINNER_FIRST, closed: true, outcomes: ['A', 'B'], outcomePrices: ['1', '0'] },
    OBSERVED,
  );
  expect(r!.winning_outcome).toBe('A');
});

test('PM: closed with empty/missing prices → null (no claim without settlement data)', () => {
  expect(extractPolymarketResolution({ ...PM_WINNER_FIRST, outcomePrices: '[]' }, OBSERVED)).toBeNull();
  expect(extractPolymarketResolution({ ...PM_WINNER_FIRST, outcomePrices: undefined }, OBSERVED)).toBeNull();
});

test('PM: no usable timestamp → observedAt fallback with @observed provenance', () => {
  const r = extractPolymarketResolution(
    { ...PM_WINNER_FIRST, updatedAt: undefined },
    OBSERVED,
  );
  expect(r!.resolved_at).toBe(OBSERVED);
  expect(r!.source).toContain('@observed');
});

// ─── Predict (real payloads) ──────────────────────────────────────────────────

// REAL: predict_markets ("New York Knicks"), Yes won.
const PREDICT_YES_WON = {
  id: '190684',
  title: 'New York Knicks',
  status: 'RESOLVED',
  tradingStatus: 'CLOSED',
  resolution: { name: 'Yes', team: null, status: 'WON', bestAsk: null, bestBid: null, indexSet: 1 },
  outcomes: [
    { name: 'Yes', status: 'WON' },
    { name: 'No', status: 'LOST' },
  ],
};

// REAL: predict_markets ("Boston Bruins"), No won.
const PREDICT_NO_WON = {
  id: '29855',
  title: 'Boston Bruins',
  status: 'RESOLVED',
  tradingStatus: 'CLOSED',
  resolution: { name: 'No', team: null, status: 'WON', bestAsk: null, bestBid: null, indexSet: 2 },
  outcomes: [
    { name: 'Yes', status: 'LOST' },
    { name: 'No', status: 'WON' },
  ],
};

// REAL: predict_markets, still open.
const PREDICT_OPEN = {
  id: '338013',
  title: 'Bitcoin Up or Down - May 14, 9:40AM-9:45AM ET',
  status: 'REGISTERED',
  tradingStatus: 'OPEN',
  resolution: null,
  outcomes: [
    { name: 'Up', status: null },
    { name: 'Down', status: null },
  ],
};

test('Predict: RESOLVED + resolution.name → winner, resolved_at = observedAt (no API ts)', () => {
  const r = extractPredictResolution(PREDICT_YES_WON, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBe('Yes');
  expect(r!.outcomes).toEqual(['Yes', 'No']);
  expect(r!.resolved_at).toBe(OBSERVED);
  expect(r!.source).toContain('@observed');
});

test('Predict: No-won real payload', () => {
  expect(extractPredictResolution(PREDICT_NO_WON, OBSERVED)!.winning_outcome).toBe('No');
});

test('Predict: REGISTERED (open) → null', () => {
  expect(extractPredictResolution(PREDICT_OPEN, OBSERVED)).toBeNull();
});

test('Predict: REMOVED (delisted, not resolved) → null', () => {
  expect(extractPredictResolution({ ...PREDICT_OPEN, status: 'REMOVED' }, OBSERVED)).toBeNull();
});

test('Predict: missing resolution object → falls back to unique outcomes[].status=WON', () => {
  const r = extractPredictResolution({ ...PREDICT_NO_WON, resolution: null }, OBSERVED);
  expect(r!.winning_outcome).toBe('No');
});

test('Predict: ambiguous outcomes (no WON entry) → resolved, winner null', () => {
  const r = extractPredictResolution(
    { ...PREDICT_NO_WON, resolution: null, outcomes: [{ name: 'Yes', status: 'LOST' }, { name: 'No', status: 'LOST' }] },
    OBSERVED,
  );
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBeNull();
});

test('Predict: no observedAt → resolved_at null (never new Date())', () => {
  const r = extractPredictResolution(PREDICT_YES_WON, null);
  expect(r!.resolved_at).toBeNull();
});

// ─── Kalshi (live raw is 100% pre-resolution → forward-path synthetics) ──────

// REAL: kalshi_markets active row (status='active', result='') — must NOT resolve.
const KALSHI_ACTIVE = {
  ticker: 'KXATPEXACTMATCH-26MAY11BELLAN-LAN21',
  status: 'active',
  result: '',
  market_type: 'binary',
  close_time: '2026-05-25T09:00:00Z',
  expiration_time: '2026-05-25T09:00:00Z',
  yes_sub_title: 'Martin Landaluce wins 2-1',
};

// SYNTHETIC forward-path: the same payload as the Kalshi API will return it once
// settled (status/result/settled_time fields per Kalshi v2 API + resolution-monitor).
const KALSHI_SETTLED_YES = {
  ...KALSHI_ACTIVE,
  status: 'settled',
  result: 'yes',
  settled_time: '2026-05-25T10:11:12Z',
};

test('Kalshi: live active payload (result empty) → null', () => {
  expect(extractKalshiResolution(KALSHI_ACTIVE, OBSERVED)).toBeNull();
});

test('Kalshi: settled + result=yes → Yes, resolved_at = settled_time, outcomes [Yes,No]', () => {
  const r = extractKalshiResolution(KALSHI_SETTLED_YES, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBe('Yes');
  expect(r!.outcomes).toEqual(['Yes', 'No']);
  expect(r!.resolved_at?.toISOString()).toBe('2026-05-25T10:11:12.000Z');
  expect(r!.source).toBe('pipeline-sync/kalshi:result');
});

test('Kalshi: settled + result=no → No; result=void → VOID sentinel', () => {
  expect(extractKalshiResolution({ ...KALSHI_SETTLED_YES, result: 'no' }, OBSERVED)!.winning_outcome).toBe('No');
  expect(extractKalshiResolution({ ...KALSHI_SETTLED_YES, result: 'void' }, OBSERVED)!.winning_outcome)
    .toBe(KALSHI_VOID_SENTINEL);
});

test('Kalshi: settled before result populated → resolved, winner null (amendable)', () => {
  const r = extractKalshiResolution({ ...KALSHI_SETTLED_YES, result: '' }, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBeNull();
  expect(r!.source).toBe('pipeline-sync/kalshi:status');
});

test('Kalshi: determined needs a result — empty → null, populated → resolved', () => {
  expect(extractKalshiResolution({ ...KALSHI_ACTIVE, status: 'determined' }, OBSERVED)).toBeNull();
  const r = extractKalshiResolution({ ...KALSHI_ACTIVE, status: 'determined', result: 'no' }, OBSERVED);
  expect(r!.winning_outcome).toBe('No');
});

test('Kalshi: no settled_time → close_time fallback; none at all → observedAt + @observed', () => {
  const noSettled = { ...KALSHI_SETTLED_YES, settled_time: undefined };
  expect(extractKalshiResolution(noSettled, OBSERVED)!.resolved_at?.toISOString())
    .toBe('2026-05-25T09:00:00.000Z');
  const noTs = { ...noSettled, close_time: undefined, expiration_time: undefined };
  const r = extractKalshiResolution(noTs, OBSERVED);
  expect(r!.resolved_at).toBe(OBSERVED);
  expect(r!.source).toContain('@observed');
});

test('Kalshi: non-binary settled market → outcomes null (no fake Yes/No vocabulary)', () => {
  const r = extractKalshiResolution({ ...KALSHI_SETTLED_YES, market_type: 'scalar', result: '' }, OBSERVED);
  expect(r!.outcomes).toBeNull();
});

// ─── Limitless (live raw is 100% pre-resolution → forward-path synthetics) ───

// REAL: limitless_markets active row (status='FUNDED', expired=false,
// winningOutcomeIndex key present but null) — must NOT resolve.
const LIMITLESS_ACTIVE = {
  slug: 'eth-up-or-down-5-mins-1778403335484',
  title: 'ETH Up or Down - 5 mins',
  status: 'FUNDED',
  expired: false,
  expirationTimestamp: 1778405100000,
  marketType: 'single',
  winningOutcomeIndex: null,
  outcomeTokens: ['Yes', 'No'],
};

// SYNTHETIC forward-path: resolved shape per Limitless API (winningOutcomeIndex)
// + ingestion reference (status RESOLVED, resolutionDate).
const LIMITLESS_RESOLVED = {
  ...LIMITLESS_ACTIVE,
  status: 'RESOLVED',
  expired: true,
  winningOutcomeIndex: 0,
  resolutionDate: '2026-05-11T09:20:00Z',
};

test('Limitless: live FUNDED payload → null', () => {
  expect(extractLimitlessResolution(LIMITLESS_ACTIVE, OBSERVED)).toBeNull();
});

test('Limitless: RESOLVED + winningOutcomeIndex=0 → outcomeTokens[0], native resolutionDate', () => {
  const r = extractLimitlessResolution(LIMITLESS_RESOLVED, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBe('Yes');
  expect(r!.outcomes).toEqual(['Yes', 'No']);
  expect(r!.resolved_at?.toISOString()).toBe('2026-05-11T09:20:00.000Z');
});

test('Limitless: index without tokens → binary CTF convention 0=Yes / 1=No', () => {
  const noTokens = { ...LIMITLESS_RESOLVED, outcomeTokens: undefined };
  expect(extractLimitlessResolution(noTokens, OBSERVED)!.winning_outcome).toBe('Yes');
  expect(extractLimitlessResolution({ ...noTokens, winningOutcomeIndex: 1 }, OBSERVED)!.winning_outcome).toBe('No');
});

test('Limitless TRAP: expired=true alone (deadline passed ≠ resolved) → null', () => {
  expect(extractLimitlessResolution({ ...LIMITLESS_ACTIVE, expired: true }, OBSERVED)).toBeNull();
});

test('Limitless: RESOLVED without index/winner → resolved, winner null (amendable)', () => {
  const r = extractLimitlessResolution({ ...LIMITLESS_ACTIVE, status: 'RESOLVED' }, OBSERVED);
  expect(r).not.toBeNull();
  expect(r!.winning_outcome).toBeNull();
  expect(r!.resolved_at).toBe(OBSERVED);
});

test('Limitless: exploded group sub-market (_limitlessEventId set) → never extracted here', () => {
  const sub = { ...LIMITLESS_RESOLVED, _limitlessEventId: '12345' };
  expect(extractLimitlessResolution(sub, OBSERVED)).toBeNull();
});

// ─── Dispatcher ──────────────────────────────────────────────────────────────

test('extractResolution dispatches per platform', () => {
  expect(extractResolution('polymarket', PM_VOID, OBSERVED)!.winning_outcome).toBe(PM_VOID_SENTINEL);
  expect(extractResolution('predict', PREDICT_YES_WON, OBSERVED)!.winning_outcome).toBe('Yes');
  expect(extractResolution('kalshi', KALSHI_ACTIVE, OBSERVED)).toBeNull();
  expect(extractResolution('limitless', LIMITLESS_ACTIVE, OBSERVED)).toBeNull();
});
